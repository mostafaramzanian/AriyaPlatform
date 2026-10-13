import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  MAX_MODULE_PAYLOAD_BYTES,
  MAX_MODULE_TIMEOUT_MS,
  MIN_MODULE_TIMEOUT_MS,
} from '../module.contract';
import { isValidCapability, isValidContract } from '../module-contract.util';
import type { PublicCapabilityCredential } from '../module-registry.service';

/**
 * Phase 49M: module-platform write contracts.
 *
 * THREE RULES THAT SHAPE EVERY DTO IN THIS FILE:
 *
 * 1. A MODULE CANNOT GRANT ITSELF ANYTHING (§8). `RegisterModuleDto` — the body a module
 *    itself sends — has no `enabled`, no `tenantScope`, no `tenantIds`, no `permissions`
 *    and no `trusted`. Those fields exist only on the ADMIN DTOs. This is not enforced by
 *    a check; the fields are absent, and `forbidNonWhitelisted` turns sending one into a
 *    400 rather than a silently ignored property.
 *
 * 2. NOTHING NAMES A BUSINESS MODULE. `moduleId` is a validated slug, not an enum: there is
 *    no `@IsIn(['hr','finance'])` anywhere, because a module exists when a row exists.
 *
 * 3. AN ENDPOINT IS VALIDATED TWICE, and the second check is the load-bearing one.
 *    `@IsUrl` proves the string is URL-shaped; `assertModuleEndpointAllowed` in the service
 *    applies the SSRF policy and the deployment-mode transport rule. A DTO cannot express
 *    the latter because it depends on environment configuration read at call time — the
 *    same division 49L documents on `CreateIntegrationDto`.
 */

/** Mirrors the slug CHECK constraints in the migration. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Mirrors `ModuleInstance_version_format`. */
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

/** Mirrors `ModuleInstance_healthPath_relative`. */
const RELATIVE_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]*$/;

export const MAX_MODULE_ID = 64;
export const MAX_INSTANCE_ID = 96;
export const MAX_DISPLAY_NAME = 120;
export const MAX_BASE_URL = 500;
export const MAX_HEALTH_PATH = 300;
export const MAX_CAPABILITIES = 64;
export const MAX_API_CONTRACTS = 32;
export const MAX_EVENT_CONTRACTS = 64;
export const MAX_TENANT_IDS = 64;
export const MAX_OPERATION_LENGTH = 120;

export const MODULE_TYPES = ['CORE', 'BUSINESS', 'INTEGRATION'] as const;
export const DEPLOYMENT_MODES = ['LOCAL', 'REMOTE', 'CENTRAL', 'HYBRID'] as const;
export const TENANT_SCOPES = ['ALL', 'RESTRICTED'] as const;
export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'DISABLED', 'UNKNOWN'] as const;

/**
 * Trims, then converts an emptied string to `undefined` so `@IsOptional()` treats `""` as
 * absent — the same helper `integration.dto.ts` (49L) and `ai-config.dto.ts` (49J-0) use,
 * for the same reason: clearing a field in a form must mean "leave unchanged", not "fail
 * MinLength".
 */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Validates every entry of a string array with a predicate.
 *
 * WHY A CUSTOM CONSTRAINT RATHER THAN `@Matches({ each: true })`: capability and contract
 * shapes are already defined once in `module-contract.util.ts`, and the compatibility gate
 * uses those same functions. Restating the regexes as decorators would create a second
 * definition that could drift from the one the gate enforces — so the DTO calls the same
 * predicate the service does.
 */
@ValidatorConstraint({ name: 'moduleStringList', async: false })
class ModuleStringListConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args?: ValidationArguments): boolean {
    if (!Array.isArray(value)) return false;

    const predicate = this.predicateFor(args);

    return value.every((entry) => typeof entry === 'string' && predicate(entry));
  }

  defaultMessage(args?: ValidationArguments): string {
    return this.kindFor(args) === 'capability'
      ? 'هر توانمندی باید شناسه‌ای معتبر باشد.'
      : 'هر قرارداد باید در قالب name@v<major> باشد.';
  }

  /**
   * The constraint argument, defaulting to `contract`.
   *
   * `ValidationArguments` is OPTIONAL in class-validator's interface, so both methods must cope
   * with its absence rather than assume the decorator passed it. Defaulting to the stricter of
   * the two predicates means a mis-wired decorator fails closed.
   */
  private kindFor(args?: ValidationArguments): 'capability' | 'contract' {
    return args?.constraints?.[0] === 'capability' ? 'capability' : 'contract';
  }

  private predicateFor(args?: ValidationArguments): (entry: string) => boolean {
    return this.kindFor(args) === 'capability' ? isValidCapability : isValidContract;
  }
}

/**
 * Validates ONE contract descriptor.
 *
 * Separate from the list constraint above rather than overloading it: a constraint that
 * accepted "an array OR a string" would silently pass an array where a single descriptor
 * was meant, and `InvokeModuleDto.contract` is exactly one descriptor. Same predicate,
 * different arity — so the shape rule still lives in one place.
 */
@ValidatorConstraint({ name: 'moduleContract', async: false })
class ModuleContractConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidContract(value);
  }

  defaultMessage(): string {
    return 'قرارداد باید در قالب name@v<major> باشد.';
  }
}

/**
 * The body a MODULE sends to register itself (§7/§8).
 *
 * WHAT IS NOT HERE IS THE SECURITY BOUNDARY, and it is worth listing explicitly because
 * `forbidNonWhitelisted` makes each absence a 400 rather than a silent drop:
 *   - no `enabled`      — a module cannot admit itself to the platform;
 *   - no `tenantScope` / `tenantIds` — §8 forbids a self-declared tenant scope;
 *   - no `permissions`  — §8 forbids self-declared permissions;
 *   - no `lifecycle` / `health` — a module cannot declare itself ACTIVE or HEALTHY; both
 *     are OBSERVED, and letting a registrant set them would make the health system
 *     decorative;
 *   - no `secret`       — Core generates and stores the credential; a module presenting a
 *     secret of its own choosing would be choosing its own key.
 */
export class RegisterModuleDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(MAX_MODULE_ID)
  @Matches(SLUG_PATTERN, { message: 'شناسه ماژول باید حروف کوچک و خط تیره باشد.' })
  moduleId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(MAX_INSTANCE_ID)
  @Matches(SLUG_PATTERN, { message: 'شناسه نمونه باید حروف کوچک و خط تیره باشد.' })
  instanceId!: string;

  @Transform(trim)
  @IsString()
  @Matches(SEMVER_PATTERN, { message: 'نسخه باید در قالب x.y.z باشد.' })
  version!: string;

  /**
   * DEPLOYMENT metadata (§6), recorded and never used to pick a business code path.
   *
   * It IS used by the transport layer to choose a network policy, which is why it is
   * required rather than defaulted: guessing LOCAL for a module that is actually remote
   * would silently exempt it from the HTTPS requirement.
   */
  @IsIn(DEPLOYMENT_MODES)
  deploymentMode!: (typeof DEPLOYMENT_MODES)[number];

  /**
   * Origin only. `require_tld: false` so a container hostname (`https://finance:8443`) is
   * accepted — the realistic compose topology — while the service still applies the SSRF
   * policy and the off-host HTTPS rule.
   *
   * Optional HERE and required by POLICY: only LOCAL may omit it, which
   * `assertModuleEndpointAllowed` enforces, because that rule depends on
   * `deploymentMode` and on environment configuration.
   */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(MAX_BASE_URL)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  baseUrl?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(MAX_HEALTH_PATH)
  @Matches(RELATIVE_PATH_PATTERN, { message: 'مسیر سلامت باید نسبی باشد.' })
  healthPath?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CAPABILITIES)
  @Validate(ModuleStringListConstraint, ['capability'])
  capabilities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_API_CONTRACTS)
  @Validate(ModuleStringListConstraint, ['contract'])
  apiContracts?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EVENT_CONTRACTS)
  @Validate(ModuleStringListConstraint, ['contract'])
  eventContracts?: string[];

  /** Compared against `MODULE_PROTOCOL_VERSION`; a mismatch is INCOMPATIBLE (§18). */
  @IsInt()
  @Min(1)
  @Max(100)
  protocolVersion!: number;
}

/**
 * The heartbeat body (§14).
 *
 * DELIBERATELY TINY. A heartbeat may refresh `lastSeenAt` and report the module's own
 * health state — nothing else. It cannot change the endpoint, the capabilities, the
 * contracts or the version, because a re-declaration is a REGISTRATION and must go through
 * the compatibility gate; allowing a heartbeat to mutate declarations would be a way to
 * bypass §18 one field at a time.
 */
export class ModuleHeartbeatDto {
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_INSTANCE_ID)
  @Matches(SLUG_PATTERN)
  instanceId!: string;

  /**
   * The module's own view of its health. ADVISORY: Core records it, and the probe remains
   * the authority — a module claiming HEALTHY while its endpoint refuses connections is
   * recorded as reachable-but-unwell by the probe, not believed.
   */
  @IsOptional()
  @IsIn(HEALTH_STATES)
  state?: (typeof HEALTH_STATES)[number];
}

/**
 * Deregistration (§15): a module announcing its own shutdown.
 *
 * The instance id is in the BODY as well as being covered by the signature, so the request
 * is self-describing; the service additionally asserts it belongs to the signing module, so
 * one module cannot deregister another's instance.
 */
export class DeregisterModuleDto {
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_INSTANCE_ID)
  @Matches(SLUG_PATTERN)
  instanceId!: string;
}

/**
 * The ADMIN registration body (§29/§31): admitting a logical module to the platform.
 *
 * This is the counterpart to `RegisterModuleDto`, and the split between the two IS the
 * trust model. Everything here is a decision an administrator makes ABOUT a module;
 * nothing here is something a module reports about itself. There is no `baseUrl`, no
 * `version`, no `capabilities` and no `instanceId` — an administrator does not type an
 * endpoint (which is also half the §40 SSRF answer) and cannot invent an instance that
 * has never announced itself.
 */
export class CreateModuleRegistrationDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(MAX_MODULE_ID)
  @Matches(SLUG_PATTERN, { message: 'شناسه ماژول باید حروف کوچک و خط تیره باشد.' })
  moduleId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_DISPLAY_NAME)
  displayName!: string;

  @IsOptional()
  @IsIn(MODULE_TYPES)
  moduleType?: (typeof MODULE_TYPES)[number];

  /**
   * Optional and DEFAULTING TO FALSE in the service, not here: a module admitted in the
   * same request that creates it would skip the operator's chance to review what
   * registered itself.
   */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(TENANT_SCOPES)
  tenantScope?: (typeof TENANT_SCOPES)[number];

  /**
   * Required exactly when `tenantScope` is RESTRICTED — `@ValidateIf` rather than a service
   * check, so the 422 names the field. The DB CHECK restates the same pair invariant, so a
   * direct write cannot produce "RESTRICTED to nobody" either.
   */
  @ValidateIf((dto: CreateModuleRegistrationDto) => dto.tenantScope === 'RESTRICTED')
  @IsArray()
  @ArrayMaxSize(MAX_TENANT_IDS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tenantIds?: string[];
}

/**
 * The ADMIN update body.
 *
 * `moduleId` IS DELIBERATELY ABSENT. It is the identity every resolution, every signature
 * and every audit row is keyed by, so renaming one would silently reassign a credential and
 * a tenant scope to a different module — the same reason 49L's `UpdateIntegrationDto` omits
 * `integration`. Pointing at a different module is a create plus a delete.
 *
 * `protocolVersion` is absent for a related reason: it records what the module was ADMITTED
 * under, and editing it by hand would let an operator declare compatibility that the
 * compatibility gate never verified.
 */
export class UpdateModuleRegistrationDto {
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_DISPLAY_NAME)
  displayName?: string;

  @IsOptional()
  @IsIn(MODULE_TYPES)
  moduleType?: (typeof MODULE_TYPES)[number];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(TENANT_SCOPES)
  tenantScope?: (typeof TENANT_SCOPES)[number];

  @ValidateIf((dto: UpdateModuleRegistrationDto) => dto.tenantScope === 'RESTRICTED')
  @IsArray()
  @ArrayMaxSize(MAX_TENANT_IDS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tenantIds?: string[];
}

/**
 * The admin "call this module" body, used by the connection test and by the diagnostic
 * invoke route (§29/§31).
 *
 * THERE IS NO `url`, NO `baseUrl`, NO `host` AND NO `instanceId` FIELD, and that is the
 * §40 point: the destination is RESOLVED from the registry, so this route cannot be used
 * as an authenticated HTTP proxy. The §29/§40 anti-pattern —
 * `POST /modules/call { "url": "http://169.254.169.254/…" }` — is structurally
 * unexpressible rather than merely refused.
 */
export class InvokeModuleDto {
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_MODULE_ID)
  @Matches(SLUG_PATTERN)
  moduleId!: string;

  /** Contract descriptor. Shape validated by the same predicate the gate uses. */
  @Transform(trim)
  @IsString()
  @Validate(ModuleContractConstraint)
  contract!: string;

  /** Operation within the contract. Opaque to Core: matched, never interpreted. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_OPERATION_LENGTH)
  operation!: string;

  /**
   * `@IsObject` rather than a per-operation class, because the payload shape is owned by the
   * TARGET MODULE, not by Core's HTTP surface. The service enforces the size bound and
   * strips nothing, so an over-large payload is refused rather than truncated.
   */
  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(MIN_MODULE_TIMEOUT_MS)
  @Max(MAX_MODULE_TIMEOUT_MS)
  timeoutMs?: number;
}

/** Restated for the client so a form can refuse an over-large payload locally. */
export const MAX_INVOKE_PAYLOAD_BYTES = MAX_MODULE_PAYLOAD_BYTES;

/**
 * THE runtime projection at the HTTP boundary, and the only place a capability credential becomes
 * a response body.
 *
 * WHY A FUNCTION AND NOT JUST AN INTERFACE. An interface is erased at runtime, so it constrains the
 * code that returns a value but says nothing about a value that has already been built. This
 * function rebuilds the body field by field, which is a property a test can EXECUTE: hand it a row
 * carrying an encryption envelope and assert the serialised result contains no envelope property
 * name. `module-registry.controller.spec.ts` does exactly that (§4).
 *
 * THE INPUT TYPE IS THE PUBLIC PROJECTION, not a Prisma row: a caller holding a `ModuleRegistration`
 * or `ModuleCapabilityCredential` row cannot pass it here without a cast, which is the point —
 * this boundary cannot be fed an envelope by accident.
 */
export function toCapabilityCredentialResponse(
  row: PublicCapabilityCredential
): CapabilityCredentialResponseDto {
  return {
    id: row.id,
    moduleId: row.moduleId,
    capability: row.capability,
    hasSecret: row.hasSecret,
    credentialUpdatedAt: row.credentialUpdatedAt,
    credentialExpiresAt: row.credentialExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The write-path projection: it forwards the ONE field the issuer must install and nothing else.
 *
 * Written out rather than returning the service result directly so the response body of a
 * provisioning call is defined here, next to the read DTO, instead of being whatever the service
 * returned last time it was edited.
 */
export function toCapabilityCredentialSecretResponse(result: {
  secret: string;
}): CapabilityCredentialSecretResponseDto {
  return { secret: result.secret };
}

/**
 * ADR-0006 A8: the CAPABILITY-CREDENTIAL response boundary.
 *
 * A POSITIVE ALLOWLIST, declared as a class rather than as a `Partial<>` of something else, for
 * the same reason `PROFILE_SELECT` in `core-user-directory.adapter.ts` is a positive allowlist: a
 * denylist would leak every column Core adds later. `secretCiphertext`, `secretIv` and
 * `secretAuthTag` are not fields here, so a route that tried to serialise one would not compile —
 * and the runtime key-set assertion in `module-registry.controller.spec.ts` proves the route does
 * not, rather than trusting the type to have been enough.
 *
 * THIS IS ALSO THE END OF THE WRITE PATH'S PLAINTEXT. The credential's VALUE never appears on this
 * type: it is returned exactly once, by the call that created it
 * (`CapabilityCredentialSecretResponseDto`), and no read can reconstruct it, because the only
 * stored form is the AES-GCM envelope.
 *
 * The field set mirrors `PublicCapabilityCredential` (the service's projection) exactly, and the
 * controller returns that projection under this type — so a field added to one and forgotten in
 * the other is a COMPILE error rather than a silently dropped column.
 */
export class CapabilityCredentialResponseDto {
  /** The credential row's own id. Never a secret, never a hint of one. */
  id!: string;

  /** The logical module the credential belongs to. */
  moduleId!: string;

  /** The contract descriptor this credential authenticates, e.g. `platform.audit@v1`. */
  capability!: string;

  /** Whether an envelope is stored. NOT the credential, nor its length. */
  hasSecret!: boolean;

  /**
   * When the slot was last written. Equal to `createdAt` for a credential that was issued and
   * never rotated, which is how a first issuance is told apart from a rotation on the read path.
   */
  credentialUpdatedAt!: Date | null;

  /** NULL means "no expiry configured", never "expired". */
  credentialExpiresAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

/**
 * The ONE-TIME provisioning/rotation response, and the response of the ONLY call that may carry a
 * capability credential's plaintext.
 *
 * `secret` is present here and NOWHERE ELSE in the HTTP surface — and only on the WRITE route that
 * generated it. There is deliberately no `GET` counterpart: an operator who loses a credential
 * rotates it, because a route that could read one back would turn the store into a credential
 * dispenser and make every audit row about rotation a lie.
 *
 * It has exactly one field, on purpose: a response that also carried a row projection would be one
 * careless spread away from carrying an envelope (`secretCiphertext`, `secretIv`, `secretAuthTag`),
 * and there is nothing else the caller of an issue/rotate needs to be told than the value it must
 * now install. Declared as a CLASS, not an interface, matching every other DTO in this file — an
 * interface with the same name would merge with this one, and that merge is what lets a field be
 * added in one place and silently absent from the other.
 */
export class CapabilityCredentialSecretResponseDto {
  /** The plaintext, returned once — by the call that GENERATED it and by no other call, ever. */
  secret!: string;
}
