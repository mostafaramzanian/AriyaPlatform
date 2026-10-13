import { readFileSync } from 'fs';
import { join } from 'path';
import { CHECK_REQUEST_REPORT_STATUS_LABELS } from './presentation/check-request-report.presentation';
import { HR_LEAVE_REPORT_STATUS_LABELS } from './presentation/hr-leave-report.presentation';
import { HR_MISSION_REPORT_STATUS_LABELS } from './presentation/hr-mission-report.presentation';
import { PERSONNEL_TRAFFIC_REPORT_SOURCE_LABELS } from './presentation/hr-personnel-traffic-report.presentation';
import { PAYMENT_REPORT_METHOD_LABELS } from './presentation/payment-history-report.presentation';
import { RECEIVING_REPORT_STATUS_LABELS } from './presentation/receiving-report.presentation';
import { RETURN_REPORT_STATE_LABELS } from './presentation/return-lifecycle-report.presentation';
import { PRODUCTION_BOM_CHANGE_REPORT_STATUS_LABELS } from './presentation/production-bom-change-report.presentation';
import { PRODUCTION_REPORT_STATUS_LABELS } from './presentation/production-report.presentation';
import {
  PURCHASE_REPORT_KIND_LABELS,
  PURCHASE_REPORT_STATUS_LABELS,
} from './presentation/purchase-report.presentation';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: ONE WORDING PER CONCEPT — the export's Persian
 * status/source words, read as TEXT from the web's own label modules and compared key
 * for key against the server's presentation maps.
 *
 * WHY THIS SPEC EXISTS, AND WHY IT READS ANOTHER APP AS TEXT
 * -----------------------------------------------------------
 * A generated file cannot import a browser module, so the status words live twice: once
 * for the screen (`apps/web/src/lib/*-labels.ts`) and once for the document (Reporting's
 * `presentation/*.ts`). Two spellings of the same lifecycle is how «the screen says
 * ارجاع برای تایید while the file says ارجاع‌شده» starts — a disagreement no Persian
 * reader can resolve. This spec is the tripwire: every entry must match EXACTLY, or the
 * file's wording is changed deliberately in the same change that changes the screen's.
 *
 * TEXT, NOT IMPORT: the web modules import browser-typed helpers this runtime cannot
 * resolve, so the comparison parses the constant BODY — the same technique
 * `reporting-isolation.spec.ts` already uses for the Core Prisma schema. The keys here
 * are the SOURCE's closed vocabularies (typed exhaustively on the Reporting side), so a
 * new status fails this spec by absence even if someone forgets the type error.
 */
const WEB_LIB = join(__dirname, '..', '..', '..', '..', 'web', 'src', 'lib');

/**
 * Parses the BODY of `const NAME = { k: 'و', ... };` — numeric or word keys, single
 * quotes, one entry per line. Fails loudly on shape drift rather than silently
 * misreading: a label nobody can parse is a label nobody can guard.
 */
function labelsOf(fileName: string, constant: string): Record<string, string> {
  const file = join(WEB_LIB, fileName);
  const source = readFileSync(file, 'utf8');
  const anchor = source.indexOf(`const ${constant}`);
  if (anchor < 0) throw new Error(`constant ${constant} not found in ${fileName}`);

  const bodyStart = source.indexOf('{', anchor);
  const bodyEnd = source.indexOf('}', bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error(`cannot read ${constant} body`);

  const body = source.slice(bodyStart + 1, bodyEnd);
  const entries = [
    ...body.matchAll(/^\s*'?(?<key>[A-Za-z0-9_]+)'?\s*:\s*'(?<value>[^']*)',?\s*$/gm),
  ];
  if (entries.length === 0) throw new Error(`no entries parsed from ${constant}`);
  return Object.fromEntries(entries.map((entry) => [entry.groups!.key, entry.groups!.value]));
}

describe('report-export-labels — the file and the screen agree on every word', () => {
  it('pins the ten Financial stage words to the web', () => {
    const web = labelsOf('financial-labels.ts', 'FINANCIAL_STATUS_LABELS');
    expect(Object.keys(web).sort()).toEqual(
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '50'].sort()
    );
    expect({ ...CHECK_REQUEST_REPORT_STATUS_LABELS }).toEqual(web);
  });

  it('pins the six Commerce lifecycle words to the web', () => {
    const web = labelsOf('commerce-labels.ts', 'DOCUMENT_STATUS_LABELS');
    expect(Object.keys(web).sort()).toEqual(
      ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'].sort()
    );
    expect({ ...PURCHASE_REPORT_STATUS_LABELS }).toEqual(web);
  });

  it('pins the one Commerce document kind to the web', () => {
    expect({ ...PURCHASE_REPORT_KIND_LABELS }).toEqual(
      labelsOf('commerce-labels.ts', 'DOCUMENT_KIND_LABELS')
    );
  });

  it('pins the four Production lifecycle words to the web', () => {
    const web = labelsOf('production-labels.ts', 'PRODUCTION_BOM_STATUS_LABELS');
    expect(Object.keys(web).sort()).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'].sort());
    expect({ ...PRODUCTION_REPORT_STATUS_LABELS }).toEqual(web);
  });

  it('keeps the change-request report on the SAME four Production words — one lifecycle, one vocabulary', () => {
    // Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the fifth report aliases the third
    // report's map rather than re-declaring it, so this pin proves the alias resolved to
    // the pinned object — and would fail if a future edit replaced it with an independent
    // (driftable) copy.
    expect({ ...PRODUCTION_BOM_CHANGE_REPORT_STATUS_LABELS }).toEqual({
      ...PRODUCTION_REPORT_STATUS_LABELS,
    });
  });

  it('pins the two HR source words to the web', () => {
    const web = labelsOf('hr-api.ts', 'ATTENDANCE_SOURCE_LABELS');
    expect(Object.keys(web).sort()).toEqual(['DEVICE', 'MANUAL'].sort());
    expect({ ...PERSONNEL_TRAFFIC_REPORT_SOURCE_LABELS }).toEqual(web);
  });

  it('pins the four HR leave lifecycle words to the web', () => {
    // Phase REPORTING-HR-LEAVE-REQUEST: the sixth report counts the register's own
    // four-member lifecycle (`domain/leave-status.ts`), and its export words must be
    // the words the screens already show for those states — one lifecycle, one set
    // of Persian words, spelled in `hr-api.ts`.
    const web = labelsOf('hr-api.ts', 'LEAVE_REQUEST_STATUS_LABELS');
    expect(Object.keys(web).sort()).toEqual(
      ['APPROVED', 'CANCELLED', 'PENDING', 'REJECTED'].sort()
    );
    expect({ ...HR_LEAVE_REPORT_STATUS_LABELS }).toEqual(web);
  });

  it('pins the five Commerce return lifecycle words to the web', () => {
    // Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the ninth report's export columns and
    // the screen's state select must speak the SAME five words the Commerce returns
    // section already shows («درخواست‌شده»/«تأییدشده»/«کالا برگشت خورد»/«بازپرداخت‌شده»/
    // «ردشده») — one lifecycle vocabulary, two surfaces.
    const web = labelsOf('commerce-labels.ts', 'RETURN_STATE_LABELS');
    expect(Object.keys(web).sort()).toEqual(
      ['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED'].sort()
    );
    expect({ ...RETURN_REPORT_STATE_LABELS }).toEqual(web);
  });

  it('pins the three Commerce receiving status words to the web', () => {
    // Phase REPORTING-COMMERCE-RECEIVING-STATUS: the tenth report's export
    // columns and the screen's status select must speak the SAME three words the
    // Commerce receiving section already shows («دریافت‌نشده»/«دریافت جزئی»/
    // «دریافت کامل») — one projection vocabulary, two surfaces.
    const web = labelsOf('commerce-labels.ts', 'RECEIVING_STATUS_LABELS');
    expect(Object.keys(web).sort()).toEqual(
      ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].sort()
    );
    expect({ ...RECEIVING_REPORT_STATUS_LABELS }).toEqual(web);
  });

  it('pins the three Commerce payment method words to the web', () => {
    // Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the eighth report's export columns and
    // the screen's method select must speak the SAME three words the Commerce payment
    // section already shows («نقد»/«تنخواه»/«چک») — one method vocabulary, two surfaces.
    const web = labelsOf('commerce-labels.ts', 'PAYMENT_METHOD_LABELS');
    expect(Object.keys(web).sort()).toEqual(['CASH', 'CHECK', 'PETTY_CASH'].sort());
    expect({ ...PAYMENT_REPORT_METHOD_LABELS }).toEqual(web);
  });

  it('pins the seven HR mission lifecycle words to the web', () => {
    // Phase REPORTING-HR-MISSION-REQUEST: the seventh report counts the register's own
    // seven-member lifecycle (`domain/mission-status.ts`), and its export words must be
    // the words the screens already show for those states — one lifecycle, one set of
    // Persian words, spelled in `hr-mission-labels.ts`.
    const web = labelsOf('hr-mission-labels.ts', 'REQUEST_STATUS_LABELS');
    expect(Object.keys(web).sort()).toEqual(
      [
        'APPROVED',
        'CANCELLED',
        'CORRECTION_REQUIRED',
        'DRAFT',
        'IN_APPROVAL',
        'REJECTED',
        'SUBMITTED',
      ].sort()
    );
    expect({ ...HR_MISSION_REPORT_STATUS_LABELS }).toEqual(web);
  });
});
