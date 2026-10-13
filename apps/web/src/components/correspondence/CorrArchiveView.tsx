'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Archive, FolderInput, FolderOpen, FolderPlus, Trash2, Undo2 } from 'lucide-react';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  archiveLetter,
  corrUserName,
  createArchiveFolder,
  deleteArchiveFolder,
  formatCorrDate,
  listArchive,
  listArchiveFolders,
  unarchiveLetter,
  type CorrArchiveEntry,
  type CorrArchiveFolder,
} from '@/lib/correspondence-api';
import { ClassificationBadge, UrgencyBadge } from './CorrBadges';

/**
 * Phase 50: بایگانی — the reference ArchivePage over the REAL archive contract.
 * Folders are per-user server rows (never client state); letters are per-user
 * archive ENTRIES whose canonical letter is never destroyed. The reference's
 * drag/drop is deliberately a lean control here — the backend stays
 * authoritative over folder assignment.
 */

const PAGE_LIMIT = 25;

export function CorrArchiveView() {
  const router = useRouter();
  const [folders, setFolders] = React.useState<CorrArchiveFolder[]>([]);
  const [activeFolder, setActiveFolder] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<CorrArchiveEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [newFolderName, setNewFolderName] = React.useState('');
  const [isBusy, setIsBusy] = React.useState(false);
  // Re-arms loading/cleared in the folder-switch and mutation handlers below
  // (same commit as the token/folder bump), so the fetch effect needs no
  // in-effect setter resets. First mount is covered by `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = React.useState<string | null>(null);
  const [confirmUnarchive, setConfirmUnarchive] = React.useState<string | null>(null);
  // انتقال به پوشه (the reference ArchiveModal's move interaction): the server
  // upserts the per-user archive entry, so re-archiving MOVES the letter.
  const [moveFor, setMoveFor] = React.useState<string | null>(null);
  const [moveTarget, setMoveTarget] = React.useState('');

  React.useEffect(() => {
    let active = true;
    listArchiveFolders()
      .then((rows) => {
        if (active) setFolders(rows);
      })
      .catch(() => {
        /* folder load failure keeps the unfiled view usable */
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);

  React.useEffect(() => {
    let active = true;
    listArchive(activeFolder, { limit: PAGE_LIMIT })
      .then((result) => {
        if (active) setEntries(result.items);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'خواندن بایگانی ناموفق بود.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeFolder, reloadToken]);

  const withBusy = (action: () => Promise<unknown>) => async () => {
    setActionError(null);
    setIsBusy(true);
    try {
      await action();
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'اقدام ناموفق بود.');
    } finally {
      setIsBusy(false);
      setConfirmDeleteFolder(null);
      setConfirmUnarchive(null);
    }
  };

  // Folder switches re-arm loading/cleared in this handler (same commit as the
  // folder state change), replacing the removed in-effect setter resets.
  const openFolder = (folderId: string | null) => {
    setActiveFolder(folderId);
    setIsLoading(true);
    setError(null);
  };

  const doCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setActionError(null);
    setIsBusy(true);
    try {
      await createArchiveFolder({ name });
      setNewFolderName('');
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'ایجاد پوشه ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  const activeFolderName =
    folders.find((folder) => folder.id === activeFolder)?.name ?? 'بدون پوشه';

  const doMove = async (entry: CorrArchiveEntry) => {
    setActionError(null);
    setIsBusy(true);
    try {
      await archiveLetter(entry.letterId, moveTarget || null);
      setMoveFor(null);
      setMoveTarget('');
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'انتقال نامه ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="size-11 rounded-xl gradient-primary grid place-items-center shadow-glow">
            <Archive className="size-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">بایگانی مکاتبات</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              بایگانی هر کاربر جداگانه است؛ برداشتن نامه از بایگانی هرگز نامه اصلی را حذف نمی‌کند.
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-3 rounded-2xl border border-border bg-card p-3 shadow-card" aria-label="پوشه‌ها">
          <button
            type="button"
            onClick={() => openFolder(null)}
            aria-current={activeFolder === null ? 'true' : undefined}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs transition ${
              activeFolder === null
                ? 'bg-primary/10 font-bold text-primary'
                : 'text-foreground hover:bg-secondary/50'
            }`}
          >
            <FolderOpen className="size-4" aria-hidden="true" />
            بدون پوشه
          </button>
          {folders.map((folder) => (
            <div key={folder.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => openFolder(folder.id)}
                aria-current={activeFolder === folder.id ? 'true' : undefined}
                className={`flex flex-1 items-center gap-2 truncate rounded-lg px-3 py-2 text-xs transition ${
                  activeFolder === folder.id
                    ? 'bg-primary/10 font-bold text-primary'
                    : 'text-foreground hover:bg-secondary/50'
                }`}
              >
                <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{folder.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{folder.entryCount}</span>
              </button>
              {confirmDeleteFolder === folder.id ? (
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void withBusy(() => deleteArchiveFolder(folder.id))()}
                    className="rounded-md border border-destructive/40 px-1.5 py-1 text-[10px] font-bold text-destructive disabled:opacity-60"
                  >
                    مطمئنم
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteFolder(null)}
                    className="rounded-md border border-border px-1.5 py-1 text-[10px]"
                  >
                    خیر
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`حذف پوشه ${folder.name}`}
                  disabled={isBusy}
                  onClick={() => setConfirmDeleteFolder(folder.id)}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
          <div className="space-y-1.5 border-t border-border pt-3">
            <label htmlFor="corr-new-folder" className="text-[11px] font-medium text-muted-foreground">
              پوشه جدید
            </label>
            <div className="flex gap-1.5">
              <input
                id="corr-new-folder"
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void doCreateFolder();
                }}
                className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none transition focus:border-ring"
              />
              <button
                type="button"
                aria-label="ایجاد پوشه"
                disabled={isBusy || !newFolderName.trim()}
                onClick={() => void doCreateFolder()}
                className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
              >
                <FolderPlus className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </aside>
        <section className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-card" aria-label={`نامه‌های ${activeFolderName}`}>
          {actionError && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {actionError}
            </p>
          )}
          {error && (
            <p role="alert" className="px-1 text-xs text-destructive">
              {error}
            </p>
          )}
          {isLoading && (
            <p className="px-1 text-xs text-muted-foreground">در حال خواندن بایگانی…</p>
          )}
          {!isLoading && !error && entries.length === 0 && (
            <p className="rounded-xl bg-secondary/40 px-4 py-6 text-center text-xs text-muted-foreground">
              در «{activeFolderName}» نامه‌ای بایگانی نشده است.
            </p>
          )}
          {!isLoading &&
            entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-card hover:bg-secondary/40 transition"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {entry.letter.letterNumber ?? '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => router.push(`/admin/correspondence/${entry.letterId}`)}
                      className="truncate font-semibold text-foreground underline-offset-4 hover:text-primary hover:underline"
                    >
                      {entry.letter.subject}
                    </button>
                    <UrgencyBadge urgency={entry.letter.urgency} />
                    <ClassificationBadge classification={entry.letter.classification} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 text-[10.5px] text-muted-foreground">
                    <span>فرستنده: {corrUserName(entry.letter.sender)}</span>
                    <span>بایگانی: {formatCorrDate(entry.archivedAt)}</span>
                  </div>
                </div>
                {moveFor === entry.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <select
                      aria-label={`پوشه مقصد برای ${entry.letter.subject}`}
                      value={moveTarget}
                      onChange={(event) => setMoveTarget(event.target.value)}
                      className="h-8 max-w-[140px] rounded-lg border border-border bg-background px-2 text-[10.5px] text-foreground"
                    >
                      <option value="">بدون پوشه</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void doMove(entry)}
                      className="rounded-md bg-primary px-2 py-1 text-[10px] font-bold text-primary-foreground disabled:opacity-60"
                    >
                      انتقال
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoveFor(null);
                        setMoveTarget('');
                      }}
                      className="rounded-md border border-border px-2 py-1 text-[10px]"
                    >
                      لغو
                    </button>
                  </span>
                ) : confirmUnarchive === entry.id ? (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void withBusy(() => unarchiveLetter(entry.letterId))()}
                      className="rounded-md border border-destructive/40 px-2 py-1 text-[10px] font-bold text-destructive disabled:opacity-60"
                    >
                      برداشتن
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmUnarchive(null)}
                      className="rounded-md border border-border px-2 py-1 text-[10px]"
                    >
                      خیر
                    </button>
                  </span>
                ) : (
                  <span className="flex shrink-0 gap-1">
                    {folders.length > 0 && (
                      <button
                        type="button"
                        aria-label={`انتقال ${entry.letter.subject} به پوشه`}
                        disabled={isBusy}
                        onClick={() => {
                          setMoveFor(entry.id);
                          setMoveTarget(entry.folderId ?? '');
                        }}
                        className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-[10.5px] transition hover:bg-secondary disabled:opacity-60"
                      >
                        <FolderInput className="size-3.5" aria-hidden="true" />
                        انتقال به پوشه
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`برداشتن ${entry.letter.subject} از بایگانی`}
                      disabled={isBusy}
                      onClick={() => setConfirmUnarchive(entry.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-[10.5px] transition hover:bg-secondary disabled:opacity-60"
                    >
                      <Undo2 className="size-3.5" aria-hidden="true" />
                      برداشتن از بایگانی
                    </button>
                  </span>
                )}
              </div>
            ))}
        </section>
      </div>
    </div>
  );
}
