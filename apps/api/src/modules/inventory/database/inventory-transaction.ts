import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/inventory-client';
import { InventoryPrismaService } from './inventory-prisma.service';

/**
 * Phase W1: the Inventory module's ONE interactive transaction unit — the same
 * branded-handle contract `commerce-transaction.ts` established, adopted rather
 * than reinvented.
 *
 * A receipt posting is TWO writes that must commit together (the ledger row and
 * the derived balance), a transfer dispatch is THREE (movement, balance
 * decrement, transfer status) — and a `$transaction` opened inside a service
 * would put `Prisma.TransactionClient` in service signatures, which is the
 * repository-boundary erosion this file exists to prevent. Services orchestrate;
 * repositories own statements; this is the only caller of `$transaction`
 * outside a repository.
 */
declare const INVENTORY_TRANSACTION_HANDLE: unique symbol;

/** The OPAQUE handle a repository accepts to join its caller's transaction. */
export interface InventoryTransactionHandle {
  readonly [INVENTORY_TRANSACTION_HANDLE]: true;
}

export type InventoryTransactionWork<T> = (tx: InventoryTransactionHandle) => Promise<T>;

/** Handles → their clients. Module-private by design (see commerce's file doc). */
const HANDLE_CLIENTS = new WeakMap<object, Prisma.TransactionClient>();

function mintHandle(client: Prisma.TransactionClient): InventoryTransactionHandle {
  const handle = Object.freeze({}) as unknown as InventoryTransactionHandle;
  HANDLE_CLIENTS.set(handle as unknown as object, client);
  return handle;
}

/**
 * The ONLY unwrapper — exported for repositories, and for repositories only.
 * FAILS LOUDLY on a foreign handle rather than silently starting a fresh
 * transaction that pretends to be the caller's.
 */
export function unwrapInventoryTransaction(
  handle: InventoryTransactionHandle
): Prisma.TransactionClient {
  const client = HANDLE_CLIENTS.get(handle as unknown as object);
  if (!client) {
    throw new Error(
      'InventoryTransactionHandle was not produced by InventoryUnitOfWork.run; ' +
        'a repository may only receive a handle minted inside a unit of work.'
    );
  }
  return client;
}

/** ONE interactive transaction, on the module's OWN client. */
@Injectable()
export class InventoryUnitOfWork {
  constructor(private readonly prisma: InventoryPrismaService) {}

  async run<T>(work: InventoryTransactionWork<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(mintHandle(tx)));
  }
}
