// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { join, extname, sep, resolve as pathResolve } from "node:path";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { scope } from "../scope.js";
import { getWidgetOrigins } from "../../widget-origins.js";
import {
  getWidgetRenderers,
  resolveWidgetRendererModule,
  widgetRendererUrl,
} from "../../widget-renderers.js";
import { validateJson } from "../validate.js";
import { portalLoginBody } from "../schemas/index.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../errors.js";
import { portalLoginRateLimiter } from "../../rate-limit.js";
import {
  buildSessionCookieHeader,
  clearSessionCookieHeader,
  DEFAULT_SESSION_MAX_AGE_S,
  getSessionCookie,
  portalCsrfToken,
  SESSION_COOKIE_BASE,
} from "../cookies.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { AuthContext, RouteApp } from "./types.js";
import type { SourceService } from "../services/SourceService.js";
import type { AuthService } from "../services/AuthService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface PortalRoutesDeps {
  db: Db;
  /** Absolute path to the `packages/gateway/portal/` static-file root. */
  portalRoot: string;
  authService: AuthService;
  sourceService: SourceService;
  /**
   * Portal session-cookie TTL in ms. Plumbed from
   * `gateway.timings.sessionTtl` via runtime-settings; rounded down to
   * seconds for the cookie's `Max-Age`. Falls back to 30d when omitted
   * (test path).
   */
  sessionTtlMs?: number;
  /**
   * Resolved session cookie name. Pre-computed by `createServer` from the
   * gateway's listen port (see `sessionCookieName(port)`) so two gateways
   * sharing a host (e.g. `localhost:7600` + `localhost:27600`) don't
   * trample each other's session cookies. Defaults to the bare
   * `__omnesis_session` name when omitted (test path).
   */
  sessionCookieName?: string;
}

const PORTAL_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// Strict CSP for the portal. Every script / style / image / font is
// served from the gateway origin (vendored deps live under
// /portal/vendor/), so 'self' is the base on every directive.
// `connect-src` covers /search and /admin/* (including SSE) — all same-origin.
// `style-src 'unsafe-inline'` is here only for inline `style=` attrs
// rendered from server-side data (e.g. icon size overrides); the CSS
// itself is loaded from /portal/css/style.css. `frame-ancestors 'none'`
// + `X-Frame-Options: DENY` together prevent clickjacking.
//
// `script-src` includes a per-deployment SHA-256 hash of every inline
// `<script>` in index.html — the importmap block and the theme-bootstrap
// block — computed at mount time (see `getPortalCsp`/`inlineScriptHashes`).
// Without the importmap's hash, Chrome blocks it as an inline script and
// every bare module specifier ("htm/preact", "preact", etc.) fails to
// resolve, producing a black portal; without the theme script's hash the
// saved light/dark preference isn't applied before first paint. We
// deliberately stay off `'unsafe-inline'` so that any other inline script
// (including XSS-injected ones) is still blocked.
//
// The one exception to "everything from 'self'" is a `link-widget` source's
// hosted widget (Plaid Link, …): its vendor SDK loads from the vendor's CDN
// and renders a vendor-hosted iframe, neither of which can be self-hosted.
// Each such source DECLARES the exact external origins it needs via its
// descriptor's `widgetOrigins`; the collector pushes the union to the gateway
// (`widget-origins.ts`), and we ADD those origins to `script-src`/`frame-src`/
// `connect-src` here — generically, never naming a source. With no
// `link-widget` source loaded the set is empty and the policy stays strictly
// self-hosted.
export function buildPortalCsp(scriptHashes: string[]): string {
  const widget = getWidgetOrigins();
  const join = (base: string, extra: readonly string[]): string =>
    extra.length > 0 ? `${base} ${extra.join(" ")}` : base;
  return [
    "default-src 'self'",
    join(`script-src 'self' ${scriptHashes.join(" ")}`, widget.script),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    join("connect-src 'self'", widget.connect),
    join("frame-src 'self'", widget.frame),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * SHA-256-hash every inline `<script>` in index.html (those with no `src`
 * attribute): today the `<script type="importmap">` block and the
 * theme-bootstrap block. Each inline script must be allow-listed by hash or
 * Chrome blocks it under the strict (no 'unsafe-inline') CSP; external
 * scripts (`<script src=…>`) are already covered by 'self'. The hash must
 * match the element's text content EXACTLY (whitespace included), so the
 * inner capture is preserved verbatim. The importmap is required — its
 * absence breaks bare-specifier resolution and blanks the portal — so we
 * fail loudly if it's missing.
 */
function inlineScriptHashes(html: string): string[] {
  if (!/<script\s+type=["']importmap["']/i.test(html)) {
    throw new Error(
      'portal index.html missing <script type="importmap"> element — CSP cannot be built',
    );
  }
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(match[1])) continue; // external script — covered by 'self'
    const hash = createHash("sha256").update(match[2], "utf8").digest("base64");
    hashes.push(`'sha256-${hash}'`);
  }
  return hashes;
}

/**
 * Lazy-cached per-portalRoot inline-script hashes. The importmap content is
 * fixed at deploy time, so we hash it once on the first request and reuse the
 * result for the lifetime of the process. Keyed by portalRoot so test suites
 * that mount multiple roots don't bleed into each other.
 *
 * The CSP STRING itself is rebuilt per request (a cheap array join) rather than
 * cached: the widget-origin allow-list (`getWidgetOrigins`) is pushed by the
 * collector AFTER the gateway boots, so a string cached on the first request
 * would freeze the policy before those origins ever arrive — and a `link-widget`
 * source's hosted widget would stay blocked.
 */
const portalScriptHashCache = new Map<string, string[]>();
function getPortalCsp(portalRoot: string): string {
  let hashes = portalScriptHashCache.get(portalRoot);
  if (!hashes) {
    const html = readFileSync(join(portalRoot, "index.html"), "utf8");
    hashes = inlineScriptHashes(html);
    portalScriptHashCache.set(portalRoot, hashes);
  }
  return buildPortalCsp(hashes);
}

function portalSecurityHeaders(filePath: string, portalRoot: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(filePath),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    // Portal assets are unversioned (no content hash in the filename) and the
    // gateway is upgraded in place, so a deploy changes a file's bytes under
    // the same URL. Without this, browsers reused cached JS/CSS — most
    // stubbornly ES-module scripts — and operators saw stale UI until a manual
    // hard-refresh. `no-cache` lets the browser keep a copy but forces it to
    // revalidate every time via `If-None-Match`; an unchanged file still
    // short-circuits to a cheap 304 (see `portalResponseFor`), so the only cost
    // is one conditional request per asset while always serving current bytes.
    "Cache-Control": "no-cache",
  };
  // Apply CSP to HTML responses (the actual document) — applying it
  // to JS/CSS subresources is meaningless and just adds bytes.
  if (filePath.endsWith(".html")) {
    headers["Content-Security-Policy"] = getPortalCsp(portalRoot);
  }
  return headers;
}

/**
 * In-memory cache of portal static files. Keyed on absolute path.
 * Each entry stores the buffer, the mtime+size that produced it, and
 * a derived weak ETag so the SPA's poll loop can short-circuit on
 * `If-None-Match` with a 304 instead of re-reading the body off disk.
 *
 * The cache is stat-validated on every request — a 1-stat lookup per
 * request is cheap; the saving is the readFileSync (and, for HTML,
 * the JSON CSP build). Eviction policy is "never": typical portal
 * size is ~30 files; even 500 KB cached per file would be 15 MB and
 * evicting would just re-read from disk on the next poll.
 */
interface CachedPortalFile {
  buf: Buffer;
  mtimeMs: number;
  size: number;
  etag: string;
}
const portalCache = new Map<string, CachedPortalFile>();

function loadPortalFile(filePath: string): CachedPortalFile | null {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cached = portalCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const buf = readFileSync(filePath);
  const etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
  const entry: CachedPortalFile = { buf, mtimeMs: stat.mtimeMs, size: stat.size, etag };
  portalCache.set(filePath, entry);
  return entry;
}

function portalResponseFor(
  filePath: string,
  ifNoneMatch: string | undefined,
  portalRoot: string,
): Response {
  const entry = loadPortalFile(filePath);
  if (!entry) {
    // Caller falls back to index.html (SPA route) — null path shouldn't
    // happen here since the dispatcher already checked existsSync, but
    // defensive: 404 rather than throw.
    return new Response("Not Found", { status: 404 });
  }
  const headers = new Headers(portalSecurityHeaders(filePath, portalRoot));
  headers.set("ETag", entry.etag);
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(entry.buf as unknown as BodyInit, { headers });
}

function contentTypeFor(filePath: string): string {
  return PORTAL_MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Portal redirect, source-meta JSON, auth API endpoints, and SPA static
 * fallback. The api endpoints must be registered BEFORE the catch-all
 * /portal/* SPA fallback.
 */
export function mountPortalRoutes(app: RouteApp, deps: PortalRoutesDeps): void {
  const { portalRoot, authService, sourceService } = deps;
  const cookieName = deps.sessionCookieName ?? SESSION_COOKIE_BASE;
  // Cookie `Max-Age` is in seconds. The configured ms TTL is rounded
  // down (a 1500ms-TTL would otherwise become 1s; not a real-world
  // shape, but cleaner to floor than to ceil).
  const sessionMaxAgeS =
    deps.sessionTtlMs !== undefined
      ? Math.max(1, Math.floor(deps.sessionTtlMs / 1000))
      : DEFAULT_SESSION_MAX_AGE_S;

  // The query survives the redirect. `/portal?token=…` is how an operator is
  // handed a ready-to-open link — the page reads the token, logs in and strips
  // it — and dropping the query here turned that link into a login prompt with
  // no indication that a token had ever been supplied.
  app.get("/portal", scope.public(), (c) => {
    const query = new URL(c.req.url).search;
    return c.redirect(`/portal/${query}`);
  });

  app.get("/portal/source-meta.json", scope.public(), (c) => c.json(sourceService.getMeta()));
  app.get("/portal/icons.json", scope.public(), (c) => c.json(sourceService.getMeta()));

  app.get("/portal/widget-renderers.json", scope.public(), (c) => {
    const meta: Record<string, string> = {};
    for (const { kind } of getWidgetRenderers()) {
      const url = widgetRendererUrl(kind);
      if (url) meta[kind] = url;
    }
    return c.json({ renderers: meta });
  });

  app.get("/portal/widget-renderers/:kind/module.js", scope.public(), (c) => {
    const kind = c.req.param("kind");
    const modulePath = resolveWidgetRendererModule(kind);
    if (!modulePath) return new Response("Not Found", { status: 404 });
    return portalResponseFor(modulePath, c.req.header("If-None-Match") ?? undefined, portalRoot);
  });

  // Brute-force guard for the public login endpoint — it accepts 40-bit
  // pairing codes, so non-loopback clients get the same per-IP throttle as
  // `/devices/pair`. Loopback is exempt: a same-host caller can already read
  // the token file, so the limit buys no security against it (mirrors the
  // search / documents limiters) and would otherwise throttle local tooling.
  const loginLimiter = portalLoginRateLimiter();

  app.post("/portal/api/login", scope.public(), validateJson(portalLoginBody), async (c) => {
    if (!isLoopbackRequest(c) && loginLimiter.consume(clientIp(c))) {
      return c.json({ error: "Too many login attempts — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    const { token, deviceName, installId } = c.req.valid("json");
    const result = await authService.login(token, { deviceName, installId });
    if (!result.ok) {
      if (result.status === 401) throw new UnauthorizedError(result.error);
      if (result.status === 409) throw new ConflictError(result.error);
      throw new BadRequestError(result.error);
    }
    return c.json(
      { ok: true, scopes: result.scopes, csrfToken: portalCsrfToken(result.sessionId) },
      {
        headers: {
          "Set-Cookie": buildSessionCookieHeader(result.sessionId, sessionMaxAgeS, cookieName),
          "Cache-Control": "no-store",
        },
      },
    );
  });

  app.post("/portal/api/logout", scope.public(), async (c) => {
    const sessionId = getSessionCookie(c.req.header("Cookie"), cookieName);
    await authService.logout(sessionId);
    return c.json(
      { ok: true },
      { headers: { "Set-Cookie": clearSessionCookieHeader(cookieName) } },
    );
  });

  app.get("/portal/api/session", scope.public(), (c) => {
    const auth = c.get("auth") as AuthContext | undefined;
    if (!auth)
      return c.json({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
    return c.json(
      {
        authenticated: true,
        scopes: auth.scopes,
        csrfToken: auth.authMethod === "portal-session" ? auth.csrfToken : undefined,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });

  // Resolve portalRoot once at mount time so the
  // per-request realpath check is a fast prefix compare. We canonicalise
  // it with `realpathSync` to handle symlinks the operator might have
  // pointed at the portal directory; the per-request realpath of the
  // requested file then has to start with this same canonical prefix
  // (plus `path.sep`) or the request is rejected as a path-traversal
  // attempt.
  const canonicalPortalRoot = realpathSync(pathResolve(portalRoot)) + sep;

  // SPA catch-all — must be registered AFTER /portal/api/* routes.
  app.get("/portal/*", scope.public(), (c) => {
    const reqPath = c.req.path.replace(/^\/portal\/?/, "") || "index.html";
    const filePath = join(portalRoot, reqPath);
    const ifNoneMatch = c.req.header("If-None-Match") ?? undefined;
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      // Canonicalise + verify the resolved path stays under
      // `canonicalPortalRoot`. Hono normalises `..` segments before
      // routing, but a symlink inside portalRoot pointing outside
      // would still escape — realpath catches that case.
      let canonicalFilePath: string;
      try {
        canonicalFilePath = realpathSync(filePath);
      } catch {
        // realpath fails on dangling symlinks / non-files — fall
        // through to the SPA index.html below.
        canonicalFilePath = "";
      }
      if (canonicalFilePath && canonicalFilePath.startsWith(canonicalPortalRoot)) {
        return portalResponseFor(canonicalFilePath, ifNoneMatch, portalRoot);
      }
      // Path escaped portalRoot (symlink escape, symlink to /etc/passwd,
      // etc.) — refuse without revealing what was requested.
      return new Response("Not Found", { status: 404 });
    }
    return portalResponseFor(join(portalRoot, "index.html"), ifNoneMatch, portalRoot);
  });
}
