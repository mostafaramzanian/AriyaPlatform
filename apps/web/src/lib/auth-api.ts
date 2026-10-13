import { API_ENDPOINT } from './constants';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string;
  expiresIn: number;
  sessionId?: string;
}

export interface UserSession {
  sub: string;
  userId: string;
  email: string;
  tokenVersion: number;
  iat: number;
  exp: number;
}

const ACCESS_TOKEN_KEY = 'aria_access_token';
const REFRESH_TOKEN_KEY = 'aria_refresh_token';
const REFRESH_TOKEN_ID_KEY = 'aria_refresh_token_id';

export function storeAccessToken(token: string): void {
  if (typeof window === 'undefined' || !token) return;
  window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function clearAccessToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function storeRefreshToken(token: string, refreshTokenId?: string): void {
  if (typeof window === 'undefined' || !token) return;
  window.localStorage.setItem(REFRESH_TOKEN_KEY, token);
  if (refreshTokenId) {
    window.localStorage.setItem(REFRESH_TOKEN_ID_KEY, refreshTokenId);
  }
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getRefreshTokenId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_TOKEN_ID_KEY);
}

export function clearRefreshToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_ID_KEY);
}

export function clearAuthTokens(): void {
  clearAccessToken();
  clearRefreshToken();
}

export function parseJwt(token: string): UserSession | null {
  try {
    const base64 = token.split('.')[1];
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as UserSession;
    if (!payload.sub || !payload.email || payload.exp === undefined) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const session = parseJwt(token);
  if (!session) return true;
  return session.exp * 1000 < Date.now();
}

export async function loginUser(credentials: LoginRequest): Promise<LoginResponse> {
  const response = await fetch(`${API_ENDPOINT}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(credentials),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = body.message || body.data?.message || body.error || '???? ?????? ???.';
    throw new Error(message);
  }

  const data = (body.data ?? body) as LoginResponse | undefined;
  if (!data?.accessToken) {
    throw new Error('?????? ???? ???? ??????? ???.');
  }

  storeAccessToken(data.accessToken);
  if (data.refreshToken) {
    storeRefreshToken(data.refreshToken, data.refreshTokenId);
  }
  return data;
}

export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    clearAuthTokens();
    return null;
  }

  try {
    const response = await fetch(`${API_ENDPOINT}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ refreshToken }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      clearAuthTokens();
      return null;
    }

    const data = (body.data ?? body) as Partial<LoginResponse> | undefined;
    const nextAccessToken = data?.accessToken;
    if (!nextAccessToken) {
      clearAuthTokens();
      return null;
    }

    storeAccessToken(nextAccessToken);
    if (data.refreshToken) {
      storeRefreshToken(data.refreshToken, data.refreshTokenId);
    }
    return nextAccessToken;
  } catch {
    clearAuthTokens();
    return null;
  }
}

export async function logoutUser(): Promise<void> {
  const token = getAccessToken();
  if (!token || isTokenExpired(token)) {
    clearAuthTokens();
    return;
  }

  try {
    await fetch(`${API_ENDPOINT}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'same-origin',
    });
  } finally {
    clearAuthTokens();
  }
}

export async function fetchCurrentUser(): Promise<UserSession | null> {
  let token = getAccessToken();
  if (!token || isTokenExpired(token)) {
    token = (await refreshAccessToken()) ?? null;
  }
  if (!token) {
    return null;
  }

  const response = await fetch(`${API_ENDPOINT}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    clearAuthTokens();
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const body = await response.json().catch(() => ({}));
  return ((body && body.data) ?? body ?? null) as UserSession | null;
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let token = getAccessToken();
  if (!token || isTokenExpired(token)) {
    token = (await refreshAccessToken()) ?? null;
  }
  if (!token) {
    throw new Error('Unauthorized');
  }

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const isFormDataBody = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  if (!headers.has('Content-Type') && init?.body && !isFormDataBody) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    clearAuthTokens();
  }

  return response;
}
