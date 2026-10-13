# Phase Report — AI Architecture Hardening + AI Gateway

> Implementation commit: **`f68a3a5`** — `refactor(ai): harden runtime architecture and add ai gateway`.
> Baseline before this phase: `9b4835e`.

## 1. Preflight findings

All inventory was produced by repository-wide `git grep` over tracked files
(`aria-code-and-architecture/` is `.gitignore`d reference material and was
excluded from every count).

### 1.1 Consumer inventory (§3.1)

| Category               | Consumers                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| configuration consumer | `ai-config.controller.ts` (admin HTTP), `app.module.ts` / `core-app.module.ts` (boot)                                                                           |
| embedding consumer     | `SearchService.embedQuery` and `SearchEmbeddingService` — both via `AIConfigService.generateEmbedding`                                                          |
| search consumer        | `SearchDocumentWriter` imported `DEFAULT_EMBEDDING_MODEL` plus a boot-time `process.env.EMBEDDING_MODEL` constant for the stored model tag                     |
| future/unused consumer | `getEmbeddingProvider()` / `getTextProvider()` / `generateEmbedding()` on the config service — zero production callers (grep-proven; specs only)                |
| unused but tested      | `OpenAIProvider.generateEmbeddingBatch` — zero production callers (spec-only)                                                                                   |
| legacy consumer        | DI token `'IAIProvider'` — provided/exported by `AIModule`, **zero** `@Inject('IAIProvider')` sites repository-wide                                              |
| comment-only           | `integration.service.ts`, `module-registry.service.ts` mention `AIConfigService` in comments only (no dependency)                                               |
| duplicate implementation | `packages/ai/index.ts` — see §1.2                                                                                                                            |

### 1.2 Duplicate abstraction (`packages/ai`) — outcome C (obsolete artifact)

- The path contains exactly one file (`index.ts`), **no `package.json`**, and
  defines a second `IAIProvider` (`generateEmbeddings` plural, `any` options,
  `return []` stubs) plus four fake-success provider classes.
- `git grep 'packages/ai'` / `git grep '@aria/ai'` across tracked files: **zero
  matches** — no import, no tsconfig path, no reference beyond the generic
  `packages/*` workspace glob.
- Verdict: dead Phase-A scaffold. **Removed** (`git rm -r packages/ai`), and an
  architecture gate (`ai-boundaries.spec.ts`) asserts the directory stays deleted
  and nothing imports it. The canonical runtime AI contract remains
  `apps/api/src/ai/i-ai-provider.ts` — exactly ONE AI abstraction survives.

### 1.3 Baseline inventory preserved

All files listed in §2 of the prompt exist and remain: the `src/ai` set
(interface, four providers, registry, config service, controller, DTO, module),
its four spec files, `AIProviderConfig` in Core Prisma with migration
`20260902120000_add_ai_provider_config` (+ permission seed `20260902120500`),
`admin.ai.read`/`admin.ai.manage`, the search integration and its 1536-wide
vector contract. **No schema change was needed** (§39: no artificial migration
created) — `modelName`, `baseUrl` and the credential envelope already existed;
dimension/timeout remain environment-owned by design.

## 2. Existing AI architecture (as found)

```
AIConfigService    = config CRUD + audit + connection test + runtime resolution
                     + generateEmbedding + getEmbeddingProvider/getTextProvider
                     + runWithCredential (process.env mutation)
AIProviderRegistry = matrix + adapter resolution (already compliant with §8)
OpenAIProvider     = env cached at constructor; OPENAI_API_KEY read at call time
Search             → AIConfigService.generateEmbedding() directly
```

Registry matrix (unchanged, still canonical): only `OPENAI/EMBEDDING` is true;
Azure/Anthropic/Local are stubs; Anthropic embedding is vendor-absent.

## 3. Problems confirmed from code

1. **`process.env` mutation per request** — `AIConfigService.runWithCredential`
   assigned `process.env.OPENAI_API_KEY` for the duration of a call. Its own doc
   admitted `NOT CONCURRENCY-SAFE`: two overlapping executions with different
   credentials could observe each other's key. Triggered by both the runtime
   embedding path and the admin connection test.
2. **`modelName`/`baseUrl` were NOT runtime-effective** — `OpenAIProvider`
   resolved `OPENAI_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION` once in
   its constructor; a stored row's `modelName`/`baseUrl` were metadata at
   runtime: the UI could display one model while another executed.
3. **Capability-agnostic interface** — `IAIProvider` presented three methods on
   every adapter; support truth lived only in the registry (correct), but no
   capability-shaped contracts existed for consumers to target.
4. **Search coupling** — `SearchService`/`SearchEmbeddingService` depended on
   `AIConfigService` (the control plane, Prisma + credential envelope) for
   execution; the stored `embeddingModel` tag came from a boot-time env constant,
   which would record the WRONG tag whenever a DB row overrode the model.
5. **No endpoint policy** — `@IsUrl({ require_tld: false })` accepted
   `http://user:pass@host` and `http://169.254.169.254/…`.
6. **Dead surface** — zero-consumer methods (`getEmbeddingProvider`,
   `getTextProvider`, `generateEmbedding` on the config service), the dead
   `'IAIProvider'` DI token, and the dead `packages/ai` package: three parallel
   ways to reach an embedding provider beside the intended path.
7. **No unit coverage of the search embedding path** — `SearchService`,
   `SearchEmbeddingService` and `SearchDocumentWriter` had no spec files.

## 4. Changes made

New files:

| File | Purpose |
| ---- | ------- |
| `src/ai/ai-errors.ts` | Taxonomy: `AIExecutionError` + 6 codes, every one produced somewhere (§33) |
| `src/ai/ai-endpoint.policy.ts` | Pure baseUrl classifier (allowed external/internal vs blocked), write-time + resolution-time (§18) |
| `src/ai/ai-runtime.resolver.ts` | Row/bootstrap → effective config; decrypt, policy, matrix re-check; hard-failure rule (§9/§13/§14) |
| `src/platform/ai/ai-gateway.contract.ts` | `AI_GATEWAY` token, `AIGatewayContract`, result/context shapes (§10/§11) |
| `src/platform/ai/ai-gateway.service.ts` | The gateway: resolve → invoke → classify → structured result |
| `src/platform/ai/platform-ai.module.ts` | Platform binding, exports ONLY the token (PlatformAuditModule idiom) |
| `docs/architecture/AI-PLATFORM.md` | Current-state architecture documentation (§37) |
| six new spec files (§12) | policy, resolver, gateway, search embedding, search service, architecture gates |

Modified:

- `i-ai-provider.ts` — capability contracts (`EmbeddingProvider`,
  `TextGenerationProvider`, `ChatCompletionProvider`) composed into `IAIProvider`;
  `AIEmbeddingExecutionOptions { model?, baseUrl?, credential? }`.
- `openai.provider.ts` — per-call effective configuration;
  `dimensions` negotiation follows the EFFECTIVE model; every failure mapped to
  a taxonomy code (messages unchanged); env read at call time ONLY as bootstrap
  when an option is absent.
- three stub adapters — gained `getEmbeddingContract()` (structurally satisfying
  the composite; matrix unchanged, still false).
- `ai-config.service.ts` — `runWithCredential`, `resolveProvider`,
  `generateEmbedding`, `getEmbeddingProvider`, `getTextProvider`,
  `readCredential` **removed**; connection test is capability-dispatched and
  resolves through the resolver (credential as parameter, zero env writes);
  create/update validate the endpoint policy.
- `ai.module.ts` — provides/exports `AIRuntimeResolver`; **`'IAIProvider'` token
  removed** (zero consumers, grep-proven); RbacModule kept for `AuditService`
  only — RolesGuard re-audit: global via `APP_GUARD` at both composition roots,
  documented in the module comment (§24).
- search (`search.service.ts`, `search-embedding.service.ts`,
  `search-document.writer.ts`, `search.module.ts`,
  `platform-search-source.module.ts`) — consume `AI_GATEWAY`; the embedding
  service returns `{ vector, model }` so the stored `embeddingModel` tag is the
  EFFECTIVE model of that execution; the boot-time env tag constant is gone.
- specs updated: `ai-config.service.spec.ts` (env-mutation tests replaced by
  parameter/env-untouched tests + decrypt-failure/policy failures + write-time
  policy tests), `openai.provider.spec.ts` (runtime-config + provider-level
  concurrency), `ai-provider.registry.spec.ts` (fourth method presence).
- removed: `packages/ai/` (§1.2).

## 5. New architecture

```
Core/Platform
   ↓
AIConfigService      (control plane: CRUD, audit, connection test)
AIProviderRegistry   (identity, matrix, adapter resolution — unchanged role)
   ↓
AIRuntimeResolver    (effective config: model + baseUrl + credential, per call)
   ↓
AIGateway            (platform/ai: the only execution seam)
   ↓
capability contracts → provider adapters
```

Consumers (Search today, Reporting tomorrow):

```
consumer → AI_GATEWAY token → AIGatewayContract → …
```

Nothing outside `src/ai` imports a provider class or the config service; the
`ai-boundaries.spec.ts` gates enforce: business modules ↔ `src/ai` isolation,
search-gateway-only wiring, adapters ↔ Prisma/business isolation, gateway ↔
business/concrete-provider isolation, adapters free of actor/tenant semantics,
and `packages/ai` staying deleted.

## 6. Runtime resolution flow

```
consumer → AI_GATEWAY.embed(input, context)
    → AIRuntimeResolver.resolveEmbedding()
        no enabled default row  → ENVIRONMENT bootstrap:
            OpenAI adapter, executionOptions undefined, model = env contract
        row exists              → DATABASE configuration:
            supports() re-check   → else UNSUPPORTED_CAPABILITY (hard)
            credential decrypt    → else CONFIGURATION_ERROR (hard)
            endpoint policy       → else SECURITY_POLICY_REJECTED (hard)
    → adapter.generateEmbedding(input, { model, baseUrl, credential })
    → AIExecutionResult { capability, provider, model, output,
                          metadata: { latencyMs, configurationSource,
                                      correlationId? } }
```

- Not memoised (§40): one indexed row read per execution; a default switch takes
  effect on the next call without restart.
- `EMBEDDING_DIMENSION`/timeout remain environment-owned (no DB column exists;
  a dimension change is a re-index concern by contract).
- Written + runtime halves of the endpoint policy run from ONE pure function.

## 7. Credential security model

- encrypted at rest (AES-256-GCM envelope, all-or-nothing CHECK — untouched);
- never returned (single masked projection, untouched); never audited; never in
  logs (closed-field logging asserted by specs); never in a URL (policy rejects
  userinfo; test stays POST-body);
- **per-call parameter**: `process.env` is never mutated by any path —
  `runWithCredential` deleted; the resolver and gateway pass the decrypted key
  through `AIEmbeddingExecutionOptions.credential`, scoped to one call frame.
  Two concurrency tests (gateway-level interleave, adapter-level fetch interleave)
  prove no execution observes another's key.

## 8. Capability model

- Canonical matrix unchanged in the registry; support declared, never inferred
  (registry spec keeps its "EXACTLY ONE supported cell" tripwire).
- Capability contracts separated (`EmbeddingProvider` / `TextGenerationProvider`
  / `ChatCompletionProvider`) and composed into `IAIProvider` for compatibility —
  no adapter was broken, no caller signature widened.
- Text generation remains **unsupported end to end**: matrix false, no gateway
  method, no fabricated implementation.
- Connection test is capability-dispatched (`switch (row.capability)`) with an
  unreachable-by-matrix default that refuses rather than probing an embedding.

## 9. Search integration

- `SearchService` and `SearchEmbeddingService` now consume `AI_GATEWAY`
  (`{ moduleId: 'search' }`); zero imports from `src/ai` remain (arch gate).
- Behaviour preserved: configured path → semantic HYBRID; env bootstrap path →
  still works through the resolver; AI failure → lexical degraded (`mode` and
  `degraded` flags unchanged); wrong-width vector → refused at BOTH the embedding
  service and writer (1536 contract intact, no padding/truncation anywhere).
- The stored `embeddingModel` tag is now the EFFECTIVE model reported for that
  vector (previously a boot-time env constant).

## 10. Gateway contract

`AI_GATEWAY` token + `AIGatewayContract.embed(input, context?)` → structured
`AIEmbeddingExecutionResult` (§11 of the prompt): capability, provider, model,
output, metadata — credential absent at any depth (spec-asserted over the
serialised result). Context carries `{ correlationId?, tenantId?, actorId?,
moduleId? }`; only `moduleId`/`correlationId` reach logs, and nothing reaches an
adapter (adapters remain business-semantics-free). Errors classified with the
§33 codes; `HttpException`s pass through; bare adapter errors wrap as
`UPSTREAM_UNAVAILABLE` with a safe message (`cause` keeps the detail in-process).

## 11. Compatibility decisions

| Decision | Rationale |
| -------- | --------- |
| `IAIProvider` kept as composite of three capability contracts | §27 staged refactor; zero caller breakage; adapters unchanged structurally |
| `'IAIProvider'` DI token **removed** | grep-proven zero consumers; keeping it preserved a credential-blind second path |
| `AIConfigService.generateEmbedding/getEmbeddingProvider/getTextProvider` **removed** | grep-proven zero production consumers; execution belongs to the gateway; keeping instance-handing would preserve the credential footgun |
| `generateEmbeddingBatch` kept on the adapter (off the port) | spec-only surface predating the port split; not promoted to the contract nobody consumes |
| env fallback when a row stores no credential (OpenAI) | pre-existing tested behaviour (49J); changed ONLY the broken-config cases (§14) |
| `resolveProvider` returning null on withdrawn capability → now hard failure | §14 explicitly requires broken configuration to fail instead of silently falling to env |
| RbacModule kept in `AIModule` | real dependency (`AuditService` producer); RolesGuard removed as justification in comments; no artificial split (§24) |
| no schema migration | columns already exist; §39 forbids artificial migrations |
| `@IsUrl` kept in the DTO + policy behind it | DTO keeps field-shape validation; the policy is the security decision, enforced at write and resolve |

## 12. Tests executed

| Command (repository root unless noted) | Result |
| --------------------------------------- | ------ |
| Focused: `jest --runInBand --testPathPattern "src/ai\|src/search\|platform/search-source\|platform/ai"` (apps/api) | ✅ 15/15 suites, **428 tests** |
| Full unit: `jest --runInBand` (apps/api; pre- and post-`eslint --fix`) | ✅ **247/247 suites, 4037 tests**, 86.35 s (both runs green) |
| New specs under `--detectOpenHandles` | ✅ 6/6 suites, 67 tests, clean exit — no leaked handles |
| `npm run build --workspace=apps/api` | ✅ prisma generate ×8 + `nest build` + postbuild, no TS errors |
| `prisma validate --schema prisma/core/schema.prisma` | ✅ valid |
| E2E targeted: `test/search.e2e-spec.ts` + `test/search-source.e2e-spec.ts` (real `core_db`, degraded LEXICAL asserted as designed) | ✅ 2/2 suites, **54 tests** |
| Full e2e sweep: `jest --config ./jest-e2e.json --runInBand --forceExit` | ✅ **23/25 suites, 567/604 tests** — the 2 failing suites (`hr.e2e-spec.ts`, `hr-runtime.e2e-spec.ts`) are **pre-existing** (identical failures in pre-phase logs `x-fulle2e*.log`, `c2-e2e.log`; 403s on HR organization routes — RBAC seeding, untouched by this phase) |
| `npm run test --workspace=apps/web -- --runInBand` | ✅ **104/104 suites, 1760 tests** (incl. `ai-api.spec.ts`, `search-api.spec.ts`) |
| `npm run lint` | ❌ repo-wide FAIL — 4527 errors, **all pre-existing** (see §13) |

New tests added this phase (67 in six new specs + updates to three existing):

- **resolver**: bootstrap path with no options; row → model/baseUrl/decrypted
  credential as options; env untouched; no-credential row; not memoised;
  decrypt-failure → `CONFIGURATION_ERROR` (no env fallback); withdrawn
  capability → `UNSUPPORTED_CAPABILITY`; policy → `SECURITY_POLICY_REJECTED`;
  submitted-credential skips decryption.
- **gateway**: structured result shape; effective options passed through;
  ENVIRONMENT provenance; credential absent from the result at any depth;
  **concurrency interleave with two credentials** (mandatory §28); classified
  error passthrough; wrap + safe message; resolution failure never reaches an
  adapter; BadRequest passthrough; safe failure logging; no success spam.
- **policy**: allowed external/internal/loopback table incl. `ollama` host;
  blocked table incl. `169.254.169.254`, IPv6 link-local, **v4-mapped
  link-local**, userinfo, non-http(s), malformed; no-bypass properties.
- **config service (updated)**: probe uses stored/submitted credential as a
  PARAMETER; env never written (success, throw, previously-unset); the row's
  effective model/baseUrl reach the adapter; decrypt-failure/policy failures are
  FAILURE without probing; write-time policy 400s; absent-baseUrl update leaves
  it untouched; audit unchanged.
- **OpenAI provider (updated)**: options model/baseUrl/credential override;
  dimensions negotiation follows the effective model; env fallback when an
  option is absent; provider-level concurrent credentials; CONFIGURATION_ERROR
  classification.
- **search (new)**: embedding service vector+model, latch/`beginPass`,
  wrong-width refusal; `SearchService` HYBRID arm via gateway, wrong-width →
  LEXICAL degraded, execution failure → LEXICAL degraded, lexical arm always
  runs.
- **architecture gates (new)**: business-module isolation, search-gateway-only
  wiring, adapter isolation from Prisma/business/platform, gateway isolation
  from business/concrete providers, adapters carry no actor/tenant semantics,
  `packages/ai` stays deleted and unimported.

## 13. Tests not executed + why

- **`npm run lint` cannot pass and this phase does not change that.** The api
  lint is red at baseline: 4527 `@typescript-eslint` errors across the tree
  (e.g. `users.service.ts` — 5, untouched; `ai-config.controller.spec.ts` — 6,
  untouched; `search.controller.ts` — 1, untouched). A scoped scan of the
  AI/search tree shows 44 remaining errors, **all** in pre-existing files or
  pre-existing regions of touched files. The 2 errors this phase introduced (two
  `any` annotations in the new resolver spec) were fixed; the six NEW files are
  lint-clean. Clearing the baseline lint debt is a separate effort (§47).
- **Full e2e sweep — EXECUTED.** 25 suites / 604 tests: 23 suites and 567 tests
  pass; the ONLY failures are `hr.e2e-spec.ts` and `hr-runtime.e2e-spec.ts`,
  which were already failing before this phase — the same two suites fail in
  `.tmp/x-fulle2e.log`, `.tmp/x-fulle2e2.log` and `.tmp/c2-e2e.log` (pre-phase
  runs; `x-fulle2e2` additionally failed `users-directory`, which passes now).
  The failures are 403s on HR organization routes (RBAC seeding in the e2e
  environment), a subsystem this phase does not touch. Every AI/search-related
  suite passes, including the targeted search pair.
- **Web workspace tests — EXECUTED.** 104/104 suites, 1760 tests pass (no web
  code changed; the admin AI API suite `ai-api.spec.ts` and `search-api.spec.ts`
  confirm the API contract the UI consumes is unchanged).
- **Root `npm test -- --runInBand`** — executed as its two workspace halves; the
  root script itself only chains the same two commands.
- **Environment quirk (pre-existing):** the full api jest run prints its summary
  and then hangs on open handles, requiring a kill. This predates the phase —
  historical logs in `.tmp/` (`c-full.txt`, `c1.txt`, …) show the same
  "Jest did not exit" message — and the six NEW specs exit cleanly under
  `--detectOpenHandles`, so this phase added no handle leaks.

## 14. Remaining limitations

- Baseline lint debt (4527 errors) is untouched — a future, separate cleanup.
- `EMBEDDING_DIMENSION` / `EMBEDDING_TIMEOUT_MS` remain environment-owned: there
  is no DB column, and a dimension change is a re-index concern by contract.
- The endpoint policy does not resolve DNS: a metadata-service HOSTNAME (not an
  address literal) is a network-layer (egress policy) concern, documented in the
  policy file.
- `generateEmbeddingBatch` remains adapter-only (no production consumer); it was
  not promoted to the port.
- No AI usage/latency persistence and no text-generation execution — deliberate
  (§12/§15 of the prompt); the seam exists, the capability does not.
- Historical phase reports (e.g. `PHASE_A_COMPLETION_REPORT.md`) keep their
  era-accurate statements; current-state documents
  (`docs/architecture/AI-PLATFORM.md`, this report, module comments) describe the
  new architecture.
- Docs-drift check (§38): `ARCHITECTURE.md`, `README.md`, `FOLDER_STRUCTURE.md`
  make no AI-runtime claims, and no `packages/ai` reference existed anywhere in
  docs — nothing required correction beyond this phase's own documents.

## 15. Reporting readiness

The dependency this phase exists for is now possible and guarded:

```ts
// A future ReportingModule — and NOTHING else — is all it needs:
@Module({ imports: [PlatformAIModule] })
export class ReportingModule {}

// and in a service:
constructor(@Inject(AI_GATEWAY) private readonly ai: AIGatewayContract) {}

const { output, model, metadata } = await this.ai.embed(text, {
  moduleId: 'reporting',
  correlationId,
  tenantId, // execution scope only — never a credential selector
  actorId,
});
```

What Reporting never learns: OpenAI/Azure/Anthropic/Local, API keys, base URLs,
Prisma, `AIProviderConfig`, the registry, or the capability matrix. What it gets:
a versionable contract, a structured result with provenance and latency, and a
classified error taxonomy. No Reporting (or other business) implementation was
built in this phase (§30) — only the seam, plus architecture gates that keep the
isolation true.

---

## Addendum — background verification results

(Filled after the long-running runs completed; see §12/§13.)

- **Full e2e sweep:** 25 suites / 604 tests → **23 suites, 567 tests PASS**;
  2 suites failing: `hr.e2e-spec.ts`, `hr-runtime.e2e-spec.ts` — both failing
  identically in PRE-PHASE logs (`.tmp/x-fulle2e.log`, `.tmp/x-fulle2e2.log`,
  `.tmp/c2-e2e.log`), 403s on HR organization routes. No AI/search suite fails;
  the historical run even failed one additional suite (`users-directory`) that
  passes now.
- **Web unit tests:** 104/104 suites, **1760 tests PASS** (includes the admin AI
  API suite).







