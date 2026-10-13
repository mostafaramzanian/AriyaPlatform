import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  AIProviderRegistry,
  type AICapabilityValue,
  type AIProviderKeyValue,
} from './ai-provider.registry';
import { OpenAIProvider } from './openai.provider';
import { AzureOpenAIProvider } from './azure-openai.provider';
import { ClaudeProvider } from './claude.provider';
import { LocalLLMProvider } from './local-llm.provider';

/**
 * Phase 49J-0 unit coverage for the provider registry.
 *
 * The registry is a small class carrying one load-bearing piece of data — the
 * capability matrix — and the whole point of this file is that the matrix cannot
 * drift silently. Every cell is asserted individually rather than by comparing
 * against a copy of the same table, because a spec that re-declares the table
 * proves only that two copies agree.
 *
 * What is proven here:
 *  - all four keys resolve to the FOUR DISTINCT DI singletons, not to new instances;
 *  - the matrix, cell by cell: exactly one true cell exists today (OPENAI/EMBEDDING);
 *  - `supports` answers from the matrix and NOT from method presence — the three
 *    stub classes all have `generateEmbedding`, so a presence check would report
 *    them capable;
 *  - Anthropic's embedding refusal is categorically different (vendor has no such
 *    model) and says so, so the UI can explain a permanently-disabled option;
 *  - `list()` and `find()` hand back COPIES, so a caller cannot mutate the
 *    module-level matrix through the returned object;
 *  - an unknown key is a NotFoundException from `resolve` and a soft
 *    undefined/false from `find`/`supports`.
 */

describe('AIProviderRegistry', () => {
  let registry: AIProviderRegistry;
  let openai: OpenAIProvider;
  let azure: AzureOpenAIProvider;
  let claude: ClaudeProvider;
  let local: LocalLLMProvider;

  /**
   * Stubs, not real providers: constructing the real ones reads env and builds
   * HTTP clients, and this class never calls a provider method — it only hands the
   * instance back. Identity is what matters, so each stub is distinguishable.
   */
  const stub = (name: string) => ({
    __name: name,
    generateText: jest.fn(),
    generateEmbedding: jest.fn(),
    generateCompletion: jest.fn(),
    getEmbeddingContract: jest.fn(() => ({ model: 'stub', dimension: 1536 })),
  });

  const ALL_KEYS: AIProviderKeyValue[] = ['OPENAI', 'AZURE_OPENAI', 'ANTHROPIC', 'LOCAL'];
  const ALL_CAPABILITIES: AICapabilityValue[] = ['TEXT_GENERATION', 'EMBEDDING'];

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AIProviderRegistry,
        { provide: OpenAIProvider, useValue: stub('openai') },
        { provide: AzureOpenAIProvider, useValue: stub('azure') },
        { provide: ClaudeProvider, useValue: stub('claude') },
        { provide: LocalLLMProvider, useValue: stub('local') },
      ],
    }).compile();

    registry = moduleRef.get(AIProviderRegistry);
    openai = moduleRef.get(OpenAIProvider);
    azure = moduleRef.get(AzureOpenAIProvider);
    claude = moduleRef.get(ClaudeProvider);
    local = moduleRef.get(LocalLLMProvider);
  });

  describe('resolve', () => {
    it('returns the injected singleton for each of the four keys', () => {
      // `toBe`, not `toEqual`: the contract is that the registry hands back the DI
      // instance. `new OpenAIProvider()` would satisfy toEqual and be a different
      // object with its own env snapshot and its own logger.
      expect(registry.resolve('OPENAI')).toBe(openai);
      expect(registry.resolve('AZURE_OPENAI')).toBe(azure);
      expect(registry.resolve('ANTHROPIC')).toBe(claude);
      expect(registry.resolve('LOCAL')).toBe(local);
    });

    it('maps ANTHROPIC to ClaudeProvider, whose name does not match its key', () => {
      // The one place where the key and the class name diverge, so the mapping is
      // asserted on its own rather than only inside the loop above.
      expect(registry.resolve('ANTHROPIC')).toBe(claude);
      expect(registry.resolve('ANTHROPIC')).not.toBe(openai);
    });

    it('returns four DISTINCT instances across the four keys', () => {
      const resolved = ALL_KEYS.map((key) => registry.resolve(key));
      expect(new Set(resolved).size).toBe(4);
    });

    it('is stable across calls', () => {
      expect(registry.resolve('OPENAI')).toBe(registry.resolve('OPENAI'));
    });

    it('throws NotFoundException for an unknown key rather than returning undefined', () => {
      // The callers (runtime resolution, connection test) would otherwise have to
      // re-check, and a silent undefined becomes a TypeError deeper in the stack.
      expect(() => registry.resolve('MISTRAL')).toThrow(NotFoundException);
      expect(() => registry.resolve('')).toThrow(NotFoundException);
    });

    it('is case-sensitive: a lowercase key is unknown', () => {
      // Stored values come from the Postgres enum, which is upper-case. Accepting
      // 'openai' would mean the registry is more permissive than the column.
      expect(() => registry.resolve('openai')).toThrow(NotFoundException);
    });

    it('names the offending key in the error so a schema/registry divergence is diagnosable', () => {
      expect(() => registry.resolve('GEMINI')).toThrow(/GEMINI/);
    });
  });

  describe('capability matrix', () => {
    // ── The one true cell ────────────────────────────────────────────────────
    it('OPENAI supports EMBEDDING', () => {
      expect(registry.supports('OPENAI', 'EMBEDDING')).toBe(true);
    });

    it('OPENAI does NOT support TEXT_GENERATION', () => {
      // OpenAIProvider.generateText exists and throws 'not implemented in Phase A'.
      expect(registry.supports('OPENAI', 'TEXT_GENERATION')).toBe(false);
    });

    // ── Every remaining cell is false ────────────────────────────────────────
    it('AZURE_OPENAI supports neither capability', () => {
      expect(registry.supports('AZURE_OPENAI', 'EMBEDDING')).toBe(false);
      expect(registry.supports('AZURE_OPENAI', 'TEXT_GENERATION')).toBe(false);
    });

    it('ANTHROPIC supports neither capability', () => {
      expect(registry.supports('ANTHROPIC', 'EMBEDDING')).toBe(false);
      expect(registry.supports('ANTHROPIC', 'TEXT_GENERATION')).toBe(false);
    });

    it('LOCAL supports neither capability', () => {
      expect(registry.supports('LOCAL', 'EMBEDDING')).toBe(false);
      expect(registry.supports('LOCAL', 'TEXT_GENERATION')).toBe(false);
    });

    it('has EXACTLY ONE supported cell in the whole matrix', () => {
      // The guard against a future edit quietly marking a stub as capable: adding a
      // second true cell fails here even if every other test still passes.
      const supported = ALL_KEYS.flatMap((key) =>
        ALL_CAPABILITIES.filter((capability) => registry.supports(key, capability)).map(
          (capability) => `${key}/${capability}`
        )
      );

      expect(supported).toEqual(['OPENAI/EMBEDDING']);
    });

    it('does not infer support from method presence', () => {
      // All four stubs expose every IAIProvider method (now four: the embedding
      // capability contract added `getEmbeddingContract`), exactly like the real
      // classes. If `supports` probed the instance, every cell above would be true.
      for (const key of ALL_KEYS) {
        const instance = registry.resolve(key);
        expect(typeof instance.generateEmbedding).toBe('function');
        expect(typeof instance.generateText).toBe('function');
        expect(typeof instance.getEmbeddingContract).toBe('function');
      }

      expect(registry.supports('LOCAL', 'EMBEDDING')).toBe(false);
    });

    it('returns false for an unknown key instead of throwing', () => {
      // `supports` is called on a stored row's provider string during resolution,
      // where a throw would turn a stale row into a 500. `resolve` is the throwing
      // one; this is the soft probe.
      expect(registry.supports('MISTRAL', 'EMBEDDING')).toBe(false);
      expect(registry.supports('', 'EMBEDDING')).toBe(false);
    });
  });

  describe('unsupportedReason', () => {
    it('explains every unsupported cell, so no disabled option is unexplained', () => {
      for (const key of ALL_KEYS) {
        for (const capability of ALL_CAPABILITIES) {
          if (registry.supports(key, capability)) continue;

          const reason = registry.unsupportedReason(key, capability);
          expect(typeof reason).toBe('string');
          expect((reason as string).trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('gives no reason for a SUPPORTED cell', () => {
      // A reason attached to a working capability would render as a warning next to
      // an option that works.
      expect(registry.unsupportedReason('OPENAI', 'EMBEDDING')).toBeUndefined();
    });

    it("states that Anthropic embedding will NEVER be available, not merely 'not yet'", () => {
      const reason = registry.unsupportedReason('ANTHROPIC', 'EMBEDDING') ?? '';

      // Anthropic publishes no embedding model at all, so this cell cannot become
      // true by writing code here. The wording has to carry that distinction.
      expect(reason).toContain('هرگز');
      expect(reason).not.toContain('در این نسخه');
    });

    it('describes the other stubs as not-implemented-in-this-version instead', () => {
      // The contrast with the Anthropic case: these are implementable.
      expect(registry.unsupportedReason('AZURE_OPENAI', 'EMBEDDING')).toContain('در این نسخه');
      expect(registry.unsupportedReason('LOCAL', 'EMBEDDING')).toContain('در این نسخه');
      expect(registry.unsupportedReason('OPENAI', 'TEXT_GENERATION')).toContain('در این نسخه');
    });

    it('returns undefined for an unknown key', () => {
      expect(registry.unsupportedReason('MISTRAL', 'EMBEDDING')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns exactly the four implemented providers, in matrix order', () => {
      expect(registry.list().map((d) => d.key)).toEqual(ALL_KEYS);
    });

    it('carries a non-empty Persian display name for each', () => {
      for (const descriptor of registry.list()) {
        expect(descriptor.displayName.trim().length).toBeGreaterThan(0);
      }
    });

    it('reports capabilities consistently with supports()', () => {
      // The UI reads `list()`; the service gates writes with `supports()`. If these
      // two disagreed, the UI would offer a capability the API refuses to save.
      for (const descriptor of registry.list()) {
        for (const capability of ALL_CAPABILITIES) {
          expect(descriptor.capabilities.includes(capability)).toBe(
            registry.supports(descriptor.key, capability)
          );
        }
      }
    });

    it('hands back copies: mutating the result cannot corrupt the matrix', () => {
      // The descriptors live in a module-level const shared by every request. A
      // caller pushing onto the returned array would otherwise grant a capability
      // process-wide.
      const first = registry.list();
      first[0].capabilities.push('TEXT_GENERATION');
      first[0].unsupportedReason.EMBEDDING = 'tampered';
      first[0].displayName = 'tampered';

      const second = registry.list();
      expect(second[0].capabilities).toEqual(['EMBEDDING']);
      expect(second[0].displayName).toBe('OpenAI');
      expect(registry.supports('OPENAI', 'TEXT_GENERATION')).toBe(false);
      expect(registry.unsupportedReason('OPENAI', 'EMBEDDING')).toBeUndefined();
    });

    it('returns a fresh array object per call', () => {
      expect(registry.list()).not.toBe(registry.list());
    });
  });

  describe('find', () => {
    it('returns the descriptor for a known key', () => {
      const descriptor = registry.find('OPENAI');
      expect(descriptor?.key).toBe('OPENAI');
      expect(descriptor?.capabilities).toEqual(['EMBEDDING']);
    });

    it('returns undefined for an unknown key rather than throwing', () => {
      // The service uses this as its "is this a real provider" check before
      // reporting a 400, so it must not throw.
      expect(registry.find('MISTRAL')).toBeUndefined();
      expect(registry.find('')).toBeUndefined();
    });

    it('is not fooled by inherited Object properties', () => {
      // `DESCRIPTORS[key]` on a plain object literal resolves 'constructor' and
      // 'toString' through the prototype chain; a truthy hit there would make
      // `find('constructor')` return a function and `supports` blow up on
      // `.capabilities`.
      expect(registry.find('constructor')).toBeUndefined();
      expect(registry.find('toString')).toBeUndefined();
      expect(registry.supports('constructor', 'EMBEDDING')).toBe(false);
      expect(registry.unsupportedReason('toString', 'EMBEDDING')).toBeUndefined();
    });

    it('hands back a copy', () => {
      const found = registry.find('LOCAL');
      found!.capabilities.push('EMBEDDING');

      expect(registry.find('LOCAL')?.capabilities).toEqual([]);
      expect(registry.supports('LOCAL', 'EMBEDDING')).toBe(false);
    });
  });
});
