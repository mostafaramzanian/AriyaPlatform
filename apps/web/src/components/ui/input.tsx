import * as React from 'react';

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, className = '', ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="mb-2 block text-sm font-medium text-foreground" htmlFor={props.id ?? props.name}>
            {label}
            {props.required && <span className="text-destructive mr-1">*</span>}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full rounded-xl border border-input bg-surface px-4 py-2 text-foreground transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 ${className}`}
          {...props}
        />
      </div>
    );
  }
);
Input.displayName = 'Input';
