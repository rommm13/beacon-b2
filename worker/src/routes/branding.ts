import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Bindings } from '../index';
import * as schema from '../db/schema';
import { requireUser } from '../lib/auth';
import { resolveStorage } from '../lib/storage';

export const THEME_KEYS = [
  'canvas', 'surface', 'surfaceRaised', 'surfaceBrand', 'border', 'borderStrong',
  'textPrimary', 'textMuted', 'textSubtle', 'textOnPrimary', 'primary',
  'primaryHover', 'success', 'warning', 'danger', 'info',
] as const;
export type ThemeKey = typeof THEME_KEYS[number];
export type ThemeTokens = Record<ThemeKey, string>;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_PUBLISHED_REVISIONS = 5;

function parseTokens(value: unknown): ThemeTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== THEME_KEYS.length || !THEME_KEYS.every(k => COLOR_RE.test(String(record[k] ?? '')))) return null;
  return Object.fromEntries(THEME_KEYS.map(k => [k, String(record[k]).toLowerCase()])) as ThemeTokens;
}

function noStore(c: any) { c.header('Cache-Control', 'no-store'); }
function immutable(c: any) { c.header('Cache-Control', 'public, max-age=31536000, immutable'); }
async function admin(c: any) { return requireUser(c.req.header('Authorization'), c.env, 'admin'); }

function logosStorage(env: Bindings) {
  return resolveStorage({
    b2: {
      B2_KEY_ID: env.B2_KEY_ID,
      B2_APPLICATION_KEY: env.B2_APPLICATION_KEY,
      B2_BUCKET: env.B2_BUCKET_LOGOS ?? env.B2_BUCKET,
      B2_ENDPOINT: env.B2_ENDPOINT,
      B2_REGION: env.B2_REGION,
    },
    r2: env.LOGOS,
  });
}

const branding = new Hono<{ Bindings: Bindings }>();

// Tiny pointer: built-ins return their immutable palette directly; custom
// themes return a cacheable published revision pointer.
branding.get('/active', async (c) => {
  noStore(c);
  const row = await c.env.DB.prepare(`
    SELECT t.id AS theme_id, t.name, t.source, t.draft_tokens,
      r.id AS revision_id, r.revision, r.published_at
    FROM branding_settings s
    JOIN branding_themes t ON t.id = s.active_theme_id
    LEFT JOIN branding_theme_revisions r ON r.id = s.active_revision_id
    WHERE s.id = 1
  `).first<{ theme_id: string; name: string; source: 'built_in' | 'custom'; draft_tokens: string; revision_id: string | null; revision: number | null; published_at: number | null }>();
  if (!row) return c.json({ error: 'branding is not configured' }, 404);
  if (row.source === 'built_in') {
    const tokens = parseTokens(JSON.parse(row.draft_tokens));
    if (!tokens) return c.json({ error: 'invalid built-in theme' }, 500);
    return c.json({ themeId: row.theme_id, name: row.name, tokens });
  }
  if (!row.revision_id || row.revision === null || row.published_at === null) return c.json({ error: 'active custom theme has no published revision' }, 500);
  return c.json({ revisionId: row.revision_id, themeId: row.theme_id, name: row.name, revision: row.revision, publishedAt: row.published_at });
});

branding.get('/revisions/:id', async (c) => {
  const row = await drizzle(c.env.DB, { schema }).select({ id: schema.brandingThemeRevisions.id, tokens: schema.brandingThemeRevisions.tokens })
    .from(schema.brandingThemeRevisions).where(eq(schema.brandingThemeRevisions.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'theme revision not found' }, 404);
  const tokens = parseTokens(JSON.parse(row.tokens));
  if (!tokens) return c.json({ error: 'invalid theme revision' }, 500);
  immutable(c);
  return c.json({ id: row.id, tokens });
});

// Product identity (name + logo). Kept separate from the theme-activation
// pointer above — same "tiny pointer" shape as /active, but a different concern.
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg',
};

branding.get('/identity', async (c) => {
  noStore(c);
  const row = await drizzle(c.env.DB, { schema }).select().from(schema.brandingIdentity).where(eq(schema.brandingIdentity.id, 1)).get();
  // Dual-purpose: the dashboard's own pre-login branding pointer, and (as of
  // supportUrl) the Go agent's independent poll source for the tray's Get
  // Support menu item -- both are equally fine consuming unauthenticated,
  // host-wide config, so this stays one endpoint rather than splitting by
  // audience. See CLAUDE.md's Branding section.
  return c.json({ productName: row?.productName ?? '', logoKey: row?.logoKey ?? null, supportUrl: row?.supportUrl ?? null });
});

branding.get('/logo/:key', async (c) => {
  const storage = logosStorage(c.env);
  const obj = await storage.get(c.req.param('key'));
  if (!obj) return c.json({ error: 'logo not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(obj.body, 200, Object.fromEntries(headers));
});

branding.patch('/admin/identity', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ productName?: string; supportUrl?: string | null }>();
  if (typeof body.productName !== 'string') return c.json({ error: 'productName is required' }, 400);
  const updates: Partial<typeof schema.brandingIdentity.$inferInsert> = {
    productName: body.productName.trim(),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  if (body.supportUrl !== undefined) {
    const trimmed = (body.supportUrl ?? '').trim();
    if (trimmed === '') {
      updates.supportUrl = null;
    } else {
      // Validated here, not just for tidiness -- this string is later
      // shelled out as a literal `cmd /c start "" <url>` argument on every
      // enrolled Windows device (agent/cmd/beacon-tray's openBrowser), same
      // "validate before it reaches a shelled-out agent-side command"
      // convention as Network Discovery's CIDR check and Patch Management's
      // update_ids GUID check before wuinstall.
      try {
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      } catch {
        return c.json({ error: 'supportUrl must be a valid http(s) URL' }, 400);
      }
      updates.supportUrl = trimmed;
    }
  }
  await drizzle(c.env.DB, { schema }).update(schema.brandingIdentity).set(updates).where(eq(schema.brandingIdentity.id, 1));
  return c.json({ ok: true });
});

branding.post('/admin/logo', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const contentType = c.req.header('content-type') ?? '';
  const ext = LOGO_CONTENT_TYPES[contentType];
  if (!ext) return c.json({ error: 'logo must be image/jpeg, image/png, image/gif, or image/svg+xml' }, 400);
  const declaredLen = Number(c.req.header('content-length') ?? '0');
  if (declaredLen > MAX_LOGO_BYTES) return c.json({ error: 'logo must be 1MB or smaller' }, 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_LOGO_BYTES) return c.json({ error: 'logo must be 1MB or smaller' }, 413);

  const db = drizzle(c.env.DB, { schema });
  const existing = await db.select({ logoKey: schema.brandingIdentity.logoKey }).from(schema.brandingIdentity).where(eq(schema.brandingIdentity.id, 1)).get();
  const key = `${crypto.randomUUID()}.${ext}`;
  const storage = logosStorage(c.env);
  await storage.put(key, bytes, { httpMetadata: { contentType } });
  await db.update(schema.brandingIdentity).set({ logoKey: key, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(schema.brandingIdentity.id, 1));
  if (existing?.logoKey) await storage.delete(existing.logoKey);
  return c.json({ logoKey: key }, 201);
});

branding.delete('/admin/logo', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const existing = await db.select({ logoKey: schema.brandingIdentity.logoKey }).from(schema.brandingIdentity).where(eq(schema.brandingIdentity.id, 1)).get();
  await db.update(schema.brandingIdentity).set({ logoKey: null, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(schema.brandingIdentity.id, 1));
  if (existing?.logoKey) await logosStorage(c.env).delete(existing.logoKey);
  return c.json({ ok: true });
});

branding.get('/admin/themes', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const themes = await db.select().from(schema.brandingThemes).all();
  const active = await db.select({ activeThemeId: schema.brandingSettings.activeThemeId }).from(schema.brandingSettings).where(eq(schema.brandingSettings.id, 1)).get();
  const revisions = await db.select().from(schema.brandingThemeRevisions).orderBy(desc(schema.brandingThemeRevisions.publishedAt)).all();
  return c.json(themes.map(theme => ({
    id: theme.id, name: theme.name, source: theme.source,
    draftTokens: parseTokens(JSON.parse(theme.draftTokens)),
    revisions: theme.source === 'custom' ? revisions.filter(r => r.themeId === theme.id).map(r => ({ id: r.id, revision: r.revision, publishedAt: r.publishedAt })) : [],
    active: active?.activeThemeId === theme.id,
  })));
});

branding.post('/admin/themes', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ name?: string; tokens?: unknown }>();
  const name = body.name?.trim(); const tokens = parseTokens(body.tokens);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!tokens) return c.json({ error: 'a complete valid palette is required' }, 400);
  const id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  await drizzle(c.env.DB, { schema }).insert(schema.brandingThemes).values({ id, name, source: 'custom', draftTokens: JSON.stringify(tokens), createdAt: now, updatedAt: now });
  return c.json({ id }, 201);
});

branding.patch('/admin/themes/:id', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ name?: string; tokens?: unknown }>();
  const db = drizzle(c.env.DB, { schema });
  const theme = await db.select().from(schema.brandingThemes).where(eq(schema.brandingThemes.id, c.req.param('id'))).get();
  if (!theme) return c.json({ error: 'theme not found' }, 404);
  if (theme.source === 'built_in') return c.json({ error: 'built-in themes cannot be edited' }, 403);
  const updates: Partial<typeof schema.brandingThemes.$inferInsert> = { updatedAt: Math.floor(Date.now() / 1000) };
  if (body.name !== undefined) { if (!body.name.trim()) return c.json({ error: 'name is required' }, 400); updates.name = body.name.trim(); }
  if (body.tokens !== undefined) { const tokens = parseTokens(body.tokens); if (!tokens) return c.json({ error: 'a complete valid palette is required' }, 400); updates.draftTokens = JSON.stringify(tokens); }
  await db.update(schema.brandingThemes).set(updates).where(eq(schema.brandingThemes.id, theme.id));
  return c.json({ ok: true });
});

branding.post('/admin/themes/:id/publish', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const theme = await db.select().from(schema.brandingThemes).where(eq(schema.brandingThemes.id, c.req.param('id'))).get();
  if (!theme) return c.json({ error: 'theme not found' }, 404);
  if (theme.source === 'built_in') return c.json({ error: 'built-in themes are already published' }, 400);
  const tokens = parseTokens(JSON.parse(theme.draftTokens)); if (!tokens) return c.json({ error: 'invalid draft palette' }, 400);
  const last = await db.select({ revision: schema.brandingThemeRevisions.revision }).from(schema.brandingThemeRevisions)
    .where(eq(schema.brandingThemeRevisions.themeId, theme.id)).orderBy(desc(schema.brandingThemeRevisions.revision)).get();
  const revision = (last?.revision ?? 0) + 1, id = `${theme.id}-v${revision}`, now = Math.floor(Date.now() / 1000);
  await db.insert(schema.brandingThemeRevisions).values({ id, themeId: theme.id, revision, tokens: JSON.stringify(tokens), publishedAt: now });

  // Keep a compact rollback history. The currently active revision is always
  // protected, even if it is older than the four most-recent inactive ones.
  const active = await db.select({ activeRevisionId: schema.brandingSettings.activeRevisionId })
    .from(schema.brandingSettings).where(eq(schema.brandingSettings.id, 1)).get();
  const revisions = await db.select({ id: schema.brandingThemeRevisions.id, revision: schema.brandingThemeRevisions.revision })
    .from(schema.brandingThemeRevisions).where(eq(schema.brandingThemeRevisions.themeId, theme.id))
    .orderBy(desc(schema.brandingThemeRevisions.revision)).all();
  const retained = [...revisions];
  let pruned = 0;
  while (retained.length > MAX_PUBLISHED_REVISIONS) {
    const oldestInactive = [...retained].reverse().find(r => r.id !== active?.activeRevisionId);
    if (!oldestInactive) break;
    await db.delete(schema.brandingThemeRevisions).where(eq(schema.brandingThemeRevisions.id, oldestInactive.id));
    retained.splice(retained.findIndex(r => r.id === oldestInactive.id), 1);
    pruned++;
  }
  return c.json({ id, revision, publishedAt: now, pruned }, 201);
});

branding.post('/admin/themes/:id/activate', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const theme = await db.select().from(schema.brandingThemes).where(eq(schema.brandingThemes.id, c.req.param('id'))).get();
  if (!theme) return c.json({ error: 'theme not found' }, 404);
  if (theme.source !== 'built_in') return c.json({ error: 'publish and activate a revision for host-created themes' }, 400);
  await db.update(schema.brandingSettings).set({ activeThemeId: theme.id, activeRevisionId: null, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(schema.brandingSettings.id, 1));
  return c.json({ ok: true });
});

branding.post('/admin/revisions/:id/activate', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const revision = await db.select({ id: schema.brandingThemeRevisions.id, themeId: schema.brandingThemeRevisions.themeId }).from(schema.brandingThemeRevisions).where(eq(schema.brandingThemeRevisions.id, c.req.param('id'))).get();
  if (!revision) return c.json({ error: 'theme revision not found' }, 404);
  await db.update(schema.brandingSettings).set({ activeThemeId: revision.themeId, activeRevisionId: revision.id, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(schema.brandingSettings.id, 1));
  return c.json({ ok: true });
});

branding.delete('/admin/themes/:id', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const theme = await db.select().from(schema.brandingThemes).where(eq(schema.brandingThemes.id, c.req.param('id'))).get();
  if (!theme) return c.json({ error: 'theme not found' }, 404);
  if (theme.source === 'built_in') return c.json({ error: 'built-in themes cannot be deleted' }, 403);
  const active = await db.select({ activeThemeId: schema.brandingSettings.activeThemeId }).from(schema.brandingSettings).where(eq(schema.brandingSettings.id, 1)).get();
  if (active?.activeThemeId === theme.id) return c.json({ error: 'activate another theme before deleting this one' }, 409);
  await db.delete(schema.brandingThemes).where(eq(schema.brandingThemes.id, theme.id));
  return c.json({ ok: true });
});

export default branding;
