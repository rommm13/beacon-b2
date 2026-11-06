import { Hono } from 'hono';
import type { Bindings } from '../index';
import { sha256hex } from '../lib/crypto';
import { resolveStorage } from '../lib/storage';

const rustdeskInstallerDownload = new Hono<{ Bindings: Bindings }>();

// An enrolled agent retrieves the pinned RustDesk installer with two
// independent proofs, exactly mirroring component-files.ts's own download
// handler: its long-lived device credential and the short-lived,
// command-specific grant token stored only in the install_rustdesk
// command's payload. The R2 object key is never sent to the dashboard or
// agent.
rustdeskInstallerDownload.post('/download', async (c) => {
  const authorization = c.req.header('Authorization');
  if (!authorization?.startsWith('Bearer ')) return c.json({ error: 'missing authorization' }, 401);

  let body: { token?: string };
  try {
    body = await c.req.json<{ token?: string }>();
  } catch {
    return c.json({ error: 'invalid request body' }, 400);
  }
  if (!body.token || body.token.length < 32) return c.json({ error: 'invalid download token' }, 400);

  const [credentialHash, tokenHash] = await Promise.all([
    sha256hex(authorization.slice(7)),
    sha256hex(body.token),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const grant = await c.env.DB.prepare(
    `SELECT g.id, i.object_key, i.size_bytes, d.device_credential_hash, d.status AS device_status, c.status AS command_status
     FROM rustdesk_installer_downloads g
     JOIN rustdesk_installer i ON i.id = 1
     JOIN devices d ON d.id = g.device_id
     JOIN commands c ON c.id = g.command_id
     WHERE g.token_hash = ? AND g.expires_at > ?`
  ).bind(tokenHash, now).first<{
    id: string; object_key: string | null; size_bytes: number | null;
    device_credential_hash: string; device_status: string; command_status: string;
  }>();
  if (!grant) return c.json({ error: 'download grant expired or not found' }, 404);
  if (grant.device_credential_hash !== credentialHash) return c.json({ error: 'download grant does not belong to this device' }, 403);
  if (grant.device_status === 'revoked') return c.json({ error: 'device revoked' }, 403);
  if (grant.command_status !== 'queued' && grant.command_status !== 'sent') return c.json({ error: 'command is no longer active' }, 409);
  if (!grant.object_key) return c.json({ error: 'installer unavailable' }, 404);

  const storage = resolveStorage({
    b2: {
      B2_KEY_ID: c.env.B2_APPLICATION_KEY_ID,
      B2_APPLICATION_KEY: c.env.B2_APPLICATION_KEY,
      B2_BUCKET: c.env.B2_BUCKET_COMPONENT_FILES,
      B2_ENDPOINT: c.env.B2_ENDPOINT,
    },
    r2: c.env.COMPONENT_FILES,
  });
  const object = await storage.get(grant.object_key);
  if (!object) return c.json({ error: 'installer unavailable' }, 404);
  await c.env.DB.prepare(
    `UPDATE rustdesk_installer_downloads SET downloaded_at = ? WHERE id = ? AND downloaded_at IS NULL`
  ).bind(now, grant.id).run();

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(grant.size_bytes ?? 0),
      'Content-Disposition': 'attachment; filename="rustdesk-installer.exe"',
      'Cache-Control': 'no-store',
    },
  });
});

export default rustdeskInstallerDownload;
