// components/forms/ContactForm.tsx
'use client';

import { useState, FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { contactFormSchema, type ContactFormData } from '@/lib/validation';
import { Alert } from '@/components/ui/alert';

export function ContactForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState<Partial<ContactFormData>>({});

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const validated = contactFormSchema.parse(formData);

      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validated),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to submit form');
      }

      setSuccess(true);
      setFormData({});
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error submitting form');
    } finally {
      setLoading(false);
    }
  }

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  if (success) {
    return (
      <Alert type="success" message="پیام با موفقیت ارسال شد! به زودی با شما تماس خواهیم گرفت." />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Input
          label="نام"
          name="name"
          placeholder="نام خود را وارد کنید"
          value={formData.name || ''}
          onChange={handleChange}
          required
        />
        <Input
          label="ایمیل"
          name="email"
          type="email"
          placeholder="ایمیل شما"
          value={formData.email || ''}
          onChange={handleChange}
          required
        />
      </div>

      <Input
        label="شرکت (اختیاری)"
        name="company"
        placeholder="شرکت خود"
        value={formData.company || ''}
        onChange={handleChange}
      />

      <Input
        label="تلفن (اختیاری)"
        name="phone"
        type="tel"
        placeholder="۰۹۱۲۳۴۵۶۷۸۹"
        value={formData.phone || ''}
        onChange={handleChange}
      />

      <Textarea
        label="پیام"
        name="message"
        placeholder="چگونه می‌توانیم کمک کنیم..."
        value={formData.message || ''}
        onChange={handleChange}
        rows={5}
        required
      />

      {error && <Alert type="error" message={error} />}

      <Button
        type="submit"
        disabled={loading}
        className="w-full sm:w-auto"
      >
        {loading ? 'در حال ارسال...' : 'ارسال پیام'}
      </Button>
    </form>
  );
}
