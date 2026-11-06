import { Hono } from 'hono';
import type { Bindings } from '../../index';
import { requireUser, roleAtLeast, type Role } from '../../lib/auth';
import type { PostCondition } from '../../lib/postConditions';
import { resolveStorage, type StorageObjectBody } from '../../lib/storage';

const adminComponents = new Hono<{ Bindings: Bindings }>();

type VariableType = 'string' | 'selection' | 'boolean' | 'date';
const VALID_VARIABLE_TYPES: VariableType[] = ['string', 'selection', 'boolean', 'date'];
const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_COMPONENT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_COMPONENT_TOTAL_FILE_BYTES = 500 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

function auth(c: any, minRole: Role = 'readonly') {
  return requireUser(c.req.header('Authorization'), c.env, minRole);
}

function uid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function mapRow(r: any) {
  return {
    id:             r.id,
    name:           r.name,
    description:    r.description,
    category:       r.category,
    type:           r.type,
    origin:         r.origin,
    scope:          r.scope,
    shell:          r.shell,
    script:         r.script,
    timeoutSeconds: r.timeout_seconds,
    postConditions: JSON.parse(r.post_conditions || '[]') as PostCondition[],
    targetOs:       r.target_os ?? null,
    requiresAdmin:  Boolean(r.requires_admin),
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
  };
}

function mapCompany(r: any) {
  return { companyId: r.company_id, name: r.name };
}

function mapVariable(r: any) {
  return {
    id:            r.id,
    componentId:   r.component_id,
    name:          r.name,
    label:         r.label,
    type:          r.type,
    options:       r.options ? JSON.parse(r.options) : null,
    defaultValue:  r.default_value,
    description:   r.description,
    required:      Boolean(r.required),
    sortOrder:     r.sort_order,
    createdAt:     r.created_at,
  };
}

function mapFile(r: any) {
  return {
    id: r.id,
    componentId: r.component_id,
    originalName: r.original_name,
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    contentType: r.content_type,
    architecture: r.architecture,
    createdAt: r.created_at,
  };
}

function mapApplication(r: any) {
  return {
    componentId: r.component_id,
    installerFileId: r.installer_file_id,
    installerArguments: JSON.parse(r.installer_arguments || '[]'),
    timeoutSeconds: r.timeout_seconds,
    detectionType: r.detection_type,
    detectionValue: r.detection_value,
    architecture: r.architecture,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Fetch components and their nested metadata in fixed-count queries,
// merge in TS (mirrors policies.ts's listWithMonitors pattern) — avoids N+1
// lookups from the dashboard.
async function embedRelations(db: D1Database, rows: any[]) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const vars = await db.prepare(
    `SELECT * FROM component_variables WHERE component_id IN (${placeholders}) ORDER BY sort_order ASC`
  ).bind(...ids).all<any>();
  const varsByComponent = new Map<string, ReturnType<typeof mapVariable>[]>();
  for (const v of vars.results) {
    const mapped = mapVariable(v);
    if (!varsByComponent.has(mapped.componentId)) varsByComponent.set(mapped.componentId, []);
    varsByComponent.get(mapped.componentId)!.push(mapped);
  }

  const companiesResult = await db.prepare(
    `SELECT cs.component_id, cs.company_id, t.name FROM component_companies cs
     JOIN companies t ON t.id = cs.company_id
     WHERE cs.component_id IN (${placeholders}) ORDER BY t.name ASC`
  ).bind(...ids).all<any>();
  const companiesByComponent = new Map<string, ReturnType<typeof mapCompany>[]>();
  for (const s of companiesResult.results) {
    if (!companiesByComponent.has(s.component_id)) companiesByComponent.set(s.component_id, []);
    companiesByComponent.get(s.component_id)!.push(mapCompany(s));
  }

  const filesResult = await db.prepare(
    `SELECT * FROM component_files WHERE component_id IN (${placeholders}) ORDER BY created_at ASC`
  ).bind(...ids).all<any>();
  const filesByComponent = new Map<string, ReturnType<typeof mapFile>[]>();
  for (const f of filesResult.results) {
    const mapped = mapFile(f);
    if (!filesByComponent.has(mapped.componentId)) filesByComponent.set(mapped.componentId, []);
    filesByComponent.get(mapped.componentId)!.push(mapped);
  }

  const appsResult = await db.prepare(
    `SELECT * FROM component_applications WHERE component_id IN (${placeholders})`
  ).bind(...ids).all<any>();
  const applicationByComponent = new Map(appsResult.results.map(r => [r.component_id, mapApplication(r)]));

  return rows.map(r => ({
    ...mapRow(r),
    variables: varsByComponent.get(r.id) ?? [],
    companies: companiesByComponent.get(r.id) ?? [],
    files: filesByComponent.get(r.id) ?? [],
    application: applicationByComponent.get(r.id) ?? null,
  }));
}

function validateVariableBody(body: any): string | null {
  if (!body.name?.trim()) return 'variable name is required';
  if (!VARIABLE_NAME_RE.test(body.name)) return 'variable name must be a valid identifier (letters, numbers, underscore, not starting with a number)';
  if (!body.label?.trim()) return 'variable label is required';
  if (body.type !== undefined && !VALID_VARIABLE_TYPES.includes(body.type)) return 'invalid variable type';
  const type: VariableType = body.type ?? 'string';
  if (type === 'selection') {
    if (!Array.isArray(body.options) || body.options.length === 0) return 'selection variables require a non-empty options list';
    for (const opt of body.options) {
      if (typeof opt?.label !== 'string' || typeof opt?.value !== 'string') return 'each selection option needs a label and value';
    }
  }
  return null;
}

// ── GET /store — read-only, must be registered before GET /:id ──────────────
adminComponents.get('/store', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const result = await c.env.DB.prepare(
    `SELECT * FROM components WHERE origin = 'store' ORDER BY name ASC`
  ).all<any>();
  return c.json(await embedRelations(c.env.DB, result.results));
});

// GET /?company_id=<id> — list components. With no company_id, returns
// everything (used by the library list page). With company_id, returns only
// what's usable against that company: global components + components whose
// Companies list includes that company — used by job-creation flows targeting a
// single company.
adminComponents.get('/', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const companyId = c.req.query('company_id');

  const result = companyId
    ? await c.env.DB.prepare(
        `SELECT * FROM components WHERE scope = 'global' OR id IN (SELECT component_id FROM component_companies WHERE company_id = ?) ORDER BY name ASC`
      ).bind(companyId).all<any>()
    : await c.env.DB.prepare(`SELECT * FROM components ORDER BY name ASC`).all<any>();

  return c.json(await embedRelations(c.env.DB, result.results));
});

// ── Application file lifecycle ────────────────────────────────────────────
// These routes are deliberately registered ahead of /:id. Storage remains private:
// administrators write through this authenticated endpoint and devices later
// receive a short-lived capability, never an object URL.

function componentFilesStorage(c: any) {
  return resolveStorage({
    b2: {
      B2_KEY_ID: c.env.B2_APPLICATION_KEY_ID,
      B2_APPLICATION_KEY: c.env.B2_APPLICATION_KEY,
      B2_BUCKET: c.env.B2_BUCKET_COMPONENT_FILES,
      B2_ENDPOINT: c.env.B2_ENDPOINT,
    },
    r2: c.env.COMPONENT_FILES,
  });
}

adminComponents.post('/:id/files', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');
  const component = await c.env.DB.prepare(`SELECT type, origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);
  if (component.type !== 'application') return c.json({ error: 'files can only be attached to application components' }, 400);

  let originalName: string | undefined;
  try {
    originalName = decodeURIComponent(c.req.header('X-File-Name') ?? '').trim();
  } catch {
    return c.json({ error: 'X-File-Name is invalid' }, 400);
  }
  const sha256 = c.req.header('X-File-SHA256')?.trim().toLowerCase();
  const architecture = c.req.header('X-File-Architecture') ?? 'amd64';
  const declaredSize = Number(c.req.header('X-File-Size') ?? '');
  const contentLength = Number(c.req.header('Content-Length') ?? '');
  if (!originalName || originalName.length > 255) return c.json({ error: 'X-File-Name is required and must be at most 255 characters' }, 400);
  if (!sha256 || !SHA256_RE.test(sha256)) return c.json({ error: 'X-File-SHA256 must be a lowercase SHA-256 hex digest' }, 400);
  if (architecture !== 'amd64') return c.json({ error: 'only amd64 application files are supported' }, 400);
  if (!Number.isInteger(declaredSize) || declaredSize < 1) return c.json({ error: 'X-File-Size is required' }, 400);
  if (!Number.isInteger(contentLength) || contentLength !== declaredSize) {
    return c.json({ error: 'Content-Length must match X-File-Size' }, 400);
  }
  if (declaredSize > MAX_COMPONENT_FILE_BYTES) return c.json({ error: 'file exceeds the 100 MiB limit' }, 413);
  if (!c.req.raw.body) return c.json({ error: 'file body required' }, 400);

  const total = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM component_files WHERE component_id = ?`
  ).bind(componentId).first<{ bytes: number }>();
  if ((total?.bytes ?? 0) + declaredSize > MAX_COMPONENT_TOTAL_FILE_BYTES) {
    return c.json({ error: 'component file total exceeds the 500 MiB limit' }, 413);
  }
  // Windows file names are case-insensitive and the agent stages every
  // attachment into one directory, so reject names that would collide before
  // the package reaches a device.
  const duplicateName = await c.env.DB.prepare(
    `SELECT id FROM component_files WHERE component_id = ? AND lower(original_name) = lower(?)`
  ).bind(componentId, originalName).first<{ id: string }>();
  if (duplicateName) return c.json({ error: 'application file names must be unique' }, 409);

  const id = uid();
  const objectKey = `components/${componentId}/${id}`;
  const storage = componentFilesStorage(c);
  try {
    // Pass the request body stream through unchanged. For R2 this preserves
    // fixed-length handling; for B2 the adapter can stream/multipart as needed.
    // Validate the browser's automatic Content-Length against the dashboard's
    // declared size (checked above) and keep put-then-commit-then-delete order.
    await storage.put(objectKey, c.req.raw.body, {
      httpMetadata: { contentType: c.req.header('Content-Type') ?? 'application/octet-stream' },
      contentLength: declaredSize,
    });
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO component_files (id, component_id, original_name, object_key, sha256, size_bytes, content_type, architecture, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, componentId, originalName, objectKey, sha256, declaredSize, c.req.header('Content-Type') ?? null, architecture, now).run();
    const row = await c.env.DB.prepare(`SELECT * FROM component_files WHERE id = ?`).bind(id).first<any>();
    return c.json(mapFile(row), 201);
  } catch (err) {
    await storage.delete(objectKey);
    return c.json({ error: err instanceof Error ? err.message : 'file upload failed' }, 400);
  }
});

adminComponents.delete('/:id/files/:fileId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');
  const component = await c.env.DB.prepare(`SELECT origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);
  const file = await c.env.DB.prepare(`SELECT * FROM component_files WHERE id = ? AND component_id = ?`).bind(c.req.param('fileId'), componentId).first<any>();
  if (!file) return c.json({ error: 'file not found' }, 404);
  const installer = await c.env.DB.prepare(`SELECT component_id FROM component_applications WHERE installer_file_id = ?`).bind(file.id).first<any>();
  if (installer) return c.json({ error: 'choose another installer file before deleting this file' }, 409);
  const storage = componentFilesStorage(c);
  await c.env.DB.prepare(`DELETE FROM component_files WHERE id = ?`).bind(file.id).run();
  await storage.delete(file.object_key);
  return c.json({ ok: true });
});

adminComponents.put('/:id/application', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');
  const component = await c.env.DB.prepare(`SELECT type, origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);
  if (component.type !== 'application') return c.json({ error: 'application settings require an application component' }, 400);

  const body = await c.req.json<{
    installer_file_id: string; installer_arguments?: string[]; timeout_seconds?: number;
    detection_type?: 'none' | 'msi_product_code' | 'powershell'; detection_value?: string | null;
  }>();
  if (!body.installer_file_id) return c.json({ error: 'installer_file_id required' }, 400);
  const installer = await c.env.DB.prepare(`SELECT id FROM component_files WHERE id = ? AND component_id = ?`).bind(body.installer_file_id, componentId).first<any>();
  if (!installer) return c.json({ error: 'installer file must belong to this component' }, 400);
  if (body.installer_arguments !== undefined && (!Array.isArray(body.installer_arguments) || body.installer_arguments.some(a => typeof a !== 'string'))) {
    return c.json({ error: 'installer_arguments must be an array of strings' }, 400);
  }
  const timeout = body.timeout_seconds ?? 900;
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > 3600) return c.json({ error: 'timeout_seconds must be between 60 and 3600' }, 400);
  const detectionType = body.detection_type ?? 'none';
  if (!['none', 'msi_product_code', 'powershell'].includes(detectionType)) return c.json({ error: 'invalid detection_type' }, 400);
  if (detectionType !== 'none' && !body.detection_value?.trim()) return c.json({ error: 'detection_value required when detection is enabled' }, 400);

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO component_applications (component_id, installer_file_id, installer_arguments, timeout_seconds, detection_type, detection_value, architecture, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'amd64', ?, ?)
     ON CONFLICT(component_id) DO UPDATE SET installer_file_id = excluded.installer_file_id, installer_arguments = excluded.installer_arguments,
       timeout_seconds = excluded.timeout_seconds, detection_type = excluded.detection_type, detection_value = excluded.detection_value, updated_at = excluded.updated_at`
  ).bind(componentId, body.installer_file_id, JSON.stringify(body.installer_arguments ?? []), timeout, detectionType, detectionType === 'none' ? null : body.detection_value!.trim(), now, now).run();
  const row = await c.env.DB.prepare(`SELECT * FROM component_applications WHERE component_id = ?`).bind(componentId).first<any>();
  return c.json(mapApplication(row));
});

// GET /:id — single component
adminComponents.get('/:id', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const row = await c.env.DB.prepare(
    `SELECT * FROM components WHERE id = ?`
  ).bind(c.req.param('id')).first<any>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const [withRelations] = await embedRelations(c.env.DB, [row]);
  return c.json(withRelations);
});

// POST / — create component (always origin='custom' — store rows only come
// from the seed migration or /:id/clone)
adminComponents.post('/', async (c) => {
  const user = await auth(c, 'technician');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{
    name: string;
    description?: string | null;
    category?: string | null;
    type?: 'script' | 'application';
    scope?: 'global' | 'company';
    shell?: string;
    script?: string;
    timeout_seconds?: number;
    post_conditions?: PostCondition[];
    target_os?: string | null;
    requires_admin?: boolean;
  }>();

  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
  const type = body.type ?? 'script';
  if (type !== 'script' && type !== 'application') return c.json({ error: 'invalid component type' }, 400);
  if (type === 'script' && !body.script?.trim()) return c.json({ error: 'script required' }, 400);
  const scope = body.scope ?? 'global';

  // Only an admin may create a component already flagged as requiring
  // admin -- otherwise a technician could set it themselves and it would
  // mean nothing. Unflagged (the default) needs no elevated role.
  if (body.requires_admin === true && !roleAtLeast(user.role, 'admin')) {
    return c.json({ error: 'admin role required to flag a component as requiring admin' }, 403);
  }

  const id  = uid();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`
    INSERT INTO components (id, name, description, category, type, origin, scope, shell, script, timeout_seconds, post_conditions, target_os, requires_admin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.name.trim(),
    body.description ?? null,
    body.category ?? null,
    type,
    scope,
    type === 'application' ? 'auto' : (body.shell ?? 'auto'),
    type === 'application' ? '' : body.script!,
    body.timeout_seconds ?? 300,
    JSON.stringify(body.post_conditions ?? []),
    type === 'application' ? 'windows' : (body.target_os ?? null),
    body.requires_admin ?? false,
    now, now,
  ).run();

  // Companies are added afterward via POST /:id/companies (mirrors how variables are
  // batched onto a brand-new component) — a fresh component always starts
  // with an empty Companies list even when scope is 'company'.
  const row = await c.env.DB.prepare(`SELECT * FROM components WHERE id = ?`).bind(id).first<any>();
  const [withRelations] = await embedRelations(c.env.DB, [row]);
  return c.json(withRelations, 201);
});

// PATCH /:id — update component
adminComponents.patch('/:id', async (c) => {
  const user = await auth(c, 'technician');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id   = c.req.param('id');
  const body = await c.req.json<Partial<{
    name: string;
    description: string | null;
    category: string | null;
    type: 'script' | 'application';
    scope: 'global' | 'company';
    shell: string;
    script: string;
    timeout_seconds: number;
    post_conditions: PostCondition[];
    target_os: string | null;
    requires_admin: boolean;
  }>>();

  const row = await c.env.DB.prepare(`SELECT id, origin, type, requires_admin FROM components WHERE id = ?`).bind(id).first<any>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);

  // Only an admin may change requires_admin, in either direction -- a
  // technician un-flagging a component they're not supposed to run would
  // defeat the whole point. Editing every other field stays technician-level.
  if (body.requires_admin !== undefined && body.requires_admin !== Boolean(row.requires_admin) && !roleAtLeast(user.role, 'admin')) {
    return c.json({ error: 'admin role required to change requires_admin' }, 403);
  }

  if (body.type !== undefined && body.type !== 'script' && body.type !== 'application') {
    return c.json({ error: 'invalid component type' }, 400);
  }
  if (body.type === 'script' && row.type === 'application') {
    const files = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM component_files WHERE component_id = ?`).bind(id).first<{ n: number }>();
    if ((files?.n ?? 0) > 0) return c.json({ error: 'delete application files before changing this component to a script' }, 409);
  }

  const sets: string[] = ['updated_at = ?'];
  const vals: any[] = [Math.floor(Date.now() / 1000)];

  if (body.name        !== undefined) { sets.push('name = ?');            vals.push(body.name); }
  if (body.description !== undefined) { sets.push('description = ?');     vals.push(body.description); }
  if (body.category    !== undefined) { sets.push('category = ?');        vals.push(body.category); }
  if (body.type        !== undefined) {
    sets.push('type = ?'); vals.push(body.type);
    if (body.type === 'application') {
      sets.push('shell = ?', 'script = ?', 'target_os = ?');
      vals.push('auto', '', 'windows');
    }
  }
  if (body.scope       !== undefined) { sets.push('scope = ?');           vals.push(body.scope); }
  if (body.shell       !== undefined) { sets.push('shell = ?');           vals.push(body.shell); }
  if (body.script      !== undefined) { sets.push('script = ?');          vals.push(body.script); }
  if (body.timeout_seconds !== undefined) { sets.push('timeout_seconds = ?'); vals.push(body.timeout_seconds); }
  if (body.post_conditions !== undefined) { sets.push('post_conditions = ?'); vals.push(JSON.stringify(body.post_conditions)); }
  if (body.target_os       !== undefined && body.type !== 'application' && row.type !== 'application') { sets.push('target_os = ?'); vals.push(body.target_os); }
  if (body.requires_admin  !== undefined) { sets.push('requires_admin = ?');  vals.push(body.requires_admin); }

  vals.push(id);
  await c.env.DB.prepare(`UPDATE components SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  // Switching back to global drops any Companies membership — a "Remove all"
  // equivalent, so re-enabling company scope later starts from a clean list
  // rather than silently resurrecting stale companies.
  if (body.scope === 'global') {
    await c.env.DB.prepare(`DELETE FROM component_companies WHERE component_id = ?`).bind(id).run();
  }

  return c.json({ ok: true });
});

// DELETE /:id — delete component
adminComponents.delete('/:id', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const id  = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT id, origin FROM components WHERE id = ?`).bind(id).first<any>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);
  const files = await c.env.DB.prepare(`SELECT object_key FROM component_files WHERE component_id = ?`).bind(id).all<{ object_key: string }>();
  await c.env.DB.prepare(`DELETE FROM components WHERE id = ?`).bind(id).run();
  // Object storage does not participate in D1's foreign-key cascade, so remove the
  // corresponding private objects explicitly after the metadata is gone.
  const storage = componentFilesStorage(c);
  await Promise.all(files.results.map(file => storage.delete(file.object_key)));
  return c.json({ ok: true });
});

// ── POST /:id/clone — copy a component (any origin) into a fresh 'custom' one ──
adminComponents.post('/:id/clone', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const sourceId = c.req.param('id');
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });

  const source = await c.env.DB.prepare(`SELECT * FROM components WHERE id = ?`).bind(sourceId).first<any>();
  if (!source) return c.json({ error: 'not found' }, 404);

  // Verify source objects before making the clone row, so a missing private
  // object cannot leave a half-created application component behind.
  // Clone copies objects via get+put through the storage adapter.
  const storage = componentFilesStorage(c);
  const sourceFiles = await c.env.DB.prepare(
    `SELECT * FROM component_files WHERE component_id = ? ORDER BY created_at ASC`
  ).bind(sourceId).all<any>();
  const sourceObjects = new Map<string, StorageObjectBody | R2ObjectBody>();
  for (const file of sourceFiles.results) {
    const sourceObject = await storage.get(file.object_key);
    if (!sourceObject) return c.json({ error: 'source application file is unavailable' }, 409);
    sourceObjects.set(file.id, sourceObject as StorageObjectBody | R2ObjectBody);
  }

  const newId = uid();
  const now   = Math.floor(Date.now() / 1000);
  const name  = body.name?.trim() || `${source.name} (Copy)`;

  // requires_admin carries over as-is -- no bypass risk, since the clone
  // ends up equally restricted, not un-flagged; a technician cloning a
  // flagged component still can't run the result any more than the source.
  await c.env.DB.prepare(`
    INSERT INTO components (id, name, description, category, type, origin, scope, shell, script, timeout_seconds, post_conditions, target_os, requires_admin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId, name, source.description, source.category, source.type,
    source.scope,
    source.shell, source.script, source.timeout_seconds, source.post_conditions, source.target_os ?? null,
    source.requires_admin,
    now, now,
  ).run();

  const sourceVars = await c.env.DB.prepare(
    `SELECT * FROM component_variables WHERE component_id = ? ORDER BY sort_order ASC`
  ).bind(sourceId).all<any>();

  for (const v of sourceVars.results) {
    await c.env.DB.prepare(`
      INSERT INTO component_variables (id, component_id, name, label, type, options, default_value, description, required, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(uid(), newId, v.name, v.label, v.type, v.options, v.default_value, v.description, v.required, v.sort_order, now).run();
  }

  const sourceCompanies = await c.env.DB.prepare(
    `SELECT company_id FROM component_companies WHERE component_id = ?`
  ).bind(sourceId).all<any>();

  for (const s of sourceCompanies.results) {
    await c.env.DB.prepare(`
      INSERT INTO component_companies (id, component_id, company_id, created_at) VALUES (?, ?, ?, ?)
    `).bind(uid(), newId, s.company_id, now).run();
  }

  // Application files cannot be shared across Components: every clone owns
  // its own metadata and private object-storage objects, keeping later edits/deletes
  // isolated. Copy the objects server-side (get+put); no public download URL exists.
  const clonedFileIDs = new Map<string, string>();
  for (const file of sourceFiles.results) {
    const sourceObject = sourceObjects.get(file.id)!;
    const clonedFileId = uid();
    const clonedObjectKey = `components/${newId}/${clonedFileId}`;
    await storage.put(clonedObjectKey, sourceObject.body, {
      httpMetadata: { contentType: file.content_type ?? 'application/octet-stream' },
      contentLength: file.size_bytes,
    });
    await c.env.DB.prepare(
      `INSERT INTO component_files (id, component_id, original_name, object_key, sha256, size_bytes, content_type, architecture, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(clonedFileId, newId, file.original_name, clonedObjectKey, file.sha256, file.size_bytes, file.content_type, file.architecture, now).run();
    clonedFileIDs.set(file.id, clonedFileId);
  }

  const sourceApplication = await c.env.DB.prepare(
    `SELECT * FROM component_applications WHERE component_id = ?`
  ).bind(sourceId).first<any>();
  if (sourceApplication) {
    const installerFileId = clonedFileIDs.get(sourceApplication.installer_file_id);
    if (!installerFileId) return c.json({ error: 'source application installer is unavailable' }, 409);
    await c.env.DB.prepare(
      `INSERT INTO component_applications (component_id, installer_file_id, installer_arguments, timeout_seconds, detection_type, detection_value, architecture, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId, installerFileId, sourceApplication.installer_arguments, sourceApplication.timeout_seconds, sourceApplication.detection_type, sourceApplication.detection_value, sourceApplication.architecture, now, now).run();
  }

  const row = await c.env.DB.prepare(`SELECT * FROM components WHERE id = ?`).bind(newId).first<any>();
  const [withRelations] = await embedRelations(c.env.DB, [row]);
  return c.json(withRelations, 201);
});

// ── Companies (nested, independent lifecycle — a component can be added to
// several companies one at a time via an "Add Company" flyout, mirroring Datto) ────

adminComponents.get('/:id/companies', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const result = await c.env.DB.prepare(
    `SELECT cs.company_id, t.name FROM component_companies cs
     JOIN companies t ON t.id = cs.company_id
     WHERE cs.component_id = ? ORDER BY t.name ASC`
  ).bind(c.req.param('id')).all<any>();
  return c.json(result.results.map(mapCompany));
});

adminComponents.post('/:id/companies', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');

  const component = await c.env.DB.prepare(`SELECT origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);

  const body = await c.req.json<{ company_id: string }>();
  if (!body.company_id) return c.json({ error: 'company_id required' }, 400);

  const company = await c.env.DB.prepare(`SELECT id FROM companies WHERE id = ?`).bind(body.company_id).first<any>();
  if (!company) return c.json({ error: 'company not found' }, 404);

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO component_companies (id, component_id, company_id, created_at) VALUES (?, ?, ?, ?)`
  ).bind(uid(), componentId, body.company_id, Math.floor(Date.now() / 1000)).run();

  return c.json({ ok: true }, 201);
});

adminComponents.delete('/:id/companies/:companyId', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');

  const component = await c.env.DB.prepare(`SELECT origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);

  await c.env.DB.prepare(
    `DELETE FROM component_companies WHERE component_id = ? AND company_id = ?`
  ).bind(componentId, c.req.param('companyId')).run();
  return c.json({ ok: true });
});

// ── Variables (nested, independent lifecycle — mirrors policy_monitors) ──────

adminComponents.get('/:id/variables', async (c) => {
  if (!(await auth(c))) return c.json({ error: 'unauthorized' }, 401);
  const result = await c.env.DB.prepare(
    `SELECT * FROM component_variables WHERE component_id = ? ORDER BY sort_order ASC`
  ).bind(c.req.param('id')).all<any>();
  return c.json(result.results.map(mapVariable));
});

adminComponents.post('/:id/variables', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');

  const component = await c.env.DB.prepare(`SELECT origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);

  const body = await c.req.json<{
    name: string;
    label: string;
    type?: VariableType;
    options?: { label: string; value: string }[];
    default_value?: string | null;
    description?: string | null;
    required?: boolean;
    sort_order?: number;
  }>();

  const err = validateVariableBody(body);
  if (err) return c.json({ error: err }, 400);

  const id  = uid();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`
    INSERT INTO component_variables (id, component_id, name, label, type, options, default_value, description, required, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, componentId, body.name.trim(), body.label.trim(), body.type ?? 'string',
    body.type === 'selection' ? JSON.stringify(body.options) : null,
    body.default_value ?? null, body.description ?? null,
    body.required ?? true, body.sort_order ?? 0, now,
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM component_variables WHERE id = ?`).bind(id).first<any>();
  return c.json(mapVariable(row!), 201);
});

adminComponents.patch('/:id/variables/:vid', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');
  const vid = c.req.param('vid');

  const component = await c.env.DB.prepare(`SELECT origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);

  const existing = await c.env.DB.prepare(`SELECT * FROM component_variables WHERE id = ? AND component_id = ?`).bind(vid, componentId).first<any>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<Partial<{
    name: string;
    label: string;
    type: VariableType;
    options: { label: string; value: string }[];
    default_value: string | null;
    description: string | null;
    required: boolean;
    sort_order: number;
  }>>();

  const merged = {
    name:  body.name  ?? existing.name,
    label: body.label ?? existing.label,
    type:  body.type  ?? existing.type,
    options: body.options !== undefined ? body.options : (existing.options ? JSON.parse(existing.options) : undefined),
  };
  const err = validateVariableBody(merged);
  if (err) return c.json({ error: err }, 400);

  const sets: string[] = [];
  const vals: any[] = [];
  if (body.name          !== undefined) { sets.push('name = ?');          vals.push(body.name.trim()); }
  if (body.label         !== undefined) { sets.push('label = ?');         vals.push(body.label.trim()); }
  if (body.type          !== undefined) { sets.push('type = ?');          vals.push(body.type); }
  if (body.options       !== undefined) { sets.push('options = ?');       vals.push(JSON.stringify(body.options)); }
  if (body.default_value !== undefined) { sets.push('default_value = ?'); vals.push(body.default_value); }
  if (body.description   !== undefined) { sets.push('description = ?');   vals.push(body.description); }
  if (body.required      !== undefined) { sets.push('required = ?');      vals.push(body.required); }
  if (body.sort_order    !== undefined) { sets.push('sort_order = ?');    vals.push(body.sort_order); }

  if (sets.length) {
    vals.push(vid);
    await c.env.DB.prepare(`UPDATE component_variables SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
  return c.json({ ok: true });
});

adminComponents.delete('/:id/variables/:vid', async (c) => {
  if (!(await auth(c, 'technician'))) return c.json({ error: 'unauthorized' }, 401);
  const componentId = c.req.param('id');
  const vid = c.req.param('vid');

  const component = await c.env.DB.prepare(`SELECT origin FROM components WHERE id = ?`).bind(componentId).first<any>();
  if (!component) return c.json({ error: 'component not found' }, 404);
  if (component.origin === 'store') return c.json({ error: 'store components are read-only — clone to your library to edit' }, 403);

  await c.env.DB.prepare(`DELETE FROM component_variables WHERE id = ? AND component_id = ?`).bind(vid, componentId).run();
  return c.json({ ok: true });
});

export default adminComponents;
