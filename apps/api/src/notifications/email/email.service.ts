import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

  constructor() {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && port) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
      });
    } else {
      this.logger.warn('SMTP not configured — emails will be logged to console');
    }
  }

  async sendMail(to: string, subject: string, html: string, text?: string) {
    if (this.transporter) {
      const info = await this.transporter.sendMail({
        from: process.env.EMAIL_FROM || 'no-reply@ariaerp.example',
        to,
        subject,
        text: text || undefined,
        html,
      });
      this.logger.log(`Email sent: ${info.messageId}`);
      return info;
    }

    // Fallback: log the email (useful for dev)
    this.logger.log(`Email (logged) to=${to} subject="${subject}"`);
    this.logger.debug(html);
    return null;
  }
}
