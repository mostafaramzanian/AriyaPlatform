'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { useAuth } from '@/components/providers/AuthProvider';

export function LoginForm() {
  const router = useRouter();
  const { login, error, isLoading, clearError } = useAuth();
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (error) clearError();

    try {
      await login(formData);
      router.push('/');
    } catch {
      // Error is already captured in auth context.
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Input
        label="ایمیل"
        name="email"
        type="email"
        value={formData.email}
        onChange={handleChange}
        placeholder="ایمیل شما"
        required
        disabled={isLoading}
      />

      <Input
        label="رمز عبور"
        name="password"
        type="password"
        value={formData.password}
        onChange={handleChange}
        placeholder="••••••••"
        required
        disabled={isLoading}
        minLength={8}
      />

      {error && <Alert type="error" message={error} />}

      <Button type="submit" disabled={isLoading} className="w-full">
        {isLoading ? 'در حال ورود...' : 'ورود'}
      </Button>

      {process.env.NODE_ENV !== 'production' && (
        <div className="mt-3 rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground">
          حساب آزمایشی: <span className="font-medium text-foreground">admin@localhost</span> /{' '}
          <span className="font-medium text-foreground">ChangeMe123!</span>
        </div>
      )}
    </form>
  );
}
