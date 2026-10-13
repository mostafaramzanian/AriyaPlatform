// Phase 49M module-platform E2E over REAL HTTP.
//
// WHAT THIS IS, AND WHAT IT IS NOT
// -------------------------------
// It is NOT a mock. Every request below crosses a real TCP socket: Aria's own Core process is
// running against the real core_db, and the "module" is a real `node:http` server that verifies
// Aria's HMAC signature with the credential Core issued it, then answers a versioned contract call.
//
// It is NOT an HR or a Finance module (§43). The fixture's logical id is `module-under-test`, its
// capability is `probe.echo`, and it holds no business data. Nothing here implies a business module
// exists.
//
// WHAT IT PROVES, and each of these is Aria's own half of the wire:
//   * an unadmitted module cannot register itself (§7);
//   * registration is HMAC-authenticated, and every rejection is an identical 401 (§19);
//   * a module cannot enable itself — a disabled registration yields a DISABLED instance (§8);
//   * an incompatible protocol is RECORDED as INCOMPATIBLE, never partially activated (§18);
//   * a heartbeat refreshes liveness and cannot promote a pinned instance (§14);
//   * discovery resolves by LOGICAL id and the admin invoke reaches the real module (§11/§24);
//   * the module verifies the signature Core sent, including the tenant slot (§21);
//   * a REMOTE registration over plain HTTP is refused before a socket opens (§26/§40);
//   * an unavailable module produces a controlled MODULE_UNAVAILABLE rather than a 500 (§27/§39);
//   * no credential is ever returned by a read (§20).
//
// State it touches, and how it is put back:
//   - creates ONE `ModuleRegistration` and its instances, deletes them at the end;
//   - binds a listener on 127.0.0.1:4699, closed at the end.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';

const API = process.env.M49M_API ?? 'http://localhost:3011/api/v1';
const MODULE_PORT = 4699;
const MODULE_ORIGIN = `http://127.0.0.1:${MODULE_PORT}`;

const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const MODULE_ID = 'module-under-test';
const INSTANCE_ID = 'module-under-test-01';
const CONTRACT = 'module.invoke@v1';
const PROTOCOL = 1;

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

/**
 * The canonical string, REIMPLEMENTED HERE ON PURPOSE.
 *
 * Importing Core's helper would make this test agree with itself by construction. Rebuilding the
 * length-prefixed form independently is what makes a signature match meaningful.
 */
function canonical({ method, path, timestamp, eventId, idempotencyKey, body }) {
  const bodyDigest = createHmac('sha256', 'aria-body-digest').update(body, 'utf8').digest('hex');

  return [method.toUpperCase(), path, timestamp, eventId, idempotencyKey, bodyDigest]
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`)
    .join('\n');
}

/** The 49M mapping: eventId <- `<moduleId>:<requestId>`, idempotencyKey <- tenant slot. */
function moduleMaterial({ method, path, timestamp, moduleId, requestId, tenantId, body }) {
  return {
    method,
    path,
    timestamp,
    eventId: `${moduleId}:${requestId}`,
    idempotencyKey: tenantId === null || tenantId === undefined ? '-' : `t:${tenantId}`,
    body,
  };
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
 * The stand-in module.
 *
 * It behaves like a real participant: it VERIFIES the signature Core sent (recomputing the canonical
 * string independently, with the tenant taken from the SIGNED body rather than the header) and it
 * declares a health state rather than relying on its 200. A fixture that accepted anything would
 * prove nothing about signing, and one that answered a bare 200 would not exercise §13.
 */
const moduleState = {
  /** The credential Core issued, set once the admin API returns it. */
  secret: null,
  /** What the module received, for assertions. */
  invocations: [],
  healthChecks: 0,
  /** Flipped to make the module stop answering, for the §27 leg. */
  down: false,
};

function startModule() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (moduleState.down) {
        req.resume();
        res.destroy();
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        moduleState.healthChecks += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // A DECLARED state and a version, which is what §13 requires for HEALTHY.
        res.end(JSON.stringify({ state: 'HEALTHY', version: '1.0.0', checks: { self: true } }));
        return;
      }

      if (req.url === '/module/v1/invoke' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const parsed = body ? JSON.parse(body) : {};

          const expected = sign(
            moduleState.secret ?? '',
            moduleMaterial({
              method: 'POST',
              path: '/module/v1/invoke',
              timestamp: String(req.headers['x-aria-module-timestamp'] ?? ''),
              moduleId: String(req.headers['x-aria-module-id'] ?? ''),
              requestId: String(req.headers['x-aria-module-request'] ?? ''),
              tenantId: parsed.tenantId ?? null,
              body,
            }),
          );

          const valid = constantTimeEqual(expected, req.headers['x-aria-module-signature']);

          moduleState.invocations.push({
            valid,
            moduleId: req.headers['x-aria-module-id'],
            tenantId: parsed.tenantId,
            operation: parsed.operation,
            contract: parsed.contract,
            protocolVersion: parsed.protocolVersion,
            hasActor: Boolean(parsed.actor),
            actorKeys: parsed.actor ? Object.keys(parsed.actor).sort() : [],
            correlationId: parsed.correlationId,
          });

          if (!valid) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthenticated' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { echoed: parsed.payload, seenBy: INSTANCE_ID } }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(MODULE_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** Signs and sends one module-facing request exactly as a real module would. */
async function moduleRequest(path, body, overrides = {}) {
  const timestamp = overrides.timestamp ?? String(Date.now());
  const requestId = overrides.requestId ?? `req-${Date.now()}`;
  const moduleId = overrides.moduleId ?? MODULE_ID;
  const secret = overrides.secret ?? moduleState.secret ?? '';
  const serialised = JSON.stringify(body);

  const signature = sign(
    secret,
    moduleMaterial({
      method: 'POST',
      path: `/api/v1${path}`,
      timestamp,
      moduleId,
      requestId,
      tenantId: null,
      body: serialised,
    }),
  );

  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-aria-module-id': moduleId,
      'x-aria-module-signature': overrides.signature ?? signature,
      'x-aria-module-timestamp': timestamp,
      'x-aria-module-request': requestId,
    },
    body: serialised,
  });

  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

/** Admin session, used for every /admin/modules call. */
let token = null;

/**
 * One admin request.
 *
 * THE RESPONSE IS RETURNED AS-IS, and that is deliberate: this Core process does not wrap responses
 * in a `{ data }` envelope, and a helper that "unwrapped" one would corrupt exactly the response that
 * matters — `ModuleCallResult` has its OWN `data` field, so an envelope heuristic would silently
 * return the module's payload where the call outcome was expected.
 */
async function admin(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await response.json().catch(() => null);

  return { status: response.status, payload };
}

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const envelope = await response.json();
  const data = envelope?.data ?? envelope;
  token = data?.accessToken ?? data?.access_token ?? null;

  return Boolean(token);
}

/** Removes everything this run created. Exact, never a table wipe. */
async function cleanup() {
  await psql(`DELETE FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`);
}

async function main() {
  const server = await startModule();

  try {
    check('admin session established', await login());
    if (!token) return;

    // Start from a clean slate in case an earlier interrupted run left a row.
    await cleanup();

    // ── §7: an unadmitted module cannot register itself ──────────────────────────
    // Signed with a credential Core has never issued, for a module Core has never heard of.
    moduleState.secret = 'x'.repeat(64);
    const unadmitted = await moduleRequest('/modules/register', {
      moduleId: MODULE_ID,
      instanceId: INSTANCE_ID,
      version: '1.0.0',
      deploymentMode: 'LOCAL',
      baseUrl: MODULE_ORIGIN,
      healthPath: '/health',
      capabilities: ['probe.echo'],
      apiContracts: [CONTRACT],
      eventContracts: [],
      protocolVersion: PROTOCOL,
    });

    check(
      'unadmitted module cannot register itself (§7)',
      unadmitted.status === 401,
      `status ${unadmitted.status}`,
    );

    const noRows = await psql(
      `SELECT count(*) FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`,
    );
    check('nothing was written for the unadmitted attempt', noRows.out === '0', `rows ${noRows.out}`);

    // ── Admin admits the module, DISABLED, with no endpoint typed anywhere ───────
    const created = await admin('POST', '/admin/modules', {
      moduleId: MODULE_ID,
      displayName: 'Module Under Test',
      moduleType: 'INTEGRATION',
    });

    check('admin can register a logical module', created.status === 201, `status ${created.status}`);
    check(
      'a new registration is DISABLED and has no credential',
      created.payload?.enabled === false && created.payload?.hasCredential === false,
      `enabled=${created.payload?.enabled} hasCredential=${created.payload?.hasCredential}`,
    );
    check(
      'the projection carries no endpoint and no credential material',
      !('baseUrl' in (created.payload ?? {})) &&
        !JSON.stringify(created.payload ?? {}).includes('secretCiphertext'),
    );

    const rowId = created.payload?.id;

    // ── §20: the credential is issued once ──────────────────────────────────────
    const rotated = await admin('POST', `/admin/modules/${rowId}/credential`);
    check(
      'credential is issued once and looks like 32 bytes of hex',
      /^[0-9a-f]{64}$/.test(rotated.payload?.secret ?? ''),
    );

    moduleState.secret = rotated.payload.secret;

    const afterRotate = await admin('GET', `/admin/modules/${rowId}`);
    check(
      'no read returns the credential (§20)',
      afterRotate.payload?.hasCredential === true &&
        !JSON.stringify(afterRotate.payload ?? {}).includes(moduleState.secret),
    );

    const registerBody = {
      moduleId: MODULE_ID,
      instanceId: INSTANCE_ID,
      version: '1.0.0',
      deploymentMode: 'LOCAL',
      baseUrl: MODULE_ORIGIN,
      healthPath: '/health',
      capabilities: ['probe.echo'],
      apiContracts: [CONTRACT],
      eventContracts: [],
      protocolVersion: PROTOCOL,
    };

    // ── §19: a wrong credential is refused, and nothing is written ───────────────
    const badSignature = await moduleRequest('/modules/register', registerBody, {
      secret: 'y'.repeat(64),
    });
    check(
      'a wrong credential is refused with 401 (§19)',
      badSignature.status === 401,
      `status ${badSignature.status}`,
    );

    const staleTimestamp = await moduleRequest('/modules/register', registerBody, {
      timestamp: String(Date.now() - 10 * 60 * 1000),
    });
    check(
      'a stale timestamp is refused with the SAME 401',
      staleTimestamp.status === 401 &&
        staleTimestamp.payload?.message === badSignature.payload?.message,
      `status ${staleTimestamp.status}`,
    );

    // ── §8: registration while DISABLED yields a DISABLED instance ───────────────
    const whileDisabled = await moduleRequest('/modules/register', registerBody);
    check(
      'registration succeeds but the instance is DISABLED while the module is (§8)',
      whileDisabled.status === 200 &&
        whileDisabled.payload?.lifecycle === 'DISABLED' &&
        whileDisabled.payload?.reason === 'MODULE_DISABLED',
      JSON.stringify(whileDisabled.payload ?? whileDisabled.payload),
    );

    // ── §18: an incompatible protocol is RECORDED, not activated ─────────────────
    await admin('PATCH', `/admin/modules/${rowId}`, { enabled: true });

    const incompatible = await moduleRequest('/modules/register', {
      ...registerBody,
      instanceId: 'module-under-test-bad',
      protocolVersion: PROTOCOL + 1,
    });

    check(
      'an incompatible protocol is refused and recorded as INCOMPATIBLE (§18)',
      incompatible.payload?.accepted === false &&
        incompatible.payload?.lifecycle === 'INCOMPATIBLE' &&
        incompatible.payload?.reason === 'PROTOCOL_MISMATCH',
      JSON.stringify(incompatible.payload ?? incompatible.payload),
    );

    const incompatibleRow = await psql(
      `SELECT lifecycle FROM "ModuleInstance" WHERE "instanceId" = 'module-under-test-bad';`,
    );
    check(
      'the incompatible instance EXISTS so an operator can see why',
      incompatibleRow.out === 'INCOMPATIBLE',
      `lifecycle ${incompatibleRow.out}`,
    );

    // ── §26/§40: a REMOTE registration over plain HTTP is refused ────────────────
    const insecureRemote = await moduleRequest('/modules/register', {
      ...registerBody,
      instanceId: 'module-under-test-remote',
      deploymentMode: 'REMOTE',
    });

    check(
      'a REMOTE instance on plain http is refused (§26/§40)',
      insecureRemote.payload?.accepted === false &&
        insecureRemote.payload?.reason === 'ENDPOINT_REJECTED',
      JSON.stringify(insecureRemote.payload ?? insecureRemote.payload),
    );

    const remoteRow = await psql(
      `SELECT count(*) FROM "ModuleInstance" WHERE "instanceId" = 'module-under-test-remote';`,
    );
    check('nothing was stored for the rejected endpoint', remoteRow.out === '0', `rows ${remoteRow.out}`);

    // ── The real registration, now that the module is admitted ───────────────────
    const registered = await moduleRequest('/modules/register', registerBody);
    check(
      'the admitted module registers and becomes ACTIVE',
      registered.payload?.accepted === true &&
        registered.payload?.lifecycle === 'ACTIVE',
      JSON.stringify(registered.payload ?? registered.payload),
    );
    check(
      'Core tells the module its heartbeat cadence (§14)',
      typeof registered.payload?.heartbeatIntervalMs === 'number' &&
        registered.payload.heartbeatIntervalMs > 0,
    );

    // ── §14: the heartbeat, and what it cannot do ───────────────────────────────
    const beat = await moduleRequest('/modules/heartbeat', {
      instanceId: INSTANCE_ID,
      state: 'HEALTHY',
    });
    check(
      'a signed heartbeat is acknowledged (§14)',
      beat.payload?.acknowledged === true && beat.payload?.lifecycle === 'ACTIVE',
      JSON.stringify(beat.payload ?? beat.payload),
    );

    const pinnedBeat = await moduleRequest('/modules/heartbeat', {
      instanceId: 'module-under-test-bad',
      state: 'HEALTHY',
    });
    check(
      'a heartbeat cannot promote an INCOMPATIBLE instance (§18)',
      pinnedBeat.payload?.lifecycle === 'INCOMPATIBLE',
      JSON.stringify(pinnedBeat.payload ?? pinnedBeat.payload),
    );

    // ── §29: the connection test probes the real module and reads its DECLARED state ─
    const probe = await admin('POST', `/admin/modules/${rowId}/instances/${INSTANCE_ID}/test`);
    check(
      'the connection test reaches the real module and reports HEALTHY (§13/§29)',
      probe.payload?.registryKnown === true &&
        probe.payload?.endpointReachable === true &&
        probe.payload?.applicationHealthy === true &&
        probe.payload?.state === 'HEALTHY',
      JSON.stringify(probe.payload),
    );
    check('the module actually served the health request', moduleState.healthChecks > 0);

    // ── §10: capability discovery ───────────────────────────────────────────────
    const capabilities = await admin(
      'GET',
      `/admin/modules/by-module/${MODULE_ID}/capabilities`,
    );
    check(
      'capability discovery reports what the module declared (§10)',
      capabilities.payload?.instances?.[0]?.capabilities?.includes('probe.echo') === true,
      JSON.stringify(capabilities.payload?.instances?.[0]?.capabilities),
    );
    check(
      'capability discovery exposes no endpoint and no credential (§10)',
      !JSON.stringify(capabilities.payload ?? {}).includes(MODULE_ORIGIN) &&
        !JSON.stringify(capabilities.payload ?? {}).includes(moduleState.secret),
    );

    // ── §11/§24: resolution by LOGICAL id, and a real signed cross-module call ───
    const invoked = await admin('POST', '/admin/modules/invoke', {
      moduleId: MODULE_ID,
      contract: CONTRACT,
      operation: 'probe.echo',
      payload: { ping: 'pong' },
    });

    check(
      'Core resolves by logical id and the module answers (§11/§24)',
      invoked.payload?.ok === true &&
        // `data` here is `ModuleCallResult.data` — the module's own payload, not a response envelope.
        invoked.payload?.data?.echoed?.ping === 'pong' &&
        invoked.payload?.instanceId === INSTANCE_ID,
      JSON.stringify(invoked.payload),
    );

    const lastCall = moduleState.invocations[moduleState.invocations.length - 1];
    check(
      'the MODULE verified Core’s signature independently (§19)',
      lastCall?.valid === true,
      JSON.stringify({ valid: lastCall?.valid }),
    );
    check(
      'the call carried the contract, the protocol and a correlation id (§16/§23)',
      lastCall?.contract === CONTRACT &&
        lastCall?.protocolVersion === PROTOCOL &&
        typeof lastCall?.correlationId === 'string' &&
        lastCall.correlationId.length > 0,
      JSON.stringify({ contract: lastCall?.contract, protocol: lastCall?.protocolVersion }),
    );
    check(
      'the actor was minimal: actorId + actorType and nothing else (§22)',
      lastCall?.hasActor === true &&
        JSON.stringify(lastCall?.actorKeys) === JSON.stringify(['actorId', 'actorType']),
      JSON.stringify(lastCall?.actorKeys),
    );

    // ── §39: an unresolvable module is a controlled error, not a 500 ─────────────
    const unknown = await admin('POST', '/admin/modules/invoke', {
      moduleId: 'never-registered',
      contract: CONTRACT,
      operation: 'probe.echo',
      payload: {},
    });

    check(
      'an unknown module returns a controlled MODULE_NOT_FOUND (§39)',
      unknown.status === 200 && unknown.payload?.ok === false &&
        unknown.payload?.errorCode === 'MODULE_NOT_FOUND',
      JSON.stringify(unknown.payload),
    );
    check(
      'the failure leaks no network information (§39)',
      !JSON.stringify(unknown.payload ?? {}).includes('127.0.0.1'),
    );

    // ── §40: the invoke route is not an HTTP proxy ───────────────────────────────
    const proxyAttempt = await fetch(`${API}/admin/modules/invoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleId: MODULE_ID,
        contract: CONTRACT,
        operation: 'probe.echo',
        payload: {},
        // `forbidNonWhitelisted` must refuse this outright rather than ignoring it.
        url: 'http://169.254.169.254/latest/meta-data',
      }),
    });

    check(
      'a url in the invoke body is REJECTED, not ignored (§40)',
      proxyAttempt.status === 422 || proxyAttempt.status === 400,
      `status ${proxyAttempt.status}`,
    );

    // ── §27: Core stays functional when the module stops answering ───────────────
    moduleState.down = true;

    const whileDown = await admin('POST', '/admin/modules/invoke', {
      moduleId: MODULE_ID,
      contract: CONTRACT,
      operation: 'probe.echo',
      payload: {},
    });

    check(
      'an unreachable module produces a controlled failure, not a 500 (§27)',
      whileDown.status === 200 && whileDown.payload?.ok === false,
      `status ${whileDown.status} code ${whileDown.payload?.errorCode}`,
    );

    const coreStillUp = await fetch(`${API}/health`);
    check('Core itself remains healthy while the module is down (§27)', coreStillUp.status === 200);

    const listWhileDown = await admin('GET', '/admin/modules');
    check(
      'the registry still lists the module while it is unreachable',
      Array.isArray(listWhileDown.payload) &&
        listWhileDown.payload.some((row) => row.moduleId === MODULE_ID),
    );

    moduleState.down = false;

    // ── §15: deregistration keeps the row, so a clean shutdown is distinguishable ─
    const deregistered = await moduleRequest('/modules/deregister', { instanceId: INSTANCE_ID });
    check(
      'the module can announce its own shutdown (§15)',
      deregistered.payload?.deregistered === true,
      JSON.stringify(deregistered.payload ?? deregistered.payload),
    );

    const afterDeregister = await psql(
      `SELECT lifecycle FROM "ModuleInstance" WHERE "instanceId" = '${INSTANCE_ID}';`,
    );
    check(
      'the row survives as DEREGISTERED rather than vanishing (§15)',
      afterDeregister.out === 'DEREGISTERED',
      `lifecycle ${afterDeregister.out}`,
    );

    const afterDeregisterCall = await admin('POST', '/admin/modules/invoke', {
      moduleId: MODULE_ID,
      contract: CONTRACT,
      operation: 'probe.echo',
      payload: {},
    });

    check(
      'a deregistered instance is no longer resolvable',
      afterDeregisterCall.payload?.ok === false &&
        afterDeregisterCall.payload?.errorCode === 'MODULE_UNAVAILABLE',
      JSON.stringify(afterDeregisterCall.payload),
    );

    // ── No business table, no HR, no Finance ─────────────────────────────────────
    const businessTables = await psql(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
         AND (table_name ILIKE '%hr%' OR table_name ILIKE '%finance%'
              OR table_name ILIKE '%employee%' OR table_name ILIKE '%invoice%');`,
    );
    check(
      'no business table was created by this phase',
      businessTables.out === '0',
      `tables ${businessTables.out}`,
    );
  } finally {
    // Always clean up, even on an assertion failure: the fixture must not outlive the run.
    await cleanup();
    await new Promise((resolve) => server.close(resolve));

    const leftovers = await psql(
      `SELECT count(*) FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`,
    );
    check('fixture removed — registry is back to its prior state', leftovers.out === '0');
  }

  const failed = results.filter((r) => !r.ok);

  console.log('');
  console.log(`TOTAL ${results.length} :: PASS ${results.length - failed.length} :: FAIL ${failed.length}`);

  if (failed.length > 0) {
    console.log('');
    for (const failure of failed) console.log(`FAILED :: ${failure.name} :: ${failure.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('E2E harness crashed:', err);
  process.exitCode = 1;
});





