/**
 * Phase 49J: navigation targets for search results.
 *
 * Routes are built from these constants and an id, NEVER from user-supplied text, so
 * a result cannot inject a URL. Every path below corresponds to a page that actually
 * exists in `apps/web/src/app` — verified against the route tree, because a search
 * result that navigates to a 404 is worse than no result.
 */

const ADMIN = '/admin';

export const SEARCH_ROUTES = {
  TICKET: `${ADMIN}/support`,
  SURVEY: `${ADMIN}/surveys`,
  MESSAGES: `${ADMIN}/messages`,
  NOTIFICATIONS: `${ADMIN}/notifications`,
  CALENDAR: `${ADMIN}/calendar`,
  DIRECTORY: `${ADMIN}/directory`,
} as const;

/** `/admin/support/<id>` — the ticket detail page. */
export function ticketHref(ticketId: string): string {
  return `${SEARCH_ROUTES.TICKET}/${ticketId}`;
}

/** `/admin/surveys/<id>` — the survey detail page. */
export function surveyHref(surveyId: string): string {
  return `${SEARCH_ROUTES.SURVEY}/${surveyId}`;
}

/**
 * `/admin/messages` — the messaging page.
 *
 * There is no per-conversation route in `apps/web` (the page owns its own rail and
 * selection state), so a message or conversation result links to the page and carries
 * the conversation id as an ANCHOR for the client to select. Inventing
 * `/admin/messages/<id>` here would produce a dead link.
 */
export function messagesHref(): string {
  return SEARCH_ROUTES.MESSAGES;
}

/** `/admin/notifications` — the notification centre. Same reasoning: no detail route. */
export function notificationsHref(): string {
  return SEARCH_ROUTES.NOTIFICATIONS;
}

/** `/admin/calendar` — reminders live inside the calendar page, with no detail route. */
export function calendarHref(): string {
  return SEARCH_ROUTES.CALENDAR;
}

/** `/admin/directory/<id>` — the directory member page. */
export function directoryHref(userId: string): string {
  return `${SEARCH_ROUTES.DIRECTORY}/${userId}`;
}
