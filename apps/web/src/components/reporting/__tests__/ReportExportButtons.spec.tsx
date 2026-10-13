import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReportExportButtons } from '../ReportExportButtons';
import { downloadReportExport } from '@/lib/report-export';

jest.mock('@/lib/report-export', () => ({
  ...jest.requireActual('@/lib/report-export'),
  downloadReportExport: jest.fn(),
}));

const downloadMock = downloadReportExport as jest.MockedFunction<typeof downloadReportExport>;

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: what the ONE export control promises — two
 * labeled actions, disabled while a file generates, the CURRENT filter scope handed to
 * the download helper, and a Persian error that never traps the user.
 */
describe('ReportExportButtons — one scope, two files', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    downloadMock.mockResolvedValue({ fileName: 'purchase-report-2026-10-05.xlsx', mimeType: 'x' });
  });

  it('renders the Persian file actions and nothing speculative', () => {
    render(<ReportExportButtons testIdPrefix="reporting" buildPath={() => '/p'} />);

    expect(screen.getByTestId('reporting-export-xlsx')).toHaveTextContent('خروجی Excel');
    expect(screen.getByTestId('reporting-export-docx')).toHaveTextContent('خروجی Word');
    expect(screen.getByTestId('reporting-export-xlsx')).toHaveAttribute('type', 'button');
  });

  it('passes the CURRENT filter scope to the download — the same query as the table', async () => {
    const user = userEvent.setup();
    const buildPath = jest.fn(
      (format: 'xlsx' | 'docx') =>
        `/reporting/commerce/purchase-documents/export/${format}?status=APPROVED`
    );
    render(<ReportExportButtons testIdPrefix="reporting" buildPath={buildPath} />);

    await user.click(screen.getByTestId('reporting-export-xlsx'));

    expect(buildPath).toHaveBeenCalledWith('xlsx');
    expect(downloadMock).toHaveBeenCalledWith(
      '/reporting/commerce/purchase-documents/export/xlsx?status=APPROVED'
    );
  });

  it('disables both actions while a file generates, then re-enables them', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    downloadMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ fileName: 'f.xlsx', mimeType: 'x' });
      })
    );
    render(<ReportExportButtons testIdPrefix="reporting" buildPath={() => '/p'} />);

    await user.click(screen.getByTestId('reporting-export-docx'));

    expect(screen.getByTestId('reporting-export-docx')).toBeDisabled();
    expect(screen.getByTestId('reporting-export-docx')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('reporting-export-xlsx')).toBeDisabled();

    release();
    await waitFor(() => expect(screen.getByTestId('reporting-export-docx')).toBeEnabled());
    expect(screen.getByTestId('reporting-export-xlsx')).toBeEnabled();
  });

  it('shows a Persian error when the download fails — and the buttons stay usable', async () => {
    const user = userEvent.setup();
    downloadMock.mockRejectedValueOnce(new Error('boom'));
    render(<ReportExportButtons testIdPrefix="reporting" buildPath={() => '/p'} />);

    await user.click(screen.getByTestId('reporting-export-xlsx'));

    const alert = await screen.findByTestId('reporting-export-xlsx');
    expect(alert).toBeInTheDocument();
    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent('boom');
    // The user can retry immediately — a failed export never traps the screen.
    expect(screen.getByTestId('reporting-export-xlsx')).toBeEnabled();
  });

  it('is keyboard-operable: tab reaches both actions, enter downloads', async () => {
    const user = userEvent.setup();
    render(<ReportExportButtons testIdPrefix="reporting" buildPath={() => '/p'} />);

    await user.tab();
    expect(screen.getByTestId('reporting-export-xlsx')).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));

    await user.tab();
    expect(screen.getByTestId('reporting-export-docx')).toHaveFocus();
  });
});
