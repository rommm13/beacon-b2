import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc } from 'drizzle-orm';
import type { Bindings } from '../../index';
import * as schema from '../../db/schema';
import { sha256hex, generateToken, encryptSecret } from '../../lib/crypto';
import { requireUser, type Role } from '../../lib/auth';
import { buildDiscoveryScanPayload } from '../../lib/discovery';
import { signCommandPayload } from '../../lib/gptBridge';

const adminCompanies = new Hono<{ Bindings: Bindings }>();

function auth(c: any, minRole: Role = 'readonly') {
  return requireUser(c.req.header('Authorization'), c.env, minRole);
}

// ── Companies ───────────────────────────────────────────────────

// GET / — list companies with device counts and primary contact via subqueries
adminCompanies.get('/', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);

  const result = await c.env.DB.prepare(`
    SELECT
      t.id, t.name, t.auto_approve_default, t.privacy_mode_default, t.patch_management_excluded,
      t.remote_access_consent_required, t.rustdesk_enabled, t.status,
      t.created_at, t.website, t.notes,
      (SELECT count(*) FROM devices WHERE company_id = t.id) AS device_count,
      (SELECT name  FROM company_contacts WHERE company_id = t.id AND is_primary = 1 LIMIT 1) AS primary_contact_name,
      (SELECT email FROM company_contacts WHERE company_id = t.id AND is_primary = 1 LIMIT 1) AS primary_contact_email
    FROM companies t
    ORDER BY t.created_at ASC
  `).all<{
    id: string; name: string; auto_approve_default: number; privacy_mode_default: number; patch_management_excluded: number;
    remote_access_consent_required: number; rustdesk_enabled: number;
    status: string; created_at: number; website: string | null; notes: string | null;
    device_count: number; primary_contact_name: string | null; primary_contact_email: string | null;
  }>();

  return c.json(result.results.map(r => ({
    id: r.id,
    name: r.name,
    autoApproveDefault: !!r.auto_approve_default,
    privacyModeDefault: !!r.privacy_mode_default,
    patchManagementExcluded: !!r.patch_management_excluded,
    remoteAccessConsentRequired: !!r.remote_access_consent_required,
    rustdeskEnabled: !!r.rustdesk_enabled,
    status: r.status,
    createdAt: r.created_at,
    deviceCount: r.device_count,
    website: r.website,
    notes: r.notes,
    primaryContactName: r.primary_contact_name,
    primaryContactEmail: r.primary_contact_email,
  })));
});

// POST / — create company + optional initial contact
adminCompanies.post('/', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  const body = await c.req.json<{
    name: string;
    auto_approve_default?: boolean;
    privacy_mode_default?: boolean;
    patch_management_excluded?: boolean;
    remote_access_consent_required?: boolean;
    rustdesk_enabled?: boolean;
    website?: string;
    notes?: string;
    contact_name?: string;
    contact_email?: string;
    contact_phone?: string;
  }>();

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  const id = crypto.randomUUID();
  await db.insert(schema.companies).values({
    id,
    name: body.name.trim(),
    autoApproveDefault: body.auto_approve_default ?? true,
    privacyModeDefault: body.privacy_mode_default ?? false,
    patchManagementExcluded: body.patch_management_excluded ?? false,
    remoteAccessConsentRequired: body.remote_access_consent_required ?? false,
    rustdeskEnabled: body.rustdesk_enabled ?? false,
    website: body.website || null,
    notes: body.notes || null,
    createdAt: now,
  });

  if (body.contact_name?.trim()) {
    await db.insert(schema.companyContacts).values({
      id: crypto.randomUUID(),
      companyId: id,
      name: body.contact_name.trim(),
      email: body.contact_email || null,
      phone: body.contact_phone || null,
      isPrimary: true,
      createdAt: now,
    });
  }

  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  return c.json({
    ...company,
    deviceCount: 0,
    primaryContactName: body.contact_name?.trim() || null,
    primaryContactEmail: body.contact_email || null,
  }, 201);
});

// PATCH /:id — update company info and settings
adminCompanies.patch('/:id', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const body = await c.req.json<{
    name?: string;
    auto_approve_default?: boolean;
    privacy_mode_default?: boolean;
    patch_management_excluded?: boolean;
    remote_access_consent_required?: boolean;
    rustdesk_enabled?: boolean;
    status?: 'active' | 'suspended';
    website?: string | null;
    notes?: string | null;
  }>();

  const updates: Partial<typeof schema.companies.$inferInsert> = {};
  if (body.name !== undefined)                 updates.name = body.name.trim();
  if (body.auto_approve_default !== undefined) updates.autoApproveDefault = body.auto_approve_default;
  if (body.privacy_mode_default !== undefined) updates.privacyModeDefault = body.privacy_mode_default;
  if (body.patch_management_excluded !== undefined) updates.patchManagementExcluded = body.patch_management_excluded;
  if (body.remote_access_consent_required !== undefined) updates.remoteAccessConsentRequired = body.remote_access_consent_required;
  if (body.rustdesk_enabled !== undefined) updates.rustdeskEnabled = body.rustdesk_enabled;
  if (body.status !== undefined)               updates.status = body.status;
  if ('website' in body)                       updates.website = body.website ?? null;
  if ('notes'   in body)                       updates.notes   = body.notes   ?? null;

  if (Object.keys(updates).length === 0) return c.json({ error: 'nothing to update' }, 400);

  await db.update(schema.companies).set(updates).where(eq(schema.companies.id, c.req.param('id')));
  return c.json({ ok: true });
});

// ── Contacts ──────────────────────────────────────────────────

adminCompanies.get('/:id/contacts', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const contacts = await db
    .select()
    .from(schema.companyContacts)
    .where(eq(schema.companyContacts.companyId, c.req.param('id')))
    .all();

  return c.json(contacts);
});

adminCompanies.post('/:id/contacts', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);
  const companyId = c.req.param('id');

  const body = await c.req.json<{
    name: string;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    is_primary?: boolean;
  }>();

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  if (body.is_primary) {
    await db.update(schema.companyContacts)
      .set({ isPrimary: false })
      .where(eq(schema.companyContacts.companyId, companyId));
  }

  const id = crypto.randomUUID();
  await db.insert(schema.companyContacts).values({
    id,
    companyId,
    name: body.name.trim(),
    title: body.title || null,
    email: body.email || null,
    phone: body.phone || null,
    isPrimary: body.is_primary ?? false,
    createdAt: now,
  });

  const contact = await db.select().from(schema.companyContacts).where(eq(schema.companyContacts.id, id)).get();
  return c.json(contact, 201);
});

adminCompanies.patch('/:id/contacts/:contactId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const companyId = c.req.param('id');
  const contactId = c.req.param('contactId');

  const body = await c.req.json<{
    name?: string;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    is_primary?: boolean;
  }>();

  if (body.is_primary) {
    await db.update(schema.companyContacts)
      .set({ isPrimary: false })
      .where(eq(schema.companyContacts.companyId, companyId));
  }

  const updates: Partial<typeof schema.companyContacts.$inferInsert> = {};
  if (body.name !== undefined)      updates.name     = body.name.trim();
  if ('title' in body)              updates.title    = body.title ?? null;
  if ('email' in body)              updates.email    = body.email ?? null;
  if ('phone' in body)              updates.phone    = body.phone ?? null;
  if (body.is_primary !== undefined) updates.isPrimary = body.is_primary;

  if (Object.keys(updates).length === 0) return c.json({ error: 'nothing to update' }, 400);

  await db.update(schema.companyContacts).set(updates).where(eq(schema.companyContacts.id, contactId));
  return c.json({ ok: true });
});

adminCompanies.delete('/:id/contacts/:contactId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  await db.delete(schema.companyContacts).where(eq(schema.companyContacts.id, c.req.param('contactId')));
  return c.json({ ok: true });
});

// ── Locations ─────────────────────────────────────────────────

adminCompanies.get('/:id/locations', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const locations = await db
    .select()
    .from(schema.companyLocations)
    .where(eq(schema.companyLocations.companyId, c.req.param('id')))
    .all();

  return c.json(locations);
});

adminCompanies.post('/:id/locations', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);
  const companyId = c.req.param('id');

  const body = await c.req.json<{
    name: string;
    is_primary?: boolean;
    street?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
  }>();

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  if (body.is_primary) {
    await db.update(schema.companyLocations)
      .set({ isPrimary: false })
      .where(eq(schema.companyLocations.companyId, companyId));
  }

  const id = crypto.randomUUID();
  await db.insert(schema.companyLocations).values({
    id,
    companyId,
    name: body.name.trim(),
    isPrimary: body.is_primary ?? false,
    street: body.street || null,
    city: body.city || null,
    state: body.state || null,
    zip: body.zip || null,
    country: body.country || null,
    createdAt: now,
  });

  const location = await db.select().from(schema.companyLocations).where(eq(schema.companyLocations.id, id)).get();
  return c.json(location, 201);
});

adminCompanies.patch('/:id/locations/:locationId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const companyId = c.req.param('id');
  const locationId = c.req.param('locationId');

  const body = await c.req.json<{
    name?: string;
    is_primary?: boolean;
    street?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
  }>();

  if (body.is_primary) {
    await db.update(schema.companyLocations)
      .set({ isPrimary: false })
      .where(eq(schema.companyLocations.companyId, companyId));
  }

  const updates: Partial<typeof schema.companyLocations.$inferInsert> = {};
  if (body.name !== undefined)       updates.name      = body.name.trim();
  if (body.is_primary !== undefined) updates.isPrimary = body.is_primary;
  if ('street'  in body)             updates.street  = body.street  ?? null;
  if ('city'    in body)             updates.city    = body.city    ?? null;
  if ('state'   in body)             updates.state   = body.state   ?? null;
  if ('zip'     in body)             updates.zip     = body.zip     ?? null;
  if ('country' in body)             updates.country = body.country ?? null;

  if (Object.keys(updates).length === 0) return c.json({ error: 'nothing to update' }, 400);

  await db.update(schema.companyLocations).set(updates).where(eq(schema.companyLocations.id, locationId));
  return c.json({ ok: true });
});

adminCompanies.delete('/:id/locations/:locationId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  await db.delete(schema.companyLocations).where(eq(schema.companyLocations.id, c.req.param('locationId')));
  return c.json({ ok: true });
});

// ── Enrollment Tokens ─────────────────────────────────────────

adminCompanies.get('/:id/tokens', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const tokens = await db
    .select()
    .from(schema.enrollmentTokens)
    .where(eq(schema.enrollmentTokens.companyId, c.req.param('id')))
    .all();

  return c.json(tokens.map(({ tokenHash: _, ...t }) => t));
});

adminCompanies.post('/:id/tokens', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  const company = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.id, c.req.param('id')))
    .get();
  if (!company) return c.json({ error: 'company not found' }, 404);

  const body: { auto_approve?: boolean | null; max_uses?: number | null; expires_in_days?: number | null } =
    await c.req.json().catch(() => ({}));

  const rawToken = generateToken();
  const tokenHash = await sha256hex(rawToken);
  const id = crypto.randomUUID();
  const expiresAt = body.expires_in_days ? now + body.expires_in_days * 86400 : null;

  await db.insert(schema.enrollmentTokens).values({
    id,
    companyId: c.req.param('id'),
    tokenHash,
    autoApprove: body.auto_approve ?? null,
    maxUses: body.max_uses ?? null,
    expiresAt,
    createdBy: 'admin',
    createdAt: now,
  });

  return c.json({ id, raw_token: rawToken, expires_at: expiresAt, max_uses: body.max_uses ?? null }, 201);
});

adminCompanies.delete('/:id/tokens/:tokenId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  await db
    .update(schema.enrollmentTokens)
    .set({ revokedAt: now })
    .where(eq(schema.enrollmentTokens.id, c.req.param('tokenId')));

  return c.json({ ok: true });
});

adminCompanies.delete('/:id/tokens/:tokenId/permanent', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const companyId = c.req.param('id');
  const tokenId = c.req.param('tokenId');

  const token = await db
    .select({ useCount: schema.enrollmentTokens.useCount, revokedAt: schema.enrollmentTokens.revokedAt })
    .from(schema.enrollmentTokens)
    .where(and(
      eq(schema.enrollmentTokens.id, tokenId),
      eq(schema.enrollmentTokens.companyId, companyId),
    ))
    .get();

  if (!token) return c.json({ error: 'enrollment token not found' }, 404);
  if (!token.revokedAt) return c.json({ error: 'revoke the enrollment token before deleting it' }, 409);
  if (token.useCount > 0) {
    return c.json({ error: 'enrollment tokens that have enrolled devices are retained for enrollment history' }, 409);
  }

  await db
    .delete(schema.enrollmentTokens)
    .where(and(
      eq(schema.enrollmentTokens.id, tokenId),
      eq(schema.enrollmentTokens.companyId, companyId),
    ));

  return c.json({ ok: true });
});

// ── Variables ─────────────────────────────────────────────────
// Per-company key/value config, referenceable from component scripts as
// CV_<KEY> (resolved per-device at job dispatch time — see jobs.ts's
// fetchCompanyVariables). Two kinds: plain variables (cleartext, always
// returned) and secrets (AES-GCM encrypted, never returned in plaintext by
// any read endpoint — same "secret never returned, blank input means keep
// existing" contract sso_providers/email_settings already established).

const VARIABLE_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

function normalizeVariableKey(raw: string): string {
  return raw.trim().toUpperCase();
}

// Shapes a row for API responses — never includes valueCiphertext/valueNonce,
// and a secret's value is reported only as hasValue, never the plaintext.
function shapeVariable(row: typeof schema.companyVariables.$inferSelect) {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    isSecret: row.isSecret,
    value: row.isSecret ? undefined : row.value,
    hasValue: row.isSecret ? row.valueCiphertext !== null : row.value !== null,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

adminCompanies.get('/:id/variables', async (c) => {
  if (!(await auth(c, 'admin'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const rows = await db
    .select()
    .from(schema.companyVariables)
    .where(eq(schema.companyVariables.companyId, c.req.param('id')))
    .all();

  return c.json(rows.map(shapeVariable));
});

adminCompanies.post('/:id/variables', async (c) => {
  if (!(await auth(c, 'admin'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);
  const companyId = c.req.param('id');

  const body = await c.req.json<{
    key: string;
    is_secret?: boolean;
    value?: string | null;
    description?: string | null;
  }>();

  const key = normalizeVariableKey(body.key ?? '');
  if (!VARIABLE_KEY_RE.test(key)) {
    return c.json({ error: 'key must be a valid identifier (A-Z, 0-9, underscore, not starting with a digit)' }, 400);
  }
  const dup = await db.select({ id: schema.companyVariables.id }).from(schema.companyVariables)
    .where(and(eq(schema.companyVariables.companyId, companyId), eq(schema.companyVariables.key, key))).get();
  if (dup) return c.json({ error: `a variable with key "${key}" already exists for this company` }, 409);

  const isSecret = body.is_secret ?? false;
  if (isSecret && !body.value) return c.json({ error: 'value is required for a new secret' }, 400);

  const id = crypto.randomUUID();
  const values: typeof schema.companyVariables.$inferInsert = {
    id, companyId, key, isSecret, description: body.description || null,
    value: null, valueCiphertext: null, valueNonce: null,
    createdAt: now, updatedAt: now,
  };
  if (isSecret) {
    const { ciphertext, nonce } = await encryptSecret(body.value!, c.env.CONFIG_ENCRYPTION_KEY);
    values.valueCiphertext = ciphertext;
    values.valueNonce = nonce;
  } else {
    values.value = body.value ?? null;
  }

  await db.insert(schema.companyVariables).values(values);
  const row = await db.select().from(schema.companyVariables).where(eq(schema.companyVariables.id, id)).get();
  return c.json(shapeVariable(row!), 201);
});

adminCompanies.patch('/:id/variables/:varId', async (c) => {
  if (!(await auth(c, 'admin'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);
  const varId = c.req.param('varId');

  const existing = await db.select().from(schema.companyVariables).where(eq(schema.companyVariables.id, varId)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<{ value?: string | null; description?: string | null }>();
  const updates: Partial<typeof schema.companyVariables.$inferInsert> = { updatedAt: now };

  if ('description' in body) updates.description = body.description || null;

  // Blank/omitted value means "keep existing" — same convention as
  // sso_providers/email_settings, since a secret's plaintext is never sent
  // back to the client to prefill a form with in the first place.
  if (body.value) {
    if (existing.isSecret) {
      const { ciphertext, nonce } = await encryptSecret(body.value, c.env.CONFIG_ENCRYPTION_KEY);
      updates.valueCiphertext = ciphertext;
      updates.valueNonce = nonce;
    } else {
      updates.value = body.value;
    }
  }

  await db.update(schema.companyVariables).set(updates).where(eq(schema.companyVariables.id, varId));
  const row = await db.select().from(schema.companyVariables).where(eq(schema.companyVariables.id, varId)).get();
  return c.json(shapeVariable(row!));
});

adminCompanies.delete('/:id/variables/:varId', async (c) => {
  if (!(await auth(c, 'admin'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  await db.delete(schema.companyVariables).where(eq(schema.companyVariables.id, c.req.param('varId')));
  return c.json({ ok: true });
});

// ── Network Discovery ────────────────────────────────────────────────────
// One config per company (UNIQUE company_id) -- see worker/src/lib/discovery.ts
// for the scheduled-dispatch half. Same technician-mutate/readonly-view tier
// as the other nested resources on this file.

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

// Prefix >= 20 caps a single range at 4096 addresses -- a broader range
// (e.g. a /8) would be catastrophic for a periodically-repeating scan to
// walk. The agent also defensively caps this independently (defense in
// depth, since a payload reaches it via the commands table with no further
// validation at dispatch time).
function isValidCidr(value: string): boolean {
  const m = CIDR_RE.exec(value.trim());
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  return octets.every(o => o >= 0 && o <= 255) && prefix >= 20 && prefix <= 32;
}

adminCompanies.get('/:id/discovery', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const config = await db.select().from(schema.networkDiscoveryConfigs)
    .where(eq(schema.networkDiscoveryConfigs.companyId, c.req.param('id'))).get();
  if (!config) return c.json(null);
  return c.json({ ...config, cidrRanges: JSON.parse(config.cidrRanges) });
});

adminCompanies.post('/:id/discovery', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);
  const companyId = c.req.param('id');

  const body = await c.req.json<{
    probe_device_id: string;
    cidr_ranges: string[];
    scan_interval_minutes?: number;
    enabled?: boolean;
    snmp_enabled?: boolean;
    ssh_enabled?: boolean;
  }>();

  if (!body.probe_device_id) return c.json({ error: 'probe_device_id is required' }, 400);
  if (!body.cidr_ranges?.length) return c.json({ error: 'at least one CIDR range is required' }, 400);
  const badRange = body.cidr_ranges.find(r => !isValidCidr(r));
  if (badRange) return c.json({ error: `"${badRange}" is not a valid CIDR range of /20 or smaller (e.g. 192.168.1.0/24)` }, 400);

  const probe = await db.select({
    id: schema.devices.id, companyId: schema.devices.companyId, status: schema.devices.status,
    detectedClass: schema.devices.detectedClass, overrideClass: schema.devices.overrideClass,
  }).from(schema.devices).where(eq(schema.devices.id, body.probe_device_id)).get();
  if (!probe || probe.companyId !== companyId) return c.json({ error: 'probe device not found for this company' }, 400);
  if (probe.status !== 'approved') return c.json({ error: 'probe device must be an approved device' }, 400);
  const effectiveClass = probe.overrideClass ?? probe.detectedClass;
  if (effectiveClass === 'laptop') return c.json({ error: 'a laptop cannot be the discovery probe -- it needs to be an always-on server or workstation' }, 400);

  const values = {
    companyId,
    probeDeviceId: body.probe_device_id,
    enabled: body.enabled ?? true,
    cidrRanges: JSON.stringify(body.cidr_ranges),
    scanIntervalMinutes: body.scan_interval_minutes ?? 360,
    // Credentialed Network Discovery (issue #78) -- these are just the
    // per-company opt-in toggles; the actual credentials live in
    // company_variables under a fixed key-name convention, looked up at
    // dispatch time (see worker/src/lib/discovery.ts).
    snmpEnabled: body.snmp_enabled ?? false,
    sshEnabled: body.ssh_enabled ?? false,
    updatedAt: now,
  };

  const existing = await db.select({ id: schema.networkDiscoveryConfigs.id }).from(schema.networkDiscoveryConfigs)
    .where(eq(schema.networkDiscoveryConfigs.companyId, companyId)).get();
  if (existing) {
    await db.update(schema.networkDiscoveryConfigs).set(values).where(eq(schema.networkDiscoveryConfigs.id, existing.id));
  } else {
    await db.insert(schema.networkDiscoveryConfigs).values({ id: crypto.randomUUID(), createdAt: now, ...values });
  }

  const row = await db.select().from(schema.networkDiscoveryConfigs).where(eq(schema.networkDiscoveryConfigs.companyId, companyId)).get();
  return c.json({ ...row!, cidrRanges: JSON.parse(row!.cidrRanges) });
});

adminCompanies.post('/:id/discovery/scan-now', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);
  const companyId = c.req.param('id');

  const config = await db.select().from(schema.networkDiscoveryConfigs)
    .where(eq(schema.networkDiscoveryConfigs.companyId, companyId)).get();
  if (!config) return c.json({ error: 'no discovery configuration for this company' }, 404);

  const scanPayload = await buildDiscoveryScanPayload(c.env.DB, c.env.CONFIG_ENCRYPTION_KEY, config);
  const scanId = crypto.randomUUID();

  await db.insert(schema.commands).values({
    id: scanId,
    deviceId: config.probeDeviceId,
    companyId,
    type: 'network_scan',
    payload: await signCommandPayload(scanId, config.probeDeviceId, JSON.parse(scanPayload) as Record<string, unknown>, c.env.CONFIG_ENCRYPTION_KEY),
    status: 'queued',
    createdAt: now,
  });
  await db.update(schema.networkDiscoveryConfigs).set({ lastScannedAt: now }).where(eq(schema.networkDiscoveryConfigs.id, config.id));

  return c.json({ ok: true });
});

adminCompanies.get('/:id/discovered-devices', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const rows = await db.select().from(schema.discoveredDevices)
    .where(eq(schema.discoveredDevices.companyId, c.req.param('id')))
    .orderBy(desc(schema.discoveredDevices.lastSeenAt))
    .all();
  return c.json(rows);
});

adminCompanies.patch('/:id/discovered-devices/:deviceId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  const body = await c.req.json<{ dismissed?: boolean }>();
  if (body.dismissed === undefined) return c.json({ error: 'nothing to update' }, 400);

  await db.update(schema.discoveredDevices).set({ dismissed: body.dismissed })
    .where(eq(schema.discoveredDevices.id, c.req.param('deviceId')));
  return c.json({ ok: true });
});

adminCompanies.delete('/:id/discovered-devices/:deviceId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });

  await db.delete(schema.discoveredDevices).where(eq(schema.discoveredDevices.id, c.req.param('deviceId')));
  return c.json({ ok: true });
});

export default adminCompanies;
