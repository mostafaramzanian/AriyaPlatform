// Phase 49L integration E2E over REAL HTTP.
//
// WHAT THIS IS, AND WHAT IT IS NOT
// -------------------------------
// It is NOT a mock. Every request below crosses a real TCP socket: Aria's own Core
// process is running, and the "automation engine" is a real `node:http` server that
// verifies Aria's HMAC signature with the shared secret it was given, then posts a
// real signed callback back to Aria.
//
// It is NOT the n8n E2E gate. n8n is not running on this machine (port 5678 closed),
// and §32 forbids installing it as part of this phase. What this proves is everything
// on ARIA's side of the wire — envelope, signature, timestamp, idempotency key,
// callback verification, replay rejection, availability under an unreachable engine —
// which is exactly the part Aria owns. Binding that webhook to a workflow graph is
// n8n's half and is reported as deferred rather than simulated.
//
// State it touches, and how it is put back:
//   - creates ONE `IntegrationConfig` row, deletes it at the end;
//   - creates `AutomationExecution` rows, deletes them at the end by event id;
//   - binds a listener on 127.0.0.1:4599, closed at the end.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';

const API = process.env.L49L_API ?? 'http://localhost:3011/api/v1';
const ENGINE_PORT = 4599;
const ENGINE_ORIGIN = `http://127.0.0.1:${ENGINE_PORT}`;

const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

/** Event ids this run creates, so cleanup can be exact rather than a table wipe. */
const CREATED_EVENT_IDS = [];

const results = [];
let step = 0;

const check = (name, ok, detail = '') => {
  step += 1;
  results.push({ name: `${step}. ${name}`, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${step}. ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs SQL in the Core database. Used only to observe and to clean up. */
function psql(sql) {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      [
        'exec', '-i', 'aria-erp-postgres',
        'psql', '-U', 'aria_user', '-d', 'core_db',
        '-t', '-A', '-v', 'ON_ERROR_STOP=1',
      ],
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: `${stdout}`.trim(), err: `${stderr}`.trim() });
      },
    );
    child.stdin.end(sql);
  });
}

/** The canonical string, reimplemented here ON PURPOSE. */
function canonical({ method, path, timestamp, eventId, idempotencyKey, body }) {
  const bodyDigest = createHmac('sha256', 'aria-body-digest').update(body, 'utf8').digest('hex');

  return [method.toUpperCase(), path, timestamp, eventId, idempotencyKey, bodyDigest]
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`)
    .join('\n');
}

function sign(secret, material) {
  return createHmac('sha256', secret).update(canonical(material), 'utf8').digest('hex');
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(a ?? '', 'utf8');
  const right = Buffer.from(b ?? '', 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The stand-in automation engine.
 *
 * It behaves like a real webhook consumer: it VERIFIES the signature Aria sent (with the
 * same secret, recomputing the canonical string independently) and records what it saw.
 * A mock that accepted anything would prove nothing about signing.
 *
 * `mode` lets one server cover the outcome matrix: accept, reject, hang.
 */
function startEngine(secret) {
  const received = [];
  let mode = 'accept';
  let closed = false;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));

    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const presented = req.headers['x-aria-signature'];
      const timestamp = req.headers['x-aria-timestamp'];
      const eventId = req.headers['x-aria-event-id'];
      const idempotencyKey = req.headers['x-aria-idempotency-key'];

      const expected = sign(secret, {
        method: req.method,
        path: new URL(req.url, ENGINE_ORIGIN).pathname,
        timestamp: String(timestamp ?? ''),
        eventId: String(eventId ?? ''),
        idempotencyKey: String(idempotencyKey ?? ''),
        body,
      });

      const signatureValid = constantTimeEqual(expected, String(presented ?? ''));

      received.push({
        headers: {
          signature: presented,
          timestamp,
          eventId,
          idempotencyKey,
          integration: req.headers['x-aria-integration'],
          contentType: req.headers['content-type'],
        },
        signatureValid,
        body: (() => {
          try {
            return JSON.parse(body);
          } catch {
            return body;
          }
        })(),
        raw: body,
      });

      if (mode === 'hang') {
        // Never responds, so Aria's AbortSignal.timeout is what ends the attempt.
        return;
      }

      if (mode === 'reject') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflow blew up' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ executionId: `engine-${received.length}` }));
    });
  });

  return new Promise((resolve) => {
    server.listen(ENGINE_PORT, '127.0.0.1', () =>
      resolve({
        received,
        setMode: (next) => {
          mode = next;
        },
        // IDEMPOTENT. The happy path closes the engine mid-run to exercise the
        // unreachable case, and the `finally` block closes it again; calling
        // `server.close()` twice makes libuv abort the process on Windows
        // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), which would
        // destroy the run's own cleanup.
        close: () =>
          closed
            ? Promise.resolve()
            : new Promise((done) => {
                closed = true;
                server.close(() => done());
              }),
      }),
    );
  });
}

/** Authenticated Aria request. Returns status plus parsed body, never throwing on 4xx. */
async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  // The Core response interceptor wraps payloads in `{ data }` for some routes.
  const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  return { status: response.status, body: data, envelope: parsed };
}

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const parsed = await response.json();
  const payload = parsed?.data ?? parsed;
  return payload?.accessToken ?? payload?.access_token ?? null;
}

/** One `AutomationExecution` row as the database holds it. */
async function readExecution(eventId) {
  const { out } = await psql(
    `SELECT status || '|' || "attemptCount" || '|' || coalesce("externalExecutionId",'-') || '|' ||
            coalesce("errorCode",'-') || '|' || coalesce("nextAttemptAt"::text,'-') || '|' ||
            "idempotencyKey" || '|' || coalesce("correlationId",'-')
     FROM "AutomationExecution" WHERE "eventId" = '${eventId}';`,
  );

  if (!out) return null;

  const [status, attemptCount, externalExecutionId, errorCode, nextAttemptAt, idempotencyKey, correlationId] =
    out.split('|');

  return { status, attemptCount, externalExecutionId, errorCode, nextAttemptAt, idempotencyKey, correlationId };
}

async function main() {
  const token = await login();
  check('Signed in against the running Core process', Boolean(token));
  if (!token) return;

  // ── Configure the integration through the REAL admin API ───────────────────
  const created = await api(token, 'POST', '/admin/integrations', {
    integration: 'N8N',
    baseUrl: ENGINE_ORIGIN,
    webhookPath: '/webhook/aria',
    enabled: false,
    timeoutMs: 3000,
    maxAttempts: 2,
  });

  check('Created the integration disabled', created.status === 201, `status=${created.status}`);
  const configId = created.body?.id;
  if (!configId) {
    // A 409 here means a previous interrupted run left its row behind. Say so plainly
    // rather than reporting an opaque failure — the fix is
    // `scripts/integration-e2e-cleanup.sql`.
    console.log(
      created.status === 409
        ? 'A configuration already exists. Run scripts/integration-e2e-cleanup.sql first.'
        : JSON.stringify(created, null, 2),
    );
    return;
  }

  check(
    'The create response carries no secret material',
    !JSON.stringify(created.body).match(/secretCiphertext|secretIv|secretAuthTag/) &&
      created.body.hasSecret === false,
  );

  // Enabling without a secret must be refused: an enabled row with no secret would
  // dispatch unsigned envelopes.
  const prematureEnable = await api(token, 'PATCH', `/admin/integrations/${configId}`, {
    enabled: true,
  });
  check(
    'Refused to enable before a secret exists',
    prematureEnable.status >= 400,
    `status=${prematureEnable.status}`,
  );

  const rotated = await api(token, 'POST', `/admin/integrations/${configId}/secret`);
  const secret = rotated.body?.secret;
  check(
    'Generated a 64-hex shared secret, returned exactly once',
    typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret),
  );
  if (!secret) return;

  const afterRotate = await api(token, 'GET', `/admin/integrations/${configId}`);
  check(
    'A later GET reports the secret as stored but never returns it',
    afterRotate.body?.hasSecret === true && !JSON.stringify(afterRotate.body).includes(secret),
  );

  const engine = await startEngine(secret);

  try {
    const enabled = await api(token, 'PATCH', `/admin/integrations/${configId}`, { enabled: true });
    check('Enabled the integration once a secret existed', enabled.body?.enabled === true);

    // ── Connection test over real HTTP ──────────────────────────────────────
    const test = await api(token, 'POST', `/admin/integrations/${configId}/test`);
    check(
      'Connection test succeeded against the live engine',
      test.status === 200 && test.body?.status === 'SUCCESS',
      test.body?.message ?? '',
    );

    const probe = engine.received.at(-1);
    check('The engine verified Aria\'s signature on the probe', probe?.signatureValid === true);
    check(
      'The probe used the connection-test event type, not a domain event',
      probe?.body?.eventType === 'integration.connection.test',
    );
    check(
      'The probe carried no tenant and no actor',
      probe?.body?.tenant?.id === null && probe?.body?.actor === undefined,
    );
    check(
      'No execution row was written for the connection test',
      (await psql(`SELECT count(*) FROM "AutomationExecution";`)).out === '0',
    );

    // ── Outbound dispatch through the manual trigger ─────────────────────────
    const eventId = `l49l-${Date.now()}`;
    CREATED_EVENT_IDS.push(eventId);

    const triggered = await api(token, 'POST', '/admin/integrations/trigger', {
      eventType: 'ticket.created',
      source: 'support',
      eventId,
      payload: { ticketId: 'e2e-ticket-1', status: 'NEW', priority: 'NORMAL' },
    });

    check(
      'Manual trigger reported ACCEPTED',
      triggered.status === 202 && triggered.body?.status === 'ACCEPTED',
      `status=${triggered.status} body=${JSON.stringify(triggered.body)}`,
    );

    const delivered = engine.received.at(-1);
    check('The engine verified the signature on the domain event', delivered?.signatureValid === true);
    check(
      'The envelope carried every §8 field',
      delivered?.body?.eventId === eventId &&
        delivered?.body?.eventType === 'ticket.created' &&
        delivered?.body?.version === 1 &&
        delivered?.body?.source === 'support' &&
        typeof delivered?.body?.occurredAt === 'string' &&
        'tenant' in (delivered?.body ?? {}),
    );
    check(
      'The idempotency header matched <integration>:<eventId>:v<version>',
      delivered?.headers?.idempotencyKey === `N8N:${eventId}:v1`,
    );
    check(
      'The actor carried ids only — no email, role or session',
      delivered?.body?.actor?.type === 'user' &&
        typeof delivered?.body?.actor?.id === 'string' &&
        Object.keys(delivered?.body?.actor ?? {}).sort().join(',') === 'id,type',
    );
    check(
      'The payload was minimised — no ticket body, subject or requester profile',
      !delivered?.raw?.includes('subject') && !delivered?.raw?.includes('requester'),
    );
    check('The request body never contained the secret', !delivered?.raw?.includes(secret));

    const stored = await readExecution(eventId);
    check(
      'The execution row recorded ACCEPTED with the engine reference and no retry',
      stored?.status === 'ACCEPTED' &&
        stored?.externalExecutionId?.startsWith('engine-') &&
        stored?.nextAttemptAt === '-',
      JSON.stringify(stored),
    );
    check(
      'The correlation id was captured for tracing',
      Boolean(stored?.correlationId) && stored?.correlationId !== '-',
    );

    // ── Idempotency: the same event id twice ────────────────────────────────
    const before = engine.received.length;
    const duplicate = await api(token, 'POST', '/admin/integrations/trigger', {
      eventType: 'ticket.created',
      source: 'support',
      eventId,
      payload: { ticketId: 'e2e-ticket-1', status: 'NEW', priority: 'NORMAL' },
    });

    check(
      'A repeated trigger returned the existing outcome as a duplicate',
      duplicate.body?.duplicate === true && duplicate.body?.dispatched === false,
      JSON.stringify(duplicate.body),
    );
    check(
      'The duplicate produced NO second delivery',
      engine.received.length === before,
      `deliveries before=${before} after=${engine.received.length}`,
    );
    check(
      'Still exactly one execution row for that event',
      (await psql(`SELECT count(*) FROM "AutomationExecution" WHERE "eventId" = '${eventId}';`))
        .out === '1',
    );

    // ── The real callback: engine → Aria, signed ─────────────────────────────
    const callbackBody = {
      eventId,
      integration: 'N8N',
      status: 'COMPLETED',
      externalExecutionId: 'engine-final-1',
    };
    const serialised = JSON.stringify(callbackBody);
    const timestamp = String(Date.now());
    const idempotencyKey = `N8N:${eventId}:v1`;

    const callbackHeaders = (signature, extra = {}) => ({
      'Content-Type': 'application/json',
      'x-aria-signature': signature,
      'x-aria-timestamp': timestamp,
      'x-aria-event-id': eventId,
      'x-aria-integration': 'N8N',
      'x-aria-idempotency-key': idempotencyKey,
      ...extra,
    });

    const signature = sign(secret, {
      method: 'POST',
      path: '/api/v1/integrations/N8N/callback',
      timestamp,
      eventId,
      idempotencyKey,
      body: serialised,
    });

    const callback = await fetch(`${API}/integrations/N8N/callback`, {
      method: 'POST',
      headers: callbackHeaders(signature),
      body: serialised,
    });
    const callbackPayload = await callback.json().catch(() => null);
    const callbackData = callbackPayload?.data ?? callbackPayload;

    check(
      'Aria accepted the signed callback',
      callback.status === 200 && callbackData?.accepted === true,
      `status=${callback.status} body=${JSON.stringify(callbackData)}`,
    );

    const completed = await readExecution(eventId);
    check(
      'The execution became COMPLETED and stopped being retryable',
      completed?.status === 'COMPLETED' && completed?.nextAttemptAt === '-',
      JSON.stringify(completed),
    );
    check(
      'The callback updated the external reference',
      completed?.externalExecutionId === 'engine-final-1',
    );

    // Replay of the SAME signed request, inside the timestamp window.
    const replay = await fetch(`${API}/integrations/N8N/callback`, {
      method: 'POST',
      headers: callbackHeaders(signature),
      body: serialised,
    });
    const replayPayload = await replay.json().catch(() => null);
    const replayData = replayPayload?.data ?? replayPayload;

    check(
      'A replayed callback returned the existing outcome as a duplicate',
      replay.status === 200 && replayData?.duplicate === true,
      `status=${replay.status} body=${JSON.stringify(replayData)}`,
    );

    // ── Callback rejections, over real HTTP ──────────────────────────────────
    const unsigned = await fetch(`${API}/integrations/N8N/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialised,
    });
    check('An UNSIGNED callback was rejected 401', unsigned.status === 401, `status=${unsigned.status}`);

    const forged = await fetch(`${API}/integrations/N8N/callback`, {
      method: 'POST',
      headers: callbackHeaders('f'.repeat(64)),
      body: serialised,
    });
    check('A FORGED signature was rejected 401', forged.status === 401, `status=${forged.status}`);

    const staleTimestamp = String(Date.now() - 10 * 60 * 1000);
    const staleSignature = sign(secret, {
      method: 'POST',
      path: '/api/v1/integrations/N8N/callback',
      timestamp: staleTimestamp,
      eventId,
      idempotencyKey,
      body: serialised,
    });

    const expired = await fetch(`${API}/integrations/N8N/callback`, {
      method: 'POST',
      headers: { ...callbackHeaders(staleSignature), 'x-aria-timestamp': staleTimestamp },
      body: serialised,
    });
    check(
      'A VALIDLY SIGNED but EXPIRED callback was rejected 401',
      expired.status === 401,
      `status=${expired.status}`,
    );

    const unknownEventBody = JSON.stringify({ ...callbackBody, eventId: 'no-such-event' });
    const unknownSignature = sign(secret, {
      method: 'POST',
      path: '/api/v1/integrations/N8N/callback',
      timestamp,
      eventId: 'no-such-event',
      idempotencyKey: 'N8N:no-such-event:v1',
      body: unknownEventBody,
    });

    const unknown = await fetch(`${API}/integrations/N8N/callback`, {
      method: 'POST',
      headers: {
        ...callbackHeaders(unknownSignature),
        'x-aria-event-id': 'no-such-event',
        'x-aria-idempotency-key': 'N8N:no-such-event:v1',
      },
      body: unknownEventBody,
    });
    check(
      'An unknown event was rejected with the SAME 401 as a bad signature',
      unknown.status === 401,
      `status=${unknown.status}`,
    );

    // ── Availability: the engine goes away ───────────────────────────────────
    await engine.close();

    const downEventId = `l49l-down-${Date.now()}`;
    CREATED_EVENT_IDS.push(downEventId);

    const whileDown = await api(token, 'POST', '/admin/integrations/trigger', {
      eventType: 'ticket.created',
      source: 'support',
      eventId: downEventId,
      payload: { ticketId: 'e2e-ticket-2', status: 'NEW' },
    });

    // §22: an unreachable engine is NOT an error for the caller.
    check(
      'A trigger with the engine DOWN still returned 202, not an error',
      whileDown.status === 202,
      `status=${whileDown.status} body=${JSON.stringify(whileDown.body)}`,
    );
    check(
      'The failure was recorded as RETRYING with a bounded next attempt',
      whileDown.body?.status === 'RETRYING' && whileDown.body?.errorCode === 'UNREACHABLE',
      JSON.stringify(whileDown.body),
    );

    const downRow = await readExecution(downEventId);
    check(
      'The row carries attemptCount=1, errorCode=UNREACHABLE and a future nextAttemptAt',
      downRow?.status === 'RETRYING' &&
        downRow?.attemptCount === '1' &&
        downRow?.errorCode === 'UNREACHABLE' &&
        downRow?.nextAttemptAt !== '-',
      JSON.stringify(downRow),
    );

    // ── The bounded retry pass, observed at RUNTIME ──────────────────────────
    //
    // The config was created with maxAttempts=2, so the retry tick has exactly ONE
    // attempt left. The engine is still down, so that attempt must fail and the row
    // must become terminal — FAILED with nextAttemptAt cleared — rather than
    // retrying forever. Polling rather than sleeping a fixed interval, because the
    // tick phase depends on when the process booted.
    //
    // Skippable with L49L_SKIP_RETRY=1 for a fast run; the same transition is
    // asserted deterministically in integration.service.spec.ts.
    if (process.env.L49L_SKIP_RETRY === '1') {
      check('Bounded retry observation SKIPPED by request', true, 'L49L_SKIP_RETRY=1');
    } else {
      const deadline = Date.now() + 95_000;
      let settled = null;

      while (Date.now() < deadline) {
        await sleep(5000);
        settled = await readExecution(downEventId);
        if (settled?.status === 'FAILED') break;
      }

      check(
        'The retry pass exhausted the bounded budget and made the row terminal',
        settled?.status === 'FAILED' &&
          settled?.attemptCount === '2' &&
          settled?.nextAttemptAt === '-',
        JSON.stringify(settled),
      );
      check(
        'It stopped at maxAttempts — no third attempt was made',
        Number(settled?.attemptCount ?? 0) <= 2,
        `attemptCount=${settled?.attemptCount}`,
      );
    }


    // ── SSRF: an internal service cannot be configured as a target ───────────
    for (const [label, baseUrl] of [
      ['redis inside the compose network', 'http://redis:6379'],
      ['the cloud metadata endpoint', 'http://169.254.169.254'],
      ['a file:// URL', 'file:///etc/passwd'],
      ['a URL carrying credentials', 'http://user:pass@example.com'],
    ]) {
      const rejected = await api(token, 'PATCH', `/admin/integrations/${configId}`, { baseUrl });
      check(
        `Refused to point the integration at ${label}`,
        rejected.status >= 400,
        `status=${rejected.status}`,
      );
    }

    // ── Authorization on the admin surface ──────────────────────────────────
    const anonymous = await fetch(`${API}/admin/integrations`);
    check(
      'The admin list requires authentication',
      anonymous.status === 401,
      `status=${anonymous.status}`,
    );
  } finally {
    // `engine.close()` is idempotent enough for a server already closed above.
    await engine.close().catch(() => undefined);

    // Cleanup: the config row and every execution this run created.
    await api(token, 'DELETE', `/admin/integrations/${configId}`);

    for (const id of CREATED_EVENT_IDS) {
      await psql(`DELETE FROM "AutomationExecution" WHERE "eventId" = '${id}';`);
    }

    const leftovers = await psql(
      `SELECT count(*) FROM "IntegrationConfig";
       SELECT count(*) FROM "AutomationExecution";`,
    );
    check('Cleaned up: no integration or execution rows left behind', leftovers.out === '0\n0', leftovers.out);
  }
}




main()
  .then(() => {
    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });


