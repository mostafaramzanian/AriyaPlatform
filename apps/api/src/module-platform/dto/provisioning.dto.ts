import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Phase 49M-1: the provisioning write contract.
 *
 * FOUR RULES THAT SHAPE THIS FILE, and each is an ABSENCE rather than a validator:
 *
 * 1. NO STATE FIELD. There is no `operationalState`, no `targetState` and no `lifecycle`
 *    here, so an administrator cannot assign `ACTIVE` to a module that never passed
 *    verification. The caller names an ACTION; `ACTION_TARGET_STATE` in the service maps it
 *    to a state and `canTransition` decides whether that move is legal. Validating a
 *    caller-supplied state would still be a route through which the transition table could
 *    be bypassed by a caller who guessed the right value.
 *
 * 2. NO URL, HOST, PORT, IMAGE OR COMMAND. The destination is a `targetKey` resolved to a
 *    row whose table has no address column; the artifact is a `releaseVersion` resolved to
 *    an object-store key. The probe-arbitrary-host and run-arbitrary-command anti-patterns
 *    are therefore unexpressible, which is stronger than refused.
 *
 * 3. NO CREDENTIAL, EVER. Not a secret, not a token, not a private key, and not even a
 *    credential reference: the reference lives on the target row where an administrator put
 *    it, and a provider resolves it at use time.
 *
 * 4. NOTHING NAMES A BUSINESS MODULE. `moduleId` is a validated slug, never an
 *    `@IsIn(['hr','finance'])`, because a module exists when a row exists.
 *
 * `forbidNonWhitelisted` is already enabled globally, so sending any field not declared here
 * is a 400 rather than a silently ignored property.
 */

/** Mirrors the slug CHECK constraints, same pattern `module.dto.ts` uses. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Mirrors `ModuleRelease_version_format` / `ModuleInstance_version_format`. */
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

/** Idempotency token shape: opaque to the server, bounded and printable. */
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The nine actions, mirroring the `ProvisioningAction` enum.
 *
 * A CLOSED LIST rather than a free string, and the one place in this phase where an
 * `@IsIn` is correct: these are Core's own verbs, not a module's vocabulary, so a new one
 * is a deliberate change to both the enum and this array.
 */
export const PROVISIONING_ACTIONS = [
  'PROVISION',
  'CONFIGURE',
  'VERIFY',
  'ACTIVATE',
  'STOP',
  'RESTART',
  'UPGRADE',
  'ROLLBACK',
  'DECOMMISSION',
] as const;

export type ProvisioningActionInput = (typeof PROVISIONING_ACTIONS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export class RequestProvisioningDto {
  /** Logical module. A slug, never an enum member. */
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(SLUG_PATTERN, { message: 'شناسه ماژول باید یک slug معتبر باشد.' })
  moduleId!: string;

  @IsIn(PROVISIONING_ACTIONS, { message: 'عملیات درخواستی معتبر نیست.' })
  action!: ProvisioningActionInput;

  /**
   * WHERE to act. A key, resolved to a `ProvisioningTarget` row — and that table has no
   * `url`, `host` or `port` column, so this string cannot become a network destination no
   * matter what an administrator types.
   */
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(96)
  @Matches(SLUG_PATTERN, { message: 'کلید مقصد باید یک slug معتبر باشد.' })
  targetKey!: string;

  /**
   * WHICH instance. Optional at the DTO level and REQUIRED by the service for every action
   * except PROVISION.
   *
   * The requirement lives in the service rather than in a `@ValidateIf`, because the same
   * rule is also a database CHECK
   * (`ModuleProvisioningExecution_nonprovision_requires_instance`) and a third copy in a
   * decorator is a third thing that can drift. The DTO's job here is SHAPE.
   */
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(96)
  @Matches(SLUG_PATTERN, { message: 'شناسه نمونه باید یک slug معتبر باشد.' })
  instanceKey?: string;

  /**
   * WHICH release, by version. Required by the service for PROVISION, UPGRADE and ROLLBACK.
   *
   * A VERSION, not an artifact key and not a URL: the key is resolved from the
   * `ModuleRelease` row, so a caller cannot point a deployment at an object they chose.
   * `latest` is refused by the pattern, for the reason the schema gives — a version nothing
   * can order makes upgrade and rollback the same operation.
   */
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(SEMVER_PATTERN, { message: 'نسخه باید در قالب x.y.z باشد.' })
  releaseVersion?: string;

  /**
   * Caller-supplied de-duplication token, folded into the execution's `idempotencyKey`.
   *
   * THE CALLER SUPPLIES IT DELIBERATELY. A server-generated token would make a retried
   * submit a second deployment, which is precisely what the UNIQUE constraint exists to
   * prevent; with a caller token, a double-clicked button collapses onto one execution and
   * the response says `deduplicated: true`.
   */
  @Transform(trim)
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  @Matches(REQUEST_KEY_PATTERN, { message: 'کلید درخواست معتبر نیست.' })
  requestKey!: string;
}
