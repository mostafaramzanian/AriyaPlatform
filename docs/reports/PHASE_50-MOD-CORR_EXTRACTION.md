# Phase 50-MOD-CORR — Correspondence extracted into an independent module

**Status:** implemented, verified against the real databases.
**Scope:** `apps/api` (module, database, client, scheduler, registration, tests, docs).
No web change was required: the HTTP contract is unchanged.

---

## 1. What changed

Correspondence (مکاتبات اداری) used to be a Core capability: code in
`apps/api/src/correspondence/**`, eleven tables inside `core_db` beside `"User"`,
seven `ON DELETE CASCADE` foreign keys from `"User"` into business documents, and a
bare `setInterval` inside `CorrespondenceService` doing its scheduling.

It is now an independent business module:

| Concern | Before | After |
|---|---|---|
| Code | `src/correspondence/**` | `src/modules/correspondence/**` (moved with `git mv`, history preserved) |
| Database | `core_db` | `correspondence_db` (`CORRESPONDENCE_DATABASE_URL`) |
| Prisma project | `prisma/core/schema.prisma` | `prisma/correspondence/schema.prisma` |
| Generated client | `src/generated/core-client` | `src/generated/correspondence-client` |
| Migration history | `prisma/core/migrations` | `prisma/correspondence/migrations/20260915120000_correspondence_baseline` |
| Identity | physical FKs + Prisma relations to `"User"` | plain `String` columns + the platform `USER_DIRECTORY` port |
| Scheduling | `setInterval` inside the domain service | `ScheduledSendDispatcherService` (`jobs/scheduled-send.dispatcher.ts`) |
| Registration | `core-app.module.ts` AND `app.module.ts` | `app.module.ts` only (composition root) |

Precedents followed, never invented: `src/modules/cms/**` (33J) for the module
namespace and an owned client, `ObservabilityPrismaService` (49M-2) for a fourth
independent database, and `ReminderDispatcherService` (49I) for the scheduler pattern.

---

## 2. DC-CORR-01 — two decisions, and why they are the right ones

### Decision 1: no cross-database foreign keys

Correspondence tables are in a different database, so the ten identity columns
(`senderId`, `userId`, `uploadedBy`, `ownerId`, `actorId`, `fromUserId`, `toUserId`,
`recipientUserId`, `tenantId`) became plain `String` identifiers. Internal integrity is
untouched: all eight relations *inside* `correspondence_db` (Letter ↔
recipients/attachments/referrals/tracking/archives/signature, the `ArchiveFolder` tree,
`LetterArchive → ArchiveFolder`) keep their exact cascade behaviour, because they
express real aggregate ownership within one database.

### Decision 2: no cascade from identity into business documents

**This is a deliberate behaviour change, not a side effect.**

| Operation | Before | After |
|---|---|---|
| `DELETE FROM "User"` | Cascaded into `Letter`, `LetterRecipient`, `LetterReferral`, `LetterAttachment`, `LetterSignature`, `LetterTempAttachment`, `ArchiveFolder`, `LetterArchive` — the organization's sent correspondence was destroyed with the account | Those rows **survive**. The identifier remains as the historical actor. |
| `LetterTrackingEvent.actorId` | Already `SET NULL`, nullable — "system event" | Unchanged meaning; the row is never deleted by Core either way. |
| Rendering a letter whose author is gone | Impossible (the row was gone too) | The projection names the historical id and renders the name as «کاربر» (`unknownUserProfile`, `displayUserName`). Pinned by `correspondence.service.spec.ts`. |

**Why this is correct for a document domain.** A letter that was sent remains the
organization's record of *what was sent, to whom and when*, independent of whether the
person who sent it still has an account. Cascade was defensible for account-scoped data
(sessions, preferences); it was wrong for the register of official correspondence, where
the sender's departure is precisely when the record matters most.

**What is explicitly NOT solved here.** Anonymization on an erasure request. A later,
separately-scoped concern (an event/contract-driven anonymization job) may blank these
columns deliberately. Doing it now, inside an extraction, would have been an unreviewed
policy change. It is recorded as a known follow-up (§7), not as a silent gap.

---

## 3. The defects this phase fixes, with evidence

The HR readiness audit (`PHASE_51-HR_READINESS_AUDIT.md` §11) found ten defects in the
Correspondence implementation. This phase owns the following and fixes them in the
module that now owns the code.

| # | Defect | Fix | Evidence |
|---|---|---|---|
| D1 | `status = 'SCHEDULED'` violated `Letter_status_timestamps`: the enum admitted a state the CHECK refused, so **no letter could be scheduled** | The baseline declares the missing SCHEDULED branch — committed and ready, no number, `sentAt`/`cancelledAt` NULL, **and `scheduledAt` NOT NULL** | Proven live against the module database: a SCHEDULED insert is accepted; the negative control (`SCHEDULED` with NULL `scheduledAt`) is still refused. Also pinned by the isolation spec. |
| D2 | The send path listed only `DRAFT`/`READY_TO_SEND`, so it could not LOAD a `SCHEDULED` letter — the state was terminal in practice | `sendDraft`'s load predicate includes `SCHEDULED`; `dispatchScheduledLetter` re-asserts the due invariant, then reuses the same atomic flip | e2e: "lets the sender send a SCHEDULED letter immediately (the path used to refuse it)" |
| D3 | `scheduledAt` was `TIMESTAMPTZ` while every sibling timestamp is `TIMESTAMP(3)` | The baseline column is `TIMESTAMP(3)`; existing values were converted with `AT TIME ZONE 'UTC'` so the stored instant is unchanged | Baseline SQL + the reconciliation checksum on `Letter.scheduledAt` (UTC wall clock) |
| D8 | Worker: bare `setInterval(60_000)`, no replica guard, no `unref()`, no batch bound, no tenant filter — every replica ran an unbounded scan | `ScheduledSendDispatcherService`: `running`/`ticking`, `unref()`ed timer, bounded `take`, atomic conditional-UPDATE claim | `scheduled-send.dispatcher.spec.ts` (10 cases) + the e2e idempotency case |
| D9 | The due scan had no supporting index | `Letter_scheduled_due_idx` — `CREATE INDEX … ("scheduledAt") WHERE "status" = 'SCHEDULED'` | Verified present in the module database; pinned by the isolation spec |
| D10 | A failed scheduled send was re-tried forever with no record of why | `sendAttempts` + `lastSendAttemptAt` + `lastSendError`; `MAX_SEND_ATTEMPTS = 5` bounds both the scan and the claim | e2e: an exhausted letter stays `SCHEDULED` and leaves the due scan; a failure records `lastSendError` |

Excluded on purpose: D4–D7 (unrelated to the extraction) were not touched.

---

## 4. The boundary: what the module may and may not see

An extracted module still has to answer two questions about people — "is this id a
member of my tenant?" and "what is this person called?" — and must not answer them by
importing Core's client. The seam is a PORT:

```
src/platform/user-directory/user-directory.contract.ts     ← the port (4 methods, allowlisted DTO)
src/platform/user-directory/core-user-directory.adapter.ts ← the ONLY file that touches core_db
src/platform/user-directory/user-directory.module.ts       ← exports the USER_DIRECTORY token
```

The module injects `@Inject(USER_DIRECTORY)`. Four call sites replace what used to be
direct reads: recipient validation, referral-target validation, background-job tenant
resolution and projection hydration (one batched call per page, keyed by id — the old
per-row relation would have been N+1).

What the port deliberately CANNOT return: email, `passwordHash`, `tokenVersion`,
`status`, roles, permissions, tenant membership beyond yes/no. A module can render a
person and validate a tenant edge; it cannot enumerate accounts, discover who is an
administrator, or read a credential-adjacent column. Widening it would re-create the
coupling this phase removed.

What still crosses from the platform is only what a business module legitimately cannot
own — each an existing platform capability rather than a new dependency:

| Dependency | Why it is legitimate |
|---|---|
| `RbacModule` → `PermissionService`, `AuditService` | Entitlements come from the RBAC catalogue, never a role-name string; security-sensitive mutations are audited |
| `NotificationModule` → `NotificationService.createForUser` | The single server-side notification path (49E); a notification failure never fails a send |
| `StorageModule` → `IStorageProvider` | Attachments/signatures reuse MinIO and signed URLs (49F/49G) |
| `calendar/jalali.util` | Pure Jalali arithmetic — no database, no client. Reusing it keeps ONE Jalali boundary; duplicating it here would be the actual defect |

### Route surface at the cutover

| Root module | Before | After |
|---|---|---|
| `CoreAppModule` | 228 routes (incl. 36 correspondence) | **192** — exactly the 36 correspondence routes left Core |
| `AppModule` (composition root) | 185 routes | **185 — IDENTICAL**, same set and same count |

The HTTP contract is therefore preserved exactly; only the module that SERVES it
changed. Raw dumps: `p50r-routes-{core,app}-{before,after}.txt` (throwaway probes).

---

## 5. Verification evidence

| Check | Result |
|---|---|
| Baseline migration applied to `correspondence_db` | 11 tables; migration recorded in `_prisma_migrations` |
| D1 positive control | `status = 'SCHEDULED'` insert **accepted** in the module database |
| D1 negative control | `SCHEDULED` with NULL `scheduledAt` **still refused** — the invariant is tightened, not loosened |
| D9 index | `Letter_scheduled_due_idx` present, partial on `status = 'SCHEDULED'` |
| Data copy `core_db` → `correspondence_db` | 8 letters, 3 recipients, 12 tracking events, 1 attachment, 2 folders, 1 archive, plus counters/signatures/temp attachments/referrals |
| Reconciliation | **22/22 lines IDENTICAL** — per-table row counts AND content MD5 checksums on both databases; the only transform is `Letter.scheduledAt` `TIMESTAMPTZ` → UTC wall clock (D3) |
| Import method | text-format `\COPY` (`\N` for NULLs) so rich-text bodies are byte-identical; `session_replication_role = replica` disables RI triggers only — **CHECK constraints stay enforced**, so an invariant-violating legacy row fails loudly instead of entering quietly |
| Typecheck | `tsc --noEmit` clean |
| Unit tests | **90 suites / 1597 tests pass** — including the new dispatcher spec (10 cases), the §25 isolation guard (11 cases) and the platform-port spec (10 cases) |
| Lint | no NEW findings on the touched surfaces (the pre-existing repo debt is unchanged) |
| Build | `npm run build` clean — all four Prisma clients regenerated; `dist/main.js` and `dist/modules/correspondence/correspondence.module.js` present |
| Route surface | Core −36 correspondence routes; composition root byte-identical |
| Correspondence e2e | **23/23 pass** (18 pre-existing + 5 new scheduler cases) against the real databases, real MinIO and the real authorization stack |

---

## 6. Operational notes

```bash
# generate the module's client (also part of `npm run build`)
npm run prisma:generate:correspondence

# apply the module's migrations to its own database
npm run prisma:migrate:correspondence
```

* `CORRESPONDENCE_DATABASE_URL` is OPTIONAL at the platform level and **required by the
  module**, exactly like `CMS_DATABASE_URL`: a process that does not import the module
  boots without it. The composition root does import it, so the API requires it.
* A deployed `aria-erp-api` container must be **rebuilt** for this cutover — the module
  now lives at `dist/modules/correspondence/**`. The database side is additive: the old
  tables in `core_db` were left in place, so the previous behaviour remains available
  until the new path is confirmed in an environment.
* The scheduler runs only in processes that register the module (the API). Its timer is
  `unref()`ed, so it never keeps a process — or a Jest run — alive.
* Backups: `correspondence_db` must be added to whatever schedule covers `core_db`. A
  database holding the organization's official correspondence is not optional
  infrastructure.

---

## 7. Deliberately NOT done

Recorded so the boundary of this phase is unambiguous:

1. **Anonymization on an erasure request.** Identity columns survive a user deletion;
   blanking them deliberately is a later, separately-scoped concern.
2. **Dropping the old `core_db` tables.** The copy is verified and reconciled, but the
   source tables are retained until the new path has run in an environment.
3. **D4–D7 of the audit.** Unrelated defects, untouched by an extraction phase.
4. **The web app.** No change: the HTTP contract is identical (proven by the route dump
   above).
5. **`correspondence_db` on a separate Postgres instance.** It is a fourth database on
   the existing cluster, matching the CMS/observability precedent. Physical separation
   is a deployment decision, and the module is already independent of it.