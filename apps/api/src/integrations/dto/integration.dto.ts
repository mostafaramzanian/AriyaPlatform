import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { INTEGRATION_EVENT_TYPES, INTEGRATION_SOURCES } from '../integration.contract';

/**
 * Phase 49L: integration write contracts.
 *
 * NO DTO HERE CARRIES A `tenantId`, AN ID, A TIMESTAMP OR A DESTINATION URL FOR A
 * NON-ADMIN CALLER. Configuration is platform-global, ids come from the path, and
 * `secretUpdatedAt` / `lastTestedAt` are stamped server-side — a client that could
 * set them could claim a rotation or a successful test that never happened.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so an
 * unexpected property is REJECTED rather than silently dropped. That matters more
 * here than almost anywhere else: a typo'd `secrett` field must 400, not vanish
 * while the response reports success.
 *
 * THE URL IS VALIDATED TWICE, and the second check is the load-bearing one.
 * `@IsUrl` only proves the string is URL-shaped; `assertIntegrationUrlAllowed` in
 * the service is what refuses `file://`, credentials-in-URL, loopback and
 * link-local targets (§30). A DTO cannot express that policy because it depends on
 * environment configuration read at call time.
 */

export const MAX_BASE_URL = 500;
export const MAX_WEBHOOK_PATH = 300;

/**
 * Bound on the shared secret. Generous ceiling, but a REAL floor: a 12-character
 * "secret" is a password, not an HMAC key, and accepting one would make the
 * signature decorative.
 */
export const MIN_WEBHOOK_SECRET = 32;
export const MAX_WEBHOOK_SECRET = 512;

/** Matches the `IntegrationKey` enum. One member, one adapter. */
export const INTEGRATION_KEYS = ['N8N'] as const;

export type IntegrationKeyLiteral = (typeof INTEGRATION_KEYS)[number];

/**
 * Trims, then converts an emptied string to `undefined` so `@IsOptional()` treats
 * `""` as absent. Without this, clearing a field in the UI would submit an empty
 * string and fail `MinLength` instead of meaning "leave unchanged" — the same
 * helper `ai-config.dto.ts` uses, and for the same reason.
 */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export class CreateIntegrationDto {
  @IsIn(INTEGRATION_KEYS)
  integration!: IntegrationKeyLiteral;

  /**
   * Origin only. `require_tld: false` so a container hostname
   * (`http://n8n:5678`) or `http://localhost:5678` is accepted — the normal local
   * topology (§31) — while a non-URL string is still refused here and a private
   * target is refused by the SSRF guard unless the deployment opted in.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(MAX_BASE_URL)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  baseUrl!: string;

  /**
   * Webhook path. Validated as a ROOT-RELATIVE path rather than a URL, so it cannot
   * carry a scheme or an authority; `buildIntegrationUrl` additionally refuses any
   * path that changes the origin after resolution.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_WEBHOOK_PATH)
  webhookPath!: string;

  /**
   * The HMAC shared secret, encrypted before it reaches the database and never
   * returned by any route afterwards. Optional at creation so a row can be created
   * disabled and have its secret generated afterwards; dispatch refuses to sign
   * without one rather than sending an unsigned event.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(MIN_WEBHOOK_SECRET)
  @MaxLength(MAX_WEBHOOK_SECRET)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Clamped range mirrors `IntegrationConfig_timeoutMs_bounded`. */
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  timeoutMs?: number;

  /** Clamped range mirrors `IntegrationConfig_maxAttempts_bounded`. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxAttempts?: number;
}

/**
 * Update contract.
 *
 * `integration` IS ABSENT, deliberately. It is the row's identity: allowing it to
 * change would silently move a secret negotiated with one engine onto another, or
 * collide with the unique index. Pointing at a different engine is a create plus a
 * delete, and reads that way in the audit log — the same rule
 * `UpdateAIProviderConfigDto` applies to `provider`/`capability`.
 *
 * An OMITTED `secret` LEAVES THE STORED ONE UNTOUCHED. That is what makes the
 * masked GET safe to round-trip: the UI can submit the whole form back without ever
 * having seen the secret.
 */
export class UpdateIntegrationDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(MAX_BASE_URL)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  baseUrl?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(MAX_WEBHOOK_PATH)
  webhookPath?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(MIN_WEBHOOK_SECRET)
  @MaxLength(MAX_WEBHOOK_SECRET)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  timeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxAttempts?: number;
}

/**
 * Inbound callback body (§24/§26).
 *
 * WHAT THIS SHAPE REFUSES TO BE: a generic command. There is no `table`, no
 * `field`, no `operator`, no `where`, no `sql` and no `entity` — nothing an
 * external system could use to address arbitrary storage. The callback names an
 * EVENT Aria already dispatched, reports an OUTCOME, and nothing else. The only
 * state it can change is the delivery status of that one execution row, and only
 * through `AutomationService.applyCallback`, which is an explicit Core command.
 *
 * `eventId` + `integration` locate the execution; both are also covered by the
 * signature, so a valid signature over a different event cannot be replayed onto
 * this one.
 */
export class IntegrationCallbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  eventId!: string;

  /**
   * Echoed back so the body is self-describing and the signature covers it. The
   * service additionally asserts it matches the `:integration` path parameter —
   * a mismatch is a rejection, not a preference for one of the two.
   */
  @IsIn(INTEGRATION_KEYS)
  integration!: IntegrationKeyLiteral;

  /**
   * Two outcomes only. An external system reporting a free-form status would put
   * its vocabulary into Aria's state machine; mapping is the adapter's job, and
   * the mapping here is deliberately trivial because the state machine is small
   * (§20).
   */
  @IsIn(['COMPLETED', 'FAILED'])
  status!: 'COMPLETED' | 'FAILED';

  /**
   * The engine's own execution reference. Optional, opaque, display-only — nothing
   * in Aria resolves it against the engine's database.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(200)
  externalExecutionId?: string;

  /**
   * SHORT CODE, NOT A MESSAGE. Bounded to 100 characters and stored verbatim in
   * `errorCode`, so an upstream stack trace or response body cannot be smuggled
   * into the database — or into the admin UI — through this field.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(100)
  errorCode?: string;
}

/**
 * Manual trigger body (§29).
 *
 * THERE IS NO `url` FIELD, AND THAT IS THE POINT: the destination is resolved from
 * `IntegrationConfig`, so this endpoint cannot be used as an HTTP proxy. The §29
 * anti-pattern — `POST /automation { "url": "http://..." }` — is structurally
 * unexpressible here.
 *
 * `eventType` and `source` are constrained to the declared contract sets, so an
 * operator cannot invent an event type no workflow is bound to.
 */
export class TriggerAutomationDto {
  @IsIn(INTEGRATION_EVENT_TYPES)
  eventType!: (typeof INTEGRATION_EVENT_TYPES)[number];

  @IsIn(INTEGRATION_SOURCES)
  source!: (typeof INTEGRATION_SOURCES)[number];

  /**
   * The minimised payload. `@IsObject` rather than a per-event class because the
   * payload shape is owned by the emitting module, not by this HTTP surface; the
   * SERVICE enforces the size bound and strips nothing, so an over-large payload is
   * refused rather than truncated.
   */
  @IsObject()
  payload!: Record<string, unknown>;

  /**
   * Optional stable id, so an operator re-clicking "run" does not create a second
   * delivery. Omitted means a fresh UUID, i.e. a genuinely new event.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  eventId?: string;
}

