/**
 * Backblaze B2 adapter (S3-compatible API) with an R2-like surface.
 *
 * Uses AWS Signature Version 4 via Web Crypto (no external deps).
 * Secrets come only from env: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT.
 *
 * Streaming: request/response bodies are passed through fetch without buffering.
 * Objects larger than MULTIPART_THRESHOLD use S3 multipart upload; parts are read
 * sequentially from the source stream and uploaded one at a time (no full-file buffer).
 */

export interface B2Env {
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET: string;
  /** S3 endpoint host or URL, e.g. "s3.us-west-004.backblazeb2.com" or "https://..." */
  B2_ENDPOINT: string;
  /** Optional SigV4 region override (e.g. "us-west-004"). Derived from endpoint host when omitted. */
  B2_REGION?: string;
  /**
   * Optional key prefix for single-bucket layouts (e.g. "branding/").
   * Prepended to every object key; list() query prefixes are scoped the same way.
   */
  B2_PREFIX?: string;
}

export interface B2PutOptions {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  /** Declared/known size in bytes. Required for stream uploads and to pick multipart for >100MB. */
  contentLength?: number;
}

export interface B2ObjectMeta {
  key: string;
  size: number;
  etag: string;
  uploaded?: Date;
  httpMetadata?: { contentType?: string };
}

/** R2ObjectBody-compatible shape returned by get(). */
export class B2ObjectBody {
  readonly key: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly etag: string;
  readonly httpMetadata: { contentType?: string };

  constructor(init: { key: string; body: ReadableStream<Uint8Array>; size: number; etag: string; httpMetadata?: { contentType?: string } }) {
    this.key = init.key;
    this.body = init.body;
    this.size = init.size;
    this.etag = init.etag;
    this.httpMetadata = init.httpMetadata ?? {};
  }

  get httpEtag(): string {
    return this.etag;
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata.contentType) headers.set('Content-Type', this.httpMetadata.contentType);
  }
}

export interface B2ListResult {
  objects: B2ObjectMeta[];
  truncated: boolean;
  cursor?: string;
  /** R2 compatibility alias */
  delimitedPrefixes: string[];
}

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MiB
const PART_SIZE = 10 * 1024 * 1024; // 10 MiB (>= S3 min 5 MiB for non-last parts)
const encoder = new TextEncoder();

function normalizeEndpoint(endpoint: string): { host: string; baseUrl: string } {
  const url = endpoint.includes('://') ? new URL(endpoint) : new URL(`https://${endpoint}`);
  const host = url.host;
  const baseUrl = `${url.protocol}//${host}`;
  return { host, baseUrl };
}

function encodeKey(key: string): string {
  // Encode each segment but keep '/' as path delimiter for S3 object keys.
  return key.split('/').map((s) => encodeURIComponent(s)).join('/');
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(hash);
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data) as BufferSource);
}

async function hmacHex(key: ArrayBuffer | Uint8Array, data: string): Promise<string> {
  return toHex(await hmac(key, data));
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  let key: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${secretKey}`);
  key = await hmac(key, dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  return key as ArrayBuffer;
}

function amzDate(d = new Date()): { amz: string; dateStamp: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, dateStamp: iso.slice(0, 8) };
}

/** Derive SigV4 region from B2 S3 endpoint host (s3.<region>.backblazeb2.com). */
function regionFromHost(host: string): string {
  const m = host.match(/^s3[.-]([a-z0-9-]+)\.backblazeb2\.com$/i);
  return m ? m[1] : 'us-west-004';
}

function parseEtag(etag: string | null): string {
  if (!etag) return '';
  return etag;
}

export class B2Storage {
  private readonly env: B2Env;
  private readonly host: string;
  private readonly baseUrl: string;
  private readonly region: string;
  private readonly prefix: string;

  constructor(env: B2Env) {
    this.env = env;
    const ep = normalizeEndpoint(env.B2_ENDPOINT);
    this.host = ep.host;
    this.baseUrl = ep.baseUrl;
    this.region = env.B2_REGION || regionFromHost(ep.host);
    const p = (env.B2_PREFIX ?? '').replace(/^\/+/, '');
    this.prefix = p === '' ? '' : p.endsWith('/') ? p : `${p}/`;
  }

  private fullKey(key: string): string {
    const k = key.replace(/^\/+/, '');
    return `${this.prefix}${k}`;
  }

  private objectUrl(key: string): string {
    return `${this.baseUrl}/${encodeURIComponent(this.env.B2_BUCKET)}/${encodeKey(this.fullKey(key))}`;
  }

  private async signedHeaders(params: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    payloadHash: string;
  }): Promise<Headers> {
    const { amz, dateStamp } = amzDate();
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const hdrs: Record<string, string> = {
      ...params.headers,
      host: params.url.host,
      'x-amz-date': amz,
      'x-amz-content-sha256': params.payloadHash,
    };
    const lowerMap = new Map<string, string>();
    for (const [k, v] of Object.entries(hdrs)) lowerMap.set(k.toLowerCase(), String(v).trim());
    const signedHeaderKeys = [...lowerMap.keys()].sort();
    const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${lowerMap.get(k)}\n`).join('');
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalQuery = [...params.url.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalRequest = [
      params.method,
      params.url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      params.payloadHash,
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonicalRequest)].join('\n');
    const signingKey = await getSigningKey(this.env.B2_APPLICATION_KEY, dateStamp, this.region, 's3');
    const signature = await hmacHex(signingKey, stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.env.B2_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const out = new Headers();
    for (const [k, v] of Object.entries(hdrs)) out.set(k, v);
    out.set('Authorization', authorization);
    return out;
  }

  private async signedFetch(method: string, url: URL, init: { headers?: Record<string, string>; body?: BodyInit | null; payloadHash?: string } = {}): Promise<Response> {
    // For streaming bodies, S3 accepts UNSIGNED-PAYLOAD (avoids buffering for hash).
    const payloadHash = init.payloadHash ?? (init.body == null ? await sha256Hex('') : 'UNSIGNED-PAYLOAD');
    const headers = await this.signedHeaders({ method, url, headers: init.headers ?? {}, payloadHash });
    return fetch(url.toString(), { method, headers, body: init.body ?? undefined });
  }

  async get(key: string): Promise<B2ObjectBody | null> {
    const url = new URL(this.objectUrl(key));
    const res = await this.signedFetch('GET', url);
    if (res.status === 404) return null;
    if (!res.ok || !res.body) {
      throw new Error(`B2 GET ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const size = Number(res.headers.get('content-length') ?? '0') || 0;
    const etag = parseEtag(res.headers.get('etag'));
    const contentType = res.headers.get('content-type') ?? undefined;
    return new B2ObjectBody({ key, body: res.body as ReadableStream<Uint8Array>, size, etag, httpMetadata: { contentType } });
  }

  async head(key: string): Promise<{ key: string; size: number; etag: string } | null> {
    const url = new URL(this.objectUrl(key));
    const res = await this.signedFetch('HEAD', url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`B2 HEAD ${key} failed: ${res.status}`);
    }
    return {
      key,
      size: Number(res.headers.get('content-length') ?? '0') || 0,
      etag: parseEtag(res.headers.get('etag')),
    };
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null, options?: B2PutOptions): Promise<void> {
    const contentType = options?.httpMetadata?.contentType ?? 'application/octet-stream';
    const len = options?.contentLength;

    // ReadableStream without reliable total length: use multipart (bounded part buffering)
    // to avoid requiring Content-Length and to support large uploads. This keeps memory
    // bounded to ~PART_SIZE per in-flight part.
    if (value instanceof ReadableStream) {
      const forceMultipart = typeof len === 'number' ? len > MULTIPART_THRESHOLD : true;
      if (forceMultipart) {
        await this.putMultipart(key, value as ReadableStream<Uint8Array>, contentType, typeof len === 'number' ? len : -1);
        return;
      }
      // Small stream with known length: still prefer multipart for S3 compatibility
      // (single PUT of a stream is finicky across runtimes); bounded buffer is tiny.
      await this.putMultipart(key, value as ReadableStream<Uint8Array>, contentType, len!);
      return;
    }

    const url = new URL(this.objectUrl(key));
    const headers: Record<string, string> = { 'content-type': contentType };
    if (typeof len === 'number') headers['content-length'] = String(len);

    let body: BodyInit | null = null;
    let payloadHash: string | undefined;
    if (value == null) {
      body = null;
      payloadHash = await sha256Hex('');
      headers['content-length'] = '0';
    } else if (typeof value === 'string') {
      body = value;
      payloadHash = await sha256Hex(value);
    } else if (value instanceof ArrayBuffer) {
      body = value;
      payloadHash = await sha256Hex(value);
    } else if (ArrayBuffer.isView(value)) {
      const u8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      body = u8 as unknown as BodyInit;
      payloadHash = await sha256Hex(u8);
    } else if (value instanceof Blob) {
      // Blob: read to buffer (bounded by actual usage; routes send streams/buffers).
      const ab = await value.arrayBuffer();
      body = ab;
      payloadHash = await sha256Hex(ab);
      headers['content-length'] = String(ab.byteLength);
    } else {
      body = value as unknown as BodyInit;
      payloadHash = 'UNSIGNED-PAYLOAD';
    }

    const res = await this.signedFetch('PUT', url, { headers, body, payloadHash });
    if (!res.ok) {
      throw new Error(`B2 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }

  async delete(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      const url = new URL(this.objectUrl(k));
      const res = await this.signedFetch('DELETE', url);
      if (!res.ok && res.status !== 404) {
        throw new Error(`B2 DELETE ${k} failed: ${res.status} ${await res.text().catch(() => '')}`);
      }
    }
  }

  async list(options?: string | { prefix?: string; cursor?: string; limit?: number }): Promise<B2ListResult> {
    const rawPrefix = typeof options === 'string' ? options : options?.prefix;
    // Scope listing to this storage's prefix; callers use logical (unprefixed) keys.
    const prefix = rawPrefix != null && rawPrefix !== '' ? `${this.prefix}${rawPrefix.replace(/^\/+/, '')}` : this.prefix || undefined;
    const cursor = typeof options === 'string' ? undefined : options?.cursor;
    const limit = typeof options === 'string' ? undefined : options?.limit;
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.env.B2_BUCKET)}`);
    url.searchParams.set('list-type', '2');
    if (prefix) url.searchParams.set('prefix', prefix);
    if (cursor) url.searchParams.set('continuation-token', cursor);
    if (limit) url.searchParams.set('max-keys', String(limit));
    const res = await this.signedFetch('GET', url);
    if (!res.ok) {
      throw new Error(`B2 LIST ${prefix ?? ''} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const xml = await res.text();
    const objects = this.parseListXml(xml);
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    return { objects, truncated, cursor: tokenMatch?.[1], delimitedPrefixes: [] };
  }

  private parseListXml(xml: string, prefix?: string): B2ObjectMeta[] {
    const out: B2ObjectMeta[] = [];
    const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
    for (const c of contents) {
      const key = this.xmlTag(c, 'Key');
      if (key == null) continue;
      const size = Number(this.xmlTag(c, 'Size') ?? '0') || 0;
      const etag = parseEtag(this.xmlTag(c, 'ETag'));
      const lm = this.xmlTag(c, 'LastModified');
      out.push({ key, size, etag, uploaded: lm ? new Date(lm) : undefined });
    }
    return out;
  }

  private xmlTag(xml: string, tag: string): string | null {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    if (!m) return null;
    return m[1]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /**
   * Presigned S3 URL (AWS SigV4 query-string).
   * operation: 'get'|'put'|'GET'|'PUT'
   */
  async getPresignedUrl(key: string, expiresSec: number, operation: 'get' | 'put' | 'GET' | 'PUT' = 'get'): Promise<string> {
    const method = operation.toUpperCase();
    const url = new URL(this.objectUrl(key));
    const { amz, dateStamp } = amzDate();
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const credential = `${this.env.B2_KEY_ID}/${scope}`;
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Credential', credential);
    url.searchParams.set('X-Amz-Date', amz);
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(expiresSec, 604800))));
    url.searchParams.set('X-Amz-SignedHeaders', 'host');
    // keep existing params (none) sorted for canonical form
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalRequest = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonicalRequest)].join('\n');
    const signingKey = await getSigningKey(this.env.B2_APPLICATION_KEY, dateStamp, this.region, 's3');
    const signature = await hmacHex(signingKey, stringToSign);
    url.searchParams.set('X-Amz-Signature', signature);
    return url.toString();
  }

  /** Multipart upload for large objects. Reads the stream in PART_SIZE chunks sequentially. */
  private async putMultipart(key: string, stream: ReadableStream<Uint8Array>, contentType: string, totalSize: number): Promise<void> {
    // 1) Initiate
    const initUrl = new URL(this.objectUrl(key));
    initUrl.searchParams.set('uploads', '');
    const initRes = await this.signedFetch('POST', initUrl, { headers: { 'content-type': contentType } });
    if (!initRes.ok) throw new Error(`B2 multipart init ${key} failed: ${initRes.status} ${await initRes.text().catch(() => '')}`);
    const initXml = await initRes.text();
    const uploadId = this.xmlTag(initXml, 'UploadId');
    if (!uploadId) throw new Error(`B2 multipart init ${key}: missing UploadId`);

    try {
      const reader = stream.getReader();
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let partNumber = 1;
      let buf: Uint8Array[] = [];
      let bufSize = 0;

      const flush = async (last: boolean) => {
        if (bufSize === 0) return;
        const minPart = last ? 0 : PART_SIZE;
        if (!last && bufSize < minPart) return;
        const part = concatChunks(buf, bufSize);
        buf = [];
        bufSize = 0;
        const partUrl = new URL(this.objectUrl(key));
        partUrl.searchParams.set('partNumber', String(partNumber));
        partUrl.searchParams.set('uploadId', uploadId);
        const partHash = await sha256Hex(part);
        const res = await this.signedFetch('PUT', partUrl, {
          headers: { 'content-length': String(part.byteLength) },
          body: part as unknown as BodyInit,
          payloadHash: partHash,
        });
        if (!res.ok) throw new Error(`B2 upload part ${partNumber} ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
        const etag = parseEtag(res.headers.get('etag')) || `"part-${partNumber}"`;
        parts.push({ partNumber, etag });
        partNumber++;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          buf.push(value);
          bufSize += value.byteLength;
          while (bufSize >= PART_SIZE) {
            // split off exactly PART_SIZE worth (may span chunks)
            const split = splitChunks(buf, bufSize, PART_SIZE);
            const part = split.part;
            buf = split.rest;
            bufSize = split.restSize;
            const partUrl = new URL(this.objectUrl(key));
            partUrl.searchParams.set('partNumber', String(partNumber));
            partUrl.searchParams.set('uploadId', uploadId);
            const partHash = await sha256Hex(part);
            const res = await this.signedFetch('PUT', partUrl, {
              headers: { 'content-length': String(part.byteLength) },
              body: part as unknown as BodyInit,
              payloadHash: partHash,
            });
            if (!res.ok) throw new Error(`B2 upload part ${partNumber} ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
            parts.push({ partNumber, etag: parseEtag(res.headers.get('etag')) || `"part-${partNumber}"` });
            partNumber++;
          }
        }
      }
      await flush(true);

      // 2) Complete
      const completeBody = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const completeUrl = new URL(this.objectUrl(key));
      completeUrl.searchParams.set('uploadId', uploadId);
      const completeRes = await this.signedFetch('POST', completeUrl, {
        headers: { 'content-type': 'application/xml' },
        body: completeBody,
        payloadHash: await sha256Hex(completeBody),
      });
      if (!completeRes.ok) throw new Error(`B2 multipart complete ${key} failed: ${completeRes.status} ${await completeRes.text().catch(() => '')}`);
    } catch (err) {
      try {
        const abortUrl = new URL(this.objectUrl(key));
        abortUrl.searchParams.set('uploadId', uploadId);
        await this.signedFetch('DELETE', abortUrl);
      } catch { /* best-effort abort */ }
      throw err;
    }
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].byteLength === total) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function splitChunks(chunks: Uint8Array[], total: number, take: number): { part: Uint8Array; rest: Uint8Array[]; restSize: number } {
  const part = new Uint8Array(take);
  const rest: Uint8Array[] = [];
  let copied = 0;
  let restSize = 0;
  for (const c of chunks) {
    if (copied >= take) {
      rest.push(c); restSize += c.byteLength;
      continue;
    }
    const need = take - copied;
    if (c.byteLength <= need) {
      part.set(c, copied); copied += c.byteLength;
    } else {
      part.set(c.subarray(0, need), copied); copied += need;
      const r = c.subarray(need);
      rest.push(r); restSize += r.byteLength;
    }
  }
  return { part, rest, restSize };
}
