'use client';

import * as React from 'react';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  AlignRight,
  AlignCenter,
  AlignLeft,
  AlignJustify,
  List,
  ListOrdered,
  Link2,
  Image as ImageIcon,
  Palette,
  Highlighter,
  Quote,
  Undo2,
  Redo2,
  Heading1,
  Heading2,
  Type,
} from 'lucide-react';

/**
 * Phase 50: the letter rich-text editor.
 *
 * A contentEditable surface with a formatting toolbar — the same interaction model
 * as the reference editor, built on the repository's own primitives instead of a new
 * dependency (audited: no TipTap/Lexical/Quill/Slate in apps/web, and the survey
 * editor (49H) already established the hand-rolled precedent).
 *
 * SECURITY MODEL: the editor is an INPUT device only. Whatever it produces is sent
 * to the server, which passes it through the allowlist sanitizer before storage;
 * rendering elsewhere always uses the server-sanitized `bodyHtml`. Nothing this
 * component emits is ever trusted on read-back.
 */

export interface RichLetterEditorProps {
  /** Controlled HTML. Unsanitized client-side — the server sanitizes on write. */
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

interface Command {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  arg?: string;
}

const INLINE_COMMANDS: Command[] = [
  { icon: Bold, label: 'درشت (Ctrl+B)', arg: 'bold' },
  { icon: Italic, label: 'خمیده (Ctrl+I)', arg: 'italic' },
  { icon: UnderlineIcon, label: 'زیرخط (Ctrl+U)', arg: 'underline' },
  { icon: Strikethrough, label: 'خط‌خورده', arg: 'strikeThrough' },
];

const BLOCK_COMMANDS: Command[] = [
  { icon: Heading1, label: 'عنوان ۱', arg: 'formatBlock<h1>' },
  { icon: Heading2, label: 'عنوان ۲', arg: 'formatBlock<h2>' },
  { icon: Type, label: 'متن عادی', arg: 'formatBlock<p>' },
];

const ALIGN_COMMANDS: Command[] = [
  { icon: AlignRight, label: 'راست‌چین', arg: 'justifyRight' },
  { icon: AlignCenter, label: 'وسط‌چین', arg: 'justifyCenter' },
  { icon: AlignLeft, label: 'چپ‌چین', arg: 'justifyLeft' },
  { icon: AlignJustify, label: 'هم‌تراز', arg: 'justifyFull' },
];

const LIST_COMMANDS: Command[] = [
  { icon: List, label: 'فهرست نقطه‌ای', arg: 'insertUnorderedList' },
  { icon: ListOrdered, label: 'فهرست شماره‌دار', arg: 'insertOrderedList' },
  { icon: Quote, label: 'نقل قول', arg: 'formatBlock<blockquote>' },
];

/** Splits `formatBlock<h1>` into (formatBlock, <h1>); plain commands stay single. */
function runCommand(command: Command, exec: EditorExec) {
  const raw = command.arg ?? '';
  const angle = raw.indexOf('<');
  if (raw.startsWith('formatBlock') && angle > 0) {
    exec('formatBlock', raw.slice(angle));
  } else {
    exec(raw, undefined);
  }
}

type EditorExec = (command: string, value?: string) => void;

/** A toolbar button. Module scope — see the note inside `RichLetterEditor`. */
function ToolButton({
  command,
  disabled,
  onRun,
}: {
  command: Command;
  disabled?: boolean;
  onRun: (command: Command) => void;
}) {
  const Icon = command.icon;
  return (
    <button
      type="button"
      aria-label={command.label}
      title={command.label}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => onRun(command)}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** The vertical rule between toolbar groups. Module scope — see the note inside `RichLetterEditor`. */
function ToolbarSeparator() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />;
}

export function RichLetterEditor({ value, onChange, disabled, placeholder }: RichLetterEditorProps) {
  const editorRef = React.useRef<HTMLDivElement>(null);
  const [linkUrl, setLinkUrl] = React.useState('');
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [colorOpen, setColorOpen] = React.useState<'fore' | 'back' | null>(null);
  const [selectedColor, setSelectedColor] = React.useState('#2563eb');
  const [imageUrl, setImageUrl] = React.useState('');
  const [imageOpen, setImageOpen] = React.useState(false);

  const wordCount = React.useMemo(() => {
    const text = (value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.split(' ').filter(Boolean).length : 0;
  }, [value]);

  const exec = React.useCallback(
    (command: string, commandValue?: string) => {
      const el = editorRef.current;
      if (!el || disabled) return;
      el.focus();
      document.execCommand(command, false, commandValue);
      onChange(el.innerHTML);
    },
    [disabled, onChange],
  );

  const handleInput = React.useCallback(() => {
    const el = editorRef.current;
    if (!el || disabled) return;
    onChange(el.innerHTML);
  }, [disabled, onChange]);

  const sanitizePastedHtml = React.useCallback((html: string): string => {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<!--\[if[^]*?\]-->/gi, '')
      .replace(/style="([^"]*)"/gi, (_, styles) => {
        const align = styles.match(/text-align\s*:\s*([^;"\s]+)/i);
        if (!align) return '';
        const a = align[1].toLowerCase();
        if (a === 'left') return '';
        return `style="text-align:${a};"`;
      })
      .replace(/ class="[^"]*"/gi, '')
      .replace(/ dir="[^"]*"/gi, '')
      .replace(/<span[^>]*>\s*<\/span>/gi, '');
  }, []);

  const handlePaste = React.useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const html = event.clipboardData.getData('text/html');
      let content: string;
      if (html) {
        content = sanitizePastedHtml(html);
      } else {
        const text = event.clipboardData.getData('text/plain');
        content = text.replace(/\r?\n/g, '<br>');
      }
      document.execCommand('insertHTML', false, content);
      handleInput();
    },
    [handleInput, sanitizePastedHtml],
  );

  // Set initial HTML once on mount (uncontrolled contentEditable pattern).
  React.useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (el.innerHTML !== (value ?? '')) {
      el.innerHTML = value ?? '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native input listener for contentEditable.
  React.useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const listener = () => handleInput();
    el.addEventListener('input', listener);
    el.addEventListener('keyup', listener);
    return () => {
      el.removeEventListener('input', listener);
      el.removeEventListener('keyup', listener);
    };
  }, [handleInput]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      exec('undo');
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      exec('redo');
    }
  };

  const insertLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    setLinkUrl('');
    // Only http(s) links are insertable; the server sanitizer re-checks anyway.
    if (/^https?:\/\//i.test(url)) exec('createLink', url);
  };

  const insertImage = () => {
    const url = imageUrl.trim();
    setImageOpen(false);
    setImageUrl('');
    if (/^https?:\/\//i.test(url)) {
      exec('insertImage', url);
    }
  };

  const applyColor = (mode: 'fore' | 'back') => {
    const color = selectedColor;
    setColorOpen(null);
    if (mode === 'fore') {
      exec('foreColor', color);
    } else {
      exec('hiliteColor', color);
    }
  };

  const COLORS = [
    '#000000', '#ffffff', '#ef4444', '#f97316', '#f59e0b',
    '#84cc16', '#22c55e', '#10b981', '#06b6d4', '#3b82f6',
    '#8b5cf6', '#d946ef', '#f43f5e', '#78716c', '#94a3b8',
  ];

  // The toolbar pieces (`ToolButton`, `ToolbarSeparator`) live at module scope —
  // a component minted inside render would get a fresh identity on every
  // keystroke and remount the whole toolbar (`react-hooks/static-components`).
  const runToolbarCommand = (command: Command) => runCommand(command, exec);

  return (
    <div className="overflow-hidden rounded-xl border border-input bg-surface">
      <div
        role="toolbar"
        aria-label="ابزار قالب‌بندی نامه"
        className="flex flex-wrap items-center gap-0.5 border-b border-border bg-secondary/40 px-2 py-1.5"
      >
        {INLINE_COMMANDS.map((command, index) => (
          <ToolButton
            key={`inline-${index}`}
            command={command}
            disabled={disabled}
            onRun={runToolbarCommand}
          />
        ))}
        <ToolbarSeparator />
        {BLOCK_COMMANDS.map((command, index) => (
          <ToolButton
            key={`block-${index}`}
            command={command}
            disabled={disabled}
            onRun={runToolbarCommand}
          />
        ))}
        <ToolbarSeparator />
        {ALIGN_COMMANDS.map((command, index) => (
          <ToolButton
            key={`align-${index}`}
            command={command}
            disabled={disabled}
            onRun={runToolbarCommand}
          />
        ))}
        <ToolbarSeparator />
        {LIST_COMMANDS.map((command, index) => (
          <ToolButton
            key={`list-${index}`}
            command={command}
            disabled={disabled}
            onRun={runToolbarCommand}
          />
        ))}
        <ToolbarSeparator />
        <button
          type="button"
          aria-label="افزودن پیوند"
          title="افزودن پیوند"
          disabled={disabled}
          aria-expanded={linkOpen}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setLinkOpen((open) => !open)}
        >
          <Link2 className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="افزودن تصویر"
          title="افزودن تصویر"
          disabled={disabled}
          aria-expanded={imageOpen}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setImageOpen((open) => !open)}
        >
          <ImageIcon className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="رنگ متن"
          title="رنگ متن"
          disabled={disabled}
          aria-expanded={colorOpen === 'fore'}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setColorOpen((prev) => (prev === 'fore' ? null : 'fore'))}
        >
          <Palette className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="هایلایت متن"
          title="هایلایت متن"
          disabled={disabled}
          aria-expanded={colorOpen === 'back'}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setColorOpen((prev) => (prev === 'back' ? null : 'back'))}
        >
          <Highlighter className="size-3.5" />
        </button>
        <ToolButton
          command={{ icon: Undo2, label: 'واگرد', arg: 'undo' }}
          disabled={disabled}
          onRun={runToolbarCommand}
        />
        <ToolButton
          command={{ icon: Redo2, label: 'بازانجام', arg: 'redo' }}
          disabled={disabled}
          onRun={runToolbarCommand}
        />

        {linkOpen && (
          <span className="mr-2 flex items-center gap-1">
            <input
              type="url"
              aria-label="نشانی پیوند"
              placeholder="https://…"
              className="h-7 w-44 rounded-lg border border-input bg-background px-2 text-[11px] text-foreground focus:border-primary focus:outline-none"
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  insertLink();
                }
                if (event.key === 'Escape') setLinkOpen(false);
              }}
              autoFocus
            />
            <button
              type="button"
              className="h-7 rounded-lg bg-primary px-2 text-[11px] font-medium text-primary-foreground"
              onClick={insertLink}
            >
              درج
            </button>
          </span>
        )}

        {imageOpen && (
          <span className="mr-2 flex items-center gap-1">
            <input
              type="url"
              aria-label="نشانی تصویر"
              placeholder="https://…"
              className="h-7 w-44 rounded-lg border border-input bg-background px-2 text-[11px] text-foreground focus:border-primary focus:outline-none"
              value={imageUrl}
              onChange={(event) => setImageUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  insertImage();
                }
                if (event.key === 'Escape') setImageOpen(false);
              }}
              autoFocus
            />
            <button
              type="button"
              className="h-7 rounded-lg bg-primary px-2 text-[11px] font-medium text-primary-foreground"
              onClick={insertImage}
            >
              درج تصویر
            </button>
          </span>
        )}

        {colorOpen && (
          <span className="mr-2 flex items-center gap-1">
            <div className="flex items-center gap-1 p-1 rounded-lg border border-input bg-background">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => { setSelectedColor(color); applyColor(colorOpen); }}
                  className="size-5 rounded-full border border-border focus:outline focus:outline-1 focus:outline-ring"
                  style={{ background: color }}
                  aria-label={`رنگ ${color}`}
                />
              ))}
            </div>
            <button
              type="button"
              className="h-7 rounded-lg bg-primary px-2 text-[11px] font-medium text-primary-foreground"
              onClick={() => applyColor(colorOpen)}
            >
              اعمال
            </button>
          </span>
        )}

        <span className="mr-auto text-[10px] tabular-nums text-muted-foreground">
          {wordCount.toLocaleString('fa-IR')} واژه
        </span>
      </div>

      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="متن نامه"
        data-placeholder={placeholder}
        className="corr-editor w-full px-4 py-3 text-sm leading-8 text-foreground outline-none break-words"
        dir="rtl"
        style={{ minHeight: 220, maxHeight: 400, overflowY: 'auto', direction: 'rtl', textAlign: 'right', color: 'inherit' }}
        onInput={handleInput}
        onBlur={handleInput}
        onKeyUp={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
      />

      <style>{`
        .corr-editor { color: hsl(var(--foreground)); }
        .corr-editor:empty::before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground));
          pointer-events: none;
        }
        .corr-editor h1 { font-size: 1.25rem; font-weight: 700; margin: 0.5em 0; color: hsl(var(--foreground)); }
        .corr-editor h2 { font-size: 1.1rem; font-weight: 700; margin: 0.5em 0; color: hsl(var(--foreground)); }
        .corr-editor p { margin: 0.4em 0; color: hsl(var(--foreground)); }
        .corr-editor ul, .corr-editor ol { padding-inline-start: 1.5rem; margin: 0.4em 0; color: hsl(var(--foreground)); }
        .corr-editor ul { list-style: disc; }
        .corr-editor ol { list-style: decimal; }
        .corr-editor blockquote {
          border-inline-start: 3px solid hsl(var(--border));
          padding-inline-start: 0.75rem;
          color: hsl(var(--muted-foreground));
          margin: 0.5em 0;
        }
        .corr-editor a { color: hsl(var(--primary)); text-decoration: underline; }
      `}</style>
    </div>
  );
}