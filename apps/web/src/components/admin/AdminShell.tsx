'use client';

import * as React from 'react';
import { CoreShell } from '@/components/core/CoreShell';

/**
 * Phase 34F introduced this shell for /admin/*.
 *
 * Phase 49B: it now delegates to CoreShell so the CMS routes render inside the
 * Core shell instead of maintaining a second layout. Kept as a named export so
 * the existing import in app/admin/layout.tsx keeps working unchanged.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  return <CoreShell>{children}</CoreShell>;
}
