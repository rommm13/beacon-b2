import { Hono } from 'hono';
import type { Bindings } from '../index';
import { sha256hex } from '../lib/crypto';
import { resolveStorage } from '../lib/storage';

const componentFiles = new Hono<{ Bindings: Bindings }>();

function componentFilesStorage(env: Bindings) {
  return resolveStorage({
    b2: {
      B2_KEY_ID: env.B2_KEY_ID,
      B2_APPLICATION_KEY: env.B2_APPLICATION_KEY,
      B2_BUCKET: env.B2_BUCKET_COMPONENT_FILES ?? env.B2_BUCKET,
      B2_ENDPOINT: env.B2_ENDPOINT,
      B2_REGION: env.B2_REGION,
    },
    r2: env.COMPONENT_FILES,
  });
}

// An enrolled agent retrieves a component file with two independent proofs:
// its long-lived device credential and the short-lived, command-specific grant
// token stored only in the command payload. The R2 object key is never sent to
// the dashboard or agent.
componentFiles.post('/download', async (c) => {
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
    `SELECT g.id, f.object_key, f.content_type, f.original_name, f.size_bytes, d.device_credential_hash, d.status AS device_status, c.status AS command_status
     FROM component_file_downloads g
     JOIN component_files f ON f.id = g.component_file_id
     JOIN devices d ON d.id = g.device_id
     JOIN commands c ON c.id = g.command_id
     WHERE g.token_hash = ? AND g.expires_at > ?`
  ).bind(tokenHash, now).first<{
    id: string; object_key: string; content_type: string | null; original_name: string; size_bytes: number;
    device_credential_hash: string; device_status: string; command_status: string;
  }>();
  if (!grant) return c.json({ error: 'download grant expired or not found' }, 404);
  if (grant.device_credential_hash !== credentialHash) return c.json({ error: 'download grant does not belong to this device' }, 403);
  if (grant.device_status === 'revoked') return c.json({ error: 'device revoked' }, 403);
  if (grant.command_status !== 'queued' && grant.command_status !== 'sent') return c.json({ error: 'command is no longer active' }, 409);

  // Mark downloaded_at before serving (atomically where possible via conditional UPDATE).
  await c.env.DB.prepare(
    `UPDATE component_file_downloads SET downloaded_at = ? WHERE id = ? AND downloaded_at IS NULL`
  ).bind(now, grant.id).run();

  const storage = componentFilesStorage(c.env);
  const object = await storage.get(grant.object_key);
  if (!object) return c.json({ error: 'component file unavailable' }, 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': grant.content_type ?? 'application/octet-stream',
      'Content-Length': String(grant.size_bytes),
      'Content-Disposition': `attachment; filename="${grant.original_name.replace(/["\\]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  });
});

export default componentFiles;
