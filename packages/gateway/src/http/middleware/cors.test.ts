// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "./cors.js";
import type { GatewayCorsSettings } from "@omnesis/config";
import type { AppEnv } from "../routes/types.js";

const APP_ORIGIN = "https://omnesis.example.com";
const OTHER_ORIGIN = "https://evil.example.org";

/**
 * Build a minimal app with the CORS middleware reading from a mutable holder,
 * so a single test can mutate the closed-over config between requests and
 * assert hot-reload. `handlerHits` tracks whether the GET route ran, to prove
 * a preflight short-circuits without reaching it.
 */
function makeApp() {
  const holder: { cors: GatewayCorsSettings | undefined } = { cors: undefined };
  let handlerHits = 0;
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    corsMiddleware(() => holder.cors),
  );
  app.get("/thing", (c) => {
    handlerHits += 1;
    return c.json({ ok: true });
  });
  return { app, holder, hits: () => handlerHits };
}

describe("corsMiddleware", () => {
  test("no cors config → no Access-Control-* headers", async () => {
    const { app } = makeApp();
    const res = await app.request("/thing", { headers: { Origin: APP_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("exact-match allowedOrigins echoes the origin; non-listed origin gets nothing", async () => {
    const { app, holder } = makeApp();
    holder.cors = { allowedOrigins: [APP_ORIGIN] };

    const ok = await app.request("/thing", { headers: { Origin: APP_ORIGIN } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);

    const denied = await app.request("/thing", { headers: { Origin: OTHER_ORIGIN } });
    expect(denied.status).toBe(200);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("'*' wildcard without credentials → Allow-Origin: *", async () => {
    const { app, holder } = makeApp();
    holder.cors = { allowedOrigins: ["*"] };
    const res = await app.request("/thing", { headers: { Origin: OTHER_ORIGIN } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Vary")).toBeNull();
  });

  test("allowCredentials + '*' echoes the concrete origin (never literal *) + Vary + Allow-Credentials", async () => {
    const { app, holder } = makeApp();
    holder.cors = { allowedOrigins: ["*"], allowCredentials: true };
    const res = await app.request("/thing", { headers: { Origin: APP_ORIGIN } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  test("OPTIONS preflight → 204 + Allow-Methods + Allow-Headers (incl. Authorization) + Max-Age, route not reached", async () => {
    const { app, holder, hits } = makeApp();
    holder.cors = { allowedOrigins: [APP_ORIGIN] };
    const res = await app.request("/thing", {
      method: "OPTIONS",
      headers: { Origin: APP_ORIGIN, "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).toContain("Authorization");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
    expect(hits()).toBe(0);
  });

  test("OPTIONS preflight for a disallowed origin → 204 with no CORS headers", async () => {
    const { app, holder } = makeApp();
    holder.cors = { allowedOrigins: [APP_ORIGIN] };
    const res = await app.request("/thing", {
      method: "OPTIONS",
      headers: { Origin: OTHER_ORIGIN, "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("custom allowedMethods / allowedHeaders / maxAgeSeconds override the defaults", async () => {
    const { app, holder } = makeApp();
    holder.cors = {
      allowedOrigins: [APP_ORIGIN],
      allowedMethods: ["GET", "POST"],
      allowedHeaders: ["Authorization", "X-Custom"],
      maxAgeSeconds: 120,
    };
    const res = await app.request("/thing", {
      method: "OPTIONS",
      headers: { Origin: APP_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, X-Custom");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("120");
  });

  test("hot-reload: mutating the closed-over config takes effect on the next request", async () => {
    const { app, holder } = makeApp();

    const before = await app.request("/thing", { headers: { Origin: APP_ORIGIN } });
    expect(before.headers.get("Access-Control-Allow-Origin")).toBeNull();

    holder.cors = { allowedOrigins: [APP_ORIGIN] };
    const after = await app.request("/thing", { headers: { Origin: APP_ORIGIN } });
    expect(after.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });
});
