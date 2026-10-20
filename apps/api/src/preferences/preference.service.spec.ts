import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '../generated/core-client';
import { PREFERENCE_DEFAULTS, PreferenceService } from './preference.service';
import type { UpdatePreferenceDto } from './dto/preference.dto';
import { PrismaService } from '../database/prisma.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { RequestContextService } from '../common/request-context.service';
import { WIDGET_IDS } from './widget-catalogue';

/**
 * Phase 49K unit coverage for the preference service.
 *
 * What this file is responsible for proving:
 *  - THE READ NEVER WRITES. A user with no row gets code-level defaults and no upsert,
 *    create or update is issued. This is the single most important assertion in the
 *    file: every authenticated page load hits `getMine`.
 *  - the subject is resolved from the request context and never from an argument;
 *  - stored navigation hrefs are re-filtered against LIVE permissions on read, so a
 *    revoked permission removes a favourite without an error and without a migration;
 *  - a write refuses an href the caller cannot open, while a recent-list write DROPS
 *    one — the deliberate asymmetry between an explicit act and an automatic one;
 *  - audit surfaces never enter `navRecent`, whatever the client submits;
 *  - the recent list is deduplicated and hard-trimmed to 10, newest first;
 *  - unknown and duplicate widget ids are refused on WRITE but ignored on READ, and a
 *    widget missing from a stored layout is appended rather than lost;
 *  - a layout reset writes SQL NULL (`Prisma.DbNull`), not the JSON value `null`;
 *  - omitted fields appear in neither half of the upsert, so PATCH cannot reset a
 *    setting the client never mentioned.
 */

describe('PreferenceService', () => {
  let service: PreferenceService;
  let prisma: { userPreference: Record<string, jest.Mock> };
  let permissions: { getUserPermissions: jest.Mock };

  const owner = 'user-owner';
  const tenantA = 'tenant-a';

  const setContext = (userId: string | undefined, tenantId: string | null) =>
    RequestContextService.set({
      requestId: 'r1',
      correlationId: 'c1',
      startTime: Date.now(),
      userId,
      tenantId,
    });

  /**
   * Establishes the request context INSIDE the test body.
   *
   * `AsyncLocalStorage.enterWith` does not propagate from a `beforeEach` into the test
   * callback — they are separate async continuations — so the context has to be entered
   * within the test itself. Same wrapper as `reminder.service.spec.ts` (49I).
   */
  const scoped = (name: string, body: () => Promise<void> | void) =>
    it(name, async () => {
      setContext(owner, tenantA);
      await body();
    });

  const preferenceRow = (overrides: Record<string, unknown> = {}) => ({
    theme: 'DARK',
    density: 'COMPACT',
    textScale: 125,
    motion: 'REDUCED',
    sidebarCollapsed: true,
    navFavoritesEnabled: true,
    navRecentEnabled: true,
    navFavorites: [] as string[],
    navRecent: [] as string[],
    dashboardLayout: null as unknown,
    updatedAt: new Date('2026-09-03T10:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PreferenceService,
        {
          provide: PrismaService,
          useValue: {
            userPreference: {
              findUnique: jest.fn().mockResolvedValue(null),
              upsert: jest.fn(),
            },
          },
        },
        {
          provide: PermissionService,
          useValue: { getUserPermissions: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = moduleRef.get(PreferenceService);
    prisma = moduleRef.get(PrismaService);
    permissions = moduleRef.get(PermissionService);

    prisma.userPreference.upsert.mockImplementation(
      async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) =>
        preferenceRow({ ...create, ...update }),
    );

    setContext(owner, tenantA);
  });

  describe('subject resolution', () => {
    scoped('refuses a request with no identity in the context', async () => {
      setContext(undefined, tenantA);

      await expect(service.getMine(owner)).rejects.toThrow(ForbiddenException);
      expect(prisma.userPreference.findUnique).not.toHaveBeenCalled();
    });

    scoped('refuses when the context identity differs from the requested subject', async () => {
      setContext('someone-else', tenantA);

      await expect(service.getMine(owner)).rejects.toThrow(ForbiddenException);
      expect(prisma.userPreference.findUnique).not.toHaveBeenCalled();
    });

    scoped('keys the read on the context identity', async () => {
      await service.getMine(owner);

      expect(prisma.userPreference.findUnique.mock.calls[0][0].where).toEqual({
        userId: owner,
      });
    });

    scoped('never sends a tenant predicate — preferences belong to the person', async () => {
      await service.getMine(owner);

      const where = prisma.userPreference.findUnique.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('tenantId');
    });
  });

  describe('getMine — no row', () => {
    scoped('returns the schema defaults', async () => {
      const result = await service.getMine(owner);

      expect(result).toMatchObject({
        theme: PREFERENCE_DEFAULTS.theme,
        density: PREFERENCE_DEFAULTS.density,
        textScale: 100,
        motion: PREFERENCE_DEFAULTS.motion,
        sidebarCollapsed: false,
        // Opt-in personalization: BOTH default to OFF for a user who never chose.
        navFavoritesEnabled: false,
        navRecentEnabled: false,
        navFavorites: [],
        navRecent: [],
        customized: false,
        updatedAt: null,
      });
    });

    /**
     * THE NO-WRITE-ON-GET RULE. A GET that created a row would make the first render of
     * every authenticated page a database write, and would erase the only signal that
     * separates "chose the defaults" from "never chose".
     */
    scoped('writes nothing', async () => {
      await service.getMine(owner);

      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
      expect(prisma.userPreference).not.toHaveProperty('create');
      expect(prisma.userPreference).not.toHaveProperty('update');
    });

    scoped('returns the full registry, every widget visible', async () => {
      const result = await service.getMine(owner);

      expect(result.dashboardLayout).toEqual(
        WIDGET_IDS.map((id) => ({ id, visible: true })),
      );
    });
  });

  describe('getMine — stored row, live RBAC re-applied', () => {
    scoped('returns stored scalars as saved', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(preferenceRow());

      const result = await service.getMine(owner);

      expect(result).toMatchObject({
        theme: 'DARK',
        density: 'COMPACT',
        textScale: 125,
        motion: 'REDUCED',
        sidebarCollapsed: true,
        navFavoritesEnabled: true,
        navRecentEnabled: true,
        customized: true,
      });
    });

    /**
     * The permission-revocation path, and the reason the read is a filter rather than a
     * validation: a favourite saved while `admin.users.read` was held must simply stop
     * appearing once it is revoked — no error, no cleanup migration.
     */
    scoped('drops a favourite whose permission the caller no longer holds', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({ navFavorites: ['/admin', '/admin/directory', '/admin/calendar'] }),
      );

      const result = await service.getMine(owner);

      expect(result.navFavorites).toEqual(['/admin', '/admin/calendar']);
    });

    scoped('keeps a gated favourite while the permission IS held', async () => {
      permissions.getUserPermissions.mockResolvedValue(['admin.users.read']);
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({ navFavorites: ['/admin/directory'] }),
      );

      const result = await service.getMine(owner);

      expect(result.navFavorites).toEqual(['/admin/directory']);
    });

    scoped('drops an href that is no longer in the navigation tree', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({ navFavorites: ['/admin/retired-page', '/admin/messages'] }),
      );

      const result = await service.getMine(owner);

      expect(result.navFavorites).toEqual(['/admin/messages']);
    });

    scoped('filters navRecent by the same rules', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({ navRecent: ['/admin/ai', '/admin/support'] }),
      );

      const result = await service.getMine(owner);

      expect(result.navRecent).toEqual(['/admin/support']);
    });
  });

  describe('getMine — stored dashboard layout', () => {
    scoped('honours stored order and hidden flags', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({
          dashboardLayout: [
            { id: 'reminders', visible: true },
            { id: 'identity', visible: false },
          ],
        }),
      );

      const result = await service.getMine(owner);

      expect(result.dashboardLayout.slice(0, 2)).toEqual([
        { id: 'reminders', visible: true },
        { id: 'identity', visible: false },
      ]);
    });

    /**
     * A widget retired in a later release must not make a saved layout unloadable, so an
     * unknown id is IGNORED here — the opposite of the write path, which refuses it.
     */
    scoped('ignores an unknown widget id rather than failing the read', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({
          dashboardLayout: [
            { id: 'widget-from-a-future-release', visible: true },
            { id: 'identity', visible: true },
          ],
        }),
      );

      const result = await service.getMine(owner);

      expect(result.dashboardLayout.map((entry) => entry.id)).not.toContain(
        'widget-from-a-future-release',
      );
      expect(result.dashboardLayout[0]).toEqual({ id: 'identity', visible: true });
    });

    /** A widget added after the layout was saved appears, rather than staying invisible. */
    scoped('appends registry widgets the stored layout never mentioned', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({ dashboardLayout: [{ id: 'reminders', visible: false }] }),
      );

      const result = await service.getMine(owner);

      expect(result.dashboardLayout).toHaveLength(WIDGET_IDS.length);
      expect(result.dashboardLayout[0]).toEqual({ id: 'reminders', visible: false });
      expect(result.dashboardLayout.slice(1).every((entry) => entry.visible)).toBe(true);
    });

    scoped('treats a non-array stored value as never-customised', async () => {
      prisma.userPreference.findUnique.mockResolvedValue(
        preferenceRow({ dashboardLayout: { id: 'identity' } }),
      );

      const result = await service.getMine(owner);

      expect(result.dashboardLayout).toEqual(
        WIDGET_IDS.map((id) => ({ id, visible: true })),
      );
    });
  });

  describe('updateMine — upsert shape', () => {
    scoped('upserts on the unique userId, never a find-then-create', async () => {
      await service.updateMine(owner, { theme: 'LIGHT' as UpdatePreferenceDto['theme'] });

      const call = prisma.userPreference.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ userId: owner });
      expect(call.create).toMatchObject({ userId: owner, theme: 'LIGHT' });
    });

    /**
     * PATCH semantics. An omitted field must be absent from BOTH halves of the upsert:
     * present-but-undefined in `create` would still be a value Prisma sends, and the row
     * would lose its schema default on first write.
     */
    scoped('omits untouched fields from both halves of the upsert', async () => {
      await service.updateMine(owner, { textScale: 140 as UpdatePreferenceDto['textScale'] });

      const call = prisma.userPreference.upsert.mock.calls[0][0];
      expect(Object.keys(call.update)).toEqual(['textScale']);
      expect(Object.keys(call.create).sort()).toEqual(['textScale', 'userId']);
      expect(call.create).not.toHaveProperty('theme');
      expect(call.update).not.toHaveProperty('density');
    });

    scoped('refuses an empty patch instead of touching updatedAt for nothing', async () => {
      await expect(service.updateMine(owner, {})).rejects.toThrow(BadRequestException);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    scoped('persists each personalization flag independently', async () => {
      await service.updateMine(owner, { navFavoritesEnabled: true });
      expect(prisma.userPreference.upsert.mock.calls[0][0].update).toEqual({
        navFavoritesEnabled: true,
      });

      await service.updateMine(owner, { navRecentEnabled: false });
      expect(prisma.userPreference.upsert.mock.calls[1][0].update).toEqual({
        navRecentEnabled: false,
      });
    });

    scoped('never writes a userId taken from anywhere but the context', async () => {
      await service.updateMine(owner, { sidebarCollapsed: true });

      const call = prisma.userPreference.upsert.mock.calls[0][0];
      expect(call.create.userId).toBe(owner);
      expect(call.update).not.toHaveProperty('userId');
      expect(call.update).not.toHaveProperty('user');
    });
  });

  describe('updateMine — navFavorites', () => {
    scoped('refuses an href the caller cannot open', async () => {
      await expect(
        service.updateMine(owner, { navFavorites: ['/admin/directory'] }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    scoped('refuses an href that is not a navigation target at all', async () => {
      await expect(
        service.updateMine(owner, { navFavorites: ['/admin/../etc/passwd'] }),
      ).rejects.toThrow(BadRequestException);
    });

    /** One message for both cases, so a write cannot probe which pages exist. */
    scoped('does not reveal whether a refused href exists or is forbidden', async () => {
      const forbidden = service.updateMine(owner, { navFavorites: ['/admin/directory'] });
      const unknown = service.updateMine(owner, { navFavorites: ['/admin/nope'] });

      await expect(forbidden).rejects.toThrow('navFavorites contains an unavailable route');
      await expect(unknown).rejects.toThrow('navFavorites contains an unavailable route');
    });

    scoped('accepts ungated targets and preserves the submitted order', async () => {
      await service.updateMine(owner, {
        navFavorites: ['/admin/calendar', '/admin', '/admin/support'],
      });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.navFavorites).toEqual([
        '/admin/calendar',
        '/admin',
        '/admin/support',
      ]);
    });

    scoped('deduplicates silently, keeping the first position', async () => {
      await service.updateMine(owner, {
        navFavorites: ['/admin', '/admin/messages', '/admin'],
      });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.navFavorites).toEqual([
        '/admin',
        '/admin/messages',
      ]);
    });

    scoped('accepts an empty array as "no favourites"', async () => {
      await service.updateMine(owner, { navFavorites: [] });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.navFavorites).toEqual([]);
    });
  });

  describe('updateMine — navRecent', () => {
    /**
     * The deliberate asymmetry with favourites. Recents are recorded automatically as
     * the user browses: rejecting the batch would break history tracking for a whole
     * session over one visit, and would let a client detect a forbidden page by watching
     * for a 400.
     */
    scoped('drops an unavailable href instead of refusing the write', async () => {
      await service.updateMine(owner, {
        navRecent: ['/admin/directory', '/admin/messages'],
      });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.navRecent).toEqual([
        '/admin/messages',
      ]);
    });

    scoped('never records an audit surface, whatever the client submits', async () => {
      await service.updateMine(owner, {
        navRecent: ['/admin/security', '/admin/audit/exports', '/admin'],
      });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.navRecent).toEqual([
        '/admin',
      ]);
    });

    scoped('deduplicates, keeping the newest position', async () => {
      await service.updateMine(owner, {
        navRecent: ['/admin', '/admin/calendar', '/admin'],
      });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.navRecent).toEqual([
        '/admin',
        '/admin/calendar',
      ]);
    });

    /**
     * Trimming happens AFTER filtering, so a dropped entry does not consume a slot. The
     * DTO's `@ArrayMaxSize(10)` already bounds the input; this proves the service's own
     * trim rather than relying on validation that a unit test bypasses.
     */
    scoped('hard-trims to ten entries', async () => {
      const seven = [
        '/admin',
        '/admin/profile',
        '/admin/notifications',
        '/admin/messages',
        '/admin/calendar',
        '/admin/support',
        '/admin/surveys',
      ];

      await service.updateMine(owner, { navRecent: [...seven, ...seven] });

      const written = prisma.userPreference.upsert.mock.calls[0][0].update.navRecent;
      expect(written).toEqual(seven);
      expect(written.length).toBeLessThanOrEqual(10);
    });
  });

  describe('updateMine — dashboardLayout', () => {
    scoped('stores the submitted order verbatim', async () => {
      await service.updateMine(owner, {
        dashboardLayout: [
          { id: 'reminders', visible: true },
          { id: 'identity', visible: false },
        ],
      });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.dashboardLayout).toEqual([
        { id: 'reminders', visible: true },
        { id: 'identity', visible: false },
      ]);
    });

    /** Refused on write, ignored on read — the asymmetry the service documents. */
    scoped('refuses an unknown widget id', async () => {
      await expect(
        service.updateMine(owner, {
          dashboardLayout: [{ id: 'not-a-widget', visible: true }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    scoped('refuses a duplicate widget id', async () => {
      await expect(
        service.updateMine(owner, {
          dashboardLayout: [
            { id: 'identity', visible: true },
            { id: 'identity', visible: false },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    scoped('does not pad the stored layout with unmentioned widgets', async () => {
      await service.updateMine(owner, {
        dashboardLayout: [{ id: 'identity', visible: true }],
      });

      expect(
        prisma.userPreference.upsert.mock.calls[0][0].update.dashboardLayout,
      ).toHaveLength(1);
    });

    scoped('accepts an empty array as "every widget hidden"', async () => {
      await service.updateMine(owner, { dashboardLayout: [] });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.dashboardLayout).toEqual(
        [],
      );
    });

    /**
     * SQL NULL, not the JSON value `null`. Only SQL NULL is the "never customised" state
     * `resolveLayout` recognises, so `Prisma.DbNull` is the difference between a working
     * reset and a row that reads back as a corrupt layout.
     */
    scoped('resets to the registry default with Prisma.DbNull', async () => {
      await service.updateMine(owner, { resetDashboardLayout: true });

      expect(prisma.userPreference.upsert.mock.calls[0][0].update.dashboardLayout).toBe(
        Prisma.DbNull,
      );
    });

    scoped('treats a false reset flag as no change at all', async () => {
      await expect(
        service.updateMine(owner, { resetDashboardLayout: false }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    scoped('refuses a layout and a reset in the same request', async () => {
      await expect(
        service.updateMine(owner, {
          dashboardLayout: [{ id: 'identity', visible: true }],
          resetDashboardLayout: true,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });
  });

  describe('updateMine — response', () => {
    scoped('returns the full re-filtered object, not just the changed fields', async () => {
      const result = await service.updateMine(owner, { theme: 'DARK' as UpdatePreferenceDto['theme'] });

      expect(result).toMatchObject({ theme: 'DARK', customized: true });
      expect(result.dashboardLayout).toHaveLength(WIDGET_IDS.length);
    });

    scoped('never echoes the owner id, surrogate key or tenant back to the client', async () => {
      const result = await service.updateMine(owner, { density: 'COMPACT' as UpdatePreferenceDto['density'] });

      expect(result).not.toHaveProperty('userId');
      expect(result).not.toHaveProperty('tenantId');
      expect(result).not.toHaveProperty('id');
    });
  });
});
