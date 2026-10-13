import { API_ENDPOINT } from './constants';
import { authenticatedFetch } from './auth-api';
import { coreGet } from './core-http';

export interface CoreProfile {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  status?: string | null;
  emailVerified?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  tenantId?: string | null;
}

export interface ProfileUpdateInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface LoginHistoryItem {
  id: string;
  action: 'login' | 'login_failed';
  success: boolean;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export async function fetchMyProfile(): Promise<CoreProfile> {
  return coreGet<CoreProfile>('/users/me');
}

export async function updateMyProfile(input: ProfileUpdateInput): Promise<CoreProfile> {
  const response = await authenticatedFetch(`${API_ENDPOINT}/users/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to update profile');
  }

  return (body?.data ?? body) as CoreProfile;
}

export async function uploadAvatar(file: File): Promise<CoreProfile> {
  const form = new FormData();
  form.append('file', file);
  const response = await authenticatedFetch(`${API_ENDPOINT}/users/me/avatar`, {
    method: 'POST',
    body: form,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to upload avatar');
  }

  return (body?.data ?? body) as CoreProfile;
}

export async function removeAvatar(): Promise<CoreProfile> {
  const response = await authenticatedFetch(`${API_ENDPOINT}/users/me/avatar`, {
    method: 'DELETE',
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to remove avatar');
  }

  return (body?.data ?? body) as CoreProfile;
}

export async function fetchLoginHistory(): Promise<LoginHistoryItem[]> {
  return coreGet<LoginHistoryItem[]>('/users/me/login-history');
}

export async function fetchSessions(): Promise<SessionRecord[]> {
  return coreGet<SessionRecord[]>('/auth/sessions');
}

export async function revokeSession(sessionId: string): Promise<{ revoked: boolean; sessionId: string }> {
  const response = await authenticatedFetch(`${API_ENDPOINT}/auth/sessions/${sessionId}/revoke`, {
    method: 'POST',
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to revoke session');
  }

  return (body?.data ?? body) as { revoked: boolean; sessionId: string };
}

export async function logoutAllSessions(): Promise<{ revokedAll: boolean }> {
  const response = await authenticatedFetch(`${API_ENDPOINT}/auth/logout-all`, {
    method: 'POST',
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to revoke all sessions');
  }

  return (body?.data ?? body) as { revokedAll: boolean };
}
