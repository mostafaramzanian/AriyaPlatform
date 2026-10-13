import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { UserDirectoryContract } from '../../../platform/user-directory/user-directory.contract';
import type { ProductionAuditGateway } from '../production-audit.gateway';
import {
  BomChangeRequestService,
  PRODUCTION_BOM_CHANGE_AUDIT_ACTION,
  toBomChangeRequestItemView,
  toBomChangeRequestView,
} from './bom-change.service';
import type {
  BomChangeRequestItemRecord,
  BomChangeRequestRecord,
  BomChangeRequestRepository,
} from './bom-change.repository';
import type { BomHeaderRecord, BomHeaderRepository } from '../bom/bom.repository';
import type { BomItemRecord, BomItemRepository } from '../bom/bom-item.repository';
import { PRODUCTION_BOM_CHANGE_ERROR_CODES } from './bom-change';
import { PRODUCTION_AUDIT_RESOURCE } from '../production.constants';
import type { CreateBomChangeRequestDto, AddBomChangeRequestItemDto } from './bom-change.dto';

/**
 * Phase PRODUCTION-BOM-CHANGE: the change-request slice's application surface.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. TENANT AND BOM SCOPE TRAVEL TOGETHER. Every call reaches the repositories with the
 *     ACTOR's tenant first, and an item is resolved against THE REQUEST'S OWN `bomId` — so
 *     a BOM this tenant does not hold, an item of a different BOM, an item of another
 *     tenant and a missing item are all the SAME 404. Checked on the ARGUMENTS actually
 *     passed, not on a comment.
 *  2. THE REQUESTER IS `actor.userId`, NEVER a body field — and a machine caller is refused
 *     rather than authoring a document nobody can be held to.
 *  3. THE SNAPSHOT COMES FROM THE ITEM, never from the payload.
 *  4. THE PAIR RULE IS `QUANTITY_CHANGE`-ONLY. Both deltas empty → 400; one delta → OK;
 *     both → OK; `DEACTIVATE` with no delta → OK. A rule that applied to both types, or
 *     that refused `0` or a negative, would fail here.
 *  5. DRAFT IS THE ONLY EDITABLE STATE, and a correction RETURNS it. Detail mutations on a
 *     submitted request are 409 before any write is reached.
 *  6. AUTHORIZATION FAILS CLOSED. Only the SNAPSHOTPPED approver may decide (403 otherwise,
 *     including a `null` actor), self-approval is refused at create and at patch, and an
 *     approver outside the tenant is a 400 naming the field.
 *  7. APPROVING WRITES NOTHING ON THE BOM. After `decide`, the header and item repositories
 *     are asserted to have received NO write call — the concrete form of
 *     `DEFERRED / CONTRACT NOT ESTABLISHED`.
 *  8. THE TRAIL RECORDS WHAT WAS WRITTEN, with the change request as `resourceId`.
 *
 * The doubles are structural: repository, header repository, item repository, audit gateway
 * and user directory are plain objects, so these specs exercise orchestration without a
 * database, a Nest container, or another owner's client.
 */

const TENANT = 'tenant-a';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const DETAIL_ID = '22222222-2222-4222-8222-222222222222';
const BOM_ITEM_ID = '33333333-3333-4333-8333-333333333333';
const BOM_ID = '44444444-4444-4444-8444-444444444444';

const ACTOR = {
  tenantId: TENANT,
  userId: 'user-requester',
  requestId: 'req-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

const MACHINE_ACTOR = { ...ACTOR, userId: null };

function requestRow(overrides: Partial<BomChangeRequestRecord> = {}): BomChangeRequestRecord {
  return {
    id: REQUEST_ID,
    tenantId: TENANT,
    bomId: BOM_ID,
    title: 'تغییر اقلام پروژه الف',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: 'user-requester',
    approverUserId: 'user-approver',
    status: 'DRAFT',
    managerOpinion: null,
    notes: null,
    requestDate: new Date('2026-01-01T00:00:00.000Z'),
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function detailRow(
  overrides: Partial<BomChangeRequestItemRecord> = {}
): BomChangeRequestItemRecord {
  return {
    id: DETAIL_ID,
    tenantId: TENANT,
    changeRequestId: REQUEST_ID,
    bomItemId: BOM_ITEM_ID,
    partName: 'Bracket',
    changeType: 'QUANTITY_CHANGE',
    originalDrawingCoefficient: 4,
    originalSpareCoefficient: 2,
    drawingCoefficientDelta: -1,
    spareCoefficientDelta: null,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    updatedAt: new Date('2026-01-04T00:00:00.000Z'),
    ...overrides,
  };
}

function headerRow(overrides: Partial<BomHeaderRecord> = {}): BomHeaderRecord {
  return {
    id: BOM_ID,
    tenantId: TENANT,
    title: 'اقلام پروژه الف',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: 'user-requester',
    approverUserId: 'user-approver',
    status: 'DRAFT',
    managerOpinion: null,
    comments: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  } as BomHeaderRecord;
}

function bomItemRow(overrides: Partial<BomItemRecord> = {}): BomItemRecord {
  return {
    id: BOM_ITEM_ID,
    tenantId: TENANT,
    bomId: BOM_ID,
    partName: 'Bracket',
    drawingConsumptionCoefficient: 4,
    spareConsumptionCoefficient: 2,
    ...overrides,
  } as BomItemRecord;
}

const CREATE_DTO: CreateBomChangeRequestDto = {
  bomId: BOM_ID,
  title: '  تغییر اقلام پروژه الف  ',
  approverUserId: 'user-approver',
};

function build() {
  const repository = {
    create: jest.fn().mockResolvedValue(requestRow()),
    findById: jest.fn().mockResolvedValue(requestRow()),
    list: jest.fn().mockResolvedValue({ requests: [requestRow()], total: 1 }),
    updateDraft: jest.fn().mockResolvedValue(requestRow({ title: 'updated' })),
    submit: jest.fn().mockResolvedValue(requestRow({ status: 'SUBMITTED' })),
    decide: jest.fn().mockResolvedValue(requestRow({ status: 'APPROVED' })),
    listItems: jest.fn().mockResolvedValue([detailRow()]),
    // DEFAULT: this request does NOT already detail the item — the common case. The
    // duplicate test overrides it, and the update/delete tests set it because
    // `requireItem` reads the SAME scoped lookup (a detail is addressed by ITS item too).
    findItemById: jest.fn().mockResolvedValue(null),
    createItem: jest.fn().mockResolvedValue(detailRow()),
    updateItemDraft: jest.fn().mockResolvedValue(detailRow({ spareCoefficientDelta: 5 })),
    deleteItemDraft: jest.fn().mockResolvedValue(true),
    countForRequest: jest.fn().mockResolvedValue(1),
  };
  const headers = { findById: jest.fn().mockResolvedValue(headerRow()) };
  const items = { findById: jest.fn().mockResolvedValue(bomItemRow()) };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
    buildOutboxPayload: jest.fn().mockReturnValue({
      tenantId: TENANT,
      auditId: 'mock-audit-id',
      payload: {},
    }),
  };
  const directory = {
    findTenantMember: jest.fn().mockResolvedValue({ id: 'u', displayName: 'member' }),
  };

  const service = new BomChangeRequestService(
    repository as unknown as BomChangeRequestRepository,
    headers as unknown as BomHeaderRepository,
    items as unknown as BomItemRepository,
    audit as unknown as ProductionAuditGateway,
    directory as unknown as UserDirectoryContract
  );

  return { service, repository, headers, items, audit, directory };
}

/** The `code` of a refusal, so a test asserts the identifier the UI maps, not a sentence. */
function codeOf(error: unknown): string | undefined {
  const body = (error as { response?: { code?: string } }).response;
  return body?.code;
}


describe('BomChangeRequestService — create: a DRAFT authored by the actor', () => {
  it('takes the requester from the ACTOR, not from the payload, and trims the title', async () => {
    const { service, repository, audit } = build();

    const view = await service.create({ ...ACTOR }, CREATE_DTO);

    const data = repository.create.mock.calls[0];
    expect(data[0]).toBe(TENANT);
    expect(data[1].requesterUserId).toBe('user-requester');
    expect(data[1].title).toBe('تغییر اقلام پروژه الف');
    // There is no `requesterUserId` on the DTO at all, so no payload could have claimed it.
    expect(CREATE_DTO).not.toHaveProperty('requesterUserId');
    expect(data[1].approverUserId).toBe('user-approver');

    expect(view.status).toBe('DRAFT');
    expect(view.items).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.CREATE,
        resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
        resourceId: REQUEST_ID,
      })
    );
  });

  it('copies the project and product-tree snapshot FROM the target BOM, never from a body', async () => {
    const { service, repository, headers } = build();

    await service.create({ ...ACTOR }, CREATE_DTO);

    expect(headers.findById).toHaveBeenCalledWith(TENANT, BOM_ID);
    expect(repository.create.mock.calls[0][1]).toMatchObject({
      projectRef: '42',
      productTreeRef: '771',
      bomId: BOM_ID,
    });
    // The DTO cannot carry either reference, so no payload can file a change against BOM B
    // while claiming project A.
    expect(CREATE_DTO).not.toHaveProperty('projectRef');
    expect(CREATE_DTO).not.toHaveProperty('productTreeRef');
  });

  it('404s a BOM this tenant does not hold, before anything is written', async () => {
    const { service, repository, headers } = build();
    headers.findById.mockResolvedValue(null);

    const error = await service.create({ ...ACTOR }, CREATE_DTO).catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.BOM_NOT_FOUND);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a machine caller — a document with no identifiable requester', async () => {
    const { service, repository } = build();

    const error = await service.create(MACHINE_ACTOR, CREATE_DTO).catch((e) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses self-approval: the approver may not be the requester', async () => {
    const { service, repository } = build();

    const error = await service
      .create({ ...ACTOR, userId: 'user-approver' }, CREATE_DTO)
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.FIELD_REQUIRED);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses an approver who is not a member of this tenant, without disclosing more', async () => {
    const { service, repository, directory } = build();
    directory.findTenantMember.mockResolvedValue(null);

    const error = await service.create({ ...ACTOR }, CREATE_DTO).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(directory.findTenantMember).toHaveBeenCalledWith(TENANT, 'user-approver');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a blank title rather than storing whitespace', async () => {
    const { service, repository } = build();

    const error = await service
      .create({ ...ACTOR }, { ...CREATE_DTO, title: '   ' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.FIELD_REQUIRED);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('BomChangeRequestService — reads are tenant-scoped and fail closed', () => {
  it('lists with the ACTOR tenant as the repository\u2019s first argument', async () => {
    const { service, repository } = build();

    const page = await service.list({ ...ACTOR }, {
      page: 1,
      pageSize: 20,
      bomId: BOM_ID,
      status: 'DRAFT',
      search: 'تغییر',
      projectRef: '42',
    });

    expect(repository.list.mock.calls[0][0]).toBe(TENANT);
    expect(repository.list.mock.calls[0][1]).toMatchObject({
      skip: 0,
      take: 20,
      bomId: BOM_ID,
      projectRef: '42',
      status: 'DRAFT',
      search: 'تغییر',
    });
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(page.items).toHaveLength(1);
  });

  it('404s another tenant\u2019s request, indistinguishably, on both reads', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(null);

    for (const call of [
      service.getOne({ ...ACTOR }, REQUEST_ID),
      service.submit({ ...ACTOR }, REQUEST_ID),
    ]) {
      const error = await call.catch((e) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_FOUND);
    }
    expect(repository.listItems).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();
  });
});


describe('BomChangeRequestService — detail rows while the request is a DRAFT', () => {
  const ADD: AddBomChangeRequestItemDto = {
    bomItemId: BOM_ITEM_ID,
    changeType: 'QUANTITY_CHANGE',
    drawingCoefficientDelta: -1,
    spareCoefficientDelta: null,
  };

  it('snapshots the ORIGINALS from the ITEM and never from the payload', async () => {
    const { service, items, repository } = build();

    const view = await service.addItem({ ...ACTOR }, REQUEST_ID, ADD);

    expect(items.findById).toHaveBeenCalledWith(TENANT, BOM_ID, BOM_ITEM_ID);
    expect(repository.createItem.mock.calls[0][0]).toBe(TENANT);
    expect(repository.createItem.mock.calls[0][1]).toBe(REQUEST_ID);
    expect(repository.createItem.mock.calls[0][2]).toEqual({
      bomItemId: BOM_ITEM_ID,
      changeType: 'QUANTITY_CHANGE',
      originalDrawingCoefficient: 4, // ← the ITEM's stored value, not any caller input
      originalSpareCoefficient: 2,
      drawingCoefficientDelta: -1,
      spareCoefficientDelta: null,
    });
    expect(ADD).not.toHaveProperty('originalDrawingCoefficient');
    expect(ADD).not.toHaveProperty('originalSpareCoefficient');
    expect(view.items[0]).toMatchObject({ partName: 'Bracket' });
    // No total is computed or returned: `original + delta` is a display derivation (S8).
    expect(view.items[0]).not.toHaveProperty('total');
  });

  it('rejects a QUANTITY_CHANGE that stated NEITHER delta', async () => {
    const { service, repository } = build();

    const error = await service
      .addItem({ ...ACTOR }, REQUEST_ID, {
        bomItemId: BOM_ITEM_ID,
        changeType: 'QUANTITY_CHANGE',
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.DELTA_REQUIRED);
    // The refusal lands BEFORE the item lookup, so a malformed payload cannot be used to
    // probe which item ids exist.
    expect(repository.createItem).not.toHaveBeenCalled();
  });

  it('accepts a QUANTITY_CHANGE with ONE delta stated — including a zero', async () => {
    const { service, repository } = build();

    await service.addItem(
      { ...ACTOR },
      REQUEST_ID,
      { ...ADD, drawingCoefficientDelta: null, spareCoefficientDelta: 0 }
    );

    expect(repository.createItem.mock.calls[0][2]).toMatchObject({
      drawingCoefficientDelta: null,
      spareCoefficientDelta: 0,
    });
  });

  it('accepts a QUANTITY_CHANGE with BOTH deltas stated', async () => {
    const { service, repository } = build();

    await service.addItem(
      { ...ACTOR },
      REQUEST_ID,
      { ...ADD, drawingCoefficientDelta: -3, spareCoefficientDelta: 5 }
    );

    expect(repository.createItem.mock.calls[0][2]).toMatchObject({
      drawingCoefficientDelta: -3,
      spareCoefficientDelta: 5,
    });
  });

  it('accepts DEACTIVATE with NO delta at all — the source checks nothing on that branch', async () => {
    const { service, repository } = build();

    await service.addItem({ ...ACTOR }, REQUEST_ID, {
      bomItemId: BOM_ITEM_ID,
      changeType: 'DEACTIVATE',
    });

    expect(repository.createItem.mock.calls[0][2]).toMatchObject({
      changeType: 'DEACTIVATE',
      drawingCoefficientDelta: null,
      spareCoefficientDelta: null,
    });
  });
});


describe('BomChangeRequestService — validation order, scope and the freeze', () => {
  const ADD: AddBomChangeRequestItemDto = {
    bomItemId: BOM_ITEM_ID,
    changeType: 'QUANTITY_CHANGE',
    drawingCoefficientDelta: -1,
    spareCoefficientDelta: null,
  };

  it('refuses a non-integer delta even though the DTO already bound it', async () => {
    const { service, repository } = build();

    const error = await service
      .addItem({ ...ACTOR }, REQUEST_ID, {
        ...ADD,
        drawingCoefficientDelta: 1.5 as unknown as number,
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.DELTA_INVALID);
    expect(repository.createItem).not.toHaveBeenCalled();
  });

  it('404s an item of a DIFFERENT BOM — foreign BOM item rejected, indistinguishably', async () => {
    const { service, items, repository } = build();
    // The item repository resolves `tenantId + bomId + itemId` together, so an item that
    // exists elsewhere answers exactly what a missing one answers.
    items.findById.mockResolvedValue(null);

    const error = await service.addItem({ ...ACTOR }, REQUEST_ID, ADD).catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEM_NOT_FOUND);
    // THE SCOPE IS THE REQUEST'S `bomId`, read from the row — never from the payload.
    expect(items.findById).toHaveBeenCalledWith(TENANT, BOM_ID, BOM_ITEM_ID);
    expect(repository.createItem).not.toHaveBeenCalled();
  });

  it('refuses a DUPLICATE detail with the source\u2019s own typed code, before any insert', async () => {
    const { service, repository } = build();
    // The scoped pre-check answers with the stored detail ⇒ the item is already detailed.
    repository.findItemById.mockResolvedValue(detailRow());

    const error = await service.addItem({ ...ACTOR }, REQUEST_ID, ADD).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEM_DUPLICATE);
    expect(repository.findItemById).toHaveBeenCalledWith(TENANT, REQUEST_ID, BOM_ITEM_ID);
    expect(repository.createItem).not.toHaveBeenCalled();
  });

  it('refuses EVERY mutation once the request is SUBMITTED, before any write', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(requestRow({ status: 'SUBMITTED' }));

    const calls = [
      service.addItem({ ...ACTOR }, REQUEST_ID, ADD),
      service.updateItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID, {
        drawingCoefficientDelta: 3,
      }),
      service.deleteItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID),
      service.update({ ...ACTOR }, REQUEST_ID, { title: 'x' }),
    ];

    for (const call of calls) {
      const error = await call.catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE);
    }

    expect(repository.createItem).not.toHaveBeenCalled();
    expect(repository.updateItemDraft).not.toHaveBeenCalled();
    expect(repository.deleteItemDraft).not.toHaveBeenCalled();
    expect(repository.updateDraft).not.toHaveBeenCalled();
  });

  it('validates the EFFECTIVE pair on a PATCH, not just the incoming one', async () => {
    const { service, repository } = build();
    // The stored row has ONE delta stated (`drawingCoefficientDelta: -1`); clearing it while
    // the other is absent would leave a QUANTITY_CHANGE with nothing stated.
    repository.findItemById.mockResolvedValue(
      detailRow({ drawingCoefficientDelta: null, spareCoefficientDelta: null })
    );

    const error = await service
      .updateItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID, {
        drawingCoefficientDelta: null,
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.DELTA_REQUIRED);
    expect(repository.updateItemDraft).not.toHaveBeenCalled();
  });

  it('leaves a delta ALONE when the key is absent, and CLEARS it when the key is null', async () => {
    const { service, repository } = build();
    repository.findItemById.mockResolvedValue(detailRow());

    await service.updateItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID, {
      spareCoefficientDelta: null,
    });
    expect(repository.updateItemDraft.mock.calls[0][3]).toEqual({
      spareCoefficientDelta: null,
    });

    await service.updateItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID, {
      changeType: 'DEACTIVATE',
    });
    expect(repository.updateItemDraft.mock.calls[1][3]).toEqual({ changeType: 'DEACTIVATE' });
  });

  it('refuses an EMPTY detail patch instead of bumping updatedAt for nothing', async () => {
    const { service, repository } = build();
    repository.findItemById.mockResolvedValue(detailRow());

    const error = await service
      .updateItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID, {})
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.PATCH_EMPTY);
    expect(repository.updateItemDraft).not.toHaveBeenCalled();
  });

  it('deletes only the DETAIL row and audits what it removed', async () => {
    const { service, repository, audit } = build();
    repository.findItemById.mockResolvedValue(detailRow());

    const result = await service.deleteItem({ ...ACTOR }, REQUEST_ID, DETAIL_ID);

    expect(result).toEqual({ id: DETAIL_ID });
    expect(repository.deleteItemDraft).toHaveBeenCalledWith(TENANT, REQUEST_ID, DETAIL_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.REMOVE_ITEM,
        resourceId: REQUEST_ID,
        oldValue: expect.objectContaining({ id: DETAIL_ID, partName: 'Bracket' }),
      })
    );
  });
});


describe('BomChangeRequestService — submit: the freeze point and the empty-request gate', () => {
  it('submits a DRAFT whose approver is still a member of this tenant', async () => {
    const { service, repository, directory, audit } = build();
    // The first read is the guard's view of the row (DRAFT); every read AFTER the write is
    // the row the write returned, which is what keeps the answer honest.
    repository.findById
      .mockResolvedValueOnce(requestRow())
      .mockResolvedValue(requestRow({ status: 'SUBMITTED', submittedAt: new Date('2026-02-01T00:00:00.000Z') }));

    const view = await service.submit({ ...ACTOR }, REQUEST_ID);

    // Phase B2.4: submit now passes an outbox payload as the 4th argument.
    expect(repository.submit).toHaveBeenCalledWith(
      TENANT, REQUEST_ID, null, expect.objectContaining({ tenantId: TENANT }),
    );
    expect(directory.findTenantMember).toHaveBeenCalledWith(TENANT, 'user-approver');
    expect(view.status).toBe('SUBMITTED');
    // Phase B2.4: the durable events use buildOutboxPayload instead of audit.record.
    expect(audit.buildOutboxPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.SUBMIT,
        resourceId: REQUEST_ID,
        newValue: expect.objectContaining({ status: 'SUBMITTED' }),
      })
    );
  });

  it('maps an empty request to the typed ITEMS_REQUIRED code, not to a generic conflict', async () => {
    const { service, repository } = build();
    // The conditional write failed while the row is STILL a DRAFT ⇒ `items: { some: {} }`
    // is the only predicate that could have refused it.
    repository.submit.mockResolvedValue(null);

    const error = await service.submit({ ...ACTOR }, REQUEST_ID).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEMS_REQUIRED);
  });

  it('maps a refusal on an already-decided row to NOT_EDITABLE, never to ITEMS_REQUIRED', async () => {
    const { service, repository } = build();
    repository.submit.mockResolvedValue(null);
    repository.findById.mockResolvedValue(requestRow({ status: 'APPROVED' }));

    const error = await service.submit({ ...ACTOR }, REQUEST_ID).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE);
  });

  it('refuses to submit twice, without reaching a write', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(requestRow({ status: 'SUBMITTED' }));

    const error = await service.submit({ ...ACTOR }, REQUEST_ID).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE);
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it('refuses to route the request to somebody who has left the tenant', async () => {
    const { service, repository, directory } = build();
    directory.findTenantMember.mockResolvedValue(null);

    const error = await service.submit({ ...ACTOR }, REQUEST_ID).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(repository.submit).not.toHaveBeenCalled();
  });
});


describe('BomChangeRequestService — decide: authority, and NO apply behaviour', () => {
  it('records the decision for the SNAPSHOTPPED approver only', async () => {
    const { service, repository, audit } = build();
    repository.findById
      .mockResolvedValueOnce(requestRow({ status: 'SUBMITTED' }))
      .mockResolvedValue(requestRow({ status: 'APPROVED', managerOpinion: 'APPROVED' }));

    const view = await service.decide(
      { ...ACTOR, userId: 'user-approver' },
      REQUEST_ID,
      'APPROVED',
      {}
    );

    // Phase B2.4: decide now passes an outbox payload as the 5th argument.
    expect(repository.decide).toHaveBeenCalledWith(
      TENANT,
      REQUEST_ID,
      'SUBMITTED',
      expect.objectContaining({ status: 'APPROVED', managerOpinion: 'APPROVED' }),
      expect.objectContaining({ tenantId: TENANT }),
    );
    expect(view.status).toBe('APPROVED');
    // Phase B2.4: the durable events use buildOutboxPayload instead of audit.record.
    expect(audit.buildOutboxPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.APPROVE })
    );
  });

  it('403s a caller who is not the recorded approver — fail closed, machine callers too', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(requestRow({ status: 'SUBMITTED' }));

    for (const actor of [
      { ...ACTOR, userId: 'someone-else' },
      { ...ACTOR, userId: null },
    ]) {
      const error = await service
        .decide(actor, REQUEST_ID, 'APPROVED', {})
        .catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
    }
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('refuses a decision on a DRAFT — only a SUBMITTED request can be decided', async () => {
    const { service, repository } = build();

    const error = await service
      .decide({ ...ACTOR, userId: 'user-approver' }, REQUEST_ID, 'REJECTED', {})
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE);
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('returns the request to DRAFT on a correction, keeping the decision on the row', async () => {
    const { service, repository, audit } = build();
    repository.findById
      .mockResolvedValueOnce(requestRow({ status: 'SUBMITTED' }))
      .mockResolvedValue(requestRow({ status: 'DRAFT', managerOpinion: 'NEEDS_CORRECTION' }));
    repository.decide.mockResolvedValue(
      requestRow({ status: 'DRAFT', managerOpinion: 'NEEDS_CORRECTION' })
    );

    const view = await service.decide(
      { ...ACTOR, userId: 'user-approver' },
      REQUEST_ID,
      'NEEDS_CORRECTION',
      {}
    );

    expect(repository.decide.mock.calls[0][3]).toMatchObject({
      status: 'DRAFT',
      managerOpinion: 'NEEDS_CORRECTION',
    });
    // Phase B2.4: the durable events use buildOutboxPayload instead of audit.record.
    expect(audit.buildOutboxPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.REQUEST_CORRECTION,
      })
    );
    // "Returned for correction" and "never submitted" stay distinguishable: the decision
    // columns were written even though the status went back to the editable one.
    expect(view.managerOpinion).toBe('NEEDS_CORRECTION');
    expect(view.status).toBe('DRAFT');
  });

  it('makes the detail rows editable again after a correction — no separate un-freeze', async () => {
    const { service, repository } = build();
    // The editable predicate asks ONLY the status, so a corrected row is editable by the
    // same call a fresh draft is.
    repository.findById.mockResolvedValue(
      requestRow({ status: 'DRAFT', managerOpinion: 'NEEDS_CORRECTION' })
    );

    const view = await service.addItem({ ...ACTOR }, REQUEST_ID, {
      bomItemId: BOM_ITEM_ID,
      changeType: 'DEACTIVATE',
    });
    expect(view.status).toBe('DRAFT');
  });

  it('APPROVING WRITES NOTHING ON THE BOM — no header write, no item write', async () => {
    const { service, headers, items, repository } = build();
    repository.findById.mockResolvedValue(requestRow({ status: 'SUBMITTED' }));

    await service.decide(
      { ...ACTOR, userId: 'user-approver' },
      REQUEST_ID,
      'APPROVED',
      {}
    );

    // The only repository write is the change request's own conditional decide. Nothing
    // reaches the BOM header's or the BOM item's write surface — the concrete form of
    // `DEFERRED / CONTRACT NOT ESTABLISHED`.
    expect(repository.decide).toHaveBeenCalledTimes(1);
    expect(headers.findById).not.toHaveBeenCalled();
    expect(items.findById).not.toHaveBeenCalled();
    expect(headers).not.toHaveProperty('updateDraft');
    expect(headers).not.toHaveProperty('decide');
    expect(items).not.toHaveProperty('updateDraft');
    expect(items).not.toHaveProperty('deleteDraft');
  });
});


describe('BomChangeRequestService — the timeline', () => {
  it('reads the change request\u2019s OWN resource, bound from the tenant-scoped row', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue({
      status: 'ok',
      page: {
        items: [
          {
            id: 'e-1',
            action: 'add_item',
            actorId: 'user-requester',
            success: true,
            reason: null,
            changedFields: ['items'],
            createdAt: '2026-01-03T00:00:00.000Z',
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      },
    });

    const timeline = await service.getTimeline(
      { ...ACTOR },
      REQUEST_ID,
      { page: 1, pageSize: 20 }
    );

    expect(audit.read).toHaveBeenCalledWith({
      tenantId: TENANT,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: REQUEST_ID,
      page: 1,
      pageSize: 20,
    });
    // Detail acts are reachable on the SAME read — that is the whole reason all nine
    // families share one `resourceId`.
    expect(timeline.items[0].action).toBe('add_item');
    expect(timeline.total).toBe(1);
  });

  it('404s another tenant\u2019s request BEFORE reaching the audit boundary', async () => {
    const { service, repository, audit } = build();
    // Fail closed: without a request there is no scope to read a trail for, so an unscoped
    // audit query would be a cross-tenant leak rather than an empty page.
    repository.findById.mockResolvedValue(null);

    const error = await service
      .getTimeline({ ...ACTOR }, REQUEST_ID, { page: 1, pageSize: 20 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(codeOf(error)).toBe(PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_FOUND);
    expect(audit.read).not.toHaveBeenCalled();
  });

  it('turns an audit outage into a 503, never into an empty page', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue({ status: 'rejected', code: 'AUDIT_READ_FAILED' });

    const error = await service
      .getTimeline({ ...ACTOR }, REQUEST_ID, { page: 1, pageSize: 20 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as { response?: { code?: string } }).response?.code).toBe(
      'AUDIT_READ_FAILED'
    );
  });
});

describe('BomChangeRequestService — projections expose the row and nothing derived', () => {
  it('projects every stored column of the header, with no label and no computed status', () => {
    const view = toBomChangeRequestView(requestRow({ status: 'SUBMITTED' }));

    expect(Object.keys(view).sort()).toEqual([
      'approverUserId',
      'bomId',
      'createdAt',
      'decidedAt',
      'decidedByUserId',
      'id',
      'managerOpinion',
      'notes',
      'productTreeRef',
      'projectRef',
      'requestDate',
      'requesterUserId',
      'status',
      'submittedAt',
      'title',
      'updatedAt',
    ]);
    expect(view.status).toBe('SUBMITTED');
    expect(view.requestDate).toBe('2026-01-01T00:00:00.000Z');
  });

  it('projects both coefficient PAIRS and no total, and reads the part name through', () => {
    const view = toBomChangeRequestItemView(detailRow({ partName: 'Bracket' }));

    expect(view).toMatchObject({
      id: DETAIL_ID,
      bomItemId: BOM_ITEM_ID,
      partName: 'Bracket',
      changeType: 'QUANTITY_CHANGE',
      originalDrawingCoefficient: 4,
      originalSpareCoefficient: 2,
      drawingCoefficientDelta: -1,
      spareCoefficientDelta: null,
    });
    expect(view).not.toHaveProperty('total');
    expect(view).not.toHaveProperty('bomItem');
  });
});

describe('BomChangeRequestService — APPROVE is a decision, not an apply', () => {
  it('the source contains no write to BomHeader or BomItem anywhere in this slice', () => {
    // `DEFERRED / CONTRACT NOT ESTABLISHED`, asserted rather than promised: the service may
    // READ the header (create) and the item (snapshot), but no line may write either. A
    // future `applyChange` would have to break this gate deliberately.
    const source = readFileSync(join(__dirname, 'bom-change.service.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
        );
      })
      .join('\n');

    expect(code).not.toMatch(/headers\.(submit|decide|updateDraft)/);
    expect(code).not.toMatch(/items\.(create|updateDraft|deleteDraft)/);
    // And the vocabulary this phase must NOT have introduced.
    expect(code).not.toMatch(/inactive|deactivated_at|is_active/i);
    expect(code).not.toMatch(/applyChange|applyChangeRequest/);
  });
});

