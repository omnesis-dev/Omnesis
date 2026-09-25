// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Targeted regression coverage for the canonical error envelope,
// status-code rules, sanitized 500 fallback,
// OAuth-callback HTML-escape, and Page<T> shape.
//
// These are deliberately decoupled from the per-route tests so the contract
// stays visible: every non-2xx response is `{error, code, detail?}`; every
// list endpoint is `{items, pageInfo: {nextCursor?, hasMore, limit}}`.
import { afterEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { buildPage, clampLimit } from "@omnesis/types";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  HttpError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  errorResponse,
} from "./errors.js";
import { validateJson } from "./validate.js";
import { escapeHtml, friendlyOauthError, renderOauthCallbackPage } from "./oauth-callback.js";

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    // Mirror the production sanitized 500 path.
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });
  return app;
}

describe("canonical error envelope", () => {
  test("every HttpError subclass renders { error, code, detail? } at the right status", async () => {
    const app = makeApp();
    app.get("/400-shape", () => {
      throw new BadRequestError("bad shape");
    });
    app.get("/400-validate", () => {
      throw new ValidationError("Validation failed", [{ path: "/x", message: "Required" }]);
    });
    app.get("/401", () => {
      throw new UnauthorizedError();
    });
    app.get("/403", () => {
      throw new ForbiddenError("admin scope required");
    });
    app.get("/404", () => {
      throw new NotFoundError("device not found");
    });
    app.get("/409", () => {
      throw new ConflictError("rebuild already in progress");
    });
    app.get("/502", () => {
      throw new BadGatewayError("collector dispatch failed");
    });
    app.get("/503", () => {
      throw new ServiceUnavailableError("indexer not ready");
    });
    app.get("/504", () => {
      throw new GatewayTimeoutError("embedder timeout");
    });

    for (const [path, status, code] of [
      ["/400-shape", 400, "BAD_REQUEST"],
      ["/401", 401, "UNAUTHORIZED"],
      ["/403", 403, "FORBIDDEN"],
      ["/404", 404, "NOT_FOUND"],
      ["/409", 409, "CONFLICT"],
      ["/502", 502, "BAD_GATEWAY"],
      ["/503", 503, "SERVICE_UNAVAILABLE"],
      ["/504", 504, "GATEWAY_TIMEOUT"],
    ] as const) {
      const res = await app.request(path);
      expect(res.status, path).toBe(status);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code, path).toBe(code);
      expect(typeof body.error, path).toBe("string");
    }

    // Validation errors carry structured `detail`.
    const valRes = await app.request("/400-validate");
    expect(valRes.status).toBe(400);
    const valBody = (await valRes.json()) as {
      error: string;
      code: string;
      detail: Array<{ path: string; message: string }>;
    };
    expect(valBody.error).toBe("Validation failed");
    expect(valBody.code).toBe("VALIDATION_ERROR");
    expect(valBody.detail[0].path).toBe("/x");
  });

  test("unknown errors fall through to a sanitized 500 — no err.message leak", async () => {
    const app = makeApp();
    app.get("/boom", () => {
      throw new Error("connection string foo bar");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
    // Must NOT echo the raw err.message.
    expect(JSON.stringify(body)).not.toContain("connection string");
  });
});

describe("Page<T> envelope", () => {
  test("buildPage produces { items, pageInfo: { hasMore, limit } } with no nextCursor when hasMore=false", () => {
    const page = buildPage([1, 2, 3], { hasMore: false, limit: 10 });
    expect(page).toEqual({
      items: [1, 2, 3],
      pageInfo: { hasMore: false, limit: 10 },
    });
  });

  test("buildPage with hasMore=true includes nextCursor", () => {
    const page = buildPage([{ id: "a" }, { id: "b" }], {
      hasMore: true,
      limit: 2,
      nextCursor: "b",
    });
    expect(page.pageInfo).toEqual({
      hasMore: true,
      limit: 2,
      nextCursor: "b",
    });
  });

  test("clampLimit honours default and max", () => {
    expect(clampLimit(null, { default: 50, max: 200 })).toBe(50);
    expect(clampLimit("100", { default: 50, max: 200 })).toBe(100);
    expect(clampLimit("9999", { default: 50, max: 200 })).toBe(200);
    expect(clampLimit("not-a-number", { default: 50, max: 200 })).toBe(50);
    expect(clampLimit("0", { default: 50, max: 200 })).toBe(50);
    expect(clampLimit("-5", { default: 50, max: 200 })).toBe(50);
  });
});

describe("OAuth callback rendering", () => {
  test("escapeHtml encodes the obvious XSS sinks", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;&#47;script&gt;",
    );
    // Single + double quotes + backtick + equals + slash + ampersand all escaped.
    expect(escapeHtml(`"=' ` + "`" + ` &/x`)).toBe("&quot;&#61;&#39; &#96; &amp;&#47;x");
  });

  test("friendlyOauthError maps known codes; otherwise generic refusal", () => {
    expect(friendlyOauthError("access_denied")).toBe("You declined to authorize Omnesis.");
    expect(friendlyOauthError("ACCESS_DENIED")).toBe("You declined to authorize Omnesis.");
    expect(friendlyOauthError("server_error")).toMatch(/internal error/i);
    expect(friendlyOauthError("invalid_grant")).toMatch(/grant.*rejected/i);
    // Unknown codes never echo.
    expect(friendlyOauthError("<script>")).toMatch(/Please retry/);
    expect(friendlyOauthError("totally-made-up")).toMatch(/Please retry/);
  });

  test("renderOauthCallbackPage never echoes raw markup, even when message + flowId carry it", () => {
    const html = renderOauthCallbackPage(
      "error",
      "<img src=x onerror=alert(1)>",
      "<script>alert(2)</script>",
    );
    // Raw script / img tags must not appear in the rendered HTML.
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toContain("<img src=x onerror");
    // Escaped forms do appear.
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    // Standard CSP + referrer headers baked in.
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('content="no-referrer"');
  });

  test("renderOauthCallbackPage success vs error swap the heading + accent without changing the layout", () => {
    const ok = renderOauthCallbackPage("success", "Authorization received");
    const fail = renderOauthCallbackPage("error", "Authorization failed");
    expect(ok).toContain("Authorization received");
    expect(fail).toContain("Authorization failed");
    // Identical structural prelude (no branch-specific scripts / asset deps).
    const headOk = ok.split("<body>")[0];
    const headFail = fail
      .split("<body>")[0]
      .replace("Authorization failed", "Authorization received")
      .replace("#c0392b", "#1f8a4c");
    expect(headOk).toBe(headFail);
  });
});

// The gateway used to answer 4xx silently: `errorResponse` returned the
// envelope and logged nothing. A client whose pushes were being refused —
// a phone holding a batch the schema no longer accepts — retried forever
// against a journal that showed no trace of it, leaving the rejection
// diagnosable only from the client's own logs.
describe("refusals are logged", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureWarnings() {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return lines;
  }

  test("a refused request logs its status, code, route and message", async () => {
    const lines = captureWarnings();
    const app = makeApp();
    app.post("/analytics/ingest", () => {
      throw new ValidationError("Validation failed", [
        { path: "/records/0/start_time", message: "Required" },
      ]);
    });

    const res = await app.request("/analytics/ingest", { method: "POST" });
    expect(res.status).toBe(400);

    const line = lines.find((l) => l.includes("VALIDATION_ERROR"));
    expect(line, `no refusal logged; saw ${JSON.stringify(lines)}`).toBeDefined();
    expect(line).toContain("400");
    expect(line).toContain("POST");
    expect(line).toContain("/analytics/ingest");
    // The detail is what makes the line actionable: it names the field that
    // broke, which is the whole point of logging the refusal at all.
    expect(line).toContain("/records/0/start_time");
  });

  test("a scope refusal is logged too — the 403 a push gets when its token is missing a write scope", async () => {
    const lines = captureWarnings();
    const app = makeApp();
    app.post("/documents", () => {
      throw new ForbiddenError("write:photos required");
    });

    const res = await app.request("/documents", { method: "POST" });
    expect(res.status).toBe(403);
    expect(lines.some((l) => l.includes("403") && l.includes("FORBIDDEN"))).toBe(true);
  });

  test("the response body is unchanged by the logging", async () => {
    captureWarnings();
    const app = makeApp();
    app.get("/404", () => {
      throw new NotFoundError("device not found");
    });

    const res = await app.request("/404");
    expect(await res.json()).toEqual({ error: "device not found", code: "NOT_FOUND" });
  });
});

describe("refusal logging keeps the log usable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureWarnings() {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return lines;
  }

  // `detail` is typed `unknown` and some routes attach whole domain
  // documents to it. Rendering those verbatim would put operator- and
  // corpus-derived content into a log file that gets pasted into issues.
  test("a non-validation detail is summarised, not serialised", async () => {
    const lines = captureWarnings();
    const app = makeApp();
    app.post("/privacy/policy", () => {
      throw new HttpError(409, "PRIVACY_POLICY_CONFLICT", "policy changed", {
        policy: "Never share anything from my personal mailbox with anyone.",
        revision: 7,
      });
    });

    await app.request("/privacy/policy", { method: "POST" });

    const line = lines.find((l) => l.includes("PRIVACY_POLICY_CONFLICT"));
    expect(line).toBeDefined();
    expect(line).not.toContain("personal mailbox");
    expect(line).toContain("detail=<object>");
  });

  // One rejected page can carry an issue per field per item. Left uncapped,
  // a collector re-sending it each cycle rotates the log away.
  test("a huge validation detail is truncated with a count of what was dropped", async () => {
    const lines = captureWarnings();
    const app = makeApp();
    const issues = Array.from({ length: 400 }, (_, i) => ({
      path: `/documents/${i}/sourceCreatedAt`,
      message: "Required",
    }));
    app.post("/documents", () => {
      throw new ValidationError("Validation failed", issues);
    });

    await app.request("/documents", { method: "POST" });

    const line = lines.find((l) => l.includes("VALIDATION_ERROR"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(1200);
    // Still names the first broken field — the reason for logging at all.
    expect(line).toContain("/documents/0/sourceCreatedAt");
    expect(line).toMatch(/more chars\)$/);
  });

  // This is the handler of last resort: anything that throws here escapes
  // `app.onError` and takes the response with it, so a detail that cannot be
  // serialised must degrade in both the log line and the body.
  test("an unserializable detail degrades instead of escaping the error handler", async () => {
    const lines = captureWarnings();
    const app = makeApp();
    const circular: Record<string, unknown> = { path: "/x", message: "bad" };
    circular.self = circular;
    app.post("/loop", () => {
      throw new ValidationError("Validation failed", [circular]);
    });

    const res = await app.request("/loop", { method: "POST" });

    // A well-formed envelope, minus the detail that could not be rendered.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Validation failed", code: "VALIDATION_ERROR" });
    expect(lines.some((l) => l.includes("detail=<unserializable>"))).toBe(true);
  });
});

// The malformed-JSON path does not go through `errorResponse` — Hono throws
// an `HTTPException` from the validator before any handler runs, and
// `app.onError` renders it separately. It needs its own log line for the
// same reason: a client sending a body the gateway cannot parse is
// otherwise invisible from the server side.
describe("malformed-body refusals are logged too", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a body that isn't JSON logs a 400 naming the route", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const app = new Hono();
    // Mirrors the production `app.onError` HTTPException branch.
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        const reqId = (c.get("requestId") as string | undefined) ?? "?";
        console.warn(
          `${err.status} BAD_REQUEST on ${c.req.method} ${c.req.path} [req=${reqId}]: ${err.message}`,
        );
        return c.json({ error: err.message || "request error", code: "BAD_REQUEST" }, err.status);
      }
      return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
    });
    app.post("/analytics/ingest", validateJson(z.object({ tableName: z.string() })), (c) =>
      c.json({ ok: true }),
    );

    const res = await app.request("/analytics/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    const line = lines.find((l) => l.includes("BAD_REQUEST"));
    expect(line, `no refusal logged; saw ${JSON.stringify(lines)}`).toBeDefined();
    expect(line).toContain("/analytics/ingest");
  });
});
