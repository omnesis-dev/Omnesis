// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_ADMIN, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { HttpError, errorResponse } from "../http/errors.js";
import { strictRoute } from "../http/scope.js";
import { DecisionClients } from "../inference/decision/decision-clients.js";
import { InferenceRegistry } from "../inference/registry.js";
import { registerDecisionRoutes } from "./decision-routes.js";
import type { AppEnv } from "../http/routes/types.js";
import type { OmnesisConfig } from "@omnesis/config";

let dir: string;
let app: Hono<AppEnv>;
let registry: InferenceRegistry;
let decisionServer: ReturnType<typeof vi.fn>;

const VERIFY_ANSWERS = {
  verify_noul: { type: "noul", noul: 0.97 },
  verify_score: { type: "score", score: 1.2 },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-decision-routes-"));
  registry = new InferenceRegistry({
    modelsDir: join(dir, "models"),
    configDir: dir,
    manifest: () => ({ version: 1, models: [] }),
    hasAnthropicApiKey: () => false,
    hasTypeSafeApiKey: () => false,
  });
  registry.loadConfig({
    inference: {
      backends: {
        ollaya: {
          type: "http",
          preset: "ollaya",
          decision: { url: "http://127.0.0.1:11435/v1/systemone" },
        },
        // A backend whose key a form reuses when it adds decisions to it.
        keyed: {
          type: "http",
          apiKey: "sk-keyed",
          decision: { url: "http://127.0.0.1:11436/v1/systemone" },
        },
      },
      typesafe: { url: "http://127.0.0.1:18999/v1/systemone" },
      assignments: { decision: "ollaya/kev" },
    },
  } as unknown as OmnesisConfig);
  decisionServer = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/api/tags"))
      return Response.json({ models: [{ name: "kev:latest" }] });
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === "kevv")
      return new Response('{"error":"model \\"kevv\\" not found"}', { status: 404 });
    return Response.json({ model: `${body.model}:latest`, answers: VERIFY_ANSWERS });
  });
  const fetchFn = decisionServer as unknown as typeof fetch;
  const clients = new DecisionClients({
    getDecisionEndpoint: (key) => registry.getDecisionEndpoint(key),
    readTypeSafeApiKey: () => null,
    fetchFn,
  });

  app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "test-device" as DeviceId,
      tokenId: "test-token" as TokenId,
      scopes: [SCOPE_ADMIN] as Scope[],
    });
    await next();
  });
  registerDecisionRoutes(strictRoute(app), {
    allowRemoteInference: () => false,
    getDecisionEndpoint: (key) => registry.getDecisionEndpoint(key),
    hasBackend: (key) => registry.hasBackend(key),
    getBackendApiKey: (key) => registry.getBackendApiKey(key),
    resolveDecision: (assignment) => registry.resolveValue("decision", assignment),
    clients,
    fetchFn,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function post(path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("decision routes", () => {
  it("lists a local server's models", async () => {
    const res = await post("/admin/inference/backends/ollaya/decision/probe");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, listed: true, models: ["kev:latest"] });
  });

  it("verifies a model the server has, and explains one it does not", async () => {
    const good = await post("/admin/inference/backends/ollaya/decision/verify", { model: "kev" });
    expect(await good.json()).toMatchObject({ ok: true, answeredBy: "kev:latest" });

    const typo = await post("/admin/inference/backends/ollaya/decision/verify", { model: "kevv" });
    const body = (await typo.json()) as { ok: boolean; status: number; reason: string };
    expect(body).toMatchObject({ ok: false, status: 404 });
    expect(body.reason).toContain('The server has no model "kevv"');
  });

  it("verifies a TypeSafe model too", async () => {
    const res = await post("/admin/inference/typesafe/verify", { model: "jev-1.13.0" });
    expect(await res.json()).toMatchObject({ ok: true, answeredBy: "jev-1.13.0:latest" });
  });

  it("answers 404 for an unknown backend and 400 for a missing or oversized model", async () => {
    expect(
      (await post("/admin/inference/backends/nope/decision/verify", { model: "x" })).status,
    ).toBe(404);
    expect((await post("/admin/inference/backends/nope/decision/probe")).status).toBe(404);
    expect((await post("/admin/inference/backends/ollaya/decision/verify", {})).status).toBe(400);
    expect(
      (await post("/admin/inference/backends/ollaya/decision/verify", { model: "x".repeat(300) }))
        .status,
    ).toBe(400);
    expect(
      (await post("/admin/inference/backends/ollaya/decision/verify", { model: "kev", extra: 1 }))
        .status,
    ).toBe(400);
  });

  it("lists a server's models before it is saved", async () => {
    const res = await post("/admin/inference/decision/probe", {
      url: "http://127.0.0.1:11435/v1/systemone",
    });
    expect(await res.json()).toEqual({ ok: true, listed: true, models: ["kev:latest"] });
    expect((await post("/admin/inference/decision/probe", { url: "not a url" })).status).toBe(400);
  });

  it("sends a saved backend's key when probing an unsaved decision API for it", async () => {
    const authOf = () =>
      new Headers(decisionServer.mock.calls.at(-1)![1]?.headers as HeadersInit).get(
        "authorization",
      );
    await post("/admin/inference/decision/probe", {
      url: "http://127.0.0.1:11435/v1/systemone",
      backendKey: "keyed",
    });
    expect(authOf()).toBe("Bearer sk-keyed");
    // A key in the body wins over the backend's.
    await post("/admin/inference/decision/probe", {
      url: "http://127.0.0.1:11435/v1/systemone",
      backendKey: "keyed",
      apiKey: "sk-typed",
    });
    expect(authOf()).toBe("Bearer sk-typed");
    // A saved backend's own decision API is probed with its key.
    await post("/admin/inference/backends/keyed/decision/probe");
    expect(authOf()).toBe("Bearer sk-keyed");
    const unknown = await post("/admin/inference/decision/probe", {
      url: "http://127.0.0.1:11435/v1/systemone",
      backendKey: "gone",
    });
    expect(unknown.status).toBe(404);
  });

  it("does not reach a server off this host without consent", async () => {
    decisionServer.mockClear();
    const res = await post("/admin/inference/decision/probe", {
      url: "http://192.0.2.5:8000/v1/systemone",
    });
    expect(await res.json()).toMatchObject({ ok: false, listed: false });
    expect(decisionServer).not.toHaveBeenCalled();
  });

  it("reports an unavailable assignment without calling the server", async () => {
    registry.loadConfig({
      inference: {
        backends: {
          cloud: {
            type: "http",
            preset: "openrouter",
            decision: { url: "https://openrouter.ai/api/v1/systemone" },
          },
        },
      },
    } as unknown as OmnesisConfig);
    decisionServer.mockClear();
    const res = await post("/admin/inference/backends/cloud/decision/verify", {
      model: "liquid/d1",
    });
    expect(await res.json()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("send data off your machine"),
    });
    expect(decisionServer).not.toHaveBeenCalled();
  });

  it("serves no calibration routes", async () => {
    expect((await app.request("/admin/models/decision/calibration")).status).toBe(404);
    expect((await post("/admin/models/decision/calibration")).status).toBe(404);
  });
});
