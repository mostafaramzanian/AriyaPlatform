import { coreGet } from './core-http';

/**
 * Phase 49D-1: Organization Directory client.
 *
 * Mirrors the backend contract exactly (`GET /users/directory`,
 * `GET /users/directory/:id`). The backend derives the tenant from the
 * authenticated identity, so no tenant identifier is ever sent from here —
 * `DirectoryQueryDto` runs under `forbidNonWhitelisted` and would reject one.
 *
 * Reads go through `coreGet`, which reuses the single existing session/token
 * mechanism and unwraps the `{ data }` envelope.
 */

/** Bounded manager projection returned by the backend. */
export interface DirectoryManager {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  jobTitle?: string | null;
}

export interface DirectoryMember {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  phone?: string | null;
  avatarUrl?: string | null;
  status?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  extension?: string | null;
  managerId?: string | null;
  manager?: DirectoryManager | null;
}

export interface DirectoryListResult {
  items: DirectoryMember[];
  hasMore: boolean;
}

export interface DirectoryQuery {
  cursor?: string;
  limit?: number;
  q?: string;
  department?: string;
  jobTitle?: string;
  managerId?: string;
}

/** Backend default and cap; mirrored so the UI never asks for more. */
export const DIRECTORY_PAGE_SIZE = 20;
export const DIRECTORY_MAX_PAGE_SIZE = 100;

export function buildDirectoryQuery(query: DirectoryQuery): string {
  const params = new URLSearchParams();

  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') {
    params.set('limit', String(Math.min(query.limit, DIRECTORY_MAX_PAGE_SIZE)));
  }
  // Empty strings are omitted rather than sent: an empty `q` would be a
  // meaningless filter, and the DTO trims before validating anyway.
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.department?.trim()) params.set('department', query.department.trim());
  if (query.jobTitle?.trim()) params.set('jobTitle', query.jobTitle.trim());
  if (query.managerId?.trim()) params.set('managerId', query.managerId.trim());

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export async function fetchDirectory(query: DirectoryQuery = {}): Promise<DirectoryListResult> {
  return coreGet<DirectoryListResult>(`/users/directory${buildDirectoryQuery(query)}`);
}

export async function fetchDirectoryMember(id: string): Promise<DirectoryMember> {
  return coreGet<DirectoryMember>(`/users/directory/${encodeURIComponent(id)}`);
}

export function directoryFullName(member: {
  firstName?: string | null;
  lastName?: string | null;
}): string | null {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}

/** Two-letter monogram for the avatar fallback; never falls back to a fake image. */
export function directoryInitials(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string;
}): string {
  const parts = [member.firstName, member.lastName].filter(Boolean) as string[];
  if (parts.length > 0) {
    return parts
      .slice(0, 2)
      .map((part) => part.trim()[0] ?? '')
      .join('')
      .toUpperCase();
  }
  return (member.email?.[0] ?? '؟').toUpperCase();
}

/**
 * Distinct filter values from the loaded page, so the department/job-title
 * selects only ever offer values that actually exist. Deliberately derived from
 * the current page instead of a new aggregation endpoint.
 */
export function distinctValues(
  items: DirectoryMember[],
  key: 'department' | 'jobTitle',
): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const value = item[key];
    if (value && value.trim()) seen.add(value.trim());
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, 'fa'));
}
