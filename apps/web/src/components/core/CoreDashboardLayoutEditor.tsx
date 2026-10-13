'use client';

import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { widgetLabel, type WidgetLayoutEntry } from './core-widgets';

/**
 * Phase 49K: the dashboard layout editor (D3, D4).
 *
 * NO DRAG AND DROP, ON PURPOSE. Reordering is two buttons per row. Drag and drop would
 * need a pointer, a new dependency and a keyboard fallback that is invariably worse
 * than the buttons it replaces — and this control has to work in a keyboard-only,
 * screen-reader, RTL context. Up/down is also unambiguous in RTL, where a horizontal
 * gesture would have to be mirrored.
 *
 * PROPS, NOT THE PROVIDER. Every mutation arrives as a callback so this panel can be
 * rendered and asserted without a session, an HTTP mock or a context. `CoreDashboard`
 * wires the callbacks to `usePreferences`, which owns the optimistic write and the
 * rollback.
 *
 * SHOWS HIDDEN WIDGETS. The editor lists the FULL registry, including hidden entries —
 * a control that only listed what is visible would make hiding a widget irreversible.
 */

export interface CoreDashboardLayoutEditorProps {
  /** Full, ordered registry — hidden entries included. */
  layout: WidgetLayoutEntry[];
  onMove: (id: string, direction: -1 | 1) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
  /** False when nothing here will outlive the tab (anonymous / read failure). */
  persisted: boolean;
  onClose: () => void;
}

const iconButtonClass =
  'grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow disabled:cursor-not-allowed disabled:opacity-40';

export function CoreDashboardLayoutEditor({
  layout,
  onMove,
  onToggle,
  onReset,
  persisted,
  onClose,
}: CoreDashboardLayoutEditorProps) {
  return (
    <section
      aria-labelledby="core-layout-editor-heading"
      data-testid="core-layout-editor"
      className="core-card p-core-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="core-layout-editor-heading" className="text-sm font-semibold text-foreground">
          چیدمان کارت‌ها
        </h3>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            data-testid="core-layout-reset"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            بازگشت به چیدمان پیش‌فرض
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="core-layout-done"
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-primary transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
          >
            پایان
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        ترتیب کارت‌ها را تغییر دهید یا کارت‌هایی را که لازم ندارید پنهان کنید. تغییرات بی‌درنگ
        اعمال می‌شوند.
      </p>

      {!persisted && (
        <Alert
          type="info"
          className="mt-4"
          message="این چیدمان تا پایان همین نشست نگه داشته می‌شود و روی حساب شما ذخیره نمی‌شود."
        />
      )}

      <ul className="mt-4 divide-y divide-border" data-testid="core-layout-list">
        {layout.map((entry, index) => {
          const label = widgetLabel(entry.id);
          const checkboxId = `core-layout-visible-${entry.id}`;

          return (
            <li
              key={entry.id}
              data-testid="core-layout-row"
              data-widget-id={entry.id}
              data-visible={entry.visible}
              className="flex items-center gap-3 py-3"
            >
              <span className="w-6 shrink-0 text-xs text-muted-foreground">{index + 1}</span>

              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>

              <label htmlFor={checkboxId} className="flex shrink-0 items-center gap-2 text-xs">
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={entry.visible}
                  onChange={() => onToggle(entry.id)}
                  className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
                />
                <span className="text-muted-foreground">نمایش</span>
              </label>

              <button
                type="button"
                onClick={() => onMove(entry.id, -1)}
                disabled={index === 0}
                aria-label={`انتقال «${label}» به بالا`}
                title={`انتقال «${label}» به بالا`}
                data-testid="core-layout-up"
                className={iconButtonClass}
              >
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={() => onMove(entry.id, 1)}
                disabled={index === layout.length - 1}
                aria-label={`انتقال «${label}» به پایین`}
                title={`انتقال «${label}» به پایین`}
                data-testid="core-layout-down"
                className={iconButtonClass}
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
