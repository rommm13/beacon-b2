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

// Independent of windowsUpdateManagement.ts's AU takeover -- registers/
// unregisters the separate "Microsoft Update" service (which broadens WUA
// search results to include Office and other Microsoft products, not just
// the OS) via agent/internal/muconfig, mirroring auconfig's exact
// manage/revert-with-prior-state-snapshot shape. Verbatim structural
// mirror of syncWindowsUpdateManagement -- not shared, same per-capability
// mirroring convention already established between auto_reboot and
// manage_windows_update.
//
// Dispatched through commands, deliberately not the check-in wire protocol
// -- same reasoning as every other Patch Policy capability this session.
export async function syncMicrosoftUpdateManagement(DB: D1Database, now: number, configEncryptionKey?: string): Promise<void> {
  const db = drizzle(DB, { schema });
  if (!configEncryptionKey) return; // manage_microsoft_update requires an origin signature: fail closed

  const policies = await fetchEnabledPatchPolicies(db);
  const managing = policies.filter(p => p.manageMicrosoftUpdate);

  const devices = await db.select().from(schema.devices)
    .where(and(eq(schema.devices.status, 'approved'), eq(schema.devices.osType, 'windows')))
    .all();
  if (devices.length === 0) return;

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

  // Same outstanding-command guard as syncWindowsUpdateManagement, keyed to
  // this feature's own command type so the two never interfere.
  const outstandingDeviceIds = new Set(
    (await db.select({ deviceId: schema.commands.deviceId }).from(schema.commands)
      .where(and(eq(schema.commands.type, 'manage_microsoft_update'), inArray(schema.commands.status, ['queued', 'sent'])))
      .all()).map(r => r.deviceId),
  );

  const inserts: Promise<unknown>[] = [];
  for (const device of devices) {
    if (outstandingDeviceIds.has(device.id)) continue;
    const desired = hasCoverage(device);
    const current = device.microsoftUpdateManaged;
    if (desired === current) continue; // null !== true/false, so a never-evaluated device always gets its first command

    const payload = desired
      ? { action: 'manage' as const }
      : { action: 'revert' as const, prior_state: device.microsoftUpdatePriorState ? JSON.parse(device.microsoftUpdatePriorState) : null };

    const muCmdId = crypto.randomUUID();
    inserts.push(
      db.insert(schema.commands).values({
        id: muCmdId,
        deviceId: device.id,
        companyId: device.companyId,
        type: 'manage_microsoft_update',
        payload: await signCommandPayload(muCmdId, device.id, payload, configEncryptionKey),
        status: 'queued',
        createdAt: now,
      }),
    );
  }
  await Promise.all(inserts);
}
