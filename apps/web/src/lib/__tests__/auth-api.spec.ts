import { authenticatedFetch, loginUser, refreshAccessToken } from '@/lib/auth-api';

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe('auth-api session lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
    (global as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('stores access and refresh tokens after login', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          accessToken: 'access.123',
          refreshToken: 'refresh.123',
          refreshTokenId: 'refresh-id-123',
          expiresIn: 900,
        },
      }),
    });

    await expect(
      loginUser({ email: 'admin@example.com', password: 'password123' }),
    ).resolves.toMatchObject({ accessToken: 'access.123' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(localStorage.getItem('aria_access_token')).toBe('access.123');
    expect(localStorage.getItem('aria_refresh_token')).toBe('refresh.123');
  });

  it('refreshes the session using the stored refresh token', async () => {
    localStorage.setItem('aria_refresh_token', 'refresh.123');

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          accessToken: 'access.456',
          refreshToken: 'refresh.456',
          refreshTokenId: 'refresh-id-456',
        },
      }),
    });

    await expect(refreshAccessToken()).resolves.toBe('access.456');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/refresh'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(localStorage.getItem('aria_access_token')).toBe('access.456');
    expect(localStorage.getItem('aria_refresh_token')).toBe('refresh.456');
  });

  it('refreshes once when the access token is expired and retries the request', async () => {
    const expiredToken = makeJwt({
      sub: 'u',
      email: 'admin@example.com',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const validToken = makeJwt({
      sub: 'u',
      email: 'admin@example.com',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    localStorage.setItem('aria_access_token', expiredToken);
    localStorage.setItem('aria_refresh_token', 'refresh.abc');

    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              accessToken: validToken,
              refreshToken: 'refresh.new',
              refreshTokenId: 'refresh-new-id',
            },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    });

    const response = await authenticatedFetch('/api/test');

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/refresh'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(localStorage.getItem('aria_access_token')).toBe(validToken);
  });
});
