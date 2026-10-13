import { BadRequestException, Injectable } from '@nestjs/common';
import { COMMERCE_DEFAULT_PAGE_SIZE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import {
  ReceivingHistoryRepository,
  type ReceivingReportFilter,
  type ReceivingReportSourceRow,
} from '../receiving/receiving-history.repository';
import {
  RECEIVING_STATUSES,
  projectReceivingStatus,
  type ReceivingStatus,
} from '../receiving/receiving-status';
import type {
  CommerceReceivingReportPage,
  CommerceReceivingReportQuery,
  CommerceReceivingReportRow,
  CommerceReceivingReportSummary,
  CommerceReceivingReportingReader,
  CommerceReceivingReportingScope,
} from './commerce-receiving-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Commerce-owned IMPLEMENTATION of
 * the Reporting read contract — the approved seam Reporting reads through, the
 * exact shape the purchase, payment and return readers established.
 *
 * The adapter exposes ONLY the three contract reads, each projected onto the
 * contract's explicit eight-field whitelist, so the repository's write surface
 * (append — the locked over-receipt invariant and the compensation cap) stays
 * unreachable by construction rather than by review.
 *
 * ONE PIPELINE FOR LIST AND SUMMARY (`computeRegister`): facts → projection →
 * narrowing → deterministic order. The list slices it; the summary counts it; the
 * export renders whatever `list()` answered — so page, counts and file can never
 * disagree about what a filter meant (the siblings achieve the same equality with
 * one SQL predicate; this projection's AGGREGATE inputs move the equality into
 * one function instead).
 *
 * NOTHING IS INVENTED HERE. No document-level status, no money total, no rate,
 * no duration, no SLA, no aging, no fulfillment percentage, no inferred event.
 * The three decisions this file owns, and nothing more:
 *  * projecting each row's status through `projectReceivingStatus` — the SAME
 *    pure module the domain's own read route uses, imported BY VALUE, never
 *    re-typed here (an impossible history throws, exactly as Commerce's own
 *    screen does);
 *  * the zero-fill of the summary over `RECEIVING_STATUSES` (completing counts
 *    the computation produced — it never makes one up);
 *  * the register's order: latest receiving instant DESC, rows with no events
 *    LAST, `id` ASC as the deterministic tie-break.
 *
 * The inverted window (`receivedTo` before `receivedFrom`) and a malformed
 * instant are refused here with the SAME 400 the DTO family answers — before any
 * statement is issued (the payment reader's refusal pattern).
 */

/** A source fact after the domain's projection — the pipeline's row type. */
type RegisterRow = ReceivingReportSourceRow & { receivingStatus: ReceivingStatus };

/** Projects one source row through the domain's ONE projection (by value). */
function projectRow(fact: ReceivingReportSourceRow): RegisterRow {
  return {
    ...fact,
    receivingStatus: projectReceivingStatus(fact.orderedQuantity, fact.receivedQuantity),
  };
}

@Injectable()
export class CommerceReceivingReportingReaderService
  implements CommerceReceivingReportingReader
{
  constructor(private readonly receiving: ReceivingHistoryRepository) {}

  /** One filtered page of the register — the pipeline's window slice. */
  async listReportRows(
    scope: CommerceReceivingReportingScope,
    query: CommerceReceivingReportQuery
  ): Promise<CommerceReceivingReportPage> {
    const window = resolveReportWindow(query);
    const rows = await computeRegister(this.receiving, scope, query);
    const start = (window.page - 1) * window.pageSize;

    return {
      items: rows.slice(start, start + window.pageSize).map(toReportRow),
      total: rows.length,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /** Per-status counts over the SAME filtered population — the SAME pipeline, zero-filled. */
  async getReportSummary(
    scope: CommerceReceivingReportingScope,
    query: CommerceReceivingReportQuery
  ): Promise<CommerceReceivingReportSummary> {
    const rows = await computeRegister(this.receiving, scope, query);
    const byStatus: Record<string, number> = {};
    for (const status of RECEIVING_STATUSES) byStatus[status] = 0;
    for (const row of rows) byStatus[row.receivingStatus] += 1;

    return { total: rows.length, byStatus };
  }

  /** One report row, or `null` for another tenant's row — never a partial row or a throw. */
  async getReportRow(
    scope: CommerceReceivingReportingScope,
    purchaseLineId: string
  ): Promise<CommerceReceivingReportRow | null> {
    const [fact] = await this.receiving.readReportSourceRows(scope.tenantId, {
      purchaseLineId,
    });
    return fact ? toReportRow(projectRow(fact)) : null;
  }
}

/**
 * THE one register pipeline: repository facts → projection → status/date
 * narrowing → order. Called by BOTH list and summary with the same query — a
 * module-level function (the payment reader's helper shape) so the class's
 * surface is EXACTLY the contract's three reads.
 *
 * The date window is validated (parse + inversion) BEFORE the repository read,
 * so a refused query issues no statement. A line with no receiving events has
 * a NULL instant and a `NOT_RECEIVED` status: it is INCLUDED by an unbounded
 * query and EXCLUDED by any stated date bound — an instant window narrows to
 * instants (documented in the contract's DATE SEMANTICS).
 */
async function computeRegister(
  receiving: ReceivingHistoryRepository,
  scope: CommerceReceivingReportingScope,
  query: CommerceReceivingReportQuery
): Promise<RegisterRow[]> {
  const receivedFrom = query.receivedFrom
    ? parseReportInstant(query.receivedFrom, 'receivedFrom')
    : undefined;
  const receivedTo = query.receivedTo
    ? parseReportInstant(query.receivedTo, 'receivedTo')
    : undefined;
  if (receivedFrom && receivedTo && receivedTo < receivedFrom) {
    throw new BadRequestException('receivedTo must not precede receivedFrom.');
  }

  const facts = await receiving.readReportSourceRows(
    scope.tenantId,
    toRepositoryFilter(query)
  );

  let rows = facts.map(projectRow);
  if (query.status !== undefined) {
    rows = rows.filter((row) => row.receivingStatus === query.status);
  }
  if (receivedFrom !== undefined || receivedTo !== undefined) {
    rows = rows.filter(
      (row) =>
        row.receivedAt !== null &&
        (receivedFrom === undefined || row.receivedAt >= receivedFrom) &&
        (receivedTo === undefined || row.receivedAt < receivedTo)
    );
  }
  return rows.sort(compareRows);
}

/** The Commerce page-size pair — one place the report resolves its window (DTO = contract, clamp = guarantee). */
function resolveReportWindow(query: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    COMMERCE_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}

/**
 * The wire query → the repository's OWN filter shape. ONLY the pushable keys
 * (document/line identity, document-number search) cross; status and the date
 * window are computed facts and never become storage predicates. Unstated keys
 * stay ABSENT (every key spread conditionally).
 */
function toRepositoryFilter(query: CommerceReceivingReportQuery): ReceivingReportFilter {
  return {
    ...(query.purchaseDocumentId !== undefined
      ? { purchaseDocumentId: query.purchaseDocumentId }
      : {}),
    ...(query.purchaseLineId !== undefined ? { purchaseLineId: query.purchaseLineId } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
  };
}

/** ISO 8601 → the instant Prisma stores — refusing what the JS parser would silently roll over. */
function parseReportInstant(value: string, field: string): Date {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException(`${field} must be a valid ISO 8601 instant`);
  }
  return instant;
}

/**
 * The register's deterministic order: latest receiving instant DESC (event-less
 * rows LAST), `id` ASC as the tie-break — so the same facts always render in the
 * same order and a page boundary never shifts between reads.
 */
function compareRows(a: RegisterRow, b: RegisterRow): number {
  if (a.receivedAt !== null && b.receivedAt !== null) {
    const byInstant = b.receivedAt.getTime() - a.receivedAt.getTime();
    if (byInstant !== 0) return byInstant;
  } else if (a.receivedAt !== null) {
    return -1;
  } else if (b.receivedAt !== null) {
    return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Projects a computed row onto the contract's eight fields.
 *
 * WHITELIST, NOT SPREAD: the computed row carries the raw aggregate facts and the
 * projected status — and the whitelist re-states them so the next fact the
 * pipeline learns (a unit, a note) cannot publish itself without this file
 * deciding it. Quantities stay the exact stored/summed STRINGS; `receivedAt`
 * stays ISO (a moment stripped of its offset is a different moment); NULL stays
 * `null`, never a fake instant.
 */
function toReportRow(row: RegisterRow): CommerceReceivingReportRow {
  return {
    id: row.id,
    purchaseDocumentId: row.purchaseDocumentId,
    purchaseDocumentNumber: row.purchaseDocumentNumber,
    orderedQuantity: row.orderedQuantity,
    receivedQuantity: row.receivedQuantity,
    receivingStatus: row.receivingStatus,
    receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
    compensationCount: row.compensationCount,
  };
}


