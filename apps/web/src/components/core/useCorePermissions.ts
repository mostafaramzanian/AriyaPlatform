'use client';

import * as React from 'react';
import { CoreApiError } from '@/lib/core-http';
import { fetchMyRbac, type CoreRbacSummary } from '@/lib/rbac-api';

/**
 * Phase 49B: loads the current user's roles/permissions from `GET /rbac`.
 *
 * Used for presentation only (navigation visibility, profile role display).
 * A failure degrades to "no permissions" rather than blocking the shell — the
 * backend still rejects unauthorized calls with 401/403.
 */

export interface CorePermissionsState {
  permissions: string[];
  roles: CoreRbacSummary['roles'];
  highestRole: CoreRbacSummary['highestRole'];
  isLoading: boolean;
  error: string | null;
  status: number | null;
  reload: () => void;
}

export function useCorePermissions(enabled: boolean): CorePermissionsState {
  const [state, setState] = React.useState<{
    permissions: string[];
    roles: CoreRbacSummary['roles'];
    highestRole: CoreRbacSummary['highestRole'];
    isLoading: boolean;
    error: string | null;
    status: number | null;
  }>({
    permissions: [],
    roles: [],
    highestRole: null,
    isLoading: enabled,
    error: null,
    status: null,
  });

  const [reloadToken, setReloadToken] = React.useState(0);
  // `reload` re-arms in the caller's handler commit (same commit as the token
  // bump): consumers call it from retry buttons, so the read that follows
  // starts from the loading/cleared state the removed in-effect setter used to
  // establish one render later.
  const reload = React.useCallback(() => {
    setState((prev) => ({ ...prev, isLoading: true, error: null, status: null }));
    setReloadToken((value) => value + 1);
  }, []);

  // Enable/disable transitions arm/reset synchronously during render, guarded
  // by the previous flag — never in the effect body
  // (`react-hooks/set-state-in-effect`):
  //  - disabled: idle list, exactly what the removed in-effect branch produced;
  //  - enabled: start the new read from the loading/cleared state the removed
  //    in-effect arm used to establish.
  // First mount is covered by the initial `isLoading: enabled`.
  const [prevEnabled, setPrevEnabled] = React.useState(enabled);
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    if (!enabled) {
      setState({
        permissions: [],
        roles: [],
        highestRole: null,
        isLoading: false,
        error: null,
        status: null,
      });
    } else {
      setState((prev) => ({ ...prev, isLoading: true, error: null, status: null }));
    }
  }

  React.useEffect(() => {
    // No request is issued without the grant: it would be a guaranteed 403.
    // The render path shows the loading skeleton while `isLoading` (armed
    // above or via the initial state) and the idle list when disabled.
    if (!enabled) return;

    let active = true;

    fetchMyRbac()
      .then((summary) => {
        if (!active) return;
        setState({
          permissions: summary.permissions,
          roles: summary.roles,
          highestRole: summary.highestRole,
          isLoading: false,
          error: null,
          status: null,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState({
          permissions: [],
          roles: [],
          highestRole: null,
          isLoading: false,
          error: err instanceof Error ? err.message : 'دریافت دسترسی‌ها با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
      });

    return () => {
      active = false;
    };
  }, [enabled, reloadToken]);

  return { ...state, reload };
}
