// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Direct tests for `validateJson()` — covers the happy path, malformed JSON,
 * missing/wrong-typed fields, and the JSON-pointer paths in `detail`.
 *
 * The cross-cutting "every route validates its body" coverage lives in
 * the per-route test files (server.test.ts, model-credentials.test.ts).
 * This file is the unit-level smoke for the primitive itself.
 */
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { observeMalformedJson, validateJson } from "./validate.js";
import { HttpError, errorResponse } from "./errors.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";

function makeApp<T extends z.ZodTypeAny>(schema: T) {
  const app = new Hono();
  // Mirror the production `app.onError` shape so this unit test exercises
  // the canonical envelope produced by HttpError + errorResponse.
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return errorResponse(c, err);
    }
    if (err instanceof HTTPException) {
      return c.json(
        { error: err.message || "request error", code: "BAD_REQUEST" },
        err.status as ContentfulStatusCode,
      );
    }
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });
  app.post("/echo", validateJson(schema), (c) => c.json(c.req.valid("json")));
  return app;
}

describe("validateJson", () => {
  test("happy path: parsed body is reachable via c.req.valid('json')", async () => {
    const app = makeApp(z.object({ x: z.number(), y: z.string() }));
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: 42, y: "ok" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ x: 42, y: "ok" });
  });

  test("missing required field returns 400 with JSON-pointer path", async () => {
    const app = makeApp(z.object({ name: z.string(), age: z.number() }));
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      detail: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.detail).toHaveLength(1);
    expect(body.detail[0].path).toBe("/age");
  });

  test("nested validation errors carry nested JSON-pointer paths", async () => {
    const app = makeApp(
      z.object({
        user: z.object({
          email: z.string().email(),
          phones: z.array(z.string().min(1)),
        }),
      }),
    );
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { email: "not-an-email", phones: ["+1", ""] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      detail: Array<{ path: string; message: string }>;
    };
    const paths = body.detail.map((d) => d.path).sort();
    expect(paths).toEqual(["/user/email", "/user/phones/1"]);
  });

  test("wrong type returns 400 (string where number expected)", async () => {
    const app = makeApp(z.object({ count: z.number() }));
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      detail: Array<{ path: string; message: string }>;
    };
    expect(body.detail[0].path).toBe("/count");
  });

  test("malformed JSON body returns 400 (Hono validator throws HTTPException)", async () => {
    const app = makeApp(z.object({ x: z.number() }));
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {",
    });
    expect(res.status).toBe(400);
  });

  test("a malformed-body observer sees the original bytes and preserves the 400", async () => {
    const observed: string[] = [];
    const app = new Hono();
    app.onError((error, c) =>
      c.json({ error: error instanceof Error ? error.message : String(error) }, 400),
    );
    app.post(
      "/echo",
      observeMalformedJson((body) => observed.push(body)),
      validateJson(z.object({ x: z.number() })),
      (c) => c.json(c.req.valid("json")),
    );

    const response = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"x":42',
    });

    expect(response.status).toBe(400);
    expect(observed).toEqual(['{"x":42']);
  });

  test("missing Content-Type with malformed body short-circuits as missing fields", async () => {
    // Hono's validator skips JSON parse when content-type is absent or
    // non-JSON. In that case `value` defaults to {} and the schema fails on
    // missing fields — rendered through our 400 envelope. This documents
    // the boundary so route authors know to set Content-Type.
    const app = makeApp(z.object({ x: z.number() }));
    const res = await app.request("/echo", {
      method: "POST",
      body: "garbage",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      detail: Array<{ path: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.detail[0].path).toBe("/x");
  });

  test("schemas with .transform() produce the transformed value at the handler", async () => {
    const app = makeApp(z.object({ raw: z.string().transform((s) => s.toUpperCase()) }));
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ raw: "HELLO" });
  });
});
