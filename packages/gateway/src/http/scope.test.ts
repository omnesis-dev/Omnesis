// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the per-route scope guards and the `strictRoute()`
 * fail-closed wrapper. These cover the primitive itself; the cross-cutting
 * "every route in the gateway has a guard" coverage is exercised
 * implicitly by `server.test.ts` (which boots the full app — and would
 * throw at construction if any route is missing a guard).
 */
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import {
  SCOPE_ADMIN,
  SCOPE_ANSWER,
  SCOPE_READ,
  SCOPE_READ_BULK,
  SCOPE_WRITE_ALL,
  Scope,
  type DeviceId,
  type TokenId,
} from "@omnesis/types";
import {
  enforceBroadWriteScope,
  enforceWriteScopeForSource,
  enforceWriteScopeForSourceType,
  policyOf,
  scope,
  strictRoute,
} from "./scope.js";
import { BadRequestError, ForbiddenError, HttpError, errorResponse } from "./errors.js";
import type { AppEnv, AuthContext } from "./routes/types.js";

function authStub(scopes: ReturnType<typeof Scope>[]): AuthContext {
  return {
    authMethod: "bearer",
    deviceId: "dev_test" as DeviceId,
    tokenId: "tok_test" as TokenId,
    scopes,
  };
}

function makeApp(auth: AuthContext | null) {
  const app = strictRoute(new Hono<AppEnv>());
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  return app;
}

describe("scope guards", () => {
  test("public: no auth required, allows anonymous", async () => {
    const app = makeApp(null);
    app.get("/p", scope.public(), (c) => c.json({ ok: true }));
    const res = await app.request("/p");
    expect(res.status).toBe(200);
  });

  test("read: 401 with no auth, 403 without read scope, 200 with read", async () => {
    let app = makeApp(null);
    app.get("/r", scope.read(), (c) => c.json({ ok: true }));
    expect((await app.request("/r")).status).toBe(401);

    app = makeApp(authStub([Scope("write:gmail")]));
    app.get("/r", scope.read(), (c) => c.json({ ok: true }));
    expect((await app.request("/r")).status).toBe(403);

    app = makeApp(authStub([SCOPE_READ]));
    app.get("/r", scope.read(), (c) => c.json({ ok: true }));
    expect((await app.request("/r")).status).toBe(200);
  });

  test("readBulk: 401 no auth, 403 with only read, 200 with read:bulk or admin", async () => {
    let app = makeApp(null);
    app.get("/rb", scope.readBulk(), (c) => c.json({ ok: true }));
    expect((await app.request("/rb")).status).toBe(401);

    // A plain read token cannot hit a bulk-corpus endpoint.
    app = makeApp(authStub([SCOPE_READ]));
    app.get("/rb", scope.readBulk(), (c) => c.json({ ok: true }));
    expect((await app.request("/rb")).status).toBe(403);

    // read:bulk passes.
    app = makeApp(authStub([SCOPE_READ_BULK]));
    app.get("/rb", scope.readBulk(), (c) => c.json({ ok: true }));
    expect((await app.request("/rb")).status).toBe(200);

    // admin also satisfies it, the way every read guard's fallback does.
    app = makeApp(authStub([SCOPE_ADMIN]));
    app.get("/rb", scope.readBulk(), (c) => c.json({ ok: true }));
    expect((await app.request("/rb")).status).toBe(200);
  });

  test("read:bulk satisfies read (it is a superset of read)", async () => {
    const app = makeApp(authStub([SCOPE_READ_BULK]));
    app.get("/r", scope.read(), (c) => c.json({ ok: true }));
    expect((await app.request("/r")).status).toBe(200);
  });

  test("admin: only admin scope passes (read does NOT satisfy admin)", async () => {
    let app = makeApp(authStub([SCOPE_READ]));
    app.get("/a", scope.admin(), (c) => c.json({ ok: true }));
    expect((await app.request("/a")).status).toBe(403);

    app = makeApp(authStub([SCOPE_ADMIN]));
    app.get("/a", scope.admin(), (c) => c.json({ ok: true }));
    expect((await app.request("/a")).status).toBe(200);
  });

  test("portalAdmin: requires a portal session, admin scope, and matching CSRF token", async () => {
    const csrfToken = "a".repeat(64);

    let app = makeApp(null);
    app.put("/policy", scope.portalAdmin(), (c) => c.json({ ok: true }));
    expect((await app.request("/policy", { method: "PUT" })).status).toBe(401);

    app = makeApp(authStub([SCOPE_ADMIN]));
    app.put("/policy", scope.portalAdmin(), (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("/policy", {
          method: "PUT",
          headers: { "X-Omnesis-CSRF": csrfToken },
        })
      ).status,
    ).toBe(403);

    const portalAuth: AuthContext = {
      authMethod: "portal-session",
      deviceId: null,
      credentialDeviceId: null,
      tokenId: "tok_test" as TokenId,
      scopes: [SCOPE_ADMIN],
      csrfToken,
    };
    app = makeApp(portalAuth);
    app.put("/policy", scope.portalAdmin(), (c) => c.json({ ok: true }));
    expect((await app.request("/policy", { method: "PUT" })).status).toBe(403);
    expect(
      (
        await app.request("/policy", {
          method: "PUT",
          headers: { "X-Omnesis-CSRF": "b".repeat(64) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/policy", {
          method: "PUT",
          headers: { "X-Omnesis-CSRF": csrfToken },
        })
      ).status,
    ).toBe(200);
  });

  test("admin requires CSRF for unsafe portal-session requests but not bearer clients", async () => {
    const csrfToken = "c".repeat(64);
    const portalAuth: AuthContext = {
      authMethod: "portal-session",
      deviceId: null,
      credentialDeviceId: null,
      tokenId: "tok_test" as TokenId,
      scopes: [SCOPE_ADMIN],
      csrfToken,
    };
    let app = makeApp(portalAuth);
    app.post("/admin-action", scope.admin(), (c) => c.json({ ok: true }));
    expect((await app.request("/admin-action", { method: "POST" })).status).toBe(403);
    expect(
      (
        await app.request("/admin-action", {
          method: "POST",
          headers: { "X-Omnesis-CSRF": csrfToken },
        })
      ).status,
    ).toBe(200);

    app = makeApp(authStub([SCOPE_ADMIN]));
    app.post("/admin-action", scope.admin(), (c) => c.json({ ok: true }));
    expect((await app.request("/admin-action", { method: "POST" })).status).toBe(200);
  });

  test("admin alone does NOT satisfy read — scopeSatisfies is literal", async () => {
    // Production tokens for admin clients carry [SCOPE_ADMIN, SCOPE_READ,
    // SCOPE_WRITE_ALL] together (see ws.test.ts setup); the guard checks
    // literal membership so admin-only would 403 on a read route. This
    // test pins the contract so a future "admin implies read" change is
    // a deliberate decision, not an accident.
    const app = makeApp(authStub([SCOPE_ADMIN]));
    app.get("/r", scope.read(), (c) => c.json({ ok: true }));
    expect((await app.request("/r")).status).toBe(403);
  });

  test("writeAny: any write scope passes; read-only fails", async () => {
    let app = makeApp(authStub([SCOPE_READ]));
    app.post("/w", scope.writeAny(), (c) => c.json({ ok: true }));
    expect((await app.request("/w", { method: "POST" })).status).toBe(403);

    app = makeApp(authStub([SCOPE_WRITE_ALL]));
    app.post("/w", scope.writeAny(), (c) => c.json({ ok: true }));
    expect((await app.request("/w", { method: "POST" })).status).toBe(200);

    app = makeApp(authStub([Scope("write:apple-health")]));
    app.post("/w", scope.writeAny(), (c) => c.json({ ok: true }));
    expect((await app.request("/w", { method: "POST" })).status).toBe(200);

    // Admin is a superset of every write scope — the portal session
    // (admin + read, no write:*) must be able to hit /documents/delete-all
    // and friends. Without this, "Remove source" in the portal silently
    // 403s and the confirm modal's onConfirm catch swallows the error.
    app = makeApp(authStub([SCOPE_ADMIN]));
    app.post("/w", scope.writeAny(), (c) => c.json({ ok: true }));
    expect((await app.request("/w", { method: "POST" })).status).toBe(200);
  });

  test("source write refinement allows admin, write:* and matching write:<type>", () => {
    expect(() => enforceWriteScopeForSource([SCOPE_ADMIN], "gmail:maya@example.com")).not.toThrow();
    expect(() => enforceWriteScopeForSource([SCOPE_WRITE_ALL], "apple-health:local")).not.toThrow();
    expect(() =>
      enforceWriteScopeForSource([Scope("write:gmail")], "gmail:maya@example.com"),
    ).not.toThrow();
    expect(() => enforceWriteScopeForSourceType([Scope("write:gmail")], "gmail")).not.toThrow();
  });

  test("source write refinement rejects mismatched source types", () => {
    expect(() => enforceWriteScopeForSource([Scope("write:gmail")], "apple-health:local")).toThrow(
      ForbiddenError,
    );
    expect(() => enforceWriteScopeForSourceType([Scope("write:gmail")], "apple-health")).toThrow(
      ForbiddenError,
    );
  });

  test("source write refinement rejects malformed source identifiers", () => {
    expect(() => enforceWriteScopeForSource([Scope("write:gmail")], "not a source")).toThrow(
      BadRequestError,
    );
    expect(() => enforceWriteScopeForSourceType([Scope("write:gmail")], "Notion")).toThrow(
      BadRequestError,
    );
  });

  test("broad write refinement rejects source-specific writers", () => {
    expect(() => enforceBroadWriteScope([SCOPE_ADMIN])).not.toThrow();
    expect(() => enforceBroadWriteScope([SCOPE_WRITE_ALL])).not.toThrow();
    expect(() => enforceBroadWriteScope([Scope("write:gmail")])).toThrow(ForbiddenError);
  });

  test("deviceWs: requires an auth context or upgrade token transport", async () => {
    let app = makeApp(null);
    app.get("/ws", scope.deviceWs(), (c) => c.json({ ok: true }));
    expect((await app.request("/ws")).status).toBe(401);

    app = makeApp(null);
    app.get("/ws", scope.deviceWs(), (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("/ws", {
          headers: { "Sec-WebSocket-Protocol": "omnesis-token.omn_test" },
        })
      ).status,
    ).toBe(200);

    app = makeApp(null);
    app.get("/ws", scope.deviceWs(), (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("/ws", {
          headers: { Authorization: "Bearer omn_test" },
        })
      ).status,
    ).toBe(200);
  });

  test("403 envelope shape: { error, code: FORBIDDEN }", async () => {
    const app = makeApp(authStub([SCOPE_READ]));
    app.get("/a", scope.admin(), (c) => c.json({ ok: true }));
    const res = await app.request("/a");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden: admin scope required",
      code: "FORBIDDEN",
    });
  });

  test("401 envelope shape: { error, code: UNAUTHORIZED }", async () => {
    const app = makeApp(null);
    app.get("/r", scope.read(), (c) => c.json({ ok: true }));
    const res = await app.request("/r");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
  });
});

describe("deviceSelf", () => {
  test("a paired device's bearer token passes with no scope at all", async () => {
    const app = makeApp(authStub([]));
    app.post("/self", scope.deviceSelf(), (c) => c.json({ device: c.get("auth").deviceId }));
    const res = await app.request("/self", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ device: "dev_test" });
  });

  test("anonymous is 401; a bearer without a device and a portal session are 403", async () => {
    const anonymous = makeApp(null);
    anonymous.post("/self", scope.deviceSelf(), (c) => c.json({ ok: true }));
    expect((await anonymous.request("/self", { method: "POST" })).status).toBe(401);

    const deviceless = makeApp({ ...authStub([]), deviceId: null });
    deviceless.post("/self", scope.deviceSelf(), (c) => c.json({ ok: true }));
    expect((await deviceless.request("/self", { method: "POST" })).status).toBe(403);

    const portal = makeApp({
      authMethod: "portal-session",
      deviceId: null,
      credentialDeviceId: null,
    } as unknown as AuthContext);
    portal.post("/self", scope.deviceSelf(), (c) => c.json({ ok: true }));
    expect((await portal.request("/self", { method: "POST" })).status).toBe(403);
  });
});

describe("policyOf — guard introspection", () => {
  test("returns the policy name for each guard kind", () => {
    expect(policyOf(scope.public())).toBe("public");
    expect(policyOf(scope.read())).toBe("read");
    expect(policyOf(scope.admin())).toBe("admin");
    expect(policyOf(scope.writeAny())).toBe("write-any");
    expect(policyOf(scope.deviceSelf())).toBe("device-self");
    expect(policyOf(scope.deviceWs())).toBe("device-ws");
  });

  test("returns null for non-guard middleware", () => {
    const random = async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
    expect(policyOf(random)).toBeNull();
    expect(policyOf("not a function")).toBeNull();
    expect(policyOf(undefined)).toBeNull();
  });
});

describe("strictRoute — fail-closed at registration", () => {
  test("throws on POST mounted without a guard", () => {
    const app = strictRoute(new Hono<AppEnv>());
    expect(() => app.post("/oops", (c) => c.json({ ok: true }))).toThrow(
      /mounted without a scope guard/,
    );
  });

  test("throws on GET mounted without a guard", () => {
    const app = strictRoute(new Hono<AppEnv>());
    expect(() => app.get("/oops", (c) => c.json({ ok: true }))).toThrow(
      /Route GET \/oops mounted without a scope guard/,
    );
  });

  test("throws on DELETE / PATCH / PUT mounted without a guard", () => {
    const app = strictRoute(new Hono<AppEnv>());
    expect(() => app.delete("/x", (c) => c.json({}))).toThrow(/scope guard/);
    expect(() => app.patch("/x", (c) => c.json({}))).toThrow(/scope guard/);
    expect(() => app.put("/x", (c) => c.json({}))).toThrow(/scope guard/);
  });

  test("does NOT throw when a guard is present at any position", () => {
    const app = strictRoute(new Hono<AppEnv>());
    // Guard first
    expect(() => app.get("/a", scope.read(), (c) => c.json({}))).not.toThrow();
    // Or guard later in the chain (defensive — registration accepts any
    // position so refactors that interleave validateJson() etc. don't break).
    expect(() =>
      app.post(
        "/b",
        async (_c, next) => {
          await next();
        },
        scope.admin(),
        (c) => c.json({}),
      ),
    ).not.toThrow();
  });

  test("a non-guard middleware does NOT count as a guard", () => {
    const app = strictRoute(new Hono<AppEnv>());
    const fakeGuard = async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
    expect(() => app.get("/c", fakeGuard, (c) => c.json({}))).toThrow(/scope guard/);
  });
});
