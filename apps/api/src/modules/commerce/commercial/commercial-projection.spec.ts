import {
  computeCommercialProjection,
  type CommercialProjectionInput,
} from './commercial-projection';

function input(overrides: Partial<CommercialProjectionInput> = {}): CommercialProjectionInput {
  return {
    documentStatus: 'SUBMITTED',
    policy: 'ALL_LINES',
    documentWorkflowStatus: null,
    lineCount: 1,
    lineWorkflowStatuses: ['APPROVED'],
    commercialApprovalStatuses: [],
    aggregationPolicy: null,
    ...overrides,
  };
}

describe('computeCommercialProjection (O4 gated)', () => {
  it('ALL_APPROVED with all routable lines approved writes APPROVED under ALL_LINES', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: 'ALL_APPROVED',
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED', 'APPROVED'],
      })
    );
    expect(result).toBe('APPROVED');
  });

  it('ALL_APPROVED with one routable line unapproved writes nothing under ALL_LINES', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: 'ALL_APPROVED',
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED', 'RUNNING'],
      })
    );
    expect(result).toBeNull();
  });

  it('INDEPENDENT with approved line workflows writes nothing under ALL_LINES', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: 'INDEPENDENT',
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED', 'APPROVED'],
      })
    );
    expect(result).toBeNull();
  });

  it('ALL_APPROVED with zero routable lines writes nothing under ALL_LINES', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: 'ALL_APPROVED',
        lineCount: 0,
        lineWorkflowStatuses: [],
      })
    );
    expect(result).toBeNull();
  });

  it('ALL_LINES without O4 behaves like ALL_APPROVED when aggregationPolicy is null', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: null,
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED', 'APPROVED'],
      })
    );
    expect(result).toBe('APPROVED');
  });

  it('ALL_LINES with an unrouted line writes nothing', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: 'ALL_APPROVED',
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED'],
      })
    );
    expect(result).toBeNull();
  });

  it('DOCUMENT_WORKFLOW is unaffected by INDEPENDENT', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'DOCUMENT_WORKFLOW',
        aggregationPolicy: 'INDEPENDENT',
        documentWorkflowStatus: 'APPROVED',
      })
    );
    expect(result).toBe('APPROVED');
  });

  it('DOCUMENT_WORKFLOW_AND_COMMERCIAL remains correct under INDEPENDENT', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'DOCUMENT_WORKFLOW_AND_COMMERCIAL',
        aggregationPolicy: 'INDEPENDENT',
        documentWorkflowStatus: 'APPROVED',
        commercialApprovalStatuses: ['APPROVED'],
      })
    );
    expect(result).toBe('APPROVED');
  });

  it('ALL_LINES_AND_COMMERCIAL satisfies when O4 and commercial conditions hold', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES_AND_COMMERCIAL',
        aggregationPolicy: 'ALL_APPROVED',
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED', 'APPROVED'],
        commercialApprovalStatuses: ['APPROVED'],
      })
    );
    expect(result).toBe('APPROVED');
  });

  it('ALL_LINES_AND_COMMERCIAL is blocked by INDEPENDENT even when commercial is APPROVED', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES_AND_COMMERCIAL',
        aggregationPolicy: 'INDEPENDENT',
        lineCount: 2,
        lineWorkflowStatuses: ['APPROVED', 'APPROVED'],
        commercialApprovalStatuses: ['APPROVED'],
      })
    );
    expect(result).toBeNull();
  });

  it('REJECTED document workflow writes REJECTED regardless of O4', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'ALL_LINES',
        aggregationPolicy: 'INDEPENDENT',
        documentWorkflowStatus: 'REJECTED',
      })
    );
    expect(result).toBe('REJECTED');
  });

  it('writes nothing when the document is not SUBMITTED', () => {
    const result = computeCommercialProjection(
      input({
        documentStatus: 'DRAFT',
        policy: 'ALL_LINES',
        aggregationPolicy: 'ALL_APPROVED',
      })
    );
    expect(result).toBeNull();
  });

  it('INDEPENDENT does not suppress DOCUMENT_WORKFLOW_AND_COMMERCIAL commercial failure', () => {
    const result = computeCommercialProjection(
      input({
        policy: 'DOCUMENT_WORKFLOW_AND_COMMERCIAL',
        aggregationPolicy: 'INDEPENDENT',
        documentWorkflowStatus: 'APPROVED',
        commercialApprovalStatuses: ['PENDING'],
      })
    );
    expect(result).toBeNull();
  });
});
