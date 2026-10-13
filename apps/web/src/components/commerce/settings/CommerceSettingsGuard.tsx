'use client';

import * as React from 'react';

import { CommerceConfirmDialog } from '../CommerceConfirmDialog';

/**
 * PHASE UI-4 (§18): ONE dirty-state guard for the whole configuration domain.
 *
 * WHY A CONTEXT AND NOT A PROP CHAIN. The surfaces that can hold unsaved changes (the
 * version routing form, the step drawer, the commercial configuration editor) are nested
 * several levels below the element that NAVIGATES AWAY (the domain's sub-navigation),
 * and the same editors are left by their own parents (choosing another version, closing
 * the drawer). A guard that could only see one level would protect one exit and leak the
 * rest. So each editor REGISTERS its dirty flag under its own id, and EVERY guarded
 * navigation in the domain — the sub-nav here, another selection in the lists — asks
 * through `requestGuard` first: no dirty flag, no prompt; any dirty flag, one dialog
 * whose confirm runs the navigation and whose cancel returns focus to wherever it was.
 *
 * WHAT IT DOES NOT DO: it never saves, never clears a form and never decides what "dirty"
 * means — that is each editor's own comparison of its form against the row it loaded. It
 * only guarantees that losing those edits is an explicit, announced choice.
 */

interface GuardContextValue {
  /** An editor states its own dirty flag; `false` (or unmount) removes it. */
  setDirty: (id: string, dirty: boolean) => void;
  /** Run `action` immediately when nothing is dirty; otherwise ask first. */
  requestGuard: (action: () => void) => void;
}

const CommerceSettingsGuardContext = React.createContext<GuardContextValue | null>(null);

export function useCommerceSettingsGuard(): GuardContextValue {
  const context = React.useContext(CommerceSettingsGuardContext);
  if (!context) {
    throw new Error('useCommerceSettingsGuard must be used inside CommerceSettingsGuardProvider');
  }
  return context;
}

/**
 * Register a boolean dirty flag for the lifetime of a component (or until it clears):
 * the effect form keeps the call site a one-liner and makes cleanup structural.
 */
export function useCommerceDirtyFlag(id: string, dirty: boolean): void {
  const { setDirty } = useCommerceSettingsGuard();
  React.useEffect(() => {
    setDirty(id, dirty);
    return () => setDirty(id, false);
  }, [id, dirty, setDirty]);
}

export function CommerceSettingsGuardProvider({ children }: { children: React.ReactNode }) {
  const [pendingAction, setPendingAction] = React.useState<(() => void) | null>(null);
  const dirtyRef = React.useRef<Set<string>>(new Set());

  const setDirty = React.useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyRef.current.add(id);
    else dirtyRef.current.delete(id);
    // A flag change with a pending prompt open would mean the action is already being
    // asked about; nothing else in this provider renders from the set.
  }, []);

  const requestGuard = React.useCallback((action: () => void) => {
    if (dirtyRef.current.size === 0) {
      action();
      return;
    }
    setPendingAction(() => action);
  }, []);

  const value = React.useMemo(() => ({ setDirty, requestGuard }), [setDirty, requestGuard]);

  /*
   * THE BROWSER-UNLOAD HALF (§18): the guard above covers in-app navigation; a reload or
   * a closed tab would bypass it, so a listener asks the browser's own confirmation while
   * ANY editor in the domain is dirty. It reads the live set, so it costs nothing when
   * nothing is being edited.
   */
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current.size === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <CommerceSettingsGuardContext.Provider value={value}>
      {children}
      <CommerceConfirmDialog
        open={pendingAction !== null}
        title="تغییرات ذخیره‌نشده"
        description="تغییراتی که هنوز ذخیره نشده‌اند از دست می‌روند."
        consequences="برای حفظ تغییرات، «بازگشت» را انتخاب کنید و ابتدا ذخیره کنید."
        confirmLabel="صرف‌نظر و ادامه"
        cancelLabel="بازگشت"
        confirmTone="danger"
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          action?.();
        }}
        onCancel={() => setPendingAction(null)}
        testId="commerce-settings-discard-dialog"
      />
    </CommerceSettingsGuardContext.Provider>
  );
}