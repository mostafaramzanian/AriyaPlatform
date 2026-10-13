import React from 'react';

/**
 * A refetch trigger that keeps its view states in sync.
 *
 * Data-fetch effects must not call setters synchronously in their own body
 * (`react-hooks/set-state-in-effect`: one extra cascading render per mount
 * and per refetch). Instead, the loading/cleared arming lives HERE, in the
 * SAME event-handler commit that bumps the token — so the next effect run
 * (triggered by the token) starts from exactly the state an in-effect reset
 * used to establish, and nothing else changes.
 *
 * Usage:
 *   const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
 *   // effect: fetch on [deps..., reloadToken] WITHOUT setLoading/setError inside
 *   // retry button: onClick={reload}
 *
 * The arming setters run synchronously inside the handler, so React batches
 * them with the token bump into one render. Mount state is the component's
 * own initial `useState` values. Note the asymmetry this hook does NOT fix:
 * on FIRST mount the effect below fires with the initial state the component
 * declares — which for gated views must be the SHELL state (nothing loading),
 * and for live views the SKELETON state (`isLoading: true` in `useState`).
 * Retries always re-arm through `reload()`. Both sides honour that split.
 */
export interface UseReloadToken {
  /** Bumps the token AND re-arms the given view states in the same commit, so
   *  the next background fetch starts from the identical loading/cleared
   *  state an in-effect reset used to establish — without storing a setter
   *  call in the effect body (`react-hooks/set-state-in-effect`). */
  reload: () => void;
  /** The token to list in the fetch effect's dependency array. */
  token: number;
}

export function useReloadToken(
  setLoading: (value: boolean) => void,
  // Typed as `null` rather than `string | null` so any nullable error state
  // (`string | null`, `CmsApiError | null`, …) can be re-armed: this hook only
  // ever CLEARS the error (`setError(null)`), it never produces a value.
  setError: (value: null) => void,
): UseReloadToken {
  // `token` is the retry path's re-arm; `isLoading` is the view's. This hook
  // flips both together in ONE event-handler commit, so a retry starts from
  // exactly the loading/cleared state it would have under an in-effect reset —
  // and first paint is owned by the component's own initial `useState`.
  const [token, setToken] = React.useState(0);
  const reload = React.useCallback(() => {
    setLoading(true);
    setError(null);
    setToken((value) => value + 1);
  }, [setError, setLoading]);
  return { reload, token };
}
