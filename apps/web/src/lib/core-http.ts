import { API_ENDPOINT } from './constants';
import { authenticatedFetch, getAccessToken } from './auth-api';

/**
 * Phase 49B: shared read helper for Core UI calls.
 *
 * Reuses `authenticatedFetch` (the single existing session mechanism) so no
 * second token store or auth flow is introduced. Nothing here logs tokens or
 * response bodies.
 */

export class CoreApiError extends Error {
  readonly status: number;

  /**
   * PHASE UI-4: the response BODY, when one was parseable — additive and OPTIONAL, so
   * every existing `new CoreApiError(message, status)` call site keeps its exact
   * behaviour. It exists because some backends answer a refusal with a STRUCTURED report
   * beside the message (`workflow-configuration.service.ts` returns `{message, level,
   * issues, truncated}` for `validate`/`publish` conflicts) and that report is the only
   * thing an administrator can act on: without it the UI could only say "invalid". The
   * UI-4 error rendering reads `details.issues` through a type guard; nothing else
   * consumes it, and nothing logs it.
   */
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'CoreApiError';
    this.status = status;
    this.details = details;
  }
}

const DEFAULT_MESSAGES: Record<number, string> = {
  401: 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.',
  403: 'شما به این بخش دسترسی ندارید.',
};

function messageFor(status: number, body: unknown): string {
  const fromBody =
    body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : null;

  if (status === 401 || status === 403) {
    return DEFAULT_MESSAGES[status];
  }

  return fromBody ?? 'دریافت اطلاعات با خطا مواجه شد.';
}

/** True when a token exists locally; used to skip pointless requests. */
export function hasLocalSession(): boolean {
  return Boolean(getAccessToken());
}

export async function coreGet<T>(path: string): Promise<T> {
  let response: Response;

  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, { method: 'GET' });
  } catch {
    // authenticatedFetch throws only when no usable token could be obtained.
    throw new CoreApiError(DEFAULT_MESSAGES[401], 401);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new CoreApiError(messageFor(response.status, body), response.status, body);
  }

  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }

  return body as T;
}

/**
 * Phase 49E: write counterpart of `coreGet`, for the idempotent
 * notification mark-read actions.
 *
 * Same session mechanism, same envelope unwrapping and the same error mapping —
 * only the method (and an optional JSON body) differ. Nothing here logs tokens or
 * response bodies.
 */
export async function corePost<T>(path: string, payload?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, {
      method: 'POST',
      ...(payload === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
    });
  } catch {
    throw new CoreApiError(DEFAULT_MESSAGES[401], 401);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new CoreApiError(messageFor(response.status, body), response.status, body);
  }

  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }

  return body as T;
}
/**
 * Phase 49G-2: multipart counterpart of `corePost`, for the single-file upload
 * endpoints (`POST /tickets/:id/attachments`).
 *
 * The `Content-Type` header is deliberately NOT set: the browser must generate the
 * multipart boundary itself. `authenticatedFetch` already skips its JSON default for
 * a `FormData` body, so the same session mechanism, envelope unwrapping and error
 * mapping apply unchanged. Nothing here logs tokens, file contents or response
 * bodies.
 */
export async function corePostForm<T>(path: string, form: FormData): Promise<T> {
  let response: Response;

  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new CoreApiError(DEFAULT_MESSAGES[401], 401);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new CoreApiError(messageFor(response.status, body), response.status, body);
  }

  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }

  return body as T;
}

/**
 * Phase 49G: PATCH counterpart of `corePost`, for the agent-only ticket mutations
 * (assignment/priority/category and the lifecycle transition).
 *
 * Same session mechanism, same envelope unwrapping and the same error mapping —
 * only the method differs. Nothing here logs tokens or response bodies.
 */
export async function corePatch<T>(path: string, payload?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, {
      method: 'PATCH',
      ...(payload === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
    });
  } catch {
    throw new CoreApiError(DEFAULT_MESSAGES[401], 401);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new CoreApiError(messageFor(response.status, body), response.status, body);
  }

  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }

  return body as T;
}
/**
 * Phase 49H: DELETE counterpart of `corePatch`, for the manager-only draft-survey
 * delete (`DELETE /surveys/:id`).
 *
 * Same session mechanism, same envelope unwrapping and the same error mapping — only
 * the method differs. No body is ever sent: a delete identifies its target by path.
 * Nothing here logs tokens or response bodies.
 */
/**
 * PHASE UI-4: PUT counterpart of `corePatch`, for the ONE replace-shaped mutation this
 * surface has — the workflow step reorder (`PUT workflow-versions/:id/steps/order`),
 * whose body states the complete order rather than amending it. Same session mechanism,
 * same envelope unwrapping and the same error mapping (including the structured refusal
 * body the workflow configuration routes answer with); nothing here logs tokens or
 * response bodies.
 */
export async function corePut<T>(path: string, payload?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, {
      method: 'PUT',
      ...(payload === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
    });
  } catch {
    throw new CoreApiError(DEFAULT_MESSAGES[401], 401);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new CoreApiError(messageFor(response.status, body), response.status, body);
  }

  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }

  return body as T;
}


/**
 * Phase 49H: DELETE counterpart of `corePatch`, for the manager-only draft-survey
 * delete (`DELETE /surveys/:id`) and the workflow step delete this phase adds.
 *
 * Same session mechanism, same envelope unwrapping and the same error mapping — only
 * the method differs. No body is ever sent: a delete identifies its target by path.
 * Nothing here logs tokens or response bodies.
 */
export async function coreDelete<T>(path: string): Promise<T> {
  let response: Response;

  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, { method: 'DELETE' });
  } catch {
    throw new CoreApiError(DEFAULT_MESSAGES[401], 401);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new CoreApiError(messageFor(response.status, body), response.status, body);
  }

  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }

  return body as T;
}
