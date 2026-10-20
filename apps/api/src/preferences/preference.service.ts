import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  MotionPreference,
  Prisma,
  ThemePreference,
  UIDensity,
} from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { MAX_NAV_RECENT, UpdatePreferenceDto } from './dto/preference.dto';
import { isExcludedFromRecent, isNavTargetAllowed } from './nav-catalogue';
import {
  WIDGET_IDS,
  defaultWidgetLayout,
  isKnownWidget,
  type WidgetLayoutEntry,
} from './widget-catalogue';

/**
 * Phase 49K: unified personalization.
 *
 * Scope is USER-OWNED, resolved from `RequestContextService` exactly as
 * NotificationService (49E), MessagingService (49F), SupportService (49G),
 * SurveysService (49H) and ReminderService (49I) do. No method takes an owner
 * parameter it trusts, and no route exposes one, so nothing here can reach another
 * user's preferences.
 *
 * NO TENANT PREDICATE, and unlike every service listed above that is correct rather
 * than an omission: `UserPreference` has no `tenantId` column. A user's text scale and
 * theme are a property of the PERSON, not of the tenant they are currently acting in —
 * making them tenant-scoped would reset the accessibility settings of anyone who moves
 * between tenants, which is the opposite of what an accessibility preference is for.
 * The one tenant-sensitive value, `navFavorites`, is protected by re-applying live
 * RBAC on every read instead.
 *
 * NO PERMISSION GATE. Choosing one's own theme is an ordinary authenticated-user
 * capability; ownership is the authorization edge. `PermissionService` is injected to
 * FILTER what is returned, never to decide whether the caller may read their own row.
 *
 * TWO RULES THIS SERVICE EXISTS TO ENFORCE, because neither SQL nor the DTO can:
 *
 *  1. AN HREF MUST BE A REAL NAVIGATION TARGET THE CALLER MAY OPEN. The CHECK
 *     constraints count the arrays; only this layer knows the navigation tree
 *     (`nav-catalogue.ts`) and the caller's permissions.
 *  2. A GET MUST NOT WRITE. A user with no row gets code-level defaults and no row is
 *     created. The row appears on the first PATCH, so the table's size tracks users
 *     who actually personalised something.
 */

/**
 * Allowlisted projection. `id`, `userId` and `createdAt` are deliberately absent: the
 * owner is always the caller, the surrogate key is never addressed by any route
 * (`/me/preferences` has no `:id`), and the creation date of a settings row is
 * internal bookkeeping with no consumer in the UI.
 */
const PREFERENCE_SELECT = {
  theme: true,
  density: true,
  textScale: true,
  motion: true,
  sidebarCollapsed: true,
  navFavoritesEnabled: true,
  navRecentEnabled: true,
  navFavorites: true,
  navRecent: true,
  dashboardLayout: true,
  updatedAt: true,
} satisfies Prisma.UserPreferenceSelect;

type PreferenceRow = Prisma.UserPreferenceGetPayload<{ select: typeof PREFERENCE_SELECT }>;

export interface PreferenceDto {
  theme: ThemePreference;
  density: UIDensity;
  textScale: number;
  motion: MotionPreference;
  sidebarCollapsed: boolean;
  /** Opt-in feature switches — both default false. */
  navFavoritesEnabled: boolean;
  navRecentEnabled: boolean;
  /** Already filtered to targets the caller may currently open. */
  navFavorites: string[];
  /** Already filtered, and never contains an audit surface. */
  navRecent: string[];
  /** Always the full registry, ordered; hidden widgets carry `visible: false`. */
  dashboardLayout: WidgetLayoutEntry[];
  /**
   * False when no row exists and every value above is a code-level default. Lets the
   * client show "using defaults" honestly instead of implying a saved choice.
   */
  customized: boolean;
  /** Null while `customized` is false — there is nothing to have been updated. */
  updatedAt: Date | null;
}

/**
 * The defaults an untouched account sees. These MUST match the `@default(...)`
 * annotations on `UserPreference`, and are restated here rather than read from the
 * database precisely so that reading them requires no row to exist.
 */
export const PREFERENCE_DEFAULTS = {
  theme: ThemePreference.SYSTEM,
  density: UIDensity.COMFORTABLE,
  textScale: 100,
  motion: MotionPreference.SYSTEM,
  sidebarCollapsed: false,
  navFavoritesEnabled: false,
  navRecentEnabled: false,
} as const;

/**
 * The scalar payload shared by both halves of the upsert.
 *
 * Deliberately NOT `Prisma.UserPreferenceUpdateInput`: that type carries a `user`
 * relation field and wraps every scalar in a `…FieldUpdateOperationsInput`, neither of
 * which a `create` accepts, so one payload could not serve both branches. Plain scalars
 * are assignable to the create and the update input alike, which is what lets an
 * omitted field be genuinely absent from BOTH — the property that makes PATCH
 * semantics work on a row that may not exist yet.
 */
type PreferenceWriteData = {
  theme?: ThemePreference;
  density?: UIDensity;
  textScale?: number;
  motion?: MotionPreference;
  sidebarCollapsed?: boolean;
  navFavoritesEnabled?: boolean;
  navRecentEnabled?: boolean;
  navFavorites?: string[];
  navRecent?: string[];
  dashboardLayout?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;
};

@Injectable()
export class PreferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The authenticated subject, and the ONLY source of ownership in this service.
   *
   * Asserted against the id the controller passed in rather than trusting it, the same
   * defence `ReminderService.scope` applies: if the two ever disagree the request is
   * refused instead of silently acting on whichever one is more convenient.
   */
  private subject(userId: string): string {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Preference context is required');
    }

    return userId;
  }

  /** The caller's live permission set, used only to FILTER what is returned. */
  private async grantedPermissions(userId: string): Promise<ReadonlySet<string>> {
    return new Set(await this.permissions.getUserPermissions(userId));
  }

  /**
   * Reads the caller's preferences, or the code-level defaults when they have never
   * saved any.
   *
   * DOES NOT WRITE — no upsert, no "create if missing", no `updatedAt` touch. That is
   * the rule the schema comment states and the one a spec asserts directly, because a
   * GET that created a row would make every authenticated page load a write and would
   * make "has this user personalised anything?" unanswerable.
   */
  async getMine(userId: string): Promise<PreferenceDto> {
    const subject = this.subject(userId);

    const [row, granted] = await Promise.all([
      this.prisma.userPreference.findUnique({
        where: { userId: subject },
        select: PREFERENCE_SELECT,
      }),
      this.grantedPermissions(subject),
    ]);

    if (!row) {
      return {
        ...PREFERENCE_DEFAULTS,
        navFavorites: [],
        navRecent: [],
        dashboardLayout: defaultWidgetLayout(),
        customized: false,
        updatedAt: null,
      };
    }

    return this.present(row, granted);
  }

  /**
   * Projects a stored row through the caller's CURRENT permissions and the CURRENT
   * registries.
   *
   * Everything here is a filter, never an error: a favourite whose permission was
   * revoked, or a widget a later release retired, simply stops being returned. Failing
   * the read instead would make a stale row lock a user out of their own dashboard,
   * and would require a migration every time a widget is renamed.
   */
  private present(row: PreferenceRow, granted: ReadonlySet<string>): PreferenceDto {
    return {
      theme: row.theme,
      density: row.density,
      textScale: row.textScale,
      motion: row.motion,
      sidebarCollapsed: row.sidebarCollapsed,
      navFavoritesEnabled: row.navFavoritesEnabled,
      navRecentEnabled: row.navRecentEnabled,
      navFavorites: row.navFavorites.filter((href) => isNavTargetAllowed(href, granted)),
      navRecent: row.navRecent.filter(
        (href) => isNavTargetAllowed(href, granted) && !isExcludedFromRecent(href),
      ),
      dashboardLayout: this.resolveLayout(row.dashboardLayout),
      customized: true,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Turns the stored JSON into the full, ordered registry.
   *
   * Three stored states, three distinct outcomes:
   *
   *  - NULL → the registry default, every widget visible. "Never customised."
   *  - a JSON array → stored order first, unknown ids DROPPED, then any widget the
   *    array never mentioned APPENDED as visible. Appending is what makes a new widget
   *    appear for users who saved a layout before it existed, instead of being
   *    invisible to exactly the established users most likely to want it.
   *  - anything else → treated as NULL. The `UserPreference_dashboardLayout_is_array`
   *    CHECK already makes a non-array impossible, so this branch is a belt-and-braces
   *    guard for rows written outside the API rather than an expected path.
   */
  private resolveLayout(stored: Prisma.JsonValue | null): WidgetLayoutEntry[] {
    if (stored === null || !Array.isArray(stored)) {
      return defaultWidgetLayout();
    }

    const resolved: WidgetLayoutEntry[] = [];
    const seen = new Set<string>();

    for (const raw of stored) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const entry = raw as Record<string, unknown>;
      const id = entry.id;

      if (typeof id !== 'string' || !isKnownWidget(id) || seen.has(id)) continue;

      seen.add(id);
      // A non-boolean `visible` is read as "visible": showing a widget on a corrupt
      // row is recoverable by the user, silently hiding one is not.
      resolved.push({ id, visible: entry.visible !== false });
    }

    for (const id of WIDGET_IDS) {
      if (!seen.has(id)) resolved.push({ id, visible: true });
    }

    return resolved;
  }

  /**
   * Applies a partial update and returns the full, re-filtered result.
   *
   * An UPSERT on the unique `userId`, which is the whole reason that column is unique:
   * a find-then-create would let two concurrent first-PATCHes both see "no row" and
   * both insert. Fields absent from the DTO appear in neither the `create` nor the
   * `update` payload, so an omitted field keeps its stored value (or its schema
   * default on first write) instead of being reset to one.
   */
  async updateMine(userId: string, dto: UpdatePreferenceDto): Promise<PreferenceDto> {
    const subject = this.subject(userId);
    const granted = await this.grantedPermissions(subject);
    const data = this.buildWriteData(dto, granted);

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one preference field must be provided');
    }

    const row = await this.prisma.userPreference.upsert({
      where: { userId: subject },
      create: { userId: subject, ...data },
      update: data,
      select: PREFERENCE_SELECT,
    });

    return this.present(row, granted);
  }

  /**
   * Translates a validated DTO into a Prisma payload, applying the rules the DTO
   * cannot express.
   *
   * WRITES ARE STRICTER THAN READS, deliberately. An unknown widget id or an
   * unreachable href is REFUSED here, while the read path silently drops it. A write is
   * a fresh statement of intent that the client can correct, so failing loudly surfaces
   * the bug; a read is historical and must never fail.
   */
  private buildWriteData(
    dto: UpdatePreferenceDto,
    granted: ReadonlySet<string>,
  ): PreferenceWriteData {
    const data: PreferenceWriteData = {};

    if (dto.theme !== undefined) data.theme = dto.theme;
    if (dto.density !== undefined) data.density = dto.density;
    if (dto.textScale !== undefined) data.textScale = dto.textScale;
    if (dto.motion !== undefined) data.motion = dto.motion;
    if (dto.sidebarCollapsed !== undefined) data.sidebarCollapsed = dto.sidebarCollapsed;
    if (dto.navFavoritesEnabled !== undefined)
      data.navFavoritesEnabled = dto.navFavoritesEnabled;
    if (dto.navRecentEnabled !== undefined) data.navRecentEnabled = dto.navRecentEnabled;

    if (dto.navFavorites !== undefined) {
      data.navFavorites = this.sanitizeFavorites(dto.navFavorites, granted);
    }

    if (dto.navRecent !== undefined) {
      data.navRecent = this.sanitizeRecent(dto.navRecent, granted);
    }

    if (dto.dashboardLayout !== undefined && dto.resetDashboardLayout) {
      throw new BadRequestException(
        'dashboardLayout and resetDashboardLayout cannot be sent together',
      );
    }

    if (dto.dashboardLayout !== undefined) {
      data.dashboardLayout = this.sanitizeLayout(dto.dashboardLayout);
    } else if (dto.resetDashboardLayout) {
      // Prisma.DbNull, not JS `null`: on a `Json?` column plain `null` means the JSON
      // value `null` rather than SQL NULL, and only SQL NULL is the "never customised"
      // state `resolveLayout` recognises.
      data.dashboardLayout = Prisma.DbNull;
    }

    return data;
  }

  /**
   * Deduplicates favourites, preserving the user's chosen order, and refuses any href
   * that is not a target the caller may open.
   *
   * DEDUPLICATION IS SILENT because a duplicate is unambiguous — the user pinned one
   * page, twice — and the first occurrence is the position they picked. An UNKNOWN or
   * FORBIDDEN href is refused with one message that does not say which, so a write
   * cannot be used to discover pages behind a permission the caller lacks.
   */
  private sanitizeFavorites(hrefs: string[], granted: ReadonlySet<string>): string[] {
    const result: string[] = [];

    for (const href of hrefs) {
      if (!isNavTargetAllowed(href, granted)) {
        throw new BadRequestException('navFavorites contains an unavailable route');
      }

      if (!result.includes(href)) result.push(href);
    }

    return result;
  }

  /**
   * Deduplicates recent entries newest-first and hard-trims to `MAX_NAV_RECENT`.
   *
   * UNAVAILABLE AND EXCLUDED HREFS ARE DROPPED, NOT REFUSED — the opposite of
   * `navFavorites`, and the difference is intentional. A favourite is an explicit,
   * deliberate act, so a bad one is a client bug worth surfacing. Recents are recorded
   * automatically as the user browses: rejecting the batch would mean one visit to an
   * excluded route silently breaks history tracking for the whole session, and would
   * hand the client a way to make a security page detectable by watching for a 400.
   * Trimming is applied AFTER filtering so dropped entries do not consume slots.
   */
  private sanitizeRecent(hrefs: string[], granted: ReadonlySet<string>): string[] {
    const result: string[] = [];

    for (const href of hrefs) {
      if (!isNavTargetAllowed(href, granted)) continue;
      if (isExcludedFromRecent(href)) continue;
      if (result.includes(href)) continue;

      result.push(href);

      if (result.length === MAX_NAV_RECENT) break;
    }

    return result;
  }

  /**
   * Validates a submitted layout and stores it as a plain JSON array.
   *
   * Unknown ids and duplicates are REFUSED rather than dropped: a layout is submitted
   * wholesale by a client that just read the registry, so either one means the client
   * and the server disagree about what exists — and quietly storing a corrected version
   * would leave that disagreement in place until it produced a stranger bug.
   *
   * WIDGETS THE CLIENT DID NOT MENTION ARE NOT ADDED HERE. `resolveLayout` appends them
   * on read, so a partial layout stays partial in storage and automatically absorbs
   * widgets added later, instead of freezing today's registry into the row.
   */
  private sanitizeLayout(
    entries: { id: string; visible: boolean }[],
  ): Prisma.InputJsonValue {
    const seen = new Set<string>();
    const layout: WidgetLayoutEntry[] = [];

    for (const entry of entries) {
      if (!isKnownWidget(entry.id)) {
        throw new BadRequestException(`Unknown dashboard widget: ${entry.id}`);
      }

      if (seen.has(entry.id)) {
        throw new BadRequestException(`Duplicate dashboard widget: ${entry.id}`);
      }

      seen.add(entry.id);
      layout.push({ id: entry.id, visible: entry.visible });
    }

    return layout as unknown as Prisma.InputJsonValue;
  }
}
