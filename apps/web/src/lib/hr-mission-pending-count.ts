import { fetchPendingMissionApprovals } from './hr-mission-api';

/**
 * Phase MANAGEMENT-DASHBOARD-V1: the count of mission steps waiting on the calling actor.
 *
 * `GET /hr/missions/approvals/pending` answers a bare array, so the count is its length.
 * The rows themselves are never rendered on the dashboard (count-only, PII rule).
 */
export async function fetchMissionApprovalsPendingCount(): Promise<number> {
  const rows = await fetchPendingMissionApprovals();
  return Array.isArray(rows) ? rows.length : 0;
}
