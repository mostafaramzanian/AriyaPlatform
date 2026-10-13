import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Phase 54-C (D14, §43.8): the DTOs of the FEATURE-entitlement admin surface.
 *
 * WHERE THESE LIVE, AND WHY THEY ARE NOT IN `module-platform/dto/module.dto.ts`
 * ----------------------------------------------------------------------------
 * §43.8 puts the API in `platform/entitlement/module-feature.controller.ts` and keeps it
 * out of the registry module, so the bodies it accepts live beside it. The registry
 * module writes `ModuleRegistration`; this module writes `ModuleFeature` and
 * `ModuleFeatureGrant`, and the two files never import each other's DTOs — the coupling
 * §43.8 refuses for the WRITE path would be just as real through a shared type.
 *
 * WHAT THE FEATURE ADMIN API PHYSICALLY CANNOT EXPRESS
 * ---------------------------------------------------
 *  * NO `moduleId` IN ANY BODY. The module is the `:moduleId` path segment, so a body
 *    cannot disagree with the route it was posted to. The same rule the registry's
 *    update DTO follows for its own identity.
 *  * NO `tenantScope`, NO `tenantIds`, NO `enabled` ON A MODULE. The scope enum is the
 *    registry's, and `RESTRICTED_MEMBERS` stays unwritable through the admin API
 *    (§45.4 item 5): an operator cannot move a module into or out of the enumerated
 *    storage mode, because that would be a provisioning decision expressed as a scope
 *    edit. Nothing in this file names a scope at all.
 *  * NO `id`, NO `grantedAt`, NO actor. The row id is the database's, a grant's time is
 *    the database's, and the actor comes from the authenticated principal and the audit
 *    trail — never from a body.
 *  * NO `grants` ARRAY ON THE FEATURE BODY. Granting is its own route with its own
 *    bounded body, so "declare a feature" cannot smuggle a tenant list with it.
 */

/**
 * The two bounds below mirror `ModuleFeature_featureId_format`, the SQL CHECK the
 * migration writes: same slug shape as `ModuleRegistration.moduleId` and the same 2-64
 * window. Declared here rather than imported from `module-platform/dto/module.dto.ts`
 * for the reason in the file header — and asserted against the migration's own text by
 * the Core-side migration gate, so the two spellings cannot drift silently.
 */
export const FEATURE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MIN_FEATURE_ID = 2;
export const MAX_FEATURE_ID = 64;

/** Operator-facing label bound, matching `ModuleRegistration`'s own 120 columns. */
export const MAX_FEATURE_DISPLAY_NAME = 120;

/**
 * One grant call names between 1 and 64 tenants.
 *
 * 64 is the registry's own array bound (`MAX_TENANT_IDS`), reused deliberately so an
 * operator's muscle memory and the two surfaces' limits agree — and so a single call
 * cannot become an unbounded write. The FEATURE level has no 64-tenant ceiling on how
 * many tenants may hold a feature (one row per tenant, §43.12 item 1); the ceiling is
 * per REQUEST, which is what keeps one request bounded.
 */
export const MIN_GRANT_TENANT_IDS = 1;
export const MAX_GRANT_TENANT_IDS = 64;

/** Page size for the granted-tenant read; bounded like every other list in Core. */
export const FEATURE_TENANT_PAGE_SIZE = 20;
export const MAX_FEATURE_TENANT_PAGE_SIZE = 100;

/** Trims, and turns an emptied string into `undefined` so `@IsOptional()` sees `""` as absent. */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim()) : value;

/**
 * Coerces a query-string page size. A non-numeric string is left as-is so `@IsInt()` refuses it with a
 * `422` rather than `Number('abc') === NaN` reaching Prisma as `take: NaN`.
 */
const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

/**
 * The body that DECLARES a feature — `POST admin/modules/:moduleId/features` (§43.8).
 *
 * THERE IS NO `enabled` HERE, and its absence is a rule rather than an omission: §43.3 makes a
 * declared feature start `enabled = false`, so "declare" can never be the act that lights the
 * platform's offer. Turning the offer on is a PATCH, a separate act by a separate request, which is
 * what makes `module.feature.enabled` an audit action that names a decision instead of appearing as
 * a side effect of creating a row.
 */
export class DeclareFeatureDto {
  @Transform(trim)
  @IsString({ message: 'شناسه قابلیت باید متن باشد.' })
  @Matches(FEATURE_ID_PATTERN, {
    message:
      'شناسه قابلیت باید با حروف کوچک لاتین یا رقم شروع شود و فقط حروف کوچک لاتین، رقم و خط تیره داشته باشد.',
  })
  @MinLength(MIN_FEATURE_ID, { message: 'شناسه قابلیت باید حداقل ۲ نویسه باشد.' })
  @MaxLength(MAX_FEATURE_ID, { message: 'شناسه قابلیت باید حداکثر ۶۴ نویسه باشد.' })
  featureId!: string;

  @Transform(trim)
  @IsString({ message: 'نام نمایشی باید متن باشد.' })
  @MinLength(1, { message: 'نام نمایشی الزامی است.' })
  @MaxLength(MAX_FEATURE_DISPLAY_NAME, { message: 'نام نمایشی باید حداکثر ۱۲۰ نویسه باشد.' })
  displayName!: string;
}

/**
 * The tenant id bound, matching the registry's own `tenantIds` rule (`@MaxLength(64, { each: true })`).
 * Deliberately a LENGTH rule and not a UUID rule: the id's shape is `Tenant.id`'s business, and the
 * database's foreign key is the authority that decides whether the tenant exists. Re-declaring that
 * here would make a future non-uuid tenant id a `422` in Core's admin surface while the registry
 * happily accepted it.
 */
export const MAX_TENANT_ID_LENGTH = 64;

/**
 * The body of a rename / offer-toggle — `PATCH admin/modules/:moduleId/features/:featureId`.
 *
 * Both fields optional, neither able to name the module or the feature: those are path segments, so
 * the body cannot disagree with the route it was sent to. An empty body is refused by the service
 * rather than read as a no-op update, because an audited mutation that changed nothing is noise in
 * the trail an operator reads to answer "who turned Leave off?".
 */
export class UpdateFeatureDto {
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString({ message: 'نام نمایشی باید متن باشد.' })
  @MinLength(1, { message: 'نام نمایشی الزامی است.' })
  @MaxLength(MAX_FEATURE_DISPLAY_NAME, { message: 'نام نمایشی باید حداکثر ۱۲۰ نویسه باشد.' })
  displayName?: string;

  @IsOptional()
  @IsBoolean({ message: 'وضعیت ارائه قابلیت باید بولی باشد.' })
  enabled?: boolean;
}

/**
 * The grant body — `POST admin/modules/:moduleId/features/:featureId/tenants` (§43.8).
 *
 * THE TENANT IDS HERE ARE NOT A §25-RULE-7 VIOLATION, and the distinction is written down where a
 * reader would try to "fix" one rule into the other: that rule forbids a client from selecting the
 * TENANCY OF A REQUEST, whereas this body states a CONFIGURATION FACT about tenants the caller
 * administers — under a manage permission, recorded in the audit trail. Collapsing the two would
 * either break administration or let a caller claim a tenant.
 *
 * `moduleId` and `featureId` are PATH SEGMENTS, never body fields: a grant cannot be posted to one
 * route while naming another module's feature.
 */
export class GrantFeatureDto {
  @IsArray({ message: 'فهرست مستأجرها باید آرایه باشد.' })
  @ArrayMinSize(MIN_GRANT_TENANT_IDS, { message: 'دست‌کم یک مستأجر لازم است.' })
  @ArrayMaxSize(MAX_GRANT_TENANT_IDS, { message: 'در هر درخواست حداکثر ۶۴ مستأجر مجاز است.' })
  @IsString({ each: true, message: 'شناسه مستأجر باید متن باشد.' })
  @MaxLength(MAX_TENANT_ID_LENGTH, {
    each: true,
    message: 'شناسه مستأجر باید حداکثر ۶۴ نویسه باشد.',
  })
  tenantIds!: string[];
}

/**
 * The granted-tenant read's query: `?limit=&cursor=`.
 *
 * The route answers with a BARE ARRAY (the client's shape) and carries the continuation cursor in a
 * response header, so a tenant list longer than one page is never SILENTLY truncated: `limit` is
 * bounded, and the header is the honest "there is more" signal an operator can act on. `cursor` is the
 * last `tenantId` of the page just read — a keyset cursor, so inserts between two pages cannot make a
 * row appear twice or vanish.
 */
export class ListFeatureTenantsQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt({ message: 'تعداد سطرهای صفحه باید عدد باشد.' })
  @Min(1, { message: 'تعداد سطرهای صفحه باید دست‌کم ۱ باشد.' })
  @Max(MAX_FEATURE_TENANT_PAGE_SIZE, { message: 'تعداد سطرهای صفحه باید حداکثر ۱۰۰ باشد.' })
  limit?: number;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString({ message: 'نشانگر صفحه باید متن باشد.' })
  @MaxLength(MAX_TENANT_ID_LENGTH, { message: 'نشانگر صفحه باید حداکثر ۶۴ نویسه باشد.' })
  cursor?: string;
}
