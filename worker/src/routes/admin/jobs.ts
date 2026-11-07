import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Bindings } from '../../index';
import * as schema from '../../db/schema';
import { requireUser, roleAtLeast, type Role } from '../../lib/auth';
import { logActivity } from '../../lib/activityLog';
import { sha256hex } from '../../lib/crypto';
import { fetchCompanyVariables } from '../../lib/companyVariables';
import { signCommandPayload } from '../../lib/gptBridge';

const adminJobs = new Hono<{ Bindings: Bindings }>();

function auth(c: any, minRole: Role = 'readonly') {
  return requireUser(c.req.header('Authorization'), c.env, minRole);
}
function uid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

// ── Types ──────────────────────────────────────────────────────

type ComponentRef =
  | { type: 'library'; component_id: string; order: number; variable_values?: Record<string, string> }
  | { type: 'inline'; shell: string; script: string; timeout_seconds?: number; order: number };

type ScriptPayload = {
  kind: 'script'; shell: string; script: string; timeout_seconds: number;
  variables: Record<string, string>; target_os: string | null;
};
type ApplicationPayload = {
  kind: 'application'; installer_file_id: string; installer_arguments: string[];
  timeout_seconds: number; detection_type: 'none' | 'msi_product_code' | 'powershell';
  detection_value: string | null; architecture: 'amd64';
  files: Array<{ id: string; original_name: string; sha256: string; size_bytes: number }>;
  variables: Record<string, string>; target_os: 'windows';
};
type ResolvedPayload = ScriptPayload | ApplicationPayload;

// ── Helper: resolve payload for a component ref ────────────────
// Library refs also resolve the component's input variables — supplied value,
// else the variable's default, else (if required) a named error surfaced as a 400.

async function resolvePayload(
  db: D1Database,
  ref: ComponentRef,
): Promise<ResolvedPayload | { error: string } | null> {
  if (ref.type === 'inline') {
    return { kind: 'script', shell: ref.shell, script: ref.script, timeout_seconds: ref.timeout_seconds ?? 300, variables: {}, target_os: null };
  }
  // library
  const comp = await db.prepare(
    `SELECT c.type, c.shell, c.script, c.timeout_seconds, c.target_os,
            a.installer_file_id, a.installer_arguments, a.timeout_seconds AS app_timeout_seconds,
            a.detection_type, a.detection_value, a.architecture
     FROM components c
     LEFT JOIN component_applications a ON a.component_id = c.id
     WHERE c.id = ?`
  ).bind(ref.component_id).first<{
    type: 'script' | 'application'; shell: string; script: string; timeout_seconds: number; target_os: string | null;
    installer_file_id: string | null; installer_arguments: string | null; app_timeout_seconds: number | null;
    detection_type: 'none' | 'msi_product_code' | 'powershell' | null; detection_value: string | null; architecture: 'amd64' | null;
  }>();
  if (!comp) return null;

  const vars = await db.prepare(
    `SELECT name, default_value, required FROM component_variables WHERE component_id = ?`
  ).bind(ref.component_id).all<{ name: string; default_value: string | null; required: number }>();

  const variables: Record<string, string> = {};
  for (const v of vars.results) {
    const supplied = ref.variable_values?.[v.name];
    if (supplied !== undefined) { variables[v.name] = supplied; continue; }
    if (v.default_value !== null) { variables[v.name] = v.default_value; continue; }
    if (v.required) return { error: `missing required variable "${v.name}" for component ${ref.component_id}` };
  }

  if (comp.type === 'application') {
    if (!comp.installer_file_id || !comp.installer_arguments || !comp.app_timeout_seconds || !comp.detection_type || !comp.architecture) {
      return { error: `application component ${ref.component_id} needs an installer file and application settings` };
    }
    const files = await db.prepare(
      `SELECT id, original_name, sha256, size_bytes FROM component_files WHERE component_id = ? ORDER BY created_at ASC`
    ).bind(ref.component_id).all<{ id: string; original_name: string; sha256: string; size_bytes: number }>();
    if (!files.results.some(file => file.id === comp.installer_file_id)) {
      return { error: `application component ${ref.component_id} has an invalid installer file` };
    }
    let installerArguments: string[];
    try {
      installerArguments = JSON.parse(comp.installer_arguments);
    } catch {
      return { error: `application component ${ref.component_id} has invalid installer arguments` };
    }
    if (!Array.isArray(installerArguments) || installerArguments.some(arg => typeof arg !== 'string')) {
      return { error: `application component ${ref.component_id} has invalid installer arguments` };
    }
    return {
      kind: 'application', installer_file_id: comp.installer_file_id, installer_arguments: installerArguments,
      timeout_seconds: comp.app_timeout_seconds, detection_type: comp.detection_type, detection_value: comp.detection_value,
      architecture: comp.architecture, files: files.results, variables, target_os: 'windows',
    };
  }

  return { kind: 'script', shell: comp.shell, script: comp.script, timeout_seconds: comp.timeout_seconds, variables, target_os: comp.target_os };
}

// ── Helper: resolve target device rows ────────────────────────

async function resolveDevices(
  db: D1Database,
  targetType: string,
  targetIds: string[],
): Promise<Array<{ id: string; company_id: string; os_type: string | null }>> {
  if (targetType === 'devices') {
    if (targetIds.length === 0) return [];
    const placeholders = targetIds.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT id, company_id, os_type FROM devices WHERE id IN (${placeholders}) AND status = 'approved'`
    ).bind(...targetIds).all<{ id: string; company_id: string; os_type: string | null }>();
    return result.results;
  }
  if (targetType === 'companies') {
    if (targetIds.length === 0) return [];
    const placeholders = targetIds.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT id, company_id, os_type FROM devices WHERE company_id IN (${placeholders}) AND status = 'approved'`
    ).bind(...targetIds).all<{ id: string; company_id: string; os_type: string | null }>();
    return result.results;
  }
  if (targetType === 'group') {
    if (targetIds.length === 0) return [];
    const placeholders = targetIds.map(() => '?').join(',');
    // DISTINCT since targeting multiple groups (or a device in more than one
    // targeted group) must not double-dispatch the same device.
    const result = await db.prepare(
      `SELECT DISTINCT d.id, d.company_id, d.os_type
       FROM devices d
       JOIN device_group_members m ON m.device_id = d.id
       WHERE m.group_id IN (${placeholders}) AND d.status = 'approved'`
    ).bind(...targetIds).all<{ id: string; company_id: string; os_type: string | null }>();
    return result.results;
  }
  // 'all'
  const result = await db.prepare(
    `SELECT id, company_id, os_type FROM devices WHERE status = 'approved'`
  ).all<{ id: string; company_id: string; os_type: string | null }>();
  return result.results;
}

// ── Helper: bulk-fetch each target device's custom field values, keyed by
// the CF_<KEY> env var name a script references (see custom-fields.ts) ────
// Datto-UDF-style: resolved fresh per-device at dispatch time, not declared
// per-component like component_variables. Early-exits with an empty map
// (zero extra queries) when no field has a key assigned yet.

async function fetchCustomFieldVars(
  db: D1Database,
  deviceIds: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (deviceIds.length === 0) return out;

  const fields = await db.prepare(`SELECT id, key FROM custom_fields WHERE key != ''`).all<{ id: string; key: string }>();
  if (fields.results.length === 0) return out;
  const keyById = new Map(fields.results.map(f => [f.id, f.key]));

  const placeholders = deviceIds.map(() => '?').join(',');
  const values = await db.prepare(
    `SELECT device_id, field_id, value FROM device_custom_field_values WHERE device_id IN (${placeholders}) AND value IS NOT NULL`
  ).bind(...deviceIds).all<{ device_id: string; field_id: string; value: string }>();

  for (const row of values.results) {
    const key = keyById.get(row.field_id);
    if (!key) continue; // field's key blank, or field deleted since assignment
    if (!out.has(row.device_id)) out.set(row.device_id, {});
    out.get(row.device_id)![`CF_${key}`] = row.value;
  }
  return out;
}

// ── Helper: resolve shell for 'auto' ─────────────────────────

function resolveShell(shell: string, osType: string | null): string {
  if (shell !== 'auto') return shell;
  return osType?.toLowerCase() === 'windows' ? 'powershell' : 'bash';
}

// ── Helper: insert commands for an already-resolved device/component set ──

async function insertJobCommands(
  db: D1Database,
  configEncryptionKey: string,
  jobId: string,
  devices: Array<{ id: string; company_id: string; os_type: string | null }>,
  resolved: { ref: ComponentRef; payload: ResolvedPayload }[],
  runAsSystem: boolean,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const inserts: Promise<any>[] = [];
  const cfVarsByDevice = await fetchCustomFieldVars(db, devices.map(d => d.id));
  const cvVarsByCompany = await fetchCompanyVariables(db, configEncryptionKey, devices.map(d => d.company_id));

  for (const device of devices) {
    // Skip components whose target_os doesn't match this device's OS
    const compatible = resolved.filter(({ payload }) =>
      !payload.target_os || payload.target_os === device.os_type
    );
    if (compatible.length === 0) continue;

    const cfVars = cfVarsByDevice.get(device.id) ?? {};
    const cvVars = cvVarsByCompany.get(device.company_id) ?? {};

    for (const { ref, payload } of compatible) {
      const cmdId  = uid();
      const compId  = ref.type === 'library' ? ref.component_id : null;
      const compOrd = ref.order;

      // Company-variable-derived vars first, then custom-field-derived vars,
      // then the component's own declared values. For Applications these stay
      // separate from installer_arguments: the agent expands argument
      // templates locally immediately before launching msiexec, so the stored
      // command payload never contains a license key interpolated into an arg.
      const variables = { ...cvVars, ...cfVars, ...payload.variables };

      if (payload.kind === 'application') {
        const downloads = await Promise.all(payload.files.map(async file => ({
          file,
          token: uid(),
        })));
        const applicationPayload = await signCommandPayload(cmdId, device.id, {
          installer_file_id: payload.installer_file_id,
          installer_arguments: payload.installer_arguments,
          timeout_seconds: payload.timeout_seconds,
          detection_type: payload.detection_type,
          detection_value: payload.detection_value,
          architecture: payload.architecture,
          files: downloads.map(({ file, token }) => ({
            id: file.id,
            original_name: file.original_name,
            sha256: file.sha256,
            size_bytes: file.size_bytes,
            download_token: token,
          })),
          variables,
          run_as_system: runAsSystem,
        }, configEncryptionKey);
        const command = db.prepare(`
          INSERT INTO commands (id, device_id, company_id, type, payload, status, created_at, job_id, component_id, component_order)
          VALUES (?, ?, ?, 'install_msi', ?, 'queued', ?, ?, ?, ?)
        `).bind(cmdId, device.id, device.company_id, applicationPayload, now, jobId, compId, compOrd);
        // A queued command is deliberately not downloadable yet. checkin.ts
        // starts this two-hour window atomically with marking the command
        // sent, so an offline device does not burn its own grant lifetime.
        const grants = await Promise.all(downloads.map(async ({ file, token }) =>
          db.prepare(`
            INSERT INTO component_file_downloads (id, component_file_id, command_id, device_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(uid(), file.id, cmdId, device.id, await sha256hex(token), now, now)
        ));
        // D1 batch preserves statement order and is atomic, so an agent can
        // never receive its command before every matching file grant exists.
        await db.batch([command, ...grants]);
        continue;
      }

      const shell = resolveShell(payload.shell, device.os_type);
      const scriptPayload = await signCommandPayload(cmdId, device.id, {
        shell,
        script: payload.script,
        timeout_seconds: payload.timeout_seconds,
        variables,
        run_as_system: runAsSystem,
      }, configEncryptionKey);

      inserts.push(
        db.prepare(`
          INSERT INTO commands (id, device_id, company_id, type, payload, status, created_at, job_id, component_id, component_order)
          VALUES (?, ?, ?, 'run_script', ?, 'queued', ?, ?, ?, ?)
        `).bind(cmdId, device.id, device.company_id, scriptPayload, now, jobId, compId, compOrd).run()
      );
    }
  }

  await Promise.all(inserts);
}

// ── Scheduled job dispatch (called from the cron every 2 min) ─────────────
// Target devices are resolved now, not at job-creation time — matches
// Datto's own documented semantics ("devices targeted by a Job are
// calculated just before it is scheduled to run"), since the matching
// device set can legitimately change between creation and a future
// scheduled_at. A job with zero matching devices right now is left
// 'active' and retried on the next cron tick until it either resolves
// devices or expires (see cancelExpiredScheduledJobs below).

export async function dispatchDueScheduledJobs(db: D1Database, configEncryptionKey: string, now: number): Promise<void> {
  const due = await db.prepare(`
    SELECT j.* FROM jobs j
    WHERE j.type = 'scheduled' AND j.status = 'active'
      AND j.scheduled_at IS NOT NULL AND j.scheduled_at <= ?
      AND (j.expires_at IS NULL OR j.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM commands WHERE job_id = j.id)
  `).bind(now, now).all<any>();

  for (const job of due.results) {
    const components: ComponentRef[] = JSON.parse(job.component_ids);
    const targetIds:  string[]       = JSON.parse(job.target_ids);

    const devices = await resolveDevices(db, job.target_type, targetIds);
    if (devices.length === 0) continue;

    const resolutions = await Promise.all(
      components.map(async (ref: ComponentRef) => ({ ref, payload: await resolvePayload(db, ref) }))
    );
    const resolved = resolutions.filter(
      (r): r is { ref: ComponentRef; payload: ResolvedPayload } => r.payload !== null && !('error' in r.payload)
    );
    // A referenced component may have been deleted/edited since creation.
    // Skip this tick rather than partially dispatch; it'll retry until expiry.
    if (resolved.length === 0) continue;

    await insertJobCommands(db, configEncryptionKey, job.id, devices, resolved, Boolean(job.run_as_system));
    // Layer-2 call -- this dispatch happens from the scheduled() cron, never
    // a user-authenticated HTTP route, so the generic middleware can't see
    // it. Job *creation* is a normal admin route and is already covered by
    // Layer 1. No companyId -- a scheduled job can target multiple companies, so
    // it isn't unambiguously owned by one.
    await logActivity(drizzle(db, { schema }), {
      actorType: 'system', category: 'Job', action: 'Dispatched scheduled job',
      entityType: 'job', entityId: job.id, method: 'CRON',
      details: { deviceCount: devices.length },
    });
  }
}

// Cancel any queued commands for expired active jobs, then mark those jobs cancelled.
// Handles two cases: scheduled jobs that never dispatched (zero commands), and any
// job (quick or scheduled) whose queued commands were never picked up before expires_at.
export async function cancelExpiredScheduledJobs(db: D1Database, now: number): Promise<void> {
  // First: expire all queued commands belonging to expired active jobs
  await db.prepare(`
    UPDATE commands SET status = 'expired'
    WHERE status = 'queued'
      AND job_id IN (
        SELECT id FROM jobs WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
      )
  `).bind(now).run();

  // Then: cancel any active job past its expiry that has no pending commands left
  await db.prepare(`
    UPDATE jobs SET status = 'cancelled'
    WHERE status = 'active'
      AND expires_at IS NOT NULL AND expires_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM commands WHERE job_id = jobs.id AND status IN ('queued', 'sent')
      )
  `).bind(now).run();
}

// ── Helper: map job row ───────────────────────────────────────

function mapJob(r: any, stats?: { device_count: number; queued: number; sent: number; completed: number; failed: number; expired: number }) {
  return {
    id:            r.id,
    name:          r.name,
    description:   r.description,
    type:          r.type,
    status:        r.status,
    componentIds:  r.component_ids,
    targetType:    r.target_type,
    targetIds:     r.target_ids,
    runAsSystem:   Boolean(r.run_as_system),
    scheduledAt:   r.scheduled_at,
    expiresAt:     r.expires_at,
    createdAt:     r.created_at,
    createdBy:     r.created_by,
    deviceCount:   stats?.device_count ?? 0,
    deviceStats: {
      queued:    stats?.queued    ?? 0,
      sent:      stats?.sent      ?? 0,
      completed: stats?.completed ?? 0,
      failed:    stats?.failed    ?? 0,
      expired:   stats?.expired   ?? 0,
    },
  };
}

// ── GET / — list jobs with aggregate device stats ─────────────

adminJobs.get('/', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);

  const typeFilter   = c.req.query('type');
  const statusFilter = c.req.query('status');

  const conditions: string[] = [];
  const bindings:   any[]    = [];

  if (typeFilter)   { conditions.push('j.type = ?');   bindings.push(typeFilter); }
  if (statusFilter) { conditions.push('j.status = ?'); bindings.push(statusFilter); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await c.env.DB.prepare(`
    SELECT
      j.*,
      COUNT(DISTINCT c.device_id)                                         AS device_count,
      SUM(CASE WHEN c.status = 'queued'    THEN 1 ELSE 0 END)            AS queued,
      SUM(CASE WHEN c.status = 'sent'      THEN 1 ELSE 0 END)            AS sent,
      SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END)            AS completed,
      SUM(CASE WHEN c.status = 'failed'    THEN 1 ELSE 0 END)            AS failed,
      SUM(CASE WHEN c.status = 'expired'   THEN 1 ELSE 0 END)            AS expired
    FROM jobs j
    LEFT JOIN commands c ON c.job_id = j.id
    ${where}
    GROUP BY j.id
    ORDER BY j.created_at DESC
    LIMIT 200
  `).bind(...bindings).all<any>();

  return c.json(result.results.map(r => mapJob(r, {
    device_count: r.device_count ?? 0,
    queued:       r.queued       ?? 0,
    sent:         r.sent         ?? 0,
    completed:    r.completed    ?? 0,
    failed:       r.failed       ?? 0,
    expired:      r.expired      ?? 0,
  })));
});

// ── GET /:id — job detail with per-device command breakdown ───

adminJobs.get('/:id', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');

  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first<any>();
  if (!job) return c.json({ error: 'not found' }, 404);

  const cmds = await c.env.DB.prepare(`
    SELECT
      c.id, c.device_id, c.component_id, c.component_order,
      c.status, c.result, c.warning, c.created_at, c.completed_at,
      d.hostname, d.os_type,
      t.name AS company_name,
      comp.name AS component_name
    FROM commands c
    JOIN devices d ON d.id = c.device_id
    JOIN companies t ON t.id = c.company_id
    LEFT JOIN components comp ON comp.id = c.component_id
    WHERE c.job_id = ?
    ORDER BY c.device_id, c.component_order ASC
  `).bind(id).all<any>();

  // Group by device
  const deviceMap = new Map<string, {
    deviceId: string; hostname: string | null; osType: string | null; companyName: string;
    commands: any[];
  }>();

  for (const row of cmds.results) {
    if (!deviceMap.has(row.device_id)) {
      deviceMap.set(row.device_id, {
        deviceId:   row.device_id,
        hostname:   row.hostname,
        osType:     row.os_type,
        companyName: row.company_name,
        commands:   [],
      });
    }
    deviceMap.get(row.device_id)!.commands.push({
      id:             row.id,
      componentId:    row.component_id,
      componentName:  row.component_name,
      componentOrder: row.component_order,
      status:         row.status,
      result:         row.result,
      warning:        row.warning === 1,
      createdAt:      row.created_at,
      completedAt:    row.completed_at,
    });
  }

  const stats = { device_count: deviceMap.size, queued: 0, sent: 0, completed: 0, failed: 0, expired: 0 };
  for (const dev of deviceMap.values()) {
    for (const cmd of dev.commands) {
      if (cmd.status in stats) stats[cmd.status as keyof typeof stats] = (stats[cmd.status as keyof typeof stats] as number) + 1;
    }
  }

  return c.json({
    ...mapJob(job, stats),
    devices: [...deviceMap.values()],
  });
});

// ── POST / — create job + dispatch commands ───────────────────

adminJobs.post('/', async (c) => {
  const user = await auth(c, 'technician');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json<{
    name: string;
    description?: string;
    type?: 'quick' | 'scheduled';
    components: ComponentRef[];
    target_type?: string;
    target_ids?: string[];
    scheduled_at?: number;
    expires_at?: number;
    run_as_system?: boolean;
  }>();

  if (!body.name?.trim())                     return c.json({ error: 'name required' }, 400);
  if (!body.components || body.components.length === 0) return c.json({ error: 'components required' }, 400);

  // A Job (Quick Job included -- DeviceDetailPage.vue's Quick Job modal
  // dispatches through this exact route) that includes a component flagged
  // requires_admin can only be created by an admin. Checked before any
  // further work -- a technician-created Job referencing a flagged
  // component should never reach device resolution or command insertion.
  const libraryComponentIds = body.components
    .filter((r): r is Extract<ComponentRef, { type: 'library' }> => r.type === 'library')
    .map(r => r.component_id);
  if (libraryComponentIds.length > 0 && !roleAtLeast(user.role, 'admin')) {
    const placeholders = libraryComponentIds.map(() => '?').join(',');
    const flagged = await c.env.DB.prepare(
      `SELECT name FROM components WHERE id IN (${placeholders}) AND requires_admin = 1`
    ).bind(...libraryComponentIds).all<{ name: string }>();
    if (flagged.results.length > 0) {
      return c.json({ error: `admin role required to run: ${flagged.results.map(r => r.name).join(', ')}` }, 403);
    }
  }

  const jobType   = body.type ?? 'quick';
  const targetType = body.target_type ?? 'devices';
  const targetIds  = body.target_ids  ?? [];

  // Quick jobs resolve + validate their target devices now, since they
  // dispatch immediately. Scheduled jobs resolve devices later, just
  // before dispatch (see dispatchDueScheduledJobs) — the device set can
  // legitimately change between now and a future scheduled_at.
  let devices: Array<{ id: string; company_id: string; os_type: string | null }> = [];
  if (jobType === 'quick') {
    devices = await resolveDevices(c.env.DB, targetType, targetIds);
    if (devices.length === 0 && targetType === 'devices') {
      return c.json({ error: 'no approved devices found for the given IDs' }, 400);
    }
  }

  // Resolve all component payloads up front (validate they exist + required variables are satisfied)
  const resolutions = await Promise.all(
    body.components.map(async (ref) => ({ ref, payload: await resolvePayload(c.env.DB, ref) }))
  );

  for (const { ref, payload } of resolutions) {
    if (payload === null) {
      return c.json({ error: `component not found: ${'component_id' in ref ? ref.component_id : 'inline'}` }, 404);
    }
    if ('error' in payload) {
      return c.json({ error: payload.error }, 400);
    }
  }
  const resolved = resolutions as { ref: ComponentRef; payload: ResolvedPayload }[];
  if (resolved.some(({ payload }) => payload.kind === 'application') && body.run_as_system === false) {
    return c.json({ error: 'application components must run as the system account' }, 400);
  }

  const now   = Math.floor(Date.now() / 1000);
  const jobId = uid();

  // Create the job record
  const createdBy = user.source === 'break-glass' ? 'Admin' : (user.displayName ?? user.email);
  await c.env.DB.prepare(`
    INSERT INTO jobs (id, name, description, type, status, component_ids, target_type, target_ids, scheduled_at, expires_at, run_as_system, created_at, created_by)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    jobId,
    body.name.trim(),
    body.description ?? null,
    jobType,
    JSON.stringify(body.components),
    targetType,
    JSON.stringify(targetIds),
    body.scheduled_at ?? null,
    body.expires_at ?? null,
    body.run_as_system ?? true,
    now,
    createdBy,
  ).run();

  // Dispatch commands immediately for quick jobs; scheduled jobs wait for
  // the cron (dispatchDueScheduledJobs) to resolve devices and dispatch
  // once scheduled_at arrives.
  if (jobType === 'quick') {
    await insertJobCommands(c.env.DB, c.env.CONFIG_ENCRYPTION_KEY, jobId, devices, resolved, body.run_as_system ?? true);
  }

  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<any>();
  return c.json(mapJob(job!, { device_count: devices.length, queued: devices.length * body.components.length, sent: 0, completed: 0, failed: 0, expired: 0 }), 201);
});

// ── DELETE /:id — retire job (cancel, keep history) ───────────

adminJobs.delete('/:id', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const id  = c.req.param('id');
  const job = await c.env.DB.prepare(`SELECT id FROM jobs WHERE id = ?`).bind(id).first<any>();
  if (!job) return c.json({ error: 'not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE commands SET status = 'failed' WHERE job_id = ? AND status IN ('queued', 'sent')`
  ).bind(id).run();
  await c.env.DB.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

// ── DELETE /:id/purge — hard delete job + commands ─────────────

adminJobs.delete('/:id/purge', async (c) => {
  if (!(await auth(c, 'admin'))) return c.json({ error: 'unauthorized' }, 401);
  const id  = c.req.param('id');
  const job = await c.env.DB.prepare(`SELECT id FROM jobs WHERE id = ?`).bind(id).first<any>();
  if (!job) return c.json({ error: 'not found' }, 404);

  await c.env.DB.prepare(`DELETE FROM commands WHERE job_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

export default adminJobs;
