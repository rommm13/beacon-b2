import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, asc, eq } from 'drizzle-orm';
import type { Bindings } from '../index';
import * as schema from '../db/schema';
import { requireUser } from '../lib/auth';
import { generateToken, sha256hex } from '../lib/crypto';
import { extendFastPoll } from '../lib/fastPoll';
import { logActivity } from '../lib/activityLog';
import { resolveStorage } from '../lib/storage';

const sessions = new Hono<{ Bindings: Bindings }>();

function sessionFilesStorage(env: Bindings) {
  return resolveStorage({
    b2: {
      B2_KEY_ID: env.B2_KEY_ID,
      B2_APPLICATION_KEY: env.B2_APPLICATION_KEY,
      B2_BUCKET: env.B2_BUCKET_SESSION_FILES ?? env.B2_BUCKET,
      B2_ENDPOINT: env.B2_ENDPOINT,
      B2_REGION: env.B2_REGION,
    },
    r2: env.SESSION_FILES,
  });
}

// Matches Application Components' own per-file cap (worker/src/routes/admin/components.ts) --
// same reasoning, no need for a different number for a structurally similar upload.
const MAX_SESSION_FILE_BYTES = 100 * 1024 * 1024;

// verifyReportToken is shared by every agent-facing Web Remote route below
// (file-requests/next, .../result, .../blob, .../upload-result) plus the
// pre-existing GET/POST .../displays and GET .../switch-monitor -- all
// check the same per-session report_token, never requireUser or the
// device's own long-lived credential (see POST / above for why). Kept as
// a small local helper rather than exported/shared more widely: this
// file is the only consumer, and the check is three lines.
async function verifyReportToken(db: ReturnType<typeof drizzle<typeof schema>>, sessionId: string, authHeader: string | undefined): Promise<boolean> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  if (!token) return false;
  const row = await db.select({ hash: schema.sessions.reportTokenHash })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  return !!row?.hash && (await sha256hex(token)) === row.hash;
}

// POST /v1/sessions — create a session and queue open_session for the agent
sessions.post('/', async (c) => {
  const actor = await requireUser(c.req.header('Authorization'), c.env, 'technician');
  if (!actor) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json<{
    device_id: string;
    company_id: string;
    session_type: 'shell' | 'tcp_tunnel' | 'screen_share';
    tcp_port?: number;
    // On-demand elevation for screen_share only (the "Elevate" button) --
    // ignored by the agent for every other session type. Not stored on the
    // sessions row -- a one-shot dispatch-time instruction, not queryable
    // session state, same as install_patches' own auto_reboot payload flag.
    // Needs no accompanying credentials: the agent relaunches the helper
    // with the agent service's own SYSTEM token, not an Administrator
    // token obtained from the logged-in user, so there's nothing here to
    // resolve server-side beyond the boolean itself.
    elevated?: boolean;
    // Which Windows Terminal Services session a screen_share helper
    // launches into -- omitted (the default) means the active console
    // session, exactly today's only behavior; a technician on a
    // Server-class device can instead pick a specific RDS/AVD session from
    // the list_remote_sessions picker (see DeviceDetailPage.vue) and pass
    // its session_id here. Ignored by every other session_type. Not
    // validated against a live session list server-side -- the agent's own
    // RunAsSession/RunAsSessionAsSystem already fails cleanly
    // (ErrNoActiveSession) if the session isn't actually active by the
    // time the command is picked up, same "the browser's own connect
    // timeout surfaces this" reasoning elevated already relies on.
    target_session_id?: number;
    // Which display beacon-screenshare.exe captures -- screen_share only,
    // omitted (the default) means the primary monitor, exactly today's
    // only behavior. A specific monitor's real GDI device name (e.g.
    // `\\.\DISPLAY2`, as reported via POST .../displays), chosen from
    // WebRemotePage.vue's Displays switcher.
    monitor?: string;
  }>();

  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  const device = await db.select({
      id: schema.devices.id,
      inventory: schema.devices.inventory,
      remoteAccessConsentOverride: schema.devices.remoteAccessConsentOverride,
    })
    .from(schema.devices)
    .where(and(
      eq(schema.devices.id, body.device_id),
      eq(schema.devices.companyId, body.company_id),
      eq(schema.devices.status, 'approved'),
    ))
    .get();

  if (!device) return c.json({ error: 'device not found or not approved' }, 404);
  try {
    if (JSON.parse(device.inventory ?? '{}').demo_seed === true) {
      return c.json({ error: 'remote sessions are unavailable for seeded demo devices' }, 409);
    }
  } catch { /* a malformed inventory blob is not a reason to block a real device */ }

  // Issue #86: whether this screen_share session requires the end user to
  // Accept/Decline before beacon-screenshare.exe ever dials the relay.
  // device.remoteAccessConsentOverride (null = inherit) wins over the
  // company default, same override-over-default shape as effective device
  // class elsewhere in this codebase. Irrelevant for shell/tcp_tunnel, so
  // only resolved when it'll actually be used.
  let requireConsent = false;
  if (body.session_type === 'screen_share') {
    const company = await db.select({ remoteAccessConsentRequired: schema.companies.remoteAccessConsentRequired })
      .from(schema.companies)
      .where(eq(schema.companies.id, body.company_id))
      .get();
    requireConsent = device.remoteAccessConsentOverride ?? company?.remoteAccessConsentRequired ?? false;
  }

  const sessionId = crypto.randomUUID();
  // WORKER_URL is a configured value, not derived from c.req.url — a
  // [[routes]] custom-domain block in wrangler.toml can make the request's
  // own URL reflect the production route even under `wrangler dev`, which
  // would otherwise send local-dev sessions to the real production worker.
  const origin = new URL(c.env.WORKER_URL).origin.replace(/^http/, 'ws');
  const agentWsUrl  = `${origin}/v1/sessions/${sessionId}/ws?role=agent`;

  // Per-session random client auth token — not the shared ADMIN_SECRET, since
  // technicians who open sessions never hold it.
  const clientAuthToken = generateToken();
  const clientWsUrl = `${origin}/v1/sessions/${sessionId}/ws?role=client&auth=${clientAuthToken}`;

  // A second, separate per-session random token -- screen_share only,
  // used by the per-session beacon-screenshare.exe helper (running inside
  // the less-trusted interactive user's own session) to report its
  // enumerated monitors back via POST .../displays. Deliberately not
  // clientAuthToken/ADMIN_SECRET/the device's own long-lived credential --
  // none of those should ever reach that helper process, so this is
  // scoped narrowly to just "report this one session's display list."
  const reportToken = body.session_type === 'screen_share' ? generateToken() : undefined;

  await db.insert(schema.sessions).values({
    id: sessionId,
    deviceId: body.device_id,
    companyId: body.company_id,
    sessionType: body.session_type,
    tcpPort: body.tcp_port ?? null,
    createdAt: now,
    clientAuthHash: await sha256hex(clientAuthToken),
    reportTokenHash: reportToken ? await sha256hex(reportToken) : null,
  });

  // Signal the agent via the existing command channel — agent picks it up on next check-in
  await db.insert(schema.commands).values({
    id: crypto.randomUUID(),
    deviceId: body.device_id,
    companyId: body.company_id,
    type: 'open_session',
    payload: JSON.stringify({
      session_id: sessionId,
      session_type: body.session_type,
      ws_url: agentWsUrl,
      tcp_port: body.tcp_port ?? 0,
      elevated: body.elevated ?? false,
      ...(body.target_session_id !== undefined ? { target_session_id: body.target_session_id } : {}),
      ...(reportToken ? { report_token: reportToken } : {}),
      ...(body.monitor ? { monitor: body.monitor } : {}),
      ...(requireConsent ? { require_consent: true } : {}),
    }),
    createdAt: now,
  });

  // Opening a session is exactly the kind of "about to do work on this
  // specific machine" signal fast-poll exists for -- see
  // worker/src/lib/fastPoll.ts's own doc comment for why this is safe here
  // (single-device, technician-initiated) but deliberately never wired
  // into Job dispatch (many-device, scheduled/bulk).
  await extendFastPoll(db, body.device_id, now);

  // Explicit Layer-2 activity-log call, not left to the generic Layer-1
  // middleware (see lib/activityLog.ts) -- Layer 1 never parses the
  // request body, so it can't distinguish an ordinary screen-share/shell
  // session from an elevated one. That distinction matters more once
  // "elevated" means the agent relaunches the helper with literal SYSTEM
  // privilege (the maximum level Windows has, exceeding the old
  // Administrator-token ceiling): "technician X elevated to SYSTEM on
  // device Y at time Z" should be a first-class, searchable audit event,
  // not indistinguishable from a routine remote-support session. This
  // route is added to activityLog.ts's SKIP_ROUTES so Layer 1 doesn't
  // also log a duplicate, detail-less row for it.
  await logActivity(db, {
    actorType: actor.source === 'break-glass' ? 'break-glass' : 'user',
    actorId: actor.id,
    actorLabel: actor.email,
    category: 'Remote Session',
    action: body.elevated ? 'Opened remote session (elevated to SYSTEM)' : 'Opened remote session',
    entityType: 'device',
    entityId: body.device_id,
    companyId: body.company_id,
    method: 'POST',
    path: c.req.path,
    details: { session_type: body.session_type, elevated: body.elevated ?? false, target_session_id: body.target_session_id ?? null, consent_required: requireConsent },
  });

  return c.json({ session_id: sessionId, client_ws_url: clientWsUrl });
});

// POST /v1/sessions/:id/consent — agent-facing: beacon-screenshare.exe
// reports the end user's Accept/Decline/no-response decision here, before
// it ever dials the relay (see runScreenShare's own doc comment for why
// that ordering is safe). Same report-token auth as .../displays, not
// requireUser or the device's own credential, for the same reason. Only
// ever called when the dispatched open_session command carried
// require_consent -- an ordinary session's helper never calls this at all,
// so sessions.consentStatus stays NULL for it, which GET .../consent below
// (and the dashboard's own polling) already treats as "nothing to report."
sessions.post('/:id/consent', async (c) => {
  if (!(await verifyReportToken(drizzle(c.env.DB, { schema }), c.req.param('id'), c.req.header('Authorization')))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json<{ status: string }>();
  if (!['accepted', 'declined', 'timed_out'].includes(body.status)) {
    return c.json({ error: 'status must be accepted, declined, or timed_out' }, 400);
  }

  const db = drizzle(c.env.DB, { schema });
  await db.update(schema.sessions)
    .set({ consentStatus: body.status })
    .where(eq(schema.sessions.id, c.req.param('id')));

  return c.json({ ok: true });
});

// GET /v1/sessions/:id/consent — technician-facing: WebRemotePage.vue polls
// this while status is still "connecting" for a screen_share session, so a
// decline/timeout surfaces immediately instead of waiting out the generic
// ~70s connect timeout. Always safe to poll regardless of whether consent
// was actually required for this dispatch -- status is just NULL ("nothing
// to report") in that case, same as before the helper has answered yet.
sessions.get('/:id/consent', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const db = drizzle(c.env.DB, { schema });
  const row = await db.select({ status: schema.sessions.consentStatus })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, c.req.param('id')))
    .get();
  if (!row) return c.json({ error: 'session not found' }, 404);
  return c.json({ status: row.status });
});

// POST /v1/sessions/:id/displays — agent-facing: the per-session
// screen_share helper (beacon-screenshare.exe, running inside the target
// user's own desktop session) reports its enumerated monitors here right
// after startup. Authenticated by the per-session report_token (see
// POST / above), not requireUser -- there's no user session token
// available inside a helper process running on the target machine, and
// this must never accept the device's own long-lived credential either
// (that would leak it into a less-trusted interactive-session process).
sessions.post('/:id/displays', async (c) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const row = await db.select({ hash: schema.sessions.reportTokenHash })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, c.req.param('id')))
    .get();
  if (!row?.hash || (await sha256hex(token)) !== row.hash) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json<{ displays: unknown }>();
  if (!Array.isArray(body.displays)) return c.json({ error: 'displays must be an array' }, 400);

  await db.update(schema.sessions)
    .set({ displays: JSON.stringify(body.displays) })
    .where(eq(schema.sessions.id, c.req.param('id')));

  return c.json({ ok: true });
});

// GET /v1/sessions/:id/displays — technician-facing: the dashboard polls
// this a handful of times shortly after connecting to populate the
// monitor switcher, once the screen_share helper above has reported in
// (typically within a second or two of the session actually being open --
// GDI monitor enumeration is near-instant, unlike waiting on a check-in
// cycle). Returns an empty array, not an error, until the helper has
// reported (or if it never does, e.g. a non-Windows target).
sessions.get('/:id/displays', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const db = drizzle(c.env.DB, { schema });
  const row = await db.select({ displays: schema.sessions.displays })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, c.req.param('id')))
    .get();
  if (!row) return c.json({ error: 'session not found' }, 404);
  let displays: unknown[] = [];
  try { displays = row.displays ? JSON.parse(row.displays) : []; } catch { /* malformed -- treat as not yet reported */ }
  return c.json({ displays });
});

// POST /v1/sessions/:id/switch-monitor — technician-facing: requests an
// in-place monitor switch on an already-open screen_share session, without
// tearing it down. Replaces this feature's original design (opening a
// brand-new session per switch, via the report_token/displays machinery
// above), which real-hardware testing found took 10+ seconds per switch --
// an inherent floor from a fresh relay Durable Object plus the
// check-in-cycle-bound open_session dispatch. This route is just a cheap
// pointer write; the actual switch happens when the already-running
// beacon-screenshare.exe helper (see GET below) notices the change on its
// own short poll interval and swaps its live Capturer/Injector in place
// (agent/internal/rfbserver's SwitchRequest), pushing an RFB DesktopSize
// pseudo-encoding update so the already-connected noVNC client resizes
// without reconnecting.
sessions.post('/:id/switch-monitor', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ monitor: string }>();
  if (!body.monitor) return c.json({ error: 'monitor is required' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const row = await db.select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, c.req.param('id')))
    .get();
  if (!row) return c.json({ error: 'session not found' }, 404);

  await db.update(schema.sessions)
    .set({ pendingMonitor: body.monitor })
    .where(eq(schema.sessions.id, c.req.param('id')));

  return c.json({ ok: true });
});

// GET /v1/sessions/:id/switch-monitor — agent-facing: the already-running
// screen_share helper polls this at a short interval (much faster than a
// check-in cycle -- see the route above) to notice a requested switch.
// Authenticated the same way as GET/POST .../displays -- the per-session
// report_token, not requireUser or the device's own long-lived credential.
// Always returns the current pointer verbatim, even if the helper already
// applied it -- the helper, not this route, tracks "did I already apply
// this," so there's nothing here to consume/clear.
sessions.get('/:id/switch-monitor', async (c) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const row = await db.select({ hash: schema.sessions.reportTokenHash, monitor: schema.sessions.pendingMonitor })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, c.req.param('id')))
    .get();
  if (!row?.hash || (await sha256hex(token)) !== row.hash) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  return c.json({ monitor: row.monitor ?? '' });
});

// ── Web Remote file transfer ────────────────────────────────────────────
// Toolbar icon -> Upload/Download -> a file picker, same shape described
// directly from real Datto RMM usage. Upload always lands on the
// logged-on target user's Desktop (see beacon-screenshare.exe's own
// resolution of that path); Download needs a remote directory browser,
// since there's no other way for a technician to know what files exist
// on a machine they aren't physically at. All three request types
// (browse/download/upload) share one small table and the same
// assign-then-poll-then-report shape this file's switch-monitor routes
// above (and the Two-Tier Policy System's file_size/ping/process/service
// checks, further afield) already established -- see migration 0080's
// own comment for the exact request/result JSON shapes.

// POST /v1/sessions/:id/file-requests — technician-facing: request a
// remote directory listing (type: 'browse') or a specific file's contents
// (type: 'download'). Returns immediately with the new request's id; the
// technician-facing GET below is polled for the result.
sessions.post('/:id/file-requests', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ type: string; path: string }>();
  if (body.type !== 'browse' && body.type !== 'download') {
    return c.json({ error: "type must be 'browse' or 'download'" }, 400);
  }
  if (!body.path) return c.json({ error: 'path is required' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const session = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.id, c.req.param('id'))).get();
  if (!session) return c.json({ error: 'session not found' }, 404);

  const id = crypto.randomUUID();
  await db.insert(schema.sessionFileRequests).values({
    id,
    sessionId: c.req.param('id'),
    type: body.type as 'browse' | 'download',
    status: 'pending',
    request: JSON.stringify({ path: body.path }),
    createdAt: Math.floor(Date.now() / 1000),
  });
  return c.json({ id }, 201);
});

// GET /v1/sessions/:id/file-requests/:reqId — technician-facing: poll for
// a browse/download/upload request's result. Registered ahead of the
// agent-facing GET .../file-requests/next below is unnecessary here (the
// literal segments "next" vs. a real UUID never collide in Hono's
// routing), unlike the ComStore-before-:id ordering rule documented
// elsewhere in this codebase.
sessions.get('/:id/file-requests/:reqId', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const db = drizzle(c.env.DB, { schema });
  const row = await db.select().from(schema.sessionFileRequests)
    .where(and(eq(schema.sessionFileRequests.id, c.req.param('reqId')), eq(schema.sessionFileRequests.sessionId, c.req.param('id'))))
    .get();
  if (!row) return c.json({ error: 'request not found' }, 404);

  let result: unknown = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { /* malformed -- treat as not yet available */ }
  return c.json({ status: row.status, result, error: row.error ?? null });
});

// POST /v1/sessions/:id/files/upload — technician-facing: upload a local
// file (raw binary body, same X-File-Name/X-File-Size convention as
// Application Components' own upload route) bound for the target
// session's logged-on user's Desktop. Creates the R2 object immediately
// (so the agent-facing poll below has something concrete to fetch) and a
// 'upload'-type file-request row for the already-running
// beacon-screenshare.exe helper to pick up.
sessions.post('/:id/files/upload', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const db = drizzle(c.env.DB, { schema });
  const session = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.id, c.req.param('id'))).get();
  if (!session) return c.json({ error: 'session not found' }, 404);

  let filename: string;
  try {
    filename = decodeURIComponent(c.req.header('X-File-Name') ?? '').trim();
  } catch {
    return c.json({ error: 'X-File-Name is invalid' }, 400);
  }
  const declaredSize = Number(c.req.header('X-File-Size') ?? '');
  const contentLength = Number(c.req.header('Content-Length') ?? '');
  if (!filename || filename.length > 255) return c.json({ error: 'X-File-Name is required and must be at most 255 characters' }, 400);
  if (!Number.isInteger(declaredSize) || declaredSize < 1) return c.json({ error: 'X-File-Size is required' }, 400);
  if (!Number.isInteger(contentLength) || contentLength !== declaredSize) {
    return c.json({ error: 'Content-Length must match X-File-Size' }, 400);
  }
  if (declaredSize > MAX_SESSION_FILE_BYTES) return c.json({ error: 'file exceeds the 100 MiB limit' }, 413);
  if (!c.req.raw.body) return c.json({ error: 'file body required' }, 400);

  const reqId = crypto.randomUUID();
  const objectKey = `session-files/${c.req.param('id')}/${reqId}`;
  const storage = sessionFilesStorage(c.env);
  try {
    await storage.put(objectKey, c.req.raw.body, {
      httpMetadata: { contentType: c.req.header('Content-Type') ?? 'application/octet-stream' },
      contentLength: declaredSize,
    });
    await db.insert(schema.sessionFileRequests).values({
      id: reqId,
      sessionId: c.req.param('id'),
      type: 'upload',
      status: 'pending',
      request: JSON.stringify({ object_key: objectKey, filename, size_bytes: declaredSize }),
      createdAt: Math.floor(Date.now() / 1000),
    });
    return c.json({ id: reqId }, 201);
  } catch (err) {
    // Best-effort cleanup -- deliberately its own try/catch, not left to
    // propagate. Found live: when the real failure is SESSION_FILES itself
    // being unavailable (e.g. the binding missing from this environment's
    // wrangler.toml), this same delete call fails too, and an unhandled
    // exception inside a catch block escapes uncaught -- Hono's own
    // generic 500 fires instead of this route's actual JSON error
    // response, hiding the real cause behind a useless "Internal Server
    // Error" with zero diagnostic detail.
    try { await storage.delete(objectKey); } catch { /* already handling a real error below; don't let cleanup mask it */ }
    return c.json({ error: err instanceof Error ? err.message : 'upload failed' }, 400);
  }
});

// GET /v1/sessions/:id/files/:reqId/download — technician-facing: stream
// a completed 'download'-type request's bytes back to the browser.
// Content-Disposition is what makes WebRemotePage.vue's downloadFile()
// helper (dashboard/src/api.ts) trigger a real browser download rather
// than rendering inline. R2 object cleanup is a known, accepted gap here
// (not solved this pass) -- self-hosted scale, transient objects, same
// "fine at this scale" reasoning this codebase already applies elsewhere
// (e.g. Custom Fields' rename-guard full-table scan) rather than risking
// deleting an object out from under an in-flight stream.
sessions.get('/:id/files/:reqId/download', async (c) => {
  if (!(await requireUser(c.req.header('Authorization'), c.env, 'technician'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const db = drizzle(c.env.DB, { schema });
  const row = await db.select().from(schema.sessionFileRequests)
    .where(and(eq(schema.sessionFileRequests.id, c.req.param('reqId')), eq(schema.sessionFileRequests.sessionId, c.req.param('id'))))
    .get();
  if (!row || row.type !== 'download' || row.status !== 'completed') {
    return c.json({ error: 'download not ready' }, 404);
  }
  let result: { object_key?: string; filename?: string } = {};
  try { result = row.result ? JSON.parse(row.result) : {}; } catch { /* fall through to the 404 below */ }
  if (!result.object_key) return c.json({ error: 'download not ready' }, 404);

  const storage = sessionFilesStorage(c.env);
  const obj = await storage.get(result.object_key);
  if (!obj) return c.json({ error: 'file no longer available' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${(result.filename ?? 'download').replace(/"/g, '')}"`);
  headers.set('Cache-Control', 'no-store');
  return c.body(obj.body, 200, Object.fromEntries(headers));
});

// GET /v1/sessions/:id/file-requests/next — agent-facing: the
// already-running beacon-screenshare.exe helper polls this at a short
// interval (same ~1s cadence as GET .../switch-monitor) to pick up the
// oldest still-pending browse/download/upload request. Returns {} when
// there's nothing to do, never an error, so the poll loop's steady state
// is silent.
sessions.get('/:id/file-requests/next', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  if (!(await verifyReportToken(db, c.req.param('id'), c.req.header('Authorization')))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const row = await db.select().from(schema.sessionFileRequests)
    .where(and(eq(schema.sessionFileRequests.sessionId, c.req.param('id')), eq(schema.sessionFileRequests.status, 'pending')))
    .orderBy(asc(schema.sessionFileRequests.createdAt))
    .limit(1)
    .get();
  if (!row) return c.json({});

  // Atomically claim it before handing it out. Without this, a request the
  // helper never finishes (a hung directory scan, a crashed goroutine mid-
  // download) stays 'pending' forever, and since this always returns the
  // *oldest* pending row, that permanently blocks every later, unrelated
  // file request in the same session -- found live: a brand-new upload
  // never got serviced at all because it could never become "the oldest
  // pending row." A plain conditional UPDATE (not .returning(), unused
  // elsewhere in this codebase), checked via D1's affected-row count same
  // as dashboards.ts's widget-delete route -- a lost race against a second
  // poller (e.g. a leftover pre-Elevate helper) just no-ops this tick
  // rather than double-claiming.
  const claim = await c.env.DB.prepare(
    "UPDATE session_file_requests SET status = 'claimed' WHERE id = ? AND status = 'pending'",
  ).bind(row.id).run();
  if (!claim.meta.changes) return c.json({});

  let request: unknown = {};
  try { request = JSON.parse(row.request); } catch { /* malformed row -- surface as an empty request, agent will fail it cleanly */ }
  return c.json({ id: row.id, type: row.type, request });
});

// POST /v1/sessions/:id/file-requests/:reqId/result — agent-facing:
// reports a 'browse' listing or an 'upload' outcome. ('download' outcomes
// go through .../upload-result below instead, since those carry the
// actual file bytes, not just a JSON result.)
sessions.post('/:id/file-requests/:reqId/result', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  if (!(await verifyReportToken(db, c.req.param('id'), c.req.header('Authorization')))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ result?: unknown; error?: string }>();
  await db.update(schema.sessionFileRequests)
    .set({
      status: body.error ? 'failed' : 'completed',
      result: body.error ? null : JSON.stringify(body.result ?? {}),
      error: body.error ?? null,
      completedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(schema.sessionFileRequests.id, c.req.param('reqId')), eq(schema.sessionFileRequests.sessionId, c.req.param('id'))));
  return c.json({ ok: true });
});

// GET /v1/sessions/:id/files/:reqId/blob — agent-facing: for an
// 'upload'-type request, fetches the R2 bytes the technician already
// uploaded (see POST .../files/upload above) so the helper can write them
// to disk.
sessions.get('/:id/files/:reqId/blob', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  if (!(await verifyReportToken(db, c.req.param('id'), c.req.header('Authorization')))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const row = await db.select().from(schema.sessionFileRequests)
    .where(and(eq(schema.sessionFileRequests.id, c.req.param('reqId')), eq(schema.sessionFileRequests.sessionId, c.req.param('id'))))
    .get();
  if (!row || row.type !== 'upload') return c.json({ error: 'not found' }, 404);
  let request: { object_key?: string } = {};
  try { request = JSON.parse(row.request); } catch { /* fall through to the 404 below */ }
  if (!request.object_key) return c.json({ error: 'not found' }, 404);

  const storage = sessionFilesStorage(c.env);
  const obj = await storage.get(request.object_key);
  if (!obj) return c.json({ error: 'file no longer available' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'no-store');
  return c.body(obj.body, 200, Object.fromEntries(headers));
});

// POST /v1/sessions/:id/file-requests/:reqId/upload-result — agent-facing:
// for a 'download'-type request, the helper streams the requested file's
// real bytes here (raw binary body, same X-File-Name/X-File-Size
// convention as every other upload route in this file) instead of a JSON
// result -- this is the one place actual remote file content flows
// through the worker. Stores to R2 and marks the request completed with
// a pointer the technician-facing GET .../download route above can serve.
sessions.post('/:id/file-requests/:reqId/upload-result', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  if (!(await verifyReportToken(db, c.req.param('id'), c.req.header('Authorization')))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const row = await db.select().from(schema.sessionFileRequests)
    .where(and(eq(schema.sessionFileRequests.id, c.req.param('reqId')), eq(schema.sessionFileRequests.sessionId, c.req.param('id'))))
    .get();
  if (!row || row.type !== 'download') return c.json({ error: 'not found' }, 404);

  let filename: string;
  try {
    filename = decodeURIComponent(c.req.header('X-File-Name') ?? '').trim();
  } catch {
    return c.json({ error: 'X-File-Name is invalid' }, 400);
  }
  const declaredSize = Number(c.req.header('X-File-Size') ?? '');
  if (!filename) filename = 'download';
  if (!Number.isInteger(declaredSize) || declaredSize < 0) return c.json({ error: 'X-File-Size is required' }, 400);
  if (declaredSize > MAX_SESSION_FILE_BYTES) return c.json({ error: 'file exceeds the 100 MiB limit' }, 413);
  if (!c.req.raw.body) return c.json({ error: 'file body required' }, 400);

  const objectKey = `session-files/${c.req.param('id')}/${c.req.param('reqId')}`;
  const storage = sessionFilesStorage(c.env);
  try {
    await storage.put(objectKey, c.req.raw.body, {
      httpMetadata: { contentType: c.req.header('Content-Type') ?? 'application/octet-stream' },
      contentLength: declaredSize,
    });
    await db.update(schema.sessionFileRequests)
      .set({
        status: 'completed',
        result: JSON.stringify({ object_key: objectKey, filename, size_bytes: declaredSize }),
        completedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(schema.sessionFileRequests.id, c.req.param('reqId')));
    return c.json({ ok: true });
  } catch (err) {
    // Same defensive cleanup-can't-mask-the-real-error fix as the
    // technician-facing upload route above -- see its own comment.
    try { await storage.delete(objectKey); } catch { /* already handling a real error below; don't let cleanup mask it */ }
    return c.json({ error: err instanceof Error ? err.message : 'upload failed' }, 400);
  }
});

// GET /v1/sessions/:id/ws — WebSocket upgrade, proxied to the SessionRelay DO
sessions.get('/:id/ws', async (c) => {
  const role = c.req.query('role');
  if (role !== 'agent' && role !== 'client') {
    return c.json({ error: 'role must be agent or client' }, 400);
  }

  if (role === 'client') {
    const auth = c.req.query('auth');
    const db = drizzle(c.env.DB, { schema });
    const row = await db.select({ hash: schema.sessions.clientAuthHash })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, c.req.param('id')))
      .get();
    if (!auth || !row?.hash || (await sha256hex(auth)) !== row.hash) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  const doId = c.env.SESSION.idFromName(c.req.param('id'));
  return c.env.SESSION.get(doId).fetch(c.req.raw);
});

export default sessions;
