'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import {
  deleteFinancialCheckAttachment,
  fetchFinancialCheckAttachmentUrl,
  fetchFinancialCheckAttachments,
  updateFinancialCheckAttachment,
  uploadFinancialCheckAttachment,
  type FinancialCheckAttachment,
  type FinancialCheckDocumentType,
} from '@/lib/financial-api';
import {
  FINANCIAL_DOCUMENT_TYPES,
  financialDocumentTypeLabel,
  financialErrorMessage,
} from '@/lib/financial-labels';
import { FinancialCard, FinancialPageHeading } from './financial-ui';

/**
 * Phase F1 + CHECK-ISSUATION: «اسناد پیوست» — ONE document section of the process
 * configuration. The DEFAULT is section 02 (source «پیوست ها», states 0/1); the wizard
 * passes 6 or 7 for the stage sections, whose upload vocabulary differs (no «نوع سند»
 * picker there — the configuration says so, this component obeys).
 *
 *  * Eleven document types, verbatim from the source's `c_NoeaSanad` — a SELECT, not a
 *    free text, because the source's grid demanded a value from that list before any
 *    upload («نوع سند انتخاب گردد.») — and ONLY when the section declares a vocabulary.
 *  * NOTHING IS REQUIRED TO EXIST: Preflight §9.3 established that no attachment blocks
 *    any transition, so the section never gates save/submit and an empty state is a
 *    legitimate answer (a stage action's requiredness lives on ITS gate, not here).
 *  * upload / edit metadata / delete — gated by `editable`, computed by the DETAIL view
 *    from the server's own step; a viewer at a later stage sees the list read-only,
 *    because evidence must stay visible while it stops being editable.
 *  * download resolves a short-lived URL through the server; `storageKey` never appears.
 */
export function CheckRequestAttachments({
  requestId,
  editable,
  section = 2,
  title = 'اسناد پیوست',
  uploader,
  remover,
}: {
  requestId: string;
  editable: boolean;
  /** The process section to render — 2 by default (the F1 request documents). */
  section?: number;
  /** Section heading; stage sections pass their configuration title. */
  title?: string;
  /** Section-specific upload: stages 6/7 pass their own; section 2 keeps the typed one. */
  uploader?: (id: string, file: File, description?: string) => Promise<unknown>;
  /** Section-specific delete (stages 6/7 pass their own; section 2 keeps the F1 one). */
  remover?: (id: string, attachmentId: string) => Promise<unknown>;
}) {
  const [items, setItems] = React.useState<FinancialCheckAttachment[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [documentType, setDocumentType] = React.useState<FinancialCheckDocumentType | ''>('');
  const [description, setDescription] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDocumentType, setEditDocumentType] = React.useState<FinancialCheckDocumentType | ''>(
    ''
  );
  const [editDescription, setEditDescription] = React.useState('');
  const [reloadToken, setReloadToken] = React.useState(0);

  const reportFailure = (err: unknown) => {
    const body = (err as { details?: { code?: string } }).details;
    setError(
      financialErrorMessage(
        body?.code,
        err instanceof Error ? err.message : 'عملیات با خطا مواجه شد.'
      )
    );
  };

  React.useEffect(() => {
    let active = true;

    fetchFinancialCheckAttachments(requestId)
      .then((rows) => {
        if (!active) return;
        // One component instance renders ONE configured section (2 / 6 / 7).
        setItems(rows.filter((row) => row.section === section));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        reportFailure(err);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [requestId, reloadToken, section]);

  const reload = () => {
    setLoading(true);
    setError(null);
    setReloadToken((value) => value + 1);
  };

  async function handleUpload() {
    if (!file) {
      setError(financialErrorMessage('CHECK_REQUEST_FILE_REQUIRED', 'فایلی انتخاب نشده است.'));
      return;
    }
    // The typed vocabulary belongs to section 2 ONLY — stage sections (6/7) take no
    // «نوع سند», exactly as the process configuration declares.
    if (!uploader && !documentType) {
      setError(
        financialErrorMessage('CHECK_REQUEST_DOCUMENT_TYPE_REQUIRED', 'نوع سند انتخاب گردد.')
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (uploader) {
        await uploader(requestId, file, description || undefined);
      } else {
        await uploadFinancialCheckAttachment(
          requestId,
          file,
          documentType as FinancialCheckDocumentType,
          description || undefined
        );
      }
      setFile(null);
      setDescription('');
      setDocumentType('');
      const input = document.getElementById('financial-attachment-file') as HTMLInputElement | null;
      if (input) input.value = '';
      reload();
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleMetadataSave(attachmentId: string) {
    setBusy(true);
    setError(null);
    try {
      await updateFinancialCheckAttachment(requestId, attachmentId, {
        ...(editDocumentType ? { documentType: editDocumentType } : {}),
        description: editDescription,
      });
      setEditingId(null);
      reload();
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(attachmentId: string) {
    setBusy(true);
    setError(null);
    try {
      if (remover) {
        await remover(requestId, attachmentId);
      } else {
        await deleteFinancialCheckAttachment(requestId, attachmentId);
      }
      reload();
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FinancialCard testId="financial-attachments-section">
      <FinancialPageHeading
        testId="financial-attachments-heading"
        title={title}
        description={
          editable
            ? uploader
              ? 'بارگذاری در این بخش بدون «نوع سند» انجام می‌شود؛ هیچ سندی برای ادامه فرآیند الزامی نیست.'
              : 'نوع سند برای هر بارگذاری اجباری است؛ هیچ سندی برای ادامه فرآیند الزامی نیست.'
            : 'اسناد در این مرحله فقط‌خواندنی هستند.'
        }
      />

      {error && (
        <div className="mb-4" data-testid="financial-attachments-error">
          <CoreError message={error} onRetry={() => setError(null)} />
        </div>
      )}

      {editable && (
        <div className="mb-5 grid gap-3 rounded-xl border border-border p-4 md:grid-cols-[1fr_1fr_auto]">
          {!uploader && (
            <label className="flex flex-col gap-1 text-sm">
              <span>
                نوع سند <span className="text-destructive">*</span>
              </span>
              <select
                data-testid="financial-attachment-document-type"
                value={documentType}
                onChange={(event) =>
                  setDocumentType(event.target.value as FinancialCheckDocumentType | '')
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              >
                <option value="">— انتخاب کنید —</option>
                {FINANCIAL_DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {financialDocumentTypeLabel(type)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span>توضیحات</span>
            <input
              data-testid="financial-attachment-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              placeholder="توضیح اختیاری"
            />
          </label>
          <div className="flex items-end gap-2">
            <input
              id="financial-attachment-file"
              data-testid="financial-attachment-file"
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm file:mr-2"
            />
            <button
              type="button"
              data-testid="financial-attachment-upload"
              disabled={busy || !file || (!uploader && !documentType)}
              onClick={handleUpload}
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              بارگذاری
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <CoreLoading lines={3} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="financial-attachments-empty">
          هیچ سندی پیوست نشده است.
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="financial-attachments-list">
          {items.map((attachment) => (
            <li
              key={attachment.id}
              data-testid={`financial-attachment-row-${attachment.id}`}
              className="flex flex-wrap items-center gap-3 py-3 text-sm"
            >
              <span className="min-w-40 font-medium text-foreground">{attachment.fileName}</span>
              <span className="text-muted-foreground">
                {attachment.documentType
                  ? financialDocumentTypeLabel(attachment.documentType)
                  : '—'}
              </span>
              {attachment.description && (
                <span className="text-muted-foreground">— {attachment.description}</span>
              )}

              <span className="mr-auto flex gap-2">
                <button
                  type="button"
                  data-testid={`financial-attachment-download-${attachment.id}`}
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const { url } = await fetchFinancialCheckAttachmentUrl(
                        requestId,
                        attachment.id
                      );
                      window.open(url, '_blank', 'noopener');
                    } catch (err) {
                      reportFailure(err);
                    }
                  }}
                  className="rounded-lg border border-border px-2 py-1 text-xs transition hover:bg-secondary"
                >
                  دانلود
                </button>

                {editable && (
                  <>
                    <button
                      type="button"
                      data-testid={`financial-attachment-edit-${attachment.id}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(attachment.id);
                        setEditDocumentType(attachment.documentType ?? '');
                        setEditDescription(attachment.description ?? '');
                      }}
                      className="rounded-lg border border-border px-2 py-1 text-xs transition hover:bg-secondary"
                    >
                      ویرایش مشخصات
                    </button>
                    <button
                      type="button"
                      data-testid={`financial-attachment-delete-${attachment.id}`}
                      disabled={busy}
                      onClick={() => handleDelete(attachment.id)}
                      className="rounded-lg border border-destructive/40 px-2 py-1 text-xs text-destructive transition hover:bg-destructive/10"
                    >
                      حذف
                    </button>
                  </>
                )}
              </span>

              {editingId === attachment.id && (
                <div className="flex w-full flex-wrap items-end gap-2 rounded-xl border border-border p-3">
                  {attachment.documentType !== null && (
                    <label className="flex flex-col gap-1 text-xs">
                      <span>نوع سند</span>
                      <select
                        data-testid={`financial-attachment-edit-type-${attachment.id}`}
                        value={editDocumentType}
                        onChange={(event) =>
                          setEditDocumentType(event.target.value as FinancialCheckDocumentType | '')
                        }
                        className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                      >
                        {FINANCIAL_DOCUMENT_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {financialDocumentTypeLabel(type)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-xs">
                    <span>توضیحات</span>
                    <input
                      data-testid={`financial-attachment-edit-description-${attachment.id}`}
                      value={editDescription}
                      onChange={(event) => setEditDescription(event.target.value)}
                      className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    data-testid={`financial-attachment-edit-save-${attachment.id}`}
                    disabled={busy}
                    onClick={() => handleMetadataSave(attachment.id)}
                    className="h-9 rounded-lg bg-primary px-3 text-xs text-primary-foreground"
                  >
                    ذخیره
                  </button>
                  <button
                    type="button"
                    data-testid={`financial-attachment-edit-cancel-${attachment.id}`}
                    disabled={busy}
                    onClick={() => setEditingId(null)}
                    className="h-9 rounded-lg border border-border px-3 text-xs"
                  >
                    انصراف
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </FinancialCard>
  );
}
