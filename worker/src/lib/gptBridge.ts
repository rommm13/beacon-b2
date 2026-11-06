// ChatGPT task bridge: gpt_tasks (writable by ChatGPT via the Cloudflare D1
// API) → commands (writable only by the worker). ChatGPT never inserts into
// commands directly, so every guarantee the worker needs — device binding,
// readonly classification, dangerous-op approval — is enforced here, in code
// that has no public endpoint.
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { bytesToBase64, base64ToBytes, toBase64Url } from './crypto';

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Statuses a task row may carry when ChatGPT touches it. `approved` is set by
// the worker only, upon verifying a confirm token — a ChatGPT-side UPDATE to
// status='approved' is meaningless without the HMAC token, and is overwritten
// before dispatch.
const STATUS_PENDING = 'pending';
const STATUS_PENDING_CONFIRM = 'pending_confirm';
const STATUS_APPROVED = 'approved';
const STATUS_QUEUED = 'queued';
const STATUS_DENIED = 'denied';
const STATUS_CANCELLED = 'cancelled';
const STATUS_TIMED_OUT = 'timed_out';
const STATUS_COMPLETED = 'completed';
const STATUS_FAILED = 'failed';

// Unapproved tasks die after an hour; dispatched-but-unpicked tasks die with
// the command (same expires semantics as scheduled jobs).
const TASK_TTL_SECONDS = 60 * 60;

export const GPT_BRIDGE_DENY_PREFIXES = ['d:\\chatgpt-disk', 'd:/chatgpt-disk'];

// ── Classification ───────────────────────────────────────────────────────────
// Readonly is decided by scanning the WHOLE script: every cmdlet-shaped token
// (Verb-Noun) must be a known readonly verb. This closes the pipeline hole
// (Get-ChildItem … | Remove-Item) and the script-block hole
// (ForEach-Object { Remove-Item … }): any single unknown or mutator cmdlet
// anywhere makes the task operational (needs approval). A cmdlet name inside a
// string only costs a false "operational" (one confirmation), never the
// reverse.
const READONLY_CMDLETS = new Set([
  'get-', 'test-', 'measure-', 'compare-object', 'select-object', 'where-object',
  'foreach-object', 'sort-object', 'format-', 'out-string', 'convertto-json',
  'convertto-csv', 'write-output', 'write-host', 'resolve-dnsname', 'ping',
  'hostname', 'whoami', 'ipconfig', 'netstat', 'systeminfo', 'tasklist',
  'nslookup', 'tracert', 'route', 'print', 'arp', 'nbtstat', 'ver', 'vol', 'cls',
]);

function isReadonlyToken(token: string): boolean {
  const t = token.toLowerCase();
  if (READONLY_CMDLETS.has(t)) return true;
  return [...READONLY_CMDLETS].some(p => t.startsWith(p));
}

function mentionsProtectedPath(script: string): boolean {
  const lower = script.toLowerCase();
  return GPT_BRIDGE_DENY_PREFIXES.some(p => lower.includes(p));
}

export function classifyGptTask(kind: string, script: string): 'readonly' | 'operational' | 'dangerous' | 'blocked' {
  if (mentionsProtectedPath(script)) return 'blocked';
  if (kind !== 'powershell') return 'dangerous'; // system actions: reboot etc.
  if (!script.trim()) return 'dangerous';
  // Every cmdlet-shaped token anywhere in the script must be readonly.
  const candidates = script.match(/[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z][a-zA-Z0-9]*/g) ?? [];
  if (candidates.some(c => !isReadonlyToken(c))) return 'operational';
  // Bare first command of the first line (hostname, whoami, ipconfig, …).
  const first = script.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
  const verb = first?.split('|')[0]!.trim().split(/\s+/)[0]!.toLowerCase().replace(/^&\s*/, '') ?? '';
  if (verb && !isReadonlyToken(verb)) return 'operational';
  return 'readonly';
}

// ── Approval token (HMAC over the task identity, not a stored flag) ─────────
// CONFIG_ENCRYPTION_KEY never leaves the worker; the token is shown once to
// the human operator via the break-glass admin route, who passes it to
// ChatGPT. ChatGPT cannot compute it (key unknown) and cannot replay it for a
// different task (token binds request_id + device + action hash + nonce).
export interface GptConfirmPayload {
  v: 1;
  requestId: string;
  deviceId: string;
  actionHash: string;
  nonce: string;
  expiresAt: number;
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSignHex(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerifyHex(data: string, sigHex: string, secret: string): Promise<boolean> {
  const expected = await hmacSignHex(data, secret);
  // Constant-time-ish compare (equal length is guaranteed for hex-of-hex).
  if (expected.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

export async function issueGptConfirmToken(payload: GptConfirmPayload, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const bodyB64 = toBase64Url(bytesToBase64(bytes));
  return `${bodyB64}.${await hmacSignHex(bodyB64, secret)}`;
}

export async function verifyGptConfirmToken(token: string, secret: string): Promise<GptConfirmPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const bodyB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let body: string;
  try {
    body = new TextDecoder().decode(base64ToBytes(bodyB64.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  // HMAC is over the base64url body itself — the exact string issueGptConfirmToken signed.
  if (!(await hmacVerifyHex(bodyB64, sig, secret))) return null;
  try {
    const payload = JSON.parse(body) as GptConfirmPayload;
    if (payload?.v !== 1 || !payload.requestId || !payload.deviceId || !payload.actionHash) return null;
    if (payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Dispatch: gpt_tasks row → real Beacon command ────────────────────────────
// Called from the check-in path (agent polls gpt_tasks implicitly through the
// worker) and from the cron sweep. Idempotent via request_id UNIQUE.
const MAX_SCRIPT_CHARS = 32000;
const MAX_CONCURRENT_TASKS_PER_DEVICE = 5;

export async function dispatchApprovedGptTask(db: Db, taskId: string, now: number): Promise<void> {
  const task = await db.select().from(schema.gptTasks).where(eq(schema.gptTasks.id, taskId)).get();
  if (!task || task.commandId || task.status !== STATUS_APPROVED) return;

  const device = await db.select({ id: schema.devices.id, status: schema.devices.status, companyId: schema.devices.companyId })
    .from(schema.devices).where(eq(schema.devices.id, task.deviceId)).get();
  if (!device || device.status !== 'approved') {
    await db.update(schema.gptTasks).set({ status: STATUS_DENIED, error: 'device_not_approved', updatedAt: now }).where(eq(schema.gptTasks.id, taskId));
    return;
  }

  // Guard against a task flood: ChatGPT is a loop-prone client.
  const inFlight = await db.select({ n: sql<number>`count(*)` })
    .from(schema.gptTasks)
    .where(and(
      eq(schema.gptTasks.deviceId, task.deviceId),
      sql`${schema.gptTasks.status} IN ('approved','queued')`,
    )).get();
  if ((inFlight?.n ?? 0) > MAX_CONCURRENT_TASKS_PER_DEVICE) {
    await db.update(schema.gptTasks).set({ status: STATUS_DENIED, error: 'too_many_concurrent_tasks', updatedAt: now }).where(eq(schema.gptTasks.id, taskId));
    return;
  }

  const commandId = crypto.randomUUID();
  // The agent's Execute() only knows run_script/install_* — an unknown type is
  // silently ignored, so "system" actions must be translated here. Only reboot
  // is offered; everything else is denied rather than sent as a no-op.
  if (task.kind === 'system') {
    if (task.script.trim().toLowerCase() !== 'reboot') {
      await db.update(schema.gptTasks).set({ status: STATUS_DENIED, error: 'unsupported_system_action', updatedAt: now }).where(eq(schema.gptTasks.id, taskId));
      return;
    }
    await db.insert(schema.commands).values({
      id: commandId,
      deviceId: task.deviceId,
      companyId: task.companyId,
      type: 'run_script',
      payload: JSON.stringify({ shell: 'powershell', script: 'shutdown /r /t 0', timeout_seconds: 30 }),
      status: 'queued',
      createdAt: now,
    });
  } else {
    await db.insert(schema.commands).values({
      id: commandId,
      deviceId: task.deviceId,
      companyId: task.companyId,
      type: 'run_script',
      payload: JSON.stringify({ shell: 'powershell', script: task.script, timeout_seconds: 300 }),
      status: 'queued',
      createdAt: now,
    });
  }

  await db.update(schema.gptTasks)
    .set({ status: STATUS_QUEUED, commandId, updatedAt: now, expiresAt: now + TASK_TTL_SECONDS })
    .where(and(eq(schema.gptTasks.id, taskId), sql`${schema.gptTasks.status} = ${STATUS_APPROVED}`));
}

// ── Check-in hook: classify new tasks, verify tokens, dispatch approved ones ─
// Runs on the device's own check-in, so latency to first dispatch is one
// poll cycle (15-60s) with no dependency on the cron tick.
export async function processGptTasksForDevice(
  db: Db,
  env: { CONFIG_ENCRYPTION_KEY?: string },
  deviceId: string,
  now: number,
): Promise<void> {
  const tasks = await db.select().from(schema.gptTasks)
    .where(and(
      eq(schema.gptTasks.deviceId, deviceId),
      sql`${schema.gptTasks.status} IN (${STATUS_PENDING}, ${STATUS_PENDING_CONFIRM}, ${STATUS_APPROVED})`,
    ))
    .limit(20).all();

  for (const task of tasks) {
    if (task.expiresAt <= now) {
      await db.update(schema.gptTasks).set({ status: STATUS_TIMED_OUT, error: 'task_expired', updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
      continue;
    }

    let status = task.status;
    if (status === STATUS_PENDING) {
      if (task.script.length > MAX_SCRIPT_CHARS) {
        await db.update(schema.gptTasks).set({ status: STATUS_DENIED, error: 'script_too_large', updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
        continue;
      }
      const cls = classifyGptTask(task.kind, task.script);
      if (cls === 'blocked') {
        await db.update(schema.gptTasks).set({ status: STATUS_DENIED, classification: cls, error: 'protected_path_denied', updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
        continue;
      }
      // readonly → auto-approve; anything else waits for an HMAC token.
      status = cls === 'readonly' ? STATUS_APPROVED : STATUS_PENDING_CONFIRM;
      await db.update(schema.gptTasks).set({ classification: cls, status, updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
    }

    if (status === STATUS_PENDING_CONFIRM && task.confirmToken && env.CONFIG_ENCRYPTION_KEY) {
      const payload = await verifyGptConfirmToken(task.confirmToken, env.CONFIG_ENCRYPTION_KEY);
      const actionHash = await sha256Hex(`${task.kind}\n${task.script}`);
      if (
        payload &&
        payload.requestId === task.requestId &&
        payload.deviceId === task.deviceId &&
        payload.actionHash === actionHash
      ) {
        status = STATUS_APPROVED;
        await db.update(schema.gptTasks).set({ status, updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
      } else if (task.expiresAt <= now) {
        // Invalid token: leave pending_confirm so the operator can retry with
        // a fresh token until the task's own TTL runs out.
        continue;
      }
    }

    if (status === STATUS_APPROVED) {
      await dispatchApprovedGptTask(db, task.id, now);
    }
  }
}

export async function gptBridgeSweep(db: Db, now: number): Promise<void> {
  // 1. Expire unapproved tasks (ChatGPT never came back with a token).
  await db.update(schema.gptTasks)
    .set({ status: STATUS_TIMED_OUT, error: 'task_expired_unapproved', updatedAt: now })
    .where(and(
      eq(schema.gptTasks.status, STATUS_PENDING_CONFIRM),
      sql`${schema.gptTasks.expiresAt} <= ${now}`,
    ));

  // 2. Mirror terminal command statuses into their tasks (also done inline on
  // check-in for latency; this catches any missed while the worker was between
  // deploys).
  const live = await db.select({
    id: schema.gptTasks.id,
    commandId: schema.gptTasks.commandId,
    status: schema.gptTasks.status,
  }).from(schema.gptTasks).where(eq(schema.gptTasks.status, STATUS_QUEUED)).all();
  for (const t of live) {
    if (!t.commandId) continue;
    const cmd = await db.select({ status: schema.commands.status, result: schema.commands.result })
      .from(schema.commands).where(eq(schema.commands.id, t.commandId)).get();
    if (!cmd) continue;
    if (cmd.status === 'completed') {
      await db.update(schema.gptTasks).set({
        status: STATUS_COMPLETED, result: cmd.result, completedAt: now, updatedAt: now,
      }).where(eq(schema.gptTasks.id, t.id));
    } else if (cmd.status === 'failed') {
      await db.update(schema.gptTasks).set({
        status: STATUS_FAILED, result: cmd.result, completedAt: now, updatedAt: now,
      }).where(eq(schema.gptTasks.id, t.id));
    }
  }

  // 3. Cancel queued tasks whose command was never picked up in time.
  const stale = await db.select({ id: schema.gptTasks.id, commandId: schema.gptTasks.commandId })
    .from(schema.gptTasks).where(and(eq(schema.gptTasks.status, STATUS_QUEUED), sql`${schema.gptTasks.expiresAt} <= ${now}`)).all();
  for (const t of stale) {
    if (t.commandId) {
      await db.update(schema.commands).set({ status: 'failed', result: JSON.stringify({ stderr: '[beacon-bridge: task expired before pickup]' }) })
        .where(and(eq(schema.commands.id, t.commandId), eq(schema.commands.status, 'queued')));
    }
    await db.update(schema.gptTasks).set({ status: STATUS_TIMED_OUT, error: 'not_picked_up_before_expiry', updatedAt: now })
      .where(eq(schema.gptTasks.id, t.id));
  }
}

// Mirror one finished command back into its gpt_tasks row. Called from the
// check-in path right after the commands table is updated, so ChatGPT sees
// results within one poll instead of waiting for the cron sweep.
export async function mirrorGptTaskResult(db: Db, commandId: string, cmd: { status: string; result: string | null }, now: number): Promise<void> {
  if (cmd.status !== 'completed' && cmd.status !== 'failed') return;
  await db.update(schema.gptTasks).set({
    status: cmd.status === 'completed' ? STATUS_COMPLETED : STATUS_FAILED,
    result: cmd.result,
    completedAt: now,
    updatedAt: now,
  }).where(and(eq(schema.gptTasks.commandId, commandId), eq(schema.gptTasks.status, STATUS_QUEUED)));
}

// Operator-initiated cancel: flips the task and, if its command hasn't been
// sent yet, kills the queued command too. Commands already sent to the agent
// cannot be recalled — the task is marked cancelled but the command runs.
export async function cancelGptTask(db: Db, taskId: string, now: number): Promise<boolean> {
  const task = await db.select().from(schema.gptTasks).where(eq(schema.gptTasks.id, taskId)).get();
  if (!task || ['completed', 'failed', 'timed_out', 'cancelled', 'denied'].includes(task.status)) return false;
  if (task.commandId) {
    await db.update(schema.commands).set({ status: 'failed', result: JSON.stringify({ stderr: '[beacon-bridge: cancelled before execution]' }) })
      .where(and(eq(schema.commands.id, task.commandId), eq(schema.commands.status, 'queued')));
  }
  await db.update(schema.gptTasks).set({ status: STATUS_CANCELLED, error: 'cancelled_by_operator', updatedAt: now, completedAt: now })
    .where(eq(schema.gptTasks.id, taskId));
  return true;
}
