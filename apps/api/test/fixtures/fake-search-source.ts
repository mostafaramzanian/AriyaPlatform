import {
  SearchSourceRegistrationError,
  validateSearchProjectionBatch,
  validateSearchSourceAdapter,
  validateSearchSourceRemovalIds,
  type RegisteredSearchSource,
  type SearchProjectionRecord,
  type SearchSourceAdapter,
  type SearchSourceAuthorizationRequest,
  type SearchSourceAuthorizationResult,
  type SearchSourceDescriptor,
  type SearchSourcePort,
} from '../../src/platform/search-source/search-source.contract';

/**
 * PHASE P-SEARCH-SOURCE (§33): the reusable, CONTRACT-DRIVEN fake for the
 * Platform Search Source port.
 *
 * WHY ONE SHARED FAKE, AND WHY CONTRACT-DRIVEN
 * --------------------------------------------
 * The platform ships no Commerce source, so no harness binds this port YET — the
 * future adapter's phase will, and it should not have to write a second in-memory
 * implementation of rules the platform already encodes. This factory validates
 * through the SAME `validate*` functions the Core binding uses, refuses with the
 * SAME `SearchSourceRegistrationError` codes, and answers authorization with the
 * SAME fail-closed shape (only seeded entities, only for an actor whose tenant
 * matches). A harness cannot pass while production would fail — the discipline
 * `fake-audit-port.ts` established for the audit port.
 *
 * WHAT "AUTHORITY" MEANS HERE
 * ---------------------------
 * Like a real adapter, the fake's authorization truth is its SEEDED ENTITY SET,
 * deliberately kept apart from its projections: the projection is a cache, the
 * seed is the row. A test that indexes an entity but never seeds it must see the
 * result vanish at authorization — that is the stale-index scenario, and a fake
 * that authorized its own projections could never prove it.
 *
 * DETERMINISM: entities are stored and returned in insertion order, timestamps
 * default to the fixed `FAKE_SEARCH_CLOCK` epoch, and nothing reads a clock, a
 * database or an environment variable.
 */

/** Fixed clock for rows that do not carry their own timestamp. */
export const FAKE_SEARCH_CLOCK = Date.UTC(2026, 0, 1);

/** One authoritative entity the fake adapter knows about. */
export interface FakeSearchSourceEntity {
  readonly entityId: string;
  /** Exact-equality bucket, exactly like `SearchDocument.tenantId`: null is a tenant, not a wildcard. */
  readonly tenantId: string | null;
  readonly title: string;
  readonly snippetFields: readonly string[];
  readonly timestamp?: Date;
  /**
   * When present, ONLY these user ids may read the entity (ownership rule).
   * Absent = any actor of the SAME tenant may read it (tenant rule).
   */
  readonly readableBy?: readonly string[];
}

/** A registration as the fake returns it: the writer handle plus seeding controls. */
export interface FakeSearchSourceRegistration extends RegisteredSearchSource {
  /** Seeds the adapter's AUTHORITY rows (what `authorize` answers from). */
  seed(entities: readonly FakeSearchSourceEntity[]): void;
  /** The registered adapter, for direct assertions. */
  readonly adapter: SearchSourceAdapter;
}

/** The fake port: the real interface, plus read-backs for assertions. */
export interface FakeSearchSourcePort extends SearchSourcePort {
  register(adapter: SearchSourceAdapter): FakeSearchSourceRegistration;
  /** Descriptors registered so far, in registration order. */
  sources(): SearchSourceDescriptor[];
  /** The projections currently held for a key (post-validation, as submitted). */
  projections(sourceKey: string): SearchProjectionRecord[];
  /** True when a projection row is held. */
  hasProjection(sourceKey: string, entityId: string): boolean;
  /**
   * Builds a seedable adapter for a descriptor: a REAL `SearchSourceAdapter` whose
   * `authorize` answers from the fake's authority store, plus a `seed` helper the
   * test uses to install entities. The extra helper is allowed because the adapter
   * check validates what the platform touches, not the object's full key set.
   */
  adapter(descriptor: SearchSourceDescriptor): FakeSearchSourceAdapter;
}

/** The fake adapter: registerable as-is, seedable from a test. */
export interface FakeSearchSourceAdapter extends SearchSourceAdapter {
  seed(entities: readonly FakeSearchSourceEntity[]): void;
}

/**
 * Creates one in-memory port. Each call is an isolated registry, so two suites
 * cannot observe each other's registrations, projections or authority rows.
 */
export function createFakeSearchSourcePort(): FakeSearchSourcePort {
  const descriptors = new Map<string, SearchSourceDescriptor>();
  const projections = new Map<string, SearchProjectionRecord[]>();
  const authority = new Map<string, Map<string, FakeSearchSourceEntity>>();

  const storeFor = (sourceKey: string): Map<string, FakeSearchSourceEntity> => {
    const existing = authority.get(sourceKey);
    if (existing) return existing;

    const created = new Map<string, FakeSearchSourceEntity>();
    authority.set(sourceKey, created);
    return created;
  };

  const adapter = (descriptor: SearchSourceDescriptor): FakeSearchSourceAdapter => {
    const store = storeFor(descriptor.key);

    return {
      descriptor,
      async authorize(
        request: SearchSourceAuthorizationRequest
      ): Promise<SearchSourceAuthorizationResult> {
        const entries = [];

        // Insertion order, filtered — no clock, no randomness, no I/O: the same
        // request against the same seed returns the same array, which is what
        // makes a harness assertion over ordering meaningful.
        for (const entityId of request.entityIds) {
          const entity = store.get(entityId);
          if (!entity) continue; // Unknown to the authority = unauthorized (fail-closed).

          if (entity.tenantId !== request.actor.tenantId) continue; // Exact-equality tenant rule.
          if (entity.readableBy && !entity.readableBy.includes(request.actor.userId)) continue;

          entries.push({
            entityId: entity.entityId,
            title: entity.title,
            snippetFields: [...entity.snippetFields],
            timestamp: entity.timestamp ?? new Date(FAKE_SEARCH_CLOCK),
          });
        }

        return { entries };
      },
      seed(next: readonly FakeSearchSourceEntity[]): void {
        for (const entity of next) store.set(entity.entityId, entity);
      },
    };
  };

  return {
    adapter,

    register(received: SearchSourceAdapter): FakeSearchSourceRegistration {
      // Contract-driven: the SAME validator and the SAME error codes as the real
      // binding, so a harness cannot pass while production would fail.
      const validation = validateSearchSourceAdapter(received);
      if (!validation.ok) {
        throw new SearchSourceRegistrationError(
          validation.code,
          `Search source rejected: ${validation.code}`
        );
      }

      const { descriptor } = received;
      if (descriptors.has(descriptor.key)) {
        throw new SearchSourceRegistrationError(
          'SOURCE_DUPLICATE',
          `Search source ${descriptor.key} is already registered`
        );
      }

      descriptors.set(descriptor.key, descriptor);
      projections.set(descriptor.key, []);
      storeFor(descriptor.key);

      return {
        descriptor,
        adapter: received,
        seed(entities: readonly FakeSearchSourceEntity[]): void {
          const store = storeFor(descriptor.key);
          for (const entity of entities) store.set(entity.entityId, entity);
        },
        async project(records: readonly SearchProjectionRecord[]) {
          const check = validateSearchProjectionBatch(records);
          if (!check.ok) return { status: 'rejected' as const, code: check.code };

          const held = projections.get(descriptor.key)!;
          for (const record of records) {
            const copy = { ...record, searchContent: [...record.searchContent] };
            const at = held.findIndex((row) => row.entityId === record.entityId);
            if (at === -1) held.push(copy);
            else held[at] = copy;
          }

          return {
            status: 'indexed' as const,
            indexed: records.length,
            // The fake has no embedding provider; lexical-only is the honest count.
            embedded: 0,
            skipped: [] as string[],
          };
        },
        async remove(entityIds: readonly string[]) {
          const check = validateSearchSourceRemovalIds(entityIds);
          if (!check.ok) return { status: 'rejected' as const, code: check.code };

          const held = projections.get(descriptor.key)!;
          const wanted = new Set(entityIds);
          const kept = held.filter((row) => !wanted.has(row.entityId));
          const removed = held.length - kept.length;
          projections.set(descriptor.key, kept);

          return { status: 'removed' as const, removed };
        },
      };
    },

    sources(): SearchSourceDescriptor[] {
      return [...descriptors.values()];
    },

    projections(sourceKey: string): SearchProjectionRecord[] {
      return [...(projections.get(sourceKey) ?? [])];
    },

    hasProjection(sourceKey: string, entityId: string): boolean {
      return (projections.get(sourceKey) ?? []).some((row) => row.entityId === entityId);
    },
  };
}

