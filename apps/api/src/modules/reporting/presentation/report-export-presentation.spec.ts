import {
  CHECK_REQUEST_REPORT_FILE_BASE,
  CHECK_REQUEST_REPORT_STATUS_LABELS,
  CHECK_REQUEST_REPORT_TITLE,
  checkRequestReportStatusExportLabel,
  toCheckRequestReportExportDocument,
} from './check-request-report.presentation';
import {
  HrPersonnelTrafficReportExportResult,
  PERSONNEL_TRAFFIC_REPORT_FILE_BASE,
  PERSONNEL_TRAFFIC_REPORT_SOURCE_LABELS,
  PERSONNEL_TRAFFIC_REPORT_TITLE,
  toHrPersonnelTrafficReportExportDocument,
} from './hr-personnel-traffic-report.presentation';
import {
  PRODUCTION_REPORT_FILE_BASE,
  PRODUCTION_REPORT_STATUS_LABELS,
  PRODUCTION_REPORT_TITLE,
  toProductionReportExportDocument,
} from './production-report.presentation';
import {
  PURCHASE_REPORT_FILE_BASE,
  PURCHASE_REPORT_STATUS_LABELS,
  PURCHASE_REPORT_TITLE,
  toPurchaseReportExportDocument,
} from './purchase-report.presentation';
import {
  reportDateLabel,
  reportDateTimeLabel,
  reportDayLabel,
  reportExportDisposition,
  reportExportFileName,
  reportPageScopeLines,
  reportPersianDigits,
  reportTimeLabel,
  reportWeekdayLabel,
} from './report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the presentation contract, asserted where it is
 * decided — the shared model's helpers, and each report's document builder against its
 * OWN result shape.
 *
 * WHAT THIS SUITE PROVES (and what it deliberately does not):
 *  * a document mirrors the RESULT it was given — same rows, same counts, same scope —
 *    so a file can never describe a different population than the table did;
 *  * filters travel as human-readable lines built from the SAME query object;
 *  * status/source words are the product's Persian vocabulary, type-sealed over each
 *    source's closed set (the wording itself is pinned to the web in
 *    `report-export-labels.spec.ts`);
 *  * date helpers read a NAMED zone and never invent a value for an absent one;
 *  * nothing the contract omits (tenant, actor ids, storage keys) can enter a document,
 *    because rows are built column-by-column from the whitelist the report exposes.
 */
const FIXED = new Date('2026-10-05T10:30:00.000Z');

describe('report-export.model — the shared presentation helpers', () => {
  it('builds the file name from report identity + the UTC day, ASCII only', () => {
    expect(reportExportFileName('purchase-report', 'xlsx', FIXED)).toBe(
      'purchase-report-2026-10-05.xlsx'
    );
    expect(reportExportFileName('purchase-report', 'docx', FIXED)).toBe(
      'purchase-report-2026-10-05.docx'
    );
    // No tenant, no row id, no search text can reach the name — it is constant-shaped.
    expect(reportExportFileName('check-request-report', 'xlsx', FIXED)).toMatch(
      /^[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.(xlsx|docx)$/
    );
  });

  it('builds an ASCII attachment disposition', () => {
    expect(reportExportDisposition('purchase-report-2026-10-05.xlsx')).toBe(
      'attachment; filename="purchase-report-2026-10-05.xlsx"'
    );
  });

  it('renumbers Latin digits for display and leaves the rest untouched', () => {
    expect(reportPersianDigits(57)).toBe('۵۷');
    expect(reportPersianDigits('صفحه 2 از 3')).toBe('صفحه ۲ از ۳');
  });

  it('reads an instant as the Persian calendar date in the NAMED application zone', () => {
    // 2026-09-18T08:00Z is 11:30 in Asia/Tehran — 27 Shahrivar 1405.
    expect(reportDateLabel('2026-09-18T08:00:00.000Z')).toBe('۱۴۰۵/۰۶/۲۷');
    expect(reportTimeLabel('2026-09-18T08:00:00.000Z')).toBe('۱۱:۳۰');
    expect(reportDateTimeLabel('2026-09-18T08:00:00.000Z')).toBe('۱۴۰۵/۰۶/۲۷ — ۱۱:۳۰');
  });

  it('renders an absent or unparseable instant as the honest dash — never a zero', () => {
    expect(reportDateLabel(null)).toBe('—');
    expect(reportDateLabel(undefined)).toBe('—');
    expect(reportDateLabel('not-a-date')).toBe('—');
    expect(reportTimeLabel(null)).toBe('—');
  });

  it('reads a stored day: Persian digits for the key, the weekday in UTC', () => {
    expect(reportDayLabel('1405/06/27')).toBe('۱۴۰۵/۰۶/۲۷');
    expect(reportWeekdayLabel('2026-09-18')).toBe('جمعه');
    expect(reportWeekdayLabel('nonsense')).toBe('—');
  });

  it('states the exported window honestly — rows, page and filtered total', () => {
    expect(reportPageScopeLines(2, 57, 2, 20)).toEqual([
      { label: 'صفحه', value: '۲ از ۳' },
      { label: 'ردیف‌های این خروجی', value: 2 },
      { label: 'مجموع (همه‌ی صفحات)', value: 57 },
    ]);
  });
});

describe('check-request report document — the Financial presentation', () => {
  const result = {
    items: [
      {
        id: 'row-1',
        title: 'درخواست چک پروژه نگین',
        checkIssueType: 'PURCHASE',
        purchaseType: 'PROJECT',
        orderReference: null,
        projectReference: null,
        requestDate: '2026-09-18T08:00:00.000Z',
        requesterOpinion: 'CONTINUE',
        status: 2,
        managerDecision: null,
        submittedAt: null,
        decidedAt: null,
      },
    ],
    total: 57,
    page: 2,
    pageSize: 20,
    summary: { total: 57, byStatus: { '0': 3, '2': 54 } },
  };

  it('carries the report identity and a safe file base', () => {
    expect(CHECK_REQUEST_REPORT_TITLE).toBe('گزارش وضعیت و گردش درخواست‌های صدور چک');
    expect(CHECK_REQUEST_REPORT_FILE_BASE).toBe('check-request-report');
  });

  it('mirrors the register table: one row in, one row out, localized columns', () => {
    const doc = toCheckRequestReportExportDocument(result, {}, FIXED);

    expect(doc.generatedAt).toEqual(FIXED);
    expect(doc.columns.map((column) => column.header)).toEqual([
      'عنوان',
      'نوع چک',
      'وضعیت',
      'تصمیم مدیر',
      'تاریخ درخواست',
    ]);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0][0]).toBe('درخواست چک پروژه نگین');
    expect(doc.rows[0][1]).toBe('خرید');
    expect(doc.rows[0][2]).toBe('در انتظار تصمیم مدیر');
    expect(doc.rows[0][3]).toBe('—');
    // The stored instant is RE-RENDERED, not copied raw and not mutated.
    expect(doc.rows[0][4]).toBe('۱۴۰۵/۰۶/۲۷');
    expect(doc.rows[0][4]).not.toContain('T');
  });

  it('carries the applied filters from the SAME query the list answered', () => {
    const doc = toCheckRequestReportExportDocument(result, { status: 2, search: 'نگین' }, FIXED);

    expect(doc.filters).toEqual([
      { label: 'وضعیت', value: 'در انتظار تصمیم مدیر' },
      { label: 'جستجو (عنوان)', value: 'نگین' },
    ]);
    expect(toCheckRequestReportExportDocument(result, {}, FIXED).filters).toEqual([]);
  });

  it('summarizes over the SAME population: every stage counted, جمع کل = total', () => {
    const doc = toCheckRequestReportExportDocument(result, {}, FIXED);

    // All ten stages of the closed lifecycle, in order, zero-filled like the strip.
    expect(doc.summary).toHaveLength(11);
    expect(doc.summary[0]).toEqual({ label: 'پیش‌نویس', value: 3 });
    expect(doc.summary[2]).toEqual({ label: 'در انتظار تصمیم مدیر', value: 54 });
    expect(doc.summary[10]).toEqual({ label: 'جمع کل', value: 57 });
    // …and the scope block agrees with the summary total.
    expect(doc.scope).toContainEqual({ label: 'مجموع (همه‌ی صفحات)', value: 57 });
    expect(doc.scope).toContainEqual({ label: 'ردیف‌های این خروجی', value: 1 });
  });

  it('seals the status vocabulary over the source ordinal set', () => {
    expect(Object.keys(CHECK_REQUEST_REPORT_STATUS_LABELS).sort()).toEqual(
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '50'].sort()
    );
    expect(checkRequestReportStatusExportLabel(50)).toBe('خاتمه یافته');
    // An ordinal nobody defined prints as itself — never an invented word.
    expect(checkRequestReportStatusExportLabel(99)).toBe('99');
  });
});

describe('purchase report document — the Commerce presentation', () => {
  const result = {
    items: [
      {
        id: 'doc-1',
        documentNumber: 'PR-1404-000123',
        kind: 'PURCHASE_REQUEST',
        status: 'APPROVED',
        supplierId: null,
        currency: 'IRR',
        subtotalAmount: '1200',
        taxAmount: '60',
        totalAmount: '1260',
        lineCount: 1,
        completedAt: null,
        createdAt: '2026-09-18T08:00:00.000Z',
      },
      {
        id: 'doc-2',
        documentNumber: 'PR-1404-000124',
        kind: 'PURCHASE_REQUEST',
        status: 'DRAFT',
        supplierId: null,
        currency: null,
        subtotalAmount: null,
        taxAmount: null,
        totalAmount: null,
        lineCount: 0,
        completedAt: null,
        createdAt: '2026-09-19T08:00:00.000Z',
      },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
    summary: { total: 2, byStatus: { APPROVED: 1, DRAFT: 1 } },
  };

  it('mirrors the register table, keeping money NUMERIC and unpriced EMPTY', () => {
    const doc = toPurchaseReportExportDocument(result, {}, FIXED);

    expect(PURCHASE_REPORT_TITLE).toBe('گزارش وضعیت و چرخه عمر درخواست‌های خرید');
    expect(PURCHASE_REPORT_FILE_BASE).toBe('purchase-report');
    expect(doc.columns.map((column) => column.header)).toEqual([
      'شماره سند',
      'نوع سند',
      'وضعیت',
      'مبلغ کل',
      'ارز',
      'تعداد اقلام',
      'تاریخ ایجاد',
    ]);
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0][2]).toBe('تأییدشده');
    expect(doc.rows[0][3]).toBe(1260); // a NUMBER — the sheet may sum it
    expect(typeof doc.rows[0][3]).toBe('number');
    expect(doc.rows[0][4]).toBe('IRR');
    expect(doc.rows[0][5]).toBe(1);
    // `null` means «not priced yet» — never a 0 that would claim free goods.
    expect(doc.rows[1][3]).toBeNull();
    expect(doc.rows[1][4]).toBe('—');
  });

  it('seals the six-member lifecycle and labels the applied status filter', () => {
    expect(Object.keys(PURCHASE_REPORT_STATUS_LABELS)).toHaveLength(6);
    expect(PURCHASE_REPORT_STATUS_LABELS.CLOSED).toBe('بسته‌شده');
    expect(toPurchaseReportExportDocument(result, { status: 'CLOSED' }, FIXED).filters).toEqual([
      { label: 'وضعیت', value: 'بسته‌شده' },
    ]);
  });
});

describe('production report document — the Production presentation', () => {
  const result = {
    items: [
      {
        id: 'bom-1',
        title: 'ست فریم فاز ۲',
        projectRef: '42',
        productTreeRef: '771',
        status: 'SUBMITTED',
        managerOpinion: null,
        itemCount: 12,
        submittedAt: '2026-09-18T08:00:00.000Z',
        decidedAt: null,
        createdAt: '2026-09-17T08:00:00.000Z',
      },
    ],
    total: 4,
    page: 1,
    pageSize: 20,
    summary: { total: 4, byStatus: { DRAFT: 1, SUBMITTED: 1, APPROVED: 1, REJECTED: 1 } },
  };

  it('mirrors the register table with the four-member lifecycle zero-filled', () => {
    const doc = toProductionReportExportDocument(result, {}, FIXED);

    expect(PRODUCTION_REPORT_TITLE).toBe('گزارش خلاصه و وضعیت عملیات تولید');
    expect(PRODUCTION_REPORT_FILE_BASE).toBe('production-report');
    expect(doc.columns.map((column) => column.header)).toEqual([
      'عنوان',
      'پروژه',
      'وضعیت',
      'نظر مدیر',
      'تعداد اقلام',
      'تاریخ ایجاد',
    ]);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0][2]).toBe('ارجاع برای تایید');
    expect(doc.rows[0][3]).toBe('—'); // nobody decided — not a verdict
    expect(doc.rows[0][4]).toBe(12);
    expect(doc.summary).toHaveLength(5); // four stages + جمع کل
    expect(doc.summary[4]).toEqual({ label: 'جمع کل', value: 4 });
    expect(Object.keys(PRODUCTION_REPORT_STATUS_LABELS)).toHaveLength(4);
  });
});

describe('personnel-traffic report document — the HR presentation', () => {
  const result: HrPersonnelTrafficReportExportResult = {
    items: [
      {
        id: 'att-1',
        employeeCode: 'E-1042',
        workDate: '2026-09-18',
        dateKey: '1405/06/27',
        clockIn: '2026-09-18T08:00:00.000Z',
        clockOut: null,
        source: 'MANUAL',
        reason: 'فراموشی ثبت',
      },
    ],
    total: 9,
    page: 1,
    pageSize: 20,
    summary: { total: 9, bySource: { DEVICE: 8, MANUAL: 1 } },
  };

  it('mirrors the register table with day/time semantics intact', () => {
    const doc = toHrPersonnelTrafficReportExportDocument(result, {}, FIXED);

    expect(PERSONNEL_TRAFFIC_REPORT_TITLE).toBe('گزارش تردد پرسنل');
    expect(PERSONNEL_TRAFFIC_REPORT_FILE_BASE).toBe('personnel-traffic-report');
    expect(doc.columns.map((column) => column.header)).toEqual([
      'کد پرسنل',
      'تاریخ',
      'روز هفته',
      'ورود',
      'خروج',
      'منبع',
    ]);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0][1]).toBe('۱۴۰۵/۰۶/۲۷'); // the register's OWN Jalali day
    expect(doc.rows[0][2]).toBe('جمعه'); // weekday of the stored Gregorian day
    expect(doc.rows[0][3]).toBe('۱۱:۳۰'); // Tehran reading of the punch instant
    expect(doc.rows[0][4]).toBe('—'); // an open day — never a zero hour
    expect(doc.rows[0][5]).toBe('اصلاح دستی');
    // The summary counts rows per source, and only that.
    expect(doc.summary).toEqual([
      { label: 'پانچ دستگاه', value: 8 },
      { label: 'اصلاح دستی', value: 1 },
      { label: 'جمع کل', value: 9 },
    ]);
  });

  it('describes the day window and the source filter the screen applied', () => {
    const doc = toHrPersonnelTrafficReportExportDocument(
      result,
      { from: '2026-09-18', to: '2026-09-19', source: 'MANUAL', search: 'E-1042' },
      FIXED
    );

    expect(doc.filters).toEqual([
      { label: 'از (میلادی)', value: '2026-09-18' },
      { label: 'تا (میلادی)', value: '2026-09-19' },
      { label: 'منبع', value: 'اصلاح دستی' },
      { label: 'جستجو (کد پرسنل)', value: 'E-1042' },
    ]);
  });

  it('seals the two-member source vocabulary', () => {
    expect(PERSONNEL_TRAFFIC_REPORT_SOURCE_LABELS).toEqual({
      DEVICE: 'پانچ دستگاه',
      MANUAL: 'اصلاح دستی',
    });
    expect(toHrPersonnelTrafficReportExportDocument(result, {}, FIXED).rows[0][5]).toBe(
      'اصلاح دستی'
    );
  });
});
