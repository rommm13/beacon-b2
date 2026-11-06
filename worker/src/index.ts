import { Hono } from 'hono';
import { cors } from 'hono/cors';
import enroll from './routes/enroll';
import checkin from './routes/checkin';
import auditRoute from './routes/audit';
import sessions from './routes/sessions';
import agentUpdate from './routes/agent-update';
import adminSummary from './routes/admin/summary';
import adminCompanies from './routes/admin/companies';
import adminDevices from './routes/admin/devices';
import adminCommands from './routes/admin/commands';
import adminPolicies from './routes/admin/policies';
import adminAlerts from './routes/admin/alerts';
import adminWebhooks from './routes/admin/webhooks';
import adminAgentVersions from './routes/admin/agent-versions';
import adminComponents from './routes/admin/components';
import adminJobs from './routes/admin/jobs';
import authRoute from './routes/auth';
import authMicrosoft from './routes/auth-microsoft';
import adminUsers from './routes/admin/users';
import adminSso from './routes/admin/sso';
import adminCustomFields from './routes/admin/custom-fields';
import adminGroups from './routes/admin/groups';
import adminDashboards from './routes/admin/dashboards';
import adminMaintenancePolicies from './routes/admin/maintenance-policies';
import adminSettings from './routes/admin/settings';
import adminEmailSettings from './routes/admin/email-settings';
import adminNotificationEmails from './routes/admin/notification-emails';
import adminPatches from './routes/admin/patches';
import adminPatchPolicies from './routes/admin/patch-policies';
import adminActivityLog from './routes/admin/activity-log';
import adminReports from './routes/admin/reports';
import adminRustdeskSettings from './routes/admin/rustdesk-settings';
import branding from './routes/branding';
import componentFiles from './routes/component-files';
import rustdeskInstallerDownload from './routes/rustdesk-installer-download';
import rustdeskPassword from './routes/rustdesk-password';
import { activityLogMiddleware } from './lib/activityLog';
import { timingSafeEqual } from './lib/auth';
import { runScheduledMaintenance } from './lib/scheduled-maintenance';
import { resolveStorage, type AnyStorage, type B2Env } from './lib/storage';

export { SessionRelay } from './durable-objects/session-relay';

export type Bindings = {
  DB: D1Database;
  ADMIN_SECRET: string;
  SESSION: DurableObjectNamespace;
  // Production dashboard origin, e.g. "https://rmm.example.com"
  ALLOWED_ORIGIN?: string;
  // Cloudflare Pages preview URL suffix, e.g. ".my-dashboard-1a2.pages.dev"
  PAGES_PREVIEW_SUFFIX?: string;
  // AES-GCM key (hex) for encrypting SSO provider client secrets at rest
  CONFIG_ENCRYPTION_KEY: string;
  // Optional shared secret for a trusted hosted scheduler. Unset for ordinary
  // self-hosted Beacon installations, where only the native Cron Trigger runs
  // scheduled maintenance.
  INTERNAL_SCHEDULER_SECRET?: string;
  // This worker's own public origin, e.g. "https://rmm-api.example.com" —
  // used to build absolute agent/client WebSocket URLs in sessions.ts.
  // Deliberately a configured value, not derived from the incoming request's
  // own URL: a [[routes]] custom-domain block in wrangler.toml can make
  // c.req.url reflect the production route even under `wrangler dev`,
  // which previously sent local-dev sessions to the real production worker.
  WORKER_URL: string;
  // Stores host-uploaded branding logos (R2 fallback when B2 not configured)
  LOGOS?: R2Bucket;
  // Private MSI installers and support files for Application Components.
  COMPONENT_FILES?: R2Bucket;
  // Private, short-lived Web Remote file-transfer uploads/downloads (see
  // routes/sessions.ts's .../files routes and migration 0080) -- separate
  // bucket from COMPONENT_FILES since these objects are transient
  // per-session transfers, not durable component assets, and never need
  // its retention/versioning story.
  SESSION_FILES?: R2Bucket;
  // Backblaze B2 (S3-compatible) storage vars. When B2 application key id/key
  // + B2_ENDPOINT + per-bucket name are present, B2 is preferred over R2 fallback.
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  /** Alias for compatibility with routes using the alternate binding name. */
  B2_APPLICATION_KEY_ID?: string;
  B2_BUCKET?: string;
  B2_BUCKET_LOGOS?: string;
  B2_BUCKET_COMPONENT_FILES?: string;
  B2_BUCKET_SESSION_FILES?: string;
  B2_ENDPOINT?: string;
  B2_REGION?: string;
  B2_PRESIGN_EXPIRES_SECONDS?: string;
};

function b2EnvFor(env: Bindings, bucket: string | undefined): Partial<B2Env> | undefined {
  if (!bucket) return undefined;
  return {
    B2_KEY_ID: env.B2_KEY_ID ?? env.B2_APPLICATION_KEY_ID,
    B2_APPLICATION_KEY: env.B2_APPLICATION_KEY,
    B2_BUCKET: bucket,
    B2_ENDPOINT: env.B2_ENDPOINT,
  };
}

export function resolveLogosStorage(env: Bindings): AnyStorage {
  return resolveStorage({ b2: b2EnvFor(env, env.B2_BUCKET_LOGOS ?? env.B2_BUCKET), r2: env.LOGOS });
}

export function resolveComponentFilesStorage(env: Bindings): AnyStorage {
  return resolveStorage({ b2: b2EnvFor(env, env.B2_BUCKET_COMPONENT_FILES ?? env.B2_BUCKET), r2: env.COMPONENT_FILES });
}

export function resolveSessionFilesStorage(env: Bindings): AnyStorage {
  return resolveStorage({ b2: b2EnvFor(env, env.B2_BUCKET_SESSION_FILES ?? env.B2_BUCKET), r2: env.SESSION_FILES });
}

const app = new Hono<{ Bindings: Bindings }>();

const corsMiddleware = (c: any, next: any) => cors({
  origin: (origin) => {
    if (!origin) return '';
    if (
      origin === c.env.ALLOWED_ORIGIN ||
      origin === 'http://localhost:5173' ||
      (c.env.PAGES_PREVIEW_SUFFIX && origin.endsWith(c.env.PAGES_PREVIEW_SUFFIX))
    ) return origin;
    return '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-File-Name', 'X-File-SHA256', 'X-File-Architecture', 'X-File-Size'],
})(c, next);

app.use('/v1/admin/*', corsMiddleware);
app.use('/v1/auth/*', corsMiddleware);
app.use('/v1/sessions', corsMiddleware);
app.use('/v1/sessions/*', corsMiddleware);
app.use('/v1/branding/*', corsMiddleware);

// Registered before the app.route() mounts below, same ordering corsMiddleware
// already uses for these same five prefix families -- Hono composes matched
// layers in registration order, so this must be registered first to actually
// wrap the route handlers. See lib/activityLog.ts for what this logs and why.
app.use('/v1/admin/*', activityLogMiddleware);
app.use('/v1/auth/*', activityLogMiddleware);
app.use('/v1/sessions', activityLogMiddleware);
app.use('/v1/sessions/*', activityLogMiddleware);
app.use('/v1/branding/*', activityLogMiddleware);

app.route('/v1/enroll', enroll);
app.route('/v1/check-in', checkin);
app.route('/v1/audit', auditRoute);
app.route('/v1/sessions', sessions);
app.route('/v1/agent', agentUpdate);
app.route('/v1/branding', branding);
app.route('/v1/component-files', componentFiles);
app.route('/v1/rustdesk-installer', rustdeskInstallerDownload);
app.route('/v1/rustdesk-password', rustdeskPassword);
app.route('/v1/admin/summary', adminSummary);
app.route('/v1/admin/companies', adminCompanies);
app.route('/v1/admin/devices', adminDevices);
app.route('/v1/admin/commands', adminCommands);
app.route('/v1/admin/policies', adminPolicies);
app.route('/v1/admin/alerts', adminAlerts);
app.route('/v1/admin/webhooks', adminWebhooks);
app.route('/v1/admin/email-settings', adminEmailSettings);
app.route('/v1/admin/notification-emails', adminNotificationEmails);
app.route('/v1/admin/agent/versions', adminAgentVersions);
app.route('/v1/admin/components', adminComponents);
app.route('/v1/admin/jobs', adminJobs);
app.route('/v1/admin/users', adminUsers);
app.route('/v1/admin/sso', adminSso);
app.route('/v1/admin/custom-fields', adminCustomFields);
app.route('/v1/admin/groups', adminGroups);
app.route('/v1/admin/dashboards', adminDashboards);
app.route('/v1/admin/maintenance-policies', adminMaintenancePolicies);
app.route('/v1/admin/patches', adminPatches);
app.route('/v1/admin/patch-policies', adminPatchPolicies);
app.route('/v1/admin/activity-log', adminActivityLog);
app.route('/v1/admin/reports', adminReports);
app.route('/v1/admin/settings', adminSettings);
app.route('/v1/admin/rustdesk-settings', adminRustdeskSettings);
app.route('/v1/auth', authRoute);
app.route('/v1/auth/microsoft', authMicrosoft);

app.get('/health', (c) => c.json({ ok: true }));

// This route is intentionally outside /v1: it is not a dashboard or agent
// API. A hosted control plane can invoke Beacon's normal periodic work through
// an internal Worker-to-Worker request when per-instance Cron Triggers are not
// available. The route does not exist unless a host explicitly configures its
// secret, and it accepts neither user sessions nor ADMIN_SECRET.
app.post('/internal/scheduled', async (c) => {
  const secret = c.env.INTERNAL_SCHEDULER_SECRET;
  const provided = c.req.header('X-Beacon-Scheduler-Secret');
  if (!secret || !provided || !(await timingSafeEqual(provided, secret))) {
    return c.body(null, 404);
  }
  await runScheduledMaintenance(c.env);
  return c.body(null, 204);
});

export default {
  fetch(req: Request, env: Bindings) {
    return app.fetch(req, env);
  },
  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    await runScheduledMaintenance(env);
  },
};
