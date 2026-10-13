import { SetMetadata } from '@nestjs/common';

/**
 * Phase 54-C (D14, §43.4): the `ENTITLEMENT_PORT` and the whole vocabulary of a decision.
 *
 * WHY THIS IS A PORT AND NOT A SERVICE CALL
 * -----------------------------------------
 * Entitlement is Core's fact: `core_db.ModuleRegistration`, `ModuleFeature` and
 * `ModuleFeatureGrant` are Core-owned tables, and the answer to "may this tenancy use this
 * feature?" can only be given by whoever owns them. A business module (HR is the first) must
 * therefore not read those tables itself — the same direction of dependency
 * `platform/audit/audit.contract.ts` (ARCH-3B), `platform/auth/permission-source.contract.ts`
 * (ARCH-3A) and `platform/user-directory/user-directory.contract.ts` (50-MOD-CORR) already
 * established, so there is ONE port idiom in this codebase and not three.
 *
 * ONE METHOD, READ-ONLY, AND THE TYPE IS THE ENFORCEMENT
 * -----------------------------------------------------
 * `decide(input)` is the whole consumer-facing contract. There is no `grant`, no `revoke`, no
 * `setEnabled`: mutation lives on the admin surface (§43.8) and nowhere else, so a consumer
 * physically cannot grant itself entitlement. That is a property of this interface rather than
 * of a code review, which is the point — the same structural choice `AuditPort` makes.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No `tenantId` parameter, here or on any future method. The tenant is read inside the
 * implementation from `RequestContextService` — the SAME source `ModuleRegistryService.resolve()`
 * uses (`module-registry.service.ts` L1079) — so one request has one tenant authority for
 * entitlement and for data, and a caller that could pass a tenant could ask for another
 * tenant's module (§25 rule 7, §24).
 */

/**
 * DI token for the port.
 *
 * A string token, matching `AUDIT_PORT` (`'AuditPort'`) and `USER_DIRECTORY`, rather than
 * introducing a `Symbol` idiom for one seam.
 */
export const ENTITLEMENT_PORT = 'EntitlementPort';

/** Metadata key written by `@RequiresModule`. Read by `ModuleEntitlementGuard` only. */
export const MODULE_REQUIREMENT_KEY = 'entitlement:module';

/** Metadata key written by `@RequiresFeature`. */
export const FEATURE_REQUIREMENT_KEY = 'entitlement:feature';

/**
 * The refusal codes a DECISION can produce — the frozen §43.2 set, in evaluation order.
 *
 * `MODULE_NOT_FOUND`, `MODULE_DISABLED` and `MODULE_FORBIDDEN` are the codes
 * `ModuleRegistryService.resolve()` already raises for the same three conditions; the gate
 * reuses them deliberately so an operator reads ONE vocabulary for ONE registry.
 *
 * `FEATURE_DISABLED` deliberately differs from `FEATURE_NOT_GRANTED`: "the platform does not
 * offer this" and "your tenancy does not hold this" are different facts, and therefore
 * different operator conversations.
 */
export type EntitlementFailureCode =
  | 'MODULE_NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'MODULE_FORBIDDEN'
  | 'FEATURE_NOT_FOUND'
  | 'FEATURE_DISABLED'
  | 'FEATURE_NOT_GRANTED';

/**
 * The one code that is NOT a §43.2 decision code: a decorated surface with no declaration.
 *
 * §43.5 requires the guard to refuse a decorated surface that carries neither decorator — "a
 * forgotten decorator must close a door, not open one" — and a `403` a client cannot tell apart
 * from a real decision would be worse than either. It is named here, next to the decision codes
 * and explicitly labelled as wiring rather than entitlement, so nothing downstream invents one.
 */
export type EntitlementDeclarationCode = 'ENTITLEMENT_NOT_DECLARED';

/** Every code the guard can return in a `403` body. */
export type EntitlementRefusalCode = EntitlementFailureCode | EntitlementDeclarationCode;

/**
 * The operator-facing label for each code, in Persian — the language every other refusal in
 * this codebase speaks (`module-url.guard.ts` L85/L122, `module-registry.service.ts` L476).
 *
 * A COMPLETE record over the union, so adding a code without labelling it is a type error: a
 * raw machine code must never reach a human, and an incomplete record is exactly how one does.
 * The web console keeps its own copy (`ENTITLEMENT_FAILURE_LABELS`,
 * `apps/web/src/lib/modules-api.ts`, §43.8) because it cannot import across the app boundary.
 */
export const ENTITLEMENT_FAILURE_LABELS: Record<EntitlementRefusalCode, string> = {
  MODULE_NOT_FOUND: 'ماژول درخواستی در این سامانه ثبت نشده است.',
  MODULE_DISABLED: 'ماژول درخواستی غیرفعال است.',
  MODULE_FORBIDDEN: 'ماژول درخواستی برای این سازمان فعال نشده است.',
  FEATURE_NOT_FOUND: 'قابلیت درخواستی در این ماژول تعریف نشده است.',
  FEATURE_DISABLED: 'این قابلیت در سطح سامانه غیرفعال است.',
  FEATURE_NOT_GRANTED: 'این قابلیت برای سازمان شما فعال نشده است.',
  ENTITLEMENT_NOT_DECLARED: 'این مسیر دسترسی تعریف نشده است و درخواست بسته رد شد.',
};

/** What a caller may ask. No tenant, no mode, no override — see the file header. */
export interface EntitlementRequest {
  /** The logical module id, e.g. `hr`. Never a business enum: a module exists when a row exists. */
  moduleId: string;

  /** The feature inside that module, when the question is the feature level. */
  featureId?: string;
}

/**
 * The decision function's result. Total: one input, one outcome, no implicit fallback.
 *
 * `ok: true` carries nothing — a decision that allowed does not need to describe itself — and a
 * refusal carries exactly one code from the frozen set.
 */
export type EntitlementDecision = { ok: true } | { ok: false; failure: EntitlementFailureCode };

/**
 * The FOUR states §43.8 asks the console to render for one tenant, in the spec's own words:
 * "**entitled** / **blocked by the module** / **blocked by the feature** / **not granted**".
 *
 * This is a PROJECTION of a decision, not a second decision. Every branch below reads a code an
 * `EntitlementDecision` already carries, and the frozen §43.9 ORDER is where it belongs — inside
 * `PlatformEntitlementService` — so nothing here can reorder a refusal. The console renders this
 * value and classifies nothing, which is the whole reason the vocabulary lives on the server side of
 * the port: a browser that grouped codes into states itself would be a second implementation of the
 * table, and it would be the one that drifts.
 */
export type EffectiveEntitlementState =
  | 'ENTITLED'
  | 'BLOCKED_BY_MODULE'
  | 'BLOCKED_BY_FEATURE'
  | 'NOT_GRANTED';

/**
 * Projects a decision onto the console vocabulary.
 *
 * Both module-level refusals answer `BLOCKED_BY_MODULE` on purpose: a disabled module and a tenancy
 * outside its scope are the same operator-facing fact — the refusal happens ABOVE the feature, so
 * neither the platform's offer nor a tenant's grant can change the answer.
 */
export function effectiveStateOf(decision: EntitlementDecision): EffectiveEntitlementState {
  if (decision.ok) return 'ENTITLED';

  switch (decision.failure) {
    case 'FEATURE_DISABLED':
    case 'FEATURE_NOT_FOUND':
      return 'BLOCKED_BY_FEATURE';
    case 'FEATURE_NOT_GRANTED':
      return 'NOT_GRANTED';
    default:
      return 'BLOCKED_BY_MODULE';
  }
}

/**
 * The consumer-facing contract. ONE read-only method; see the file header for why nothing
 * mutating appears here.
 */
export interface EntitlementPort {
  decide(input: EntitlementRequest): Promise<EntitlementDecision>;
}

/** The value `@RequiresFeature` writes: both ids, because a feature is addressed by its module. */
export interface FeatureRequirement {
  moduleId: string;
  featureId: string;
}

/** Declares the MODULE-level question on a controller class (or a handler). */
export const RequiresModule = (moduleId: string) => SetMetadata(MODULE_REQUIREMENT_KEY, moduleId);

/** Declares the FEATURE-level question. Implies the module question for the same module id. */
export const RequiresFeature = (moduleId: string, featureId: string) =>
  SetMetadata(FEATURE_REQUIREMENT_KEY, { moduleId, featureId } satisfies FeatureRequirement);

/**
 * Merges the two declaration sites into the one requirement the port is asked about.
 *
 * The rules, and why each is a refusal rather than a preference:
 *
 *  * neither declaration → `null`. §43.5: the guard then returns `403`, because a surface whose
 *    decorator was forgotten must be closed, not opened.
 *  * a feature declaration alone → the module question is STILL asked, with the module id the
 *    feature declaration itself names. Nothing is skipped: the feature level is only ever
 *    reachable behind the module level (§43.9).
 *  * both, naming DIFFERENT modules → `null`. Two declarations that disagree are a wiring
 *    contradiction; picking one of them would be a silent decision made by a guard.
 */
export function combineEntitlementRequirement(
  moduleId: string | undefined,
  feature: FeatureRequirement | undefined
): EntitlementRequest | null {
  if (moduleId !== undefined && feature !== undefined && feature.moduleId !== moduleId) return null;

  const resolvedModuleId = moduleId ?? feature?.moduleId;

  if (resolvedModuleId === undefined) return null;

  return feature === undefined
    ? { moduleId: resolvedModuleId }
    : { moduleId: resolvedModuleId, featureId: feature.featureId };
}
