import ExcelJS from 'exceljs';

/**
 * ui-redesign (employees directory): the «خروجی اکسل» writer.
 *
 * Same contract as the Reporting export writers: a real workbook built server-side
 * from the SAME rows the screen listed — never a scrape of the rendered table. The
 * sheet is right-to-left, Persian, and carries the filter context above the header
 * row so the file states what it is a picture OF.
 */

export interface EmployeeExportRow {
  employeeCode: string;
  name: string;
  unit: string | null;
  position: string | null;
  employmentType: string | null;
  startDate: string | null;
  status: string;
  hasAccount: boolean;
}

export interface EmployeeExportInput {
  rows: EmployeeExportRow[];
  total: number;
  generatedAt: Date;
  statusLabel: (status: string) => string;
  employmentTypeLabel: (type: string) => string;
  dateLabel: (isoDate: string) => string;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function renderEmployeesXlsx(input: EmployeeExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Aria ERP';
  workbook.created = input.generatedAt;
  workbook.modified = input.generatedAt;

  const sheet = workbook.addWorksheet('کارکنان', { views: [{ rightToLeft: true }] });

  sheet.columns = [{ width: 30 }, { width: 14 }, { width: 24 }, { width: 24 }, { width: 16 }, { width: 14 }, { width: 12 }, { width: 14 }];

  sheet.getCell(1, 1).value = 'مدیریت پرونده‌های پرسنلی';
  sheet.getCell(1, 1).font = { bold: true, size: 13 };
  sheet.getCell(2, 1).value = 'زمان تولید';
  sheet.getCell(2, 2).value = input.generatedAt.toISOString();
  sheet.getCell(3, 1).value = 'ردیف‌های این خروجی';
  sheet.getCell(3, 2).value = input.rows.length;
  sheet.getCell(4, 1).value = 'مجموع (همه‌ی صفحات)';
  sheet.getCell(4, 2).value = input.total;

  const headerIndex = 6;
  const header = [
    'کارمند',
    'کد پرسنلی',
    'واحد سازمانی',
    'سمت',
    'نوع استخدام',
    'شروع همکاری',
    'وضعیت',
    'حساب کاربری',
  ];
  header.forEach((text, i) => {
    const cell = sheet.getCell(headerIndex, i + 1);
    cell.value = text;
    cell.font = { bold: true };
  });

  input.rows.forEach((row, i) => {
    const r = headerIndex + 1 + i;
    sheet.getCell(r, 1).value = row.name;
    sheet.getCell(r, 2).value = row.employeeCode;
    sheet.getCell(r, 3).value = row.unit ?? '—';
    sheet.getCell(r, 4).value = row.position ?? '—';
    sheet.getCell(r, 5).value = row.employmentType ? input.employmentTypeLabel(row.employmentType) : '—';
    sheet.getCell(r, 6).value = row.startDate ? input.dateLabel(row.startDate) : '—';
    sheet.getCell(r, 7).value = input.statusLabel(row.status);
    sheet.getCell(r, 8).value = row.hasAccount ? 'متصل' : 'فاقد حساب';
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const EMPLOYEES_XLSX_MIME = XLSX_MIME;
