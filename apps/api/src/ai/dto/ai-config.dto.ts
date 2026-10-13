import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Phase 49J-0: AI provider configuration write contracts.
 *
 * NO DTO CARRIES A `tenantId`, `isDefault`-plus-`enabled` shortcut, an id, or any
 * timestamp. Configuration is platform-global, ids come from the path, and
 * `credentialUpdatedAt` is stamped server-side when a key is actually written —
 * a client that could set it would be able to claim a rotation that never
 * happened.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so an
 * unexpected property is rejected rather than silently dropped. That matters more
 * here than anywhere else in the codebase: a typo'd `apikey` field must 400, not
 * vanish while the response reports success.
 */

export const MAX_MODEL_NAME = 200;
export const MAX_BASE_URL = 500;

/**
 * An API key long enough to be one. 5000 is generous — provider keys are far
 * shorter — but a bound must exist so an unbounded body cannot be encrypted into
 * the database.
 */
export const MAX_CREDENTIAL = 5000;

/** Matches the `AIProviderKey` enum. Four members, one per implemented provider. */
export const AI_PROVIDER_KEYS = ['OPENAI', 'AZURE_OPENAI', 'ANTHROPIC', 'LOCAL'] as const;

/** Matches the `AICapability` enum. */
export const AI_CAPABILITIES = ['TEXT_GENERATION', 'EMBEDDING'] as const;

export type AIProviderKeyLiteral = (typeof AI_PROVIDER_KEYS)[number];
export type AICapabilityLiteral = (typeof AI_CAPABILITIES)[number];

/**
 * Trims, then converts an emptied string to `undefined` so `@IsOptional()` treats
 * `""` as absent. Without this, clearing a field in the UI would submit an empty
 * string and fail the `MinLength` check instead of meaning "leave unchanged".
 */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export class CreateAIProviderConfigDto {
  @IsIn(AI_PROVIDER_KEYS)
  provider!: AIProviderKeyLiteral;

  @IsIn(AI_CAPABILITIES)
  capability!: AICapabilityLiteral;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MODEL_NAME)
  modelName!: string;

  /**
   * Endpoint override. `require_tld: false` so a container hostname
   * (`http://ollama:11434`) is accepted — the local provider's normal case — while
   * a non-URL string is still refused.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(MAX_BASE_URL)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  baseUrl?: string;

  /**
   * The plaintext credential, encrypted before it reaches the database and never
   * returned by any route afterwards. Optional because a LOCAL provider on a
   * trusted network has no key.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CREDENTIAL)
  credential?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * Accepted at creation so a first provider can be created live in one call. The
   * service refuses `isDefault` without `enabled`, matching the DB CHECK, and
   * demotes any previous default for the capability in the same transaction.
   */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/**
 * Update contract.
 *
 * `provider` AND `capability` ARE BOTH ABSENT, deliberately. They form the row's
 * unique identity: allowing either to change would silently move the credential
 * that was encrypted for one provider onto another, or collide with the
 * `(provider, capability)` unique index. Pointing at a different provider is a
 * create plus a delete, and reads that way in the audit log.
 *
 * An OMITTED `credential` LEAVES THE STORED KEY UNTOUCHED — it does not clear it.
 * That is what makes a masked GET safe to round-trip: the UI can submit the whole
 * form back without ever having seen the key. Use `clearCredential` to remove one.
 */
export class UpdateAIProviderConfigDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MODEL_NAME)
  modelName?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(MAX_BASE_URL)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  baseUrl?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CREDENTIAL)
  credential?: string;

  /**
   * Explicit removal, refused in the same request as `credential` so
   * "set it" and "remove it" can never arrive together and be resolved by
   * whichever branch happens to run first.
   */
  @IsOptional()
  @IsBoolean()
  clearCredential?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/**
 * Connection test input.
 *
 * The credential is OPTIONAL: with it, an operator can verify a key BEFORE saving
 * it (the reason this endpoint takes a body at all); without it, the stored key is
 * decrypted and used, which is what verifies an existing row still works. There is
 * no third mode where the probe text is caller-supplied — see §11: the probe
 * string is fixed server-side so this endpoint cannot be used as a free
 * pass-through to a paid provider API.
 */
export class TestAIProviderConnectionDto {
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CREDENTIAL)
  credential?: string;
}
