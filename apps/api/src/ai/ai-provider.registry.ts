import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IAIProvider } from './i-ai-provider';
import { OpenAIProvider } from './openai.provider';
import { AzureOpenAIProvider } from './azure-openai.provider';
import { ClaudeProvider } from './claude.provider';
import { LocalLLMProvider } from './local-llm.provider';

/**
 * Phase 49J-0: the registry that turns a stored `AIProviderKey` into an instance.
 *
 * FOUR KEYS, BECAUSE THERE ARE FOUR IMPLEMENTATIONS. `src/ai` contains
 * OpenAIProvider, AzureOpenAIProvider, ClaudeProvider and LocalLLMProvider —
 * nothing else. A fifth entry (Mistral, Gemini, Cohere…) was considered and
 * dropped: registering a key with no class behind it would let an administrator
 * save a configuration the registry cannot resolve, converting a successful save
 * into a 500 the first time an embedding is requested. The enum in the Prisma
 * schema has the same four members for the same reason.
 *
 * CAPABILITY SUPPORT IS DECLARED, NOT GUESSED. `supports()` answers from the map
 * below rather than by probing the instance, because every one of these classes
 * satisfies `IAIProvider` structurally — all three methods exist on all four —
 * while three of them are Phase-A stubs that throw. Asking "does the method
 * exist" would therefore report every provider as fully capable. The map records
 * what actually WORKS:
 *
 *   OPENAI       EMBEDDING ✅   TEXT_GENERATION ❌ (generateText/generateCompletion
 *                               both throw 'not implemented in Phase A')
 *   AZURE_OPENAI EMBEDDING ❌   TEXT_GENERATION ❌ (whole class is a stub)
 *   ANTHROPIC    EMBEDDING ❌   TEXT_GENERATION ❌ — and embedding is not merely
 *                               unimplemented but ABSENT FROM THE VENDOR: Anthropic
 *                               ships no embedding model, so this cell can never
 *                               become ✅ by writing code here.
 *   LOCAL        EMBEDDING ❌   TEXT_GENERATION ❌ (whole class is a stub)
 *
 * The admin UI reads this map, so it cannot offer a capability that would throw.
 */

/** The four provider keys, matching the `AIProviderKey` enum in prisma/core/schema.prisma. */
export type AIProviderKeyValue = 'OPENAI' | 'AZURE_OPENAI' | 'ANTHROPIC' | 'LOCAL';

/** Matching the `AICapability` enum. */
export type AICapabilityValue = 'TEXT_GENERATION' | 'EMBEDDING';

export interface AIProviderDescriptor {
  key: AIProviderKeyValue;
  /** Operator-facing label. Persian, because the admin UI is Persian and RTL. */
  displayName: string;
  /** Capabilities that genuinely work today. */
  capabilities: AICapabilityValue[];
  /**
   * Why an unsupported capability is unsupported, so the UI can explain a
   * disabled option instead of silently hiding it.
   */
  unsupportedReason: Partial<Record<AICapabilityValue, string>>;
}

/**
 * The capability matrix. Hand-written and audited against the four classes; the
 * accompanying spec asserts each cell so it cannot drift silently.
 */
const DESCRIPTORS: Record<AIProviderKeyValue, AIProviderDescriptor> = {
  OPENAI: {
    key: 'OPENAI',
    displayName: 'OpenAI',
    // The ONLY working capability in the whole matrix today.
    capabilities: ['EMBEDDING'],
    unsupportedReason: {
      TEXT_GENERATION: 'تولید متن برای OpenAI در این نسخه پیاده‌سازی نشده است.',
    },
  },
  AZURE_OPENAI: {
    key: 'AZURE_OPENAI',
    displayName: 'Azure OpenAI',
    capabilities: [],
    unsupportedReason: {
      EMBEDDING: 'ارائه‌دهنده Azure OpenAI در این نسخه پیاده‌سازی نشده است.',
      TEXT_GENERATION: 'ارائه‌دهنده Azure OpenAI در این نسخه پیاده‌سازی نشده است.',
    },
  },
  ANTHROPIC: {
    key: 'ANTHROPIC',
    displayName: 'Anthropic Claude',
    capabilities: [],
    unsupportedReason: {
      // Categorically different from the others: no amount of implementation work
      // makes this true, because Anthropic publishes no embedding model.
      EMBEDDING: 'Anthropic مدل embedding ارائه نمی‌کند؛ این قابلیت هرگز در دسترس نخواهد بود.',
      TEXT_GENERATION: 'ارائه‌دهنده Anthropic در این نسخه پیاده‌سازی نشده است.',
    },
  },
  LOCAL: {
    key: 'LOCAL',
    displayName: 'مدل محلی (Local LLM)',
    capabilities: [],
    unsupportedReason: {
      EMBEDDING: 'ارائه‌دهنده مدل محلی در این نسخه پیاده‌سازی نشده است.',
      TEXT_GENERATION: 'ارائه‌دهنده مدل محلی در این نسخه پیاده‌سازی نشده است.',
    },
  },
};

@Injectable()
export class AIProviderRegistry {
  private readonly logger = new Logger(AIProviderRegistry.name);

  /**
   * Injected by class, not constructed here. These are Nest singletons already
   * declared in AIModule; `new OpenAIProvider()` would bypass DI and produce a
   * second instance with its own logger and its own env snapshot.
   */
  constructor(
    private readonly openai: OpenAIProvider,
    private readonly azure: AzureOpenAIProvider,
    private readonly claude: ClaudeProvider,
    private readonly local: LocalLLMProvider
  ) {}

  /**
   * The ONLY lookup into DESCRIPTORS.
   *
   * `DESCRIPTORS[key]` alone is unsafe: DESCRIPTORS is a plain object literal, so
   * `'constructor'`, `'toString'` and friends resolve through `Object.prototype`
   * and return a truthy non-descriptor. A `if (!descriptor)` guard then passes and
   * `descriptor.capabilities` explodes with a TypeError — a 500 where the answer
   * should be "unknown provider". The own-property check makes every public method
   * below prototype-safe at once.
   */
  private descriptor(key: string): AIProviderDescriptor | undefined {
    return Object.prototype.hasOwnProperty.call(DESCRIPTORS, key)
      ? DESCRIPTORS[key as AIProviderKeyValue]
      : undefined;
  }

  /** Every registered provider with its real capabilities. Feeds the admin UI. */
  list(): AIProviderDescriptor[] {
    return Object.values(DESCRIPTORS).map((descriptor) => ({
      ...descriptor,
      capabilities: [...descriptor.capabilities],
      unsupportedReason: { ...descriptor.unsupportedReason },
    }));
  }

  /** Metadata for one key, or undefined for an unknown string. */
  find(key: string): AIProviderDescriptor | undefined {
    const descriptor = this.descriptor(key);
    if (!descriptor) return undefined;

    return {
      ...descriptor,
      capabilities: [...descriptor.capabilities],
      unsupportedReason: { ...descriptor.unsupportedReason },
    };
  }

  /** Declared support, never inferred from method presence. See the class comment. */
  supports(key: string, capability: AICapabilityValue): boolean {
    return this.descriptor(key)?.capabilities.includes(capability) ?? false;
  }

  /** The explanation for a false `supports`, for surfacing in the UI. */
  unsupportedReason(key: string, capability: AICapabilityValue): string | undefined {
    return this.descriptor(key)?.unsupportedReason[capability];
  }

  /**
   * Resolves a key to its instance.
   *
   * Throws NotFoundException on an unknown key rather than returning undefined:
   * the only callers are runtime resolution and the connection test, and both
   * would otherwise have to re-check, which is where a silent `undefined` becomes
   * a confusing TypeError deeper in the stack. A stored row can only hold an enum
   * value, so this can realistically only fire if the enum and this file diverge.
   */
  resolve(key: string): IAIProvider {
    switch (key) {
      case 'OPENAI':
        return this.openai;
      case 'AZURE_OPENAI':
        return this.azure;
      case 'ANTHROPIC':
        return this.claude;
      case 'LOCAL':
        return this.local;
      default:
        this.logger.error({ key }, 'Unknown AI provider key requested');
        throw new NotFoundException(`Unknown AI provider: ${key}`);
    }
  }
}
