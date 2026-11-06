import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, inArray } from 'drizzle-orm';
import type { Bindings } from '../index';
import * as schema from '../db/schema';
import type { CheckInRequest, CheckInResponse } from '../lib/types';
import { sha256hex } from '../lib/crypto';
import { evaluateCheckinAlerts, evaluateFileSizeAlerts, evaluatePingAlerts, evaluateProcessAlerts, evaluateServiceAlerts, evaluateWindowsUpdateDriftAlerts, resolveWindowsUpdateDriftAlerts } from '../lib/alerts';
import { evaluatePostConditions, type PostCondition } from '../lib/postConditions';
import { isDeviceSuppressedNow } from '../lib/maintenance';
import { isFastPollActive, FAST_POLL_INTERVAL_SECONDS } from '../lib/fastPoll';
import { recordDiscoveredHosts, type DiscoveredHost } from '../lib/discovery';
import { processGptTasksForDevice, mirrorGptTaskResult } from '../lib/gptBridge';

const checkin = new Hono<{ Bindings: Bindings }>();

checkin.post('/', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization' }, 401);
  }
  const credentialHash = await sha256hex(auth.slice(7));

  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  const device = await db.select()
    .from(schema.devices)
    .where(eq(schema.devices.deviceCredentialHash, credentialHash))
    .get();

  if (!device) return c.json({ error: 'unknown device' }, 401);
  if (device.status === 'revoked') return c.json({ error: 'device revoked' }, 403);

  let body: CheckInRequest;
  try {
    body = await c.req.json<CheckInRequest>();
  } catch {
    return c.json({ error: 'invalid request body' }, 400);
  }

  if (body.device_id !== device.id || body.tenant_id !== device.companyId) {
    return c.json({ error: 'device_id or company_id mismatch' }, 403);
  }

  // A lower uptime_seconds than the prior check-in means the device has
  // rebooted since then -- clear any pending-reboot flag. Compared against
  // `device` (fetched above, before this update), which still holds the OLD
  // inventory. Only spliced into .set() when actually detected -- never
  // unconditionally with a live true/false -- otherwise every ordinary
  // check-in (uptime just increasing normally) would silently wipe a flag a
  // *different* check-in's command-result loop below had just set.
  let rebootDetected = false;
  if (device.pendingRebootRequired && typeof device.inventory === 'string') {
    try {
      const prior = JSON.parse(device.inventory) as { uptime_seconds?: number };
      if (typeof prior.uptime_seconds === 'number' && body.metrics.uptime_seconds < prior.uptime_seconds) {
        rebootDetected = true;
      }
    } catch { /* malformed prior inventory -- leave the flag as-is, next check-in retries */ }
  }

  // detected_class is always recomputed from agent signals — never touches override_class
  await db.update(schema.devices)
    .set({
      lastSeen: now,
      agentVersion: body.agent_version,
      hostname: body.metrics.hostname,
      osType: body.metrics.os_type,
      osVersion: body.metrics.os_version,
      detectedClass: body.metrics.detected_class,
      inventory: JSON.stringify(body.metrics),
      externalIp: c.req.header('CF-Connecting-IP') ?? null,
      ...(rebootDetected ? { pendingRebootRequired: false, pendingRebootDetectedAt: null } : {}),
    })
    .where(eq(schema.devices.id, device.id));

  // Process results from previously issued commands
  if (body.pending_command_results?.length) {
    const ids = body.pending_command_results.map(r => r.command_id);
    const owned = await db.select({
      id: schema.commands.id, componentId: schema.commands.componentId, jobId: schema.commands.jobId,
      type: schema.commands.type, companyId: schema.commands.companyId, payload: schema.commands.payload,
    })
      .from(schema.commands)
      .where(and(
        inArray(schema.commands.id, ids),
        eq(schema.commands.deviceId, device.id),
      ));
    const ownedById = new Map(owned.map(r => [r.id, r]));

    const componentIds = [...new Set(owned.map(r => r.componentId).filter((x): x is string => !!x))];
    const postCondByComponent = new Map<string, PostCondition[]>();
    if (componentIds.length) {
      const comps = await db.select({ id: schema.components.id, postConditions: schema.components.postConditions })
        .from(schema.components)
        .where(inArray(schema.components.id, componentIds));
      for (const comp of comps) postCondByComponent.set(comp.id, JSON.parse(comp.postConditions || '[]'));
    }

    const affectedJobIds = new Set<string>();
    for (const r of body.pending_command_results) {
      const ownedCmd = ownedById.get(r.command_id);
      if (!ownedCmd) continue; // ignore results for commands not belonging to this device
      const conditions = ownedCmd.componentId ? (postCondByComponent.get(ownedCmd.componentId) ?? []) : [];
      const warning = evaluatePostConditions(conditions, r.stdout ?? '', r.stderr ?? '');

      await db.update(schema.commands)
        .set({
          status: r.status,
          result: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code }),
          completedAt: now,
          warning,
        })
        .where(eq(schema.commands.id, r.command_id));

      // ChatGPT bridge: push the result into gpt_tasks immediately so the
      // model reads it within this same poll cycle rather than waiting for
      // the cron sweep. Best-effort, same posture as the dispatch hook.
      try {
        await mirrorGptTaskResult(db, r.command_id, { status: r.status, result: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code }) }, now);
      } catch {
        // cron sweep will catch up
      }

      if (ownedCmd.type === 'network_scan' && r.status === 'completed') {
        try {
          const scanResult = JSON.parse(r.stdout ?? '{}') as { hosts?: DiscoveredHost[] };
          if (scanResult.hosts?.length) {
            await recordDiscoveredHosts(db, ownedCmd.companyId, scanResult.hosts, now);
          }
        } catch {
          // Malformed scan output shouldn't fail the whole check-in --
          // the command row above already recorded raw stdout/stderr for
          // debugging.
        }
      }

      if (ownedCmd.type === 'install_rustdesk' && r.status === 'completed') {
        try {
          const installResult = JSON.parse(r.stdout ?? '{}') as { rustdesk_id?: string };
          if (installResult.rustdesk_id) {
            await db.update(schema.devices).set({ rustdeskId: installResult.rustdesk_id }).where(eq(schema.devices.id, device.id));
          }
        } catch {
          // Malformed install result shouldn't fail the whole check-in --
          // the command row above already recorded raw stdout/stderr. Note:
          // the unattended password is never in stdout/stderr here at all --
          // see rustdesk-password.ts's own doc comment for why.
        }
      }

      if (ownedCmd.type === 'install_patches' && r.status === 'completed') {
        try {
          const installResult = JSON.parse(r.stdout ?? '{}') as { reboot_required?: boolean };
          if (installResult.reboot_required) {
            // Set unconditionally regardless of the command's own
            // auto_reboot payload flag -- an auto-reboot dispatch already
            // shuts the device down almost immediately, so this just
            // self-clears within a check-in or two via the uptime-decrease
            // comparison above, rather than needing a separate code path.
            await db.update(schema.devices).set({
              pendingRebootRequired: true,
              pendingRebootDetectedAt: now,
            }).where(eq(schema.devices.id, device.id));
          }
        } catch {
          // Malformed install result shouldn't fail the whole check-in --
          // the command row above already recorded raw stdout/stderr.
        }
      }

      if (ownedCmd.type === 'manage_windows_update' && r.status === 'completed') {
        try {
          const applyResult = JSON.parse(r.stdout ?? '{}') as {
            applied?: boolean; prior_no_auto_update?: number | null; prior_au_options?: number | null;
          };
          const action = (JSON.parse(ownedCmd.payload) as { action?: string }).action;

          if (action === 'manage' && applyResult.applied) {
            await db.update(schema.devices).set({
              windowsUpdateManaged: true,
              windowsUpdatePriorState: JSON.stringify({
                no_auto_update: applyResult.prior_no_auto_update ?? null,
                au_options: applyResult.prior_au_options ?? null,
              }),
              windowsUpdateManagedAt: now,
            }).where(eq(schema.devices.id, device.id));
          } else if (action === 'revert' && applyResult.applied) {
            await db.update(schema.devices).set({
              windowsUpdateManaged: false,
              windowsUpdatePriorState: null,
              windowsUpdateManagedAt: null,
            }).where(eq(schema.devices.id, device.id));
            // Beacon no longer asserts any AU registry state for this device
            // -- unconditionally clear any open drift alert, regardless of
            // maintenance mode or the monitor's own auto_resolve setting.
            // See resolveWindowsUpdateDriftAlerts's own doc comment.
            await resolveWindowsUpdateDriftAlerts(c.env.DB, device.id, now);
          }
        } catch {
          // Malformed/failed result shouldn't fail the whole check-in --
          // the command row above already recorded raw stdout/stderr, and
          // syncWindowsUpdateManagement will simply retry next cron tick
          // since devices.windowsUpdateManaged won't have changed.
        }
      }

      if (ownedCmd.type === 'manage_microsoft_update' && r.status === 'completed') {
        try {
          const applyResult = JSON.parse(r.stdout ?? '{}') as {
            applied?: boolean; prior_registered?: boolean | null;
          };
          const action = (JSON.parse(ownedCmd.payload) as { action?: string }).action;

          if (action === 'manage' && applyResult.applied) {
            await db.update(schema.devices).set({
              microsoftUpdateManaged: true,
              microsoftUpdatePriorState: JSON.stringify({
                was_registered: applyResult.prior_registered ?? false,
              }),
              microsoftUpdateManagedAt: now,
            }).where(eq(schema.devices.id, device.id));
          } else if (action === 'revert' && applyResult.applied) {
            await db.update(schema.devices).set({
              microsoftUpdateManaged: false,
              microsoftUpdatePriorState: null,
              microsoftUpdateManagedAt: null,
            }).where(eq(schema.devices.id, device.id));
          }
        } catch {
          // Same "swallow, let the next cron tick retry" reasoning as
          // manage_windows_update above.
        }
      }

      if (ownedCmd.jobId) affectedJobIds.add(ownedCmd.jobId);
    }

    // Flip job to 'completed' once all its commands have reached a terminal state.
    for (const jobId of affectedJobIds) {
      const pending = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM commands WHERE job_id = ? AND status IN ('queued', 'sent')`
      ).bind(jobId).first<{ n: number }>();
      if (pending && pending.n === 0) {
        await c.env.DB.prepare(
          `UPDATE jobs SET status = 'completed' WHERE id = ? AND status = 'active'`
        ).bind(jobId).run();
      }
    }
  }

  const inMaintenance = await isDeviceSuppressedNow(db, device, now);
  const fastPollActive = isFastPollActive(device, now);

  // ChatGPT bridge: classify/dispatch new tasks, hand approved ones to the
  // queue below (same commands table the agent just polled). Best-effort:
  // a bridge failure must not break the device's normal check-in.
  try {
    await processGptTasksForDevice(db, c.env, device.id, now);
  } catch {
    // swallowed: next check-in retries
  }

  // Evaluate in-band alert checks (disk_space, etc.) against fresh inventory
  const { fileSizeChecks, pingChecks, processChecks, serviceChecks, windowsUpdateDriftChecks } = inMaintenance
    ? { fileSizeChecks: [], pingChecks: [], processChecks: [], serviceChecks: [], windowsUpdateDriftChecks: [] }
    : await evaluateCheckinAlerts(c.env.DB, c.env, device, body.metrics, now);

  if (!inMaintenance) {
    // Evaluate file_size measurements the agent took for a prior check-in's assignments
    if (body.pending_file_size_results?.length) {
      await evaluateFileSizeAlerts(c.env.DB, c.env, device, body.pending_file_size_results, now);
    }

    // Evaluate ping measurements the agent took for a prior check-in's assignments
    if (body.pending_ping_results?.length) {
      await evaluatePingAlerts(c.env.DB, c.env, device, body.pending_ping_results, now);
    }

    // Evaluate process measurements the agent took for a prior check-in's assignments
    if (body.pending_process_results?.length) {
      await evaluateProcessAlerts(c.env.DB, c.env, device, body.pending_process_results, now);
    }

    // Evaluate service measurements the agent took for a prior check-in's assignments
    if (body.pending_service_results?.length) {
      await evaluateServiceAlerts(c.env.DB, c.env, device, body.pending_service_results, now);
    }

    // Evaluate Windows Update drift measurements the agent took for a prior check-in's assignments
    if (body.pending_windows_update_drift_results?.length) {
      await evaluateWindowsUpdateDriftAlerts(c.env.DB, c.env, device, body.pending_windows_update_drift_results, now);
    }
  }

  // Pending devices: accept data for visibility, return no commands
  if (device.status === 'pending') {
    return c.json<CheckInResponse>({});
  }

  // Fetch queued commands and mark them sent
  const queued = await db.select()
    .from(schema.commands)
    .where(and(
      eq(schema.commands.deviceId, device.id),
      eq(schema.commands.status, 'queued'),
    ))
    .limit(10);

  if (queued.length > 0) {
    await db.update(schema.commands)
      .set({ status: 'sent' })
      .where(inArray(schema.commands.id, queued.map(c => c.id)));
    // File grants become usable only once their matching command is handed to
    // the agent. This keeps the capability short-lived without punishing an
    // offline device whose queued command waited for days before its next
    // check-in.
    await c.env.DB.prepare(
      `UPDATE component_file_downloads SET expires_at = ? WHERE command_id IN (${queued.map(() => '?').join(',')})`
    ).bind(now + (2 * 60 * 60), ...queued.map(c => c.id)).run();
    // Same activation as component_file_downloads above, for
    // install_rustdesk's own two grant tables (installer download +
    // password redemption) -- both keyed the same way, both only
    // become usable once their command is actually handed to the agent.
    await c.env.DB.prepare(
      `UPDATE rustdesk_installer_downloads SET expires_at = ? WHERE command_id IN (${queued.map(() => '?').join(',')})`
    ).bind(now + (2 * 60 * 60), ...queued.map(c => c.id)).run();
    await c.env.DB.prepare(
      `UPDATE rustdesk_password_grants SET expires_at = ? WHERE command_id IN (${queued.map(() => '?').join(',')})`
    ).bind(now + (2 * 60 * 60), ...queued.map(c => c.id)).run();
  }

  return c.json<CheckInResponse>({
    commands: queued.map(cmd => ({
      command_id: cmd.id,
      type: cmd.type,
      payload: JSON.parse(cmd.payload),
    })),
    file_size_checks: fileSizeChecks.length ? fileSizeChecks : undefined,
    ping_checks: pingChecks.length ? pingChecks : undefined,
    process_checks: processChecks.length ? processChecks : undefined,
    service_checks: serviceChecks.length ? serviceChecks : undefined,
    windows_update_drift_checks: windowsUpdateDriftChecks.length ? windowsUpdateDriftChecks : undefined,
    next_checkin_seconds: fastPollActive ? FAST_POLL_INTERVAL_SECONDS : undefined,
  });
});

export default checkin;
