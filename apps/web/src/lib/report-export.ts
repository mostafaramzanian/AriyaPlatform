import { API_ENDPOINT } from './constants';
import { authenticatedFetch } from './auth-api';
import { CoreApiError } from './core-http';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the ONE binary-download helper for report
 * exports — the counterpart of `coreGet`, because `coreGet` parses JSON and a file is
 * not JSON.
 *
 * THE SAME SESSION, NOT A SECOND ONE: `authenticatedFetch` (the single existing session
 * mechanism) carries the token, so an export route sees exactly the actor the report
 * screen saw — same authentication, same tenant, same remit. Nothing here logs tokens or
 * file contents. Errors reuse `CoreApiError` with the body's message when one parses, so
 * a refusal reads like every other report failure (401 → session Persian sentence, 403 →
 * the access sentence the screens already translate).
 *
 * THE FILENAME IS THE SERVER'S: `Content-Disposition: attachment; filename="…"` names a
 * report-identity + day string the API built from constants (no tenant, no search text,
 * no user input), so the client never sanitises — it only falls back when the header is
 * absent. Download runs through a transient object URL that is revoked after the click,
 * and the anchor is keyboard-native like every other button.
 */
export type ReportExportDownloadFormat = 'xlsx' | 'docx';

export const REPORT_EXPORT_MIME: Record<ReportExportDownloadFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function downloadReportExport(pathWithQuery: string): Promise<{
  fileName: string | null;
  mimeType: string | null;
}> {
  let response: Response;
  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${pathWithQuery}`, { method: 'GET' });
  } catch {
    throw new CoreApiError('نشست شما منقضی شده است. لطفاً دوباره وارد شوید.', 401);
  }

  if (!response.ok) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const fromBody =
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : null;
    throw new CoreApiError(
      response.status === 403
        ? 'شما به این بخش دسترسی ندارید.'
        : (fromBody ?? 'دریافت خروجی با خطا مواجه شد.'),
      response.status
    );
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    const fileName = reportFileNameFromDisposition(response.headers.get('content-disposition'));
    if (fileName) anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }

  return {
    fileName: reportFileNameFromDisposition(response.headers.get('content-disposition')),
    mimeType: response.headers.get('content-type'),
  };
}

/** The ASCII `filename="…"` the API emits — `null` when the route names nothing. */
export function reportFileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match ? match[1] : null;
}
