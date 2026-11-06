import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Bindings } from '../index';
import * as schema from '../db/schema';
import { requireUser } from '../lib/auth';
import { issueGptConfirmToken, cancelGptTask, sha256Hex } from '../lib/gptBridge';

// Operator-side helpers for the ChatGPT bridge. ChatGPT itself only ever
// touches the gpt_tasks table through the Cloudflare D1 API; these routes are
// for the human operator: minting approval tokens for dangerous operations
// and cancelling tasks. Admin-only via requireUser (break-glass works).
const gptBridge = new Hono<{ Bindings: Bindings }>();

gptBridge.use('*', async (c, next) => {
  const user = await requireUser(c.req.header('Authorization'), c.env, 'admin');
  if (!user) return c.json({ error: 'forbidden' }, 403);
  await next();
});

// GET confirm token for a pending_confirm task. Read-only in intent: the
// token is derived state, bound to this exact task (request_id + device +
// action hash) and expiring with it.
gptBridge.get('/tasks/:id/confirm-token', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const task = await db.select().from(schema.gptTasks).where(eq(schema.gptTasks.id, c.req.param('id'))).get();
  if (!task) return c.json({ error: 'not_found' }, 404);
  if (task.status !== 'pending_confirm') {
    return c.json({ error: 'not_pending_confirm', status: task.status }, 409);
  }
  const actionHash = await sha256Hex(`${task.kind}\n${task.script}`);
  const token = await issueGptConfirmToken(
    {
      v: 1,
      requestId: task.requestId,
      deviceId: task.deviceId,
      actionHash,
      nonce: crypto.randomUUID(),
      expiresAt: task.expiresAt,
    },
    c.env.CONFIG_ENCRYPTION_KEY,
  );
  return c.json({
    task_id: task.id,
    request_id: task.requestId,
    classification: task.classification,
    script_preview: task.script.slice(0, 500),
    confirm_token: token,
    expires_at: task.expiresAt,
  });
});

// POST /tasks/:id/cancel — operator cancel (queued command killed if unsent).
gptBridge.post('/tasks/:id/cancel', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const ok = await cancelGptTask(db, c.req.param('id'), Math.floor(Date.now() / 1000));
  return ok ? c.json({ ok: true }) : c.json({ ok: false, error: 'already_terminal' }, 409);
});

// GET /tasks/:id — operator view of a single task (full row incl. result).
gptBridge.get('/tasks/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const task = await db.select().from(schema.gptTasks).where(eq(schema.gptTasks.id, c.req.param('id'))).get();
  if (!task) return c.json({ error: 'not_found' }, 404);
  return c.json({ task });
});

export default gptBridge;
