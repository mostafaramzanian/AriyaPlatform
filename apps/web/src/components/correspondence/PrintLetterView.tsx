'use client';

import * as React from 'react';
import { Printer, X, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  CLASSIFICATION_LABELS,
  URGENCY_LABELS,
  corrUserName,
  formatCorrDate,
  type CorrLetter,
  type CorrRecipient,
} from '@/lib/correspondence-api';

/**
 * Phase 50: A4 print preview — the reference PrintLetterView concept over REAL
 * letter data, with the letterhead drawn from the letter's own sender/tenant
 * context. NOTHING is hard-coded: no fake company name, address, phone, sender or
 * signature. Confidential letters carry the classification watermark visually and
 * as a real label; the marking is never colour-only.
 *
 * The body HTML is SERVER-SANITIZED (correspondence-sanitize.util on the API);
 * rendering it is the same trust contract as the read view.
 */

export interface PrintLetterViewProps {
  open: boolean;
  onClose: () => void;
  letter: CorrLetter;
  bodyHtml: string;
  /** Recipients already filtered by the server per the viewer's BCC entitlement. */
  recipients: CorrRecipient[];
  /** The viewer's own display name for the signature block (from the auth session). */
  signerName: string | null;
  /** Tenant/organization display label from real context; null renders nothing fake. */
  organizationName: string | null;
}

export function PrintLetterView(props: PrintLetterViewProps) {
  const { open, onClose } = props;

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const isConfidential = props.letter.classification !== 'NORMAL';
  const toRows = props.recipients.filter((row) => row.kind === 'TO');
  const ccRows = props.recipients.filter((row) => row.kind === 'CC');

  return (
    <div dir="rtl" className="corr-print-overlay fixed inset-0 z-[100] overflow-auto bg-neutral-200/95">
      <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-neutral-300 bg-white/95 px-6 py-3 shadow-sm">
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          <Printer className="size-4" aria-hidden="true" />
          چاپ
        </button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500">پیش‌نمایش چاپ — A4</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پیش‌نمایش چاپ"
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100"
          >
            <X className="size-4" aria-hidden="true" />
            بستن
          </button>
        </div>
      </div>

      <div className="flex justify-center px-4 py-8">
        <PrintSheet
          letter={props.letter}
          bodyHtml={props.bodyHtml}
          toRows={toRows}
          ccRows={ccRows}
          signerName={props.signerName}
          organizationName={props.organizationName}
          isConfidential={isConfidential}
        />
      </div>

      <style>{`
        .corr-print-sheet {
          width: 210mm;
          min-height: 297mm;
          padding: 18mm 18mm 14mm 18mm;
          box-sizing: border-box;
        }
        .corr-signature-block, .corr-footer-block, .corr-header-block { break-inside: avoid; page-break-inside: avoid; }
        @media print {
          @page { size: A4; margin: 0; }
          html, body { background: #fff !important; }
          body * { visibility: hidden !important; }
          .corr-print-overlay, .corr-print-overlay * { visibility: visible !important; }
          .corr-print-overlay { position: static !important; background: #fff !important; overflow: visible !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .corr-print-sheet { box-shadow: none !important; width: 210mm !important; min-height: auto !important; margin: 0 !important; padding: 15mm 18mm !important; }
        }
      `}</style>
    </div>
  );
}

function PrintSheet({
  letter,
  bodyHtml,
  toRows,
  ccRows,
  signerName,
  organizationName,
  isConfidential,
}: {
  letter: CorrLetter;
  bodyHtml: string;
  toRows: CorrRecipient[];
  ccRows: CorrRecipient[];
  signerName: string | null;
  organizationName: string | null;
  isConfidential: boolean;
}) {
  return (
    <article className="corr-print-sheet relative flex flex-col bg-white text-neutral-900 shadow-2xl" lang="fa">
      {isConfidential && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rotate-[-30deg] text-[110px] font-extrabold tracking-widest text-rose-600/5">
            {CLASSIFICATION_LABELS[letter.classification]}
          </span>
        </div>
      )}

      <header className="corr-header-block border-b-2 border-neutral-900 pb-3 text-center">
        {organizationName && <p className="text-sm font-bold text-neutral-900">{organizationName}</p>}
        <div className="mt-2 flex items-center justify-center gap-3 text-[10.5px] text-neutral-600">
          <span>
            شماره: <strong className="font-mono tabular-nums">{letter.letterNumber ?? '—'}</strong>
          </span>
          <span aria-hidden="true">|</span>
          <span>تاریخ: {formatCorrDate(letter.letterDate ?? letter.sentAt ?? letter.createdAt)}</span>
          <span aria-hidden="true">|</span>
          <span className="inline-flex items-center gap-1">
            {isConfidential ? (
              <ShieldAlert className="size-3 text-rose-600" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-3 text-neutral-500" aria-hidden="true" />
            )}
            {CLASSIFICATION_LABELS[letter.classification]}
          </span>
          <span aria-hidden="true">|</span>
          <span>{URGENCY_LABELS[letter.urgency]}</span>
        </div>
      </header>

      <main className="flex-1 px-0 py-5">
        <h1 className="mb-4 text-center text-base font-bold leading-8">{letter.subject}</h1>

        <table className="mb-5 w-full text-[10.5px] leading-6">
          <tbody>
            <tr>
              <td className="w-24 py-0.5 text-neutral-500">فرستنده:</td>
              <td className="font-medium">{corrUserName(letter.sender)}</td>
            </tr>
            {toRows.length > 0 && (
              <tr>
                <td className="py-0.5 text-neutral-500">گیرندگان:</td>
                <td>{toRows.map((row) => corrUserName(row.user)).join('، ')}</td>
              </tr>
            )}
            {ccRows.length > 0 && (
              <tr>
                <td className="py-0.5 text-neutral-500">رونوشت:</td>
                <td>{ccRows.map((row) => corrUserName(row.user)).join('، ')}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div
          className="corr-print-body text-[11.5px] leading-8 text-neutral-900"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />

        <div className="corr-signature-block mt-10 flex items-end justify-between gap-4">
          <div className="text-[10px] text-neutral-500">
            {letter.category ? `موضوع: ${letter.category}` : ''}
          </div>
          <div className="text-center">
            <div className="text-[11px] font-bold text-neutral-900">
              {signerName ?? corrUserName(letter.sender)}
            </div>
            {letter.sender.jobTitle && (
              <div className="text-[10px] text-neutral-600">{letter.sender.jobTitle}</div>
            )}
            <div className="mt-8 border-t border-neutral-400 px-5 pt-1 text-[9px] text-neutral-500">
              مهر و امضاء
            </div>
          </div>
        </div>
      </main>

      <footer className="corr-footer-block border-t border-neutral-300 pt-2">
        <div className="flex items-center justify-between gap-3 text-[9px] text-neutral-600">
          <span className="font-semibold text-neutral-800">{organizationName ?? ''}</span>
          <span className="font-medium tabular-nums">صفحه ۱</span>
          <span
            className={
              isConfidential
                ? 'rounded border border-rose-500 px-2 py-0.5 font-bold text-rose-700'
                : 'rounded border border-neutral-400 px-2 py-0.5 font-bold text-neutral-700'
            }
          >
            {CLASSIFICATION_LABELS[letter.classification]}
          </span>
        </div>
      </footer>
    </article>
  );
}