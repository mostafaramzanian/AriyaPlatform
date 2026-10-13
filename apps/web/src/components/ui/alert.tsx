export interface AlertProps {
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  className?: string;
}

export function Alert({ type, message, className = '' }: AlertProps) {
  const variantStyles = {
    success: 'border-success/30 bg-success/10 text-success',
    error: 'border-destructive/30 bg-destructive/10 text-destructive',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    info: 'border-primary/30 bg-primary/10 text-primary',
  };

  return (
    <div
      role="alert"
      className={`rounded-xl border px-4 py-3 text-sm ${variantStyles[type]} ${className}`}
    >
      {message}
    </div>
  );
}
