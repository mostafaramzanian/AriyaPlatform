import {
  COMMERCE_APPROVAL_DECISIONS,
  COMMERCE_MAX_PAGE_SIZE,
  COMMERCE_PAYMENT_METHODS,
  COMMERCE_RETURN_STATES,
  appendCommercePayment,
  appendCommerceReceipt,
  approveCommerceReturn,
  assignCommerceLine,
  buildPurchaseDocumentQuery,
  compensateCommercePayment,
  compensateCommerceReceiptLine,
  createCommercePurchaseDocument,
  createCommerceReturn,
  emptyPurchaseLineDraft,
  fetchCommerceAssignments,
  fetchCommerceCommercialApprovals,
  fetchCommerceCommercialGroups,
  fetchCommercePayments,
  fetchCommercePurchaseDocument,
  fetchCommercePurchaseDocuments,
  fetchCommerceReceipts,
  fetchCommerceReturns,
  pendingApprovalsForUser,
  receiveBackCommerceReturn,
  refundCommerceReturn,
  rejectCommerceReturn,
  serializePurchaseLine,
  submitCommerceCommercialDecision,
  submitCommercePurchaseDocument,
  updateCommercePurchaseDocument,
} from '../commerce-api';
import {
  addCommerceWorkflowStep,
  archiveCommerceCommercialConfiguration,
  archiveCommerceWorkflowVersion,
  buildCommerceSimpleCondition,
  buildCommerceWorkflowDefinitionsQuery,
  buildCommerceWorkflowVersionsQuery,
  commerceRuleOperatorsFor,
  COMMERCE_WORKFLOW_DOCUMENT_FACTS,
  COMMERCE_WORKFLOW_EXECUTABLE_ACTOR_SOURCES,
  COMMERCE_WORKFLOW_LINE_FACTS,
  createCommerceCommercialConfiguration,
  createCommerceCommercialGroup,
  createCommerceWorkflowDefinition,
  createCommerceWorkflowVersion,
  deleteCommerceWorkflowStep,
  fetchCommerceCommercialConfiguration,
  fetchCommerceCommercialConfigurations,
  fetchCommerceCommercialGroup,
  fetchCommerceWorkflowDefinition,
  fetchCommerceWorkflowDefinitions,
  fetchCommerceWorkflowVersion,
  fetchCommerceWorkflowVersions,
  publishCommerceCommercialConfiguration,
  publishCommerceWorkflowVersion,
  readCommerceCommercialAssignmentRules,
  readCommerceSimpleCondition,
  readCommerceWorkflowValidationReport,
  renameCommerceWorkflowDefinition,
  reorderCommerceWorkflowSteps,
  updateCommerceCommercialConfiguration,
  updateCommerceCommercialGroup,
  updateCommerceWorkflowStep,
  updateCommerceWorkflowVersion,
  validateCommerceCommercialConfiguration,
  validateCommerceWorkflowVersion,
} from '../commerce-api';
import { CoreApiError, coreDelete, coreGet, corePatch, corePost, corePut } from '../core-http';
import {
  assignment,
  commercialApproval,
  commercialConfiguration,
  commercialConfigurationsPage,
  commercialGroup,
  paymentRecord,
  paymentsRead,
  purchaseDocument,
  purchasePage,
  receipt,
  receiptsRead,
  returnDocument,
  returnsRead,
  workflowDefinition,
  workflowDefinitionsPage,
  workflowStep,
  workflowVersion,
  workflowVersionsPage,
  workflowVersionSummary,
} from '@/components/commerce/__tests__/commerce-fixtures';

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
  corePatch: jest.fn(),
  corePut: jest.fn(),
  coreDelete: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;
const putMock = corePut as jest.MockedFunction<typeof corePut>;
const deleteMock = coreDelete as jest.MockedFunction<typeof coreDelete>;

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * PHASE UI-1: the Commerce client's wire contract.
 *
 * WHAT THESE SPECS PIN: the exact paths (so a typo cannot ship), the query serialization
 * (Persian encoded, blanks dropped, `pageSize` capped by the declared constant), the
 * `tenantId`-free request shape (the actor is server-derived; the client must never send
 * one), and the Option A filter's exact semantics. Nothing here calls the network: the
 * `core-http` module is mocked and every production function runs untouched.
 */
describe('commerce-api — request shape', () => {
  it('builds an empty query for a bare read', () => {
    expect(buildPurchaseDocumentQuery()).toBe('');
    expect(buildPurchaseDocumentQuery({})).toBe('');
  });

  it('serializes the exact supported filters, in a stable order', () => {
    expect(
      buildPurchaseDocumentQuery({
        page: 2,
        pageSize: 20,
        search: 'PR-1405-0001',
        status: 'SUBMITTED',
        requesterId: 'u-1',
      })
    ).toBe('?page=2&pageSize=20&search=PR-1405-0001&status=SUBMITTED&requesterId=u-1');
  });

  it('encodes a Persian search rather than sending it raw', () => {
    expect(buildPurchaseDocumentQuery({ search: 'خرید' })).toBe(
      `?search=${encodeURIComponent('خرید')}`
    );
  });

  it('drops a blank search instead of sending an empty filter', () => {
    expect(buildPurchaseDocumentQuery({ search: '   ' })).toBe('');
  });

  it('caps pageSize with the constant the API declares', () => {
    expect(buildPurchaseDocumentQuery({ pageSize: 5000 })).toBe(`?pageSize=${COMMERCE_MAX_PAGE_SIZE}`);
    expect(COMMERCE_MAX_PAGE_SIZE).toBe(100);
  });

  it('never sends a tenant (the actor is resolved server-side)', () => {
    const built = buildPurchaseDocumentQuery({
      page: 1,
      pageSize: 20,
      search: 'PR-1',
      status: 'DRAFT',
      requesterId: 'u-1',
    });
    expect(built).not.toMatch(/tenant/i);
  });

  it('reads the register from the route the purchase controller owns', async () => {
    getMock.mockResolvedValue(purchasePage([], 0));

    await fetchCommercePurchaseDocuments({ page: 1, pageSize: 5 });

    expect(getMock).toHaveBeenCalledWith('/commerce/purchase-documents?page=1&pageSize=5');
  });

  it('can ask for the unfiltered register with no query string at all', async () => {
    getMock.mockResolvedValue(purchasePage([], 0));

    await fetchCommercePurchaseDocuments();

    expect(getMock).toHaveBeenCalledWith('/commerce/purchase-documents');
  });

  it('reads commercial approvals through the document-scoped route', async () => {
    getMock.mockResolvedValue({ documentId: 'doc-1', approvals: [] });

    await fetchCommerceCommercialApprovals('doc-1');

    expect(getMock).toHaveBeenCalledWith('/commerce/commercial-approvals?documentId=doc-1');
  });
});

describe('commerce-api — Option A filter (pending approvals for THIS user)', () => {
  it('keeps only PENDING rows whose stored approver is the given user', () => {
    const mine = commercialApproval({ id: 'mine', approverUserId: 'u-1', status: 'PENDING' });
    const decided = commercialApproval({ id: 'decided', approverUserId: 'u-1', status: 'APPROVED' });
    const rejected = commercialApproval({ id: 'rejected', approverUserId: 'u-1', status: 'REJECTED' });
    const somebodyElse = commercialApproval({ id: 'other', approverUserId: 'u-2' });

    expect(pendingApprovalsForUser([mine, decided, rejected, somebodyElse], 'u-1')).toEqual([mine]);
  });

  it('matches nothing when the session has no user id — never a row of unknown ownership', () => {
    const mine = commercialApproval({ approverUserId: 'u-1' });
    expect(pendingApprovalsForUser([mine], null)).toEqual([]);
  });
});

/**
 * PHASE UI-2 — the mutation surface. Every assertion here is a WIRE FACT verified against
 * the backend before the function was written: the exact path, the exact method, the exact
 * body shape (no `tenantId`, no `status`, no `documentNumber`, no `currency` on payments,
 * no `reversesPaymentId` on any payload), and the no-body rule for receive-back.
 */
describe('commerce-api — UI-2 request shapes', () => {
  it('reads one purchase document from its own route', async () => {
    getMock.mockResolvedValue(purchaseDocument());

    await fetchCommercePurchaseDocument('doc 1');

    expect(getMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc%201');
  });

  it('creates through POST with only the DTO fields, and omits blank optionals', async () => {
    postMock.mockResolvedValue(purchaseDocument());

    await createCommercePurchaseDocument({
      requesterId: 'u-1',
      lines: [{ lineType: 'STANDARD', quantity: 2 }],
    });

    expect(postMock).toHaveBeenCalledWith('/commerce/purchase-documents', {
      requesterId: 'u-1',
      lines: [{ lineType: 'STANDARD', quantity: 2 }],
    });
  });

  it('updates through PATCH, sending null for a cleared supplier and never a tenant', async () => {
    patchMock.mockResolvedValue(purchaseDocument());

    await updateCommercePurchaseDocument('doc-1', {
      requesterId: 'u-1',
      supplierId: null,
      currency: null,
      lines: [{ lineType: 'SERVICE', quantity: 1 }],
    });

    expect(patchMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1', {
      requesterId: 'u-1',
      supplierId: null,
      currency: null,
      lines: [{ lineType: 'SERVICE', quantity: 1 }],
    });
    const [, payload] = patchMock.mock.calls[0];
    expect(JSON.stringify(payload)).not.toMatch(/tenant/i);
  });

  it('submits through POST …/submit with NO body at all', async () => {
    postMock.mockResolvedValue(purchaseDocument({ status: 'SUBMITTED' }));

    await submitCommercePurchaseDocument('doc-1');

    expect(postMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1/submit');
  });

  it('serializes a line draft into the exact DTO fields (blank optionals omitted)', () => {
    const draft = {
      ...emptyPurchaseLineDraft('k1'),
      quantity: '2.5',
      unit: 'KG',
      unitPrice: '10',
      technicalDescription: '  کالای نمونه  ',
    };

    expect(serializePurchaseLine(draft)).toEqual({
      lineType: 'STANDARD',
      quantity: 2.5,
      unit: 'KG',
      unitPrice: 10,
      technicalDescription: 'کالای نمونه',
    });
  });

  it('reads payments with the capped page window and the exact method filter', async () => {
    getMock.mockResolvedValue(paymentsRead());

    await fetchCommercePayments('doc-1', { page: 2, pageSize: 5000, method: 'CHECK' });

    expect(getMock).toHaveBeenCalledWith(
      `/commerce/purchase-documents/doc-1/payments?page=2&pageSize=${COMMERCE_MAX_PAGE_SIZE}&method=CHECK`
    );
  });

  it('appends a payment with amount+method and never a currency or a reversal link', async () => {
    postMock.mockResolvedValue(paymentRecord());

    await appendCommercePayment('doc-1', { amount: 400, method: 'CASH' });

    expect(postMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1/payments', {
      amount: 400,
      method: 'CASH',
    });
    for (const method of COMMERCE_PAYMENT_METHODS) {
      expect(typeof method).toBe('string');
    }
  });

  it('compensates through the path-named target with an empty body by default', async () => {
    postMock.mockResolvedValue(paymentRecord({ reversesPaymentId: 'payment-1', amount: '-400.0000' }));

    await compensateCommercePayment('doc-1', 'payment-1');

    expect(postMock).toHaveBeenCalledWith(
      '/commerce/purchase-documents/doc-1/payments/payment-1/compensate',
      {}
    );
  });

  it('reads receipts from the document route', async () => {
    getMock.mockResolvedValue(receiptsRead());

    await fetchCommerceReceipts('doc-1');

    expect(getMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1/receipts');
  });

  it('appends a receipt as lines[] of {purchaseLineId, quantity}', async () => {
    postMock.mockResolvedValue(receipt());

    await appendCommerceReceipt('doc-1', { lines: [{ purchaseLineId: 'line-1', quantity: 4 }] });

    expect(postMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1/receipts', {
      lines: [{ purchaseLineId: 'line-1', quantity: 4 }],
    });
  });

  it('compensates a receipt line with a POSITIVE magnitude and the target in the path', async () => {
    postMock.mockResolvedValue(receipt());

    await compensateCommerceReceiptLine('doc-1', 'receipt-line-1', { quantity: 1.5 });

    expect(postMock).toHaveBeenCalledWith(
      '/commerce/purchase-documents/doc-1/receipts/receipt-line-1/compensate',
      { quantity: 1.5 }
    );
  });

  it('reads returns from the document route', async () => {
    getMock.mockResolvedValue(returnsRead());

    await fetchCommerceReturns('doc-1');

    expect(getMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1/returns');
  });

  it('creates a return with reason, replacementRequired and line references', async () => {
    postMock.mockResolvedValue(returnDocument());

    await createCommerceReturn('doc-1', {
      reason: 'کالای معیوب',
      replacementRequired: false,
      lines: [{ purchaseLineId: 'line-1', receiptLineId: 'receipt-line-1', quantity: 2 }],
    });

    expect(postMock).toHaveBeenCalledWith('/commerce/purchase-documents/doc-1/returns', {
      reason: 'کالای معیوب',
      replacementRequired: false,
      lines: [{ purchaseLineId: 'line-1', receiptLineId: 'receipt-line-1', quantity: 2 }],
    });
  });

  it('walks approve / reject through their own routes with an empty body by default', async () => {
    postMock.mockResolvedValue(returnDocument({ state: 'APPROVED' }));

    await approveCommerceReturn('doc-1', 'return-1');
    await rejectCommerceReturn('doc-1', 'return-1');

    expect(postMock).toHaveBeenNthCalledWith(
      1,
      '/commerce/purchase-documents/doc-1/returns/return-1/approve',
      {}
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      '/commerce/purchase-documents/doc-1/returns/return-1/reject',
      {}
    );
  });

  it('sends receive-back with NO body at all (the DTO accepts no field)', async () => {
    postMock.mockResolvedValue(returnDocument({ state: 'RECEIVED_BACK' }));

    await receiveBackCommerceReturn('doc-1', 'return-1');

    expect(postMock).toHaveBeenCalledWith(
      '/commerce/purchase-documents/doc-1/returns/return-1/receive-back'
    );
  });

  it('refunds with Q’s paymentId and never an amount', async () => {
    postMock.mockResolvedValue(returnDocument({ state: 'REFUNDED' }));

    await refundCommerceReturn('doc-1', 'return-1', { paymentId: 'payment-1' });

    expect(postMock).toHaveBeenCalledWith(
      '/commerce/purchase-documents/doc-1/returns/return-1/refund',
      { paymentId: 'payment-1' }
    );
  });

  it('reads assignments and groups from their document/tenant routes', async () => {
    getMock.mockResolvedValue({ documentId: 'doc-1', assignments: [], history: [] });

    await fetchCommerceAssignments('doc-1');
    expect(getMock).toHaveBeenCalledWith('/commerce/commercial-assignments?documentId=doc-1');

    getMock.mockResolvedValue({
      items: [commercialGroup()],
      page: 1,
      pageSize: 100,
      total: 1,
    });
    await fetchCommerceCommercialGroups({ pageSize: 100 });
    expect(getMock).toHaveBeenCalledWith('/commerce/commercial-groups?pageSize=100');
  });

  it('assigns ONE line through the line-first route, with no tenant and no document id', async () => {
    postMock.mockResolvedValue(assignment());

    await assignCommerceLine({ lineId: 'line-1', groupId: 'group-1', reason: 'انتقال' });

    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-assignments', {
      lineId: 'line-1',
      groupId: 'group-1',
      reason: 'انتقال',
    });
    const [, payload] = postMock.mock.calls[0];
    expect(JSON.stringify(payload)).not.toMatch(/tenant|documentId/);
  });

  it('knows the return-state vocabulary it renders, in the schema’s order', () => {
    expect(COMMERCE_RETURN_STATES).toEqual([
      'REQUESTED',
      'APPROVED',
      'RECEIVED_BACK',
      'REFUNDED',
      'REJECTED',
    ]);
  });
});

/**
 * PHASE UI-3 — the COMMERCIAL DECISION request shape. Every assertion is a WIRE FACT
 * verified against `CommercialApprovalDecisionDto` and `decide()` before the function was
 * written: the exact path, the exact method, the two-value decision vocabulary, the
 * omission of a blank comment, and the ABSENCE of any actor identity (who decides is
 * derived server-side; the body may never state a tenant, an approver or an acting user).
 */
describe('commerce-api — UI-3 commercial decision', () => {
  it('uses exactly the two decision values the DTO validates against', () => {
    expect([...COMMERCE_APPROVAL_DECISIONS]).toEqual(['APPROVED', 'REJECTED']);
  });

  it('posts the decision WITHOUT a comment key when the comment is blank', async () => {
    postMock.mockResolvedValue(commercialApproval({ status: 'APPROVED' }));

    await submitCommerceCommercialDecision('approval 1', { decision: 'APPROVED' });

    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-approvals/approval%201/decision', {
      decision: 'APPROVED',
    });
    const [, payload] = postMock.mock.calls[0];
    expect(Object.keys(payload as object)).toEqual(['decision']);
  });

  it('carries the comment when one is stated, and never any actor identity', async () => {
    postMock.mockResolvedValue(commercialApproval({ status: 'REJECTED' }));

    await submitCommerceCommercialDecision('approval-1', {
      decision: 'REJECTED',
      comment: 'قیمت با فاکتور هم‌خوان نیست.',
    });

    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-approvals/approval-1/decision', {
      decision: 'REJECTED',
      comment: 'قیمت با فاکتور هم‌خوان نیست.',
    });
    const [, payload] = postMock.mock.calls[0];
    expect(JSON.stringify(payload)).not.toMatch(/tenant|approver|actingUserId|userId/i);
  });

  it('propagates a refusal untouched so the central mapper can own the wording', async () => {
    const refusal = new CoreApiError('This commercial approval is already APPROVED.', 409);
    postMock.mockRejectedValue(refusal);

    await expect(
      submitCommerceCommercialDecision('approval-1', { decision: 'APPROVED' })
    ).rejects.toBe(refusal);
  });
});

// =============================================================================
// PHASE UI-4 — the configuration client's wire contract (C1-M / C1-P)
// =============================================================================

/**
 * WHAT THESE SPECS PIN: the exact path and HTTP method of every configuration route the
 * UI-4 surfaces call, the exact body each one sends (including the `undefined` = keep /
 * `null` = clear distinction the backend DTOs state), the query serialization of the
 * lists, and the absence of any client-invented identifier — no `tenantId`, no actor
 * fields, no status: the lifecycle is walked by the routes that own each transition.
 */
describe('commerce-api UI-4 — workflow definitions', () => {
  it('lists definitions with the shared page window and an encoded search', async () => {
    getMock.mockResolvedValue(workflowDefinitionsPage());

    await fetchCommerceWorkflowDefinitions({ page: 2, pageSize: 20, search: 'خرید' });

    expect(getMock).toHaveBeenCalledWith(
      `/commerce/workflow-definitions?page=2&pageSize=20&search=${encodeURIComponent('خرید')}`
    );
    expect(buildCommerceWorkflowDefinitionsQuery({ pageSize: 5000 })).toBe(
      `?pageSize=${COMMERCE_MAX_PAGE_SIZE}`
    );
    expect(buildCommerceWorkflowDefinitionsQuery({ search: '   ' })).toBe('');
  });

  it('reads one definition, creates one and renames one on their own paths', async () => {
    getMock.mockResolvedValue(workflowDefinition());
    postMock.mockResolvedValue(workflowDefinition());
    patchMock.mockResolvedValue(workflowDefinition({ name: 'نام تازه' }));

    await fetchCommerceWorkflowDefinition('def-1');
    expect(getMock).toHaveBeenCalledWith('/commerce/workflow-definitions/def-1');

    await createCommerceWorkflowDefinition({ code: 'standard-purchase', name: 'فرآیند' });
    expect(postMock).toHaveBeenCalledWith('/commerce/workflow-definitions', {
      code: 'standard-purchase',
      name: 'فرآیند',
    });

    await renameCommerceWorkflowDefinition('def-1', { name: 'نام تازه' });
    expect(patchMock).toHaveBeenCalledWith('/commerce/workflow-definitions/def-1', {
      name: 'نام تازه',
    });
  });

  it('lists versions WITH the status filter and creates a DRAFT with only stated fields', async () => {
    getMock.mockResolvedValue(workflowVersionsPage());
    postMock.mockResolvedValue(workflowVersionSummary());

    await fetchCommerceWorkflowVersions('def-1', { page: 1, pageSize: 20, status: 'PUBLISHED' });
    expect(getMock).toHaveBeenCalledWith(
      '/commerce/workflow-definitions/def-1/versions?page=1&pageSize=20&status=PUBLISHED'
    );
    expect(buildCommerceWorkflowVersionsQuery({})).toBe('');

    await createCommerceWorkflowVersion('def-1', { versionLabel: '1404-01' });
    expect(postMock).toHaveBeenCalledWith('/commerce/workflow-definitions/def-1/versions', {
      versionLabel: '1404-01',
    });
  });

  it('walks the version lifecycle on its three transition routes', async () => {
    postMock.mockResolvedValue(workflowVersion());

    await validateCommerceWorkflowVersion('version-1');
    expect(postMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/validate');

    await publishCommerceWorkflowVersion('version-1');
    expect(postMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/publish');

    await archiveCommerceWorkflowVersion('version-1');
    expect(postMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/archive');
  });

  it('reads a version with its steps and patches only the routing columns', async () => {
    getMock.mockResolvedValue(workflowVersion());
    patchMock.mockResolvedValue(workflowVersion());

    await fetchCommerceWorkflowVersion('version-1');
    expect(getMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1');

    await updateCommerceWorkflowVersion('version-1', {
      triggerEvent: null,
      parallelJoinPolicy: 'ALL',
      selectionPriority: 5,
    });
    expect(patchMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1', {
      triggerEvent: null,
      parallelJoinPolicy: 'ALL',
      selectionPriority: 5,
    });
  });
});

describe('commerce-api UI-4 — workflow steps', () => {
  it('adds, patches, deletes and REORDERS steps on their exact routes', async () => {
    postMock.mockResolvedValue(workflowStep());
    patchMock.mockResolvedValue(workflowStep());
    deleteMock.mockResolvedValue({ deleted: true, stepId: 'step-1' });
    putMock.mockResolvedValue(workflowVersion());

    await addCommerceWorkflowStep('version-1', {
      stepKey: 'manager-review',
      displayName: 'بررسی مدیر',
      ordering: 1,
      executionMode: 'PARALLEL',
      parallelGroup: 'branch-a',
      actorSource: 'CONFIGURED_USER',
      actorUserId: 'u-2',
    });
    expect(postMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/steps', {
      stepKey: 'manager-review',
      displayName: 'بررسی مدیر',
      ordering: 1,
      executionMode: 'PARALLEL',
      parallelGroup: 'branch-a',
      actorSource: 'CONFIGURED_USER',
      actorUserId: 'u-2',
    });

    await updateCommerceWorkflowStep('version-1', 'step-1', {
      condition: null,
      actorRoleCode: null,
    });
    expect(patchMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/steps/step-1', {
      condition: null,
      actorRoleCode: null,
    });

    await deleteCommerceWorkflowStep('version-1', 'step-1');
    expect(deleteMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/steps/step-1');

    await reorderCommerceWorkflowSteps('version-1', ['step-2', 'step-1']);
    expect(putMock).toHaveBeenCalledWith('/commerce/workflow-versions/version-1/steps/order', {
      order: ['step-2', 'step-1'],
    });
  });

  it('never sends a tenant, a status or an actor on any workflow write', async () => {
    postMock.mockResolvedValue(workflowDefinition());
    patchMock.mockResolvedValue(workflowVersion());
    putMock.mockResolvedValue(workflowVersion());

    await createCommerceWorkflowDefinition({ code: 'c', name: 'n' });
    await updateCommerceWorkflowVersion('version-1', { selectionPriority: 1 });
    await reorderCommerceWorkflowSteps('version-1', ['step-1']);

    for (const call of [...postMock.mock.calls, ...patchMock.mock.calls, ...putMock.mock.calls]) {
      expect(JSON.stringify(call[1] ?? {})).not.toMatch(
        /tenant|status|actor(User|Role)?Id|approver/i
      );
    }
  });
});

describe('commerce-api UI-4 — commercial configuration and groups', () => {
  it('lists and reads commercial configurations on their paths', async () => {
    getMock.mockResolvedValue(commercialConfigurationsPage());

    await fetchCommerceCommercialConfigurations({ page: 3, pageSize: 20 });
    expect(getMock).toHaveBeenCalledWith('/commerce/commercial-configurations?page=3&pageSize=20');

    await fetchCommerceCommercialConfiguration('config-1');
    expect(getMock).toHaveBeenCalledWith('/commerce/commercial-configurations/config-1');
  });

  it('creates and patches a configuration with the DTO field names, nothing else', async () => {
    postMock.mockResolvedValue(commercialConfiguration());
    patchMock.mockResolvedValue(commercialConfiguration());

    const input = {
      versionLabel: '1404-01',
      assignmentTrigger: 'PURCHASE_SUBMITTED' as const,
      noAssignmentBehavior: 'LEAVE_UNASSIGNED' as const,
      matchBehavior: 'HIGHEST_PRIORITY' as const,
      assignmentRules: [{ label: 'استاندارد', priority: 10, commercialGroupId: 'group-1' }],
      approvalActivation: 'NOT_REQUIRED' as const,
      approvalApprover: null,
      approverUserId: null,
      applicabilityCondition: null,
      projectionPolicy: 'DOCUMENT_WORKFLOW' as const,
    };

    await createCommerceCommercialConfiguration(input);
    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-configurations', input);
    expect(JSON.stringify(input)).not.toMatch(/tenant/i);

    await updateCommerceCommercialConfiguration('config-1', { noAssignmentBehavior: 'REJECT_OPERATION' });
    expect(patchMock).toHaveBeenCalledWith('/commerce/commercial-configurations/config-1', {
      noAssignmentBehavior: 'REJECT_OPERATION',
    });
  });

  it('walks the commercial lifecycle on validate/publish/archive', async () => {
    postMock.mockResolvedValue(commercialConfiguration({ status: 'VALIDATED' }));

    await validateCommerceCommercialConfiguration('config-1');
    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-configurations/config-1/validate');

    await publishCommerceCommercialConfiguration('config-1');
    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-configurations/config-1/publish');

    await archiveCommerceCommercialConfiguration('config-1');
    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-configurations/config-1/archive');
  });

  it('reads, creates and patches a commercial group — with null clearing the liaison', async () => {
    getMock.mockResolvedValue(commercialGroup());
    postMock.mockResolvedValue(commercialGroup());
    patchMock.mockResolvedValue(commercialGroup({ liaisonUserId: null }));

    await fetchCommerceCommercialGroup('group-1');
    expect(getMock).toHaveBeenCalledWith('/commerce/commercial-groups/group-1');

    await createCommerceCommercialGroup({ code: 'IT', name: 'فناوری', liaisonUserId: 'u-2' });
    expect(postMock).toHaveBeenCalledWith('/commerce/commercial-groups', {
      code: 'IT',
      name: 'فناوری',
      liaisonUserId: 'u-2',
    });

    await updateCommerceCommercialGroup('group-1', { name: 'فناوری اطلاعات', liaisonUserId: null });
    expect(patchMock).toHaveBeenCalledWith('/commerce/commercial-groups/group-1', {
      name: 'فناوری اطلاعات',
      liaisonUserId: null,
    });
  });
});

describe('commerce-api UI-4 — the pure condition, report and rule readers', () => {
  it('authors exactly the engine leaf: {field, op, value}, and no value key when forbidden', () => {
    expect(buildCommerceSimpleCondition({ field: 'totalAmount', op: 'greaterThan', value: 100 })).toEqual({
      field: 'totalAmount',
      op: 'greaterThan',
      value: 100,
    });
    expect(buildCommerceSimpleCondition({ field: 'supplierId', op: 'isEmpty' })).toEqual({
      field: 'supplierId',
      op: 'isEmpty',
    });
  });

  it('round-trips only SIMPLE leaves and refuses composite trees or array operands', () => {
    expect(readCommerceSimpleCondition({ field: 'currency', op: 'equals', value: 'IRR' })).toEqual({
      field: 'currency',
      op: 'equals',
      value: 'IRR',
    });
    expect(readCommerceSimpleCondition({ field: 'supplierId', op: 'isEmpty' })).toEqual({
      field: 'supplierId',
      op: 'isEmpty',
    });
    // Composite trees and array operands are NOT authorable here — shown, never rewritten.
    expect(readCommerceSimpleCondition({ all: [{ field: 'currency', op: 'equals', value: 'IRR' }] })).toBeNull();
    expect(readCommerceSimpleCondition({ field: 'kind', op: 'in', value: ['PURCHASE_REQUEST'] })).toBeNull();
    expect(readCommerceSimpleCondition(null)).toBeNull();
  });

  it('pairs the operators with each fact TYPE — the engine\'s own pairing, mirrored', () => {
    const enumFact = COMMERCE_WORKFLOW_DOCUMENT_FACTS.find((fact) => fact.name === 'kind')!;
    const numberFact = COMMERCE_WORKFLOW_DOCUMENT_FACTS.find((fact) => fact.name === 'totalAmount')!;
    const stringFact = COMMERCE_WORKFLOW_LINE_FACTS.find((fact) => fact.name === 'unit')!;

    expect(commerceRuleOperatorsFor(enumFact)).toEqual(['equals', 'notEquals']);
    expect(commerceRuleOperatorsFor(numberFact)).toContain('greaterThan');
    expect(commerceRuleOperatorsFor(stringFact)).toContain('isEmpty');
    expect(commerceRuleOperatorsFor(numberFact)).not.toContain('isEmpty');
  });

  it('reads the structured report off a refusal, and nothing when the body carries none', () => {
    const withReport = new CoreApiError('The workflow version does not pass the configuration checks.', 400, {
      level: 'PUBLISH',
      truncated: false,
      issues: [
        { refusal: 'WORKFLOW_TRIGGER_MISSING', path: 'triggerEvent' },
        { refusal: 'STEP_ACTOR_SOURCE_MISSING', stepKey: 'manager-review' },
        { notAnIssue: true },
      ],
    });

    expect(readCommerceWorkflowValidationReport(withReport)).toEqual({
      level: 'PUBLISH',
      truncated: false,
      issues: [
        { refusal: 'WORKFLOW_TRIGGER_MISSING', path: 'triggerEvent' },
        { refusal: 'STEP_ACTOR_SOURCE_MISSING', stepKey: 'manager-review' },
      ],
    });

    expect(readCommerceWorkflowValidationReport(new CoreApiError('plain 409', 409))).toBeNull();
    expect(readCommerceWorkflowValidationReport(new Error('network'))).toBeNull();
  });

  it('reads stored assignment rules and drops members that are not rule-shaped', () => {
    expect(
      readCommerceCommercialAssignmentRules([
        { label: 'استاندارد', priority: 10, commercialGroupId: 'group-1' },
        { label: 'بدون گروه' },
        null,
        'nope',
        { label: 'خدمات', priority: 20, commercialGroupId: 'group-2', condition: { field: 'lineType', op: 'equals', value: 'SERVICE' } },
      ])
    ).toEqual([
      { label: 'استاندارد', priority: 10, commercialGroupId: 'group-1' },
      {
        label: 'خدمات',
        priority: 20,
        commercialGroupId: 'group-2',
        condition: { field: 'lineType', op: 'equals', value: 'SERVICE' },
      },
    ]);
    expect(readCommerceCommercialAssignmentRules('nope')).toEqual([]);
  });

  it('pins the executable actor source list — one member, and the UI says so', () => {
    expect([...COMMERCE_WORKFLOW_EXECUTABLE_ACTOR_SOURCES]).toEqual(['CONFIGURED_USER']);
  });
});
