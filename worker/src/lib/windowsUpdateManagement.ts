import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { fetchDeviceGroupIds } from './alerts';
import { signCommandPayload } from './gptBridge';
import {
  fetchEnabledPatchPolicies, fetchPatchPolicyCompanyIds, fetchPatchPolicyDeviceIds,
  fetchPatchPolicyGroupIds, fetchExcludedCompanyIds, deviceMatchesPatchPolicy,
} from './patchPolicies';

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Device = typeof schema.devices.$inferSelect;

// Windows' own separate "Automatic Updates" behavior is never touched by
// the rest of Patch Management (which drives WUA directly) -- left enabled,
// Windows can install an update Beacon hasn't approved, or reboot outside a
// configured install window, undercutting the whole approval/scheduling
// model. This syncs a device's AU takeover state to whether it's currently
// covered by an enabled, opted-in (`manage_windows_update`) Patch Policy --
// gated strictly on real coverage so a device is never left with Windows
// Update disabled and nothing else to patch it: losing coverage for any
// reason (toggle turned off, policy disabled/deleted, retargeted) reverts
// it on the very next cron tick, the same way coverage itself is always
// recomputed fresh rather than tracked incrementally.
//
// Dispatches through the existing commands table (the same one-shot
// mechanism as install_patches/network_scan), not the check-in wire
// protocol -- deliberately, per this session's own earlier incident where
// extending CheckInRequest/CheckInResponse broke check-in fleet-wide.
export async function syncWindowsUpdateManagement(DB: D1Database, now: number, configEncryptionKey?: string): Promise<void> {
  const db = drizzle(DB, { schema });
  if (!configEncryptionKey) return; // manage_windows_update requires an origin signature: fail closed

  const policies = await fetchEnabledPatchPolicies(db);
  const managing = policies.filter(p => p.manageWindowsUpdate);

  const devices = await db.select().from(schema.devices)
    .where(and(eq(schema.devices.status, 'approved'), eq(schema.devices.osType, 'windows')))
    .all();
  if (devices.length === 0) return;

  // Coverage is evaluated independent of whether a policy's install window
  // is active right now -- gating on window-active would defeat the whole
  // point of pre-emptively disabling Windows' own auto-update ahead of a
  // scheduled window that hasn't opened yet.
  const [policyCompanyIds, policyDeviceIds, policyGroupIds, excludedCompanyIds, deviceGroupIds] = await Promise.all([
    fetchPatchPolicyCompanyIds(db),
    fetchPatchPolicyDeviceIds(db),
    fetchPatchPolicyGroupIds(db),
    fetchExcludedCompanyIds(db),
    fetchDeviceGroupIds(db, devices.map(d => d.id)),
  ]);

  const hasCoverage = (device: Device): boolean =>
    managing.some(p => deviceMatchesPatchPolicy(
      p, device, deviceGroupIds.get(device.id) ?? new Set(), policyGroupIds, policyCompanyIds, policyDeviceIds, excludedCompanyIds));

  // Skip a device with an already-outstanding (not yet terminal) command --
  // same guard Jobs already uses to avoid piling up redundant dispatches on
  // a device that's offline or slow to check in.
  const outstandingDeviceIds = new Set(
    (await db.select({ deviceId: schema.commands.deviceId }).from(schema.commands)
      .where(and(eq(schema.commands.type, 'manage_windows_update'), inArray(schema.commands.status, ['queued', 'sent'])))
      .all()).map(r => r.deviceId),
  );

  const inserts: Promise<unknown>[] = [];
  for (const device of devices) {
    if (outstandingDeviceIds.has(device.id)) continue;
    const desired = hasCoverage(device);
    const current = device.windowsUpdateManaged;
    if (desired === current) continue; // null !== true/false, so a never-evaluated device always gets its first command

    const payload = desired
      ? { action: 'manage' as const }
      : { action: 'revert' as const, prior_state: device.windowsUpdatePriorState ? JSON.parse(device.windowsUpdatePriorState) : null };

    const wuCmdId = crypto.randomUUID();
    inserts.push(
      db.insert(schema.commands).values({
        id: wuCmdId,
        deviceId: device.id,
        companyId: device.companyId,
        type: 'manage_windows_update',
        payload: await signCommandPayload(wuCmdId, device.id, payload, configEncryptionKey),
        status: 'queued',
        createdAt: now,
      }),
    );
  }
  await Promise.all(inserts);
}
