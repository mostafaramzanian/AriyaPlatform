 'use client';

import * as React from 'react';
import {
  UserSession,
  clearAuthTokens,
  getAccessToken,
  isTokenExpired,
  loginUser,
  logoutUser,
  LoginRequest,
  parseJwt,
  refreshAccessToken,
} from '@/lib/auth-api';

interface AuthState {
  user: UserSession | null;
  isLoading: boolean;
  error: string | null;
  isAuthenticated: boolean;
}

interface AuthContextValue extends AuthState {
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({
    user: null,
    isLoading: true,
    error: null,
    isAuthenticated: false,
  });

  const hydrateSession = React.useCallback(async () => {
    let token = getAccessToken();
    if (token && isTokenExpired(token)) {
      token = (await refreshAccessToken()) ?? null;
    } else if (!token) {
      token = (await refreshAccessToken()) ?? null;
    }

    if (token && !isTokenExpired(token)) {
      const user = parseJwt(token);
      setState({
        user,
        isAuthenticated: !!user,
        isLoading: false,
        error: null,
      });
      return;
    }

    clearAuthTokens();
    setState((prev) => ({
      ...prev,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    }));
  }, []);

  React.useEffect(() => {
    // Deferred to a microtask: the already-valid-token path of `hydrateSession`
    // reaches `setState` without an intervening await, which would call it
    // synchronously inside the effect body (`react-hooks/set-state-in-effect`).
    // The flag skips the hydration when the provider unmounts first.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void hydrateSession();
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateSession]);

  const login = React.useCallback(async (credentials: LoginRequest) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const { accessToken } = await loginUser(credentials);
      const user = parseJwt(accessToken);
      if (!user) {
        throw new Error('???? ??????? ??????? ???.');
      }
      setState({
        user,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '??? ?? ????.';
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        user: null,
        error: message,
      }));
      throw err;
    }
  }, []);

  const logout = React.useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      await logoutUser();
    } finally {
      clearAuthTokens();
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    }
  }, []);

  const clearError = React.useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const value = React.useMemo(
    () => ({
      ...state,
      login,
      logout,
      clearError,
    }),
    [state, login, logout, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
