// components/forms/BookDemoForm.tsx
'use client';

import { useState, FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { bookDemoFormSchema, type BookDemoFormData } from '@/lib/validation';
import { Alert } from '@/components/ui/alert';

export function BookDemoForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState<Partial<BookDemoFormData>>({
    companySize: '11-50',
    timeline: 'exploring',
  });

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const validated = bookDemoFormSchema.parse(formData);

      const response = await fetch('/api/book-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validated),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to book demo');
      }

      setSuccess(true);
      setFormData({
        companySize: '11-50',
        timeline: 'exploring',
      });
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error booking demo');
    } finally {
      setLoading(false);
    }
  }

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  if (success) {
    return (
      <Alert type="success" message="درخواست دموی سازمانی ارسال شد! تیم ما در طی 24 ساعت برای تأیید زمان دموی شما تماس خواهد گرفت." />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Input
          label="نام"
          name="firstName"
          placeholder="محمد"
          value={formData.firstName || ''}
          onChange={handleChange}
          required
        />
        <Input
          label="نام خانوادگی"
          name="lastName"
          placeholder="احمدی"
          value={formData.lastName || ''}
          onChange={handleChange}
          required
        />
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Input
          label="ایمیل کاری"
          name="email"
          type="email"
          placeholder="ایمیل کاری"
          value={formData.email || ''}
          onChange={handleChange}
          required
        />
        <Input
          label="تلفن"
          name="phone"
          type="tel"
          placeholder="۰۹۱۲۳۴۵۶۷۸۹"
          value={formData.phone || ''}
          onChange={handleChange}
          required
        />
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Input
          label="شرکت"
          name="company"
          placeholder="شرکت خود"
          value={formData.company || ''}
          onChange={handleChange}
          required
        />
        <Input
          label="سمت شغلی"
          name="jobTitle"
          placeholder="مدیر عملیات"
          value={formData.jobTitle || ''}
          onChange={handleChange}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Select
          label="اندازه شرکت"
          name="companySize"
          value={formData.companySize || '11-50'}
          onChange={handleChange}
          options={[
            { value: '1-10', label: '1-10 نفر' },
            { value: '11-50', label: '11-50 نفر' },
            { value: '51-200', label: '51-200 نفر' },
            { value: '201-1000', label: '201-1000 نفر' },
            { value: '1000+', label: '1000+ نفر' },
          ]}
          required
        />
        <Select
          label="جدول زمانی"
          name="timeline"
          value={formData.timeline || 'exploring'}
          onChange={handleChange}
          options={[
            { value: 'immediate', label: 'فوری (این ماه)' },
            { value: '1-3-months', label: '1-3 ماه' },
            { value: '3-6-months', label: '3-6 ماه' },
            { value: 'exploring', label: 'هنوز در حال بررسی' },
          ]}
          required
        />
      </div>

      <Textarea
        label="مورد استفاده (اختیاری)"
        name="useCase"
        placeholder="نیازهای خاص خود را برای ما شرح دهید..."
        value={formData.useCase || ''}
        onChange={handleChange}
        rows={4}
      />

      {error && <Alert type="error" message={error} />}

      <Button
        type="submit"
        disabled={loading}
        className="w-full sm:w-auto"
      >
        {loading ? 'در حال رزرو...' : 'رزرو دموی سازمانی'}
      </Button>

      <p className="text-sm text-muted-foreground">
        ما در طی 24 ساعت برای تأیید زمان دموی شما تماس خواهیم گرفت.
      </p>
    </form>
  );
}
