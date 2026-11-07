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

// ── Classification ───────────────────────────────────────────────────────────
// Re-exported from gptDiagOps.ts — security model lives there: kind='diag'
// auto-executes ONLY worker-owned catalog scripts; kind='powershell' (arbitrary
// script text) ALWAYS requires human confirmation; D:\ChatGPT-Disk mention is
// a fast-fail block (not the real boundary for arbitrary scripts — the human
// is).
import { classifyGptTask, DIAG_OPS } from './gptDiagOps';

export { GPT_BRIDGE_DENY_PREFIXES } from './gptDiagOps';
export type { GptClassification } from './gptDiagOps';

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

// ── Command origin signatures ────────────────────────────────────────────────
// The check-in path refuses to hand any CODE-EXECUTING command to an agent
// unless its payload carries a valid HMAC (CONFIG_ENCRYPTION_KEY) over
// command_id + device_id + payload. This is the trust boundary for direct D1
// writers: a row INSERTed straight into commands (no worker code path) has no
// signature and is failed on the next check-in instead of executing on the
// device. The signature lives INSIDE the payload it signs (added just before
// signing), so modifying any field — including the signature itself — breaks
// verification.
// Command types whose payload leads to process/script execution on the device.
// Only these require the origin signature; the rest (session open, restart,
// measurements, agent lifecycle) keep working unsigned for compatibility.
export const SIGNED_COMMAND_TYPES = new Set([
  'run_script', 'install_msi', 'install_rustdesk', 'install_patches',
  'manage_windows_update', 'manage_microsoft_update', 'network_scan',
]);

export async function signCommandOrigin(commandId: string, deviceId: string, payload: Record<string, unknown>, secret: string): Promise<string> {
  const material = JSON.stringify({ commandId, deviceId, payload });
  return hmacSignHex(material, secret);
}

export async function verifyCommandOrigin(commandId: string, deviceId: string, type: string, payloadJson: string, secret?: string): Promise<boolean> {
  if (!SIGNED_COMMAND_TYPES.has(type)) return true; // not code-executing: no signature required
  if (!secret) return false; // signed type but no key configured: fail closed
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return false;
  }
  const { origin_sig: originSig, ...rest } = parsed as { origin_sig?: string };
  if (!originSig) return false;
  const material = JSON.stringify({ commandId, deviceId, payload: rest });
  return hmacVerifyHex(material, originSig, secret);
}

// Adds the origin signature to a code-executing command's payload object
// before it is stored. Every dispatch site that creates SIGNED_COMMAND_TYPES
// rows must route its payload through this.
export async function signCommandPayload(commandId: string, deviceId: string, payloadObj: Record<string, unknown>, secret: string): Promise<string> {
  payloadObj.origin_sig = await signCommandOrigin(commandId, deviceId, payloadObj, secret);
  return JSON.stringify(payloadObj);
}

// ── Dispatch: gpt_tasks row → real Beacon command ────────────────────────────
// Called from the check-in path (agent polls gpt_tasks implicitly through the
// worker) and from the cron sweep. Idempotent via request_id UNIQUE.
const MAX_SCRIPT_CHARS = 32000;
const MAX_CONCURRENT_TASKS_PER_DEVICE = 5;

export async function dispatchApprovedGptTask(db: Db, env: { CONFIG_ENCRYPTION_KEY?: string }, taskId: string, now: number, scriptOverride?: string): Promise<void> {
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
  const secret = env.CONFIG_ENCRYPTION_KEY;
  if (!secret) {
    // No signing key configured: fail closed rather than dispatch unsigned.
    await db.update(schema.gptTasks).set({ status: STATUS_DENIED, error: 'signing_key_unavailable', updatedAt: now }).where(eq(schema.gptTasks.id, taskId));
    return;
  }
  let payloadObj: Record<string, unknown>;
  if (task.kind === 'system') {
    if (task.script.trim().toLowerCase() !== 'reboot') {
      await db.update(schema.gptTasks).set({ status: STATUS_DENIED, error: 'unsupported_system_action', updatedAt: now }).where(eq(schema.gptTasks.id, taskId));
      return;
    }
    payloadObj = { shell: 'powershell', script: 'shutdown /r /t 0', timeout_seconds: 30 };
  } else {
    payloadObj = { shell: 'powershell', script: withUtf8Console(scriptOverride ?? task.script), timeout_seconds: 300 };
  }
  payloadObj.origin_sig = await signCommandOrigin(commandId, task.deviceId, payloadObj, secret);
  await db.insert(schema.commands).values({
    id: commandId,
    deviceId: task.deviceId,
    companyId: task.companyId,
    type: 'run_script',
    payload: JSON.stringify(payloadObj),
    status: 'queued',
    createdAt: now,
  });

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
    let scriptToRun = task.script;
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
      if (cls === 'dangerous') {
        await db.update(schema.gptTasks).set({ status: STATUS_DENIED, classification: cls, error: 'unknown_kind_or_diag_op', updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
        continue;
      }
      // diag → swap in the worker-owned catalog script; arbitrary powershell →
      // keeps its own text and ALWAYS waits for a human confirm token.
      if (task.kind === 'diag') {
        scriptToRun = DIAG_OPS[task.script.trim().toLowerCase()]!.script;
      }
      status = cls === 'readonly' ? STATUS_APPROVED : STATUS_PENDING_CONFIRM;
      await db.update(schema.gptTasks).set({ classification: cls, status, updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
    } else if (status === STATUS_APPROVED && !task.classification) {
      // STATUS FORGERY GUARD: 'approved' is a plain column a direct D1 writer
      // can set on INSERT (proven live by the neg8 test). Approval that the
      // worker itself granted always carries a classification — it is stamped
      // in the same UPDATE that transitions pending → approved. An approved
      // row without one was never classified, so classify it now: diag ops
      // get dispatched with the catalog script, anything else drops to
      // pending_confirm and still requires a real human token.
      const cls = classifyGptTask(task.kind, task.script);
      if (cls === 'blocked' || cls === 'dangerous') {
        await db.update(schema.gptTasks).set({ status: STATUS_DENIED, classification: cls, error: 'forged_status_blocked', updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
        continue;
      }
      if (task.kind === 'diag' && cls === 'readonly') {
        scriptToRun = DIAG_OPS[task.script.trim().toLowerCase()]!.script;
        await db.update(schema.gptTasks).set({ classification: cls, updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
      } else {
        // Arbitrary script with forged approval: strip the forged status,
        // demand the real token.
        status = STATUS_PENDING_CONFIRM;
        await db.update(schema.gptTasks).set({ classification: cls, status, updatedAt: now }).where(eq(schema.gptTasks.id, task.id));
      }
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
      await dispatchApprovedGptTask(db, env, task.id, now, scriptToRun);
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
    if (cmd.status === 'completed' || cmd.status === 'failed') {
      let resultJson = cmd.result;
      if (resultJson) {
        try {
          const parsed = JSON.parse(resultJson) as { stdout?: string; stderr?: string };
          if (parsed.stdout) parsed.stdout = decodeBeacon64Stdout(parsed.stdout);
          if (parsed.stderr) parsed.stderr = decodeBeacon64Stdout(parsed.stderr);
          resultJson = JSON.stringify(parsed);
        } catch {
          // keep raw result on any decode problem
        }
      }
      await db.update(schema.gptTasks).set({
        status: cmd.status === 'completed' ? STATUS_COMPLETED : STATUS_FAILED,
        result: resultJson, completedAt: now, updatedAt: now,
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
// PowerShell 5.1 + redirected stdout mangles non-ASCII deterministically but
// unreliably to repair (CP866/CP1251 double-encode chains verified live:
// plain → '?' destroyed, prologue/chcp → reversible-but-ugly double-encode).
// The robust fix is to never let non-ASCII travel the pipe: wrap the script
// so its output is emitted as base64 of UTF-8 bytes (ASCII-only, survives
// every encoding chain), and decode it back in the check-in result mirror.
export function withUtf8Console(script: string): string {
  const prologue = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}';
  const payload = `${prologue}\n${script}`;
  return [
    '$__beaconLines = New-Object System.Collections.Generic.List[string]',
    'try {',
    '  $__out = & {', // script runs in a child scope
    payload.split('\n').map(l => `    ${l}`).join('\n'),
    '  } 2>&1 | Out-String',
    '  $__beaconLines.Add([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__out)))',
    '} catch {',
    '  $__beaconLines.Add([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("BRIDGE_ERROR: " + $_.Exception.Message)))',
    '}',
    '$__beaconLines | ForEach-Object { Write-Output "BEACON64:$($_)" }',
  ].join('\n');
}

// Inverse of withUtf8Console: rebuild clean UTF-8 stdout from the BEACON64
// lines the wrapped script emitted. Non-matching lines (prologue noise,
// native output outside the wrapper) are passed through as-is.
export function decodeBeacon64Stdout(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const b64 = lines.filter(l => l.startsWith('BEACON64:')).map(l => l.slice('BEACON64:'.length));
  if (b64.length === 0) return stdout; // not a wrapped script (e.g. diag dispatched before this fix)
  try {
    const joined = b64.map(b => {
      const norm = b.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(norm + '='.repeat((4 - (norm.length % 4 || 4)) % 4));
      return [...new Uint8Array([...bin].map(c => c.charCodeAt(0)))];
    }).flat();
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(new Uint8Array(joined)).trimEnd();
  } catch {
    return stdout;
  }
}

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
