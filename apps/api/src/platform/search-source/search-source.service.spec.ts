import { SearchSourceService } from './search-source.service';
import { SearchSourceRegistrationError, externalCandidateKey } from './search-source.contract';
import {
  SearchDocumentWriter,
  type IndexableSearchDocument,
  type SearchWriteResult,
} from './search-document.writer';
import { buildSearchText } from '../../search/persian-normalize';
import {
  OPTIONAL_SOURCE_WEIGHT,
  PRIMARY_SOURCE_WEIGHT,
} from '../../search/search.constants';

/**
 * Phase P-SEARCH-SOURCE: the registry, the ingestion boundary and the
 * query-time authorization dispatcher, pinned against a STUB writer.
 *
 * The writer is the one seam replaced here — everything above it (validation,
 * normalization, grouping, fail-closed semantics, route composition) is the real
 * implementation. The stub records what would be persisted and mirrors the real
 * writer's blank-skip rule, so these tests stay free of Postgres while still
 * asserting the EXACT rows the boundary would write.
 */

interface RecordedWrite {
  beginPasses: number;
  batches: IndexableSearchDocument[][];
  removals: Array<{ sourceType: string; sourceKey: string; sourceIds: string[] }>;
}

function stubWriter(): { writer: SearchDocumentWriter; record: RecordedWrite } {
  const record: RecordedWrite = { beginPasses: 0, batches: [], removals: [] };

  const writer = {
    beginPass(): void {
      record.beginPasses += 1;
    },
    async write(documents: readonly IndexableSearchDocument[]): Promise<SearchWriteResult> {
      record.batches.push([...documents]);
      const writable = documents.filter((document) => document.searchText.length > 0);
      return { written: writable.length, embedded: 0 };
    },
    async remove(
      sourceType: string,
      sourceKey: string,
      sourceIds: readonly string[]
    ): Promise<number> {
      record.removals.push({ sourceType, sourceKey, sourceIds: [...sourceIds] });
      return sourceIds.length;
    },
  } as unknown as SearchDocumentWriter;

  return { writer, record };
}

const descriptor = (over: Partial<Record<string, unknown>> = {}) => ({
  key: 'test.source',
  ownerModuleId: 'test',
  weightClass: 'PRIMARY' as const,
  routeTemplate: '/admin/test/:id',
  ...over,
});

const record = (entityId: string, over: Record<string, unknown> = {}) => ({
  entityId,
  tenantId: 'tenant-a',
  searchContent: ['PO-1', 'سند'],
  sourceUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

describe('SearchSourceService', () => {
  describe('registration', () => {
    it('accepts a valid adapter and lists its descriptor', () => {
      const { writer } = stubWriter();
      const service = new SearchSourceService(writer);

      const handle = service.register({
        descriptor: descriptor(),
        authorize: async () => ({ entries: [] }),
      });

      expect(handle.descriptor.key).toBe('test.source');
      expect(service.list()).toEqual([handle.descriptor]);
    });

    it('rejects a duplicate key with SOURCE_DUPLICATE', () => {
      const { writer } = stubWriter();
      const service = new SearchSourceService(writer);
      const adapter = { descriptor: descriptor(), authorize: async () => ({ entries: [] }) };

      service.register(adapter);

      expect(() => service.register({ ...adapter })).toThrow(SearchSourceRegistrationError);
      try {
        service.register({ ...adapter });
      } catch (error) {
        expect((error as SearchSourceRegistrationError).code).toBe('SOURCE_DUPLICATE');
      }
    });

    it.each([
      ['SOURCE_KEY_INVALID', { key: 'BAD KEY' }],
      ['SOURCE_OWNER_INVALID', { ownerModuleId: 'Bad_Owner' }],
      ['SOURCE_WEIGHT_CLASS_INVALID', { weightClass: 'HIGHEST' }],
      ['SOURCE_ROUTE_TEMPLATE_INVALID', { routeTemplate: 'https://evil.example' }],
    ] as const)('rejects a malformed descriptor with %s', (code, patch) => {
      const { writer } = stubWriter();
      const service = new SearchSourceService(writer);

      try {
        service.register({
          descriptor: descriptor(patch),
          authorize: async () => ({ entries: [] }),
        });
        throw new Error('registration should have thrown');
      } catch (error) {
        expect((error as SearchSourceRegistrationError).code).toBe(code);
      }
    });

    it('rejects an adapter without a callable authorize — at composition, not first search', () => {
      const { writer } = stubWriter();
      const service = new SearchSourceService(writer);

      expect(() =>
        service.register({ descriptor: descriptor() } as never)
      ).toThrow(SearchSourceRegistrationError);
      expect(service.list()).toEqual([]);
    });
  });

  describe('weight resolution', () => {
    it('maps the declared class to the platform EXISTING constants', () => {
      const { writer } = stubWriter();
      const service = new SearchSourceService(writer);

      service.register({
        descriptor: descriptor({ key: 'test.primary', weightClass: 'PRIMARY' }),
        authorize: async () => ({ entries: [] }),
      });
      service.register({
        descriptor: descriptor({ key: 'test.supporting', weightClass: 'SUPPORTING' }),
        authorize: async () => ({ entries: [] }),
      });

      expect(service.weightMultiplier('test.primary')).toBe(PRIMARY_SOURCE_WEIGHT);
      expect(service.weightMultiplier('test.supporting')).toBe(OPTIONAL_SOURCE_WEIGHT);
      // Unregistered key → null, which the ranking step treats as EXCLUDE.
      expect(service.weightMultiplier('test.unknown')).toBeNull();
    });
  });

  describe('projection (ingestion boundary)', () => {
    const setup = () => {
      const { writer, record } = stubWriter();
      const service = new SearchSourceService(writer);
      const handle = service.register({
        descriptor: descriptor(),
        authorize: async () => ({ entries: [] }),
      });
      return { service, handle, record };
    };

    it('writes EXTERNAL rows keyed by the REGISTERED source, normalized by the platform pipeline', async () => {
      const { handle, record: record$ } = setup();
      const content = ['PO-2026-0001', 'سند خرید'];
      const sourceUpdatedAt = new Date('2026-02-02T00:00:00.000Z');

      const result = await handle.project([
        { entityId: 'doc-1', tenantId: 'tenant-a', searchContent: content, sourceUpdatedAt },
      ]);

      expect(result).toEqual({ status: 'indexed', indexed: 1, embedded: 0, skipped: [] });
      expect(record$.beginPasses).toBe(1);
      expect(record$.batches).toHaveLength(1);

      const [row] = record$.batches[0];
      expect(row).toEqual({
        sourceType: 'EXTERNAL',
        sourceKey: 'test.source',
        sourceId: 'doc-1',
        tenantId: 'tenant-a',
        // The SAME normalization the platform's own indexer uses — not a second one.
        searchText: buildSearchText(content),
        sourceUpdatedAt,
      });
    });

    it('reports blank-normalizing content as skipped and does not write it', async () => {
      const { handle, record: record$ } = setup();

      const result = await handle.project([record('blank', { searchContent: ['!!!', '‌‌'] })]);

      expect(result).toEqual({
        status: 'indexed',
        indexed: 0,
        embedded: 0,
        skipped: ['blank'],
      });
      // beginPass still ran (it is a pass), but the blank row never reached
      // persistence — the writer received an empty batch.
      expect(record$.beginPasses).toBe(1);
      expect(record$.batches).toHaveLength(1);
      expect(record$.batches[0]).toHaveLength(0);
    });

    it.each([
      ['PROJECTION_SHAPE_INVALID', { secret: 'x' }],
      ['PROJECTION_ENTITY_ID_INVALID', { entityId: 'has space' }],
      ['PROJECTION_TENANT_INVALID', { tenantId: '' }],
      ['PROJECTION_CONTENT_INVALID', { searchContent: [] }],
      ['PROJECTION_TIMESTAMP_INVALID', { sourceUpdatedAt: 'now' }],
    ] as const)('rejects an invalid record with %s and writes NOTHING', async (code, patch) => {
      const { handle, record: record$ } = setup();

      const result = await handle.project([record('doc-1'), record('doc-2', patch)]);

      expect(result).toEqual({ status: 'rejected', code });
      // Whole-batch refusal: not one row of the batch may reach the index.
      expect(record$.batches).toHaveLength(0);
      expect(record$.beginPasses).toBe(0);
    });

    it('rejects an oversized batch before touching the writer', async () => {
      const { handle, record: record$ } = setup();
      const oversized = Array.from({ length: 201 }, (_, i) => record(`e-${i}`));

      const result = await handle.project(oversized);

      expect(result).toEqual({ status: 'rejected', code: 'PROJECTION_BATCH_INVALID' });
      expect(record$.batches).toHaveLength(0);
    });

    it('handles an empty batch as a no-op that is still "indexed"', async () => {
      const { handle } = setup();
      expect(await handle.project([])).toEqual({
        status: 'indexed',
        indexed: 0,
        embedded: 0,
        skipped: [],
      });
    });
  });

  describe('removal', () => {
    it('deletes only its OWN namespace, deduplicated, and reports the count', async () => {
      const { writer, record } = stubWriter();
      const service = new SearchSourceService(writer);
      const handle = service.register({
        descriptor: descriptor(),
        authorize: async () => ({ entries: [] }),
      });

      const result = await handle.remove(['a', 'a', 'b']);

      expect(result).toEqual({ status: 'removed', removed: 2 });
      expect(record.removals).toEqual([
        { sourceType: 'EXTERNAL', sourceKey: 'test.source', sourceIds: ['a', 'b'] },
      ]);
    });

    it('rejects invalid ids without calling the writer', async () => {
      const { writer, record } = stubWriter();
      const service = new SearchSourceService(writer);
      const handle = service.register({
        descriptor: descriptor(),
        authorize: async () => ({ entries: [] }),
      });

      expect(await handle.remove(['ok', 'bad id'])).toEqual({
        status: 'rejected',
        code: 'REMOVAL_IDS_INVALID',
      });
      expect(record.removals).toHaveLength(0);
    });
  });

  describe('authorization dispatch', () => {
    const setup = () => {
      const { writer } = stubWriter();
      return new SearchSourceService(writer);
    };

    it('issues ONE batched call per source with the TRUSTED actor, deduplicating ids', async () => {
      const service = setup();
      const callsA: unknown[] = [];
      const callsB: unknown[] = [];

      service.register({
        descriptor: descriptor({ key: 'test.a' }),
        authorize: async (request) => {
          callsA.push(request);
          return { entries: [] };
        },
      });
      service.register({
        descriptor: descriptor({ key: 'test.b' }),
        authorize: async (request) => {
          callsB.push(request);
          return { entries: [] };
        },
      });

      await service.authorize({ userId: 'user-1', tenantId: 'tenant-a' }, [
        { sourceKey: 'test.a', entityId: 'x' },
        { sourceKey: 'test.a', entityId: 'x' }, // found by both arms: one id, one question
        { sourceKey: 'test.a', entityId: 'y' },
        { sourceKey: 'test.b', entityId: 'z' },
      ]);

      expect(callsA).toEqual([
        { actor: { userId: 'user-1', tenantId: 'tenant-a' }, entityIds: ['x', 'y'] },
      ]);
      expect(callsB).toEqual([
        { actor: { userId: 'user-1', tenantId: 'tenant-a' }, entityIds: ['z'] },
      ]);
    });

    it('returns only entries the source authorized, keyed by the external candidate key', async () => {
      const service = setup();
      const at = new Date('2026-03-03T00:00:00.000Z');

      service.register({
        descriptor: descriptor({ key: 'test.a', routeTemplate: '/admin/test/:id' }),
        authorize: async (request) => ({
          entries: request.entityIds
            .filter((id) => id === 'allowed')
            .map((id) => ({
              entityId: id,
              title: `عنوان ${id}`,
              snippetFields: [`متن ${id}`],
              timestamp: at,
            })),
        }),
      });

      const authorized = await service.authorize({ userId: 'user-1', tenantId: 'tenant-a' }, [
        { sourceKey: 'test.a', entityId: 'allowed' },
        { sourceKey: 'test.a', entityId: 'denied' },
      ]);

      expect([...authorized.keys()]).toEqual([externalCandidateKey('test.a', 'allowed')]);
      const entry = authorized.get(externalCandidateKey('test.a', 'allowed'))!;
      expect(entry.title).toBe('عنوان allowed');
      expect(entry.snippetFields).toEqual(['متن allowed']);
      expect(entry.timestamp).toBe(at);
      // The href is composed by the PLATFORM from the registered template — never
      // returned by the source.
      expect(entry.navigation).toEqual({ href: '/admin/test/allowed' });
      expect(authorized.has(externalCandidateKey('test.a', 'denied'))).toBe(false);
    });

    it('URL-ENCODES the entity id into the composed route', async () => {
      const service = setup();
      service.register({
        descriptor: descriptor({ routeTemplate: '/admin/test/:id' }),
        authorize: async (request) => ({
          entries: request.entityIds.map((id) => ({
            entityId: id,
            title: 't',
            snippetFields: ['s'],
            timestamp: new Date(0),
          })),
        }),
      });

      const authorized = await service.authorize({ userId: 'user-1', tenantId: null }, [
        { sourceKey: 'test.source', entityId: 'a/b' },
      ]);

      expect(authorized.get(externalCandidateKey('test.source', 'a/b'))!.navigation).toEqual({
        href: '/admin/test/a%2Fb',
      });
    });

    it('drops an UNREGISTERED source entirely (fail-closed), without calling anyone', async () => {
      const service = setup();

      const authorized = await service.authorize({ userId: 'user-1', tenantId: 'tenant-a' }, [
        { sourceKey: 'test.ghost', entityId: 'x' },
      ]);

      expect(authorized.size).toBe(0);
    });

    it('drops a source whose adapter THROWS, leaving other sources intact', async () => {
      const service = setup();
      service.register({
        descriptor: descriptor({ key: 'test.broken' }),
        authorize: async () => {
          throw new Error('source database is down');
        },
      });
      service.register({
        descriptor: descriptor({ key: 'test.ok', routeTemplate: '/admin/ok/:id' }),
        authorize: async (request) => ({
          entries: request.entityIds.map((id) => ({
            entityId: id,
            title: 'ok',
            snippetFields: ['ok'],
            timestamp: new Date(0),
          })),
        }),
      });

      const authorized = await service.authorize({ userId: 'user-1', tenantId: 'tenant-a' }, [
        { sourceKey: 'test.broken', entityId: 'b1' },
        { sourceKey: 'test.ok', entityId: 'o1' },
      ]);

      // The failing source contributes NOTHING; the healthy one is untouched.
      expect([...authorized.keys()]).toEqual([externalCandidateKey('test.ok', 'o1')]);
    });

    it('drops a source whose answer fails validation — no partial trust', async () => {
      const service = setup();
      service.register({
        descriptor: descriptor(),
        // An id the platform never asked about: an injection attempt, refused wholesale.
        authorize: async () => ({
          entries: [
            { entityId: 'invented', title: 'x', snippetFields: ['x'], timestamp: new Date(0) },
          ],
        }),
      });

      const authorized = await service.authorize({ userId: 'user-1', tenantId: 'tenant-a' }, [
        { sourceKey: 'test.source', entityId: 'asked' },
      ]);

      expect(authorized.size).toBe(0);
    });
  });
});

