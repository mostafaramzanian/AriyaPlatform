# PHASE 52-ARCH-3C-R1 — JWT RUNTIME ACTIVATION

Phase 52-ARCH-3C built the key set, the rotation policy and the JWKS publisher, and proved all
three with unit tests and a live rotation **on a port of its own** (that phase's §5.2, proof 3).
What it never did was switch the seam ON in the deployment that actually runs. The container
serving Core was still minting HS256 tokens under `JWT_SECRET`, because nothing had ever handed it
key material — the code was complete and unreachable at the same time.

Activating it produced three things, in this order:

1. a **defect** that no unit test could have found, because the tests bootstrap through a different
   file than the deployment does (§1);
2. a **configuration channel** that carries the key set without a secret ever entering a tracked
   file (§2, §3);
3. **evidence from the running system** — a control run that measures the state before, then a
   sign, a publish, a rotation and a retirement observed on the deployed container (§4–§8).

Everything below is what the live runtime answered. Where a number appears, it came from a probe
against `http://localhost:3001`, not from a test harness on a port of its own.

## 1. THE DEFECT, WHICH ONLY ACTIVATION COULD FIND

`main.ts` — the combined bootstrap — had always set the prefix with the JWKS path excluded:

```ts
app.setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] });
```

`core-main.ts` (the runtime the deployment actually runs) and `cms-main.ts` set the same prefix with
**no exclusion at all**:

```ts
app.setGlobalPrefix('api/v1');
```

All three bind `AuthModule`, and `AuthModule` registers `TokenJwksController` — so all three serve
the document, and two of them served it at `api/v1/.well-known/jwks.json`.

The blast radius is the whole point of the contract. `TOKEN_JWKS_PATH` is a path **other runtimes**
are told to use: `.env.example` points `JWT_JWKS_URI` at `/.well-known/jwks.json`, the ingress
matches that path exactly (`infrastructure/nginx/conf.d/api.conf`), and ADR-0006 §B7 fixes it as a
constant. An issuer that answers 404 at the one URL every verifier is configured with is an issuer
with no verifiers — and the failure mode is a **404 on a health-looking URL**, not an authentication
error anyone would chase.

Why the tests were silent: every unit test that exercises the JWKS route builds its own Nest app,
and the e2e bootstrap (`test/setup.ts`) mirrors `main.ts`, which was already correct. The three
bootstraps are only distinguishable by *reading them*, and the deployment runs one of them. This is
the first finding of the phase and it is the reason the phase exists.

Both bootstraps now exclude the constant. Fixed on the live system, the difference is measurable
in one line each:

| Request | Result on the deployed Core runtime |
|---|---|
| `GET /.well-known/jwks.json` | **200** |
| `GET /api/v1/.well-known/jwks.json` | **404** |

and the boot log says which is the real one, in Nest's own words:

```
RouterExplorer  Mapped {/.well-known/jwks.json, GET} route
```

The exclusion is asserted by a new architecture rule, so a fourth bootstrap cannot repeat the
mistake: `architecture-boundaries.spec.ts` parses every `setGlobalPrefix` declaration in `src/`,
requires each one to list the **constant** `TOKEN_JWKS_PATH` (not a re-typed string, which would
work by accident and drift), and asserts that `main.ts`, `core-main.ts` and `cms-main.ts` are all
still present so the rule cannot pass by finding nothing to check.


## 2. THE CHANNEL THE KEY SET TRAVELS ON

The secret store is the gitignored root `.env`, resolved by compose interpolation — the same channel
`OPENAI_API_KEY` already uses, and the one the standing constraints require (a credential in one
place).

```
JWT_ACTIVE_KEY_ID: ${JWT_ACTIVE_KEY_ID:-}
JWT_SIGNING_KEYS: ${JWT_SIGNING_KEYS:-}
```

Written into `docker-compose.yml` directly after `JWT_REFRESH_SECRET`, in the `api` service's
environment block, with the reason stated in the comment beside it. Three properties, each checked
rather than assumed:

* **The values are not in the file.** Only the variable names are; compose resolves them from the
  host environment or the root `.env`. `git check-ignore` reports `.env` ignored at
  `.gitignore:18`.
* **The names resolve.** `docker compose config` on the real file resolves `JWT_ACTIVE_KEY_ID` to
  the expected kid and `JWT_SIGNING_KEYS` to the key-set JSON (1,749 characters of interpolated
  value), so the container receives them.
* **The secret cannot reach the image.** `.dockerignore` excludes `.env` and `.env.*`, and the
  running container was asked directly: neither `/app/.env` nor `/app/apps/api/.env` exists.

`JWT_SECRET` and `JWT_REFRESH_SECRET` are left exactly as they were. They are not dead weight: the
refresh flow never consults them (refresh tokens are opaque database rows, not JWTs), and access
tokens stop being signed with the shared secret the moment a key set is configured — but removing
them in the same change would have turned a rollback into a code change rather than a config change
(delete the two variables from `.env`, recreate the `api` service; nothing else moves).

## 3. THE KEY MATERIAL, DESCRIBED WITHOUT PUBLISHING IT

Two RSA pairs, generated on the host with Node's `crypto.generateKeyPairSync`, 2048 bits each
(ADR-0006 §B2's floor; the seam refuses anything smaller at boot):

| kid | role | modulus | SPKI SHA-256 (first 16 hex) |
|---|---|---|---|
| `r1-2026-09` | signs in stage 1; retires in stage 2 | 2048 | `540f39cdf2b012d1` |
| `r1-2026-10` | signs from stage 2 onward | 2048 | `f73410d95dd7baeb` |

The private halves were written to the host's temporary directory, never printed, and never copied
anywhere tracked. Two details are deliberate rather than incidental:

* in stage 1 the set holds **one** entry — the active signer with its private half — because a set
  with an active signer is a rotation in progress, and `assertRotationOverlap()` refuses a second
  key that declares no `retireAt`;
* in stage 2 the retiring key is given its **public half only**. A key that is leaving does not need
  the ability to sign, and the running system accepted that configuration — which is the live
  confirmation that a verification-only entry is enough for a key that is still being accepted.

## 4. THE CONTROL: WHAT THE DEPLOYMENT ANSWERED BEFORE ACTIVATION

A claim that a runtime now signs RS256 is only worth the measurement of what it signed before, from
the same path. The pre-R1 image (`erp-api:pre-r1`, built before the 3C seam) was booted with the
deployment's **own** environment minus the two key variables (32 variables carried over), on the
deployment's own network, keeping the image's entrypoint and the command compose uses
(`node dist/core-main.js`).

The image is provably pre-3C, by asking it rather than by trusting a tag:

```
ls dist/platform/auth                 -> No such file or directory
ls dist/auth/token-jwks.controller.js -> No such file or directory
```

Measured, 7/7:

| Probe | Result |
|---|---|
| `POST /api/v1/auth/login` | **200** |
| issued token `alg` | **HS256** |
| issued token `kid` | **absent** |
| `GET /api/v1/auth/me` with that token | **200** |
| `GET /.well-known/jwks.json` | **404** |
| `GET /api/v1/.well-known/jwks.json` | **404** |
| content-type of both 404s | `application/json; charset=utf-8` — Nest's own 404 |

So: before activation Core minted HS256 under the shared secret and published no keys; the JWKS
controller does not exist in that build at all.

**The first control run was invalid, and how it was caught.** It published the container on host port
3002 — which is held by an unrelated long-running container (`new-api`) that answers `200` with an
HTML body to *every* path. Its probe therefore measured someone else's server (`login` → 404, and a
"JWKS" that was any URL). A port number is not an identity. The control was rebuilt to publish **no
host port at all** and to probe from inside the container's own network namespace, which is why the
`content-type` of the 404s became an assertion: only Nest's 404 is `application/json`.

## 5. ACTIVATION (STAGE 1): SIGNING, PUBLISHING, AND THE PREFIX DEFECT

Stage 1 configured a set whose only entry is the active signer — `r1-2026-09` with its private half —
because `assertRotationOverlap()` refuses a second key that declares no `retireAt` (see §3).

The first RS256 token the deployment minted was the login token from that activation: it carried
`alg=RS256`, `kid="r1-2026-09"`, `iat` 1789907465 = **12:31:05Z**, and was decoded on the host at
12:40:18Z. It is preserved as `%TEMP%\p52r1\token-stage1-r1-09.txt`; the working copy
(`token-old.txt`) was overwritten at 12:56:46Z — the same moment the stage-1 battery below was
re-run — and now holds a stage-2-window token (`kid="r1-2026-10"`, `iat` 12:32:43Z), which is the
revision the later retirement checks used as "the old token". The `r1-09` reading above is the decode
recorded at the time, and its archive is the named file.

The stage-1 battery itself is archived (`%TEMP%\p52r1_stage1_final.log`), 15/15, run at 12:56:46Z —
after the rotation had completed, so against the **single-key** set: login `alg=RS256` with
`kid="r1-2026-10"`; `GET /api/v1/auth/me` `200`; JWKS `200` with `keys=1` naming that kid; the
published key `kty=RSA` with a 342-character modulus and exactly the fields `kty,use,alg,kid,n,e`; the
body scanned for `PRIVATE KEY` — absent; `cache-control: public, max-age=300` exactly; and four
refusals, each `401`: an unknown kid, a known kid with the wrong key, HS256 signed with a shared
secret, and HS256 using the published document itself as the HMAC secret (the RS256/HS256 confusion
ADR-0006 §B3 exists to prevent).

The defect of §1, re-measured on the deployed runtime after the final recreate:

| Request | Deployed Core runtime |
|---|---|
| `GET /.well-known/jwks.json` | **200** |
| `GET /api/v1/.well-known/jwks.json` | **404** |

and the running container's own log agrees about which one is real:

```
RouterExplorer  Mapped {/.well-known/jwks.json, GET} route
```

## 6. ROTATION (STAGE 2): TWO KEYS, THE POLICY FLOOR, AND A CLOCK

Stage 2 handed the deployment a real rotation: `r1-2026-10` active with its private half, `r1-2026-09`
demoted to its **public half only** with a `retireAt`. The window was set to a span of exactly
`TOKEN_ROTATION_OVERLAP_SECONDS` (900s) — the floor itself, not a comfortable margin: `activatedAt`
420s in the past, `retireAt` 480s ahead. The container was recreated, not restarted in place
(`docker compose up -d --force-recreate api`), and booted into this posture, verbatim:

```
Token acceptance: RS256 from key-set(2 keys, active=r1-2026-10, overlap>=900s), signs RS256,
2 public key(s) published, max-ttl=300s, HMAC acceptance disabled
```

In flight (T1), the issuer signed with the new kid while the document published **both** kids
(`["r1-2026-10","r1-2026-09"]`, 848 bytes) and the pre-rotation `r1-09` token still authenticated.
That is the overlap working as designed: a verifier that only knows the old key keeps working while
the issuer has already moved on.

Retirement (T2), 17s past `retireAt` (12:40:01Z): published kids `["r1-2026-10"]`, JWKS still `200`,
the new kid still signs and authenticates, the `r1-09` token `401` — and the container's
`StartedAt` was unchanged (`12:32:04.56`, `restarts=0`). Retirement happened **by clock inside a
running process**: no restart, no config reload.

**What T2 could not prove, stated plainly.** This deployment mints 300s access tokens
(`max-ttl=300s`), while the overlap tail left for observation was 480s. The pre-rotation token's own
`exp` (iat + 300s) therefore passed **253s before** the key retired, so its `401` was consistent with
expiry and retirement could not be told apart. T2 proved that publication stopped and that nothing
restarted; it did not prove that a *live* token dies with its key. §7 exists to close exactly that gap.

(One log line from that window reads like a failure and is not: the first T2 pass ran at 12:39:49Z,
**11 seconds before** `retireAt`, and correctly reported the retiring key still published. The clock,
not the policy, put it there.)

## 7. THE RETIREMENT INSTANT, MEASURED ON A LIVE TOKEN (STAGE 3)

The gap in §6 is closed by re-rotating the same two keys on a compressed window — span 960s (still
above the 900s floor) with `retireAt` only **120s** ahead — and minting the test token **on the host**
with the retiring key's private half. That half never entered the container (the container holds only
its public half), and the token's TTL is exactly the deployment's own 300s, so it is alive on both
sides of the boundary.

```
12:52:00.570  container started; restarts=0
12:52:06.872  107s BEFORE retireAt: kids=["r1-2026-10","r1-2026-09"] (848 bytes);
              a token signed by the RETIRING key -> HTTP 200, 300s of lifetime left
12:53:54.000  retireAt (clock; nothing restarted, reloaded or reconfigured)
12:54:01.127  7s AFTER retireAt: kids=["r1-2026-10"] (429 bytes);
              the SAME token -> HTTP 401, with 186s of lifetime left;
              the active key still signs (kid=r1-2026-10) and authenticates;
              container StartedAt identical, restarts=0
```

T3: 7/7. The `401` cannot be explained by expiry — the token had 186 seconds of life left — and it
cannot be explained by a restart, because the process that accepted the token is the process that
refused it. Publication and acceptance stopped at the same instant because they are two views of one
rule (`isRetired()`), which is what ADR-0006 §B7 asks for and what §6 alone could not demonstrate.

The deployment's state after this run: the rotation completed by clock, and the document serves
exactly one key — `r1-2026-10`.

## 8. WHAT CHANGED IN THE REPOSITORY

Activation needed one code change, and finding it needed the deployment. The verifier's contract is
`/.well-known/jwks.json`; `main.ts` (the combined bootstrap) already excluded that path from the
`api/v1` prefix, but **the deployment does not run `main.ts`** — compose runs
`node dist/core-main.js`. So the fix had to land in the bootstrap the platform actually deploys.

| File | Change | Why |
|---|---|---|
| `apps/api/src/core-main.ts` | +13/−1 — `setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] })` + import | **The defect.** Without it, Core served the document only at `/api/v1/.well-known/jwks.json` and 404'd at the path every verifier is told to use. This is the runtime that issues the tokens. |
| `apps/api/src/cms-main.ts` | +10/−1 — the same exclusion + import | The third bootstrap. It binds `AuthModule`, so it registers the JWKS route too; one contract, one spelling, in every runtime that sets a prefix. |
| `apps/api/src/architecture-boundaries.spec.ts` | +83 lines | The regression guard (§8.1). |
| `docker-compose.yml` | +12 lines | The two interpolated variables, documented, defaulting to empty so an unset key set leaves the shared secret the only source (§3) — plus a line naming where the accepted variable shapes and this report live, so an operator meets the pointer in the file they are editing. |
| `docs/reports/PHASE_52-ARCH-3C-R1_ACTIVATION.md` | new (untracked) | This report. |

The e2e-spec modifications visible in `git status` (calendar, media, messaging, users-directory, …)
**predate this run** and belong to earlier phases; nothing in this activation touched them.

### 8.1 The guard, and why it is shaped the way it is

The spec reads each bootstrap's `setGlobalPrefix(...)` call from the **syntax tree** and requires the
exclusion to be the constant `TOKEN_JWKS_PATH` — `exclude: ['/.well-known/jwks.json']` fails the
rule even though it would happen to work. A path that is part of a contract has one spelling; a
second literal copy is a second copy of the contract, and nothing keeps two copies in agreement. The
rule also names the three bootstraps in a vacuity check, so it cannot pass by finding no prefixes to
inspect — the same failure mode it exists to prevent.

This is the same guard style as the 3C boundary tests: the property is asserted where it can be
falsified (source text), not where it is merely described (a comment).

Validated on the final tree: `npx tsc --noEmit` clean (npm config warnings only) and
`jest src/architecture-boundaries.spec.ts` **23 passed / 23 total**.

## 9. WHAT THE DEPLOYMENT LOOKS LIKE NOW

| | |
|---|---|
| Container | `aria-erp-api`, image `erp-api:latest` (rebuilt during this activation) |
| Command | `node dist/core-main.js` (compose's own command, unchanged) |
| Started | `2026-09-20T12:52:00Z`, `restarts=0`, host port `3001` |
| `GET /.well-known/jwks.json` | **200**, `public, max-age=300`, kids `["r1-2026-10"]` |
| `GET /api/v1/.well-known/jwks.json` | **404** (contract path is the root one) |
| Signing | RS256, `kid=r1-2026-10`, `max-ttl=300s`, HMAC acceptance disabled |
| Rollback | `erp-api:pre-r1` (the pre-3C image) still tagged locally |

**The `.env` file, precisely.** This activation **created** `E:/ERP/.env` (it did not exist before:
creation time `15:40:24` local, today); it is gitignored (`.gitignore:18`) and was never tracked, so
**no pre-existing configuration was displaced**. It holds exactly two variables —
`JWT_ACTIVE_KEY_ID` (12 chars) and `JWT_SIGNING_KEYS` (2339 chars) — and their values never appear in
this report, in a tracked file, or in any command that was logged. The other way compose interpolates
is also live in this deployment: `OPENAI_API_KEY` is `SET` in the running container while `.env` does
not mention it, i.e. it comes from the host environment — the same channel `§3` describes.

**Disposal.** Both key pairs are self-generated **test** material, produced for this evidence with
the OpenSSL commands in §3.1 and held on this host at `%TEMP%\p52r1\` (`r1-private.pem`,
`r1b-private.pem`). A real deployment must generate its own keys and retire these; the mechanism is
what R1 activates, not the custody of these two files. A re-run should also back `.env` up before
rewriting it (the probe scripts overwrite it in place; harmless here only because it did not exist).

**The key set as the runtime itself reports it**, after the rotation completed (kids, field *names*
and presence only — never material):

```
entries=2
kid="r1-2026-10" hasPrivate=true  hasPublic=false activatedAt=set retireAt=absent
kid="r1-2026-09" hasPrivate=false hasPublic=true  activatedAt=absent retireAt=set
active="r1-2026-10"
```

The active signer's private half is present and no key is published with private material; the
retired key survives only as a public half, which is what lets a verifier keep checking tokens that
were issued under it. And the key set is the **only** key source: `JWT_JWKS_URI=0`,
`JWT_ASYMMETRIC_PUBLIC_KEY=0`, `JWT_ASYMMETRIC_PRIVATE_KEY=0`, `JWT_ACTIVE_KEY_ID=1`,
`JWT_SIGNING_KEYS=1` (counts, not values). There is therefore no ambient JWKS client to "also" trust,
so the set published from configuration is the only verification material this runtime can hold —
which is what makes the no-startup-fetch property meaningful rather than merely stated.

**Re-measured on this final state** (after the clock retired a key in a live process):
`/.well-known/jwks.json` → **200** with kids `["r1-2026-10"]`; `/api/v1/.well-known/jwks.json` →
**404**, still Nest's JSON 404 — the §1 defect row, re-confirmed; the container's identity is
`started=2026-09-20T12:52:00.570Z`, `restarts=0`; and a scan for complete PEM blocks across the
shipped code and the container filesystem returns **0**.

## 10. THE VALIDATION LEDGER

Every claim above rests on a run, and every run is listed here with its result:

| Run | Measure | Result |
|---|---|---|
| Control (pre-activation posture) | pre-3C image, no key set, probed from inside | 7/7 |
| Stage 1 (activation) | live `probe.mjs stage1` against the deployed container | 15/15 |
| T1 (rotation in flight) | both keys published, old token still accepted | 6/6 |
| T2 (clock retirement) | one key published, retirement applied without a restart | 6/6 — with the limitation stated in §6 |
| T3 (retirement instant, live token) | 200 → 401 on the same token across `retireAt` | 7/7 |
| Architecture boundaries | `jest src/architecture-boundaries.spec.ts` | 23/23 |
| Type check | `tsc --noEmit` | clean |

Negative checks asserted live (all `401`): a token from an unknown `kid`; a token signed by a
different key *naming a known kid*; an `HS256` token signed with a guessed shared secret; and an
`HS256` token using the **published public PEM as the HMAC secret** — the classic algorithm-confusion
shape. Once asymmetric verification is configured, `legacyAccepted()` is unconditionally false, so
the shared secret is not a fallback an attacker can reach.

Static checks on the shipped artifact: no full `PEM` block anywhere in the image (`0` matches); no
`JWT_JWKS_URI` and no `JWT_ASYMMETRIC_*` variable present; exactly one key source configured; the
JWKS document asserts no private field (`d/p/q/dp/dq/qi/oth/k`) and its raw body contains no
`PRIVATE KEY` marker.

**Reproduce.** The harness lives in `%TEMP%\p52r1\` (`probe.mjs` with `stage1|t1|t2`, `t3.mjs`,
`control_inside.mjs`) with the wrappers beside it (`p52r1_rotate.ps1`, `p52r1_stage3.ps1`,
`p52r1_control2.ps1`). They read credentials from the seed source, never print tokens, and write the
key set into the gitignored `.env` through the same interpolation channel the deployment uses.

## 11. WHAT THIS EVIDENCE DOES NOT COVER

Stated plainly, so nobody reads past it:

1. **Key custody.** No KMS, secret manager or HSM. The keys are files produced for this test and
   held in a gitignored env file. R1 activates the *mechanism* — signing, publication, verification,
   rotation, retirement — not where a production key lives.
2. **A separate verifier runtime.** Core was measured, and Core is both issuer and verifier here. The
   remote path — another runtime fetching this document over the network with `JWT_JWKS_URI` — was
   not stood up; that variable is unset in this deployment, so the client path is untested by this
   evidence.
3. **Boundary sweeps of the policy floor.** The 900s floor and the refusal of a second key that
   declares no `retireAt` were respected by the configurations used and by the boot validation, but
   this activation exercised one window shape (900s) plus one compressed shape (960s), not a sweep.
4. **Ingress and TLS.** The document was fetched over localhost HTTP. The nginx contract path
   (`infrastructure/nginx/conf.d/api.conf`) was read to confirm the path, but the ingress itself was
   not exercised in this run.
5. **Nothing was committed.** The change set sits in the working tree; this report is untracked. The
   commit, the review, and the withdrawal of the two test keys from `.env` are the operator's next
   steps.
6. **A repeated measurement of HMAC refusal.** `HMAC acceptance disabled` is stated in the activated
   deployment's own posture line and the forged-token refusals of §10 (two of them HMAC-shaped) hold
   against it, but a fresh, repeatedly-run sweep of the legacy `HS256` path against the final state was
   not performed in this pass, so the phase-3C compatibility table is not re-verified by this report.

One more honest note about the process: the first control attempt and the first T2 pass were both
wrong for *measurement* reasons (a port owned by another container; a probe fired 11s early), and
both were caught by the evidence itself rather than by inspection — `login` returning 404 through a
port the compose file did not own, and a "still published" result that contradicted a `retireAt`
already in the config. The corrected runs are the ones reported.

