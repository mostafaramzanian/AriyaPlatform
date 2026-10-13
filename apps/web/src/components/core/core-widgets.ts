/**
 * Phase 49K: client-side dashboard widget registry.
 *
 * THE MIRROR OF `apps/api/src/preferences/widget-catalogue.ts`. The ids here MUST
 * match that file exactly; the web app cannot import from `apps/api`, which is the
 * same constraint `core-nav.ts` already lives with for navigation targets.
 *
 * A widget EXISTS because a React component renders it — that is why the catalogue is
 * code and not data. What is user data is the LAYOUT: the order and visibility of
 * widgets that already exist. The server keeps the two apart on purpose:
 *
 *  - it REFUSES an unknown id on write, so a stale client fails loudly instead of
 *    storing a layout entry nothing can render;
 *  - it IGNORES an unknown id on read and APPENDS any widget the stored layout never
 *    mentioned, so a layout saved before this release still loads and automatically
 *    picks up widgets added since.
 *
 * The client therefore never has to reconcile a layout itself: `GET /me/preferences`
 * always returns the full, ordered registry. `defaultWidgetLayout` below exists only
 * for the pre-response render and for optimistic reordering.
 *
 * NO PERMISSION FIELD, matching the server. Every widget in this phase renders a
 * PERSONAL surface (the caller's own identity, RBAC summary, notifications, reminders
 * and navigation the shell already filters), so none has an admin-only data source to
 * gate. Each widget's DATA still comes from a route that enforces its own edge, so a
 * widget a user should not see renders empty rather than leaking. A widget with an
 * administrative source must be gated on its data route AND here — never only here.
 */

/**
 * Default dashboard order, and the source of truth for "which ids are widgets".
 *
 * Order matters: it is what a user who has never customised anything sees and what a
 * reset returns to. Identity and access come first (the data the previous dashboard
 * already showed), then the attention-demanding surfaces.
 *
 * Phase 49C-4: the two navigation-derived widgets (`quick-actions`, `modules`) left
 * the dashboard — quick access duplicated the sidebar, and the authorised-modules
 * surface moved to the Account Center (`/admin/profile?tab=modules`) as
 * `CoreModulesList`. Stored layouts that still mention the retired ids are dropped
 * by `resolveWidgetLayout` on read, exactly like the server's own read rule, so no
 * migration is needed.
 */
export const WIDGET_IDS = [
  'identity',
  'access',
  'notifications',
  'reminders',
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

const WIDGET_ID_SET: ReadonlySet<string> = new Set(WIDGET_IDS);

/** True when `id` is a widget this release can render. */
export function isKnownWidget(id: string): id is WidgetId {
  return WIDGET_ID_SET.has(id);
}

export interface WidgetLayoutEntry {
  id: string;
  visible: boolean;
}

/**
 * Persian labels for the layout editor and each widget's heading.
 *
 * Kept here rather than in the widget components so the settings UI can list widgets
 * it does not render, and so the label and the id can never drift apart.
 */
export const WIDGET_LABELS: Record<WidgetId, string> = {
  identity: 'حساب کاربری',
  access: 'نقش‌ها و دسترسی‌ها',
  notifications: 'اعلان‌ها',
  reminders: 'یادآورها',
};

/** The label for an id, falling back to the id so an unknown one is still nameable. */
export function widgetLabel(id: string): string {
  return isKnownWidget(id) ? WIDGET_LABELS[id] : id;
}

/**
 * How wide a widget renders in the two-column grid at `md:` and up.
 *
 * CLIENT-ONLY, AND NOT MIRRORED SERVER-SIDE — unlike the id set. A span is a
 * presentation fact about the component that renders the widget, so the API has no
 * reason to know it and no way to validate it; the server only ever needs to answer
 * "is this id a widget". Keeping it here also means changing a widget's width is not
 * a schema or contract change.
 *
 * Phase 49C-4: the two full-width navigation-derived cards (quick-actions, modules)
 * left the dashboard, so every remaining widget renders half-width. The record stays
 * so a future wide widget is a one-line change, not a mechanism change.
 */
export const WIDGET_SPAN: Record<WidgetId, boolean> = {
  identity: false,
  access: false,
  notifications: false,
  reminders: false,
};

/** True when the widget spans both columns. Unknown ids render half-width. */
export function isWideWidget(id: string): boolean {
  return isKnownWidget(id) ? WIDGET_SPAN[id] : false;
}

/**
 * The layout of a user who has never customised anything: every widget, in registry
 * order, visible.
 *
 * Used for the render BEFORE `GET /me/preferences` resolves. It is not the same as an
 * empty array: `[]` means "every widget hidden", a choice the user can make, while a
 * missing layout means "never chose".
 */
export function defaultWidgetLayout(): WidgetLayoutEntry[] {
  return WIDGET_IDS.map((id) => ({ id, visible: true }));
}

/**
 * Normalises a layout received from the server or held optimistically.
 *
 * Applies the same two rules the server's read path applies, so an optimistic local
 * reorder and the eventual server response resolve to the same list: unknown and
 * duplicate ids are DROPPED, then any widget the layout never mentioned is APPENDED
 * as visible. Never throws — a corrupt layout must not blank the dashboard.
 */
export function resolveWidgetLayout(entries: unknown): WidgetLayoutEntry[] {
  if (!Array.isArray(entries)) return defaultWidgetLayout();

  const resolved: WidgetLayoutEntry[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

    const { id, visible } = raw as { id?: unknown; visible?: unknown };
    if (typeof id !== 'string' || !isKnownWidget(id) || seen.has(id)) continue;

    seen.add(id);
    // A non-boolean `visible` reads as visible: showing a widget on a corrupt entry is
    // recoverable by the user, silently hiding one is not.
    resolved.push({ id, visible: visible !== false });
  }

  for (const id of WIDGET_IDS) {
    if (!seen.has(id)) resolved.push({ id, visible: true });
  }

  return resolved;
}
