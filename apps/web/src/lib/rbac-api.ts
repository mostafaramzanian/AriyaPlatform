import { coreGet } from './core-http';

/**
 * Phase 49B: read-only client for the existing `GET /rbac` contract.
 *
 * Response shape verified against the running Core API:
 * { userId, roles: [{ id, name, displayName, description, hierarchy }],
 *   permissions: string[], highestRole: Role | null }
 *
 * Permissions are consumed for presentation only — the backend remains the
 * authorization authority and its 403 responses stay decisive.
 */

export interface CoreRole {
  id: string;
  name: string;
  displayName: string;
  description?: string | null;
  hierarchy: number;
}

export interface CoreRbacSummary {
  userId: string;
  roles: CoreRole[];
  permissions: string[];
  highestRole: CoreRole | null;
}

export async function fetchMyRbac(): Promise<CoreRbacSummary> {
  const raw = await coreGet<Partial<CoreRbacSummary>>('/rbac');

  return {
    userId: typeof raw?.userId === 'string' ? raw.userId : '',
    roles: Array.isArray(raw?.roles) ? raw.roles : [],
    permissions: Array.isArray(raw?.permissions)
      ? raw.permissions.filter((p): p is string => typeof p === 'string')
      : [],
    highestRole: raw?.highestRole ?? null,
  };
}
