import {
  AUDIT_READ_DEFAULT_PAGE_SIZE,
  AUDIT_READ_MAX_PAGE_SIZE,
  MAX_AUDIT_FIELD_LENGTH,
  validateAuditReadQuery,
  type AuditReadQuery,
} from './audit.contract';

/**
 * PHASE P-AUDIT-READ (§25 A/M): the READ contract itself, with no database and no port binding.
 *
 * WHY THE VALIDATOR GETS ITS OWN FILE
 * -----------------------------------
 * `validateAuditReadQuery` is the ONE place the read contract is enforced, and it is called by
 * BOTH the Core binding and the contract-driven test fakes. If it is wrong, it is wrong in
 * several places that are tested separately, so "the tenant is required", "the resource pair is
 * required" and "a page cannot exceed the ceiling" would be several rules that happen to agree
 * today. This file pins each rule once, at the source.
 *
 * WHAT IS ASSERTED, AND WHY EACH PART IS LOAD-BEARING
 * ---------------------------------------------------
 *  1. THE DEFAULTS ARE PART OF THE CONTRACT. A caller that sends no paging gets exactly the
 *     platform list window (page 1 / 20), so two consumers cannot disagree about the first page.
 *  2. THE CODES NAME THE FIRST THING WRONG, gravest first — a missing tenant outranks a missing
 *     resource, exactly as `validateAuditEvent` orders the write side.
 *  3. THE TENANT CANNOT BE ABSENT. The read has no shape in which a tenant-less query is
 *     accepted, so it can never become a wider read.
 *  4. A resourceId WITHOUT a resourceType IS REFUSED. §23: a read must not be able to span
 *     unrelated resource types because only half of the resource pair was supplied.
 *  5. THE PAGE AND THE WINDOW ARE BOUNDED. `pageSize` has a ceiling and the window must point in
 *     one direction; `page` itself is unbounded by design (the row predicate is what bounds the
 *     scan).
 */

/** A valid query, as a trusted consumer builds it. One field per test is broken deliberately. */
const baseQuery = (overrides: Partial<AuditReadQuery> = {}): AuditReadQuery => ({
  tenantId: 'tenant-north',
  resource: 'commerce.purchase_document',
  resourceId: 'doc-1',
  ...overrides,
});

describe('validateAuditReadQuery', () => {
  describe('the accepted shape', () => {
    it('resolves the paging defaults and returns a query ready for the repository', () => {
      expect(validateAuditReadQuery(baseQuery())).toEqual({
        ok: true,
        query: {
          tenantId: 'tenant-north',
          resource: 'commerce.purchase_document',
          resourceId: 'doc-1',
          page: 1,
          pageSize: AUDIT_READ_DEFAULT_PAGE_SIZE,
        },
      });
    });

    it('keeps the optional narrowers, at the ceiling and everywhere inside it', () => {
      expect(
        validateAuditReadQuery(
          baseQuery({
            action: 'STATUS_CHANGED',
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-02-01T00:00:00.000Z',
            page: 3,
            pageSize: AUDIT_READ_MAX_PAGE_SIZE,
          })
        )
      ).toEqual({
        ok: true,
        query: {
          tenantId: 'tenant-north',
          resource: 'commerce.purchase_document',
          resourceId: 'doc-1',
          action: 'STATUS_CHANGED',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
          page: 3,
          pageSize: AUDIT_READ_MAX_PAGE_SIZE,
        },
      });
    });

    it('treats an explicitly null optional field as absent, not as a value', () => {
      // "The caller never said" and "the caller said: no value" are the same statement for an
      // optional narrower; only a concrete value narrows.
      expect(
        validateAuditReadQuery(
          baseQuery({
            action: null as unknown as string,
            from: null as unknown as string,
            to: null as unknown as string,
          })
        )
      ).toEqual({
        ok: true,
        query: {
          tenantId: 'tenant-north',
          resource: 'commerce.purchase_document',
          resourceId: 'doc-1',
          page: 1,
          pageSize: AUDIT_READ_DEFAULT_PAGE_SIZE,
        },
      });
    });

    it('never mutates the value it was handed', () => {
      const input = baseQuery();
      validateAuditReadQuery(input);
      expect(input).toEqual(baseQuery());
    });
  });

  describe('the envelope', () => {
    it.each([null, undefined, [], 'query', 7, true])(
      'rejects %p as not an object',
      (value) => {
        expect(validateAuditReadQuery(value)).toEqual({
          ok: false,
          code: 'AUDIT_READ_QUERY_INVALID',
        });
      }
    );
  });

  describe('the tenancy rule — the gravest fault, named first', () => {
    it('cannot express a tenant-less read', () => {
      expect(
        validateAuditReadQuery(baseQuery({ tenantId: undefined as unknown as string }))
      ).toEqual({ ok: false, code: 'AUDIT_READ_TENANT_MISSING' });
      expect(validateAuditReadQuery(baseQuery({ tenantId: '' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_TENANT_MISSING',
      });
      expect(
        validateAuditReadQuery(baseQuery({ tenantId: 'x'.repeat(MAX_AUDIT_FIELD_LENGTH + 1) }))
      ).toEqual({ ok: false, code: 'AUDIT_READ_TENANT_MISSING' });
      expect(validateAuditReadQuery(baseQuery({ tenantId: 'tenant\nnorth' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_TENANT_MISSING',
      });
    });

    it('reports the missing tenant BEFORE a missing resource, because it is the graver fault', () => {
      expect(validateAuditReadQuery({ resource: '', resourceId: '' })).toEqual({
        ok: false,
        code: 'AUDIT_READ_TENANT_MISSING',
      });
    });
  });

  describe('the resource question', () => {
    it('names each absent field with its own code', () => {
      expect(validateAuditReadQuery(baseQuery({ resource: '' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_RESOURCE_MISSING',
      });
      expect(validateAuditReadQuery(baseQuery({ resourceId: '' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_RESOURCE_ID_MISSING',
      });
    });

    it('refuses a resourceId without a resourceType — a read cannot span resource types', () => {
      // §23: filtering by resourceId alone must never be able to return unrelated resource types,
      // and the closed shape makes the attempt a named rejection rather than a broader query.
      expect(validateAuditReadQuery({ tenantId: 'tenant-north', resourceId: 'doc-1' })).toEqual({
        ok: false,
        code: 'AUDIT_READ_RESOURCE_MISSING',
      });
    });
  });

  describe('the optional narrowers', () => {
    it('refuses an action that would not be a storable event field', () => {
      expect(validateAuditReadQuery(baseQuery({ action: '' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_QUERY_INVALID',
      });
      expect(
        validateAuditReadQuery(baseQuery({ action: 'x'.repeat(MAX_AUDIT_FIELD_LENGTH + 1) }))
      ).toEqual({ ok: false, code: 'AUDIT_READ_QUERY_INVALID' });
    });

    it('refuses an unusable window: unparseable bounds, or a zero/negative span', () => {
      expect(validateAuditReadQuery(baseQuery({ from: 'not-a-date' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_RANGE_INVALID',
      });
      expect(validateAuditReadQuery(baseQuery({ to: 'not-a-date' }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_RANGE_INVALID',
      });
      expect(
        validateAuditReadQuery(
          baseQuery({ from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' })
        )
      ).toEqual({ ok: false, code: 'AUDIT_READ_RANGE_INVALID' });
      expect(
        validateAuditReadQuery(
          baseQuery({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' })
        )
      ).toEqual({ ok: false, code: 'AUDIT_READ_RANGE_INVALID' });
    });

    it('accepts a one-sided window, and keeps the bound it was given', () => {
      const from = validateAuditReadQuery(baseQuery({ from: '2026-01-01T00:00:00.000Z' }));
      const to = validateAuditReadQuery(baseQuery({ to: '2026-01-01T00:00:00.000Z' }));

      expect(from.ok && from.query.from).toBe('2026-01-01T00:00:00.000Z');
      expect(from.ok && from.query.to).toBeUndefined();
      expect(to.ok && to.query.to).toBe('2026-01-01T00:00:00.000Z');
      expect(to.ok && to.query.from).toBeUndefined();
    });
  });

  describe('paging is bounded', () => {
    it('refuses a page or pageSize that is not a positive integer', () => {
      for (const page of [0, -1, 1.5, '2', Number.NaN]) {
        expect(validateAuditReadQuery(baseQuery({ page: page as unknown as number }))).toEqual({
          ok: false,
          code: 'AUDIT_READ_PAGE_INVALID',
        });
      }

      for (const pageSize of [0, -1, 1.5, '20', Number.NaN]) {
        expect(
          validateAuditReadQuery(baseQuery({ pageSize: pageSize as unknown as number }))
        ).toEqual({ ok: false, code: 'AUDIT_READ_PAGE_INVALID' });
      }
    });

    it('refuses a pageSize above the ceiling and accepts exactly the ceiling', () => {
      expect(validateAuditReadQuery(baseQuery({ pageSize: AUDIT_READ_MAX_PAGE_SIZE + 1 }))).toEqual({
        ok: false,
        code: 'AUDIT_READ_PAGE_INVALID',
      });

      const atCeiling = validateAuditReadQuery(baseQuery({ pageSize: AUDIT_READ_MAX_PAGE_SIZE }));
      expect(atCeiling.ok && atCeiling.query.pageSize).toBe(AUDIT_READ_MAX_PAGE_SIZE);
    });

    it('has no ceiling of its own on `page` — the resource-scoped predicate bounds the scan', () => {
      const result = validateAuditReadQuery(baseQuery({ page: 10_000 }));
      expect(result.ok && result.query.page).toBe(10_000);
    });
  });

  describe('Commerce compatibility (§27)', () => {
    it("accepts the confirmed future consumer's exact query, as a literal", () => {
      // resourceType `commerce.purchase_document` + the purchase id: the use case GAP-7 needs,
      // expressible WITHOUT Commerce Prisma, Core Prisma, JSON parsing or mirrored audit data.
      expect(
        validateAuditReadQuery({
          tenantId: '9f1c2f34-0000-4000-8000-000000000001',
          resource: 'commerce.purchase_document',
          resourceId: '3f6b1a1e-5f2c-4d4b-8c3a-9d0e1f2a3b4c',
        })
      ).toEqual({
        ok: true,
        query: {
          tenantId: '9f1c2f34-0000-4000-8000-000000000001',
          resource: 'commerce.purchase_document',
          resourceId: '3f6b1a1e-5f2c-4d4b-8c3a-9d0e1f2a3b4c',
          page: 1,
          pageSize: AUDIT_READ_DEFAULT_PAGE_SIZE,
        },
      });
    });
  });
});

