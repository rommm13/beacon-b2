import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  autoApproveDefault: integer('auto_approve_default', { mode: 'boolean' }).notNull().default(true),
  privacyModeDefault: integer('privacy_mode_default', { mode: 'boolean' }).notNull().default(false),
  // Blanket opt-out from Patch Policy coverage (and Windows Update
  // Management takeover, which shares the same coverage check) -- for a
  // company managing Windows Update its own way (WSUS, etc.) that
  // shouldn't have Beacon's patch policies forced onto it just because an
  // unrestricted global policy targets every device by default.
  patchManagementExcluded: integer('patch_management_excluded', { mode: 'boolean' }).notNull().default(false),
  // Default for whether a Web Remote (screen_share) session requires the
  // end user to Accept/Decline before it connects -- see devices.
  // remoteAccessConsentOverride for the per-device override, and
  // worker/src/routes/sessions.ts's POST / for where the effective value
  // is resolved. Defaults false so nothing changes for an existing company
  // until an admin opts in.
  remoteAccessConsentRequired: integer('remote_access_consent_required', { mode: 'boolean' }).notNull().default(false),
  // Opt-in for the RustDesk "Full Remote Control" tier -- an additional
  // remote tool alongside Web Remote/Remote Shell, installed on-demand per
  // device (see rustdeskSettings below and devices.rustdeskId). Off by
  // default, no per-device override yet.
  rustdeskEnabled: integer('rustdesk_enabled', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
  createdAt: integer('created_at').notNull(),
  // Contact
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  // Business
  website: text('website'),
  notes: text('notes'),
  // Address stored as JSON: { street, city, state, zip, country }
  address: text('address'),
});

export const enrollmentTokens = sqliteTable('enrollment_tokens', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  // SHA-256 of the raw token — never store raw. High-entropy random input
  // makes SHA-256 sufficient here; bcrypt/argon2 not needed.
  tokenHash: text('token_hash').notNull().unique(),
  agentType: text('agent_type', { enum: ['standard', 'discovery_probe'] }).notNull().default('standard'),
  // Nullable — when null, inherits companies.auto_approve_default at enrollment time.
  autoApprove: integer('auto_approve', { mode: 'boolean' }),
  maxUses: integer('max_uses'), // null = unlimited
  useCount: integer('use_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'), // null = never
  revokedAt: integer('revoked_at'), // null = active
  createdBy: text('created_by').notNull(),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  enrollmentTokenId: text('enrollment_token_id').notNull().references(() => enrollmentTokens.id),
  agentType: text('agent_type', { enum: ['standard', 'discovery_probe'] }).notNull().default('standard'),
  deviceCredentialHash: text('device_credential_hash').notNull().unique(),
  status: text('status', { enum: ['pending', 'approved', 'revoked'] }).notNull().default('pending'),
  hostname: text('hostname'),
  osType: text('os_type'),
  osVersion: text('os_version'),
  // Recomputed each check-in from OS edition + WMI enclosure/battery signals.
  detectedClass: text('detected_class', { enum: ['server', 'workstation', 'laptop'] }),
  // Set by a human. Sticky — auto-detection never overwrites this once set.
  // Effective class = overrideClass ?? detectedClass.
  overrideClass: text('override_class', { enum: ['server', 'workstation', 'laptop'] }),
  // NULL = inherit companies.remoteAccessConsentRequired; true/false = an
  // explicit per-device override. Same nullable-override-over-a-company-
  // default shape as overrideClass above.
  remoteAccessConsentOverride: integer('remote_access_consent_override', { mode: 'boolean' }),
  agentVersion: text('agent_version'),
  lastSeen: integer('last_seen'),
  inventory: text('inventory'), // JSON blob — don't normalize until queries require it
  rustdeskId: text('rustdesk_id'), // populated on first on-demand install
  // AES-GCM encrypted unattended-access password, same ciphertext/nonce
  // column-pair shape as companyVariables/emailSettings. Set alongside
  // rustdeskId by an install_rustdesk command; never returned to the
  // dashboard except via the dedicated reveal-password endpoint.
  rustdeskPasswordCiphertext: text('rustdesk_password_ciphertext'),
  rustdeskPasswordNonce: text('rustdesk_password_nonce'),
  // Inherits companies.privacy_mode_default when null. Never silently overwritten.
  privacyModeOverride: integer('privacy_mode_override', { mode: 'boolean' }),
  // Manually-entered — no OS/hardware API exposes OEM warranty status, so
  // there's no agent collector for this the way there is for other System
  // fields. A real auto-lookup would need per-vendor API integrations.
  warrantyExpiresAt: integer('warranty_expires_at'),
  // Captured from the check-in request's own CF-Connecting-IP header — not
  // agent-collected (no agent-side way to learn its own public IP).
  externalIp: text('external_ip'),
  // Maintenance window — alerts are suppressed until this timestamp. Null means
  // not in maintenance. Set via the dashboard; cleared when the window expires
  // or is manually ended.
  maintenanceEndsAt: integer('maintenance_ends_at'),
  maintenanceReason: text('maintenance_reason'),
  // Windows' own Automatic Updates takeover state, driven by an opted-in
  // Patch Policy (see worker/src/lib/windowsUpdateManagement.ts). NULL =
  // never evaluated (non-Windows, or not yet covered by a qualifying
  // policy). windowsUpdatePriorState is a JSON snapshot of the AU registry
  // values from immediately before Beacon's first takeover, used to revert
  // to the device's real prior configuration rather than a guessed default.
  windowsUpdateManaged: integer('windows_update_managed', { mode: 'boolean' }),
  windowsUpdatePriorState: text('windows_update_prior_state'),
  windowsUpdateManagedAt: integer('windows_update_managed_at'),
  // Microsoft Update (Office & other MS products) service-registration
  // takeover, driven by an opted-in Patch Policy (see
  // worker/src/lib/microsoftUpdateManagement.ts) -- independent of the
  // Windows Update Management fields above, same 1:1 shape.
  // microsoftUpdatePriorState is a small JSON snapshot ({was_registered})
  // from immediately before Beacon's first takeover.
  microsoftUpdateManaged: integer('microsoft_update_managed', { mode: 'boolean' }),
  microsoftUpdatePriorState: text('microsoft_update_prior_state'),
  microsoftUpdateManagedAt: integer('microsoft_update_managed_at'),
  // Whether this device has the Hyper-V role/feature installed (a
  // virtualization host, not a guest). NULL = never evaluated (non-Windows,
  // or not yet audited). Drives Patch Policy's automatic exclusion of
  // Hyper-V hosts from a policy's Server-class/company sweep -- see
  // worker/src/lib/patchPolicies.ts's deviceMatchesPatchPolicy.
  isHyperVHost: integer('is_hyper_v_host', { mode: 'boolean' }),
  // Windows Installation Type ("Client"/"Server"/"Server Core"/...), same
  // tri-state (NULL = never evaluated) shape as isHyperVHost. The Hyper-V
  // exclusion above is only meant for a genuine production hypervisor
  // host, not an ordinary Client desktop running Hyper-V locally (WSL2,
  // Docker Desktop, local dev VMs) -- deviceMatchesPatchPolicy ANDs this in
  // to narrow the exclusion to isHyperVHost && windowsInstallationType !==
  // 'Client'.
  windowsInstallationType: text('windows_installation_type'),
  // Fleet-visible pending-reboot state -- set from an install_patches
  // command's reboot_required result, cleared once a later check-in's
  // uptime_seconds shows the device has since restarted. No "never
  // evaluated" tri-state needed (unlike isHyperVHost/windowsUpdateManaged
  // above) -- a device either has a pending reboot or it doesn't.
  pendingRebootRequired: integer('pending_reboot_required', { mode: 'boolean' }).notNull().default(false),
  pendingRebootDetectedAt: integer('pending_reboot_detected_at'),
  // Temporary fast-poll window -- see migrations/0077_fast_poll.sql and
  // worker/src/lib/fastPoll.ts for the full design. NULL = normal 60s
  // check-in cadence.
  fastPollUntil: integer('fast_poll_until'),
  createdAt: integer('created_at').notNull(),
  approvedAt: integer('approved_at'),
});

export const agentVersions = sqliteTable('agent_versions', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  os: text('os').notNull(),   // 'windows' | 'linux' | 'darwin'
  arch: text('arch').notNull(), // 'amd64' | 'arm64'
  downloadUrl: text('download_url').notNull(),
  signatureHex: text('signature_hex').notNull(), // hex-encoded Ed25519 sig over SHA-256 of binary
  publishedAt: integer('published_at').notNull(),
  isLatest: integer('is_latest', { mode: 'boolean' }).notNull().default(false),
});

export const companyContacts = sqliteTable('company_contacts', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  title: text('title'),
  email: text('email'),
  phone: text('phone'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const companyLocations = sqliteTable('company_locations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  street: text('street'),
  city: text('city'),
  state: text('state'),
  zip: text('zip'),
  country: text('country'),
  createdAt: integer('created_at').notNull(),
});

// Global, not per-company (migration 0046 dropped what was then tenant_id) -- the hoster's
// own team reads alerts, not the client company being monitored.
export const webhookEndpoints = sqliteTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

// Standalone alert-notification addresses with no Beacon account (a shared
// mailbox, a ticketing system's inbound address, etc.) -- the other of two
// unioned recipient sources, alongside users.receivesAlerts below.
export const notificationEmails = sqliteTable('notification_emails', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

// Singleton active email provider config, mirrors brandingIdentity's shape.
// configCiphertext holds the entire provider-specific credential blob as one
// AES-GCM JSON string (shape varies by provider, so per-field encryption
// doesn't fit) -- see worker/src/lib/email/.
export const emailSettings = sqliteTable('email_settings', {
  id: integer('id').primaryKey(),
  provider: text('provider', { enum: ['ses', 'resend', 'mailgun'] }),
  fromAddress: text('from_address'),
  configCiphertext: text('config_ciphertext'),
  configNonce: text('config_nonce'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

export const policies = sqliteTable('policies', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull(),
  description: text('description'),
  // Derived, not directly user-set (migration 0032) -- recomputed by
  // recomputePolicyScope in routes/admin/policies.ts after every mutation
  // of policy_companies/policy_devices/policy_groups: 'global' when a policy has
  // zero targets across all three, 'company' when it has 1+. Same pattern
  // components.scope already uses, generalized one level further since this
  // is now derived from three tables' union instead of a single user pick.
  scope:       text('scope', { enum: ['global', 'company'] }).notNull().default('global'),
  // Vestigial as of migration 0032 -- superseded by policy_companies (real
  // multi-company membership). No longer read or written; same fate as
  // components.companyId after migration 0022.
  companyId:   text('company_id').references(() => companies.id),
  enabled:     integer('enabled', { mode: 'boolean' }).notNull().default(true),
  targetOs:    text('target_os').notNull().default('["windows","linux","macos"]'),
  targetClass: text('target_class').notNull().default('["server","workstation","laptop"]'),
  createdAt:   integer('created_at').notNull(),
  updatedAt:   integer('updated_at').notNull(),
});

export const policyMonitors = sqliteTable('policy_monitors', {
  id:                      text('id').primaryKey(),
  policyId:                text('policy_id').notNull().references(() => policies.id),
  checkType:               text('check_type', { enum: ['disk_space', 'offline', 'cpu_usage', 'memory_usage', 'av_status', 'file_size', 'ping', 'process', 'service', 'software', 'windows_update_drift'] }).notNull(),
  enabled:                 integer('enabled', { mode: 'boolean' }).notNull().default(true),
  config:                  text('config').notNull().default('{}'),
  alertPriority:           text('alert_priority', { enum: ['critical', 'high', 'moderate', 'low'] }).notNull().default('high'),
  sustainedMinutes:        integer('sustained_minutes').notNull().default(5),
  checkIntervalMinutes:    integer('check_interval_minutes').notNull().default(1),
  autoResolve:             integer('auto_resolve', { mode: 'boolean' }).notNull().default(true),
  autoResolveAfterMinutes: integer('auto_resolve_after_minutes').notNull().default(60),
  // Per-monitor opt-in for external notifications (migration 0047) --
  // independent of the alert itself firing (always visible in Global
  // Alerts). Default false: notifications only go out when explicitly
  // enabled, not retroactively for existing/seeded monitors.
  notifyWebhook:           integer('notify_webhook', { mode: 'boolean' }).notNull().default(false),
  notifyEmail:             integer('notify_email', { mode: 'boolean' }).notNull().default(false),
  createdAt:               integer('created_at').notNull(),
});

// Policy targeting via Device Groups -- zero rows for a policy means
// unchanged scope/OS/class-only behavior; see deviceMatchesPolicy in
// worker/src/lib/alerts.ts for how this is evaluated.
export const policyGroups = sqliteTable('policy_groups', {
  policyId:  text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  groupId:   text('group_id').notNull().references(() => deviceGroups.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.groupId] })]);

// Multi-company targeting (migration 0032) -- one of three targeting
// dimensions (alongside policyDevices below and policyGroups above), all
// OR'd together in deviceMatchesPolicy (worker/src/lib/alerts.ts): a device
// matches if it satisfies ANY entry across ANY of the three tables. Zero
// rows total = unrestricted, generalizing the "zero policy_groups rows =
// unchanged" precedent to all three kinds. Mirrors policyGroups' exact
// composite-PK shape.
export const policyCompanies = sqliteTable('policy_companies', {
  policyId:  text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  companyId:  text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.companyId] })]);

// Individual-device targeting (migration 0032) -- see policyCompanies above for
// the shared OR-across-three-kinds semantics.
export const policyDevices = sqliteTable('policy_devices', {
  policyId:  text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  deviceId:  text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.deviceId] })]);

export const alertState = sqliteTable('alert_state', {
  id:                 text('id').primaryKey(),
  deviceId:           text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  policyMonitorId:    text('policy_monitor_id').notNull().references(() => policyMonitors.id),
  conditionFirstSeen: integer('condition_first_seen'),
  isAlerting:         integer('is_alerting', { mode: 'boolean' }).notNull().default(false),
  alertedAt:          integer('alerted_at'),
  // Snapshotted from policy_monitors.alert_priority at the moment this alert
  // actually fires (set in lockstep with alertedAt, migration 0048) -- the
  // source of truth for "what severity was this when it fired," since the
  // monitor's own priority can be edited later without retroactively
  // changing history. Nullable/never reset on resolve, same as alertedAt.
  alertPriority:      text('alert_priority', { enum: ['critical', 'high', 'moderate', 'low'] }),
  resolvedAt:         integer('resolved_at'),
  updatedAt:          integer('updated_at').notNull(),
  // Rate-limiting / circuit breaker for flapping monitors (migration 0081,
  // issue #169) -- see worker/src/lib/alerts.ts's computeRateLimit(). A
  // rolling count of notification-worthy transitions within the current
  // window, and the self-expiring mute this row's own webhook/email get
  // suppressed under once that count is exceeded -- mirrors
  // devices.fastPollUntil's "arm to an absolute future timestamp, read live
  // as > now, no cron sweep" convention.
  transitionWindowStartedAt: integer('transition_window_started_at'),
  transitionCount:           integer('transition_count').notNull().default(0),
  notificationsMutedUntil:   integer('notifications_muted_until'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  companyId: text('company_id').notNull().references(() => companies.id),
  sessionType: text('session_type', { enum: ['shell', 'tcp_tunnel', 'screen_share'] }).notNull(),
  tcpPort: integer('tcp_port'), // for tcp_tunnel
  status: text('status', { enum: ['pending', 'active', 'closed'] }).notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  closedAt: integer('closed_at'),
  // sha256hex of a per-session random token — the WS client leg's credential.
  // No longer the shared ADMIN_SECRET, since non-break-glass users don't hold it.
  clientAuthHash: text('client_auth_hash'),
  // sha256hex of a second, separate per-session random token -- checked by
  // POST /v1/sessions/:id/displays (the per-session screen_share helper
  // reporting its enumerated monitors back), not requireUser. Deliberately
  // distinct from clientAuthHash so the real device credential never has
  // to reach the less-trusted interactive-user-session helper process.
  reportTokenHash: text('report_token_hash'),
  // JSON array of {device_name, index, primary, width, height, x, y},
  // reported by the same call above -- read back by
  // GET /v1/sessions/:id/displays for the dashboard's monitor switcher.
  displays: text('displays'),
  // The real GDI device name of the monitor the dashboard most recently
  // asked this session to switch to (see .../switch-monitor). The
  // already-running beacon-screenshare.exe helper polls this and applies
  // an in-place switch -- a plain "last requested" pointer, not a queue,
  // since only the latest request ever matters.
  pendingMonitor: text('pending_monitor'),
  // 'accepted'|'declined'|'timed_out', set by beacon-screenshare.exe (via
  // POST .../consent, report-token authenticated) before it ever dials the
  // relay, for a screen_share session that required end-user consent. NULL
  // = no decision reported yet (consent wasn't required, or the helper
  // hasn't answered yet) -- polled by the dashboard while status is still
  // "connecting" so a decline/timeout surfaces immediately instead of
  // waiting out the generic connect timeout.
  consentStatus: text('consent_status'),
});

// Web Remote file upload/download -- one row per browse/download/upload
// request, following the same "technician requests something, the
// already-running beacon-screenshare.exe helper polls for it and reports
// a result" shape as sessions.pendingMonitor above. See migration 0080's
// own comment for the exact request/result JSON shapes per type.
export const sessionFileRequests = sqliteTable('session_file_requests', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['browse', 'download', 'upload'] }).notNull(),
  status: text('status', { enum: ['pending', 'claimed', 'completed', 'failed'] }).notNull().default('pending'),
  request: text('request').notNull(), // JSON
  result: text('result'), // JSON, set once completed
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
});

export const deviceAudits = sqliteTable('device_audits', {
  id:           text('id').primaryKey(),
  deviceId:     text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  companyId:     text('company_id').notNull().references(() => companies.id),
  auditType:    text('audit_type').notNull().default('full'),
  hardware:     text('hardware'),   // JSON blob
  software:     text('software'),   // JSON blob
  services:     text('services'),   // JSON blob
  security:     text('security'),   // JSON blob
  // Pending/missing Windows Update patches (migration 0052) -- Windows-only.
  // Approval state lives separately in patchApprovals below (fleet-wide, not
  // per-device), keyed by each patch's own update_id. See
  // agent/internal/audit/patches.go.
  patches:      text('patches'),    // JSON blob
  agentVersion: text('agent_version'),
  createdAt:    integer('created_at').notNull(),
});

// Fleet-wide patch approval decisions (migration 0053) -- one row per Windows
// Update (keyed by WUA's UpdateID GUID), not per device. No row means
// undecided/pending. title/kbArticleIds/severity are a display-only snapshot
// taken at approval time -- the live "which devices have this pending" answer
// still comes from each device's latest deviceAudits.patches blob.
export const patchApprovals = sqliteTable('patch_approvals', {
  updateId:     text('update_id').primaryKey(),
  status:       text('status').notNull(), // 'approved' | 'ignored'
  title:        text('title').notNull(),
  kbArticleIds: text('kb_article_ids').notNull(), // JSON array
  severity:     text('severity'),
  updatedAt:    integer('updated_at').notNull(),
});

// Master Activity Log (migration 0058) -- accountability ("who did what") +
// fleet-wide operational visibility. Written by two layers: a generic
// middleware (worker/src/lib/activityLog.ts, wired in index.ts) that covers
// the vast majority of user-triggered admin/auth/session/branding mutations
// for free by keying off (method, c.req.routePath) after the handler
// succeeds; and a handful of explicit logActivity() calls for
// system/cron-triggered mutations that never go through a user-authenticated
// HTTP route (alert fire/resolve, scheduled job dispatch, patch policy
// auto-approval/dispatch) plus login/SSO events, which have no bearer token
// to resolve an actor from. Deliberately NO FK constraints on
// actorId/entityId/companyId -- this table must never cascade-delete or be
// blocked by a delete elsewhere just because it recorded something about a
// user/entity/company that no longer exists; actorLabel is a display-time
// snapshot for the same "survive the referenced row's deletion" reason
// patchApprovals already established for title/severity. entityId is NOT
// similarly snapshotted -- the Activity Log UI does a best-effort live join
// against the current entity table for a friendly name, falling back to the
// raw id / "(deleted)", matching how DeviceChangeLogPage/JobsPage already
// show live-joined rather than snapshotted entity data. Pruned by
// pruneActivityLog(), called from the scheduled() cron.
export const activityLog = sqliteTable('activity_log', {
  id:         text('id').primaryKey(),
  createdAt:  integer('created_at').notNull(),
  actorType:  text('actor_type', { enum: ['user', 'system', 'break-glass'] }).notNull(),
  actorId:    text('actor_id'),       // users.id snapshot -- no FK, see table comment
  actorLabel: text('actor_label'),    // email/displayName snapshot, or 'System' for cron events
  category:   text('category').notNull(),   // 'Device' | 'Policy' | 'Job' | 'User' | 'Auth' | 'Session' | 'Patch' | 'SSO' | 'Branding' | ...
  action:     text('action').notNull(),     // human label, e.g. "Deleted device"
  entityType: text('entity_type'),          // 'device' | 'policy' | 'job' | ... -- no FK, see table comment
  entityId:   text('entity_id'),
  companyId:   text('company_id'),            // only set when unambiguous (mostly device-linked events) -- no FK, see table comment
  method:     text('method').notNull(),     // 'POST'/'PATCH'/'DELETE'/'PUT', or 'CRON' for system events
  path:       text('path'),                 // raw request path -- debugging fallback when no lookup-table entry exists
  details:    text('details'),              // nullable JSON, room for future enrichment
});

export const deviceAuditChanges = sqliteTable('device_audit_changes', {
  id:         text('id').primaryKey(),
  deviceId:   text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  companyId:   text('company_id').notNull().references(() => companies.id),
  auditId:    text('audit_id').notNull().references(() => deviceAudits.id, { onDelete: 'cascade' }),
  category:   text('category').notNull(),
  changeType: text('change_type').notNull(),
  itemName:   text('item_name').notNull(),
  field:      text('field'),
  oldValue:   text('old_value'),
  newValue:   text('new_value'),
  detectedAt: integer('detected_at').notNull(),
});

export const components = sqliteTable('components', {
  id:             text('id').primaryKey(),
  name:           text('name').notNull(),
  description:    text('description'),
  category:       text('category'), // freeform organizational tag — surfaced in the UI as "Group", not to be confused with `type`
  type:           text('type', { enum: ['script', 'application'] }).notNull().default('script'),
  origin:         text('origin', { enum: ['custom', 'store'] }).notNull().default('custom'),
  // "Companies" scoping — 'global' means usable everywhere; 'company' means
  // restricted to the companies listed in component_companies (a real many-to-many,
  // not a single company — see that table for the actual membership list).
  scope:          text('scope', { enum: ['global', 'company'] }).notNull().default('global'),
  // Vestigial — superseded by component_companies (0022) before this ever saw
  // real usage. No longer read or written; kept only because the physical
  // column exists and D1's SQLite doesn't make DROP COLUMN worth it here.
  companyId:      text('company_id').references(() => companies.id),
  shell:          text('shell').notNull().default('auto'),
  script:         text('script').notNull().default(''),
  timeoutSeconds: integer('timeout_seconds').notNull().default(300),
  postConditions: text('post_conditions').notNull().default('[]'), // JSON PostCondition[]
  targetOs:       text('target_os'), // null = all platforms; 'windows'|'linux'|'darwin' = OS-specific
  // Only an admin may run a Job (Quick Job included) that includes this
  // component, and only an admin may set/clear this flag itself (enforced
  // in worker/src/routes/admin/components.ts) -- otherwise a technician
  // could just un-flag a component to bypass the restriction. See
  // CLAUDE.md's Components/Job System section.
  requiresAdmin:  integer('requires_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt:      integer('created_at').notNull(),
  updatedAt:      integer('updated_at').notNull(),
});

export const componentVariables = sqliteTable('component_variables', {
  id:            text('id').primaryKey(),
  componentId:   text('component_id').notNull().references(() => components.id, { onDelete: 'cascade' }),
  name:          text('name').notNull(),
  label:         text('label').notNull(),
  type:          text('type', { enum: ['string', 'selection', 'boolean', 'date'] }).notNull().default('string'),
  options:       text('options'),       // JSON [{label,value}] — only for type='selection'
  defaultValue:  text('default_value'), // always a string, regardless of declared type
  description:   text('description'),
  required:      integer('required', { mode: 'boolean' }).notNull().default(true),
  sortOrder:     integer('sort_order').notNull().default(0),
  createdAt:     integer('created_at').notNull(),
});

// Files attached to an existing Application Component. The bytes stay in a
// private R2 bucket; objectKey is never exposed as a public download URL.
export const componentFiles = sqliteTable('component_files', {
  id: text('id').primaryKey(),
  componentId: text('component_id').notNull().references(() => components.id, { onDelete: 'cascade' }),
  originalName: text('original_name').notNull(),
  objectKey: text('object_key').notNull().unique(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  contentType: text('content_type'),
  architecture: text('architecture'),
  createdAt: integer('created_at').notNull(),
});

// Application-specific execution metadata. Script Components intentionally
// have no row here and continue using their existing shell/script fields.
export const componentApplications = sqliteTable('component_applications', {
  componentId: text('component_id').primaryKey().references(() => components.id, { onDelete: 'cascade' }),
  installerFileId: text('installer_file_id').notNull().references(() => componentFiles.id),
  installerArguments: text('installer_arguments').notNull().default('[]'),
  timeoutSeconds: integer('timeout_seconds').notNull().default(900),
  detectionType: text('detection_type', { enum: ['none', 'msi_product_code', 'powershell'] }).notNull().default('none'),
  detectionValue: text('detection_value'),
  architecture: text('architecture', { enum: ['amd64'] }).notNull().default('amd64'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// A hashed, time-limited capability for one enrolled device to retrieve one
// private component file for a queued command. The raw token never persists.
export const componentFileDownloads = sqliteTable('component_file_downloads', {
  id: text('id').primaryKey(),
  componentFileId: text('component_file_id').notNull().references(() => componentFiles.id, { onDelete: 'cascade' }),
  commandId: text('command_id').notNull().references(() => commands.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  downloadedAt: integer('downloaded_at'),
  createdAt: integer('created_at').notNull(),
});

// Multi-company "Companies" membership for company-scoped components — a component
// can be restricted to several companies at once, added/removed one at a time
// (mirrors Datto's "Add Company" flyout).
export const componentCompanies = sqliteTable('component_companies', {
  id:          text('id').primaryKey(),
  componentId: text('component_id').notNull().references(() => components.id, { onDelete: 'cascade' }),
  companyId:    text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  createdAt:   integer('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id:           text('id').primaryKey(),
  name:         text('name').notNull(),
  description:  text('description'),
  type:         text('type', { enum: ['quick', 'scheduled'] }).notNull().default('quick'),
  status:       text('status', { enum: ['active', 'completed', 'cancelled'] }).notNull().default('active'),
  componentIds: text('component_ids').notNull().default('[]'), // JSON
  targetType:   text('target_type').notNull().default('devices'),
  targetIds:    text('target_ids').notNull().default('[]'),    // JSON
  runAsSystem:  integer('run_as_system', { mode: 'boolean' }).notNull().default(true),
  scheduledAt:  integer('scheduled_at'),
  expiresAt:    integer('expires_at'),
  createdAt:    integer('created_at').notNull(),
  createdBy:    text('created_by'),
});

// --- Auth: local accounts + Microsoft Entra ID SSO, global RBAC roles ---

export const ssoProviders = sqliteTable('sso_providers', {
  id:                     text('id').primaryKey(),
  type:                   text('type', { enum: ['microsoft'] }).notNull().default('microsoft'), // 'google' reserved (v2)
  name:                   text('name').notNull(),
  directoryId:            text('directory_id').notNull(), // Entra directory (tenant) id — NOT Beacon's own `companies`
  clientId:               text('client_id').notNull(),
  clientSecretCiphertext: text('client_secret_ciphertext').notNull(), // AES-GCM ciphertext, base64
  clientSecretNonce:      text('client_secret_nonce').notNull(),      // AES-GCM 12-byte nonce, base64
  enabled:                integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt:              integer('created_at').notNull(),
  updatedAt:              integer('updated_at').notNull(),
});

export const ssoGroupRoleMappings = sqliteTable('sso_group_role_mappings', {
  id:            text('id').primaryKey(),
  ssoProviderId: text('sso_provider_id').notNull().references(() => ssoProviders.id),
  groupId:       text('group_id').notNull(), // Entra security group object id
  groupName:     text('group_name'),         // cached display name, cosmetic only
  role:          text('role', { enum: ['admin', 'technician', 'readonly'] }).notNull(),
  createdAt:     integer('created_at').notNull(),
});

// Short-lived, single-use CSRF/PKCE state for the OAuth redirect. id IS the `state`
// value sent to Microsoft — no server-side session exists yet at this point in the flow.
export const ssoLoginState = sqliteTable('sso_login_state', {
  id:            text('id').primaryKey(),
  ssoProviderId: text('sso_provider_id').notNull().references(() => ssoProviders.id),
  codeVerifier:  text('code_verifier').notNull(), // PKCE
  redirectUri:   text('redirect_uri').notNull(),
  createdAt:     integer('created_at').notNull(),
  expiresAt:     integer('expires_at').notNull(),
});

export const users = sqliteTable('users', {
  id:            text('id').primaryKey(),
  email:         text('email').notNull(),
  displayName:   text('display_name'),
  role:          text('role', { enum: ['admin', 'technician', 'readonly'] }).notNull().default('readonly'),
  // Self-describing: "pbkdf2-sha256$<iterations>$<saltB64>$<hashB64>". NULL for SSO-only users.
  passwordHash:  text('password_hash'),
  authSource:    text('auth_source', { enum: ['local', 'microsoft'] }).notNull().default('local'),
  ssoProviderId: text('sso_provider_id').references(() => ssoProviders.id),
  ssoSubject:    text('sso_subject'), // Entra object id (`oid` claim); NULL for local accounts
  status:        text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  createdAt:     integer('created_at').notNull(),
  updatedAt:     integer('updated_at').notNull(),
  lastLoginAt:   integer('last_login_at'),
  createdBy:     text('created_by'),
  // Opt-in: this account receives alert notification emails (one of two
  // unioned recipient sources, alongside notificationEmails above).
  receivesAlerts: integer('receives_alerts', { mode: 'boolean' }).notNull().default(false),
});

export const userSessions = sqliteTable('user_sessions', {
  id:          text('id').primaryKey(),
  userId:      text('user_id').notNull().references(() => users.id),
  // sha256hex(raw token) — same convention as enrollmentTokens.tokenHash / devices.deviceCredentialHash
  tokenHash:   text('token_hash').notNull().unique(),
  createdAt:   integer('created_at').notNull(),
  expiresAt:   integer('expires_at').notNull(),
  lastUsedAt:  integer('last_used_at'),
  revokedAt:   integer('revoked_at'),
  userAgent:   text('user_agent'),
  ip:          text('ip'),
});

// One-time code handed to the SPA after an SSO login so the real session token never
// appears in a URL. The SPA immediately POSTs it to /v1/auth/microsoft/exchange.
export const ssoExchangeCodes = sqliteTable('sso_exchange_codes', {
  id:           text('id').primaryKey(),
  sessionToken: text('session_token').notNull(), // raw (unhashed), single-use, ~60s TTL
  createdAt:    integer('created_at').notNull(),
  expiresAt:    integer('expires_at').notNull(),
});

export const commands = sqliteTable('commands', {
  id:             text('id').primaryKey(),
  deviceId:       text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  companyId:       text('company_id').notNull().references(() => companies.id),
  type:           text('type').notNull(),
  payload:        text('payload').notNull(), // JSON
  status:         text('status', { enum: ['queued', 'sent', 'completed', 'failed'] }).notNull().default('queued'),
  result:         text('result'), // JSON: { stdout, stderr, exit_code }
  warning:        integer('warning', { mode: 'boolean' }).notNull().default(false), // post_conditions match — orthogonal to status
  createdAt:      integer('created_at').notNull(),
  completedAt:    integer('completed_at'),
  // Job linkage (null for direct commands like reboot)
  jobId:          text('job_id'),
  componentId:    text('component_id'),
  componentOrder: integer('component_order').notNull().default(1),
});

// ChatGPT task bridge — see migrations/0087_gpt_tasks_bridge.sql and lib/gptBridge.ts.
// ChatGPT writes THIS table via the Cloudflare D1 API; the worker is the only
// writer of commands rows derived from it. Approval is an HMAC token verified
// here, never a plain column ChatGPT could UPDATE.
export const gptTasks = sqliteTable('gpt_tasks', {
  id:             text('id').primaryKey(),
  requestId:      text('request_id').notNull().unique(),
  deviceId:       text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  companyId:      text('company_id').notNull().references(() => companies.id),
  kind:           text('kind').notNull().default('powershell'),
  script:         text('script').notNull(),
  reason:         text('reason').notNull(),
  status:         text('status').notNull().default('pending'),
  classification: text('classification'),
  commandId:      text('command_id'),
  confirmToken:   text('confirm_token'),
  result:         text('result'),
  error:          text('error'),
  requestedAt:    integer('requested_at').notNull(),
  updatedAt:      integer('updated_at').notNull(),
  completedAt:    integer('completed_at'),
  expiresAt:      integer('expires_at').notNull(),
});

// Dynamic custom fields ("UDF" equivalent) — admin-defined named fields, values
// stored per device. Not Datto's 300 fixed numbered slots; a real join table
// (not a JSON blob on devices) so a future filter/targeting pass doesn't need
// a schema change. Manual entry only for this pass — no agent-write path.
export const customFields = sqliteTable('custom_fields', {
  id:        text('id').primaryKey(),
  name:      text('name').notNull(),
  // Identifier form of `name` (uppercase, [A-Z_][A-Z0-9_]*) -- lets a script
  // reference this field's value as the env var CF_<key>, resolved per-device
  // at job dispatch time. '' means no key assigned yet (not referenceable).
  key:       text('key').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const deviceCustomFieldValues = sqliteTable('device_custom_field_values', {
  deviceId:  text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  fieldId:   text('field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
  value:     text('value'),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.deviceId, t.fieldId] })]);

// Per-Company key/value config, referenceable from component scripts as
// CV_<KEY> (see worker/src/routes/admin/jobs.ts's fetchCompanyVariables).
// Two kinds: plain variables (value, cleartext) and secrets (valueCiphertext/
// valueNonce, AES-GCM via CONFIG_ENCRYPTION_KEY -- same pattern as
// sso_providers/email_settings, never returned in plaintext once saved).
export const companyVariables = sqliteTable('company_variables', {
  id:               text('id').primaryKey(),
  companyId:        text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  key:              text('key').notNull(),
  isSecret:         integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  value:            text('value'),
  valueCiphertext:  text('value_ciphertext'),
  valueNonce:       text('value_nonce'),
  description:      text('description'),
  createdAt:        integer('created_at').notNull(),
  updatedAt:        integer('updated_at').notNull(),
});

// Network Discovery (v1: live-host sweep) -- a designated always-on "probe"
// device per company periodically ping-sweeps a configured CIDR range and
// reports live hosts back. See worker/src/lib/discovery.ts.
export const networkDiscoveryConfigs = sqliteTable('network_discovery_configs', {
  id:                  text('id').primaryKey(),
  companyId:           text('company_id').notNull().unique().references(() => companies.id, { onDelete: 'cascade' }),
  probeDeviceId:       text('probe_device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  enabled:             integer('enabled', { mode: 'boolean' }).notNull().default(true),
  cidrRanges:          text('cidr_ranges').notNull(), // JSON string[]
  scanIntervalMinutes: integer('scan_interval_minutes').notNull().default(360),
  lastScannedAt:       integer('last_scanned_at'),
  // Credentialed Network Discovery (issue #78, migration 0076) -- per-company
  // opt-in toggles only. Credentials themselves live in company_variables
  // under a fixed key-name convention (CV_SNMP_COMMUNITY, CV_SSH_USERNAME,
  // CV_SSH_PASSWORD), not here -- see worker/src/lib/discovery.ts.
  snmpEnabled:         integer('snmp_enabled', { mode: 'boolean' }).notNull().default(false),
  sshEnabled:          integer('ssh_enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt:           integer('created_at').notNull(),
  updatedAt:           integer('updated_at').notNull(),
});

// Keyed by (company_id, ip_address), not MAC -- see migration 0062's comment.
export const discoveredDevices = sqliteTable('discovered_devices', {
  id:           text('id').primaryKey(),
  companyId:    text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  ipAddress:    text('ip_address').notNull(),
  macAddress:   text('mac_address'),
  hostname:     text('hostname'),
  firstSeenAt:  integer('first_seen_at').notNull(),
  lastSeenAt:   integer('last_seen_at').notNull(),
  timesSeen:    integer('times_seen').notNull().default(1),
  dismissed:    integer('dismissed', { mode: 'boolean' }).notNull().default(false),
  // Credentialed Network Discovery (issue #78, migration 0076) -- all
  // nullable, only ever set once a probe actually finds something (never
  // blanked out by a scan that finds nothing new). See migration 0076's own
  // comment for what populates each column.
  openPorts:     text('open_ports'),      // JSON int[]
  snmpSysDescr:  text('snmp_sys_descr'),
  snmpSysName:   text('snmp_sys_name'),
  sshBanner:     text('ssh_banner'),
  sshOsInfo:     text('ssh_os_info'),
});

// Device Groups -- static, manually-curated device collections (Datto's
// "Groups", not the dynamic "Filter" half of that system). Used to target
// both Jobs (resolveDevices in jobs.ts) and Policies (policyGroups below).
export const deviceGroups = sqliteTable('device_groups', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull(),
  description: text('description'),
  createdAt:   integer('created_at').notNull(),
  updatedAt:   integer('updated_at').notNull(),
});

// Host-level visual branding. Built-in themes are immutable palettes; custom
// themes have drafts plus immutable published revisions for cache-safe rollout.
export const brandingThemes = sqliteTable('branding_themes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source', { enum: ['built_in', 'custom'] }).notNull(),
  draftTokens: text('draft_tokens').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const brandingThemeRevisions = sqliteTable('branding_theme_revisions', {
  id: text('id').primaryKey(),
  themeId: text('theme_id').notNull().references(() => brandingThemes.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  tokens: text('tokens').notNull(),
  publishedAt: integer('published_at').notNull(),
});

export const brandingSettings = sqliteTable('branding_settings', {
  id: integer('id').primaryKey(),
  activeThemeId: text('active_theme_id').notNull().references(() => brandingThemes.id),
  activeRevisionId: text('active_revision_id').references(() => brandingThemeRevisions.id),
  updatedAt: integer('updated_at').notNull(),
});

// Shared host-wide dashboards. A dashboard with no dashboardCompanies rows shows
// all companies; widget layout is a persisted 12-column grid.
export const dashboards = sqliteTable('dashboards', {
  id:        text('id').primaryKey(),
  name:      text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isHome:    integer('is_home', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const dashboardCompanies = sqliteTable('dashboard_companies', {
  dashboardId: text('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  companyId:    text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  createdAt:   integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.dashboardId, t.companyId] })]);

export const dashboardWidgets = sqliteTable('dashboard_widgets', {
  id:          text('id').primaryKey(),
  dashboardId: text('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  type:        text('type').notNull(),
  title:       text('title'),
  config:      text('config').notNull().default('{}'),
  gridX:       integer('grid_x').notNull().default(0),
  gridY:       integer('grid_y').notNull().default(0),
  gridW:       integer('grid_w').notNull().default(4),
  gridH:       integer('grid_h').notNull().default(3),
  sortOrder:   integer('sort_order').notNull().default(0),
  createdAt:   integer('created_at').notNull(),
  updatedAt:   integer('updated_at').notNull(),
});

// Host-level product identity: white-labeled name + logo mark. Kept separate
// from brandingSettings — that table is strictly a theme-activation pointer,
// this is a different concern with its own lifecycle.
export const brandingIdentity = sqliteTable('branding_identity', {
  id: integer('id').primaryKey(),
  productName: text('product_name').notNull(),
  logoKey: text('logo_key'),
  // Get Support tray menu item's destination -- delivered to the agent via
  // an unauthenticated GET /v1/branding/identity poll, not check-in. Null
  // means unconfigured; the tray hides the menu item. See CLAUDE.md's
  // Branding section (issue #90).
  supportUrl: text('support_url'),
  updatedAt: integer('updated_at').notNull(),
});

// Global RustDesk relay/rendezvous server config -- singleton, same shape
// as brandingIdentity above. All three fields nullable/empty by default,
// meaning devices use RustDesk's own public ID/relay servers with no
// self-hosted infrastructure required; a self-hoster can point at their own
// hbbs/hbbr later by filling these in, with no code change. Not yet read by
// any agent-side code -- see CLAUDE.md's RustDesk section for the deferred
// on-demand-install follow-on work this config exists ahead of.
export const rustdeskSettings = sqliteTable('rustdesk_settings', {
  id: integer('id').primaryKey(),
  idServer: text('id_server'),
  relayServer: text('relay_server'),
  key: text('key'),
  updatedAt: integer('updated_at').notNull(),
});

// The pinned RustDesk installer -- singleton, mirrors rustdeskSettings
// above. Beacon hosts a specific version rather than trusting a live fetch
// from RustDesk's own CDN at install time -- same trust model as
// Application Components' file delivery. Nullable until first upload.
export const rustdeskInstaller = sqliteTable('rustdesk_installer', {
  id: integer('id').primaryKey(),
  objectKey: text('object_key'),
  version: text('version'),
  sha256: text('sha256'),
  sizeBytes: integer('size_bytes'),
  uploadedAt: integer('uploaded_at'),
});

// A hashed, time-limited capability for one enrolled device to download the
// pinned RustDesk installer for one queued install_rustdesk command -- same
// shape as componentFileDownloads above, kept separate since that table is
// FK'd to componentFiles (an Application Component's own file), which the
// RustDesk installer isn't.
export const rustdeskInstallerDownloads = sqliteTable('rustdesk_installer_downloads', {
  id: text('id').primaryKey(),
  commandId: text('command_id').notNull().references(() => commands.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  downloadedAt: integer('downloaded_at'),
  createdAt: integer('created_at').notNull(),
});

// A hashed, time-limited, single-use capability for one enrolled device to
// redeem its own devices.rustdeskPassword{Ciphertext,Nonce} in plaintext
// exactly once, during its own install_rustdesk command -- same
// activation/expiry shape as rustdeskInstallerDownloads, granting a
// decrypt-on-redeem instead of an R2 object.
export const rustdeskPasswordGrants = sqliteTable('rustdesk_password_grants', {
  id: text('id').primaryKey(),
  commandId: text('command_id').notNull().references(() => commands.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  redeemedAt: integer('redeemed_at'),
  createdAt: integer('created_at').notNull(),
});

export const deviceGroupMembers = sqliteTable('device_group_members', {
  groupId:   text('group_id').notNull().references(() => deviceGroups.id, { onDelete: 'cascade' }),
  deviceId:  text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.groupId, t.deviceId] })]);

// Maintenance Policy (v1: 'one_time' + 'weekly' recurrence only, matching
// Datto RMM's real Maintenance Policy scope) -- fleet-wide scheduled alert
// suppression, alongside (not replacing) the existing per-device ad-hoc
// window above (devices.maintenanceEndsAt/maintenanceReason, migration
// 0025). Targeting mirrors policyCompanies/policyDevices/policyGroups' exact
// shape as independent parallel tables -- a different policy type with its
// own targeting, not a reuse of Monitoring Policy's tables. No OS/Class gate
// -- Datto's own Maintenance Policy has no such filter, narrower scope than
// Monitoring Policy. See worker/src/lib/maintenance.ts for evaluation.
export const maintenancePolicies = sqliteTable('maintenance_policies', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull(),
  description: text('description'),
  enabled:     integer('enabled', { mode: 'boolean' }).notNull().default(true),
  recurrenceType: text('recurrence_type', { enum: ['one_time', 'weekly'] }).notNull(),
  // One-time fields -- null unless recurrenceType='one_time'. Stored as an
  // absolute UTC instant (like devices.maintenanceEndsAt) -- the host
  // timezone is "baked in" once at creation time via the dashboard's
  // conversion helper, not re-interpreted on every evaluation.
  oneTimeStartAt:         integer('one_time_start_at'),
  oneTimeDurationMinutes: integer('one_time_duration_minutes'),
  // Weekly fields -- null unless recurrenceType='weekly'. Wall-clock, always
  // re-interpreted against the CURRENT host_settings.timezone at evaluation
  // time (unlike one-time above) -- matches Datto's own "one account-wide
  // Time Zone applies to schedules" behavior. weeklyDays follows the same
  // "JSON-stringified array in a text column" convention as
  // policies.targetOs/targetClass, not a bitmask.
  weeklyDays:            text('weekly_days'),            // JSON int[], 0=Sun..6=Sat
  weeklyStartMinute:     integer('weekly_start_minute'), // 0-1439, host-tz minutes since midnight
  weeklyDurationMinutes: integer('weekly_duration_minutes'), // 1-1439 (Datto caps just under 24h)
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const maintenancePolicyCompanies = sqliteTable('maintenance_policy_companies', {
  policyId:  text('policy_id').notNull().references(() => maintenancePolicies.id, { onDelete: 'cascade' }),
  companyId:  text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.companyId] })]);

export const maintenancePolicyDevices = sqliteTable('maintenance_policy_devices', {
  policyId:  text('policy_id').notNull().references(() => maintenancePolicies.id, { onDelete: 'cascade' }),
  deviceId:  text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.deviceId] })]);

export const maintenancePolicyGroups = sqliteTable('maintenance_policy_groups', {
  policyId:  text('policy_id').notNull().references(() => maintenancePolicies.id, { onDelete: 'cascade' }),
  groupId:   text('group_id').notNull().references(() => deviceGroups.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.groupId] })]);

// Patch Policy (migration 0054) -- severity-threshold auto-approval rules
// plus recurring scheduled install windows. Recurrence columns are a
// verbatim duplicate of maintenancePolicies, not shared -- same
// per-policy-type mirroring convention. Unlike Maintenance Policy's
// passive suppression gate, this needs active cron dispatch (like Jobs);
// lastDispatchedAt is the one new piece of state that requires. See
// worker/src/lib/patchPolicies.ts.
export const patchPolicies = sqliteTable('patch_policies', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull(),
  description: text('description'),
  enabled:     integer('enabled', { mode: 'boolean' }).notNull().default(true),
  recurrenceType: text('recurrence_type', { enum: ['one_time', 'weekly'] }).notNull(),
  oneTimeStartAt:         integer('one_time_start_at'),
  oneTimeDurationMinutes: integer('one_time_duration_minutes'),
  weeklyDays:            text('weekly_days'),
  weeklyStartMinute:     integer('weekly_start_minute'),
  weeklyDurationMinutes: integer('weekly_duration_minutes'),
  // Windows Update's own Classification taxonomy (Critical Updates,
  // Security Updates, Update Rollups, Feature Packs, Service Packs, Tools,
  // Updates), not an MSRC severity threshold -- severity is only
  // meaningfully populated for Security-Updates-classified patches, so a
  // severity-only gate could never auto-approve anything else. Empty array
  // = auto-approval off, same "explicit opt-in" semantics the old
  // min_severity:null had.
  autoApproveClassifications: text('auto_approve_classifications').notNull().default('[]'),
  // Device Class targeting only (no OS dimension -- Patch Management is
  // Windows-only already, so an OS filter here would never do anything).
  // Same JSON-array-in-TEXT convention and "all classes" default as
  // policies.targetClass, ANDed with the Company/Device/Group OR-list below.
  targetClass:       text('target_class').notNull().default('["server","workstation","laptop"]'),
  autoReboot:        integer('auto_reboot', { mode: 'boolean' }).notNull().default(false),
  // Opt-in takeover of Windows' own separate Automatic Updates behavior --
  // see worker/src/lib/windowsUpdateManagement.ts. Default false: an
  // existing policy's behavior never changes retroactively.
  manageWindowsUpdate: integer('manage_windows_update', { mode: 'boolean' }).notNull().default(false),
  // Visibility + manual-approval only -- never eligible for Auto-Approval
  // (confirmed via AskUserQuestion; a bad driver can break hardware/boot
  // in a way a bad software patch usually can't). Gates whether the
  // worker keeps driver-type items when storing this device's audit (see
  // worker/src/routes/audit.ts) -- the agent scans+reports drivers
  // unconditionally now, this is a storage-time filter, not an
  // agent-side one.
  includeDrivers: integer('include_drivers', { mode: 'boolean' }).notNull().default(false),
  // Independent of manageWindowsUpdate -- see worker/src/lib/
  // microsoftUpdateManagement.ts. Default false: no retroactive flip.
  manageMicrosoftUpdate: integer('manage_microsoft_update', { mode: 'boolean' }).notNull().default(false),
  lastDispatchedAt:  integer('last_dispatched_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const patchPolicyCompanies = sqliteTable('patch_policy_companies', {
  policyId:  text('policy_id').notNull().references(() => patchPolicies.id, { onDelete: 'cascade' }),
  companyId:  text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.companyId] })]);

export const patchPolicyDevices = sqliteTable('patch_policy_devices', {
  policyId:  text('policy_id').notNull().references(() => patchPolicies.id, { onDelete: 'cascade' }),
  deviceId:  text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.deviceId] })]);

export const patchPolicyGroups = sqliteTable('patch_policy_groups', {
  policyId:  text('policy_id').notNull().references(() => patchPolicies.id, { onDelete: 'cascade' }),
  groupId:   text('group_id').notNull().references(() => deviceGroups.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.policyId, t.groupId] })]);

// Host-wide singleton settings -- currently just the Maintenance-Policy
// scheduling timezone (Datto: Setup > Account Settings > Time Zone, one
// value for the whole account, no per-company override -- confirmed against
// Datto's real docs and explicitly declined by the user when floated as an
// option). Same id=1 CHECK singleton shape as emailSettings/
// brandingSettings/brandingIdentity. A natural home for other future
// host-wide settings.
export const hostSettings = sqliteTable('host_settings', {
  id:        integer('id').primaryKey(),
  timezone:  text('timezone').notNull().default('UTC'), // IANA name, e.g. "America/New_York"
  updatedAt: integer('updated_at').notNull(),
  // Persisted-timestamp throttle for pruneActivityLog() (migration 0058) --
  // mirrors userSessions.lastUsedAt's throttle shape rather than a stateless
  // cron-tick bucket, so a missed/delayed cron tick can't silently skip a
  // whole day's prune.
  activityLogPrunedAt: integer('activity_log_pruned_at'),
});
