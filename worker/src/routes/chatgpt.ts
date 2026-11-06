import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, desc, eq, like } from 'drizzle-orm';
import type { Bindings } from '../index';
import * as schema from '../db/schema';
import { sha256hex } from '../lib/crypto';
import { timingSafeEqual } from '../lib/auth';
import { logActivity } from '../lib/activityLog';
import { extendFastPoll } from '../lib/fastPoll';

type ChatgptBindings = Bindings & { CHATGPT_ADAPTER_KEY?: string };

const chatgpt = new Hono<{ Bindings: ChatgptBindings }>();

const CONFIRM_TTL_SECONDS = 10 * 60;
const ADAPTER_VERSION = '0.1';
const SYSTEM_ALLOWLIST = new Set(['reboot', 'run_audit', 'restart_agent', 'force_update']);

function jsonError(c: any, status: number, error: string, message: string, details?: unknown) {
  return c.json({ ok: false, error, message, ...(details !== undefined ? { details } : {}) }, status);
}

function ok<T>(c: any, data: T, extra?: Record<string, unknown>) {
  return c.json({ ok: true, data, ...(extra ?? {}) });
}

async function requireAdapterAuth(c: any): Promise<Response | null> {
  const key = c.env.CHATGPT_ADAPTER_KEY;
  if (!key) {
    return jsonError(c, 503, 'adapter_disabled', 'ChatGPT adapter is not configured');
  }
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return jsonError(c, 401, 'unauthorized', 'Bearer token required');
  }
  const token = auth.slice('Bearer '.length);
  if (!token || !(await timingSafeEqual(token, key))) {
    return jsonError(c, 401, 'unauthorized', 'Invalid adapter key');
  }
  return null;
}

chatgpt.use('*', async (c, next) => {
  const denied = await requireAdapterAuth(c);
  if (denied) return denied;
  await next();
});

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4 || 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function hmacVerify(data: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('HMAC', key, base64UrlToBytes(signature), new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

interface ConfirmPayload {
  v: 1;
  deviceId: string;
  companyId: string;
  kind: 'powershell' | 'system';
  actionHash: string;
  reasonHash: string;
  timeoutSeconds: number;
  expiresAt: number;
  nonce: string;
}

async function issueConfirmId(payload: ConfirmPayload, secret: string): Promise<string> {
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(body, secret);
  return `${body}.${sig}`;
}

async function verifyConfirmId(confirmId: string, secret: string): Promise<ConfirmPayload | null> {
  const parts = confirmId.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!(await hmacVerify(body, sig, secret))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as ConfirmPayload;
    if (payload?.v !== 1) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.expiresAt <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function shapeDeviceForAdapter(row: typeof schema.devices.$inferSelect) {
  const {
    deviceCredentialHash: _dc,
    enrollmentTokenId: _et,
    rustdeskPasswordCiphertext: _rpc,
    rustdeskPasswordNonce: _rpn,
    ...device
  } = row;
  return device;
}

function parseJsonMaybe(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function execRiskDescription(kind: 'powershell' | 'system', action: string): string {
  if (kind === 'powershell') return 'High risk: runs arbitrary PowerShell on the target device via Beacon command queue.';
  if (action === 'reboot') return 'High risk: reboots the target device.';
  return `Operational risk: executes predefined system action "${action}" on the target device.`;
}

chatgpt.get('/status', async (c) => {
  let dbReachable = false;
  let dbError: string | undefined;
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
    dbReachable = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'db query failed';
  }
  return ok(c, {
    adapter: 'beacon-chatgpt-mcp',
    version: ADAPTER_VERSION,
    worker: 'ok',
    beacon_reachable: true,
    d1_reachable: dbReachable,
    ...(dbError ? { d1_error: dbError } : {}),
    durable_object_session_binding: !!c.env.SESSION,
    dangerous_actions_require_confirmation: true,
    confirmations_single_use: true,
    capabilities: ['status', 'devices.read', 'devices.audit.read', 'exec.two_phase', 'jobs.read', 'files.request'],
  });
});

chatgpt.get('/devices', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const devices = await db.select().from(schema.devices).all();
  const companyIds = [...new Set(devices.map(d => d.companyId))];
  const companies = companyIds.length
    ? await db.select({ id: schema.companies.id, name: schema.companies.name }).from(schema.companies).all()
    : [];
  const companyMap = new Map(companies.map(t => [t.id, t.name]));
  return ok(c, devices.map(d => ({
    ...shapeDeviceForAdapter(d),
    companyName: companyMap.get(d.companyId) ?? null,
  })));
});

chatgpt.get('/devices/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const device = await db.select().from(schema.devices).where(eq(schema.devices.id, c.req.param('id'))).get();
  if (!device) return jsonError(c, 404, 'not_found', 'Device not found');
  const company = await db.select({ name: schema.companies.name })
    .from(schema.companies).where(eq(schema.companies.id, device.companyId)).get();
  return ok(c, { ...shapeDeviceForAdapter(device), companyName: company?.name ?? null });
});

chatgpt.get('/devices/:id/audit/latest', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const device = await db.select({ id: schema.devices.id })
    .from(schema.devices).where(eq(schema.devices.id, c.req.param('id'))).get();
  if (!device) return jsonError(c, 404, 'not_found', 'Device not found');
  const audit = await db.select().from(schema.deviceAudits)
    .where(eq(schema.deviceAudits.deviceId, device.id))
    .orderBy(desc(schema.deviceAudits.createdAt))
    .limit(1)
    .get();
  if (!audit) return jsonError(c, 404, 'not_found', 'No audit data for this device yet');
  return ok(c, {
    ...audit,
    hardware: parseJsonMaybe(audit.hardware),
    software: parseJsonMaybe(audit.software),
    services: parseJsonMaybe(audit.services),
    security: parseJsonMaybe(audit.security),
    patches: parseJsonMaybe(audit.patches),
  });
});

chatgpt.get('/jobs', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 200);
  const jobs = await db.select().from(schema.jobs).orderBy(desc(schema.jobs.createdAt)).limit(limit).all();
  return ok(c, jobs.map(j => ({
    ...j,
    componentIds: parseJsonMaybe(j.componentIds),
    targetIds: parseJsonMaybe(j.targetIds),
  })));
});

chatgpt.get('/jobs/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const job = await db.select().from(schema.jobs).where(eq(schema.jobs.id, c.req.param('id'))).get();
  if (!job) return jsonError(c, 404, 'not_found', 'Job not found');
  const cmds = await db.select().from(schema.commands)
    .where(eq(schema.commands.jobId, job.id))
    .orderBy(desc(schema.commands.createdAt))
    .all();
  return ok(c, {
    ...job,
    componentIds: parseJsonMaybe(job.componentIds),
    targetIds: parseJsonMaybe(job.targetIds),
    commands: cmds.map(cmd => ({
      id: cmd.id,
      deviceId: cmd.deviceId,
      companyId: cmd.companyId,
      type: cmd.type,
      status: cmd.status,
      result: parseJsonMaybe(cmd.result),
      warning: cmd.warning,
      createdAt: cmd.createdAt,
      completedAt: cmd.completedAt,
      jobId: cmd.jobId,
      componentId: cmd.componentId,
      componentOrder: cmd.componentOrder,
    })),
  });
});

interface ExecBody {
  device_id?: string;
  kind?: 'powershell' | 'system';
  script?: string;
  action?: string;
  timeout_seconds?: number;
  reason?: string;
  confirm?: boolean;
  confirm_id?: string;
}

chatgpt.post('/exec', async (c) => {
  const body = await c.req.json<ExecBody>().catch(() => null);
  if (!body || typeof body !== 'object') return jsonError(c, 400, 'invalid_body', 'JSON body required');

  const kind = body.kind;
  if (kind !== 'powershell' && kind !== 'system') {
    return jsonError(c, 400, 'invalid_kind', 'kind must be "powershell" or "system"');
  }

  const deviceId = body.device_id?.trim();
  if (!deviceId) return jsonError(c, 400, 'invalid_device', 'device_id is required');

  let action = '';
  let payload: Record<string, unknown> = {};
  let cmdType = 'run_script';

  if (kind === 'powershell') {
    const script = body.script?.trim();
    if (!script) return jsonError(c, 400, 'invalid_script', 'script is required for kind=powershell');
    const timeout = Math.min(Math.max(Number(body.timeout_seconds ?? 300) || 300, 5), 3600);
    action = script;
    payload = { shell: 'powershell', script, timeout_seconds: timeout };
    cmdType = 'run_script';
  } else {
    const systemAction = body.action?.trim() ?? body.script?.trim() ?? '';
    if (!SYSTEM_ALLOWLIST.has(systemAction)) {
      return jsonError(c, 400, 'invalid_system_action', 'system action must be one of the allowlisted predefined actions', {
        allowlist: [...SYSTEM_ALLOWLIST],
      });
    }
    action = systemAction;
    if (systemAction === 'reboot') {
      payload = { shell: 'powershell', script: 'shutdown /r /t 0', timeout_seconds: 30 };
      cmdType = 'run_script';
    } else {
      payload = {};
      cmdType = systemAction;
    }
  }

  const db = drizzle(c.env.DB, { schema });
  const device = await db.select({
    id: schema.devices.id,
    companyId: schema.devices.companyId,
    status: schema.devices.status,
    osType: schema.devices.osType,
  }).from(schema.devices).where(eq(schema.devices.id, deviceId)).get();
  if (!device) return jsonError(c, 404, 'not_found', 'Device not found');
  if (device.status !== 'approved') return jsonError(c, 409, 'device_not_approved', 'Device must be approved to receive commands');

  const reason = body.reason?.trim() || 'Requested via ChatGPT adapter';
  const actionHash = await sha256hex(`${kind}\n${action}`);
  const reasonHash = await sha256hex(reason);
  const timeoutSeconds = Number((payload.timeout_seconds as number | undefined) ?? 0) || 0;
  const now = Math.floor(Date.now() / 1000);

  if (!body.confirm) {
    const confirmPayload: ConfirmPayload = {
      v: 1,
      deviceId: device.id,
      companyId: device.companyId,
      kind,
      actionHash,
      reasonHash,
      timeoutSeconds,
      expiresAt: now + CONFIRM_TTL_SECONDS,
      nonce: crypto.randomUUID(),
    };
    const confirmId = await issueConfirmId(confirmPayload, c.env.CHATGPT_ADAPTER_KEY!);
    await logActivity(db, {
      actorType: 'system',
      actorId: 'chatgpt-adapter',
      actorLabel: 'ChatGPT MCP Adapter',
      category: 'ChatGPT Adapter',
      action: 'Exec confirmation requested',
      entityType: 'device',
      entityId: device.id,
      companyId: device.companyId,
      method: 'POST',
      path: c.req.path,
      details: {
        kind,
        cmdType,
        actionHash,
        reason,
        scriptPreview: kind === 'powershell' ? action.slice(0, 200) : undefined,
        confirmExpiresAt: confirmPayload.expiresAt,
      },
    });
    return ok(c, {
      accepted: false,
      confirmation_required: true,
      confirm_id: confirmId,
      expires_at: confirmPayload.expiresAt,
      device_id: device.id,
      company_id: device.companyId,
      kind,
      risk: execRiskDescription(kind, action),
      description: kind === 'powershell'
        ? 'Confirm to queue PowerShell for execution through Beacon. No execution occurs without confirm:true.'
        : `Confirm to queue predefined system action "${action}" through Beacon.`,
    });
  }

  if (!body.confirm_id) {
    return jsonError(c, 409, 'confirmation_required', 'confirm_id is required when confirm=true');
  }
  const verified = await verifyConfirmId(body.confirm_id, c.env.CHATGPT_ADAPTER_KEY!);
  if (!verified) {
    await logActivity(db, {
      actorType: 'system',
      actorId: 'chatgpt-adapter',
      actorLabel: 'ChatGPT MCP Adapter',
      category: 'ChatGPT Adapter',
      action: 'Exec confirmation rejected',
      entityType: 'device',
      entityId: device.id,
      companyId: device.companyId,
      method: 'POST',
      path: c.req.path,
      details: { kind, reason: 'invalid_or_expired_confirmation' },
    });
    return jsonError(c, 409, 'confirmation_required', 'Confirmation is invalid or expired');
  }
  if (
    verified.deviceId !== device.id ||
    verified.companyId !== device.companyId ||
    verified.kind !== kind ||
    verified.actionHash !== actionHash ||
    verified.reasonHash !== reasonHash ||
    verified.timeoutSeconds !== timeoutSeconds
  ) {
    await logActivity(db, {
      actorType: 'system',
      actorId: 'chatgpt-adapter',
      actorLabel: 'ChatGPT MCP Adapter',
      category: 'ChatGPT Adapter',
      action: 'Exec confirmation mismatch',
      entityType: 'device',
      entityId: device.id,
      companyId: device.companyId,
      method: 'POST',
      path: c.req.path,
      details: { kind },
    });
    return jsonError(c, 409, 'confirmation_mismatch', 'Confirmation does not match the requested action');
  }

  const commandId = crypto.randomUUID();
  const payloadWithNonce = { ...payload, adapter_nonce: verified.nonce };
  const reused = await db.select({ id: schema.commands.id })
    .from(schema.commands)
    .where(like(schema.commands.payload, `%"adapter_nonce":"${verified.nonce}"%`))
    .get();
  if (reused) {
    await logActivity(db, {
      actorType: 'system',
      actorId: 'chatgpt-adapter',
      actorLabel: 'ChatGPT MCP Adapter',
      category: 'ChatGPT Adapter',
      action: 'Exec confirmation reused',
      entityType: 'device',
      entityId: device.id,
      companyId: device.companyId,
      method: 'POST',
      path: c.req.path,
      details: { kind, existingCommandId: reused.id },
    });
    return jsonError(c, 409, 'confirmation_reused', 'This confirmation was already used');
  }
  await db.insert(schema.commands).values({
    id: commandId,
    deviceId: device.id,
    companyId: device.companyId,
    type: cmdType,
    payload: JSON.stringify(payloadWithNonce),
    status: 'queued',
    createdAt: now,
  });
  await extendFastPoll(db, device.id, now);

  const auditId = crypto.randomUUID();
  await logActivity(db, {
    actorType: 'system',
    actorId: 'chatgpt-adapter',
    actorLabel: 'ChatGPT MCP Adapter',
    category: 'ChatGPT Adapter',
    action: 'Exec dispatched',
    entityType: 'device',
    entityId: device.id,
    companyId: device.companyId,
    method: 'POST',
    path: c.req.path,
    details: {
      commandId,
      auditId,
      kind,
      cmdType,
      actionHash,
      reason,
      dispatchedAs: 'technician-equivalent-command-queue',
    },
  });

  return ok(c, {
    accepted: true,
    device_id: device.id,
    company_id: device.companyId,
    command_id: commandId,
    status: 'queued',
    poll_after_seconds: 5,
  }, { audit_id: auditId });
});

interface FileRequestBody {
  session_id?: string;
  type?: 'browse' | 'download' | 'upload';
  request?: unknown;
  path?: string;
}

chatgpt.post('/files/request', async (c) => {
  const body = await c.req.json<FileRequestBody>().catch(() => null);
  if (!body || typeof body !== 'object') return jsonError(c, 400, 'invalid_body', 'JSON body required');

  const sessionId = body.session_id?.trim();
  if (!sessionId) return jsonError(c, 400, 'invalid_session', 'session_id is required');
  if (body.type !== 'browse' && body.type !== 'download' && body.type !== 'upload') {
    return jsonError(c, 400, 'invalid_type', 'type must be "browse", "download", or "upload"');
  }
  if (body.type === 'upload') {
    return jsonError(c, 400, 'unsupported_upload', 'Upload bytes must not pass through the adapter; create/use the existing session upload flow instead');
  }

  const requestPayload = body.request && typeof body.request === 'object'
    ? body.request
    : (body.path ? { path: body.path } : null);
  if (!requestPayload || typeof (requestPayload as { path?: unknown }).path !== 'string' || !(requestPayload as { path: string }).path.trim()) {
    return jsonError(c, 400, 'invalid_request', 'request.path (or path) is required');
  }

  const db = drizzle(c.env.DB, { schema });
  const session = await db.select({ id: schema.sessions.id, deviceId: schema.sessions.deviceId, companyId: schema.sessions.companyId, status: schema.sessions.status })
    .from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) return jsonError(c, 404, 'not_found', 'Session not found');

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(schema.sessionFileRequests).values({
    id,
    sessionId,
    type: body.type,
    status: 'pending',
    request: JSON.stringify(requestPayload),
    createdAt: now,
  });

  await logActivity(db, {
    actorType: 'system',
    actorId: 'chatgpt-adapter',
    actorLabel: 'ChatGPT MCP Adapter',
    category: 'ChatGPT Adapter',
    action: 'File request created',
    entityType: 'device',
    entityId: session.deviceId,
    companyId: session.companyId,
    method: 'POST',
    path: c.req.path,
    details: { requestId: id, sessionId, type: body.type, sessionStatus: session.status },
  });

  return ok(c, {
    accepted: true,
    request_id: id,
    session_id: sessionId,
    type: body.type,
    status: 'pending',
  }, { audit_id: null });
});

export default chatgpt;
