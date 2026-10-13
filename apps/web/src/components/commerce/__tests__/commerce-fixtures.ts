import type {
  CommerceApproval,
  CommerceAssignment,
  CommerceAssignmentHistoryEntry,
  CommerceCommercialConfigurationPage,
  CommerceCommercialConfigurationRecord,
  CommerceCommercialGroup,
  CommercePaymentsRead,
  CommercePaymentRecord,
  CommercePurchaseDocument,
  CommercePurchaseLine,
  CommercePurchasePage,
  CommerceReceipt,
  CommerceReceiptsRead,
  CommerceReturn,
  CommerceReturnsRead,
  CommerceWorkflowDefinition,
  CommerceWorkflowDefinitionsPage,
  CommerceWorkflowStep,
  CommerceWorkflowVersion,
  CommerceWorkflowVersionsPage,
  CommerceWorkflowVersionSummary,
} from '@/lib/commerce-api';

/**
 * PHASE UI-1/UI-2 fixtures — the wire shapes `commerce-api.ts` mirrors, built field for field.
 *
 * Every money value is the exact `Decimal(18,4)` STRING the API sends (never a number),
 * and every id is a plain token: the specs assert on rendered output and on call
 * arguments, so the fixtures' only job is to be structurally identical to the contract.
 * A field the wire does not carry is deliberately absent here — a fixture that invented
 * one would let a view depend on something the backend never sends.
 */

export function purchaseLine(overrides: Partial<CommercePurchaseLine> = {}): CommercePurchaseLine {
  return {
    id: 'line-1',
    lineNumber: 1,
    lineType: 'STANDARD',
    quantity: '10.0000',
    unit: 'PCS',
    unitPrice: '100.0000',
    tax: '0.0000',
    lineTotal: '1000.0000',
    externalRef: null,
    itemReference: null,
    technicalDescription: null,
    ...overrides,
  };
}

export function purchaseDocument(
  overrides: Partial<CommercePurchaseDocument> = {}
): CommercePurchaseDocument {
  return {
    id: 'doc-1',
    documentNumber: 'PR-1405-0001',
    kind: 'PURCHASE_REQUEST',
    status: 'DRAFT',
    editable: true,
    // PHASE C4-R: the completion projection the document read always carries — `null`
    // until the purchase is completed, never absent.
    completedByUserId: null,
    completedAt: null,
    requester: {
      id: '4f8a2f10-1234-4a5b-8c6d-7e9f0a1b2c3d',
      profile: {
        id: '4f8a2f10-1234-4a5b-8c6d-7e9f0a1b2c3d',
        firstName: 'سارا',
        lastName: 'محمدی',
        avatarUrl: null,
        jobTitle: null,
        department: null,
      },
    },
    supplierId: null,
    currency: 'IRR',
    subtotalAmount: '1000.0000',
    taxAmount: '0.0000',
    totalAmount: '1000.0000',
    lines: [purchaseLine()],
    createdAt: '2026-02-01T08:00:00.000Z',
    updatedAt: '2026-02-02T08:00:00.000Z',
    ...overrides,
  };
}

export function purchasePage(
  items: CommercePurchaseDocument[] = [],
  total = items.length,
  overrides: Partial<CommercePurchasePage> = {}
): CommercePurchasePage {
  return { items, page: 1, pageSize: 20, total, ...overrides };
}

export function commercialApproval(overrides: Partial<CommerceApproval> = {}): CommerceApproval {
  return {
    id: 'approval-1',
    purchaseLineId: 'line-1',
    purchaseDocumentId: 'doc-1',
    status: 'PENDING',
    approverUserId: 'u-1',
    decidedByUserId: null,
    decidedAt: null,
    comment: null,
    createdAt: '2026-02-03T08:00:00.000Z',
    updatedAt: '2026-02-03T08:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PHASE UI-2 — payments (C1-Q)
// ---------------------------------------------------------------------------

export function paymentRecord(overrides: Partial<CommercePaymentRecord> = {}): CommercePaymentRecord {
  return {
    id: 'payment-1',
    amount: '400.0000',
    currency: 'IRR',
    method: 'CASH',
    paymentDate: '2026-02-04T08:00:00.000Z',
    payerRef: null,
    payeeRef: null,
    invoiceRef: null,
    externalReference: null,
    reversesPaymentId: null,
    recordedByUserId: 'u-1',
    createdAt: '2026-02-04T08:00:00.000Z',
    ...overrides,
  };
}

export function paymentsRead(overrides: Partial<CommercePaymentsRead> = {}): CommercePaymentsRead {
  return {
    items: [paymentRecord()],
    page: 1,
    pageSize: 20,
    total: 1,
    paymentStatus: {
      status: 'PARTIAL',
      paidAmount: '400.0000',
      totalAmount: '1000.0000',
      currency: 'IRR',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PHASE UI-2 — receiving (C1-R)
// ---------------------------------------------------------------------------

export function receiptLine(overrides: Partial<CommerceReceipt['lines'][number]> = {}) {
  return {
    id: 'receipt-line-1',
    purchaseLineId: 'line-1',
    quantity: '4.0000',
    reversesReceiptLineId: null,
    createdAt: '2026-02-05T08:00:00.000Z',
    ...overrides,
  };
}

export function receipt(overrides: Partial<CommerceReceipt> = {}): CommerceReceipt {
  return {
    id: 'receipt-1',
    receivedAt: '2026-02-05T08:00:00.000Z',
    receiverId: 'u-1',
    createdAt: '2026-02-05T08:00:00.000Z',
    lines: [receiptLine()],
    ...overrides,
  };
}

export function receiptsRead(overrides: Partial<CommerceReceiptsRead> = {}): CommerceReceiptsRead {
  return {
    receipts: [receipt()],
    lines: [
      {
        purchaseLineId: 'line-1',
        orderedQuantity: '10.0000',
        receivedQuantity: '4.0000',
        receivingStatus: 'PARTIALLY_RECEIVED',
      },
    ],
    ...overrides,
  };
}

/** The "nothing happened yet" read — every line NOT_RECEIVED, no events. */
export function receiptsReadEmpty(): CommerceReceiptsRead {
  return {
    receipts: [],
    lines: [
      {
        purchaseLineId: 'line-1',
        orderedQuantity: '10.0000',
        receivedQuantity: '0.0000',
        receivingStatus: 'NOT_RECEIVED',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// PHASE UI-2 — returns (C1-S)
// ---------------------------------------------------------------------------

export function returnDocument(overrides: Partial<CommerceReturn> = {}): CommerceReturn {
  return {
    id: 'return-1',
    reason: 'کالای معیوب',
    replacementRequired: true,
    requestedByUserId: 'u-1',
    createdAt: '2026-02-06T08:00:00.000Z',
    state: 'REQUESTED',
    lines: [
      {
        id: 'return-line-1',
        purchaseLineId: 'line-1',
        receiptLineId: 'receipt-line-1',
        quantity: '2.0000',
        createdAt: '2026-02-06T08:00:00.000Z',
      },
    ],
    transitions: [
      {
        id: 'transition-1',
        state: 'REQUESTED',
        actorUserId: 'u-1',
        reason: null,
        createdAt: '2026-02-06T08:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

export function returnsRead(overrides: Partial<CommerceReturnsRead> = {}): CommerceReturnsRead {
  return { returns: [returnDocument()], ...overrides };
}

// ---------------------------------------------------------------------------
// PHASE UI-2 — commercial assignments (C1-P)
// ---------------------------------------------------------------------------

export function assignment(overrides: Partial<CommerceAssignment> = {}): CommerceAssignment {
  return {
    id: 'assignment-1',
    purchaseLineId: 'line-1',
    purchaseDocumentId: 'doc-1',
    commercialGroupId: 'group-1',
    status: 'ASSIGNED',
    source: 'PURCHASE_SUBMITTED',
    resolvedUserId: 'u-2',
    matchedRuleLabel: 'default',
    configurationVersionId: 'version-1',
    createdAt: '2026-02-07T08:00:00.000Z',
    updatedAt: '2026-02-07T08:00:00.000Z',
    ...overrides,
  };
}

export function assignmentHistoryEntry(
  overrides: Partial<CommerceAssignmentHistoryEntry> = {}
): CommerceAssignmentHistoryEntry {
  return {
    id: 'assignment-history-1',
    purchaseLineId: 'line-1',
    commercialGroupId: 'group-1',
    status: 'ASSIGNED',
    source: 'PURCHASE_SUBMITTED',
    resolvedUserId: 'u-2',
    matchedRuleLabel: 'default',
    configurationVersionId: 'version-1',
    actorUserId: null,
    reason: null,
    changedAt: '2026-02-07T08:00:00.000Z',
    ...overrides,
  };
}

export function commercialGroup(
  overrides: Partial<CommerceCommercialGroup> = {}
): CommerceCommercialGroup {
  return {
    id: 'group-1',
    code: 'IT',
    name: 'گروه فناوری اطلاعات',
    liaisonUserId: 'u-2',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PHASE UI-4 — workflow configuration and commercial configuration fixtures
// ---------------------------------------------------------------------------

export function workflowDefinition(
  overrides: Partial<CommerceWorkflowDefinition> = {}
): CommerceWorkflowDefinition {
  return {
    id: 'def-1',
    code: 'standard-purchase',
    name: 'فرآیند خرید استاندارد',
    versionCount: 2,
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-02T08:00:00.000Z',
    ...overrides,
  };
}

export function workflowDefinitionsPage(
  items: CommerceWorkflowDefinition[] = [workflowDefinition()],
  total = items.length
): CommerceWorkflowDefinitionsPage {
  return { items, page: 1, pageSize: 20, total };
}

export function workflowStep(
  overrides: Partial<CommerceWorkflowStep> = {}
): CommerceWorkflowStep {
  return {
    id: 'step-1',
    stepKey: 'manager-review',
    displayName: 'بررسی مدیر',
    mandatory: true,
    executionMode: 'SEQUENTIAL',
    ordering: 1,
    parallelGroup: null,
    condition: null,
    onConditionFalse: null,
    actorSource: 'CONFIGURED_USER',
    actorUserId: '4f8a2f10-1234-4a5b-8c6d-7e9f0a1b2c3d',
    actorRoleCode: null,
    actorRule: null,
    thresholds: null,
    lineFilters: null,
    configuration: null,
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  };
}

export function workflowVersionSummary(
  overrides: Partial<CommerceWorkflowVersionSummary> = {}
): CommerceWorkflowVersionSummary {
  return {
    id: 'version-1',
    workflowDefinitionId: 'def-1',
    versionLabel: '1404-01',
    status: 'DRAFT',
    triggerEvent: 'PURCHASE_SUBMITTED',
    parallelJoinPolicy: null,
    selectionPriority: null,
    selectionCondition: null,
    publishedAt: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
    stepCount: 1,
    ...overrides,
  };
}

export function workflowVersionsPage(
  items: CommerceWorkflowVersionSummary[] = [workflowVersionSummary()],
  total = items.length
): CommerceWorkflowVersionsPage {
  return { items, page: 1, pageSize: 20, total };
}

export function workflowVersion(
  overrides: Partial<CommerceWorkflowVersion> = {}
): CommerceWorkflowVersion {
  return {
    id: 'version-1',
    workflowDefinitionId: 'def-1',
    versionLabel: '1404-01',
    status: 'DRAFT',
    triggerEvent: 'PURCHASE_SUBMITTED',
    parallelJoinPolicy: null,
    selectionPriority: null,
    selectionCondition: null,
    publishedAt: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
    steps: [workflowStep()],
    ...overrides,
  };
}

export function commercialConfiguration(
  overrides: Partial<CommerceCommercialConfigurationRecord> = {}
): CommerceCommercialConfigurationRecord {
  return {
    id: 'config-1',
    versionLabel: '1404-01',
    status: 'DRAFT',
    assignmentTrigger: 'PURCHASE_SUBMITTED',
    noAssignmentBehavior: 'LEAVE_UNASSIGNED',
    matchBehavior: 'HIGHEST_PRIORITY',
    assignmentRules: [
      { label: 'کالای استاندارد', priority: 10, commercialGroupId: 'group-1' },
    ],
    approvalActivation: 'NOT_REQUIRED',
    approvalApprover: null,
    approverUserId: null,
    applicabilityCondition: null,
    projectionPolicy: 'DOCUMENT_WORKFLOW',
    createdAt: '2026-03-05T08:00:00.000Z',
    updatedAt: '2026-03-06T08:00:00.000Z',
    ...overrides,
  };
}

export function commercialConfigurationsPage(
  items: CommerceCommercialConfigurationRecord[] = [commercialConfiguration()],
  total = items.length
): CommerceCommercialConfigurationPage {
  return { items, page: 1, pageSize: 20, total };
}
