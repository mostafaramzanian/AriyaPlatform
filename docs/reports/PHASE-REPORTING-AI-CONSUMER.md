# Phase Report — Reporting AI Consumer Contract

> Implementation commit: **`fec78be`** — `feat(reporting): integrate ai gateway contract`.
> Baseline before this phase: `d5a8973`.

## 1. What this phase is

The first AI consumer seam **inside the Reporting bounded context**, built on the
completed AI Architecture Hardening + AI Gateway foundation (`f68a3a5`,
`d5a8973`). Reporting now consumes the platform AI infrastructure through one
contract — and knows nothing else about it. No provider implementation, no
provider configuration persistence and no new AI capability was built.

## 2. Pre-flight findings (evidence)

- **No Reporting bounded context existed.** `apps/api/src/modules/reporting/`
  did not exist; `git log --all -- '*reporting*'` plus repository-wide greps for
  `ReportingModule` / `modules/reporting` found no module, schema, entity, DTO,
  service, route or permission anywhere. "Reporting" appeared only as
  forward-looking comments in the AI platform files. The prior phase's report
  (`PHASE-AI-ARCHITECTURE-HARDENING.md` §15) pre-established this phase's
  expected shape:

  ```ts
  @Module({ imports: [PlatformAIModule] })
  export class ReportingModule {}
  ```
- **The gateway contract (unchanged this phase):** `AI_GATEWAY = 'AIGateway'`;
  `AIGatewayContract { embed(input, context?) → AIEmbeddingExecutionResult }`.
  `PlatformAIModule` exports ONLY that token.
- **Confirmed capability availability:** EMBEDDING is the only implemented
  capability in the registry matrix (OPENAI ✅; TEXT_GENERATION ❌ everywhere;
  Azure/Anthropic/Local are matrix-false stubs). The gateway has no
  text-generation method, so no summarization/explanation feature could be
  honestly built in this phase even if a domain contract had existed.
- **Existing consumers:** `SearchService` (`src/search`) and
  `SearchEmbeddingService` (`src/platform/search-source`), both through
  `AI_GATEWAY`; the existing gate "business modules never import the AI
  runtime/configuration" already covered `src/modules/**`.

## 3. Contract decision

Reporting consumes exactly one thing from the platform: **`AI_GATEWAY`, typed
`AIGatewayContract`, obtained by importing `PlatformAIModule`.** Because the
pre-flight found **no Reporting domain contract of any kind**, no business AI
use case was implemented — the seam is the deliverable, and this report records
that explicitly rather than fabricating a feature (phase brief §4).

```text
ReportingModule (composition root)
      ↓  imports: [PlatformAIModule]
AI_GATEWAY token → AIGatewayContract (embed only)
      ↓
Platform AI runtime (resolution, credentials, capability matrix, providers)
```

What Reporting gets: a versionable contract, a structured result
(`output`/`model`/`metadata`) and a classified error taxonomy. What it can
never get from this import: a provider class, a credential, a base URL,
`AIProviderConfig`, Prisma, the registry or the capability matrix.

## 4. Files changed

| File | Architectural purpose |
| ---- | -------------------- |
| `apps/api/src/modules/reporting/reporting.module.ts` | The bounded context's composition root. Its ONLY import is `PlatformAIModule`; the doc comment fixes the boundary rules and the capability-honesty statement. |
| `apps/api/src/modules/reporting/reporting.module.spec.ts` | Wiring tests: the token resolves through the real platform graph (two socket-opening leaves stubbed, `platform-identity.module.spec.ts` technique), a negative control proves the seam is load-bearing, the export surface ends at the token, and the module is registered in the combined composition root. |
| `apps/api/src/ai/ai-boundaries.spec.ts` | Five new executable gates (§6). |
| `apps/api/src/app.module.ts` | Registers `ReportingModule` in the COMBINED root only — like the other business bounded contexts, deliberately not in `CoreAppModule`. |
| `docs/reports/PHASE-REPORTING-AI-CONSUMER.md` | This report. |

## 5. Boundary statement

```text
Reporting consumes AI only through AI_GATEWAY.
Reporting does not own provider configuration.
Reporting does not resolve providers.
Reporting does not hold credentials.
Reporting does not import Prisma AI configuration.
Platform AI owns provider/runtime concerns.
```

No Reporting controller exists yet; when one does, it may not accept provider
names, credentials, base URLs or configuration identifiers — the guards in §6
make the import-level version of that rule executable today.

## 6. Architecture enforcement (all in `src/ai/ai-boundaries.spec.ts`)

1. **(pre-existing, covers Reporting)** business modules never import
   `src/ai/**` — the runtime, configuration, registry and every provider
   adapter.
2. **NEW — reporting cannot reach AI configuration, providers, credentials or
   persistence:** AST import audit over `src/modules/reporting/**` (spec files
   excluded — a wiring spec may stub `PrismaService`/`NotificationPublisher`,
   exactly as `platform-identity.module.spec.ts` does) forbidding `src/ai/**`,
   `src/database/**`, `src/generated/**`, `CryptoService`, and provider SDK
   specifiers (`openai`, `@azure/openai`, `@anthropic-ai/sdk`, `ollama`).
3. **NEW — reporting reads no environment variables:** AST-level
   `process.env` access is forbidden in Reporting sources — credentials and
   provider configuration are platform concerns.
4. **NEW — the seam cannot rot:** `reporting.module.ts` must contain and
   actually import `PlatformAIModule` (text check + syntax-tree check).
5. **NEW — `PlatformAIModule` exports `AI_GATEWAY` and nothing else:** the
   claim the module documentation makes, so the seam stays one token wide.
6. **NEW — capability honesty:** `AIGatewayContract` declares exactly
   `['embed']`; adding a contract method ahead of a real implementation fails
   the gate on the way in.

## 7. Security, tenant and data boundaries

- **No secret material is reachable:** the gates in §6 remove the credential
  helper, Core persistence (where `AIProviderConfig` and its
  ciphertext/IV/auth tag live), generated clients, provider SDKs and
  `process.env` from Reporting's import surface. The gateway result carries no
  credential at any depth.
- **No business AI call sites exist yet**, hence no prompt/payload
  construction, no output validation surface and no cross-tenant data path to
  audit — the future call site is where phase-brief §13–§16 apply, and the
  module comment states those rules.
- **Reporting never becomes a data-access mechanism for the AI platform** — it
  injects a token, and the token's contract has one method: `embed(string)`.
- Existing Search behavior, embedding width contract, effective-model tracking
  and AI configuration behavior were untouched (verified in §8).

## 8. Verification (every command executed)

| Check | Command (from `apps/api` unless noted) | Result |
| ---- | ---- | ---- |
| Reporting unit tests | `jest src/modules/reporting --silent` | **PASS** — 1 suite, 4 tests |
| AI boundary gates | `jest src/ai/ai-boundaries.spec.ts --silent` | **PASS** — 1 suite, 12 tests |
| Architecture + runtime policy | `jest src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts --silent` | **PASS** — 2 suites, 57 tests |
| Typecheck | `tsc --noEmit -p tsconfig.json` | **PASS** — exit 0, no diagnostics |
| Full API unit suite | `jest --silent` (full run) | **PASS** — 248 suites, 4046 tests, 49.5 s |
| Open handles (new spec) | `jest src/modules/reporting --detectOpenHandles` | **PASS** — 4 tests, no handles reported |
| API build | `nest build` (uses `tsconfig.build.json`) | **PASS** — `dist/main.js` emitted, no diagnostics |
| Boot + Search e2e (stack running) | `jest --config ./jest-e2e.json --runInBand test/app.e2e-spec.ts test/search.e2e-spec.ts` | **PASS** — 2 suites, 92 tests, 19.6 s (`app.e2e` boots the real `AppModule`, i.e. the `ReportingModule` registration; `search.e2e` exercises the search degrade path through the same gateway) |
| Formatting | `prettier --check`/content-diff on changed files | Changed files have **0 content deviations**; CRLF `--check` warnings are repo-wide baseline (`core.autocrlf=true`, untouched files warn identically). 4 pre-existing content drifts in `ai-boundaries.spec.ts` predate this phase and were left untouched. |

Pre-existing conditions, recorded not hidden: the full unit run prints the
"worker process failed to exit gracefully" warning that also appears in
historical logs (`.tmp/g-full.txt`, `.tmp/p-closure-all*.txt`); the known
pre-existing HR e2e failures (`hr.e2e-spec.ts`, `hr-runtime.e2e-spec.ts`, per
the hardening report) were **not** part of this run.

## 9. Deliberately NOT implemented

No dashboards, report builder, scheduled reporting, AI billing, token
accounting, provider onboarding, Azure/Anthropic/Local/text-generation
implementation, decision support, agents, RAG, or new AI persistence. No
Gateway contract change — the platform contract did not materially change, so
`docs/architecture/AI-PLATFORM.md` was not modified (§11's Reporting entry now
describes reality). No Reporting-local AI port: with no use case, phase-brief §8
forbids indirection for its own sake.

## 10. Remaining gaps

- **No business AI behavior exists**, because no Reporting domain contract
  exists. The first real Reporting use case will consume `embed` for
  semantic/similarity assistance; anything needing generated text stays blocked
  until TEXT_GENERATION has a real implementation behind a new gateway method
  (and the §6 capability-honesty gate is updated deliberately in that phase).
- When the first Reporting service lands, phase-brief §13–§16 rules
  (authorized-data projection into prompts, output validation, degradation
  policy) become testable and must land with it.




