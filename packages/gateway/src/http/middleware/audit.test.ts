// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { LogLevel, setLogLevel } from "@omnesis/core";
import { tokenIdLogPrefix } from "../audit-format.js";
import { auditMiddleware } from "./audit.js";
import type { GatewayAuditSettings } from "@omnesis/config";
import type { AppEnv, AuthContext } from "../routes/types.js";
import type { DeviceId, TokenId } from "@omnesis/types";

// Invented, log-safe ids: long enough to prove prefix truncation.
const TOKEN_ID = "tok_abcdef0123456789" as TokenId;
const DEVICE_ID = "dev_0123456789abcdef" as DeviceId;

/**
 * Capture INFO log lines. The structured logger writes INFO straight to
 * `process.stderr.write`; spying there lets us assert the audit line content
 * without reaching into the logger internals.
 */
function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return { lines, spy };
}

/**
 * Build an app whose first middleware optionally installs an auth context,
 * followed by the audit middleware reading a mutable config holder.
 */
function makeApp(auth: AuthContext | null) {
  const holder: { audit: GatewayAuditSettings | undefined } = { audit: undefined };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-test-1");
    if (auth) c.set("auth", auth);
    await next();
  });
  app.use(
    "*",
    auditMiddleware(() => holder.audit),
  );
  app.get("/thing/:id", (c) => c.json({ ok: true }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.onError((_err, c) => c.json({ error: "nope" }, 500));
  return { app, holder };
}

const authed: AuthContext = {
  authMethod: "bearer",
  deviceId: DEVICE_ID,
  tokenId: TOKEN_ID,
  scopes: [],
};

beforeEach(() => setLogLevel(LogLevel.INFO));
afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel(LogLevel.WARN);
});

describe("tokenIdLogPrefix", () => {
  test("null/undefined → 'anon'", () => {
    expect(tokenIdLogPrefix(null)).toBe("anon");
    expect(tokenIdLogPrefix(undefined)).toBe("anon");
  });
  test("long id → first 6 chars only", () => {
    expect(tokenIdLogPrefix(TOKEN_ID)).toBe("tok_ab");
  });
});

describe("auditMiddleware", () => {
  test("disabled → no audit line", async () => {
    const { app } = makeApp(authed);
    const { lines } = captureStderr();
    await app.request("/thing/42");
    const audit = lines.filter((l) => l.includes(":audit]"));
    expect(audit).toHaveLength(0);
  });

  test("enabled + authed → exactly one INFO line with prefixes, method, route template, status, ms", async () => {
    const { app, holder } = makeApp(authed);
    holder.audit = { enabled: true };
    const { lines } = captureStderr();
    await app.request("/thing/42");
    const audit = lines.filter((l) => l.includes(":audit]"));
    expect(audit).toHaveLength(1);
    const line = audit[0]!;
    expect(line).toContain("GET");
    // route TEMPLATE, not the concrete id
    expect(line).toContain("/thing/:id");
    expect(line).not.toContain("/thing/42");
    expect(line).toContain("200");
    expect(line).toContain("tok=tok_ab");
    expect(line).toContain("dev=dev_0123");
    expect(line).toMatch(/in \d+ms/);
    expect(line).toContain("[req=req-test-1]");
  });

  test("the raw token / full id is NOT present in the line", async () => {
    const { app, holder } = makeApp(authed);
    holder.audit = { enabled: true };
    const { lines } = captureStderr();
    await app.request("/thing/42");
    const line = lines.filter((l) => l.includes(":audit]"))[0]!;
    expect(line).not.toContain(TOKEN_ID);
    expect(line).not.toContain(DEVICE_ID);
  });

  test("unauthenticated + includeUnauthenticated=false → no line", async () => {
    const { app, holder } = makeApp(null);
    holder.audit = { enabled: true };
    const { lines } = captureStderr();
    await app.request("/thing/42");
    expect(lines.filter((l) => l.includes(":audit]"))).toHaveLength(0);
  });

  test("unauthenticated + includeUnauthenticated=true → line with tok=anon dev=none", async () => {
    const { app, holder } = makeApp(null);
    holder.audit = { enabled: true, includeUnauthenticated: true };
    const { lines } = captureStderr();
    await app.request("/thing/42");
    const audit = lines.filter((l) => l.includes(":audit]"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!).toContain("tok=anon");
    expect(audit[0]!).toContain("dev=none");
  });

  test("status reflects the actual response (500 on a thrown route)", async () => {
    const { app, holder } = makeApp(authed);
    holder.audit = { enabled: true };
    const { lines } = captureStderr();
    await app.request("/boom");
    const line = lines.filter((l) => l.includes(":audit]"))[0]!;
    expect(line).toContain("500");
    expect(line).toContain("/boom");
  });
});
