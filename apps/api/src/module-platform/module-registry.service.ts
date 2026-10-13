import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  ModuleDeploymentMode,
  ModuleHealthState,
  ModuleLifecycleState,
  ModuleTenantScope,
  ModuleType,
  Prisma,
} from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { RequestContextService } from '../common/request-context.service';
import { ObservabilityLifecycleService } from '../observability/observability-lifecycle.service';
import type {
  LifecycleEventInput,
  LifecyclePhaseValue,
} from '../observability/observability.contract';
import {
  MODULE_HEARTBEAT_INTERVAL_MS,
  MODULE_PROTOCOL_VERSION,
  MODULE_STALE_AFTER_MS,
  RESOLVABLE_LIFECYCLES,
  SWEEPABLE_LIFECYCLES,
  type ModuleDeploymentModeValue,
  type ModuleHealthValue,
  type ModuleLifecycleValue,
  type ModuleRegistrationResult,
  type ResolvedModuleInstance,
} from './module.contract';
import { checkCompatibility, isValidContract } from './module-contract.util';
import { evaluateModuleEndpoint } from './module-url.guard';
import { MODULE_SECRET_BYTES, isSecretExpired } from './module-signature';
import {
  CreateModuleRegistrationDto,
  RegisterModuleDto,
  UpdateModuleRegistrationDto,
} from './dto/module.dto';

/**
 * Phase 49M: owns the module registry, registration, discovery and lifecycle.
 *
 * SEVEN RULES THIS CLASS EXISTS TO ENFORCE:
 *
 * 1. NO MODULE IS EVER ASSUMED LOCAL OR REMOTE. There is no default deployment mode, no
 *    `moduleId === …` comparison and no branch anywhere in this file that reads
 *    `deploymentMode` to decide WHAT to do — only the transport chooses HOW, and it does
 *    that in `module.transport.ts`. Grep this file for `LOCAL`: every occurrence is either
 *    passing the value through to storage or handing it to the URL policy.
 *
 * 2. THE SECRET NEVER LEAVES. `toPublicRegistration()` and, since ADR-0006 A8,
 *    `toPublicCapabilityCredential()` are the ONLY projections any route uses, and neither has
 *    a branch that emits the ciphertext, the IV or the tag — not for SUPER_ADMIN, not on
 *    create, not in an error message. A caller learns whether a credential exists and when it
 *    changed. The single exception is the value returned by the call that GENERATED it, once.
 *
 * 3. A MODULE CANNOT ELEVATE ITSELF (§8). Registration writes only what a module may
 *    describe about itself. `enabled`, `tenantScope` and `tenantIds` are read from the
 *    stored registration and never from the request, so the trust decision belongs to the
 *    administrator in every code path.
 *
 * 4. INCOMPATIBLE IS RECORDED, NOT PARTIALLY ACTIVATED (§18). A protocol or contract
 *    mismatch produces a persisted INCOMPATIBLE instance and an accepted:false result — so
 *    an operator can SEE why a module they deployed is not serving, which a rejection with
 *    no row would not give them.
 *
 * 5. TENANT IS NEVER WIDENED (§21). `resolve` applies the registration's tenant scope to
 *    the CALLER'S tenant from `RequestContextService`, including when that is null; there
 *    is no code path in which a caller supplies the tenant it wants to act for.
 *
 * 6. DISCOVERY IS BOUNDED (§45). `resolve` is a single indexed query per call with no fan
 *    out, no per-widget lookup and no unbounded polling; staleness is computed from
 *    `lastSeenAt` rather than by probing, so a resolution costs one SELECT.
 *
 * 7. NOTHING HERE KNOWS A BUSINESS DOMAIN. No HR, no Finance, no capability list, no
 *    per-module special case. Adding a module is a row.
 */

/** Audit action names, one per state change worth reconstructing later (§33). */
const AUDIT_ACTIONS = {
  REGISTERED: 'MODULE_REGISTERED',
  UPDATED: 'MODULE_UPDATED',
  ENABLED: 'MODULE_ENABLED',
  DISABLED: 'MODULE_DISABLED',
  DELETED: 'MODULE_DELETED',
  CREDENTIAL_ROTATED: 'MODULE_CREDENTIAL_ROTATED',
  /**
   * ADR-0006 A8. A SECOND, DISTINGUISHABLE ACTION, deliberately not `CREDENTIAL_ROTATED`
   * above: that one is keyed by registration row id and describes the MODULE-HOP credential.
   * Reusing it here would put two meanings and two key kinds behind one name, and would make
   * "rotating the identity credential did not touch the audit credential" unobservable in the
   * trail — the exact silent reinterpretation A8 exists to prevent.
   */
  CAPABILITY_CREDENTIAL_ROTATED: 'PLATFORM_CAPABILITY_CREDENTIAL_ROTATED',
  CONNECTION_TESTED: 'MODULE_CONNECTION_TESTED',
  INSTANCE_REGISTERED: 'MODULE_INSTANCE_REGISTERED',
  INSTANCE_DEREGISTERED: 'MODULE_INSTANCE_DEREGISTERED',
} as const;

/**
 * Phase 49M-2: lifecycle event types, one per REAL registry state change.
 *
 * MAPPED FROM `AUDIT_ACTIONS` ABOVE, WITH TWO DELIBERATE OMISSIONS:
 *
 *  - NO HEARTBEAT. `heartbeat()` writes `lastSeenAt` on every tick (§14 says 30 s per
 *    instance) and §33 already refuses to audit it. Emitting a lifecycle row per heartbeat
 *    would put the highest-cardinality, lowest-value stream in this phase into the very table
 *    an operator reads to reconstruct an incident — the mistake `core_db."AuditLog"` already
 *    demonstrates, with 94% of its 36k rows being noise. A heartbeat that CHANGES health is
 *    still not emitted here: `ModuleHealthService` owns observed health, and duplicating it
 *    would mean two sources for one fact.
 *  - NO CONNECTION_TESTED. Unlike 49L's integration test, the module connection test persists
 *    nothing on the registry row; it is a read-only probe, and §49M-2's rule is that a
 *    lifecycle row records a TRANSITION.
 */
const LIFECYCLE_EVENTS = {
  REGISTERED: 'module.registration.created',
  UPDATED: 'module.registration.updated',
  ENABLED: 'module.registration.enabled',
  DISABLED: 'module.registration.disabled',
  DELETED: 'module.registration.deleted',
  CREDENTIAL_ROTATED: 'module.registration.credential_rotated',
  /** ADR-0006 A8's capability-specific lifecycle event — see `AUDIT_ACTIONS` above. */
  CAPABILITY_CREDENTIAL_ROTATED: 'module.capability_credential.rotated',
  INSTANCE_REGISTERED: 'module.instance.registered',
  INSTANCE_DEREGISTERED: 'module.instance.deregistered',
} as const;

/**
 * Rows one staleness sweep may touch.
 *
 * BOUNDED, matching 49L's `RETRY_BATCH_SIZE` rationale: a tick that could update every row
 * in the table is a tick that can lock the table.
 */
export const STALE_SWEEP_BATCH = 100;

/** Page size ceiling for the admin list. */
export const MAX_MODULE_PAGE = 100;

/**
 * Rows one module's capability-credential read may return (ADR-0006 A8).
 *
 * A SECOND CEILING RATHER THAN A REUSE OF `MAX_MODULE_PAGE`, because the two bound different
 * things: the first bounds how many MODULES an admin list may render, this one bounds how many
 * CAPABILITIES one module may render. Sharing one constant would couple a module count to a
 * capability count, and the two do not grow together.
 */
export const MAX_CAPABILITY_CREDENTIAL_PAGE = 100;

/**
 * The one "no such module" refusal.
 *
 * SHARED RATHER THAN REPEATED, so the admin reads and the capability-credential paths cannot
 * drift into several messages for one condition — an operator who sees two different sentences
 * for "this module is not registered" will reasonably conclude they are two problems.
 */
const MODULE_NOT_FOUND_MESSAGE = 'ماژول یافت نشد.';

/**
 * One logical module as the admin API projects it.
 *
 * NOTE WHAT IS NOT ON THIS TYPE: `secretCiphertext`, `secretIv`, `secretAuthTag`. They are
 * not omitted by a filter that could be forgotten — they are absent from the type, so a
 * projection that tried to include one would not compile.
 */
export interface PublicModuleRegistration {
  id: string;
  moduleId: string;
  displayName: string;
  moduleType: ModuleType;
  enabled: boolean;
  tenantScope: ModuleTenantScope;
  tenantIds: string[];
  protocolVersion: number;
  /** Whether a credential is stored. NOT the credential, nor its length. */
  hasCredential: boolean;
  credentialUpdatedAt: Date | null;
  credentialExpiresAt: Date | null;
  /**
   * DERIVED lifecycle of the LOGICAL module — see the `ModuleLifecycleState` comment in the
   * schema. `DISCOVERED` appears here and in no column: it means "admitted, never announced".
   */
  derivedLifecycle: ModuleLifecycleValue | 'DISCOVERED';
  /** Worst health across instances, so a list row cannot look healthier than reality. */
  aggregateHealth: ModuleHealthValue;
  instances: PublicModuleInstance[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One instance as the admin API projects it.
 *
 * `baseUrl` IS included, and that is a deliberate, narrow exception to "do not expose
 * internal network information": §28 asks for the endpoint "only if safe/appropriate", and
 * the route is gated on `admin.modules.read`, which only SUPER_ADMIN, ADMIN and
 * OPERATIONS_ADMIN hold. An operator diagnosing "why is this module unreachable" without
 * being able to see where Core is pointing is being asked to guess. It is never returned by
 * `resolve`, never sent to a non-admin surface, and never logged.
 */
export interface PublicModuleInstance {
  id: string;
  instanceId: string;
  moduleId: string;
  deploymentMode: ModuleDeploymentMode;
  version: string;
  baseUrl: string | null;
  healthPath: string;
  capabilities: string[];
  apiContracts: string[];
  eventContracts: string[];
  lifecycle: ModuleLifecycleState;
  health: ModuleHealthState;
  healthErrorCode: string | null;
  lastSeenAt: Date | null;
  lastProbedAt: Date | null;
  /** Computed, not stored: `lastSeenAt` older than the stale threshold. */
  stale: boolean;
  createdAt: Date;
}

/**
 * One CAPABILITY CREDENTIAL as the admin API projects it (ADR-0006 A8).
 *
 * SAME STRUCTURAL RULE AS `PublicModuleRegistration`: `secretCiphertext`, `secretIv` and
 * `secretAuthTag` are not filtered out here, they are ABSENT FROM THE TYPE — so a projection
 * that tried to emit one would not compile. `hasSecret` and the two timestamps are what an
 * operator legitimately learns: whether a capability is provisioned, and when it changed.
 *
 * The credential's VALUE is returned by exactly one call, the one that created it, and by no
 * read path — which is why this type has no field that could hold it.
 */
export interface PublicCapabilityCredential {
  id: string;
  moduleId: string;
  /** The contract descriptor this credential authenticates, e.g. `platform.audit@v1`. */
  capability: string;
  /** Whether an envelope is stored. NOT the credential, nor its length, nor a hint of it. */
  hasSecret: boolean;
  /**
   * When the slot was last written. EQUAL TO `createdAt` for a credential that has been issued
   * and never rotated, which is how a first issuance is told apart from a rotation on the read
   * path — both are the same write and therefore carry the same trail action, see
   * `rotateCapabilityCredential`.
   */
  credentialUpdatedAt: Date | null;
  /** NULL means "no expiry configured", never "expired". */
  credentialExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The row shape every private helper below consumes. */
type RegistrationRow = Prisma.ModuleRegistrationGetPayload<{ include: { instances: true } }>;

/** The row shape the capability-credential helpers below consume. */
type CapabilityCredentialRow = Prisma.ModuleCapabilityCredentialGetPayload<Record<string, never>>;

/** Why a resolution failed. Short codes; never network detail (§39). */
export type ResolutionFailure =
  | 'MODULE_NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'MODULE_FORBIDDEN'
  | 'MODULE_UNAVAILABLE'
  | 'CONTRACT_UNSUPPORTED';

export interface ModuleResolution {
  ok: boolean;
  instance?: ResolvedModuleInstance;
  failure?: ResolutionFailure;
}

@Injectable()
export class ModuleRegistryService {
  private readonly logger = new Logger(ModuleRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    // Optional for the same reason `IntegrationService` (49L) and `AIConfigService` (49J-0)
    // make it optional: a trimmed test module must be able to exercise the domain rules
    // without wiring the audit pipeline, and a missing audit sink must never break logic.
    @Optional() private readonly audit?: AuditService,
    // 49M-2: the lifecycle timeline, optional for the same two reasons as `audit` — the
    // existing specs build this service from an explicit provider list, and observability is
    // optional infrastructure that must never be able to fail a registry mutation.
    @Optional() private readonly lifecycle?: ObservabilityLifecycleService
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Admin reads
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Every registered module with its instances (§28/§31).
   *
   * ONE QUERY WITH AN INCLUDE, not N+1: the admin list renders instances inline, and a
   * per-row instance fetch would be exactly the per-widget discovery §45 forbids.
   */
  async listRegistrations(): Promise<PublicModuleRegistration[]> {
    const rows = await this.prisma.moduleRegistration.findMany({
      include: { instances: { orderBy: { instanceId: 'asc' } } },
      orderBy: [{ moduleType: 'asc' }, { displayName: 'asc' }],
      take: MAX_MODULE_PAGE,
    });

    return rows.map((row) => this.toPublicRegistration(row));
  }

  async getRegistration(id: string): Promise<PublicModuleRegistration> {
    return this.toPublicRegistration(await this.loadOrThrow(id));
  }

  /**
   * Capability discovery for ONE module (§10).
   *
   * WHAT THIS RETURNS: identity, version, capabilities, contracts, status. WHAT IT CANNOT
   * RETURN, because none of it exists in the projection: a database schema, a secret, an
   * internal file path, a credential. §10's prohibition is satisfied structurally rather
   * than by remembering to filter.
   */
  async describeCapabilities(moduleId: string): Promise<{
    moduleId: string;
    displayName: string;
    enabled: boolean;
    derivedLifecycle: ModuleLifecycleValue | 'DISCOVERED';
    aggregateHealth: ModuleHealthValue;
    instances: {
      instanceId: string;
      version: string;
      deploymentMode: ModuleDeploymentMode;
      lifecycle: ModuleLifecycleState;
      health: ModuleHealthState;
      capabilities: string[];
      apiContracts: string[];
      eventContracts: string[];
    }[];
  }> {
    const row = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId },
      include: { instances: { orderBy: { instanceId: 'asc' } } },
    });

    if (!row) throw new NotFoundException(MODULE_NOT_FOUND_MESSAGE);

    const projected = this.toPublicRegistration(row);

    return {
      moduleId: projected.moduleId,
      displayName: projected.displayName,
      enabled: projected.enabled,
      derivedLifecycle: projected.derivedLifecycle,
      aggregateHealth: projected.aggregateHealth,
      instances: projected.instances.map((instance) => ({
        instanceId: instance.instanceId,
        version: instance.version,
        deploymentMode: instance.deploymentMode,
        lifecycle: instance.lifecycle,
        health: instance.health,
        capabilities: instance.capabilities,
        apiContracts: instance.apiContracts,
        eventContracts: instance.eventContracts,
      })),
    };
  }

  /**
   * Every capability credential one module holds (ADR-0006 A8).
   *
   * THIS IS A READ OF A STORE OF SECRETS, and the projection is what keeps it safe:
   * `toPublicCapabilityCredential` has no field for `secretCiphertext`, `secretIv` or
   * `secretAuthTag`, so an operator learns WHICH capabilities are provisioned and WHEN each one
   * changed — never a value, a length or a hint of one. There is deliberately no method that
   * returns a stored credential, in any role, ever.
   *
   * AN UNKNOWN `moduleId` IS A 404, matching `describeCapabilities`. An empty list would be
   * indistinguishable from a typo in the id, and "this module is not admitted" is a different
   * answer from "this module holds no capability credentials" — an operator needs to tell them
   * apart, because the fix is different.
   *
   * TWO INDEXED READS, not N+1 (§45): the registration by its unique `moduleId`, then the
   * credentials by the `(moduleId, capability)` unique key the resolver itself uses. Bounded, so
   * a module with an implausible number of credentials cannot turn one admin page into an
   * unbounded scan.
   */
  async listCapabilityCredentials(moduleId: string): Promise<PublicCapabilityCredential[]> {
    await this.loadRegistrationIdentityOrThrow(moduleId);

    const rows = await this.prisma.moduleCapabilityCredential.findMany({
      where: { moduleId },
      orderBy: { capability: 'asc' },
      take: MAX_CAPABILITY_CREDENTIAL_PAGE,
    });

    return rows.map((row) => this.toPublicCapabilityCredential(row));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admin writes
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Admits a logical module to the platform (§29).
   *
   * NOTE WHAT THIS METHOD DOES NOT ACCEPT: an endpoint, a version, a capability list or an
   * instance. An administrator declares that a module MAY participate; the module itself
   * declares where it is and what it can do. That division is what keeps an operator from
   * typing a URL — the §40 confused-deputy surface — and what makes a stale hand-typed
   * endpoint impossible.
   *
   * `enabled` DEFAULTS TO FALSE even when the DTO omits it, matching 49L's
   * `IntegrationConfig`: creating configuration must never silently start routing traffic.
   */
  async createRegistration(
    actorId: string,
    dto: CreateModuleRegistrationDto
  ): Promise<PublicModuleRegistration> {
    const tenantScope = (dto.tenantScope ?? 'ALL') as ModuleTenantScope;

    // The pair invariant, enforced here so the 400 is readable; the DB CHECK restates it so
    // a direct SQL write cannot bypass it either.
    const tenantIds = tenantScope === 'RESTRICTED' ? (dto.tenantIds ?? []) : [];

    if (tenantScope === 'RESTRICTED' && tenantIds.length === 0) {
      throw new BadRequestException('برای دامنه محدود، حداقل یک مستأجر لازم است.');
    }

    try {
      const created = await this.prisma.moduleRegistration.create({
        data: {
          moduleId: dto.moduleId,
          displayName: dto.displayName,
          moduleType: (dto.moduleType ?? 'BUSINESS') as ModuleType,
          enabled: dto.enabled ?? false,
          tenantScope,
          tenantIds,
          protocolVersion: MODULE_PROTOCOL_VERSION,
        },
        include: { instances: true },
      });

      await this.record(AUDIT_ACTIONS.REGISTERED, actorId, created.id, {
        moduleId: created.moduleId,
        moduleType: created.moduleType,
        enabled: created.enabled,
        tenantScope: created.tenantScope,
      });

      this.emitLifecycle(
        LIFECYCLE_EVENTS.REGISTERED,
        'SUCCEEDED',
        created.id,
        created.moduleId,
        actorId,
        {
          moduleType: created.moduleType,
          enabled: created.enabled,
          tenantScope: created.tenantScope,
          // COUNT, not the ids. A RESTRICTED scope's tenant list is customer identity that a
          // platform timeline has no need to carry.
          tenantCount: created.tenantIds.length,
        }
      );

      return this.toPublicRegistration(created);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('این شناسه ماژول قبلاً ثبت شده است.');
      }

      throw err;
    }
  }

  /**
   * Partial update of the administrator-owned fields.
   *
   * DISABLING CASCADES TO EVERY INSTANCE, in one transaction. A disabled module whose
   * instances still read ACTIVE would be a registry that disagrees with itself: the resolver
   * filters them out by the parent's `enabled` flag, but the admin UI would show green rows.
   * Both are updated together so what an operator sees is what the resolver applies.
   */
  async updateRegistration(
    actorId: string,
    id: string,
    dto: UpdateModuleRegistrationDto
  ): Promise<PublicModuleRegistration> {
    const existing = await this.loadOrThrow(id);

    const tenantScope = (dto.tenantScope ?? existing.tenantScope) as ModuleTenantScope;
    const tenantIds = tenantScope === 'RESTRICTED' ? (dto.tenantIds ?? existing.tenantIds) : [];

    if (tenantScope === 'RESTRICTED' && tenantIds.length === 0) {
      throw new BadRequestException('برای دامنه محدود، حداقل یک مستأجر لازم است.');
    }

    const willDisable = dto.enabled === false && existing.enabled;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.moduleRegistration.update({
        where: { id },
        data: {
          ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
          ...(dto.moduleType !== undefined ? { moduleType: dto.moduleType as ModuleType } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          tenantScope,
          tenantIds,
        },
        include: { instances: true },
      });

      if (!willDisable) return row;

      await tx.moduleInstance.updateMany({
        where: { registrationId: id },
        data: {
          lifecycle: ModuleLifecycleState.DISABLED,
          health: ModuleHealthState.DISABLED,
        },
      });

      // Re-read so the response reflects the cascade rather than the pre-update rows.
      return tx.moduleRegistration.findUniqueOrThrow({
        where: { id },
        include: { instances: true },
      });
    });

    const action =
      dto.enabled === true && !existing.enabled
        ? AUDIT_ACTIONS.ENABLED
        : willDisable
          ? AUDIT_ACTIONS.DISABLED
          : AUDIT_ACTIONS.UPDATED;

    await this.record(action, actorId, id, {
      moduleId: updated.moduleId,
      enabled: updated.enabled,
      tenantScope: updated.tenantScope,
      instancesAffected: willDisable ? updated.instances.length : 0,
    });

    // AFTER the `$transaction` above has committed, and outside it. Emitting inside the
    // callback would hold a Core transaction open across an observability write, and a
    // rollback would leave a timeline claiming a disable that never happened.
    //
    // ONE row, and its `eventType` follows the SAME three-way choice the audit `action` above
    // makes, so the two trails cannot disagree about what this call did.
    this.emitLifecycle(
      action === AUDIT_ACTIONS.ENABLED
        ? LIFECYCLE_EVENTS.ENABLED
        : action === AUDIT_ACTIONS.DISABLED
          ? LIFECYCLE_EVENTS.DISABLED
          : LIFECYCLE_EVENTS.UPDATED,
      'SUCCEEDED',
      id,
      updated.moduleId,
      actorId,
      {
        enabled: updated.enabled,
        tenantScope: updated.tenantScope,
        // The cascade is the operationally interesting part of a disable: N instances left
        // ACTIVE in the same commit.
        instancesAffected: willDisable ? updated.instances.length : 0,
      }
    );

    return this.toPublicRegistration(updated);
  }

  /**
   * Removes a registration and, by CASCADE, its instances.
   *
   * The cascade lives in the FK rather than here on purpose: deleting instances in
   * application code would leave a window in which the resolver could still see orphans.
   */
  async deleteRegistration(actorId: string, id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.loadOrThrow(id);

    await this.prisma.moduleRegistration.delete({ where: { id } });

    await this.record(AUDIT_ACTIONS.DELETED, actorId, id, {
      moduleId: row.moduleId,
      instancesRemoved: row.instances.length,
    });

    this.emitLifecycle(LIFECYCLE_EVENTS.DELETED, 'SUCCEEDED', id, row.moduleId, actorId, {
      instancesRemoved: row.instances.length,
    });

    return { id, deleted: true };
  }

  /**
   * Generates a new shared credential and returns it ONCE (§20).
   *
   * ONE-WAY BY CONSTRUCTION: the plaintext is returned by this call and never again. No route
   * reads a stored credential, so an operator who loses it rotates rather than recovers —
   * the same property 49L's webhook secret has, and the reason `hasCredential` exists instead
   * of a masked value.
   *
   * ROTATION DOES NOT DISABLE THE MODULE, and that is a deliberate trade: instances stay
   * resolvable and their next signed request fails verification until they are given the new
   * credential. Disabling on rotation would turn a routine key change into an outage.
   * REVOCATION — "stop this module now" — is `enabled: false` plus a rotation, which §20
   * lists as a separate operation for exactly this reason.
   */
  async rotateCredential(actorId: string, id: string): Promise<{ secret: string }> {
    const row = await this.loadOrThrow(id);

    const secret = randomBytes(MODULE_SECRET_BYTES).toString('hex');
    const envelope = this.crypto.encrypt(secret);

    await this.prisma.moduleRegistration.update({
      where: { id },
      data: {
        secretCiphertext: envelope.ciphertext,
        secretIv: envelope.iv,
        secretAuthTag: envelope.authTag,
        secretUpdatedAt: new Date(),
      },
    });

    // `generated: true` and nothing else. The audit row records THAT a rotation happened,
    // never the value — an audit log is a place credentials leak to quietly, because nobody
    // reads it until an incident.
    await this.record(AUDIT_ACTIONS.CREDENTIAL_ROTATED, actorId, id, { generated: true });

    // Same containment rule in the lifecycle trail, and it matters more here: this table is
    // read by an operator-facing timeline API, so a credential in `detail` would be a
    // disclosure through a surface that is DESIGNED to be displayed.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.CREDENTIAL_ROTATED,
      'SUCCEEDED',
      id,
      row.moduleId,
      actorId,
      { generated: true }
    );

    return { secret };
  }

  /**
   * Issues, or replaces, the capability credential for one `(moduleId, capability)` pair
   * (ADR-0006 A8), and returns the new plaintext ONCE.
   *
   * ONE WRITE, TWO READINGS. The first call for a pair ISSUES and every later call ROTATES: both
   * generate a fresh 32-byte plaintext, both overwrite the same single slot, and the read
   * projection already tells the two apart — a first issuance is the row whose `createdAt`
   * equals its `credentialUpdatedAt`. A separate `issue` method with its own audit action was
   * considered and rejected: the ADR names exactly two capability-credential operations
   * (`resolveCapabilityCredential` and this one) and exactly ONE trail pair for them, so a second
   * action name here would add vocabulary the design does not have while adding no fact the
   * projection cannot already show. A row that exists WITHOUT an envelope stays expressible (the
   * `secret*` columns are nullable as a set) for a provisioning path that declares capabilities
   * before it can mint credentials.
   *
   * THE UPDATE BRANCH NEVER TOUCHES `secretExpiresAt`, matching `rotateCredential` exactly, which
   * is what A8 asks for: "exactly `ModuleRegistration`'s semantics". An expiry is a POLICY an
   * operator configured, so a rotation must not silently clear it; the create branch leaves it
   * NULL, and NULL means "no expiry configured" rather than "expired".
   *
   * CAPABILITY-SPECIFIC BY CONSTRUCTION (A8): the write is addressed by the composite
   * `(moduleId, capability)` key, so rotating the identity credential cannot touch the audit one
   * — and because the trail records `capability`, "rotating identity did not touch audit" is
   * OBSERVABLE later rather than merely asserted once by a test.
   *
   * `capability` IS VALIDATED HERE AND IN THE TABLE. The shape check turns a typo into a readable
   * 400 instead of the CHECK constraint surfacing as a 500, and it is the same `isValidContract`
   * predicate the compatibility gate uses — so "the descriptor a credential authenticates" and
   * "the descriptor an instance declares" cannot drift into two rules.
   *
   * THE MODULE MUST ALREADY BE ADMITTED (§7). A capability credential for a module that is not
   * registered would be a credential nothing can resolve, so this refuses rather than creating
   * anything — and the FK says the same thing in the schema.
   */
  async rotateCapabilityCredential(
    actorId: string,
    moduleId: string,
    capability: string
  ): Promise<{ secret: string }> {
    if (!isValidContract(capability)) {
      throw new BadRequestException('قرارداد باید در قالب name@v<major> باشد.');
    }

    const registration = await this.loadRegistrationIdentityOrThrow(moduleId);

    const secret = randomBytes(MODULE_SECRET_BYTES).toString('hex');
    const envelope = this.crypto.encrypt(secret);

    let rotated: CapabilityCredentialRow;

    try {
      rotated = await this.prisma.moduleCapabilityCredential.upsert({
        where: { moduleId_capability: { moduleId, capability } },
        create: {
          moduleId,
          capability,
          secretCiphertext: envelope.ciphertext,
          secretIv: envelope.iv,
          secretAuthTag: envelope.authTag,
          secretUpdatedAt: new Date(),
        },
        update: {
          secretCiphertext: envelope.ciphertext,
          secretIv: envelope.iv,
          secretAuthTag: envelope.authTag,
          secretUpdatedAt: new Date(),
        },
      });
    } catch (err) {
      // The registration disappeared between the read above and this write, so the FK refused
      // it. A 404 rather than a 500: the module really is gone, and its CASCADE means there is no
      // credential left to replace either.
      if (this.isMissingParent(err)) throw new NotFoundException(MODULE_NOT_FOUND_MESSAGE);

      throw err;
    }

    // The ADR's payload and nothing else. `capability` names WHICH credential moved; the value is
    // never written to a trail, and containment matters most in the lifecycle table because it is
    // read by an operator-facing timeline API rather than only during an incident.
    const detail = { capability, generated: true };

    // `resourceId` IS THE CREDENTIAL'S ID, so the resource has to say so: recording it as a
    // `ModuleRegistration` row would leave the id in the audit trail pointing at a row in another
    // table — at nothing.
    await this.record(
      AUDIT_ACTIONS.CAPABILITY_CREDENTIAL_ROTATED,
      actorId,
      rotated.id,
      detail,
      'ModuleCapabilityCredential'
    );

    // The subject is the REGISTRATION, per the rule `emitLifecycle` documents: an operator reads
    // a timeline per module, so the module-hop credential and every capability credential land on
    // ONE subject and `capability` in `detail` says which one moved.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.CAPABILITY_CREDENTIAL_ROTATED,
      'SUCCEEDED',
      registration.id,
      registration.moduleId,
      actorId,
      detail
    );

    return { secret };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Module self-service: registration, heartbeat, deregistration
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Records one instance announcement (§7/§8/§18).
   *
   * THE ORDER OF DECISIONS IS THE SECURITY MODEL, and every step is refused rather than
   * worked around:
   *   1. the LOGICAL module must already be registered — an unknown `moduleId` cannot create
   *      itself, so a module gains no platform status merely by being able to POST (§7);
   *   2. the ENDPOINT is validated against the SSRF policy AND the deployment-mode transport
   *      rule (§40), before anything is stored;
   *   3. COMPATIBILITY is checked (§18) — a mismatch is stored as INCOMPATIBLE and returns
   *      accepted:false, never a partially activated instance;
   *   4. the module's admitted state decides the lifecycle: a disabled registration yields a
   *      DISABLED instance, so a module cannot bring itself online by re-announcing.
   *
   * AUTHENTICATION HAPPENS BEFORE THIS METHOD, in the controller's HMAC verification. The
   * separation is the same one 49L uses for its callback: verification is a transport
   * concern, and mixing it into the domain service would make the service impossible to test
   * without signing every fixture.
   *
   * UPSERT ON `instanceId`: a restarted instance re-announces with the same id and updates
   * its row. Inserting instead would leave a stale duplicate that the resolver would happily
   * return until the sweep marked it unavailable.
   */
  async registerInstance(dto: RegisterModuleDto): Promise<ModuleRegistrationResult> {
    const identity = { moduleId: dto.moduleId, instanceId: dto.instanceId };

    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId: dto.moduleId },
    });

    // (1) §7 — no self-creation. NotFound rather than an auto-create: a module that can
    // register itself into existence is a module that admitted itself.
    if (!registration) {
      throw new NotFoundException('ماژول ثبت‌نشده است.');
    }

    // (2) §40 — the endpoint policy, applied before any write.
    const endpoint = evaluateModuleEndpoint(dto.baseUrl ?? null, dto.deploymentMode);

    if (!endpoint.ok) {
      return {
        accepted: false,
        identity,
        lifecycle: 'INCOMPATIBLE',
        reason: 'ENDPOINT_REJECTED',
        heartbeatIntervalMs: MODULE_HEARTBEAT_INTERVAL_MS,
      };
    }

    // (3) §18 — compatibility, no partial activation.
    const capabilities = dto.capabilities ?? [];
    const apiContracts = dto.apiContracts ?? [];
    const compatibility = checkCompatibility({
      protocolVersion: dto.protocolVersion,
      apiContracts,
      capabilities,
    });

    // (4) The admitted state, and ONLY the admitted state, decides whether this instance may
    // serve. Note there is no `dto.enabled` anywhere in this expression.
    const lifecycle: ModuleLifecycleState = !compatibility.ok
      ? ModuleLifecycleState.INCOMPATIBLE
      : registration.enabled
        ? ModuleLifecycleState.ACTIVE
        : ModuleLifecycleState.DISABLED;

    const health: ModuleHealthState = !compatibility.ok
      ? ModuleHealthState.UNAVAILABLE
      : registration.enabled
        ? // UNKNOWN, not HEALTHY: registration is an announcement, not an observation. The
          // probe or the module's own heartbeat is what makes it healthy.
          ModuleHealthState.UNKNOWN
        : ModuleHealthState.DISABLED;

    const data = {
      registrationId: registration.id,
      moduleId: registration.moduleId,
      deploymentMode: dto.deploymentMode as ModuleDeploymentMode,
      version: dto.version,
      baseUrl: dto.baseUrl ?? null,
      healthPath: dto.healthPath ?? '/health',
      capabilities,
      apiContracts,
      eventContracts: dto.eventContracts ?? [],
      lifecycle,
      health,
      healthErrorCode: compatibility.ok ? null : (compatibility.failure ?? 'INCOMPATIBLE'),
      lastSeenAt: new Date(),
    };

    await this.prisma.moduleInstance.upsert({
      where: { instanceId: dto.instanceId },
      create: { instanceId: dto.instanceId, ...data },
      update: data,
    });

    await this.record(AUDIT_ACTIONS.INSTANCE_REGISTERED, null, registration.id, {
      moduleId: registration.moduleId,
      instanceId: dto.instanceId,
      deploymentMode: dto.deploymentMode,
      version: dto.version,
      lifecycle,
      compatible: compatibility.ok,
    });

    // PHASE IS NOT ALWAYS 'SUCCEEDED' HERE, and this is the one emission in this file where
    // that distinction carries information. An INCOMPATIBLE announcement is a REFUSAL — the
    // row was written, the instance was not admitted — and normalizing it to SUCCEEDED because
    // the upsert worked would make the timeline claim a module came online when it was turned
    // away. `outcomeCode` keeps the specific compatibility failure verbatim.
    //
    // A DISABLED lifecycle is still SUCCEEDED: the announcement was accepted and correctly
    // pinned by the administrator's decision, which is not a failure of anything.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.INSTANCE_REGISTERED,
      compatibility.ok ? 'SUCCEEDED' : 'REFUSED',
      registration.id,
      registration.moduleId,
      null,
      {
        lifecycle,
        health,
        compatible: compatibility.ok,
        // The DECLARED version, not an endpoint. §40's baseUrl never enters this row.
        version: dto.version,
        capabilityCount: capabilities.length,
      },
      { instanceId: dto.instanceId, deploymentMode: dto.deploymentMode },
      compatibility.ok ? undefined : (compatibility.failure ?? 'INCOMPATIBLE')
    );

    return {
      accepted: compatibility.ok,
      identity,
      lifecycle: lifecycle as ModuleLifecycleValue,
      reason: compatibility.ok
        ? registration.enabled
          ? undefined
          : 'MODULE_DISABLED'
        : compatibility.failure,
      heartbeatIntervalMs: MODULE_HEARTBEAT_INTERVAL_MS,
    };
  }

  /**
   * Refreshes `lastSeenAt` and, optionally, the module's self-reported state (§14).
   *
   * A HEARTBEAT CANNOT PROMOTE AN INSTANCE PAST ITS ADMITTED STATE. An INCOMPATIBLE or
   * DISABLED instance stays where it is: the update below only moves UNAVAILABLE →
   * ACTIVE/DEGRADED, so a module cannot heartbeat its way out of a failed compatibility
   * check or an administrator's decision.
   *
   * IT ALSO CANNOT CHANGE DECLARATIONS. The DTO carries no endpoint, no version, no
   * capabilities and no contracts, so there is no field here through which §18 could be
   * bypassed one heartbeat at a time.
   */
  async heartbeat(
    moduleId: string,
    instanceId: string,
    state?: ModuleHealthValue
  ): Promise<{
    acknowledged: boolean;
    heartbeatIntervalMs: number;
    lifecycle: ModuleLifecycleValue;
  }> {
    const instance = await this.prisma.moduleInstance.findUnique({
      where: { instanceId },
      select: {
        id: true,
        moduleId: true,
        lifecycle: true,
        registration: { select: { enabled: true } },
      },
    });

    // A heartbeat for an instance that belongs to a DIFFERENT module is rejected as unknown,
    // not as forbidden: distinguishing them would tell a caller which instance ids exist.
    if (!instance || instance.moduleId !== moduleId) {
      throw new NotFoundException('نمونه ماژول یافت نشد.');
    }

    const terminal =
      instance.lifecycle === ModuleLifecycleState.INCOMPATIBLE ||
      instance.lifecycle === ModuleLifecycleState.DISABLED ||
      instance.lifecycle === ModuleLifecycleState.DEREGISTERED;

    // A disabled REGISTRATION also pins the instance: the parent's decision outranks the
    // child's report, always.
    const pinned = terminal || !instance.registration.enabled;

    const reported = state ?? 'HEALTHY';
    const lifecycle = pinned
      ? instance.lifecycle
      : reported === 'DEGRADED'
        ? ModuleLifecycleState.DEGRADED
        : reported === 'UNAVAILABLE'
          ? ModuleLifecycleState.UNAVAILABLE
          : ModuleLifecycleState.ACTIVE;

    await this.prisma.moduleInstance.update({
      where: { id: instance.id },
      data: {
        lastSeenAt: new Date(),
        ...(pinned
          ? {}
          : {
              lifecycle,
              health: reported as ModuleHealthState,
              healthErrorCode: reported === 'HEALTHY' ? null : undefined,
            }),
      },
    });

    // NOT AUDITED, and §33 says so explicitly: a heartbeat every 30 seconds per instance
    // would bury every real registry mutation in the audit trail.
    return {
      acknowledged: true,
      heartbeatIntervalMs: MODULE_HEARTBEAT_INTERVAL_MS,
      lifecycle: lifecycle as ModuleLifecycleValue,
    };
  }

  /**
   * Records a module's own orderly shutdown (§15).
   *
   * THE ROW IS KEPT, not deleted. A DEREGISTERED row is how an operator sees that an instance
   * left deliberately rather than crashed — deleting it would make a clean shutdown and a
   * vanished instance indistinguishable, which is precisely the distinction that matters when
   * something is missing.
   */
  async deregisterInstance(
    moduleId: string,
    instanceId: string
  ): Promise<{ deregistered: boolean }> {
    const instance = await this.prisma.moduleInstance.findUnique({
      where: { instanceId },
      select: { id: true, moduleId: true, registrationId: true },
    });

    if (!instance || instance.moduleId !== moduleId) {
      throw new NotFoundException('نمونه ماژول یافت نشد.');
    }

    await this.prisma.moduleInstance.update({
      where: { id: instance.id },
      data: {
        lifecycle: ModuleLifecycleState.DEREGISTERED,
        health: ModuleHealthState.UNAVAILABLE,
        // Cleared so the row leaves the partial staleness index entirely: a deregistered
        // instance cannot become "more stale", and sweeping it forever would be waste.
        lastSeenAt: null,
      },
    });

    await this.record(AUDIT_ACTIONS.INSTANCE_DEREGISTERED, null, instance.registrationId, {
      moduleId,
      instanceId,
    });

    this.emitLifecycle(
      LIFECYCLE_EVENTS.INSTANCE_DEREGISTERED,
      'SUCCEEDED',
      instance.registrationId,
      moduleId,
      null,
      // An ORDERLY shutdown, which is the fact this row exists to preserve: the alternative —
      // a swept, stale instance — never reaches this method at all.
      { orderly: true },
      { instanceId }
    );

    return { deregistered: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Discovery
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolves a LOGICAL module id to one callable instance (§11).
   *
   * THIS IS THE ONLY WAY TO REACH A MODULE, and the shape of the method is why the phase's
   * central rule holds: the input is a logical id and a contract, and no caller anywhere can
   * supply a URL, a host, an instance id or a deployment mode. `resolve('finance')` behaves
   * identically whether finance is in this process or on another continent.
   *
   * IT NEVER THROWS. A missing, disabled, tenant-forbidden or unhealthy module is a normal
   * state of a distributed system (§27), so every outcome is a result object. Throwing would
   * make an optional module's absence take down the Core operation that asked about it.
   *
   * THE TENANT COMES FROM THE REQUEST CONTEXT, never from an argument (§21). There is
   * deliberately no `tenantId` parameter: a caller that could pass one could ask for another
   * tenant's module.
   *
   * ONE QUERY, and it is index-covered by
   * `ModuleInstance_moduleId_lifecycle_lastSeenAt_idx`. No probe, no fan-out, no N+1 (§45):
   * health is READ from the row, and freshness is computed from `lastSeenAt` in memory.
   *
   * THE MEMBERSHIP READ IS THE ONE ADDITION, AND IT IS CONDITIONAL (§45.4 item 3). An
   * `ALL`- or `RESTRICTED`-scoped module is resolved with exactly the query count it had
   * before Phase 54-C, because `ALL` needs no membership at all and `RESTRICTED` reads the
   * array already on the row. Only a `RESTRICTED_MEMBERS` registration costs one more
   * indexed read, against the unique key
   * `ModuleRegistrationTenant_registrationId_tenantId_key`, and it is the same Core-owned
   * read the inbound entitlement gate makes — one source of truth, so the gate and the
   * resolver cannot disagree about who is entitled.
   */
  async resolve(moduleId: string, contract?: string): Promise<ModuleResolution> {
    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId },
      select: {
        id: true,
        enabled: true,
        tenantScope: true,
        tenantIds: true,
        instances: {
          where: { lifecycle: { in: RESOLVABLE_LIFECYCLES as ModuleLifecycleState[] } },
          orderBy: [{ health: 'asc' }, { lastSeenAt: 'desc' }],
          take: 10,
        },
      },
    });

    if (!registration) return { ok: false, failure: 'MODULE_NOT_FOUND' };
    if (!registration.enabled) return { ok: false, failure: 'MODULE_DISABLED' };

    // §21 — the caller's tenant, from the trusted authenticated context. `null` is a real
    // value and is checked as one: a tenant-less caller is admitted only by an ALL-scoped
    // module, never by a scoped one, because "no tenant" is not a member of any list.
    //
    // §45.4 item 3 — THE CHECK IS EXHAUSTIVE BY CONSTRUCTION. Every scope that is not `ALL`
    // must PROVE membership, so a member added to the enum later cannot be silently admitted
    // by a `=== RESTRICTED` test that no longer matches anything (the exact widening that
    // motivated this shape). `RESTRICTED` reads the legacy array byte-identically to before;
    // `RESTRICTED_MEMBERS` reads the child table, which is its ONLY membership source — its
    // array is required to be empty by `ModuleRegistration_tenantScope_consistent`, so a row
    // listing this tenant there still refuses here. The `default` branch refuses rather than
    // falls through, which is what makes an unrecognised scope fail closed.
    const tenantId = RequestContextService.get()?.tenantId ?? null;

    switch (registration.tenantScope) {
      // Zero queries: the scope IS the answer, and an ALL-scoped module's resolution stays a
      // single indexed read (§45.4 item 3 keeps that property for every module that has not
      // opted into RESTRICTED_MEMBERS).
      case ModuleTenantScope.ALL:
        break;

      case ModuleTenantScope.RESTRICTED:
        if (tenantId === null || !registration.tenantIds.includes(tenantId)) {
          return { ok: false, failure: 'MODULE_FORBIDDEN' };
        }
        break;

      case ModuleTenantScope.RESTRICTED_MEMBERS: {
        if (tenantId === null) return { ok: false, failure: 'MODULE_FORBIDDEN' };

        // Presence is membership (§45.5), and this is the same Core-owned read the inbound
        // gate makes — one source of truth, so the outbound path cannot disagree with the
        // gate about who is entitled.
        const membership = await this.prisma.moduleRegistrationTenant.findUnique({
          where: {
            registrationId_tenantId: { registrationId: registration.id, tenantId },
          },
          select: { id: true },
        });

        if (membership === null) return { ok: false, failure: 'MODULE_FORBIDDEN' };
        break;
      }

      default:
        // Unreachable while the enum has three members (`tsc` proves the cases above cover
        // it), and deliberately not a fall-through: a fourth member must refuse.
        return { ok: false, failure: 'MODULE_FORBIDDEN' };
    }

    const now = Date.now();

    // Freshness in memory rather than in SQL, so the ordering above stays index-friendly.
    // A stale instance is skipped, not returned-and-hoped-for: the sweep will demote it, and
    // in the meantime a caller should be told UNAVAILABLE instead of timing out.
    const candidates = registration.instances.filter((instance) => {
      if (instance.health === ModuleHealthState.UNAVAILABLE) return false;
      if (instance.lastSeenAt === null) return false;
      if (now - instance.lastSeenAt.getTime() > MODULE_STALE_AFTER_MS) return false;

      // A transport-requiring instance with no endpoint is unresolvable. The DB CHECK makes
      // this unreachable for REMOTE/CENTRAL/HYBRID; it is still checked because LOCAL is
      // allowed to have none and the transport must not be handed a null URL.
      if (instance.deploymentMode !== ModuleDeploymentMode.LOCAL && !instance.baseUrl) {
        return false;
      }

      // §18 again, at call time: an instance that no longer declares the required contract is
      // not a candidate. Re-checked here rather than trusted from registration because a
      // re-announcement can change declarations.
      if (contract && !instance.apiContracts.includes(contract)) return false;

      return true;
    });

    if (candidates.length === 0) {
      // Distinguishes "nothing healthy" from "nothing that speaks this contract", because the
      // two demand different operator actions: restart the module vs upgrade it.
      const contractMismatch =
        contract !== undefined &&
        registration.instances.length > 0 &&
        !registration.instances.some((instance) => instance.apiContracts.includes(contract));

      return {
        ok: false,
        failure: contractMismatch ? 'CONTRACT_UNSUPPORTED' : 'MODULE_UNAVAILABLE',
      };
    }

    // FIRST CANDIDATE, deliberately: healthiest (enum order puts HEALTHY first) then most
    // recently seen. Not round-robin, not random — §12 asks only that MULTIPLE INSTANCES be
    // MODELLED, and inventing a balancing policy here would be a load-balancer nobody
    // measured. The list is a list, so adding one later changes this line and nothing else.
    return { ok: true, instance: this.toResolved(candidates[0]) };
  }

  /**
   * Resolves the shared credential for one module, for the transport layer only.
   *
   * WHY THIS IS A SEPARATE METHOD FROM `resolve`: so the credential never travels with the
   * resolved instance. `ResolvedModuleInstance` has no secret field, so a caller holding one
   * cannot leak a credential through a log line, an error message or a serialised response —
   * and `ModuleClient` is the only caller of this method.
   *
   * EXPIRY IS ENFORCED HERE (§20). An expired credential is treated as absent rather than
   * used-and-hoped-for, so the call fails at this end with a clear code instead of producing
   * an unexplained 401 at the far end.
   */
  async resolveSecret(moduleId: string): Promise<string | undefined> {
    const row = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId },
      select: {
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        secretExpiresAt: true,
      },
    });

    if (!row) return undefined;
    if (isSecretExpired(row.secretExpiresAt)) return undefined;

    return this.readSecret(row);
  }

  /**
   * Resolves the capability credential for one `(moduleId, capability)` pair, for the transport
   * layer only (ADR-0006 A8).
   *
   * THE SAME CONTRACT AS `resolveSecret` ABOVE, ON A DIFFERENT KEY, and a separate method for the
   * same reason: the credential never travels with anything else. It never throws — a caller that
   * cannot obtain a value must fail closed — and `undefined` covers every way there is no usable
   * credential: no such module, no such capability, an expired envelope, or one that will not
   * decrypt.
   *
   * EXPIRY IS ENFORCED HERE, exactly as `resolveSecret` enforces it. An expired capability
   * credential is treated as ABSENT rather than used-and-hoped-for, so the refusal happens at
   * this end with a known cause instead of producing an unexplained 401 at the far end.
   *
   * A MALFORMED DESCRIPTOR SHORT-CIRCUITS. Nothing invalid can have been stored — the write path
   * and the table CHECK both refuse it — so the query would only ever return nothing; answering
   * without a round trip also documents that this resolver is not a way to probe the table with
   * crafted input.
   */
  async resolveCapabilityCredential(
    moduleId: string,
    capability: string
  ): Promise<string | undefined> {
    if (!isValidContract(capability)) return undefined;

    const row = await this.prisma.moduleCapabilityCredential.findUnique({
      where: { moduleId_capability: { moduleId, capability } },
      select: {
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        secretExpiresAt: true,
      },
    });

    if (!row) return undefined;
    if (isSecretExpired(row.secretExpiresAt)) return undefined;

    return this.readSecret(row);
  }

  /**
   * Demotes instances that have not been heard from within the stale threshold (§14).
   *
   * BOUNDED AND CLAIM-FREE. Unlike 49L's retry pass this needs no conditional claim: the
   * update is IDEMPOTENT — setting an already-UNAVAILABLE row to UNAVAILABLE changes nothing
   * — so two API instances running the sweep concurrently is harmless. That is why there is
   * no lock, no advisory lock and no leader election here; correctness comes from the
   * operation being idempotent rather than from being alone.
   *
   * IT USES THE PARTIAL INDEX: the `lifecycle IN (…)` predicate matches
   * `ModuleInstance_lastSeenAt_idx`'s WHERE clause exactly, so terminal rows are never
   * scanned.
   */
  async sweepStaleInstances(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - MODULE_STALE_AFTER_MS);

    const stale = await this.prisma.moduleInstance.findMany({
      where: {
        lifecycle: { in: SWEEPABLE_LIFECYCLES as ModuleLifecycleState[] },
        lastSeenAt: { lt: threshold },
      },
      select: { id: true },
      take: STALE_SWEEP_BATCH,
      orderBy: { lastSeenAt: 'asc' },
    });

    if (stale.length === 0) return 0;

    const result = await this.prisma.moduleInstance.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: {
        lifecycle: ModuleLifecycleState.UNAVAILABLE,
        health: ModuleHealthState.UNAVAILABLE,
        healthErrorCode: 'HEARTBEAT_STALE',
      },
    });

    if (result.count > 0) {
      this.logger.warn(
        { demoted: result.count, staleAfterMs: MODULE_STALE_AFTER_MS },
        'Module instances marked unavailable after missed heartbeats'
      );
    }

    return result.count;
  }

  /**
   * Records the observed health of one instance, after a probe.
   *
   * Called by `ModuleHealthService`, which owns the probing. Kept here because the registry
   * owns every write to `ModuleInstance` — a second writer would mean two places that decide
   * what a lifecycle transition means.
   *
   * A PROBE NEVER OVERRIDES AN ADMINISTRATOR OR THE COMPATIBILITY GATE: DISABLED,
   * DEREGISTERED and INCOMPATIBLE rows keep their lifecycle, and only `health` and
   * `lastProbedAt` change. Letting a successful probe promote an INCOMPATIBLE module to ACTIVE
   * would silently undo §18.
   */
  async recordProbe(
    instanceId: string,
    health: ModuleHealthValue,
    errorCode?: string
  ): Promise<void> {
    const instance = await this.prisma.moduleInstance.findUnique({
      where: { instanceId },
      select: { id: true, lifecycle: true },
    });

    if (!instance) return;

    const pinned =
      instance.lifecycle === ModuleLifecycleState.DISABLED ||
      instance.lifecycle === ModuleLifecycleState.DEREGISTERED ||
      instance.lifecycle === ModuleLifecycleState.INCOMPATIBLE;

    const lifecycle =
      health === 'HEALTHY'
        ? ModuleLifecycleState.ACTIVE
        : health === 'DEGRADED'
          ? ModuleLifecycleState.DEGRADED
          : ModuleLifecycleState.UNAVAILABLE;

    await this.prisma.moduleInstance.update({
      where: { id: instance.id },
      data: {
        health: health as ModuleHealthState,
        healthErrorCode: errorCode ?? null,
        lastProbedAt: new Date(),
        // A REACHABLE instance is also a SEEN instance: a successful probe is evidence of
        // life, so it refreshes the staleness clock exactly as a heartbeat would. Without
        // this, a module that only answers probes would be swept while demonstrably healthy.
        ...(health === 'HEALTHY' || health === 'DEGRADED' ? { lastSeenAt: new Date() } : {}),
        ...(pinned ? {} : { lifecycle }),
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The registration's own identity, or a 404 — the guard every capability-credential path
   * starts with (ADR-0006 A8).
   *
   * `select` RATHER THAN A FULL ROW: these paths need the registration ROW ID (the lifecycle
   * subject every module event is keyed by) and its `moduleId`, and loading the instance list or
   * the envelope would mean reading a credential to answer a question about identity.
   *
   * ONE HELPER FOR READS AND WRITES, so "there is no capability credential without an admitted
   * module" is one code path rather than two that could disagree.
   */
  private async loadRegistrationIdentityOrThrow(
    moduleId: string
  ): Promise<{ id: string; moduleId: string }> {
    const row = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId },
      select: { id: true, moduleId: true },
    });

    if (!row) throw new NotFoundException(MODULE_NOT_FOUND_MESSAGE);

    return row;
  }

  private async loadOrThrow(id: string): Promise<RegistrationRow> {
    const row = await this.prisma.moduleRegistration.findUnique({
      where: { id },
      include: { instances: { orderBy: { instanceId: 'asc' } } },
    });

    if (!row) throw new NotFoundException(MODULE_NOT_FOUND_MESSAGE);

    return row;
  }

  /**
   * THE ONLY projection of a registration, and the reason the secret cannot leak: there is no
   * branch here that emits `secretCiphertext`, `secretIv` or `secretAuthTag`, and
   * `PublicModuleRegistration` has no field to put them in.
   */
  private toPublicRegistration(row: RegistrationRow): PublicModuleRegistration {
    const instances = row.instances.map((instance) => this.toPublicInstance(instance));

    return {
      id: row.id,
      moduleId: row.moduleId,
      displayName: row.displayName,
      moduleType: row.moduleType,
      enabled: row.enabled,
      tenantScope: row.tenantScope,
      tenantIds: row.tenantIds,
      protocolVersion: row.protocolVersion,
      hasCredential: Boolean(row.secretCiphertext && row.secretIv && row.secretAuthTag),
      credentialUpdatedAt: row.secretUpdatedAt,
      credentialExpiresAt: row.secretExpiresAt,
      derivedLifecycle: this.deriveLifecycle(row.enabled, instances),
      aggregateHealth: this.aggregateHealth(row.enabled, instances),
      instances,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * THE ONLY projection of a capability credential, and the A8 rule made structural: there is no
   * branch here that emits `secretCiphertext`, `secretIv` or `secretAuthTag`, and
   * `PublicCapabilityCredential` has no field to put them in — so a projection that tried to
   * include one would not compile.
   *
   * `hasSecret` IS THE READ-BACK ANSWER, exactly as `hasCredential` is for a registration. A row
   * may exist with a NULL envelope (the schema models "declared, not yet issued"), so an operator
   * asking "is this capability provisioned?" gets a boolean instead of a value nobody is allowed
   * to read.
   */
  private toPublicCapabilityCredential(row: CapabilityCredentialRow): PublicCapabilityCredential {
    return {
      id: row.id,
      moduleId: row.moduleId,
      capability: row.capability,
      hasSecret: Boolean(row.secretCiphertext && row.secretIv && row.secretAuthTag),
      credentialUpdatedAt: row.secretUpdatedAt,
      credentialExpiresAt: row.secretExpiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toPublicInstance(instance: RegistrationRow['instances'][number]): PublicModuleInstance {
    return {
      id: instance.id,
      instanceId: instance.instanceId,
      moduleId: instance.moduleId,
      deploymentMode: instance.deploymentMode,
      version: instance.version,
      baseUrl: instance.baseUrl,
      healthPath: instance.healthPath,
      capabilities: instance.capabilities,
      apiContracts: instance.apiContracts,
      eventContracts: instance.eventContracts,
      lifecycle: instance.lifecycle,
      health: instance.health,
      healthErrorCode: instance.healthErrorCode,
      lastSeenAt: instance.lastSeenAt,
      lastProbedAt: instance.lastProbedAt,
      stale: this.isStale(instance.lastSeenAt, instance.lifecycle),
      createdAt: instance.createdAt,
    };
  }

  /**
   * Whether an instance has gone quiet.
   *
   * Terminal lifecycles are NEVER stale: a DISABLED or DEREGISTERED instance is not expected
   * to heartbeat, so reporting it as stale would be an alarm about a decision somebody made
   * deliberately.
   */
  private isStale(lastSeenAt: Date | null, lifecycle: ModuleLifecycleState): boolean {
    if (!SWEEPABLE_LIFECYCLES.includes(lifecycle as ModuleLifecycleValue)) return false;
    if (lastSeenAt === null) return true;

    return Date.now() - lastSeenAt.getTime() > MODULE_STALE_AFTER_MS;
  }

  /**
   * The LOGICAL module's lifecycle, derived rather than stored.
   *
   * DISCOVERED means "admitted, never announced" — the one state that belongs to the logical
   * module and to no instance, which is exactly why it is not an enum member (a column would
   * be wrong for every row that has an instance). The rest is the BEST instance state, so a
   * module with one healthy and one broken instance reads ACTIVE: it can serve.
   */
  private deriveLifecycle(
    enabled: boolean,
    instances: PublicModuleInstance[]
  ): ModuleLifecycleValue | 'DISCOVERED' {
    if (instances.length === 0) return 'DISCOVERED';
    if (!enabled) return 'DISABLED';

    const states = new Set(instances.map((instance) => instance.lifecycle));

    if (states.has(ModuleLifecycleState.ACTIVE)) return 'ACTIVE';
    if (states.has(ModuleLifecycleState.DEGRADED)) return 'DEGRADED';
    if (states.has(ModuleLifecycleState.REGISTERED)) return 'REGISTERED';
    if (states.has(ModuleLifecycleState.INCOMPATIBLE)) return 'INCOMPATIBLE';
    if (states.has(ModuleLifecycleState.UNAVAILABLE)) return 'UNAVAILABLE';

    return 'DEREGISTERED';
  }

  /**
   * WORST health across instances, and the asymmetry with `deriveLifecycle` is intentional.
   *
   * Lifecycle answers "can this module serve?" — one good instance is enough. Health answers
   * "is anything wrong?" — and one broken instance IS something wrong. Reporting the best
   * health would hide a dead instance behind a live one, which is the failure that gets
   * noticed only when the live one also dies.
   */
  private aggregateHealth(enabled: boolean, instances: PublicModuleInstance[]): ModuleHealthValue {
    if (!enabled) return 'DISABLED';
    if (instances.length === 0) return 'UNKNOWN';

    const states = new Set(
      instances.map((instance) =>
        instance.stale ? ModuleHealthState.UNAVAILABLE : instance.health
      )
    );

    if (states.has(ModuleHealthState.UNAVAILABLE)) return 'UNAVAILABLE';
    if (states.has(ModuleHealthState.DEGRADED)) return 'DEGRADED';
    if (states.has(ModuleHealthState.UNKNOWN)) return 'UNKNOWN';
    if (states.has(ModuleHealthState.HEALTHY)) return 'HEALTHY';

    return 'DISABLED';
  }

  /** The transport's view of an instance. Carries no credential, by construction. */
  private toResolved(instance: RegistrationRow['instances'][number]): ResolvedModuleInstance {
    return {
      moduleId: instance.moduleId,
      instanceId: instance.instanceId,
      version: instance.version,
      deploymentMode: instance.deploymentMode as ModuleDeploymentModeValue,
      baseUrl: instance.baseUrl,
      healthPath: instance.healthPath,
      capabilities: instance.capabilities,
      apiContracts: instance.apiContracts,
      lifecycle: instance.lifecycle as ModuleLifecycleValue,
      health: instance.health as ModuleHealthValue,
      lastSeenAt: instance.lastSeenAt,
    };
  }

  /**
   * Decrypts a stored credential, or returns undefined.
   *
   * SWALLOWS THE ERROR ON PURPOSE, matching `IntegrationService.readSecret` (49L): a
   * decryption failure means the master key changed or the row is corrupt, and the useful
   * behaviour is "there is no usable credential" rather than a 500 in whatever operation
   * happened to trigger the call. Nothing about the failure is logged, because a GCM failure
   * message can carry fragments of the material.
   */
  private readSecret(row: {
    secretCiphertext: string | null;
    secretIv: string | null;
    secretAuthTag: string | null;
  }): string | undefined {
    if (!row.secretCiphertext || !row.secretIv || !row.secretAuthTag) return undefined;

    try {
      return this.crypto.decrypt({
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        authTag: row.secretAuthTag,
      });
    } catch {
      return undefined;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }

  /**
   * A foreign-key refusal (ADR-0006 A8): the parent row was removed between a check and the
   * write. Kept beside `isUniqueViolation` because both translate a Prisma code into a refusal a
   * caller can act on instead of a 500.
   */
  private isMissingParent(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2003';
  }

  /**
   * Writes one audit row, best-effort.
   *
   * NEVER THROWS AND NEVER CARRIES A CREDENTIAL. The audit sink is optional (see the
   * constructor), and a failure to record must not fail the mutation that was recorded — the
   * same rule `IntegrationService.record` follows. `actorId` is null for a MODULE-initiated
   * action, which is honest: no human did it.
   */
  private async record(
    action: string,
    actorId: string | null,
    resourceId: string,
    payload: Record<string, unknown>,
    // ADR-0006 A8: the resource TYPE is a parameter because a capability credential's id is not a
    // `ModuleRegistration` id, and an audit trail whose ids point at the wrong table cannot be
    // reconstructed — the reader cannot tell which table to look in. Defaults to the registration,
    // which is what every pre-A8 call site meant.
    resource: string = 'ModuleRegistration'
  ): Promise<void> {
    if (!this.audit) return;

    const context = RequestContextService.get();

    try {
      await this.audit.log({
        requestId: context?.requestId ?? 'module-platform',
        correlationId: context?.correlationId,
        userId: actorId,
        action,
        resource,
        resourceId,
        newValue: payload,
        success: true,
      });
    } catch (err) {
      this.logger.warn(
        { action, err: err instanceof Error ? err.message : 'unknown' },
        'Module registry audit write failed'
      );
    }
  }

  /** Exposed for the connection test, which audits its own outcome. */
  async recordConnectionTest(
    actorId: string,
    id: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.record(AUDIT_ACTIONS.CONNECTION_TESTED, actorId, id, payload);
  }

  /**
   * Emits one lifecycle transition into observability_db, best-effort.
   *
   * PHASE 49M-2. Sits beside `record()` above and follows the same three rules — never
   * throws, never carries a credential, `actorId` is null for a MODULE-initiated action — but
   * writes a DIFFERENT database: `observability_db."LifecycleEvent"` rather than
   * `core_db."AuditLog"`. Neither replaces the other, and neither is in a transaction with
   * the mutation it describes.
   *
   * `module` CARRIES THE DISTRIBUTED IDENTITY (`moduleId`/`instanceId`), which is the field
   * that makes a registry row joinable with a provisioning row in the same query — the whole
   * reason `ObservabilityModuleContext` exists rather than these ids being buried in `detail`.
   *
   * `subjectId` IS THE REGISTRATION ROW ID and `subjectKey` IS THE LOGICAL `moduleId`, for
   * both instance and registration events. That is deliberate: an operator reads a timeline
   * per MODULE, and keying instance events by their own id would scatter one module's history
   * across as many subjects as it has instances.
   */
  private emitLifecycle(
    eventType: string,
    phase: LifecyclePhaseValue,
    registrationId: string,
    moduleId: string,
    actorId: string | null,
    detail: Record<string, unknown> = {},
    context: { instanceId?: string | null; deploymentMode?: string | null } = {},
    outcomeCode?: string
  ): void {
    if (!this.lifecycle) return;

    try {
      const extra: Partial<LifecycleEventInput> = {
        // A module announcing itself is genuinely not a user action, and claiming SYSTEM for
        // an administrator's decision would erase who made it. `actorId === null` is the
        // honest marker of a module-initiated transition, exactly as in `record()`.
        actorType: actorId ? 'USER' : 'MODULE',
        actorId,
        outcomeCode: outcomeCode ?? null,
        module: {
          moduleId,
          instanceId: context.instanceId ?? null,
          deploymentMode: context.deploymentMode ?? null,
        },
        detail,
      };

      this.lifecycle.module(eventType, phase, { id: registrationId, key: moduleId }, extra);
    } catch (err) {
      this.logger.warn(
        { eventType, err: err instanceof Error ? err.message : 'unknown' },
        'Module registry lifecycle emission failed'
      );
    }
  }
}
