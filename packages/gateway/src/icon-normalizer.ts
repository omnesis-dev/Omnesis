// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Worker } from "node:worker_threads";
import { classifyInferenceIp, createLogger, resolveWorkerEntry } from "@omnesis/core";
import { SOURCE_ICON_MAX_BYTES, SOURCE_ICON_MAX_INPUT_CHARS } from "./icon-limits.js";
import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import type { LookupAddress } from "node:dns";

const log = createLogger("gateway:icon-normalizer");

/**
 * Normalize a source icon to a uniform `data:image/png;base64,…` URI so
 * every consumer (portal, iOS, iTerm CLI inline-image OSC) gets the same
 * pre-decoded raster. We accept whatever a source pushes — a hosted URL,
 * an SVG/PNG data URI, or legacy raw base64 — and convert it once at
 * write time. Stored exactly once per source in `sync_state.icon`.
 *
 * Reasons to normalize at the gateway (vs. at each consumer):
 *  - iOS UIImage doesn't decode SVG bytes from `data:image/svg+xml;base64,…`
 *    or from a network-fetched .svg; consumers would each need an SVG
 *    renderer.
 *  - iTerm2's OSC 1337 inline-image protocol takes raw base64 of a raster
 *    format (PNG/JPEG/GIF) — it can't follow URLs and can't render SVG.
 *  - Portal `<img src=…>` doesn't care; either form renders.
 *  - Doing the conversion once means each rendering surface stays simple.
 *
 * The converted bytes live in the user's local SQLite. The repo never
 * ships them, so the OSS-safety property of the source-icons-OSS-safe
 * change still holds — we don't redistribute brand assets, we just
 * cache rasterized brand glyphs per-user for client compatibility.
 */

const TARGET_PIXEL_SIZE = 64;
// 15s — generous enough that ~15 concurrent third-party icon fetches
// (gstatic, notion, microsoft, …) at gateway boot all complete before
// the first /admin/sources/descriptors response is built. 5s would
// frequently abort half of them under cold-cache concurrent load,
// leaving the Add-Source modal with Lucide fallbacks until the next
// reload trips the memo retry path.
const FETCH_TIMEOUT_MS = 15000;
const ICON_FETCH_USER_AGENT = "omnesis-gateway/icon-normalizer";
const MAX_REDIRECTS = 5;
type IconHostLookup = (hostname: string, opts: { all: true }) => Promise<LookupAddress[]>;
/**
 * Cap on the URL → PNG-data-URI memo. The active icon set
 * is small (~30 sources × 1 icon each) so 256 is plenty of headroom; the
 * cap exists so a long-running gateway whose icon URLs occasionally
 * rotate doesn't accumulate stale entries forever, and so a force-refresh
 * (icon changed at the URL after eviction) re-fetches naturally.
 */
const MEMO_LRU_CAP = 256;

/**
 * Tiny FIFO-by-insertion-order LRU. Map preserves insertion order, so
 * `set(key, value)` after `delete(key)` re-bumps the entry to the end —
 * iteration head is the oldest live entry, evicted when over cap.
 */
const memo = new Map<string, Promise<string | null>>();

function memoGet(key: string): Promise<string | null> | undefined {
  const value = memo.get(key);
  if (value === undefined) return undefined;
  // Bump to the end of the iteration order so frequently-used entries
  // survive eviction.
  memo.delete(key);
  memo.set(key, value);
  return value;
}

function memoSet(key: string, value: Promise<string | null>): void {
  if (memo.has(key)) memo.delete(key);
  memo.set(key, value);
  while (memo.size > MEMO_LRU_CAP) {
    const oldest = memo.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** Drop the in-process URL → PNG-data-URI cache. Test-only. */
export function _resetIconNormalizerCache(): void {
  memo.clear();
}

/** Test-only: introspect the current memo size. */
export function _iconNormalizerCacheSize(): number {
  return memo.size;
}

/**
 * Convert an arbitrary icon string into `data:image/png;base64,…`. Returns
 * null when the input is unusable (empty, fetch failed, unrenderable).
 *
 * Inputs:
 *  - `data:image/png;base64,…`     → passthrough
 *  - `data:image/jpeg;base64,…`    → passthrough (iTerm/UIImage handle it)
 *  - `data:image/gif;base64,…`     → passthrough
 *  - `data:image/svg+xml;base64,…` → rasterize to PNG
 *  - `data:image/svg+xml,<utf8>`   → rasterize to PNG
 *  - `https?://…`                  → fetch, then handle as bytes (rasterize
 *                                    if SVG, otherwise wrap as data URI)
 *  - bare `iVBOR…` base64          → assume legacy PNG, wrap with prefix
 *  - anything else                 → null
 */
export async function normalizeIcon(
  raw: string | undefined,
  fetcher: typeof fetch = fetch,
  lookup: IconHostLookup = (hostname, opts) => dns.lookup(hostname, opts),
): Promise<string | null> {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > SOURCE_ICON_MAX_INPUT_CHARS) return null;

  if (trimmed.startsWith("data:")) {
    return await normalizeDataUri(trimmed);
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return normalizeUrl(trimmed, fetcher, lookup);
  }
  // Legacy raw base64 PNG (no prefix). Wrap with the canonical PNG prefix
  // so the next read is a same-format passthrough.
  if (looksLikeBase64Png(trimmed)) {
    if (decodedBase64Bytes(trimmed) > SOURCE_ICON_MAX_BYTES) return null;
    return `data:image/png;base64,${trimmed}`;
  }
  return null;
}

async function normalizeDataUri(uri: string): Promise<string | null> {
  const commaAt = uri.indexOf(",");
  if (commaAt < 0) return null;
  const header = uri.slice(5, commaAt);
  const payload = uri.slice(commaAt + 1);
  // Each known raster format passes through unchanged.
  if (
    header.startsWith("image/png;base64") ||
    header.startsWith("image/jpeg;base64") ||
    header.startsWith("image/jpg;base64") ||
    header.startsWith("image/gif;base64") ||
    header.startsWith("image/webp;base64")
  ) {
    return decodedBase64Bytes(payload) <= SOURCE_ICON_MAX_BYTES ? uri : null;
  }
  if (header.startsWith("image/svg+xml")) {
    const isBase64 = header.includes(";base64");
    let svgBytes: Buffer;
    if (isBase64) {
      if (decodedBase64Bytes(payload) > SOURCE_ICON_MAX_BYTES) return null;
      try {
        svgBytes = Buffer.from(payload, "base64");
      } catch {
        return null;
      }
    } else {
      try {
        svgBytes = Buffer.from(decodeURIComponent(payload), "utf8");
      } catch {
        svgBytes = Buffer.from(payload, "utf8");
      }
    }
    if (svgBytes.byteLength > SOURCE_ICON_MAX_BYTES) return null;
    return rasterizeSvgToDataUri(svgBytes);
  }
  return null;
}

async function normalizeUrl(
  url: string,
  fetcher: typeof fetch,
  lookup: IconHostLookup,
): Promise<string | null> {
  const cached = memoGet(url);
  if (cached) return cached;
  const promise = fetchAndConvert(url, fetcher, lookup);
  memoSet(url, promise);
  // If the fetch resolves to null, drop from cache so a future write retries.
  promise
    .then((result) => {
      if (result === null) memo.delete(url);
    })
    .catch(() => {});
  return promise;
}

async function fetchAndConvert(
  url: string,
  fetcher: typeof fetch,
  lookup: IconHostLookup,
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = url;
    let res: Response | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const target = await assertPublicIconUrl(currentUrl, lookup);
      const init = {
        headers: { "User-Agent": ICON_FETCH_USER_AGENT },
        redirect: "manual" as const,
        signal: ac.signal,
      };
      res =
        fetcher === fetch ? await requestPinnedIcon(target, init) : await fetcher(currentUrl, init);
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      if (!location) break;
      await res.body?.cancel();
      if (redirectCount === MAX_REDIRECTS) {
        log.warn(`Icon fetch exceeded ${MAX_REDIRECTS} redirects`);
        return null;
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    if (!res) return null;
    if (!res.ok) {
      log.warn(`Icon fetch returned HTTP ${res.status}`);
      return null;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > SOURCE_ICON_MAX_BYTES) {
      await res.body?.cancel();
      log.warn(`Icon exceeds ${SOURCE_ICON_MAX_BYTES} bytes; skipping`);
      return null;
    }
    const bytes = await readBoundedBody(res, ac);
    if (!bytes) {
      log.warn(`Icon exceeds ${SOURCE_ICON_MAX_BYTES} bytes; skipping`);
      return null;
    }
    const looksSvg =
      contentType.includes("svg") ||
      currentUrl.toLowerCase().endsWith(".svg") ||
      bytes.subarray(0, 64).toString("utf8").trimStart().startsWith("<");
    if (looksSvg) {
      return await rasterizeSvgToDataUri(bytes);
    }
    const mime = pickRasterMime(contentType, bytes);
    if (!mime) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch (err) {
    log.warn(`Icon fetch failed${err instanceof IconBodyTooLargeError ? ": body too large" : ""}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface PinnedIconTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

async function assertPublicIconUrl(
  rawUrl: string,
  lookup: IconHostLookup,
): Promise<PinnedIconTarget> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`disallowed icon URL scheme ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error("embedded icon URL credentials");

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true });
  if (addresses.length === 0) throw new Error("icon hostname resolved to no addresses");
  for (const { address } of addresses) {
    if (classifyInferenceIp(address) !== "public") {
      throw new Error(`icon hostname resolved to a non-public address`);
    }
  }
  const selected = addresses[0];
  if (!selected) throw new Error("icon hostname resolved to no addresses");
  return { url: parsed, address: selected.address, family: selected.family as 4 | 6 };
}

class IconBodyTooLargeError extends Error {}

async function requestPinnedIcon(target: PinnedIconTarget, init: RequestInit): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const options: RequestOptions = {
      // A pooled socket is keyed by hostname/port and would bypass this
      // request's pinned lookup. Icons are fetched rarely, so use a fresh
      // connection whose address is always the one validated above.
      agent: false,
      headers: init.headers as Record<string, string>,
      lookup: (_hostname, optionsOrCallback, maybeCallback) => {
        const options = typeof optionsOrCallback === "object" ? optionsOrCallback : {};
        const callback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
        if (!callback) return;
        if (options.all) {
          callback(null, [{ address: target.address, family: target.family }]);
        } else {
          callback(null, target.address, target.family);
        }
      },
      method: "GET",
      signal: init.signal ?? undefined,
    };
    const req = transport.request(target.url, options, (incoming) => {
      const status = incoming.statusCode ?? 500;
      const headers = responseHeaders(incoming.headers);
      if (status >= 300 && status < 400) {
        incoming.destroy();
        resolve(new Response(null, { status, headers }));
        return;
      }
      const declaredLength = Number(incoming.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > SOURCE_ICON_MAX_BYTES) {
        incoming.destroy();
        reject(new IconBodyTooLargeError());
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > SOURCE_ICON_MAX_BYTES) {
          incoming.destroy(new IconBodyTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        const body =
          status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks, total);
        resolve(new Response(body, { status, headers }));
      });
      incoming.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Exercise the production pinned transport without a public DNS dependency. Test-only. */
export async function _requestPinnedIconForTest(
  rawUrl: string,
  address: string,
  family: 4 | 6,
): Promise<Response> {
  return requestPinnedIcon(
    { url: new URL(rawUrl), address, family },
    { headers: { "User-Agent": ICON_FETCH_USER_AGENT } },
  );
}

function responseHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readBoundedBody(response: Response, ac: AbortController): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > SOURCE_ICON_MAX_BYTES) {
        ac.abort();
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function decodedBase64Bytes(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

// ─── SVG rasterize: offloaded to a dedicated worker ──────────
//
// Resvg's `render()` is a sync native call; running it on the main thread
// blocks every other HTTP request for the duration. A single dedicated
// worker thread owns the binding so the main thread just sends bytes and
// awaits a PNG. The worker is spawned lazily on first SVG encounter and
// kept alive (`unref()`'d so it doesn't pin the process) for subsequent
// rasterizes. A graceful shutdown hook tears it down on process exit.

type RasterizeWorkerReply =
  | { id: number; ok: true; png: string }
  | { id: number; ok: false; error: string };

interface PendingRasterize {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
}

let rasterizeWorker: Worker | null = null;
let nextRasterizeId = 0;
const pendingRasterizes = new Map<number, PendingRasterize>();

/** Test-only: tear down the rasterize worker and reject pending calls. */
export async function _shutdownIconRasterizeWorker(): Promise<void> {
  if (!rasterizeWorker) return;
  for (const [, p] of pendingRasterizes) {
    p.reject(new Error("rasterize worker shut down"));
  }
  pendingRasterizes.clear();
  const w = rasterizeWorker;
  rasterizeWorker = null;
  await w.terminate();
}

function getRasterizeWorker(): Worker {
  if (rasterizeWorker) return rasterizeWorker;
  // Mirrors the spawn pattern from `workers/indexer-worker-proxy.ts`:
  // .ts source under tsx (with the register-tsx preload), emitted dist
  // sibling when running compiled.
  const entry = resolveWorkerEntry(
    "./icon-rasterize-worker.ts",
    import.meta.url,
    "./workers/register-tsx.mjs",
  );
  rasterizeWorker = new Worker(entry.url, { execArgv: entry.execArgv });
  rasterizeWorker.on("message", (reply: RasterizeWorkerReply) => {
    const pending = pendingRasterizes.get(reply.id);
    if (!pending) return;
    pendingRasterizes.delete(reply.id);
    if (reply.ok) {
      pending.resolve(`data:image/png;base64,${reply.png}`);
    } else {
      pending.reject(new Error(reply.error));
    }
  });
  rasterizeWorker.on("error", (err) => {
    log.warn(`icon-rasterize-worker error: ${err.message}`);
    // Fail every in-flight rasterize so callers don't hang.
    for (const [, p] of pendingRasterizes) p.reject(err);
    pendingRasterizes.clear();
    rasterizeWorker = null;
  });
  // Don't pin the process — the gateway should be free to exit on
  // SIGINT even if no rasterize is in flight.
  rasterizeWorker.unref();
  return rasterizeWorker;
}

async function rasterizeSvgToDataUri(svgBytes: Buffer): Promise<string | null> {
  const worker = getRasterizeWorker();
  const id = ++nextRasterizeId;
  return new Promise<string>((resolve, reject) => {
    pendingRasterizes.set(id, { resolve, reject });
    worker.postMessage({
      id,
      svgBytes: new Uint8Array(svgBytes),
      targetSize: TARGET_PIXEL_SIZE,
    });
  })
    .catch((err) => {
      log.warn(`SVG rasterize failed: ${err instanceof Error ? err.message : String(err)}`);
      return null as unknown as string;
    })
    .then((v) => (v === null ? null : v));
}

function pickRasterMime(contentType: string, bytes: Buffer): string | null {
  // Trust Content-Type when it points at a known raster format. Otherwise
  // sniff the magic bytes — some CDNs serve images as octet-stream.
  if (contentType.startsWith("image/png")) return "image/png";
  if (contentType.startsWith("image/jpeg") || contentType.startsWith("image/jpg"))
    return "image/jpeg";
  if (contentType.startsWith("image/gif")) return "image/gif";
  if (contentType.startsWith("image/webp")) return "image/webp";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  return null;
}

function looksLikeBase64Png(s: string): boolean {
  // PNG bytes start with 0x89 0x50 0x4E 0x47 → base64 starts with "iVBORw0KGgo".
  return s.startsWith("iVBORw0KGgo");
}
