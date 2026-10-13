import {
  MAX_SEARCH_AUTHORIZATION_BATCH,
  MAX_SEARCH_CONTENT_FIELDS,
  MAX_SEARCH_PROJECTION_BATCH,
  MAX_SEARCH_RESULT_TITLE_LENGTH,
  SEARCH_ENTITY_ID_PATTERN,
  SEARCH_SOURCE_KEY_PATTERN,
  composeRouteHref,
  externalCandidateKey,
  validateSearchProjectionBatch,
  validateSearchProjectionRecord,
  validateSearchSourceAdapter,
  validateSearchSourceAuthorizationResult,
  validateSearchSourceDescriptor,
  validateSearchSourceRemovalIds,
  validateSearchSourceRouteTemplate,
} from './search-source.contract';

/**
 * Phase P-SEARCH-SOURCE: the contract's pure rules, pinned directly.
 *
 * Every test here names the ATTACK or the FAILURE it refuses: a smuggled URL, a
 * smuggled field, an invented authorization id, a path-traversal segment. The
 * validators are plain functions on purpose — they are the boundary a bounded
 * context's own tests can exercise without booting Nest, exactly like
 * `validateAuditReadQuery`.
 */
describe('search-source contract', () => {
  const validDescriptor = {
    key: 'commerce.purchase-document',
    ownerModuleId: 'commerce',
    weightClass: 'SUPPORTING',
    routeTemplate: '/admin/commerce/purchase-documents/:id',
  };

  const validRecord = {
    entityId: 'doc-1',
    tenantId: 'tenant-a',
    searchContent: ['PO-2026-0001', 'پیش‌فاکتور'],
    sourceUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  describe('source keys', () => {
    it('accepts lowercase dot/hyphen namespaced keys', () => {
      for (const key of ['commerce.purchase-document', 'hr', 'a.b.c', 'finance.ledger-entries']) {
        expect(SEARCH_SOURCE_KEY_PATTERN.test(key)).toBe(true);
      }
    });

    it('rejects anything a namespace could not hold', () => {
      for (const key of [
        '',
        'UPPER',
        'has space',
        'trail-',
        '-lead',
        '.lead',
        'x:y',
        'x/y',
        'key!',
      ]) {
        expect(SEARCH_SOURCE_KEY_PATTERN.test(key)).toBe(false);
      }
    });

    it('enforces the length bound in the DESCRIPTOR validation, not in the grammar', () => {
      // The pattern alone cannot bound length; the validator composes grammar AND
      // bound, which is why a 65-character key is refused with SOURCE_KEY_INVALID.
      expect(SEARCH_SOURCE_KEY_PATTERN.test('a'.repeat(65))).toBe(true);
      expect(
        validateSearchSourceDescriptor({
          ...validDescriptor,
          key: 'a'.repeat(65),
        })
      ).toEqual({ ok: false, code: 'SOURCE_KEY_INVALID' });
    });
  });

  describe('descriptor validation', () => {
    it('accepts a well-formed descriptor', () => {
      expect(validateSearchSourceDescriptor(validDescriptor)).toEqual({ ok: true });
    });

    it.each([
      ['key', { key: 'Bad Key' }, 'SOURCE_KEY_INVALID'],
      ['owner', { ownerModuleId: 'Commerce' }, 'SOURCE_OWNER_INVALID'],
      ['weight', { weightClass: 'DOMINANT' }, 'SOURCE_WEIGHT_CLASS_INVALID'],
      ['route', { routeTemplate: '//evil.example' }, 'SOURCE_ROUTE_TEMPLATE_INVALID'],
    ] as const)('refuses an invalid %s with its own code', (_name, patch, code) => {
      expect(validateSearchSourceDescriptor({ ...validDescriptor, ...patch })).toEqual({
        ok: false,
        code,
      });
    });

    it('refuses a descriptor carrying an unknown field — no arbitrary object', () => {
      expect(
        validateSearchSourceDescriptor({ ...validDescriptor, numericWeight: 0.99 })
      ).toEqual({ ok: false, code: 'SOURCE_KEY_INVALID' });
    });

    it('refuses a missing field rather than defaulting it', () => {
      const withoutOwner = { ...validDescriptor } as Partial<typeof validDescriptor>;
      delete withoutOwner.ownerModuleId;
      expect(
        validateSearchSourceDescriptor(
          withoutOwner as Parameters<typeof validateSearchSourceDescriptor>[0],
        ),
      ).toEqual({
        ok: false,
        code: 'SOURCE_OWNER_INVALID',
      });
    });

    it('refuses non-objects, arrays and null', () => {
      for (const value of [null, 'x', 42, ['key']]) {
        expect(validateSearchSourceDescriptor(value).ok).toBe(false);
      }
    });
  });

  describe('route templates', () => {
    it.each([
      '/admin/support',
      '/admin/commerce/purchase-documents/:id',
      '/:id',
      '/admin/a-b.c_d/e',
    ])('accepts an app-absolute template %s', (template) => {
      expect(validateSearchSourceRouteTemplate(template)).toEqual({ ok: true });
    });

    it.each([
      ['no leading slash', 'admin/x'],
      ['protocol-relative', '//evil.example/x'],
      ['absolute URL', 'https://evil.example/x'],
      ['scheme injection', 'javascript:alert(1)'],
      ['query string', '/admin/x?q=1'],
      ['fragment', '/admin/x#y'],
      ['traversal segment', '/admin/../etc/passwd'],
      ['dot segment', '/admin/./x'],
      ['placeholder not final', '/admin/:id/edit'],
      ['placeholder embedded', '/admin/:identifier'],
      ['trailing slash', '/admin/x/'],
      ['empty', ''],
      ['non-string', 7],
    ] as const)('refuses %s', (_name, template) => {
      expect(validateSearchSourceRouteTemplate(template).ok).toBe(false);
    });

    it('refuses a template over the length bound', () => {
      expect(validateSearchSourceRouteTemplate(`/${'a'.repeat(200)}`).ok).toBe(false);
    });
  });

  describe('route composition', () => {
    it('substitutes the FINAL placeholder only', () => {
      expect(composeRouteHref('/admin/commerce/purchase-documents/:id', 'doc-9')).toBe(
        '/admin/commerce/purchase-documents/doc-9'
      );
      expect(composeRouteHref('/:id', 'x')).toBe('/x');
    });

    it('URL-ENCODES the entity id so it cannot add path structure', () => {
      expect(composeRouteHref('/admin/x/:id', 'a/b?c=#d')).toBe('/admin/x/a%2Fb%3Fc%3D%23d');
    });

    it('leaves a template without a placeholder untouched', () => {
      expect(composeRouteHref('/admin/messages', 'whatever')).toBe('/admin/messages');
    });
  });

  describe('external candidate keys', () => {
    it('is the source-keyed identity, distinct from platform candidate keys', () => {
      expect(externalCandidateKey('commerce.purchase-document', 'abc')).toBe(
        'EXTERNAL:commerce.purchase-document:abc'
      );
      // Two sources, same entity id: never the same candidate.
      expect(externalCandidateKey('s.a', 'abc')).not.toBe(externalCandidateKey('s.b', 'abc'));
    });
  });

  describe('projection records', () => {
    it('accepts a record with only the four allowed fields', () => {
      expect(validateSearchProjectionRecord(validRecord)).toEqual({ ok: true });
    });

    it('accepts a tenant-less row as its OWN bucket, not as "any tenant"', () => {
      expect(validateSearchProjectionRecord({ ...validRecord, tenantId: null })).toEqual({
        ok: true,
      });
    });

    it.each([
      ['missing entity id', { entityId: '' }, 'PROJECTION_ENTITY_ID_INVALID'],
      ['whitespace in id', { entityId: 'a b' }, 'PROJECTION_ENTITY_ID_INVALID'],
      ['dot id', { entityId: '.' }, 'PROJECTION_ENTITY_ID_INVALID'],
      ['dotdot id', { entityId: '..' }, 'PROJECTION_ENTITY_ID_INVALID'],
      ['empty tenant', { tenantId: '' }, 'PROJECTION_TENANT_INVALID'],
      ['numeric tenant', { tenantId: 42 }, 'PROJECTION_TENANT_INVALID'],
      ['empty content', { searchContent: [] }, 'PROJECTION_CONTENT_INVALID'],
      ['non-string content', { searchContent: [42] }, 'PROJECTION_CONTENT_INVALID'],
      ['missing timestamp', { sourceUpdatedAt: '2026-01-01' }, 'PROJECTION_TIMESTAMP_INVALID'],
    ] as const)('refuses %s', (_name, patch, code) => {
      expect(validateSearchProjectionRecord({ ...validRecord, ...patch })).toEqual({
        ok: false,
        code,
      });
    });

    it('refuses a record carrying a SENSITIVE or unknown field — no arbitrary object', () => {
      // The phase's sensitive-field rule: an extra key is a REJECTION, not a
      // silently dropped field. This is what structurally blocks a credential, an
      // audit snapshot or an entity dump from reaching the index.
      for (const extra of [
        { secret: 'shh' },
        { snapshot: { passwordHash: 'x' } },
        { internal: true },
      ]) {
        expect(validateSearchProjectionRecord({ ...validRecord, ...extra })).toEqual({
          ok: false,
          code: 'PROJECTION_SHAPE_INVALID',
        });
      }
    });

    it('refuses a record with a missing field rather than defaulting it', () => {
      const withoutContent = { ...validRecord } as Partial<typeof validRecord>;
      delete withoutContent.searchContent;
      expect(
        validateSearchProjectionRecord(
          withoutContent as Parameters<typeof validateSearchProjectionRecord>[0],
        ),
      ).toEqual({
        ok: false,
        code: 'PROJECTION_SHAPE_INVALID',
      });
    });

    it('refuses a content part over the field-length bound', () => {
      expect(
        validateSearchProjectionRecord({
          ...validRecord,
          searchContent: ['x'.repeat(2001)],
        })
      ).toEqual({ ok: false, code: 'PROJECTION_CONTENT_INVALID' });
    });

    it('refuses more content parts than the contract declares', () => {
      expect(
        validateSearchProjectionRecord({
          ...validRecord,
          searchContent: Array.from({ length: MAX_SEARCH_CONTENT_FIELDS + 1 }, (_, i) => `f${i}`),
        })
      ).toEqual({ ok: false, code: 'PROJECTION_CONTENT_INVALID' });
    });

    it('uses one id grammar for entities and tenants', () => {
      expect(SEARCH_ENTITY_ID_PATTERN.test('doc-1')).toBe(true);
      expect(SEARCH_ENTITY_ID_PATTERN.test('doc 1')).toBe(false);
      expect(SEARCH_ENTITY_ID_PATTERN.test('doc\n1')).toBe(false);
    });
  });

  describe('projection batches', () => {
    it('accepts an empty batch as a no-op and a full batch', () => {
      expect(validateSearchProjectionBatch([])).toEqual({ ok: true });
      expect(validateSearchProjectionBatch([validRecord])).toEqual({ ok: true });
    });

    it('rejects the WHOLE batch when one record is malformed — nothing is written', () => {
      expect(
        validateSearchProjectionBatch([validRecord, { ...validRecord, entityId: '' }])
      ).toEqual({ ok: false, code: 'PROJECTION_ENTITY_ID_INVALID' });
    });

    it('rejects a batch over the indexer batch bound', () => {
      const oversized = Array.from({ length: MAX_SEARCH_PROJECTION_BATCH + 1 }, (_, i) => ({
        ...validRecord,
        entityId: `e-${i}`,
      }));
      expect(validateSearchProjectionBatch(oversized)).toEqual({
        ok: false,
        code: 'PROJECTION_BATCH_INVALID',
      });
    });

    it('rejects a non-array', () => {
      expect(validateSearchProjectionBatch(validRecord)).toEqual({
        ok: false,
        code: 'PROJECTION_BATCH_INVALID',
      });
    });
  });

  describe('removal ids', () => {
    it('accepts an empty list and duplicates (a retry is a no-op, not an error)', () => {
      expect(validateSearchSourceRemovalIds([])).toEqual({ ok: true });
      expect(validateSearchSourceRemovalIds(['a', 'a', 'b'])).toEqual({ ok: true });
    });

    it.each([
      ['a bad id', ['ok', 'bad id']],
      ['a non-string', ['ok', 7]],
      [
        'an oversized list',
        Array.from({ length: MAX_SEARCH_PROJECTION_BATCH + 1 }, (_, i) => `e${i}`),
      ],
    ] as const)('refuses %s', (_name, ids) => {
      expect(validateSearchSourceRemovalIds(ids)).toEqual({
        ok: false,
        code: 'REMOVAL_IDS_INVALID',
      });
    });
  });

  describe('authorization results', () => {
    const requested = ['a', 'b'];

    const entry = (entityId: string) => ({
      entityId,
      title: 'عنوان',
      snippetFields: ['متن'],
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    it('accepts a subset — omission is how a source says "unauthorized"', () => {
      expect(
        validateSearchSourceAuthorizationResult({ entries: [entry('a')] }, requested)
      ).toEqual({ ok: true });
      expect(validateSearchSourceAuthorizationResult({ entries: [] }, requested)).toEqual({
        ok: true,
      });
    });

    it('refuses an id the platform never asked about — no injected rows', () => {
      expect(
        validateSearchSourceAuthorizationResult({ entries: [entry('zzz')] }, requested)
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
    });

    it('refuses a duplicate entry for one id', () => {
      expect(
        validateSearchSourceAuthorizationResult({ entries: [entry('a'), entry('a')] }, requested)
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
    });

    it('refuses more entries than requested', () => {
      expect(
        validateSearchSourceAuthorizationResult(
          { entries: [entry('a'), entry('b'), entry('a')] },
          ['a']
        )
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
    });

    it('refuses unknown fields on the result and on each entry', () => {
      expect(
        validateSearchSourceAuthorizationResult({ entries: [], debug: true }, requested)
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
      expect(
        validateSearchSourceAuthorizationResult(
          { entries: [{ ...entry('a'), payload: 'blob' }] },
          requested
        )
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
    });

    it.each([
      ['an empty title', { title: '   ' }],
      ['an oversized title', { title: 'x'.repeat(MAX_SEARCH_RESULT_TITLE_LENGTH + 1) }],
      ['non-string snippet fields', { snippetFields: [42] }],
      ['a bad timestamp', { timestamp: '2026-01-01' }],
    ] as const)('refuses an entry with %s', (_name, patch) => {
      expect(
        validateSearchSourceAuthorizationResult(
          { entries: [{ ...entry('a'), ...patch }] },
          requested
        )
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
    });

    it('refuses more snippet fields than the contract declares', () => {
      expect(
        validateSearchSourceAuthorizationResult(
          { entries: [{ ...entry('a'), snippetFields: ['1', '2', '3', '4', '5'] }] },
          requested
        )
      ).toEqual({ ok: false, code: 'AUTHORIZATION_RESULT_INVALID' });
    });

    it('refuses a non-object result, and the batch bound stays meaningful', () => {
      expect(validateSearchSourceAuthorizationResult(null, requested)).toEqual({
        ok: false,
        code: 'AUTHORIZATION_RESULT_INVALID',
      });
      expect(MAX_SEARCH_AUTHORIZATION_BATCH).toBeGreaterThan(0);
    });
  });

  describe('adapter validation', () => {
    const authorize = async () => ({ entries: [] });

    it('accepts a plain adapter and a CLASS adapter (prototype methods)', () => {
      expect(
        validateSearchSourceAdapter({ descriptor: validDescriptor, authorize })
      ).toEqual({ ok: true });

      class TestSource {
        readonly descriptor = validDescriptor;
        authorize = authorize;
      }

      expect(validateSearchSourceAdapter(new TestSource())).toEqual({ ok: true });
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['a missing authorize', { descriptor: validDescriptor }],
      ['a non-function authorize', { descriptor: validDescriptor, authorize: 'no' }],
      [
        'a bad descriptor',
        { descriptor: { ...validDescriptor, key: 'BAD' }, authorize },
      ],
    ] as const)('refuses %s', (_name, adapter) => {
      expect(validateSearchSourceAdapter(adapter).ok).toBe(false);
    });
  });
});
