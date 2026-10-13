/**
 * PHASE UI-2: the shape every detail-section read holds, so ONE failure cannot blank the
 * document. Each section enters the page with its own state, reloads alone and renders its
 * own loading/error/empty branch; the page's primary read (the document) is the only thing
 * whose failure replaces the screen.
 */
export type SectionStatus = 'loading' | 'ready' | 'error';

export interface SectionState<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

export function initialSectionState<T>(): SectionState<T> {
  return { status: 'loading', data: null, error: null };
}
