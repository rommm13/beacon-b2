import type { Bindings } from '../index';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { evaluateOfflineAlerts } from './alerts';
import { dispatchDuePatchPolicies } from './patchPolicies';
import { dispatchDueDiscoveryScans } from './discovery';
import { syncWindowsUpdateManagement } from './windowsUpdateManagement';
import { syncMicrosoftUpdateManagement } from './microsoftUpdateManagement';
import { pruneActivityLog } from './activityLog';
import { dispatchDueScheduledJobs, cancelExpiredScheduledJobs } from '../routes/admin/jobs';
import { gptBridgeSweep } from './gptBridge';

// Keep all periodic maintenance behind one entry point. Standalone Beacon
// invokes this from its native Cron Trigger; a hosted control plane may invoke
// the same function through the narrowly-scoped internal scheduler route.
export async function runScheduledMaintenance(env: Bindings, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await evaluateOfflineAlerts(env.DB, env, now);
  await dispatchDueScheduledJobs(env.DB, env.CONFIG_ENCRYPTION_KEY, now);
  await cancelExpiredScheduledJobs(env.DB, now);
  await dispatchDuePatchPolicies(env.DB, now);
  await syncWindowsUpdateManagement(env.DB, now);
  await syncMicrosoftUpdateManagement(env.DB, now);
  await dispatchDueDiscoveryScans(env.DB, env.CONFIG_ENCRYPTION_KEY, now);
  await pruneActivityLog(env.DB, now);
  await gptBridgeSweep(drizzle(env.DB, { schema }), now);
}
