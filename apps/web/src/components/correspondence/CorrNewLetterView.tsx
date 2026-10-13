'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  LETTER_CATEGORIES,
  MAX_SUBJECT_LENGTH,
  createDraft,
  deleteAttachment,
  deleteSignature,
  downloadSignature,
  listLetterAttachments,
  newCorrKey,
  sendLetter,
  updateDraft,
  uploadSignature,
  uploadTempAttachment,
  fetchLetterContent,
  type CorrAttachment,
  type CorrLetter,
  type LetterClassification,
  type LetterUrgency,
} from '@/lib/correspondence-api';
import { ComposerBody, type ComposerAttachments, type ComposerState } from './ComposerBody';

/**
 * Phase 50: ایجاد نامه جدید — the composer (state + real actions; layout lives in
 * ComposerBody). The letter NUMBER is always server-minted; the SEND is always
 * idempotent via a fresh sendKey.
 */

const BODY_PLACEHOLDER = '<p>با سلام و احترام،</p><p>به استحضار می‌رساند …</p>';

export interface CorrNewLetterViewProps {
  /** Present when resuming an existing draft (the composer doubles as edit). */
  draftId?: string;
}

export function CorrNewLetterView({ draftId }: CorrNewLetterViewProps) {
  const router = useRouter();

  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState(BODY_PLACEHOLDER);
  const [category, setCategory] = React.useState<string>(LETTER_CATEGORIES[0]);
  const [urgency, setUrgency] = React.useState<LetterUrgency>('NORMAL');
  const [classification, setClassification] = React.useState<LetterClassification>('NORMAL');
  const [letterDate, setLetterDate] = React.useState('');
  const [toIds, setToIds] = React.useState<string[]>([]);
  const [ccIds, setCcIds] = React.useState<string[]>([]);
  const [bccIds, setBccIds] = React.useState<string[]>([]);
  const [showBcc, setShowBcc] = React.useState(false);

  const [letter, setLetter] = React.useState<CorrLetter | null>(null);
  const [attachments, setAttachments] = React.useState<CorrAttachment[]>([]);
  const [tempAttachmentIds, setTempAttachmentIds] = React.useState<string[]>([]);
  const [isBusy, setIsBusy] = React.useState(false);
  const [isAttachmentBusy, setIsAttachmentBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [signatureId, setSignatureId] = React.useState<string | null>(null);
  const [signatureUrl, setSignatureUrl] = React.useState<string | null>(null);
  const [letterNumber, setLetterNumber] = React.useState('');
  const [scheduledAtDate, setScheduledAtDate] = React.useState<string | null>(null);
  const [scheduledAtTime, setScheduledAtTime] = React.useState('');

  const refreshAttachments = React.useCallback(async (letterId: string) => {
    try {
      setAttachments(await listLetterAttachments(letterId));
    } catch {
      // A failed listing never blocks composing; the retry happens on next action.
    }
  }, []);

  // Resume an existing DRAFT (the composer doubles as the edit surface).
  React.useEffect(() => {
    if (!draftId) return;
    let active = true;
    fetchLetterContent(draftId)
      .then((content) => {
        if (!active) return;
        if (content.status === 'SENT' || content.status === 'CANCELLED') {
          router.replace(`/admin/correspondence/${draftId}`);
          return;
        }
        setLetter(content);
        setAttachments(content.attachments);
        setSubject(content.subject);
        setBody(content.bodyHtml);
        setCategory(content.category ?? LETTER_CATEGORIES[0]);
        setUrgency(content.urgency);
        setClassification(content.classification);
        setLetterNumber(content.letterNumber ?? '');
        setToIds((content.recipients ?? []).filter((r) => r.kind === 'TO').map((r) => r.user.id));
        setCcIds((content.recipients ?? []).filter((r) => r.kind === 'CC').map((r) => r.user.id));
        setShowBcc((content.recipients ?? []).some((r) => r.kind === 'BCC'));
        setBccIds(
          (content.recipients ?? [])
            .filter((r) => r.kind === 'BCC' && content.canSeeBcc)
            .map((r) => r.user.id),
        );
        if (content.signatureId) {
          setSignatureId(content.signatureId);
          downloadSignature(content.signatureId)
            .then((sig) => setSignatureUrl(sig.url))
            .catch(() => setSignatureUrl(null));
        } else {
          setSignatureId(null);
          setSignatureUrl(null);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'بازیابی پیش‌نویس ناموفق بود.');
      });
    return () => {
      active = false;
    };
  }, [draftId, router]);

  const validate = (): string | null => {
    const subjectTrimmed = subject.trim();
    if (subjectTrimmed.length === 0) return 'موضوع نامه الزامی است.';
    if (subjectTrimmed.length > MAX_SUBJECT_LENGTH) {
      return 'موضوع نامه طولانی‌تر از حد مجاز است.';
    }
    const bodyText = body.replace(/<[^>]+>/g, '').trim();
    if (bodyText.length === 0) return 'متن نامه الزامی است.';
    return null;
  };

  const payload = React.useCallback(
    () => ({
      subject: subject.trim(),
      body,
      category: category || null,
      urgency,
      classification,
      letterDate: null,
      recipientIds: toIds,
      ccIds,
      bccIds,
      letterNumber: letterNumber.trim() || null,
      signatureId: signatureId,
      tempAttachmentIds,
      scheduledAtDate,
      scheduledAtTime: scheduledAtTime || null,
    }),
    [
      subject,
      body,
      category,
      urgency,
      classification,
      // `letterDate` is intentionally absent: payload() hardcodes
      // `letterDate: null`, so the callback never reads the state — listing it
      // as a dependency was flagged by `react-hooks/exhaustive-deps`.
      toIds,
      ccIds,
      bccIds,
      letterNumber,
      signatureId,
      tempAttachmentIds,
      scheduledAtDate,
      scheduledAtTime,
    ],
  );

  const handleSaveDraft = async () => {
    setError(null);
    const invalid = validate();
    if (invalid) {
      setValidationError(invalid);
      return;
    }
    setValidationError(null);
    setIsBusy(true);
    try {
      const saved = letter ? await updateDraft(letter.id, payload()) : await createDraft(payload());
      setLetter(saved);
      void refreshAttachments(saved.id);
      if (!draftId) router.replace(`/admin/correspondence/new/${saved.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ذخیره پیش‌نویس ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSend = async () => {
    setError(null);
    const invalid = validate();
    if (invalid) {
      setValidationError(invalid);
      return;
    }
    if (toIds.length === 0 && ccIds.length === 0 && bccIds.length === 0) {
      setValidationError('حداقل یک گیرنده برای ارسال الزامی است.');
      return;
    }
    setValidationError(null);
    setIsBusy(true);
    try {
      const target = letter ? await updateDraft(letter.id, payload()) : await createDraft(payload());
      const sendKey = newCorrKey();
      if (scheduledAtDate && !scheduledAtTime) {
        setError('برای ارسال زمان‌دار باید ساعت را هم وارد کنید.');
        setIsBusy(false);
        return;
      }
      await sendLetter(target.id, sendKey, scheduledAtDate, scheduledAtTime || null);
      router.push('/admin/correspondence/sent');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ارسال نامه ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleUploadAttachment = async (file: File) => {
    setError(null);
    setIsAttachmentBusy(true);
    try {
      const temp = await uploadTempAttachment(file);
      setAttachments((prev) => [...prev, temp]);
      setTempAttachmentIds((prev) => [...prev, temp.id]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'بارگذاری پیوست ناموفق بود.');
    } finally {
      setIsAttachmentBusy(false);
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    setError(null);
    setIsAttachmentBusy(true);
    try {
      await deleteAttachment(attachmentId);
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      setTempAttachmentIds((prev) => prev.filter((id) => id !== attachmentId));
      if (letter) await refreshAttachments(letter.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'حذف پیوست ناموفق بود.');
    } finally {
      setIsAttachmentBusy(false);
    }
  };

  const handleUploadSignature = async (fileOrDataUrl: File | string) => {
    setError(null);
    setIsBusy(true);
    try {
      let file: File;
      if (typeof fileOrDataUrl === 'string') {
        const res = await fetch(fileOrDataUrl);
        const blob = await res.blob();
        file = new File([blob], 'signature.png', { type: 'image/png' });
      } else {
        file = fileOrDataUrl;
      }
      const sig = await uploadSignature(file);
      setSignatureId(sig.id);
      setSignatureUrl(sig.url ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'بارگذاری امضا ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleClearSignature = async () => {
    if (signatureId) {
      setIsBusy(true);
      try {
        await deleteSignature(signatureId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'حذف امضا ناموفق بود.');
      } finally {
        setIsBusy(false);
      }
    }
    setSignatureId(null);
    setSignatureUrl(null);
  };

  const attachmentsState: ComposerAttachments = {
    items: attachments,
    canUpload: true,
    busy: isAttachmentBusy || isBusy,
    onUpload: (file) => void handleUploadAttachment(file),
    onDelete: (attachmentId) => void handleDeleteAttachment(attachmentId),
  };

  const state: ComposerState = {
    subject,
    setSubject,
    category,
    setCategory,
    urgency,
    setUrgency,
    classification,
    setClassification,
    letterDate,
    setLetterDate,
    toIds,
    setToIds,
    ccIds,
    setCcIds,
    bccIds,
    setBccIds,
    showBcc,
    setShowBcc,
    body,
    setBody,
    signatureUrl,
    setSignatureUrl,
    letterNumber,
    setLetterNumber,
    scheduledAtDate,
    setScheduledAtDate,
    scheduledAtTime,
    setScheduledAtTime,
  };

  return (
    <ComposerBody
      letter={letter}
      state={state}
      validationError={validationError}
      error={error}
      isBusy={isBusy}
      attachments={attachmentsState}
      onSaveDraft={handleSaveDraft}
      onSend={handleSend}
      onSignatureUpload={handleUploadSignature}
      onSignatureClear={handleClearSignature}
      onCancel={() => router.push('/admin/correspondence/drafts')}
    />
  );
}