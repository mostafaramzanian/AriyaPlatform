/**
 * Phase 49K: server-side mirror of the dashboard widget registry.
 *
 * WHY A SECOND COPY OF THE ID LIST
 * --------------------------------
 * The widget CATALOGUE is code, not data (see the scope-decision comment above
 * `UserPreference` in `prisma/core/schema.prisma`): a widget exists only if a React
 * component renders it. What is user data is the LAYOUT — the order and visibility of
 * widgets that already exist — and a layout referring to a widget nothing renders is
 * exactly the failure mode the schema comment refuses to persist.
 *
 * The service therefore needs to know the id set to answer two questions the database
 * cannot:
 *
 *  - on WRITE, is this id a widget at all? An unknown id is refused, so a typo in a
 *    layout PATCH fails loudly instead of being stored and then silently dropped.
 *  - on READ, is this id STILL a widget? Ids that have since been removed from the
 *    registry are IGNORED rather than rejected, so a layout saved before a release
 *    that retired a widget stays loadable.
 *
 * Those two rules are deliberately asymmetric. A write is a fresh statement of intent
 * and can be corrected by the client; a read is historical and must not fail.
 *
 * The ids here MUST match `apps/web/src/components/core/core-widgets.ts`. The API
 * cannot import from `apps/web`, the same constraint `nav-catalogue.ts` documents.
 *
 * NO PERMISSION FIELD, and that is a decision. Every widget in this phase renders a
 * PERSONAL surface — the caller's own identity, their own RBAC summary, their own
 * notifications (49E), their own reminders (49I), and navigation the shell already
 * filters — so none of them has an admin-only data source to gate. Widget-level RBAC
 * is not therefore absent from the design: each widget's DATA comes from a route that
 * enforces its own authorization edge, so a widget a user should not see renders
 * empty rather than leaking. When a widget with an administrative source is added,
 * the gate belongs next to its id here AND on its data route — never only here.
 */

/**
 * Default dashboard order, and the source of truth for "which ids are widgets".
 *
 * Order matters: this is the layout a user who has never customised anything sees,
 * and it is the order a reset returns to. It runs from identity and access (what the
 * previous dashboard already showed, kept because it was honest data) to the
 * attention-demanding surfaces (notifications, reminders) and finally the navigation
 * aids.
 */
export const WIDGET_IDS = [
  'identity',
  'access',
  'notifications',
  'reminders',
  'quick-actions',
  'modules',
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

const WIDGET_ID_SET: ReadonlySet<string> = new Set(WIDGET_IDS);

/** True when `id` is a widget the current release can render. */
export function isKnownWidget(id: string): id is WidgetId {
  return WIDGET_ID_SET.has(id);
}

export interface WidgetLayoutEntry {
  id: string;
  visible: boolean;
}

/**
 * The layout of a user who has never customised anything: every widget, in registry
 * order, visible.
 *
 * Returned for a NULL `dashboardLayout` — which is not the same as an empty array.
 * NULL means "never customised"; `[]` means "every widget hidden", and both are legal
 * states the schema keeps distinguishable on purpose.
 */
export function defaultWidgetLayout(): WidgetLayoutEntry[] {
  return WIDGET_IDS.map((id) => ({ id, visible: true }));
}
