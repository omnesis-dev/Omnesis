// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-route declarative scope.
 *
 * Every route's auth policy lives at its mount site, not in a path-pattern
 * classifier in the auth middleware. The mount carries one of:
 *
 *   - `scope.public()`         — no token required
 *   - `scope.read()`           — `read` scope or higher (admin satisfies)
 *   - `scope.readBulk()`       — `read:bulk` bulk-corpus scope (admin satisfies)
 *   - `scope.admin()`          — `admin` scope strictly
 *   - `scope.portalAdmin()`    — portal cookie + admin + CSRF synchronizer token
 *   - `scope.writeAny()`       — any `write:*` scope (handler refines per body)
 *   - `scope.subscriptionsManage()` — admin OR `subscriptions:manage`
 *   - `scope.deviceWs()`       — token-bearing WebSocket upgrade
 *
 * The outer auth middleware in `server.ts` only parses tokens (Bearer or
 * portal session) and stores the result on the context — it does not 401
 * or 403. Each per-route guard inspects `auth` and rejects on its own.
 *
 * `strictRoute(app)` wraps Hono's `app.<verb>(...)` registrars so that any
 * mount missing a scope guard throws *at registration time*. This is the
 * fail-closed gate the bundle requires: a route that hasn't declared a
 * policy can never be served.
 */
import { timingSafeEqual } from "node:crypto";
import { parseWebSocketAuthProtocolHeader } from "@omnesis/core";
import {
  parseSourceId,
  scopeSatisfies,
  SCOPE_ADMIN,
  SCOPE_ANSWER,
  SCOPE_READ,
  SCOPE_READ_BULK,
  SCOPE_PUSH_CLAIM,
  SCOPE_SUBSCRIPTIONS_MANAGE,
  SCOPE_SUBSCRIPTIONS_ANSWER,
  SCOPE_SUBSCRIPTIONS_OUTCOME,
  SCOPE_WRITE_ALL,
  trySourceId,
  trySourceType,
  writeScope,
  type SourceType,
  type Scope,
} from "@omnesis/types";
import { UnauthorizedError, ForbiddenError, BadRequestError } from "./errors.js";
import { PORTAL_CSRF_HEADER } from "./cookies.js";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv, AuthContext } from "./routes/types.js";

/** Symbol marker. Each guard middleware carries its policy name as a function-property. */
const POLICY_KEY = "_authPolicy" as const;

export type AuthPolicy =
  | "public"
  | "read"
  | "read-bulk"
  | "answer"
  | "answer-mcp"
  | "admin"
  | "portal-admin"
  | "legacy-mcp-self-revoke"
  | "write-any"
  | "subscriptions-manage"
  | "subscriptions-answer"
  | "subscriptions-outcome"
  | "push-claim"
  | "device-self"
  | "device-ws";

type GuardMW = MiddlewareHandler<AppEnv> & { [POLICY_KEY]: AuthPolicy };

function tag(mw: MiddlewareHandler<AppEnv>, policy: AuthPolicy): GuardMW {
  Object.defineProperty(mw, POLICY_KEY, { value: policy, enumerable: false });
  return mw as GuardMW;
}

function getAuth(c: Context<AppEnv>): AuthContext | null {
  return (c.get("auth") as AuthContext | undefined) ?? null;
}

function unauth(_c: Context<AppEnv>): never {
  throw new UnauthorizedError("Unauthorized");
}

function forbidden(_c: Context<AppEnv>, msg: string): never {
  throw new ForbiddenError(`Forbidden: ${msg}`);
}

function hasAnyWriteScope(scopes: readonly Scope[]): boolean {
  for (const s of scopes) {
    // `admin` is a superset of every write scope, the way every read guard in
    // this file treats it. Without this, the
    // `admin, read` portal session can't delete sources or ingest docs —
    // POST /documents/delete-all/source/:id silently 403s and the portal's
    // confirm-modal `onConfirm` swallows the error to console.error, so
    // Resync appears to do nothing.
    if (s === SCOPE_ADMIN || s === "write:*" || s.startsWith("write:")) return true;
  }
  return false;
}

function targetSourceType(sourceId: string): SourceType {
  const parsed = trySourceId(sourceId);
  if (!parsed) throw new BadRequestError("Invalid sourceId");
  return parseSourceId(parsed).sourceType;
}

/**
 * Refine `scope.writeAny()` for a concrete source mutation. Admin and
 * `write:*` may mutate any source; otherwise the token needs
 * `write:<sourceType>` for the target source id. Document ingest applies the
 * same rule per source type through `enforceWriteScopeForSourceType`, so one
 * token is never accepted by one write route and refused by another.
 */
export function enforceWriteScopeForSource(scopes: readonly Scope[], sourceId: string): void {
  if (scopeSatisfies(scopes, SCOPE_ADMIN) || scopeSatisfies(scopes, SCOPE_WRITE_ALL)) return;
  const sourceType = targetSourceType(sourceId);
  if (!scopeSatisfies(scopes, writeScope(sourceType))) {
    throw new ForbiddenError(`Forbidden: write:${sourceType} scope required`);
  }
}

/**
 * Same refinement when the route body carries a source type instead of a
 * full source id (e.g. `/devices/sources/bulk-upsert`).
 */
export function enforceWriteScopeForSourceType(scopes: readonly Scope[], sourceType: string): void {
  if (scopeSatisfies(scopes, SCOPE_ADMIN) || scopeSatisfies(scopes, SCOPE_WRITE_ALL)) return;
  const parsed = trySourceType(sourceType);
  if (!parsed) throw new BadRequestError("Invalid source type");
  if (!scopeSatisfies(scopes, writeScope(parsed))) {
    throw new ForbiddenError(`Forbidden: write:${parsed} scope required`);
  }
}

/**
 * Process-wide collector pushes cannot be narrowed to one source. Require a
 * broad writer (`write:*`) or admin so a narrow push client such as
 * `write:web` cannot rewrite gateway-wide source metadata.
 */
export function enforceBroadWriteScope(scopes: readonly Scope[]): void {
  if (scopeSatisfies(scopes, SCOPE_ADMIN) || scopeSatisfies(scopes, SCOPE_WRITE_ALL)) return;
  throw new ForbiddenError("Forbidden: write:* scope required");
}

/** No auth required. */
function publicRoute(): GuardMW {
  return tag(async (_c, next) => {
    await next();
  }, "public");
}

/**
 * Requires `read` scope.
 *
 * `admin` does NOT satisfy it: scopeSatisfies grants `read` for `read` or
 * `read:bulk` only, deliberately, so a token holding admin for control
 * routes does not silently gain corpus reads. A device kind that needs to
 * read is granted `read` explicitly (see defaultScopesForDeviceKind).
 */
function read(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_READ)) {
      return forbidden(c, "read scope required");
    }
    await next();
  }, "read");
}

/**
 * Requires bulk-read (`read:bulk`) scope; `admin` also satisfies it. Guards
 * the endpoints that enumerate or dump the corpus in bulk (full-document
 * listing/ids, bulk people-per-document, row-level analytics-table dumps) so a
 * plain `read` token cannot walk the whole corpus at once.
 */
function readBulk(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    const ok =
      scopeSatisfies(auth.scopes, SCOPE_ADMIN) || scopeSatisfies(auth.scopes, SCOPE_READ_BULK);
    if (!ok) return forbidden(c, "read:bulk scope required");
    await next();
  }, "read-bulk");
}

/** Requires `admin` scope. */
function admin(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_ADMIN)) {
      return forbidden(c, "admin scope required");
    }
    if (
      auth.authMethod === "portal-session" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    ) {
      requirePortalCsrf(c, auth);
    }
    await next();
  }, "admin");
}

function requirePortalCsrf(
  c: Context<AppEnv>,
  auth: Extract<AuthContext, { authMethod: "portal-session" }>,
): void {
  const presented = c.req.header(PORTAL_CSRF_HEADER);
  const expected = auth.csrfToken;
  const presentedBytes = Buffer.from(presented ?? "", "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (
    presentedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(presentedBytes, expectedBytes)
  ) {
    forbidden(c, "valid portal CSRF token required");
  }
}

/**
 * Policy-authoring boundary: only an authenticated browser session may pass,
 * even when a bearer token carries `admin`. The synchronizer token protects
 * the cookie-authenticated mutation against cross-site requests.
 */
function portalAdmin(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_ADMIN)) {
      return forbidden(c, "admin scope required");
    }
    if (auth.authMethod !== "portal-session") {
      return forbidden(c, "portal session required");
    }
    requirePortalCsrf(c, auth);
    await next();
  }, "portal-admin");
}

/**
 * One-time cutover boundary for a retired stdio MCP credential. Possession of
 * the exact legacy bearer is the proof needed to destroy it; it grants no
 * authority over any other token or device.
 */
function legacyMcpSelfRevoke(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (
      !auth ||
      auth.authMethod !== "bearer" ||
      !auth.deviceId ||
      !auth.tokenId ||
      auth.scopes.length !== 1 ||
      (auth.scopes[0] !== SCOPE_ANSWER && auth.scopes[0] !== SCOPE_READ)
    ) {
      return unauth(c);
    }
    await next();
  }, "legacy-mcp-self-revoke");
}

/** External answer boundary: dedicated `answer` scope or admin. */
function answer(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_ANSWER)) {
      return forbidden(c, "answer scope required");
    }
    await next();
  }, "answer");
}
/** Manage subscriptions owned by the authenticated integration device. */
function subscriptionsManage(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_SUBSCRIPTIONS_MANAGE)) {
      return forbidden(c, "subscriptions:manage scope required");
    }
    await next();
  }, "subscriptions-manage");
}

/** One firing's short-lived, privacy-reviewed Answer authority. */
function subscriptionsAnswer(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_SUBSCRIPTIONS_ANSWER)) {
      return forbidden(c, "subscriptions:answer scope required");
    }
    await next();
  }, "subscriptions-answer");
}

/** One firing's authority to report what its woken workflow did. */
function subscriptionsOutcome(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!scopeSatisfies(auth.scopes, SCOPE_SUBSCRIPTIONS_OUTCOME)) {
      return forbidden(c, "subscriptions:outcome scope required");
    }
    await next();
  }, "subscriptions-outcome");
}

/** Claim only the authenticated phone's queued notification content. */
function pushClaim(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (auth.authMethod !== "bearer" || !auth.deviceId) {
      return forbidden(c, "paired device token required");
    }
    if (!scopeSatisfies(auth.scopes, SCOPE_PUSH_CLAIM)) {
      return forbidden(c, "push:claim scope required");
    }
    await next();
  }, "push-claim");
}

/**
 * Requires a paired device's own bearer token and nothing more: the route
 * writes only the row that token belongs to, so the identity is the whole
 * authorization, as it is for the events a device sends over its socket.
 */
function deviceSelf(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (auth.authMethod !== "bearer" || !auth.deviceId) {
      return forbidden(c, "paired device token required");
    }
    await next();
  }, "device-self");
}

/**
 * Requires *any* write scope. The handler is responsible for refining the
 * check per source-type (e.g. `write:gmail` for gmail documents) — the
 * guard only ensures the caller carries at least one write scope at all.
 */
function writeAny(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return unauth(c);
    if (!hasAnyWriteScope(auth.scopes)) {
      return forbidden(c, "write scope required");
    }
    await next();
  }, "write-any");
}

/**
 * Device WebSocket upgrade gate. The route middleware validates the actual
 * token because it owns the `DeviceWsServer` instance and rate limiter; this
 * guard fail-closes requests that do not carry any supported token transport.
 */
function deviceWs(): GuardMW {
  return tag(async (c, next) => {
    const auth = getAuth(c);
    const protocolToken = parseWebSocketAuthProtocolHeader(c.req.header("sec-websocket-protocol"));
    const authHeader = c.req.header("Authorization");
    const hasBearerToken = authHeader?.startsWith("Bearer ") && authHeader.slice(7).trim() !== "";
    if (!auth && !protocolToken && !hasBearerToken) return unauth(c);
    await next();
  }, "device-ws");
}

export const scope = {
  public: publicRoute,
  read,
  readBulk,
  answer,
  subscriptionsManage,
  subscriptionsAnswer,
  subscriptionsOutcome,
  pushClaim,
  deviceSelf,
  admin,
  portalAdmin,
  legacyMcpSelfRevoke,
  writeAny,
  deviceWs,
};

/** Detect whether a value is one of our policy guards. */
function isGuard(x: unknown): x is GuardMW {
  return (
    typeof x === "function" && typeof (x as { [POLICY_KEY]?: unknown })[POLICY_KEY] === "string"
  );
}

export function policyOf(mw: unknown): AuthPolicy | null {
  return isGuard(mw) ? mw[POLICY_KEY] : null;
}

const HTTP_VERBS = ["get", "post", "put", "patch", "delete"] as const;
type Verb = (typeof HTTP_VERBS)[number];

/**
 * Wrap a Hono app's verb-registrars so any mount that doesn't include a
 * scope guard throws at registration. This is the bundle's fail-closed
 * invariant: a route without a declared policy can never be served.
 *
 * Returns the input app (mutated in place) for convenience.
 */
export function strictRoute<H extends Hono<AppEnv>>(app: H): H {
  type AppLike = Record<Verb, (path: string, ...handlers: unknown[]) => unknown>;
  const a = app as unknown as AppLike;
  for (const verb of HTTP_VERBS) {
    const orig = a[verb].bind(app) as (path: string, ...handlers: unknown[]) => unknown;
    a[verb] = (path: string, ...handlers: unknown[]) => {
      const hasGuard = handlers.some(isGuard);
      if (!hasGuard) {
        throw new Error(
          `Route ${verb.toUpperCase()} ${path} mounted without a scope guard. ` +
            `Add scope.public()/.read()/.readBulk()/.answer()/.admin()/.portalAdmin()/.subscriptionsManage()/.subscriptionsAnswer()/.pushClaim()/.writeAny()/.deviceWs() ` +
            `as the first middleware on the route.`,
        );
      }
      return orig(path, ...handlers);
    };
  }
  return app;
}
