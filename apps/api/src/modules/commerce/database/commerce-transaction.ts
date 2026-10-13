import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/commerce-client';
import { CommercePrismaService } from './commerce-prisma.service';

/**
 * Phase C1 step N (§8.1 of `docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md`): the
 * Commerce module's ONE interactive transaction unit.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * A purchase submission must never persist the forbidden state
 *
 *     PurchaseDocument = SUBMITTED   and   WorkflowInstance = (none)
 *
 * and a workflow decision must never leave the run "one step behind" a step that
 * already records an approval. Both are TWO OR MORE repository writes that must
 * succeed or fail together, and the only mechanism that expresses that in this
 * repository stack is ONE interactive Prisma transaction opened above the
 * repositories and threaded through them.
 *
 * WHAT WAS WRONG WITH THE ALTERNATIVES
 * ------------------------------------
 *  - "Each repository opens its own `$transaction`" cannot make two writes atomic:
 *    they would commit independently, and a failure between them would commit half
 *    the act. The repository's own `createDocument` keeps its internal transaction
 *    because it is a single-caller act whose parts are all its own; it is not a
 *    mechanism another caller can compose with.
 *  - "The service calls `$transaction` itself" is the obvious shortcut, and it is
 *    refused: it would put `Prisma.TransactionClient` in a SERVICE's type
 *    signature (and therefore in the generated-client import graph of every file
 *    that follows it), which is exactly the repository-boundary erosion the
 *    isolation suite exists to prevent. Services orchestrate; repositories own
 *    statements.
 *
 * WHAT IS ACTUALLY EXPORTED, AND TO WHOM
 * --------------------------------------
 *  - `CommerceUnitOfWork.run(work)` — the ONLY caller of `$transaction` outside a
 *    repository. A service composes one unit of work per request-level act and
 *    receives the work's return value; it never sees a Prisma type.
 *  - `mintHandle` — NOT exported. The handle is created in exactly one place
 *    (inside `run`), so no caller can fabricate one and present it to a repository
 *    to sneak a write outside the module's real transaction.
 *  - `unwrapCommerceTransaction(handle)` — exported because REPOSITORIES need the
 *    underlying client. It is the only unwrapper, and the source-scan guard
 *    (`workflow-execution.guards.spec.ts`) asserts that no service, controller,
 *    DTO or pure-runtime file mentions it, `CommerceUnitOfWork`, or
 *    `Prisma.TransactionClient`. A repository that receives a handle and an
 *    orchestrator that receives a value are the two halves of the same boundary.
 *
 * WHY THE HANDLE IS A BRAND RATHER THAN A WRAPPER OBJECT
 * -----------------------------------------------------
 * The handle is a branded, frozen, EMPTY object: the client is held in a
 * module-private `WeakMap`, so the Prisma type is not reachable through any
 * property, `JSON.stringify` of a handle is `{}` (it can never leak into a DTO, a
 * log payload or an audit `newValue`), and there is no getter a future author
 * could call by accident. The brand exists only in the TYPE system, so
 * `handle as Promise<T>` — or any other coercion — still fails to type-check.
 *
 * WHAT A UNIT OF WORK IS NOT
 * --------------------------
 * It is not a retry, not a queue, not a saga and not a lock manager: the phase
 * contract forbids async workflow processing in N. Notification runs OUTSIDE
 * it (after commit, against committed state). Durable audit events write an
 * `AuditOutbox` row INSIDE it (Phase B2.3) so that the event commits or rolls
 * back atomically with the business mutation — the relay delivers asynchronously.
 * Non-durable audit events continue to run after commit via `record()`. It
 * is one interactive transaction with one callback, and it does not know what the
 * callback does.
 */
declare const COMMERCE_TRANSACTION_HANDLE: unique symbol;

/**
 * The OPAQUE handle a repository accepts to join its caller's transaction.
 *
 * MENTION THIS TYPE, NEVER ITS PAYLOAD. A repository method signature may name it
 * (`tx: CommerceTransactionHandle`); a service may only pass one through. The
 * property below is a type-level brand with no runtime counterpart — the brand
 * symbol is never assigned, which is doubly deliberate: it cannot be forged by
 * building the same key, and a handle cannot be constructed anywhere but here.
 */
export interface CommerceTransactionHandle {
  readonly [COMMERCE_TRANSACTION_HANDLE]: true;
}

/**
 * The work a unit of work runs. `tx` is the ONLY thing the callback may hand to a
 * repository; nothing else about the transaction is observable to it.
 */
export type CommerceTransactionWork<T> = (tx: CommerceTransactionHandle) => Promise<T>;

/**
 * Handles → their clients. Module-private on purpose (see the file doc). A
 * `WeakMap` rather than a private field, because the handle must stay a plain
 * frozen object with no own properties: a field would be one `Object.keys` away
 * from a Prisma type in a log line.
 */
const HANDLE_CLIENTS = new WeakMap<object, Prisma.TransactionClient>();

/**
 * The ONLY producer of handles, called only from `CommerceUnitOfWork.run`.
 *
 * Not exported. A second producer would be the hole this whole file is designed
 * to close: any code that could mint a handle could hand it to a repository and
 * get writes that pretend to be in a transaction that does not exist.
 */
function mintHandle(client: Prisma.TransactionClient): CommerceTransactionHandle {
  const handle = Object.freeze({}) as unknown as CommerceTransactionHandle;
  HANDLE_CLIENTS.set(handle as unknown as object, client);
  return handle;
}

/**
 * The ONLY unwrapper — exported for repositories, and for repositories only.
 *
 * FAILS LOUDLY ON A FOREIGN HANDLE. The `WeakMap` miss can only happen if a value
 * that was not produced by `mintHandle` reached a repository, which is a defect
 * this function refuses to paper over by opening a fresh transaction: silently
 * doing that would re-create precisely the non-atomic write the caller was trying
 * to avoid.
 */
export function unwrapCommerceTransaction(
  handle: CommerceTransactionHandle
): Prisma.TransactionClient {
  const client = HANDLE_CLIENTS.get(handle as unknown as object);
  if (!client) {
    throw new Error(
      'CommerceTransactionHandle was not produced by CommerceUnitOfWork.run; ' +
        'a repository may only receive a handle minted inside a unit of work.'
    );
  }
  return client;
}

/**
 * ONE interactive transaction, on the module's OWN client (never Core's, never
 * HR's — the isolation suite asserts that this file imports nothing but the
 * generated Commerce client and the Commerce Prisma service).
 *
 * WHY `run` TAKES THE WHOLE ACT RATHER THAN EXPOSING BEGIN/COMMIT. An API shaped
 * like a transaction object invites a caller to "remember" to commit, to keep it
 * open across an `await` that talks to the network, or to return it. Handing the
 * runner a callback makes the act's boundary the callback's boundary: the commit
 * is the runner's decision, the rollback is Prisma's answer to a throw, and there
 * is no third state a caller can create.
 *
 * The generic is not decoration — it is what lets a service return the committed
 * state (an instance, its steps) without any repository result being re-cast.
 */
@Injectable()
export class CommerceUnitOfWork {
  constructor(private readonly prisma: CommercePrismaService) {}

  async run<T>(work: CommerceTransactionWork<T>): Promise<T> {
    return this.prisma.$transaction((client: Prisma.TransactionClient) => work(mintHandle(client)));
  }
}
