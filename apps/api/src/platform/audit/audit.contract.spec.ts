import {
  AUDIT_BINDING_PATTERN,
  AUDIT_EXCHANGE,
  AUDIT_INGEST_QUEUE,
  AUDIT_TOPIC_PREFIX,
  MAX_AUDIT_FIELD_LENGTH,
  MAX_AUDIT_ID_LENGTH,
  PLATFORM_AUDIT_CONTRACT,
  auditEventDigest,
  auditRoutingKey,
  canonicalAuditJson,
  isAuditId,
  toAuditEnvelope,
  validateAuditEvent,
  type AuditDigestSubject,
  type AuditEvent,
  type AuditEventInput,
} from './audit.contract';

/**
 * Phase ARCH-3B (§3/§6/§14): `platform.audit@v1` itself, with no database and no broker.
 *
 * WHY THE CONTRACT GETS ITS OWN FILE
 * ----------------------------------
 * `validateAuditEvent` is the ONE place the contract is enforced, and it is called by BOTH writers —
 * the in-process port binding and the queue consumer. If it is wrong, it is wrong in two places that
 * are tested separately, so "the tenant is required" would be two rules that happen to agree today.
 * This file pins the rule once, at the source, and the two writers' specs then only have to prove
 * that they CALL it.
 *
 * WHAT IS ASSERTED, AND WHY EACH PART IS LOAD-BEARING
 * --------------------------------------------------
 *  1. THE REJECTION CODE NAMES THE FIRST THING WRONG. The codes are a closed set an operator reads
 *     in a log line at 3am: "contract mismatch" means something else is publishing on this binding,
 *     "tenant missing" means a producer is broken, "id invalid" means a producer is inventing
 *     identities. Collapsing them into one "invalid" would make the alert useless exactly when it
 *     fires, so the ORDER is asserted rather than merely the outcome.
 *  2. THE TENANT CANNOT BE ABSENT. That is ARCH-3B §3's whole tenancy claim: the 36,489 historical
 *     rows the contract names are provably historical BECAUSE this path has no shape in which a
 *     tenant is absent.
 *  3. THE IDENTITY IS A UUID OF BOUNDED LENGTH. `auditId` is the idempotency key, so a producer that
 *     passes a `requestId`, a control character that would land in a log line, or a value that is
 *     merely UUID-shaped is refused at the boundary rather than becoming an unclassifiable row.
 *  4. THE DIGEST IS ORDER-INDEPENDENT, AND HAS NO ROW-ONLY COLUMN TO CONTAIN.
 *     `AuditLog."oldValue"` is `jsonb`, which does not preserve key order; a byte comparison would
 *     report a CONFLICT for two spellings of one object, which is how an at-least-once delivery
 *     guarantee turns into a stream of false alarms. `id` and `createdAt` are absent STRUCTURALLY
 *     rather than by filtering — they are not fields of `AuditDigestSubject`, which is built from the
 *     event's own fields — so a retry can never disagree with the row about a value that did not exist
 *     when the event was produced.
 */

/** A valid event, as a producer supplies it. One field per test is then broken deliberately. */
const baseInput = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  auditId: '3f6b1a1e-5f2c-4d4b-8c3a-9d0e1f2a3b4c',
  tenantId: 'tenant-north',
  requestId: 'req-1',
  actorId: 'user-1',
  action: 'CREATE',
  resource: 'employee',
  resourceId: 'emp-1',
  ...overrides,
});

/** The envelope as it travels, i.e. input + capability descriptor. */
const envelope = (overrides: Partial<AuditEventInput> = {}) =>
  toAuditEnvelope(baseInput(overrides));

/** The digest subject for one event, as the writer builds it. */
const subject = (overrides: Partial<AuditDigestSubject> = {}): AuditDigestSubject => ({
  auditId: baseInput().auditId,
  tenantId: 'tenant-north',
  requestId: 'req-1',
  actorId: 'user-1',
  action: 'CREATE',
  resource: 'employee',
  resourceId: 'emp-1',
  ...overrides,
});

describe('platform.audit@v1 contract', () => {
  describe('the wire binding (§12)', () => {
    it('names the exchange, queue and binding the ADR records in E8', () => {
      // Literals rather than re-derived expressions: E8 records these three values, and a rename would
      // silently re-point every producer at a binding nobody consumes.
      expect(AUDIT_EXCHANGE).toBe('domain_events');
      expect(AUDIT_INGEST_QUEUE).toBe('platform.audit.ingest');
      expect(AUDIT_BINDING_PATTERN).toBe('audit.#');
      expect(PLATFORM_AUDIT_CONTRACT).toBe('platform.audit@v1');
    });

    it('routes under the legacy prefix, so one binding carries both families', () => {
      // Deliberate: a module's audit traffic is on ONE binding rather than two. Lower-cased because a
      // routing key is matched literally and `audit.Employee.CREATE` would miss the consumer's logs.
      expect(auditRoutingKey({ resource: 'Employee', action: 'CREATE' })).toBe(
        'audit.employee.create'
      );
      expect(auditRoutingKey({ resource: 'position', action: 'update' })).toBe(
        `${AUDIT_TOPIC_PREFIX}position.update`
      );
    });
  });

  describe('validateAuditEvent — the envelope, before anything else', () => {
    it.each([[null], ['a string'], [42], [[]]])(
      'rejects %p as AUDIT_ENVELOPE_INVALID, not as a missing field',
      (value) => {
        // An array is the interesting one: it is an object, so a naive `typeof` check would let it
        // through and every field read afterwards would be `undefined` — reported as four missing
        // fields rather than one wrong envelope.
        expect(validateAuditEvent(value)).toEqual({ ok: false, code: 'AUDIT_ENVELOPE_INVALID' });
      }
    );

    it('rejects a LEGACY event (no contract field) as a contract mismatch', () => {
      // THE DOUBLE-WRITE GUARD. `AuditService` publishes on the same prefix without a `contract`, and
      // its row already exists in `AuditLog`. Ingesting it would write the same act twice, so this
      // code — not a missing-tenant code — is what the consumer drops it with.
      const legacy = { ...baseInput() };

      expect(validateAuditEvent(legacy)).toEqual({
        ok: false,
        code: 'AUDIT_CONTRACT_MISMATCH',
      });
    });

    it('rejects the SIBLING capability, so one credential cannot impersonate the other (A8)', () => {
      const sibling = { ...baseInput(), contract: 'platform.identity@v1' };

      expect(validateAuditEvent(sibling)).toEqual({ ok: false, code: 'AUDIT_CONTRACT_MISMATCH' });
    });

    it('reports the contract mismatch BEFORE any field problem', () => {
      // The envelope was never a platform event, so its absent tenant is not the finding. Ordering is
      // asserted rather than implied: a validator that checked fields first would blame a producer.
      expect(validateAuditEvent({ contract: 'legacy.v0' })).toEqual({
        ok: false,
        code: 'AUDIT_CONTRACT_MISMATCH',
      });
    });
  });

  describe('validateAuditEvent — the identity (§3/§14)', () => {
    it('distinguishes a MISSING id from an INVALID one', () => {
      // Two different producer bugs: one forgot the field, the other derived it from the request. A
      // single code would tell an operator neither.
      const missing = validateAuditEvent(envelope({ auditId: undefined as unknown as string }));
      const invalid = validateAuditEvent(envelope({ auditId: 'req-1' }));

      // `req-1` is exactly the mistake §3 names: the identity a replayed request would repeat.
      expect(missing).toEqual({ ok: false, code: 'AUDIT_ID_MISSING' });
      expect(invalid).toEqual({ ok: false, code: 'AUDIT_ID_INVALID' });
    });

    it('accepts a UUID in either case, and rejects a version/variant it did not issue', () => {
      expect(isAuditId('3F6B1A1E-5F2C-4D4B-8C3A-9D0E1F2A3B4C')).toBe(true);
      // Version nibble `6` and variant nibble `c` are not shapes this platform's ids take.
      expect(isAuditId('3f6b1a1e-5f2c-6d4b-cc3a-9d0e1f2a3b4c')).toBe(false);
      // A long non-UUID string is not accepted for its length.
      expect(isAuditId('3'.repeat(MAX_AUDIT_ID_LENGTH))).toBe(false);
      expect(isAuditId('')).toBe(false);
    });
  });

  describe('validateAuditEvent — the tenancy rule (§3)', () => {
    it('cannot express a tenant-less event', () => {
      // THE CLAIM THE MIGRATION RESTS ON. The historical rows with a NULL tenant are provably
      // historical precisely because this path has no shape in which a tenant is absent.
      const absent = validateAuditEvent(envelope({ tenantId: null as unknown as string }));
      const empty = validateAuditEvent(envelope({ tenantId: '' }));

      expect(absent).toEqual({ ok: false, code: 'AUDIT_TENANT_MISSING' });
      expect(empty).toEqual({ ok: false, code: 'AUDIT_TENANT_MISSING' });
    });

    it('refuses a tenant that would corrupt a routing key or a log line', () => {
      // A field is echoed into a routing key and an operator's log. A newline is refused HERE rather
      // than escaped later, so no writer has to remember to escape it.
      expect(validateAuditEvent(envelope({ tenantId: 'tenant\nnorth' }))).toEqual({
        ok: false,
        code: 'AUDIT_TENANT_MISSING',
      });
      expect(
        validateAuditEvent(envelope({ tenantId: 'x'.repeat(MAX_AUDIT_FIELD_LENGTH + 1) }))
      ).toEqual({ ok: false, code: 'AUDIT_TENANT_MISSING' });
    });

    it('reports the missing tenant BEFORE a missing action, because it is the graver fault', () => {
      const bare = { ...baseInput(), tenantId: '', action: '', resource: '', resourceId: '' };

      expect(validateAuditEvent({ ...bare, contract: PLATFORM_AUDIT_CONTRACT })).toEqual({
        ok: false,
        code: 'AUDIT_TENANT_MISSING',
      });
    });
  });

  describe('validateAuditEvent — the three fields the trail indexes on', () => {
    it('names each absent field with its own code', () => {
      const action = validateAuditEvent(envelope({ action: '' }));
      const resource = validateAuditEvent(envelope({ resource: undefined as unknown as string }));
      const resourceId = validateAuditEvent(envelope({ resourceId: '' }));

      expect(action).toEqual({ ok: false, code: 'AUDIT_ACTION_MISSING' });
      expect(resource).toEqual({ ok: false, code: 'AUDIT_RESOURCE_MISSING' });
      expect(resourceId).toEqual({ ok: false, code: 'AUDIT_RESOURCE_ID_MISSING' });
    });

    it('is a SHAPE check, not a trimmer: whitespace passes, empty and control characters do not', () => {
      // `isField` refuses the empty string, over-long values and control characters — the three ways a
      // value would corrupt a routing key or a log line — and deliberately does NOT trim. Trimming here
      // would mean the validator accepted `" emp-1 "` while the writer stored the untrimmed value, so
      // the digest of the arriving event and of the stored row would differ by a space and every replay
      // would report a conflict.
      expect(validateAuditEvent(envelope({ resourceId: '  ' })).ok).toBe(true);
      expect(validateAuditEvent(envelope({ resource: 'employee ' })).ok).toBe(true);
      expect(validateAuditEvent(envelope({ resourceId: 'emp\u00001' })).ok).toBe(false);
      expect(
        validateAuditEvent(envelope({ resource: 'x'.repeat(MAX_AUDIT_FIELD_LENGTH) })).ok
      ).toBe(true);
    });

    it('is ordered: the first broken field is the one reported', () => {
      // Every one of these is wrong, so an unordered validator would be free to report any of them.
      expect(validateAuditEvent(envelope({ action: '', resource: '', resourceId: '' }))).toEqual({
        ok: false,
        code: 'AUDIT_ACTION_MISSING',
      });
      expect(validateAuditEvent(envelope({ resource: '', resourceId: '' }))).toEqual({
        ok: false,
        code: 'AUDIT_RESOURCE_MISSING',
      });
    });
  });

  describe('validateAuditEvent — an accepted event', () => {
    it('returns the envelope itself, so one parse serves both writers', () => {
      const valid = envelope();
      const result = validateAuditEvent(valid);

      expect(result.ok).toBe(true);
      // The SAME object, not a copy or a projection: the consumer hands this straight to the port, so a
      // rebuilding step here would be a second definition of the event.
      expect(result.ok && result.event).toBe(valid);
    });

    it('does not validate the OPTIONAL fields, and does not normalise them either', () => {
      // The writer normalises (`requestId ?? ''`, `changedFields ?? []`) because it owns the columns,
      // and the digest is taken over the NORMALISED subject. A validator that coerced values here
      // would create a second, divergent normalisation — so it simply does not touch them.
      const event = {
        ...envelope(),
        success: 'yes',
        changedFields: undefined,
      } as unknown as AuditEvent;

      const result = validateAuditEvent(event);

      expect(result.ok).toBe(true);
      expect(result.ok && result.event.success).toBe('yes');
      expect(result.ok && result.event.changedFields).toBeUndefined();
    });
  });

  describe('toAuditEnvelope', () => {
    it('stamps the descriptor, and cannot be talked out of it', () => {
      // The spread order is the guarantee: `contract` is written LAST, so a caller whose object
      // carries a `contract` of its own is overwritten rather than trusted. Without this, a producer
      // could label a legacy event as a platform one and have the same act ingested twice.
      const smuggled = { ...baseInput(), contract: 'legacy.v0' } as unknown as AuditEventInput;

      expect(toAuditEnvelope(smuggled).contract).toBe(PLATFORM_AUDIT_CONTRACT);
    });

    it('is accepted by the validator it feeds', () => {
      expect(validateAuditEvent(toAuditEnvelope(baseInput())).ok).toBe(true);
    });
  });

  describe('canonicalAuditJson — the comparison the idempotency check rests on', () => {
    it('sorts object keys recursively, so two spellings of one object are one string', () => {
      const left = canonicalAuditJson({ b: 1, a: { d: 2, c: 3 } });
      const right = canonicalAuditJson({ a: { c: 3, d: 2 }, b: 1 });

      expect(left).toBe(right);
    });

    it('PRESERVES array order, because an array is a sequence and not a set', () => {
      // `[1,2]` and `[2,1]` are different footprints of a change list; sorting them would call two
      // genuinely different events identical.
      expect(canonicalAuditJson([1, 2])).not.toBe(canonicalAuditJson([2, 1]));
    });

    it('renders a TOP-LEVEL undefined as null, and drops an omitted key inside an object', () => {
      // The exact semantics, because the digest depends on them and the difference is easy to misread:
      //   * a top-level `undefined` is `'null'`, exactly like a top-level `null`;
      //   * inside an object, an `undefined`-valued key is DROPPED (it was never said), while an
      //     explicit `null` is KEPT (it was said, and it means "no value").
      // This is why the WRITER normalises before digesting: `redactedSubject` maps every absent
      // optional field to the value that will actually be stored, so an event that omitted `reason`
      // and one that sent `null` become the same subject and therefore the same digest. Without that
      // normalisation the two would hash differently and every replay of an omitted field would be
      // reported as a conflict. `platform-audit.service.spec.ts` pins that they agree.
      const omitted = canonicalAuditJson({ reason: undefined });
      const explicitNull = canonicalAuditJson({ reason: null });

      expect(canonicalAuditJson(undefined)).toBe('null');
      expect(canonicalAuditJson(null)).toBe('null');
      expect(omitted).toBe('{}');
      expect(explicitNull).toBe('{"reason":null}');
      expect(omitted).not.toBe(explicitNull);
    });

    it('normalises values with no row-level meaning rather than stringifying them', () => {
      // A Date or a class instance stringifies differently per call; letting it into the digest would
      // make every replay of such a payload a conflict.
      expect(canonicalAuditJson(new Date(0))).toBe('null');
      expect(canonicalAuditJson(new (class Payload {})())).toBe('null');
    });

    it('handles nesting: null, arrays and scalars', () => {
      expect(canonicalAuditJson(null)).toBe('null');
      expect(canonicalAuditJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
      expect(canonicalAuditJson('x')).toBe('"x"');
      expect(canonicalAuditJson({ deep: { nested: [{ z: 1, a: 2 }] } })).toBe(
        '{"deep":{"nested":[{"a":2,"z":1}]}}'
      );
    });
  });

  describe('auditEventDigest — one event, one fingerprint', () => {
    it('is a 64-character hex SHA-256', () => {
      expect(auditEventDigest(subject())).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is stable across key order in the change snapshots', () => {
      // THE jsonb CASE, as an assertion: Postgres does not preserve key order, so a stored row can
      // come back with the keys in any order and must still be recognised as the same event.
      const first = auditEventDigest(subject({ newValue: { name: 'Ali', code: 'E-1' } }));
      const second = auditEventDigest(subject({ newValue: { code: 'E-1', name: 'Ali' } }));

      expect(first).toBe(second);
    });

    it('changes when any compared field changes, including the tenant', () => {
      // The tenant is in the digest on purpose: one identity arriving for two tenants is the alarm the
      // writer raises as a conflict rather than silently recording the act twice.
      const base = auditEventDigest(subject());

      expect(auditEventDigest(subject({ action: 'UPDATE' }))).not.toBe(base);
      expect(auditEventDigest(subject({ tenantId: 'tenant-south' }))).not.toBe(base);
      expect(auditEventDigest(subject({ resourceId: 'emp-2' }))).not.toBe(base);
      expect(auditEventDigest(subject({ actorId: 'user-2' }))).not.toBe(base);
    });

    it('treats an omitted key and an empty value as DIFFERENT subjects, by design', () => {
      // THE BOUNDARY OF THIS FUNCTION'S RESPONSIBILITY. The digest compares what the ROW will hold, not
      // what a caller happened to send, so an omitted `requestId` (dropped) and a sent `''` (kept) hash
      // differently here — and the equality of a genuine replay is produced by the WRITER's
      // normalisation before it digests (`requestId ?? ''`, `changedFields ?? []`). That normalisation
      // is asserted in `platform-audit.service.spec.ts`, where an event with no request context and one
      // that sent the empty string are shown to produce the same digest and therefore `duplicate`
      // rather than `conflict`.
      //
      // Asserting equality HERE would have claimed this function normalises. Idempotency would then
      // depend on the writer happening to agree with it, and a later change that stopped normalising
      // there would break replays with every test in this file still green.
      expect(auditEventDigest(subject({ requestId: undefined }))).not.toBe(
        auditEventDigest(subject({ requestId: '' }))
      );
    });
  });
});
