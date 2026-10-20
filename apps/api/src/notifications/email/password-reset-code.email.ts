/**
 * The email that carries a password-reset CODE.
 *
 * WHY THE CODE IS IN THE SUBJECT LINE AND IN A MONOSPACE BLOCK. This is the ONE message whose
 * whole purpose is to be transcribed: the recipient opens it, reads six digits and types them
 * into the form. So the code is the first thing in the subject (visible in a notification
 * preview without opening anything), it is rendered in Latin digits as a large, spaced,
 * selectable block — and it appears in the plain-text alternative too, because a client that
 * refuses HTML must still be able to complete the flow.
 *
 * WHAT IT NEVER CONTAINS:
 *  - no login LINK with a credential in it. The code is a secret the user must TYPE, so the
 *    message carries no URL that would hand it to whatever renders the link preview;
 *  - no hint about the account beyond the address the mail was sent TO (no name, no role, no
 *    tenant) — an intercepted message says nothing about the organization;
 *  - no "your password was reset" wording: nothing has happened yet at this point, and a
 *    message that claimed otherwise would be a lie the user might act on.
 *
 * WHY THE COPY IS HERE AND NOT IN THE SERVICE: the wording is part of the platform's Persian
 * voice, and it must be assertable in a test without an SMTP connection. `AuthService` decides
 * WHEN to send; this module decides WHAT the user reads.
 */
export interface PasswordResetCodeEmailInput {
  /** The six-digit code, already generated. Rendered as-is (Latin digits). */
  code: string;
  /** How long the code stays valid, in minutes — the same number the row stores. */
  expiresInMinutes: number;
  /** The application URL, shown as plain text so the user knows where to type the code. */
  appUrl: string;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** The subject: the code first, so a notification preview is already useful. */
export function passwordResetCodeSubject(code: string): string {
  return `کد بازیابی رمز عبور: ${code}`;
}

export function passwordResetCodeEmail(input: PasswordResetCodeEmailInput): EmailContent {
  const subject = passwordResetCodeSubject(input.code);
  // Spaced digits: easier to read aloud and to transcribe, and the spaces are stripped by the
  // input on the other side (the platform normalizes Persian and Latin digits either way).
  const spaced = input.code.split('').join(' ');

  const text = [
    `کد بازیابی رمز عبور شما: ${input.code}`,
    '',
    `این کد تا ${input.expiresInMinutes} دقیقه اعتبار دارد و فقط یک بار قابل استفاده است.`,
    `اگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید؛ رمز عبور فعلی شما تغییری نمی‌کند.`,
    '',
    `برای وارد کردن کد به نشانی ${input.appUrl} بروید و گزینهٔ «رمز عبور را فراموش کرده‌ام» را انتخاب کنید.`,
  ].join('\n');

  const html = [
    '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f5f6fa;padding:24px">',
    '  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ef;border-radius:16px;padding:24px">',
    '    <h1 style="margin:0 0 8px;font-size:18px;color:#111827">بازیابی رمز عبور</h1>',
    '    <p style="margin:0 0 16px;font-size:13px;line-height:22px;color:#4b5563">',
    '      کد زیر را در صفحهٔ بازیابی رمز عبور وارد کنید.',
    '    </p>',
    '    <div style="margin:0 0 16px;padding:16px;text-align:center;background:#eef2ff;border:1px dashed #c7d2fe;border-radius:12px">',
    `      <div style="font-family:Consolas,Menlo,monospace;font-size:30px;letter-spacing:6px;color:#1f2937" dir="ltr">${spaced}</div>`,
    '    </div>',
    `    <p style="margin:0 0 8px;font-size:13px;line-height:22px;color:#4b5563">این کد تا ${input.expiresInMinutes} دقیقه اعتبار دارد و فقط یک بار قابل استفاده است.</p>`,
    '    <p style="margin:0;font-size:13px;line-height:22px;color:#4b5563">',
    '      اگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید؛ رمز عبور فعلی شما تغییری نمی‌کند.',
    '    </p>',
    '    <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb" />',
    `    <p style="margin:0;font-size:12px;line-height:20px;color:#6b7280">برای وارد کردن کد به نشانی <span dir="ltr">${input.appUrl}</span> بروید و گزینهٔ «رمز عبور را فراموش کرده‌ام» را انتخاب کنید.</p>`,
    '  </div>',
    '</div>',
  ].join('\n');

  return { subject, html, text };
}