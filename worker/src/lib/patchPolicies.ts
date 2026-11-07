import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { fetchDeviceGroupIds } from './alerts';
import { logActivity } from './activityLog';
import { signCommandPayload } from './gptBridge';

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Device = typeof schema.devices.$inferSelect;
type PatchPolicy = typeof schema.patchPolicies.$inferSelect;

// ── Recurrence evaluation ──────────────────────────────────────────────────
// Verbatim duplicate of lib/maintenance.ts's isMaintenanceWindowActive and
// its helpers, retyped against patchPolicies -- not shared, same
// per-policy-type mirroring convention every other policy type in this
// codebase already follows (see maintenancePolicyCompanies' own comment).

const WEEK_MINUTES = 7 * 1440;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function wallClockParts(unixSeconds: number, timeZone: string): { weekdayIdx: number; minutesSinceMidnight: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unixSeconds * 1000));
  const weekday = parts.find(p => p.type === 'weekday')!.value;
  const hour   = Number(parts.find(p => p.type === 'hour')!.value) % 24;
  const minute = Number(parts.find(p => p.type === 'minute')!.value);
  return { weekdayIdx: WEEKDAY_INDEX[weekday], minutesSinceMidnight: hour * 60 + minute };
}

function inCyclicRange(x: number, start: number, end: number): boolean {
  return (x >= start && x < end) || (x + WEEK_MINUTES >= start && x + WEEK_MINUTES < end);
}

export function isPatchWindowActive(policy: PatchPolicy, hostTimezone: string, now: number): boolean {
  if (policy.recurrenceType === 'one_time') {
    if (policy.oneTimeStartAt == null || policy.oneTimeDurationMinutes == null) return false;
    const end = policy.oneTimeStartAt + policy.oneTimeDurationMinutes * 60;
    return now >= policy.oneTimeStartAt && now < end;
  }

  if (!policy.weeklyDays || policy.weeklyStartMinute == null || policy.weeklyDurationMinutes == null) return false;
  const days = JSON.parse(policy.weeklyDays) as number[];
  if (days.length === 0) return false;

  const { weekdayIdx, minutesSinceMidnight } = wallClockParts(now, hostTimezone);
  const nowWeekMinutes = weekdayIdx * 1440 + minutesSinceMidnight;

  return days.some(d => {
    const windowStart = d * 1440 + policy.weeklyStartMinute!;
    const windowEnd   = windowStart + policy.weeklyDurationMinutes!;
    return inCyclicRange(nowWeekMinutes, windowStart, windowEnd);
  });
}

// windowDurationSeconds: the policy's own configured duration, used by
// dispatchDuePatchPolicies to avoid re-dispatching within one continuous
// active occurrence (see that function's own comment for why this is
// simpler than computing an exact window-start timestamp).
function windowDurationSeconds(policy: PatchPolicy): number {
  const minutes = policy.recurrenceType === 'one_time' ? policy.oneTimeDurationMinutes : policy.weeklyDurationMinutes;
  return (minutes ?? 0) * 60;
}

// ── Auto-Approval classifications ───────────────────────────────────────────
// Windows Update's real organizing taxonomy (confirmed against Microsoft's
// own WSUS Classification GUID docs), not an MSRC severity scale -- severity
// is only meaningfully populated for Security-Updates-classified patches.
// Definition Updates deliberately excluded -- already filtered client-side
// in agent/internal/audit/patches.go before a patch is ever stored, so it'd
// never appear here anyway.
//
// Trimmed to just these two (a wider 7-classification list shipped
// initially, then cut back) -- confirmed via further research that
// Critical Updates, Feature Packs, Service Packs, Tools, and plain
// "Updates" are all effectively obsolete on any Windows 10 1903+ / current
// Server device: Microsoft stopped populating Critical Updates in 1903,
// consolidating almost everything into Security Updates instead, and
// Feature Packs/Service Packs predate the Windows-as-a-service model
// entirely. Keeping dead options in the checklist is pure noise, not
// forward-compatible completeness -- narrower is more honest about what
// actually shows up on real fleet data.
export const AUTO_APPROVE_CLASSIFICATIONS = [
  'Security Updates', 'Update Rollups',
] as const;

// ── Targeting (exact mirror of lib/maintenance.ts's Companies/Devices/Groups
// OR-list machinery, retyped -- duplicated, not shared) ────────────────────

// Exported: reused by windowsUpdateManagement.ts for its own coverage check
// (does an enabled, opted-in policy target this device at all), which needs
// the exact same targeting machinery but evaluated independent of window-
// active state.
export async function fetchEnabledPatchPolicies(db: Db): Promise<PatchPolicy[]> {
  return db.select().from(schema.patchPolicies).where(eq(schema.patchPolicies.enabled, true));
}

export async function fetchPatchPolicyCompanyIds(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await db.select().from(schema.patchPolicyCompanies);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.policyId)) out.set(r.policyId, new Set());
    out.get(r.policyId)!.add(r.companyId);
  }
  return out;
}

export async function fetchPatchPolicyDeviceIds(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await db.select().from(schema.patchPolicyDevices);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.policyId)) out.set(r.policyId, new Set());
    out.get(r.policyId)!.add(r.deviceId);
  }
  return out;
}

export async function fetchPatchPolicyGroupIds(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await db.select().from(schema.patchPolicyGroups);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.policyId)) out.set(r.policyId, new Set());
    out.get(r.policyId)!.add(r.groupId);
  }
  return out;
}

// Company-wide blanket veto -- exported for the same "fetch once per
// invocation, never per device" reason every other fetch* helper here is.
// windowsUpdateManagement.ts reuses this too, so a company opted out of
// Patch Policy coverage is automatically opted out of AU takeover as well,
// with no extra code needed there.
export async function fetchExcludedCompanyIds(db: Db): Promise<Set<string>> {
  const rows = await db.select({ id: schema.companies.id })
    .from(schema.companies).where(eq(schema.companies.patchManagementExcluded, true));
  return new Set(rows.map(r => r.id));
}

export function deviceMatchesPatchPolicy(
  p: PatchPolicy,
  device: Device,
  deviceGroupIds: Set<string>,
  policyGroupIds: Map<string, Set<string>>,
  policyCompanyIds: Map<string, Set<string>>,
  policyDeviceIds: Map<string, Set<string>>,
  excludedCompanyIds: Set<string>,
): boolean {
  // Company-wide veto short-circuits everything else -- a company opted
  // out of patch management entirely (e.g. it manages Windows Update via
  // its own WSUS) shouldn't be pulled back in by an unrestricted global
  // policy, an explicit device-level target, or anything else. No
  // per-policy override of this -- see the migration's own comment for why
  // this is a blanket flag, not a per-policy exclusion list.
  if (excludedCompanyIds.has(device.companyId)) return false;

  const companies   = policyCompanyIds.get(p.id);
  const devices = policyDeviceIds.get(p.id);
  const groups  = policyGroupIds.get(p.id);

  const matchesDevice = devices?.has(device.id) ?? false;
  const matchesGroup  = groups ? [...groups].some(gid => deviceGroupIds.has(gid)) : false;

  // Hyper-V *server* hosts are never swept in automatically by a
  // Server-class or company-wide target -- no opt-out toggle, confirmed via
  // AskUserQuestion (real operational experience: nobody wants an RMM
  // auto-rebooting a production hypervisor host without first checking
  // cluster/maintenance-mode state or migrating VMs off it). The only way
  // to patch one through Beacon is a policy that explicitly Device- or
  // Group-targets it -- a deliberately curated selection, unlike
  // company-wide targeting, which is just as much an unattended sweep as
  // the class-based default. This check must run before the class check
  // below, since it's meant to override it, not be gated behind it.
  //
  // Deliberately scoped to a genuine Server-family install, not just "the
  // Hyper-V feature is present" -- found live: isHyperVHost alone also
  // matches an ordinary Windows Client desktop running Hyper-V locally
  // (WSL2, Docker Desktop, local dev VMs), a materially different risk
  // profile that was silently going unpatched fleet-wide with no way to
  // override it short of an explicit Device/Group target. windowsInstallationType
  // being null (not yet audited since this shipped, same tri-state as
  // isHyperVHost itself) keeps the conservative pre-existing behavior --
  // exclude until a fresh audit positively confirms it's a Client install.
  const knownClientOS = device.windowsInstallationType === 'Client';
  if (device.isHyperVHost && !knownClientOS && !matchesDevice && !matchesGroup) return false;

  // Class check is ANDed with the OR-list below, same relationship
  // policies.targetClass has with its own Companies/Devices/Groups OR-list
  // (see alerts.ts's deviceMatchesPolicy) -- a device must be in-class AND
  // match at least one target (or targeting is empty/unrestricted).
  const targetClass = JSON.parse(p.targetClass) as string[];
  const devClass = device.overrideClass ?? device.detectedClass;
  const classOk = targetClass.length === 0 || (devClass ? targetClass.includes(devClass) : false);
  if (!classOk) return false;

  const total = (companies?.size ?? 0) + (devices?.size ?? 0) + (groups?.size ?? 0);
  if (total === 0) return true; // unrestricted — matches every device

  const matchesCompany = companies?.has(device.companyId) ?? false;
  return matchesCompany || matchesDevice || matchesGroup;
}

// Single-device coverage check for whether driver-type patches should be
// kept when storing this device's audit -- called from audit.ts's ingest
// handler (one device at a time), unlike the bulk per-tick helpers above.
// Cheap enough at self-hosted scale to run per-audit (same reasoning
// "full-table scan is fine at this scale" already used elsewhere in this
// codebase) rather than threading a new field through the check-in wire
// protocol or building agent-side persisted config for it.
export async function deviceHasDriverVisibility(db: Db, device: Device): Promise<boolean> {
  const policies = await fetchEnabledPatchPolicies(db);
  const managing = policies.filter(p => p.includeDrivers);
  if (managing.length === 0) return false;

  const [policyCompanyIds, policyDeviceIds, policyGroupIds, excludedCompanyIds, deviceGroupIds] = await Promise.all([
    fetchPatchPolicyCompanyIds(db),
    fetchPatchPolicyDeviceIds(db),
    fetchPatchPolicyGroupIds(db),
    fetchExcludedCompanyIds(db),
    fetchDeviceGroupIds(db, [device.id]),
  ]);

  return managing.some(p => deviceMatchesPatchPolicy(
    p, device, deviceGroupIds.get(device.id) ?? new Set(), policyGroupIds, policyCompanyIds, policyDeviceIds, excludedCompanyIds));
}

// ── Fleet patch scan (exact two-phase pattern GET /v1/admin/patches already
// uses: scan every approved device's latest audit, group by update_id, then
// overlay patch_approvals) -- shared here since both auto-approval and
// dispatch eligibility need the same "who has what pending" answer. ────────

interface AuditPatchItem {
  update_id?: string;
  title: string;
  kb_article_ids: string[];
  severity: string;
  categories: string[];
  type?: string; // 'software'|'driver' -- absent on pre-upgrade agents
}

export interface FleetPatchState {
  updateId: string;
  severity: string;
  categories: string[];
  type: string; // 'software'|'driver'; defaults to 'software' for pre-upgrade agent data
  deviceIds: string[]; // devices with this update currently pending
  status: 'pending' | 'approved' | 'ignored';
}

export async function scanFleetPatches(db: Db, devices: { id: string }[]): Promise<Map<string, FleetPatchState>> {
  const byUpdateId = new Map<string, FleetPatchState>();

  for (const device of devices) {
    const audit = await db.select({ patches: schema.deviceAudits.patches })
      .from(schema.deviceAudits)
      .where(and(eq(schema.deviceAudits.deviceId, device.id), isNotNull(schema.deviceAudits.patches)))
      .orderBy(desc(schema.deviceAudits.createdAt))
      .limit(1)
      .get();
    if (!audit?.patches) continue;

    let items: AuditPatchItem[];
    try {
      items = JSON.parse(audit.patches);
    } catch {
      continue;
    }

    for (const item of items) {
      if (!item.update_id) continue; // pre-upgrade agent -- needs a rescan, same as GET /v1/admin/patches
      let entry = byUpdateId.get(item.update_id);
      if (!entry) {
        entry = { updateId: item.update_id, severity: item.severity, categories: item.categories ?? [], type: item.type ?? 'software', deviceIds: [], status: 'pending' };
        byUpdateId.set(item.update_id, entry);
      }
      entry.deviceIds.push(device.id);
    }
  }

  if (byUpdateId.size > 0) {
    const approvals = await db.select().from(schema.patchApprovals).all();
    for (const a of approvals) {
      const entry = byUpdateId.get(a.updateId);
      if (entry) entry.status = a.status as 'approved' | 'ignored';
    }
  }

  return byUpdateId;
}

// ── Auto-approval ────────────────────────────────────────────────────────
// Fleet-wide, same as manual approval (patch_approvals has no per-device
// concept) -- a policy's classification set, matched by a patch anywhere in
// the fleet, approves it globally, reusing the exact upsert shape
// PATCH /v1/admin/patches/:updateId already uses. The policy's own
// targeting only controls which devices receive the resulting *install*
// (see dispatchDuePatchPolicies), not which patches get approved.
export async function autoApprovePatches(db: Db, now: number): Promise<void> {
  const policies = await fetchEnabledPatchPolicies(db);
  const rules = policies
    .map(p => ({ policy: p, classifications: JSON.parse(p.autoApproveClassifications) as string[] }))
    .filter(r => r.classifications.length > 0);
  if (rules.length === 0) return;

  const devices = await db.select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.status, 'approved'))
    .all();
  const fleet = await scanFleetPatches(db, devices);

  for (const patch of fleet.values()) {
    if (patch.status !== 'pending') continue;
    // Drivers are never auto-approved, full stop -- Category and Type are
    // independent WUA properties, so a driver update's own categories could
    // in principle still overlap a policy's classification list (e.g. some
    // driver happens to carry a "Security Updates" category) without this
    // explicit check. Confirmed via AskUserQuestion: drivers stay
    // manual-approval-only regardless of any Auto-Approval setting, since a
    // bad driver can break hardware/boot in a way a bad software patch
    // usually can't.
    if (patch.type === 'driver') continue;
    const meetsAnyRule = rules.some(r => patch.categories.some(c => r.classifications.includes(c)));
    if (!meetsAnyRule) continue;

    // Check-then-insert, not an ON CONFLICT upsert -- matches the
    // established convention elsewhere in this codebase (e.g. the device
    // custom-field-value upsert). patch.status === 'pending' above already
    // means scanFleetPatches found no existing row for this updateId as of
    // this invocation, but re-check right before inserting as a narrow
    // defense against a race with a concurrent manual approval.
    const existing = await db.select({ updateId: schema.patchApprovals.updateId })
      .from(schema.patchApprovals).where(eq(schema.patchApprovals.updateId, patch.updateId)).get();
    if (existing) continue;

    await db.insert(schema.patchApprovals).values({
      updateId: patch.updateId,
      status: 'approved',
      title: '', // best-effort snapshot; GET /v1/admin/patches always re-derives title live from the fleet scan anyway
      kbArticleIds: '[]',
      severity: patch.severity,
      updatedAt: now,
    });
    // Layer-2 call -- runs from the scheduled() cron, never a user-authenticated
    // HTTP route. Kept distinct from dispatchDuePatchPolicies' own call below --
    // "a patch was auto-approved" and "a policy dispatched installs" are two
    // separate facts an operator would want told apart.
    await logActivity(db, {
      actorType: 'system', category: 'Patch', action: 'Auto-approved patch',
      entityType: 'patch', entityId: patch.updateId, method: 'CRON',
      details: { severity: patch.severity, categories: patch.categories },
    });
  }
}

// ── Scheduled dispatch ──────────────────────────────────────────────────────
// The active-cron-dispatch half Maintenance Policy's passive suppression
// gate doesn't need -- closer to Jobs' dispatchDueScheduledJobs shape. Jobs'
// own NOT EXISTS (SELECT 1 FROM commands WHERE job_id = j.id) idiom is
// one-shot-only and doesn't generalize to a *recurring* weekly window --
// see the re-dispatch guard below instead.
export async function dispatchDuePatchPolicies(DB: D1Database, now: number, configEncryptionKey?: string): Promise<void> {
  const db = drizzle(DB, { schema });
  if (!configEncryptionKey) return; // cannot sign install_patches without the key: fail closed

  await autoApprovePatches(db, now);

  const policies = await fetchEnabledPatchPolicies(db);
  if (policies.length === 0) return;

  const row = await db.select({ timezone: schema.hostSettings.timezone })
    .from(schema.hostSettings).where(eq(schema.hostSettings.id, 1)).get();
  const hostTimezone = row?.timezone ?? 'UTC';

  // A continuous active stretch can't outlast its own configured duration,
  // so "last dispatch was more than this window's duration ago" is enough
  // to guarantee exactly one dispatch per occurrence without computing an
  // exact window-start timestamp -- re-arms correctly once the window goes
  // inactive and later recurs.
  const due = policies.filter(p => {
    if (!isPatchWindowActive(p, hostTimezone, now)) return false;
    if (p.lastDispatchedAt == null) return true;
    return now > p.lastDispatchedAt + windowDurationSeconds(p);
  });
  if (due.length === 0) return;

  const [policyCompanyIds, policyDeviceIds, policyGroupIds, excludedCompanyIds, devices] = await Promise.all([
    fetchPatchPolicyCompanyIds(db),
    fetchPatchPolicyDeviceIds(db),
    fetchPatchPolicyGroupIds(db),
    fetchExcludedCompanyIds(db),
    db.select().from(schema.devices).where(eq(schema.devices.status, 'approved')).all(),
  ]);
  const deviceGroupIds = await fetchDeviceGroupIds(db, devices.map(d => d.id));
  const fleet = await scanFleetPatches(db, devices);

  for (const policy of due) {
    const targeted = devices.filter(d =>
      deviceMatchesPatchPolicy(policy, d, deviceGroupIds.get(d.id) ?? new Set(), policyGroupIds, policyCompanyIds, policyDeviceIds, excludedCompanyIds));

    let dispatchedCount = 0;
    for (const device of targeted) {
      const eligible = [...fleet.values()]
        .filter(patch => patch.status === 'approved' && patch.deviceIds.includes(device.id))
        .map(patch => patch.updateId);
      if (eligible.length === 0) continue;

      const patchCmdId = crypto.randomUUID();
      await db.insert(schema.commands).values({
        id: patchCmdId,
        deviceId: device.id,
        companyId: device.companyId,
        type: 'install_patches',
        payload: await signCommandPayload(patchCmdId, device.id, { update_ids: eligible, auto_reboot: policy.autoReboot }, configEncryptionKey),
        status: 'queued',
        createdAt: now,
      });
      dispatchedCount++;
    }

    await db.update(schema.patchPolicies).set({ lastDispatchedAt: now }).where(eq(schema.patchPolicies.id, policy.id));

    // Layer-2 call, only when this policy actually dispatched to ≥1 device --
    // a policy whose window is active but has nothing eligible right now
    // isn't a real, log-worthy event.
    if (dispatchedCount > 0) {
      await logActivity(db, {
        actorType: 'system', category: 'Patch Policy', action: 'Dispatched patch installs',
        entityType: 'patchPolicy', entityId: policy.id, method: 'CRON',
        details: { deviceCount: dispatchedCount },
      });
    }
  }
}

// ── Admin CRUD support ──────────────────────────────────────────────────────

export async function copyPatchPolicyTargets(DB: D1Database, sourcePolicyId: string, newPolicyId: string, now: number): Promise<void> {
  const db = drizzle(DB, { schema });
  const [companies, devices, groups] = await Promise.all([
    db.select().from(schema.patchPolicyCompanies).where(eq(schema.patchPolicyCompanies.policyId, sourcePolicyId)),
    db.select().from(schema.patchPolicyDevices).where(eq(schema.patchPolicyDevices.policyId, sourcePolicyId)),
    db.select().from(schema.patchPolicyGroups).where(eq(schema.patchPolicyGroups.policyId, sourcePolicyId)),
  ]);
  await Promise.all([
    ...companies.map(s => db.insert(schema.patchPolicyCompanies).values({ policyId: newPolicyId, companyId: s.companyId, createdAt: now })),
    ...devices.map(d => db.insert(schema.patchPolicyDevices).values({ policyId: newPolicyId, deviceId: d.deviceId, createdAt: now })),
    ...groups.map(g => db.insert(schema.patchPolicyGroups).values({ policyId: newPolicyId, groupId: g.groupId, createdAt: now })),
  ]);
}
