import { coreGet } from './core-http';

/**
 * Phase MANAGEMENT-DASHBOARD-V1: the read-only client for the Commerce pending-decisions
 * inbox, mirroring `pending-decisions.controller.ts` exactly:
 *
 *   GET /commerce/pending-decisions   (the caller's own inbox, paged)
 *
 * WHAT IS DELIBERATELY ABSENT: no `userId` (the inbox is the session's own), no `tenantId`
 * (resolved server-side), and no write verb. The dashboard reads ONLY `total` from this
 * response; the `items` array is never rendered on the dashboard (count-only, PII rule).
 */

/** The page the inbox returns. Only `total` is consumed by the dashboard. */
export interface CommercePendingDecisionsPage {
  items: unknown[];
  page: number;
  pageSize: number;
  total: number;
}

/** The inbox's total pending count for the calling actor. */
export function fetchCommercePendingDecisionsCount(): Promise<number> {
  return coreGet<CommercePendingDecisionsPage>('/commerce/pending-decisions?pageSize=1').then(
    (page) => page.total
  );
}
