import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { logActivity } from './activityLog';
import { fetchCompanyVariables } from './companyVariables';
import { signCommandPayload } from './gptBridge';

type Db = ReturnType<typeof drizzle<typeof schema>>;

// ── Credentialed scan payload (issue #78) ───────────────────────────────────
// Fixed Company Variable key names -- the credential storage/lookup
// convention this feature uses instead of a new picker UI, matching how
// CV_/CF_ already work everywhere else in this codebase. A protocol is only
// included in a scan's payload when it's enabled on the config *and* has
// its required credential(s) actually present -- a missing credential
// silently skips just that protocol, never the whole scan.
interface DiscoveryCredentials {
  snmp?: { community: string };
  ssh?: { username: string; password: string };
}

async function resolveDiscoveryCredentials(
  DB: D1Database, configEncryptionKey: string, companyId: string,
  snmpEnabled: boolean, sshEnabled: boolean,
): Promise<DiscoveryCredentials> {
  const creds: DiscoveryCredentials = {};
  if (!snmpEnabled && !sshEnabled) return creds;

  const varsByCompany = await fetchCompanyVariables(DB, configEncryptionKey, [companyId]);
  const vars = varsByCompany.get(companyId) ?? {};

  if (snmpEnabled && vars['CV_SNMP_COMMUNITY']) {
    creds.snmp = { community: vars['CV_SNMP_COMMUNITY'] };
  }
  if (sshEnabled && vars['CV_SSH_USERNAME'] && vars['CV_SSH_PASSWORD']) {
    creds.ssh = { username: vars['CV_SSH_USERNAME'], password: vars['CV_SSH_PASSWORD'] };
  }
  return creds;
}

// ── Scheduled dispatch ──────────────────────────────────────────────────────
// Scans dispatch through the existing commands table -- same one-shot
// mechanism as install_patches/run_audit -- not the check-in wire protocol,
// deliberately avoiding the exact surface (CheckInRequest/CheckInResponse)
// that caused a real production incident when it was last extended. Closer
// to dispatchDuePatchPolicies' shape than to any per-monitor check pattern:
// a config is either due or not, dispatching directly to its one designated
// probe device, not resolved against a device set.
export async function dispatchDueDiscoveryScans(DB: D1Database, configEncryptionKey: string, now: number): Promise<void> {
  const db = drizzle(DB, { schema });

  const configs = await db.select().from(schema.networkDiscoveryConfigs)
    .where(eq(schema.networkDiscoveryConfigs.enabled, true)).all();
  const due = configs.filter(c =>
    c.lastScannedAt == null || now - c.lastScannedAt >= c.scanIntervalMinutes * 60
  );
  if (due.length === 0) return;

  for (const config of due) {
    // Re-verify the probe device still exists, is approved, and still
    // belongs to this company -- skip silently and retry next tick if not,
    // same defensive shape dispatchDuePatchPolicies uses for its own
    // targeted devices (the device may have been reassigned/deleted/revoked
    // since the config was saved).
    const probe = await db.select({ id: schema.devices.id, status: schema.devices.status, companyId: schema.devices.companyId })
      .from(schema.devices).where(eq(schema.devices.id, config.probeDeviceId)).get();
    if (!probe || probe.status !== 'approved' || probe.companyId !== config.companyId) continue;

    const credentials = await resolveDiscoveryCredentials(DB, configEncryptionKey, config.companyId, config.snmpEnabled, config.sshEnabled);

    const scanId = crypto.randomUUID();
    await db.insert(schema.commands).values({
      id: scanId,
      deviceId: config.probeDeviceId,
      companyId: config.companyId,
      type: 'network_scan',
      payload: await signCommandPayload(scanId, config.probeDeviceId, { cidr_ranges: JSON.parse(config.cidrRanges), ...credentials }, configEncryptionKey),
      status: 'queued',
      createdAt: now,
    });
    await db.update(schema.networkDiscoveryConfigs).set({ lastScannedAt: now }).where(eq(schema.networkDiscoveryConfigs.id, config.id));

    // Layer-2 call -- runs from the scheduled() cron, never a
    // user-authenticated HTTP route.
    await logActivity(db, {
      actorType: 'system', category: 'Network Discovery', action: 'Dispatched scan',
      entityType: 'networkDiscoveryConfig', entityId: config.id, companyId: config.companyId, method: 'CRON',
    });
  }
}

// ── Manual scan-now dispatch ─────────────────────────────────────────────────
// Shares the same credential-resolution logic as the cron path above --
// exported so worker/src/routes/admin/companies.ts's scan-now route can
// build an identical payload rather than re-deriving it.
export async function buildDiscoveryScanPayload(
  DB: D1Database, configEncryptionKey: string, config: typeof schema.networkDiscoveryConfigs.$inferSelect,
): Promise<string> {
  const credentials = await resolveDiscoveryCredentials(DB, configEncryptionKey, config.companyId, config.snmpEnabled, config.sshEnabled);
  return JSON.stringify({ cidr_ranges: JSON.parse(config.cidrRanges), ...credentials });
}

// ── Upsert a scan result's hosts ─────────────────────────────────────────────
// Called from checkin.ts when a network_scan command completes. Check-then-
// insert-or-update, not an ON CONFLICT upsert -- matches the established
// convention elsewhere (device custom-field values, patch approvals).
export interface DiscoveredHost {
  ip: string;
  mac?: string;
  hostname?: string;
  // Credentialed Network Discovery (issue #78) -- all optional, only
  // present when the corresponding probe actually found something.
  open_ports?: number[];
  snmp_sys_descr?: string;
  snmp_sys_name?: string;
  ssh_banner?: string;
  ssh_os_info?: string;
}

export async function recordDiscoveredHosts(db: Db, companyId: string, hosts: DiscoveredHost[], now: number): Promise<void> {
  for (const host of hosts) {
    const existing = await db.select({
      id: schema.discoveredDevices.id, timesSeen: schema.discoveredDevices.timesSeen,
      macAddress: schema.discoveredDevices.macAddress, hostname: schema.discoveredDevices.hostname,
      openPorts: schema.discoveredDevices.openPorts, snmpSysDescr: schema.discoveredDevices.snmpSysDescr,
      snmpSysName: schema.discoveredDevices.snmpSysName, sshBanner: schema.discoveredDevices.sshBanner,
      sshOsInfo: schema.discoveredDevices.sshOsInfo,
    })
      .from(schema.discoveredDevices)
      .where(and(eq(schema.discoveredDevices.companyId, companyId), eq(schema.discoveredDevices.ipAddress, host.ip)))
      .get();

    // A scan that doesn't resolve a given field this time (e.g. an ARP
    // cache miss, or this particular scan had no credentials configured)
    // shouldn't blank out a value a previous scan already found -- only
    // overwrite when this scan actually found something, same rule for
    // every field here, not just mac/hostname.
    if (existing) {
      await db.update(schema.discoveredDevices).set({
        macAddress: host.mac ?? existing.macAddress,
        hostname: host.hostname ?? existing.hostname,
        openPorts: host.open_ports ? JSON.stringify(host.open_ports) : existing.openPorts,
        snmpSysDescr: host.snmp_sys_descr ?? existing.snmpSysDescr,
        snmpSysName: host.snmp_sys_name ?? existing.snmpSysName,
        sshBanner: host.ssh_banner ?? existing.sshBanner,
        sshOsInfo: host.ssh_os_info ?? existing.sshOsInfo,
        lastSeenAt: now,
        timesSeen: existing.timesSeen + 1,
      }).where(eq(schema.discoveredDevices.id, existing.id));
    } else {
      await db.insert(schema.discoveredDevices).values({
        id: crypto.randomUUID(),
        companyId,
        ipAddress: host.ip,
        macAddress: host.mac ?? null,
        hostname: host.hostname ?? null,
        openPorts: host.open_ports ? JSON.stringify(host.open_ports) : null,
        snmpSysDescr: host.snmp_sys_descr ?? null,
        snmpSysName: host.snmp_sys_name ?? null,
        sshBanner: host.ssh_banner ?? null,
        sshOsInfo: host.ssh_os_info ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        timesSeen: 1,
      });
    }
  }
}
