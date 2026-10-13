# AI Platform Architecture

> Phase AI-ARCH-HARDENING. This document describes the **current** AI platform
> boundary of Aria ERP: what is implemented, what is refused, and which seam a
> future consumer (Reporting, AI Decision Support) is meant to use. Nothing in
> this file describes an aspirational capability — see
> `docs/reports/PHASE-AI-ARCHITECTURE-HARDENING.md` for the phase report,
> including pre-flight evidence and executed verification.

## 1. Supported capabilities (the honest list)

The **registry matrix** (`apps/api/src/ai/ai-provider.registry.ts`) is the single
canonical truth for capability support. It is asserted cell-by-cell in
`ai-provider.registry.spec.ts`, and the admin UI receives it from the backend —
no second copy exists anywhere.

| Provider       | EMBEDDING | TEXT_GENERATION | Notes                                                      |
| -------------- | --------- | --------------- | ---------------------------------------------------------- |
| `OPENAI`       | ✅        | ❌              | The only working capability in the whole matrix today.     |
| `AZURE_OPENAI` | ❌        | ❌              | Stub class; not implemented.                               |
| `ANTHROPIC`    | ❌        | ❌              | Vendor ships no embedding model; never implementable here. |
| `LOCAL`        | ❌        | ❌              | Stub class; not implemented.                               |

Capability support is **declared, never inferred** from the presence of a method.
Every adapter structurally satisfies the composite `IAIProvider` interface, and
three of the four classes throw on every call — the matrix, not the type system,
is the gate.

**Explicitly NOT implemented anywhere in this repository:** text generation,
chat completions, tool calling, vision, reranking, AI billing, AI usage
persistence, per-tenant credentials. The gateway exposes no method for them;
the interface contracts exist (`TextGenerationProvider`,
`ChatCompletionProvider`) so the vocabulary is in place, and they will gain
methods only when a real implementation does.

## 2. Ownership map

```
AIConfigService      (src/ai/ai-config.service.ts)
  → CONTROL PLANE: config CRUD, audit, connection test, admin HTTP surface.
    No execution, no provider instances handed out.

AIProviderRegistry   (src/ai/ai-provider.registry.ts)
  → provider identity, availability, capability matrix, adapter resolution.
    No credential, no database, no audit, no HTTP.

AIRuntimeResolver    (src/ai/ai-runtime.resolver.ts)
  → turns a stored row (or the environment bootstrap) into an EFFECTIVE
    execution configuration: model, baseUrl, decrypted credential, adapter.
    Owns the endpoint policy check and the "broken config is a hard failure"
    rule. Never caches, never mutates `process.env`.

AIGateway            (src/platform/ai/ai-gateway.service.ts)
  → the ONLY execution seam consumers use. Resolves, invokes, classifies
    errors, logs safely, returns a STRUCTURED result.

PlatformAIModule     (src/platform/ai/platform-ai.module.ts)
  → binds the gateway over AIModule and exports ONLY the `AI_GATEWAY` token.
```

Dependency direction (enforced by `src/ai/ai-boundaries.spec.ts`):

```
Reporting / Search / future consumers
      ↓  (AI_GATEWAY contract only)
PlatformAIModule → AIGateway
      ↓
AIRuntimeResolver → AIProviderRegistry
      ↓
provider adapters (OpenAIProvider, …)
```

No business module imports `src/ai/**`. No provider adapter imports Prisma,
persistence, business modules, or the platform layer. The gateway imports
neither concrete providers nor business code.

## 3. Runtime resolution flow

```
consumer calls AI_GATEWAY.embed(input, context)
      ↓
AIGateway: AIRuntimeResolver.resolveEmbedding()
      ↓
  an enabled DEFAULT AIProviderConfig row for EMBEDDING exists?
      ├─ NO  → ENVIRONMENT bootstrap:
      │        adapter = OpenAI (env-configured 49J-A path),
      │        executionOptions = undefined, model = adapter's env contract.
      └─ YES → DATABASE configuration:
               registry.supports() re-checked   → else UNSUPPORTED_CAPABILITY
               credential decrypted             → else CONFIGURATION_ERROR
               baseUrl passes endpoint policy   → else SECURITY_POLICY_REJECTED
               executionOptions = { model, baseUrl, credential }
      ↓
adapter.generateEmbedding(input, executionOptions)   ← explicit parameters
      ↓
AIExecutionResult { capability, provider, model, output,
                    metadata: { latencyMs, configurationSource, correlationId? } }
```

- **`modelName` and `baseUrl` are runtime-effective**: the row's values are passed
  to the adapter per call; the UI cannot display one model while another runs.
- **Resolution is not memoised**: a default switch takes effect on the next call,
  without restart (§40). No credential is held in instance state.
- **No migration was required**: the schema already carried `modelName`,
  `baseUrl` and the credential envelope; only dimension/timeout remain
  environment-owned (they are re-index concerns, not config).

## 4. Credential security model

```
encrypted at rest   — AES-256-GCM envelope (ciphertext/iv/authTag) in Core DB,
                      all-or-nothing CHECK constraint.
never returned      — single masked projection (`hasCredential`,
                      `credentialUpdatedAt`); no route, role or debug flag
                      emits the key.
never logged        — provider logs, gateway logs and audit payloads are
                      closed field sets; specs assert absence.
never in a URL      — endpoint policy rejects userinfo; connection test is
                      POST with the credential in the body, never a query.
per-call, not global — the credential is an EXPLICIT parameter to the adapter.
                      `process.env` is NEVER mutated per request (§6), which is
                      what makes concurrent executions with different
                      credentials safe (concurrency test, §28).
```

The credential lives inside the execution boundary only: resolver → gateway →
adapter call frame. It is absent from `AIExecutionResult`, from audit rows, and
from every log line.

## 5. Fallback rules (§14)

| Situation                                     | Behaviour                                 |
| --------------------------------------------- | ----------------------------------------- |
| No configured row, env key present            | **ENVIRONMENT bootstrap** (49J-A, unchanged) |
| No configured row, no env key                 | `CONFIGURATION_ERROR`, no upstream call   |
| Row exists, credential decrypts               | Row's model/baseUrl/credential            |
| Row exists, credential decrypt fails          | **Hard failure** — never env              |
| Row exists, provider lost the capability      | **Hard failure** — never env              |
| Row exists, endpoint violates policy          | **Hard failure** — never env              |
| Row exists, stores no credential (OpenAI)     | Env key applies downstream (documented)   |

The principle: **environment is a bootstrap for an empty configuration, never a
silent repair for a broken one.**

## 6. AI gateway contract

```ts
// apps/api/src/platform/ai/ai-gateway.contract.ts
export const AI_GATEWAY = 'AIGateway';

interface AIGatewayContract {
  embed(input: string, context?: AIExecutionContext): Promise<AIEmbeddingExecutionResult>;
}
// AIExecutionContext  = { correlationId?, tenantId?, actorId?, moduleId? }
// AIEmbeddingExecutionResult = { capability: 'EMBEDDING', provider, model,
//                                 output: number[], metadata: { latencyMs,
//                                 configurationSource, correlationId? } }
```

- Consumers inject the **token**, typed as the contract — never the class.
- `configurationSource` is config provenance (`DATABASE` | `ENVIRONMENT`), not
  credential state or topology.
- The result is **structured from day one** so a future text-generation method
  slots in without reshaping consumers; no JSON parser exists yet because no
  consumer exists yet (§32).
- Errors are classified (`AIExecutionError` codes): `CONFIGURATION_ERROR`,
  `UNSUPPORTED_CAPABILITY`, `SECURITY_POLICY_REJECTED`, `UPSTREAM_UNAVAILABLE`,
  `UPSTREAM_TIMEOUT`, `INVALID_PROVIDER_RESPONSE`.

### Business execution scope vs configuration scope

Provider configuration is **platform-global** (no tenant column — unchanged).
The optional `AIExecutionContext` carries business execution identity
(tenant/actor/module/correlation) for traceability and logging only; it is never
forwarded to an adapter, and passing a `tenantId` can never select a credential.

## 7. Search integration

```
SearchService.embedQuery       → AI_GATEWAY (query vector, { moduleId: 'search' })
SearchEmbeddingService (index) → AI_GATEWAY (document vector, { moduleId: 'search' })
SearchDocumentWriter           → stores vector + the EFFECTIVE model tag
```

- Semantic arm runs when the vector has exactly `EMBEDDING_DIMENSIONS` (1536)
  finite floats; anything else **degrades to lexical** (`mode: LEXICAL`,
  `degraded: true`) and the reason never reaches the client.
- Index-time failure latches the write pass to lexical-only (one failed attempt
  per pass, not per row); `beginPass()` resets it.
- The `embeddingModel` column records the model the gateway reported for THAT
  vector — a re-index concern stays visible instead of silent.
- Search imports nothing from `src/ai`; the boundary spec enforces it.

## 8. Endpoint policy (§18)

`src/ai/ai-endpoint.policy.ts`, a pure classifier run at **write time**
(create/update → 400) and at **resolution time** (hard failure):

- Allowed: http(s) hostnames (any — names are never resolved, so there is no
  DNS-rebinding theatre), and public/private/loopback address literals uniformly.
- Blocked: non-http(s) schemes, URLs with embedded credentials, and address
  literals that can never be a deliberate AI endpoint — unspecified
  (`0.0.0.0`, `::`), link-local (`169.254/16`, `fe80::/10`, incl. v4-mapped
  forms — the cloud metadata service lives there), multicast/reserved.
- There is **no special-case branch** for `localhost`, `127.0.0.1`, `10.x` or
  IPv6 loopback: everything passes through the same classification, allowed
  uniformly — which is exactly why local LLM hostnames keep working and nothing
  can skip validation by looking familiar.

## 9. RBAC & audit (unchanged)

- `admin.ai.read` → GET routes (masked configuration + capability matrix).
- `admin.ai.manage` → create/update/delete/enable/disable/default/**connection
  test**. The test is write-level: it spends money and accepts an unsaved key.
- Audit actions: `AI_PROVIDER_CREATED / UPDATED / ENABLED / DISABLED /
  SELECTED / DELETED / CONNECTION_TESTED`, payloads carry metadata only
  (`provider`, `capability`, `modelName`, `result`, `changedFields`,
  `hasCredential`-style facts) — never the credential, ciphertext, or upstream
  bodies.

## 10. Known unsupported / deferred

- Azure OpenAI, Anthropic, Local LLM: stubs, matrix-false, no fabricated results.
- Text generation: unsupported everywhere; the instance-handing helpers
  (`getEmbeddingProvider()` / `getTextProvider()` / `generateEmbedding()` on the
  config service) were removed rather than kept lying about it.
- AI usage/latency persistence: the gateway returns `latencyMs` and provenance
  per execution — that is the extension point; no table, no consumer yet (§12).
- Multiple live credentials: the concurrency-safe parameter path removes the
  architectural blocker; per-request multi-credential execution is available the
  day a consumer needs it.

## 11. Future extension points

1. **Reporting** depends on `PlatformAIModule` + `AI_GATEWAY` only — it will not
   know OpenAI, base URLs, Prisma, or `AIProviderConfig`.
2. **Text generation** arrives as a new gateway method over the existing
   `TextGenerationProvider` contract + a new matrix cell — never as a matrix
   edit without an implementation.
3. **AI Decision Support** composes on Reporting's semantic layer and the
   gateway; no domain capability is pre-built.
4. **Execution telemetry** extends `AIExecutionMetadata` / a future sink without
   changing the consumer-facing result shape.

## 12. File index

| Path                                                         | Role                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| `apps/api/src/ai/i-ai-provider.ts`                           | Capability contracts + embedding options   |
| `apps/api/src/ai/ai-provider.registry.ts`                    | Canonical capability matrix + adapter resolution |
| `apps/api/src/ai/ai-config.service.ts`                       | Configuration control plane                |
| `apps/api/src/ai/ai-runtime.resolver.ts`                     | Effective-config resolution                |
| `apps/api/src/ai/ai-endpoint.policy.ts`                      | baseUrl security policy                    |
| `apps/api/src/ai/ai-errors.ts`                               | Error taxonomy                             |
| `apps/api/src/ai/openai.provider.ts`                         | The one real adapter (embeddings)          |
| `apps/api/src/ai/{azure-openai,claude,local-llm}.provider.ts` | Stub adapters                             |
| `apps/api/src/ai/ai.module.ts`                               | Control-plane DI module                    |
| `apps/api/src/ai/ai-boundaries.spec.ts`                      | Architecture gates                         |
| `apps/api/src/platform/ai/ai-gateway.contract.ts`            | Consumer contract (`AI_GATEWAY`)           |
| `apps/api/src/platform/ai/ai-gateway.service.ts`             | Gateway implementation                     |
| `apps/api/src/platform/ai/platform-ai.module.ts`             | Platform binding (exports the token)       |


