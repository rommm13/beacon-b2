import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Bindings } from '../../index';
import * as schema from '../../db/schema';
import { requireUser } from '../../lib/auth';
import { resolveStorage } from '../../lib/storage';

// Global RustDesk relay/rendezvous server config -- singleton (id=1), see
// schema.rustdeskSettings's own doc comment. Admin-only both ways: unlike
// branding identity, nothing here is consumed pre-login or by the agent yet
// (no agent-side RustDesk install exists), so there's no case for a public
// GET.
async function admin(c: any) { return requireUser(c.req.header('Authorization'), c.env, 'admin'); }

const rustdeskSettings = new Hono<{ Bindings: Bindings }>();

rustdeskSettings.get('/', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const row = await db.select().from(schema.rustdeskSettings).where(eq(schema.rustdeskSettings.id, 1)).get();
  const installer = await db.select().from(schema.rustdeskInstaller).where(eq(schema.rustdeskInstaller.id, 1)).get();
  return c.json({
    idServer: row?.idServer ?? null,
    relayServer: row?.relayServer ?? null,
    key: row?.key ?? null,
    installer: installer?.objectKey ? {
      version: installer.version,
      sizeBytes: installer.sizeBytes,
      uploadedAt: installer.uploadedAt,
    } : null,
  });
});

// Raw-binary upload of the pinned RustDesk installer, mirroring
// components.ts's application-file upload convention: the dashboard
// computes SHA-256 client-side (Workers can't cheaply hash a streamed R2
// put) and declares it via X-File-SHA256, cross-checked against
// Content-Length rather than re-hashed server-side. Put-then-commit-then-
// delete-old, same safety ordering as Branding's logo upload -- a
// mid-failure never leaves zero valid installers.
const MAX_INSTALLER_BYTES = 100 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

rustdeskSettings.post('/admin/installer', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const version = c.req.header('X-File-Version')?.trim();
  const sha256 = c.req.header('X-File-SHA256')?.trim().toLowerCase();
  const declaredSize = Number(c.req.header('X-File-Size') ?? '');
  const contentLength = Number(c.req.header('Content-Length') ?? '');
  if (!version) return c.json({ error: 'X-File-Version is required' }, 400);
  if (!sha256 || !SHA256_RE.test(sha256)) return c.json({ error: 'X-File-SHA256 must be a lowercase SHA-256 hex digest' }, 400);
  if (!Number.isInteger(declaredSize) || declaredSize < 1) return c.json({ error: 'X-File-Size is required' }, 400);
  if (!Number.isInteger(contentLength) || contentLength !== declaredSize) {
    return c.json({ error: 'Content-Length must match X-File-Size' }, 400);
  }
  if (declaredSize > MAX_INSTALLER_BYTES) return c.json({ error: 'installer exceeds the 100 MiB limit' }, 413);
  if (!c.req.raw.body) return c.json({ error: 'file body required' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const storage = resolveStorage({
    b2: {
      B2_KEY_ID: c.env.B2_APPLICATION_KEY_ID,
      B2_APPLICATION_KEY: c.env.B2_APPLICATION_KEY,
      B2_BUCKET: c.env.B2_BUCKET_COMPONENT_FILES,
      B2_ENDPOINT: c.env.B2_ENDPOINT,
    },
    r2: c.env.COMPONENT_FILES,
  });
  const existing = await db.select({ objectKey: schema.rustdeskInstaller.objectKey }).from(schema.rustdeskInstaller).where(eq(schema.rustdeskInstaller.id, 1)).get();
  const objectKey = `rustdesk-installer/${crypto.randomUUID()}`;
  await storage.put(objectKey, c.req.raw.body, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  await db.update(schema.rustdeskInstaller).set({
    objectKey, version, sha256, sizeBytes: declaredSize, uploadedAt: Math.floor(Date.now() / 1000),
  }).where(eq(schema.rustdeskInstaller.id, 1));
  if (existing?.objectKey) await storage.delete(existing.objectKey);
  return c.json({ ok: true }, 201);
});

rustdeskSettings.patch('/', async (c) => {
  if (!(await admin(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ id_server?: string | null; relay_server?: string | null; key?: string | null }>();
  const updates: Partial<typeof schema.rustdeskSettings.$inferInsert> = {
    updatedAt: Math.floor(Date.now() / 1000),
  };
  // No secret-bearing field here (unlike email_settings), so a blank/empty
  // value just clears the column rather than needing a "blank means keep
  // existing" merge -- each field is independently settable to null.
  if (body.id_server !== undefined) updates.idServer = body.id_server?.trim() || null;
  if (body.relay_server !== undefined) updates.relayServer = body.relay_server?.trim() || null;
  if (body.key !== undefined) updates.key = body.key?.trim() || null;
  await drizzle(c.env.DB, { schema }).update(schema.rustdeskSettings).set(updates).where(eq(schema.rustdeskSettings.id, 1));
  return c.json({ ok: true });
});

export default rustdeskSettings;
