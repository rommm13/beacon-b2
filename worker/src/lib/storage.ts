/**
 * Unified storage interface for R2 and Backblaze B2 (S3-compatible).
 *
 * Routes can accept `StorageAdapter` instead of a concrete R2Bucket/B2Storage
 * without changing their call sites (get/put/delete/head/list share the same shape).
 * `getPresignedUrl` is available on B2Storage and on this adapter abstraction.
 */

import { B2Storage, type B2Env, type B2PutOptions, type B2ObjectBody, type B2ListResult } from './b2';

/** Subset of R2 HTTP metadata options used by this codebase. */
export interface StoragePutHttpMetadata {
  contentType?: string;
  cacheControl?: string;
}

export interface StoragePutOptions extends B2PutOptions {
  httpMetadata?: StoragePutHttpMetadata;
  /** Known size; enables streaming/multipart decisions for B2. */
  contentLength?: number;
}

/** Object returned by get(); compatible with Cloudflare R2ObjectBody usage in routes. */
export interface StorageObjectBody {
  key?: string;
  body: ReadableStream;
  size?: number;
  etag?: string;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  writeHttpMetadata(headers: Headers): void;
}

export interface StorageHeadResult {
  key: string;
  size: number;
  etag: string;
}

export interface StorageListResult {
  objects: Array<{ key: string; size: number; etag?: string; uploaded?: Date }>;
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes?: string[];
}

export type PresignOperation = 'get' | 'put' | 'GET' | 'PUT';

/**
 * StorageAdapter unifies R2Bucket and B2Storage.
 * - R2Bucket satisfies get/put/delete/head/list natively (structural).
 * - B2Storage implements the same methods plus getPresignedUrl.
 *
 * Note: `getPresignedUrl` is not part of R2Bucket; call it only when the
 * runtime adapter is B2Storage (or check via `supportsPresign`).
 */
export interface StorageAdapter {
  get(key: string): Promise<StorageObjectBody | R2ObjectBody | B2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: StoragePutOptions | R2PutOptions,
  ): Promise<R2Object | void>;
  delete(key: string | string[]): Promise<void>;
  head(key: string): Promise<R2Object | StorageHeadResult | null>;
  list(options?: R2ListOptions | { prefix?: string }): Promise<R2Objects | StorageListResult>;
  getPresignedUrl?(key: string, expiresSec: number, operation?: PresignOperation): Promise<string>;
}

/** Union type for bindings/variables that may hold either backend. */
export type AnyStorage = R2Bucket | B2Storage;

export function isB2Storage(storage: AnyStorage): storage is B2Storage {
  return storage instanceof B2Storage;
}

export function supportsPresign(storage: AnyStorage): storage is B2Storage {
  return typeof (storage as B2Storage).getPresignedUrl === 'function';
}

export async function getPresignedUrl(
  storage: AnyStorage,
  key: string,
  expiresSec: number,
  operation: PresignOperation = 'get',
): Promise<string> {
  if (isB2Storage(storage)) return storage.getPresignedUrl(key, expiresSec, operation);
  throw new Error('getPresignedUrl is only supported for B2Storage; R2 requires a different presign mechanism');
}

/** Create a B2-backed adapter from env bindings. */
export function createB2Storage(env: Partial<B2Env>): B2Storage {
  const { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION, B2_PREFIX } = env;
  if (!B2_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET || !B2_ENDPOINT) {
    throw new Error('B2 storage requires env: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT');
  }
  return new B2Storage({ B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION, B2_PREFIX });
}

/**
 * Pick storage backend from bindings.
 * Prefers B2 when B2_* vars are present; falls back to the provided R2 bucket.
 * Routes remain unchanged: they keep using the same binding name, and callers
 * can pass the resolved adapter where appropriate.
 */
export function resolveStorage(opts: { b2?: Partial<B2Env>; r2?: R2Bucket }): AnyStorage {
  if (opts.b2?.B2_KEY_ID && opts.b2?.B2_APPLICATION_KEY && opts.b2?.B2_BUCKET && opts.b2?.B2_ENDPOINT) {
    return createB2Storage(opts.b2);
  }
  if (opts.r2) return opts.r2;
  throw new Error('No storage backend configured (need B2_* env or an R2 bucket binding)');
}

export type { B2Env, B2Storage, B2ObjectBody, B2ListResult };
