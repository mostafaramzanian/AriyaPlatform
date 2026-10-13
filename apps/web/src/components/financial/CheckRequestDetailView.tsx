'use client';

import { CheckRequestWizard } from './CheckRequestWizard';

/**
 * Phase F1 → CHECK-ISSUANCE: the route component of
 * `/admin/financial/check-requests/[id]`.
 *
 * The screen it renders is the CONFIGURATION-DRIVEN wizard (`CheckRequestWizard`) — the
 * stepper, the step panels and the action buttons all come from the published
 * `financial.check-issuance` definition and the row's `available-actions`. This wrapper
 * keeps the F1 export name and props so every existing import (the route, the specs)
 * stays valid while the interior became a wizard.
 */
export function CheckRequestDetailView({ requestId }: { requestId: string }) {
  return <CheckRequestWizard requestId={requestId} />;
}
