# PHASE 52-ARCH-3C â€” KEY PUBLICATION AND ROTATION

Scope: ADR-0006 Â§B2's *publication* half and the rotation contract its Consequences section
required but never measured. Core can now mint RS256 tokens from a **key set**, publish the
corresponding public keys at `GET /.well-known/jwks.json`, and retire a key on a clock â€”
without a restart, an endpoint, a permission or an admin UI.

The line this phase had to hold: a rotation must be an act on **configuration**, and the
moment a key stops being published and the moment it stops being accepted must be the **same**
moment. Everything below is that line, or the evidence for it.

## 1. THE PROBLEM, IN THE CODE THAT EXISTED

Before this phase the platform could already *verify* asymmetric tokens
(`JWT_ASYMMETRIC_PUBLIC_KEY`, `JWT_JWKS_URI`) and could *sign* with exactly one static key
(`JWT_ASYMMETRIC_KEY_ID` + `JWT_ASYMMETRIC_PRIVATE_KEY`). Three things were therefore missing,
and each was missing in a way that only shows up during a rotation:

1. **Nowhere to publish.** B2 said verification happens "via JWKS addressed by `kid`", but
   nothing in this repository served such a document. A verifier outside Core had to be handed
   a PEM out of band â€” i.e. the key-distribution path B2 mandates did not exist.
2. **One key, forever.** `TokenPolicy.asymmetricPublicKey` / `asymmetricPrivateKey` are single
   values. Publishing a successor and a predecessor at once, or accepting both, was not
   expressible; changing the key meant every verifier updating out of band, atomically, or
   failing verification until they did.
3. **No defined overlap.** The Consequences section required "rotation overlap" and said
   nothing about how long it must be, so "we waited long enough" was an operator's assumption.
   Nothing made a key *stop* being in play either, so a retired key's PEM would keep verifying
   indefinitely wherever it had been configured.

## 2. WHAT WAS BUILT

### 2.1 The key set â€” `apps/api/src/platform/auth/token-signing-keys.ts` (new, 478 lines)

`JWT_SIGNING_KEYS` is read as a JSON array of entries â€”
`{ kid, publicKey?, privateKey?, activatedAt?, retireAt? }` â€” and turned into
`TokenSigningKey[]`. The field list is **closed**: a misspelled field is refused rather than
ignored, because a silently ignored `retireAt` is a rotation that never completes and a
silently ignored `privateKey` is a verification-only entry where a signer was intended.
Everything decidable at boot is decided at boot: PEM shape, RSA modulus â‰¥ 2048 (ADR-0006 Â§B2),
pair consistency (a configured `publicKey` must BE the public half of the configured
`privateKey` â€” otherwise every verifier reports `signature-invalid` and nothing in a
configuration diff explains why), duplicate `kid`, `retireAt` before `activatedAt`, and the
ability to produce a JWKS entry at all.

Two decisions in this file are load-bearing:

* **the public half is derived** from the private half when only the private half is given, so
  a signing entry can never publish a key other than the one it signs with, and no operator
  keeps two copies of one key in agreement by hand;
* **`isRetired(key, now)` is the only definition of "in play"**, and the verifier and the
  publisher both consult it.

`toPublishedJwk()` writes the JWK **field by field** (`kty`, `use`, `alg`, `kid`, `n`, `e`)
rather than spreading a library export: a JWK carries whatever the runtime decided to put in
it, and a document assembled by spreading publishes whatever a future field smuggles in. `use`
and `alg` are stated because a verifier that has to infer either may infer wrong.

### 2.2 The rotation policy â€” `assertRotationOverlap()` (same file)

Three rules, in the order an operator meets them, all fatal at boot (`TokenPolicyError`):

1. the **active** key may not carry a `retireAt` â€” a signer with an end date stops minting the
   moment the window closes;
2. when this process **designates a signer**, every other key **must** carry one â€” a
   verification key with no end date stays published and accepted forever, so the rotation
   could never complete. A verification-only set (no active `kid`: a business runtime holding
   the platform's public keys) is not a rotation and is not given a window it has no use for;
3. for every key still inside its window, `retireAt âˆ’ successor's activatedAt â‰¥ 900s`.

The 900s is **derived and deliberately not configurable** (`TOKEN_ROTATION_OVERLAP_SECONDS`,
declared in `token-contract.ts` beside the numbers it is derived from): this platform accepts
an access token for at most 300s (`DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS`) and a verifier may
keep a JWKS document for up to 300s (`JWKS_CACHE_TTL_MS`), so â‰ˆ600s is the technical floor and
900s adds margin for clock skew. A knob whose only effect is to shorten that window turns a
security property into a typo, so there is no knob: a too-short window fails the boot, not the
verifier. Rule 3 is also why the active key needs `activatedAt` as soon as it has a
predecessor â€” without it the window cannot be *measured*, only assumed.

### 2.3 Publication â€” `token-jwks.ts` and `token-jwks.controller.ts` (new)

`TokenJwksPublisher` (in the seam) turns `TokenPolicy.publishableKeys(now)` into the JWKS
document: active key **first**, retired keys omitted, public material only.
`publishableKeys()` applies `isRetired` itself â€” retirement is not a caller's responsibility,
because a publisher that forgot it would advertise a key the verifier no longer accepts.

`TokenJwksController` (in `auth/`, registered by `AuthModule`) serves it at
`GET /.well-known/jwks.json` with `Cache-Control: public, max-age=300` â€” equal to
`JWKS_CACHE_TTL_MS`, so no intermediary holds a pre-rotation document longer than a verifier
inside this platform would. A runtime holding no key material answers **`404
JWKS_NOT_CONFIGURED`**, never `{"keys":[]}`: an empty document is a statement about the key set
that a verifier would read as an answer, while an absent one is the truth about that process.

The route is registered by the **runtime that issues tokens**, not by the seam: the seam may
not import `auth/` (`architecture-boundaries.spec.ts`), and publication is a Core act â€” Core
issues the tokens, so Core publishes the keys. A runtime that binds only the seam publishes
nothing.

### 2.4 The single-key path is not forked

`TokenPolicy` gained `signingKeys`, `activeSigningKeyId`, `signingKey`, `signingKeyProblem`,
`publishableKeys()` and `asymmetricIssuanceEnabled`, and now resolves *both* key sources in one
place. `TokenIssuer` asks the policy for the signing key instead of reading
`asymmetricPrivateKey`/`asymmetricKeyId` itself, so the issuer cannot disagree with the rest of
the platform about which key signs, and a refusal names the variable the operator actually has
to set (`JWT_SIGNING_KEYS`/`JWT_ACTIVE_KEY_ID` for a key set, `JWT_ASYMMETRIC_PRIVATE_KEY` for
a single-key deployment). `TokenKeySet.asymmetricKey()` gained one branch ahead of the existing
ones: a configured key set answers **completely** â€” an unknown `kid` is refused
(`key-unavailable`) rather than falling through to a static key or a JWKS fetch, and a retired
`kid` is refused for the same reason. Falling through is exactly how a rotation stops being one.
## 3. THE BOUNDARY AS IT NOW STANDS

Publication split the same way the seam already split everything else, and for the same
reason:

| Question | Answered in | Why there |
|---|---|---|
| Which keys may be published, and when? | `token-jwks.ts` (seam) | it is a question about the token contract, and a runtime that binds the seam must be able to answer it without a Core |
| Who serves the document? | `token-jwks.controller.ts` (`auth/`) | serving is a Core act â€” Core issues the tokens, so Core publishes the keys |
| Which key signs? | `token-policy.ts` (seam) | one place, so no caller can disagree about it |
| Is a key still in play? | `isRetired()` (seam) | one rule, consulted by the verifier *and* the publisher |

The seam may not import `auth/`, and `architecture-boundaries.spec.ts` enforces it â€” that is
why the route could not live beside the publisher even though that would have been the smaller
diff. The consequence is stated in `token-auth.module.ts` rather than left implicit: **a
runtime that binds only the seam publishes nothing**, and one that holds no key material of its
own answers `404 JWKS_NOT_CONFIGURED` rather than an empty document.

Three configuration surfaces are now mutually exclusive â€” a key set, a static public key, a
JWKS endpoint â€” because two of them would be two answers to "which key signed this?". The rule
is enforced twice on purpose: `env.validation.ts` at the environment boundary (so the process
does not even finish booting) and `TokenPolicy.assertKeySetCoherent()` at the policy boundary
(so a `TokenPolicy` constructed directly in a test or a future runtime gets the same refusal).

## 4. WHAT DID NOT CHANGE

* **The default is untouched.** No deployment in this repository configures key material â€”
  `JWT_SIGNING_KEYS`, `JWT_ACTIVE_KEY_ID`, `JWT_ASYMMETRIC_*` and `JWT_JWKS_URI` appear in no
  `.env`, no compose file and no policy â€” so every running process still verifies HS256 with
  `JWT_SECRET`, exactly as before. This phase makes rotation *possible*; it does not perform
  one, and it does not turn HMAC off anywhere.
* **No route moved.** `app.setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] })` excludes
  exactly one path; every existing route keeps the URL it had. `test/setup.ts` mirrors the
  exclusion so an e2e suite cannot pass at a prefixed URL that production would 404.
* **No new permission, endpoint, table, migration or admin surface.** Rotation is an act on
  configuration; the only new route is the read-only public document itself.
* **`JwtStrategy`, `JwtAuthGuard`, `RolesGuard` and `resolveHrActor()` are not touched.** The
  verifier's *key source* gained a branch; the verification pipeline did not change.
* **The single-key path is not forked.** `JWT_ASYMMETRIC_PRIVATE_KEY` + `JWT_ASYMMETRIC_KEY_ID`
  behave as they did, including the diagnostic the issuer raises when the key id is missing â€”
  it is now produced by `signingKeyProblem` instead of by the issuer's own branch.
* **Revocation (C), RBAC (D), audit (E) and the `future-hr` policy (F) are not touched.**


## 5. EVIDENCE

### 5.1 Sizes, counted file by file

New code and configuration files, six, **1,179 lines**:

| File | Lines | What it is |
|---|---|---|
| `src/platform/auth/token-signing-keys.ts` | 478 | the key set: parser, PEM/RSA/`kid` refusals, `toPublishedJwk()`, `isRetired()`, `assertRotationOverlap()` |
| `src/platform/auth/token-signing-keys.spec.ts` | 373 | 33 `it()` in 6 `describe()` |
| `src/platform/auth/token-jwks.spec.ts` | 94 | 5 `it()` |
| `src/auth/token-jwks.controller.spec.ts` | 87 | 5 `it()` |
| `src/auth/token-jwks.controller.ts` | 74 | the route |
| `src/platform/auth/token-jwks.ts` | 73 | `TokenJwksPublisher` |

Of those, **625 lines are production code** and **554 are spec**. The seam grew by two files, Core
by one.

Staged diff across the repository, this phase's changes only:

```
added=2489  deleted=32  files=22
```

22 = 7 new + 15 modified. The seventh new file is this report â€” committed with the change it
describes rather than in a commit of its own, the convention every prior closure report followed.
The 15 modified files, largest first â€” and the three that dominate the diff are the three the phase
had to open up:

| File | `+` | `âˆ’` | What changed |
|---|---|---|---|
| `src/platform/auth/token-policy.ts` | 203 | 15 | key-set resolution, `assertKeySetCoherent()`, `signingKey`, `signingKeyProblem`, `publishableKeys()`, `describe()` |
| `src/platform/auth/token-policy.spec.ts` | 131 | 0 | 23 â†’ 34 `it()` |
| `src/platform/auth/token-keyset.spec.ts` | 75 | 0 | 17 â†’ 22 `it()` |
| `docs/ADR/ADR-0006-ARCH-3-CROSS-RUNTIME-CONTRACTS.md` | 63 | 1 | B7, B8, amendment-record entry |
| `src/platform/auth/token-issuer.spec.ts` | 63 | 0 | 21 â†’ 24 `it()` |
| `src/platform/auth/token-contract.ts` | 50 | 0 | `TOKEN_ROTATION_OVERLAP_SECONDS`, `TOKEN_JWKS_PATH`, `TokenPolicyError` now live here |
| `src/platform/auth/token-keyset.ts` | 29 | 1 | the key-set branch in `asymmetricKey()` |
| `src/config/env.validation.ts` | 29 | 0 | the two variables, and the mutual-exclusion rule |
| `apps/api/.env.example` | 28 | 1 | the key set documented; `JWT_JWKS_URI` re-pointed at Core |
| `src/platform/auth/token-auth.module.ts` | 25 | 0 | `TokenJwksPublisher` provider + export, and *why* the route is not here |
| `infrastructure/nginx/conf.d/api.conf` | 23 | 0 | the exact-match `location` |
| `src/platform/auth/token-issuer.ts` | 10 | 9 | asks the policy for the signing key |
| `test/setup.ts` | 10 | 2 | the same `exclude`, mirrored |
| `src/main.ts` | 9 | 2 | the `exclude` |
| `src/auth/auth.module.ts` | 2 | 1 | registers `TokenJwksController` |

`token-issuer.ts` is the only file whose deletions approach its additions (10/9), and that is the
point of the change: two branches that read the single-key variables were **replaced** by one call
to the policy, not supplemented by one.

### 5.2 The three proofs

A policy that is only described is not a policy, so the three claims this phase makes were each
checked against something that could have said no.

**1. Configuration refusals â€” 33 `it()` in `token-signing-keys.spec.ts`.** Every "will be refused"
sentence in Â§2.1 and Â§2.2 is an assertion: non-JSON, a non-array, an empty array, an entry that is
not an object, an unknown field, a missing/empty/oversized/illegal-charset `kid`, a duplicate
`kid`, `publicKey` holding private material, a non-PEM `publicKey`, a `privateKey` that is not a
private key, an entry holding neither half, a `publicKey` that is **not** the public half of the
`privateKey`, a 1024-bit modulus, `retireAt <= activatedAt`, an active key with a `retireAt`, a
non-active key without one, a missing `activatedAt`, and a window of 899s against a required 900s.

**2. The unit suite.** Whole API package, `npx jest --silent`:

```
Test Suites: 131 passed, 131 total
Tests:       2236 passed, 2236 total
Snapshots:   0 total
Time:        33.655 s
```

**3. The live rotation.** Unit tests exercise the pieces; only a running process proves the
*clock*, so a real API was started on port 3999 with a real key set â€” `new` active and signing,
`old` public-only with a `retireAt` a few minutes out â€” and driven with real HTTP and real tokens
minted from the private keys. 17 assertions, all passing:

* `GET /.well-known/jwks.json` answers **without a token** (`200`), with `Cache-Control: public,
  max-age=300`, carrying **no private material** â€” every entry's fields are exactly
  `alg+e+kid+kty+n+use` â€” and publishing exactly the keys in play (`["new","old"]`);
* login issues an `RS256` token whose header names `kid=new`, and that token authenticates;
* a token signed by the *active* key is accepted;
* **T1: a token signed by the key inside its overlap window is accepted**;
* an unknown `kid` is refused (`401`);
* an **HS256 token carrying the shared secret is refused** (`401`) â€” no fallback to HMAC once
  asymmetric material exists (ADR-0006 Â§B5);
* **algorithm confusion is refused**: an HS256 token keyed with the *public* key (`401`);
* then, after waiting out the declared retirement: **T2 â€” the retired key is no longer published**
  (`kids=["new"]`), **the retired key verifies nothing**, and the active key still works â€” *with no
  restart*, which is the only thing that distinguishes "retired" from "still configured".

The T2 leg was run twice, at two different windows (25s and 247s), because the claim under test is
about a clock rather than a code path; both runs passed 17/17.



### 5.3 Types and lint

```
npx tsc --noEmit -p tsconfig.json                        exit 0, no output   (three separate runs)
npx eslint <this phase's 17 src/** paths>                exit 0, no findings
npx eslint test/setup.ts                                 exit 1 â€” a parsing error, identical for EVERY test/ file
npx eslint "src/**/*.ts"  (the repo's own lint scope)     exit 1 â€” 2,883 pre-existing problems
```

`tsc --noEmit -p tsconfig.json` was run three times as the tree settled, always `exit 0` with no
output.

`eslint` over this phase's source files â€” 17 paths: the 6 new files and the 11 modified files under
`src/` â€” is **clean**, `exit 0`, and it was re-confirmed after the last edit. `test/setup.ts`,
the eighteenth path this phase touched, reports one problem and it is **not a finding in this
phase's code**: `Parsing error: ... configured to run on <tsconfigRootDir>/test/setup.ts using
parserOptions.project: <tsconfigRootDir>/tsconfig.eslint.json`, because that config's `include` is
`["src/**/*.ts", "scripts/**/*.ts"]` with `test` in `exclude`, so ESLint has no program to type-check
a `test/` file against. That boundary is the repository's, not this phase's, and it was shown to be
so by linting **untouched committed** files through the same config: an untouched `test/` file
(`test/support.e2e-spec.ts`) fails identically. It follows that the repository's own lint script
(`npm run lint` = `eslint "src/**/*.ts" --fix`) has never linted `test/**` at all, which is why
`test/setup.ts` is linted by nothing â€” and why this phase's `test/setup.ts` change, ten added lines
mirroring the `exclude` in `main.ts`, cannot be lint-gated by any configuration this repository
currently has.

The same command over the whole `src` tree â€” the repo's own scope â€” is `exit 1` with **2,883
problems**, all pre-existing: a phase cannot report a clean repo-wide lint, and this one does not
claim to. What it claims is precisely what Â§5.3's first two lines say, and the third and fourth lines
are there so the difference between them is not mistaken for a regression.

The app e2e suite was re-run against the modified bootstrap: **1 suite, 51 tests passed**
(`test/app.e2e-spec.ts`), the suite that would have failed first if the `exclude` had moved an
existing route.

### 5.4 Formatting â€” this phase's files, and the repository's pre-existing debt

`npx prettier --check "src/**/*.ts" "test/**/*.ts"` â€” the repository's own `format:check` script â€”
**fails, and fails repo-wide**: `exit 1`, **397 of 488 files** flagged (30 under `src/generated`,
18 under `test/`, 349 hand-written `src/`, i.e. **81% of the tree**). Prettier is therefore not the
style this repository is actually written in, and this phase did not make that worse:

* every one of the **12 modified `.ts` files was flagged by `prettier --check` at HEAD as well** â€”
  checked by extracting the HEAD revision of each touched file into a scratch directory and running
  the same command over it: `12 of 12` flagged, `exit 1`. The flags this phase's edits sit among are
  therefore inherited, not introduced;
* the **6 new files** are flagged, like 397 of 488 files (and like every other hand-written file in
  `src/platform/auth/`), so they are consistent with the files they sit beside rather than with the
  formatter.

"Fixing" this cannot mean reformatting six files while leaving 391 others in disagreement with the
same rules, and a change that did so would make the diff of this phase noise. The gate this
repository does enforce is `eslint`, and on the surface that gate covers this phase is clean
(Â§5.3). Recorded here rather than silently normalised, because a formatting result that disagrees
with 81% of the tree is evidence about the tree, not about this change.

---

## 6. THE ADR'S ACCEPTANCE CRITERIA, ONE BY ONE

The ADR's list held **11** criteria before this phase and holds **13** after it: the two this phase
added (B7, B8) are the two the ADR previously could not state, because "publishes JWKS addressed by
`kid`" did not say *where* the document lives and "rotation overlap" did not say *how long*. The
honest table states per criterion what is true now.

| ADR criterion | Status after 52-ARCH-3C |
|---|---|
| Core signs with RS256 and publishes JWKS addressed by `kid`; HR verifies locally and holds no signing key | **The publication half is now done; the HR half is not this phase.** Core can sign RS256 from a configured key set and publish those keys at a `kid`-addressed JWKS â€” proven live (Â§5.2.3). What is *not* true: no deployment configures key material, so no runtime is on RS256; and no HR runtime exists to verify locally, which is ARCH-2/extraction work. |
| Publication has one venue and it is Core's own process: `GET /.well-known/jwks.json`, outside any API version prefix, public material only, cached no longer than a verifier here caches it (B7) | **Satisfied in code and on a running process.** Served at the root via `setGlobalPrefix('api/v1', { exclude })` on exactly that path, routed by an exact-match ingress location, carrying only `kty/use/alg/kid/n/e`, with `Cache-Control: public, max-age=300` = `JWKS_CACHE_TTL_MS`; a runtime with no key material answers `404`, never `{"keys":[]}`. |
| Rotation is configuration rather than an act on a running process: the active key signs, a predecessor stays published and accepted for â‰¥900s after its successor became active, and once its `retireAt` passes it is neither published nor accepted, with no restart (B8) | **Satisfied in code and against a clock.** `assertRotationOverlap()` refuses a window under 900s *at boot*; `isRetired()` is the single rule applied by both the publisher and the verifier; T1 (accepted inside the window) and T2 (not published, verifies nothing, no restart) were both observed live. |
| Access tokens carry `tid`, `ver` and canonicalised `perm`; tokens exceeding `HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS` are rejected | **Unchanged by this phase** (ARCH-3A). It is the source of the 900s floor: the accepted TTL (300s) plus a verifier's JWKS cache (300s) is the â‰ˆ600s technical minimum the policy rounds up. |
| Tenant and subject are read only from claims; no HR path reads a client-supplied tenant | **Not this phase.** No tenant-resolution code was touched. |
| `platform.identity@v1` returns exactly `DirectoryUserProfile` | **Not this phase** (ADR Â§A). |
| `platform.audit@v1` carries `AuditOptions` + `tenantId` + a caller-minted `auditId`, ingested idempotently | **Not this phase** (ADR Â§E). |
| Audit egress failure never fails a business write and never reports healthy while degraded | **Not this phase** (ADR Â§E). |
| `future-hr` declares `HR_DATABASE_URL: required` and `CORE_DATABASE_URL: not-used`, with the matrix assertion updated in the same change | **Not this phase, and forbidden to it** by the ADR's own non-goals; `future-hr` is still a declared target. |
| An architecture test proves no HR import closure reaches Core Prisma | **Not this phase.** The three boundary tests that exist (the seamâ†’`auth/` rule, the Core-free claim-only bindings, the HR closure as it stands) still pass; the phase added no import that would need a new rule, and Â§3 explains why the route could not live in the seam. |
| `platform.identity@v1` and `platform.audit@v1` are authenticated by **different** capability credentials, one per (caller, capability), stored encrypted and rotatable independently; neither authenticates the other (A8) | **Not this phase.** Landed in ARCH-3B; no credential code was touched. |
| An audit envelope that is unsigned, or signed with anything other than the caller's `platform.audit@v1` credential, is rejected without producing a row, and broker network position is never the authentication (E9) | **Not this phase, and still open as ARCH-3B's amendment records** â€” the ingester reads no AMQP headers yet. Untouched here. |
| Revocation latency and the audit loss window are documented in the runtime's operational notes, not only in this ADR | **Advanced for rotation only.** The overlap floor and the cache lifetime are now written where an operator actually reads them â€” `apps/api/.env.example` (the three-step rotation, the 900s rule and *why*) and ADR Â§B7/B8. Revocation latency and the audit loss window remain where ARCH-3A left them. |

Read as a count: **two criteria fully satisfied and proven (B7, B8), one advanced by half (the
publication half of the first criterion), one documentation criterion advanced for rotation, and nine
untouched** â€” of which six belong to the identity/audit contracts, one to the HR extraction, one to
the `future-hr` policy flip the ADR's non-goals exclude, and one (E9) was already recorded as open by
ARCH-3B's own amendment. No criterion is claimed as met that a reader cannot re-run.

---

## 7. WHAT THIS PHASE DID NOT DO

Named explicitly, because each absence is a decision rather than an oversight:

- **No key material was configured anywhere.** The capability now exists; the switch is not
  thrown. `JWT_SIGNING_KEYS`, `JWT_ACTIVE_KEY_ID` and every `JWT_ASYMMETRIC_*` name appear in
  **no** `.env`, in no compose file and in no policy: `docker-compose.yml` passes the `api`
  container exactly two JWT variables, `JWT_SECRET` and `JWT_REFRESH_SECRET`, and no `env_file`
  is used. So **no runtime â€” not even the containerized Core â€” is on RS256**, and
  `JWT_LEGACY_HS256_ENABLED` is still at its default. Turning the platform on is a deployment's
  act, and this phase deliberately leaves the ordering of that act to whoever can also decide
  when the last shared-secret token expires.
- **No rotation endpoint, no rotation permission, and no admin UI.** There is nothing to mutate
  in a running process: a rotation is an edit to configuration plus a restart. An endpoint would
  have meant a permission, an audit action and a fail-open path into signing authority, in
  exchange for automating an edit that deployment tooling already performs.
- **No change to the verification path's other callers.** `token-verifier.ts`,
  `jwt.strategy.ts`, `JwtAuthGuard` and `tenant-context.interceptor.ts` are **not in the diff**.
  The key-set branch was added *inside* `TokenKeySet.asymmetricKey()`, which is the one place
  that answers "which key does this token name?" â€” so guards, strategies and the WebSocket
  handshake inherit the behaviour without a line of their own changing.
- **No new architecture rule, and no existing one bent.** `architecture-boundaries.spec.ts` is
  unmodified. It is also *why* the route is in `auth/` rather than in the seam: the seam may not
  import `auth/`, so a controller registered by `AuthModule` could not live there. The suite
  passes unchanged.
- **No HR runtime, and no `future-hr` change.** No `hr-app.module.ts`, no HR entrypoint, no
  policy edit; `future-hr` still declares `CORE_DATABASE_URL: required`, and the assertion that
  says so still says so. No HR runtime verifies locally against this document yet â€” the document
  is published for one; wiring a consumer is ARCH-2.
- **No identity or audit contract work.** `platform.identity@v1`, `platform.audit@v1`, the
  capability-credential store and the audit ingester are untouched, including the E9 gap
  ARCH-3B's own amendment records.
- **No revocation work, and no change to the bridge's removal.** `RevocationFeed` is still bound
  to `UnwiredRevocationFeed`; `JWT_LEGACY_HS256_ENABLED` still defaults to `true` and is still
  disabled automatically once asymmetric material exists, which is now *three* ways rather than
  two â€” a static key, a JWKS URI, or a key set.
- **No deployment-shaped document was served.** Every proof in Â§5.2.3 ran on a throwaway process
  on port 3999 with generated keys that were written under `%TEMP%`, never into the repository or
  a running container. The staged worktree contains no key material of any kind.

---


## 8. RESIDUAL RISKS, AND WHAT BOUNDS EACH ONE

Each row names a risk this phase *introduces or leaves standing*, the mechanism in the code that
bounds it, and what remains open.

| Risk | What bounds it | What remains open |
|---|---|---|
| A key set that is incoherent â€” a duplicate `kid`, a public half that is not the private half's, a key under 2048 bits, an active key with a `retireAt`, a predecessor without one, a window under 900s, a misspelled field | Every one of those is **refused at boot** by `parseSigningKeys()`, `assertKeySetCoherent()` and `assertRotationOverlap()`, and conversion to a JWK is attempted at boot too, so a key set that cannot produce the document fails before it can serve a token | Boot-time refusal is only as good as the deployment's willingness to notice a crash loop. Nothing here *reports* a key set that is legal but unintended â€” a predecessor given a 900s window when the operator meant 30 days, say. `describe()` in the boot log is all the visibility there is. |
| Clock skew between the issuer and a verifier | The 900s floor is ~50% above the â‰ˆ600s technical minimum (`DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS` 300s + `JWKS_CACHE_TTL_MS` 300s), which is the margin skew must consume before the window is short | Skew is bounded by margin, not measured or enforced. A process whose clock is minutes off retires early or late relative to another, and nothing warns about it. Clock discipline remains the deployment's responsibility. |
| A verifier caches the document for longer than `max-age=300` | The header is explicit and bounded, and it is **derived** from `JWKS_CACHE_TTL_MS` rather than repeated â€” the two numbers cannot drift apart. 300s is one third of the 900s window, so two consecutive fully-stale caches still fit inside it | The header binds only those who honour it. A third-party verifier that ignores `Cache-Control`, or an intermediary configured to override it, can hold a pre-rotation document longer; that is outside this platform's reach and is documented at the header. |
| The JWKS route is unauthenticated and re-derives the document per request | Public material only, no write path, and a 300s cache header so normal clients fetch it roughly 0.2 times a minute. Derivation is cheap: `toPublishedJwk()` parses an already-validated PEM and exports `n`/`e` | There is no memoisation and no in-process rate limit. A caller that ignores the cache can make the process parse a public key per request; the ingress is the place to bound that if a target deployment finds it necessary. |
| An operator rotates in the wrong order | `JWT_ACTIVE_KEY_ID` cannot name a key the set does not hold, an active key cannot carry a `retireAt`, and a predecessor must carry one â€” the three ways to get the order wrong are boot failures with messages naming the variable. `.env.example` records the three steps | The platform cannot check that step 3 (removing the old key) ever happened. A retired key left in the set is harmless â€” once past its `retireAt` it is neither published nor accepted â€” but it is also invisible, so nothing reports that a rotation's cleanup is outstanding. |
| A key set that is correct but unreachable in practice | `TokenKeySet` fetches a remote JWKS with a cache, a cooldown against repeated failures and a timeout, failing **closed** on an unknown `kid`; the key-set branch added here is consulted **first** and refuses completely, so a configured set cannot silently fall through to a static key or a JWKS endpoint | The mutual-exclusion rules make the fall-through impossible by construction, but a deployment migrating from `JWT_JWKS_URI` to a key set must remove one before adding the other, and the refusal it meets in between is a boot failure naming both variables. That is the intended experience, not a degraded one. |
| Forgery on the shared-secret path | Unchanged from ARCH-3A: the `perm`/`tid` trust rule is keyed on the *verified* trust level, and HMAC acceptance disappears automatically once any asymmetric source is configured | Still the platform's live posture (Â§7). This phase made the alternative configurable; it did not make it configured. |
| Nobody notices which keys are published | The document itself is the inventory, `describe()` prints the key source and the published key count at boot, and `JWKS_NOT_CONFIGURED` distinguishes "not a publisher" from "publishes nothing" | There is no health-surface signal for "a rotated-out key is still in the set" or for a publisher and a verifier disagreeing. ADR finding F5 routes posture to the existing runtime-health mechanism, which is where that belongs and is not this phase. |

---

## 9. EXIT STATE, AND WHERE THE ADR'S ORDERING NOW STANDS

**What is true now that was not true before this phase.** Core publishes the keys it signs with, at a
path that is a contract rather than a convention, with rotation expressed as configuration and
retirement enforced by a clock â€” the same `isRetired` rule applied by the publisher and by the
verifier, so a key stops being published and stops being accepted at one instant. Prerequisite 1 was
short two things: *where* the document lives, and *how long* the overlap must be. Both are now code
with enforced rules (`TOKEN_JWKS_PATH`, `TOKEN_ROTATION_OVERLAP_SECONDS`), and both halves of a real
rotation were exercised live rather than inspected (Â§5.2).

**Where the ADR's ordering stands, prerequisite by prerequisite.** The order is the ADR's
(Â§Prerequisites and ordering), and each line below names its state rather than its intent.

1. **Core issues asymmetric tokens carrying `tid`, `ver` and `perm`** (B2, B3) â€” **code-complete as
   of this phase.** ARCH-3A built issuance; this phase built the half that was missing, publication
   Ã— rotation. What is *not* done is the deployment act: no `.env`, no compose file and no policy
   configures key material (Â§7), so every runtime still verifies with the shared secret. That is a
   posture change awaiting a decision, not an unfinished implementation â€” and the decision is now
   one variable with a tested alternative, which is what this phase existed to make true.
2. **Tenant moves from the per-request Prisma lookup to the `tid` claim** (E3, B3) â€” done in code
   (ARCH-3A), unchanged here.
3. **Core exposes `platform.identity@v1`** (A) â€” surfaces exist (ARCH-3B):
   `apps/api/src/platform/identity/` serves the contract, controller and module. Untouched here.
4. **Core exposes the `platform.audit@v1` ingester** (E) â€” exists (ARCH-3B):
   `apps/api/src/platform/audit/audit-ingest.consumer.ts`. The ADR's own amendment record for that
   phase states the ingester reads no AMQP headers, so no signature is verified and the
   capability-signed-envelope criterion (E9) is still **open**. Untouched here.
5. **Then, and only then:** the `future-hr` policy flip (F1), the runtime extraction, and the
   `architecture-boundaries.spec.ts` assertion update â€” **untouched.** `runtime-datasources.ts` and
   the boundaries spec still declare `CORE_DATABASE_URL: required` for `future-hr`, which remains the
   truth.

**So the next work, in the ADR's order.** What stands between here and prerequisite 5 is now one
*deployment* act and one open *audit* criterion â€” not a code gap in authentication. The deployment
act is the one thing this phase deliberately did not do: configuring a key set turns asymmetric
verification on everywhere it is configured and turns HMAC acceptance off with it (Â§7), so it is a
posture change that belongs to whoever owns the environment, not to a phase that was asked to make
it possible. Nothing here moves ARCH-2 forward on the calendar; it removes the last "not yet
possible" from prerequisite 1's code half.

---

## 10. THE CHANGE, FILE BY FILE

### 10.1 New â€” the seam, `apps/api/src/platform/auth/` (4 files, 1,018 lines)

| File | Lines | What it is |
|---|---|---|
| `token-signing-keys.ts` | 478 | `parseSigningKeys()`, `parseSigningKey()`, `toPublishedJwk()`, `isRetired()`, `assertRotationOverlap()`, `MIN_RSA_MODULUS_BITS`, `SIGNING_KEY_FIELDS` |
| `token-signing-keys.spec.ts` | 373 | 33 `it()` in 6 `describe()` â€” the refusals |
| `token-jwks.spec.ts` | 94 | 5 `it()` â€” what the publisher will and will not publish |
| `token-jwks.ts` | 73 | `TokenJwksPublisher`: `document()` and the `not-configured` refusal |

Neither production file imports anything from `auth/`, and neither reaches for `ConfigService`: the
parser is given a string and the publisher is given a policy, so both are testable without a Nest
container and the seam stays bindable by a runtime with no Core at all
(`architecture-boundaries.spec.ts`, Â§5.2).

### 10.2 New â€” the Core binding (2 files, 161 lines)

| File | Lines | What it is |
|---|---|---|
| `src/auth/token-jwks.controller.ts` | 74 | `GET /.well-known/jwks.json` â€” the route, its `Cache-Control`, and the `404 JWKS_NOT_CONFIGURED` refusal |
| `src/auth/token-jwks.controller.spec.ts` | 87 | 5 `it()` â€” status, header, body shape, refusal |

The controller lives in `auth/` rather than in the seam **because serving the document is a Core
act** â€” Core issues the tokens, so Core publishes the keys â€” while the seam must remain bindable by
a runtime that has no Core to serve from. That is a rule the repository already enforces, not a
preference: `architecture-boundaries.spec.ts` refuses any seam import of `auth/`, so a publisher
route declared inside the seam would have had to drag core concerns across the boundary or break the
test.

### 10.3 Modified â€” 15 tracked files, +750 / âˆ’32

(750 and 32 are the modified files alone; the phase's 22-file total in Â§5.1 is 2,489/32 once the six
new code/config files above and this report are counted.)

| File | `+` | `âˆ’` | Lines | What changed |
|---|---|---|---|---|
| `src/platform/auth/token-policy.ts` | 203 | 15 | 289 â†’ 477 | key-set resolution; `assertKeySetCoherent()`; `signingKey`; `signingKeyProblem`; `publishableKeys()`; `describe()` |
| `src/platform/auth/token-policy.spec.ts` | 131 | 0 | 277 â†’ 408 | 23 â†’ 34 `it()` |
| `src/platform/auth/token-keyset.spec.ts` | 75 | 0 | 283 â†’ 358 | 17 â†’ 22 `it()` |
| `docs/ADR/ADR-0006-ARCH-3-CROSS-RUNTIME-CONTRACTS.md` | 63 | 1 | 763 â†’ 825 | B7, B8, and the amendment-record entry for this phase |
| `src/platform/auth/token-issuer.spec.ts` | 63 | 0 | 319 â†’ 382 | 21 â†’ 24 `it()` |
| `src/platform/auth/token-contract.ts` | 50 | 0 | 268 â†’ 318 | `TOKEN_ROTATION_OVERLAP_SECONDS`, `TOKEN_JWKS_PATH`, and `TokenPolicyError` moved here |
| `src/platform/auth/token-keyset.ts` | 29 | 1 | 423 â†’ 451 | the key-set branch in `asymmetricKey()`, and the retired-`kid` refusal |
| `src/config/env.validation.ts` | 29 | 0 | 258 â†’ 287 | the two variables and the third-source mutual-exclusion rule |
| `apps/api/.env.example` | 28 | 1 | 270 â†’ 297 | the key set documented; `JWT_JWKS_URI` re-pointed at Core |
| `src/platform/auth/token-auth.module.ts` | 25 | 0 | 120 â†’ 145 | `TokenJwksPublisher` provider and export, and why the route is not here |
| `infrastructure/nginx/conf.d/api.conf` | 23 | 0 | 46 â†’ 69 | the exact-match `location` for the JWKS path, with the cache bound the platform's own verifiers use |
| `src/platform/auth/token-issuer.ts` | 10 | 9 | 255 â†’ 256 | asks the policy for the signing key instead of reading the variables |
| `test/setup.ts` | 10 | 2 | 255 â†’ 263 | the same `exclude`, mirrored into the E2E bootstrap |
| `src/main.ts` | 9 | 2 | 88 â†’ 95 | `setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] })` |
| `src/auth/auth.module.ts` | 2 | 1 | 49 â†’ 50 | registers `TokenJwksController` |

Two rows in that table deserve the comment Â§5.1 makes about them, restated here because they are the
only places where **existing behaviour moved**: `token-issuer.ts` (10/9) is the file whose deletions
nearly match its additions â€” two branches that read the single-key variables were *replaced* by one
call into `token-policy.ts`, not supplemented by one â€” and `main.ts` (9/2) changes a line every route
in the platform depends on, which is why the change is an `exclude` naming exactly one path rather
than anything that touches how the other routes resolve.

### 10.4 Reproducing every figure above

Run from the repository root (`E:\ERP`), on this commit's tree. Each line below is the command whose
output is quoted in the section named beside it.

```powershell
# Â§5.1 and Â§10.3 â€” the phase's whole change, and the split between new and modified.
git diff --cached --numstat                    # 22 rows: 7 with 0 deletions (new) + 15 modified
git diff --cached --numstat | % { ... }        # sums to: added=2489  deleted=32  files=22

# Â§10.3 â€” line counts, HEAD against the working tree, counted the same way for both sides.
$f='apps/api/src/platform/auth/token-policy.ts'
@(git show "HEAD:$f").Count                   # 289  (NOT Measure-Object -Line: it skips blanks)
@(Get-Content $f).Count                       # 477

# Â§5.1, Â§10.1, Â§10.2 â€” sizes of the six new files.
Get-ChildItem apps/api/src/platform/auth/token-signing-keys.ts, ... | % { $_.Name, $_.Length }

# Â§5.1, Â§10.3 â€” it() counts, HEAD against the working tree.
(git show 'HEAD:apps/api/src/platform/auth/token-policy.spec.ts' | Out-String) -split "`n" |
  Select-String -Pattern '\bit\(' | Measure-Object        # 23, and 34 in the working tree

# Â§5.3 â€” types, lint, and the e2e suite that would fail first if a route had moved.
cd apps/api
npx tsc --noEmit -p tsconfig.json                        # exit 0, no output
npx eslint <this phase's 17 src paths>                   # exit 0, no findings
npx jest --config ./jest-e2e.json --runInBand test/app.e2e-spec.ts --forceExit
                                                         # Test Suites: 1 passed | Tests: 51 passed

# Â§5.4 â€” formatting, this phase's files and the repository's baseline.
npx prettier --check "src/**/*.ts" "test/**/*.ts"         # exit 1, 397 of 488 flagged
# the HEAD revision of each modified file, into a scratch directory:
git show 'HEAD:apps/api/src/platform/auth/token-policy.ts' > $scratch/token-policy.ts
npx prettier --check $scratch/token-policy.ts             # flagged at HEAD too: 12 of 12

# Â§5.2, proof 3 â€” the live rotation, on a port of its own.
$env:JWT_SIGNING_KEYS = '<[{"kid":"new","privateKey":"...","activatedAt":"..."},
                           {"kid":"old","publicKey":"...","retireAt":"..."}]>'
$env:JWT_ACTIVE_KEY_ID = 'new'
$env:JWT_LEGACY_HS256_ENABLED = 'false'
npx ts-node -r tsconfig-paths/register src/main.ts       # 17/17 assertions, then 17/17 again
```

Three figures in this report are deliberately *not* one-line reproducible, and each says so where it
appears: the 2,883 repo-wide lint problems (Â§5.3) depend on the eslint version resolved in
`node_modules`; the 12-of-12 prettier baseline (Â§5.4) required materialising HEAD revisions into a
scratch directory, which the snippet above shows for one file and which was run for all twelve; and
the live-rotation probe (Â§5.2) needs three RSA key pairs of its own and a wall-clock wait for
`retireAt`, because the property it establishes is that **a clock**, not a restart, is what retires a
key.

**Status of the working tree when this report was written.** All 22 files above are staged â€” the ADR
and the nginx config among them, and this report with them, which is why Â§5.1's totals count it.
Twelve `apps/api/test/*.e2e-spec.ts` files also show as modified in `git status`, and they are **not
part of this phase**: they were already modified in the working tree before it began, which is how
`app.e2e-spec.ts` came to be re-run rather than rewritten, and none of the twelve is in the staged
set above.
