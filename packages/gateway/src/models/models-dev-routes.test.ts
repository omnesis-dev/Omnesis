// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPE_ADMIN, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { ConfigStore } from "../config-store.js";
import { HttpError, errorResponse } from "../http/errors.js";
import { strictRoute } from "../http/scope.js";
import { ModelManager } from "./manager.js";
import { ModelsDevCatalog } from "./models-dev-catalog.js";
import { registerModelRoutes } from "./routes.js";
import type { InferenceOverview } from "@omnesis/core";
import type { AppEnv } from "../http/routes/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-models-dev-routes-"));
  dirs.push(dir);
  const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  await configStore.load();
  const result = await configStore.put({
    inference: { assignments: { agent: "deepseek/deepseek-example" } },
  });
  if (!result.ok) throw new Error("fixture config failed");
  const inference: InferenceOverview = {
    backends: {
      deepseek: { type: "http", status: "ok", models: ["deepseek-example", "unknown-model"] },
    },
    assignments: {
      agent: {
        role: "agent",
        kind: "http",
        backendKey: "deepseek",
        url: "https://api.example.com",
        model: "deepseek-example",
        allowRemoteInference: true,
        available: true,
      },
    } as InferenceOverview["assignments"],
  };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h2v2H0z"/></svg>';
  const fetcher = vi.fn(
    async (url: string | URL | Request) =>
      new Response(String(url).includes("/logos/") ? svg : "{}", { status: 200 }),
  );
  const modelsDevCatalog = new ModelsDevCatalog({
    configDir: dir,
    bundledFetchedAt: Date.now(),
    fetcher: fetcher as typeof fetch,
    bundled: {
      deepseek: {
        name: "DeepSeek",
        models: {
          "deepseek-example": {
            reasoning: true,
            reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
            modalities: { input: ["text"], output: ["text"] },
            tool_call: true,
          },
        },
      },
    },
  });
  const app = new Hono<AppEnv>();
  app.onError((err, c) =>
    err instanceof HttpError ? errorResponse(c, err) : new Response(String(err), { status: 500 }),
  );
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/admin/"))
      c.set("auth", {
        authMethod: "bearer",
        deviceId: "test-device" as DeviceId,
        tokenId: "test-token" as TokenId,
        scopes: [SCOPE_ADMIN] as Scope[],
      });
    await next();
  });
  registerModelRoutes(strictRoute(app), {
    modelManager: new ModelManager({ modelsDir: dir }),
    modelsDevCatalog,
    configStore,
    getSystemInfo: () => ({}) as ReturnType<typeof import("../system-info.js").getSystemInfo>,
    getInferenceOverview: () => inference,
    probeBackend: vi.fn(),
    verifyModel: vi.fn(),
  });
  return { app, configStore, fetcher, inference };
}

describe("Models.dev model routes", () => {
  it("exposes matched controls and keeps unknown listed models", async () => {
    const { app, configStore } = await fixture();
    const response = await app.request("/admin/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.modelControls["deepseek/deepseek-example"].controls).toEqual([
      { key: "reasoningEnabled", type: "boolean", label: "Reasoning" },
      { key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "high"] },
    ]);
    expect(body.modelControls["deepseek/unknown-model"].source).toBe("unknown");
    expect(body.inference.backends.deepseek.models).toContain("unknown-model");
    expect(body.modelSettings.agent).toEqual({
      assignment: "deepseek/deepseek-example",
      values: {},
    });
    configStore.stop();
  });

  it("saves a full replacement and rejects stale assignments and unsupported values", async () => {
    const { app, configStore } = await fixture();
    const patch = (assignment: string, values: object) =>
      app.request("/admin/models/behavior/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignment, values }),
      });
    expect(
      (
        await patch("deepseek/deepseek-example", {
          reasoningEnabled: false,
          reasoningEffort: "high",
        })
      ).status,
    ).toBe(400);
    expect((await patch("deepseek/deepseek-example", { reasoningEnabled: false })).status).toBe(
      200,
    );
    expect(configStore.get().inference?.modelSettings?.agent?.values).toEqual({
      reasoningEnabled: false,
    });
    expect((await patch("deepseek/deepseek-example", {})).status).toBe(200);
    expect(configStore.get().inference?.modelSettings?.agent?.values).toEqual({});
    expect((await patch("deepseek/deepseek-example", { reasoningEffort: "medium" })).status).toBe(
      400,
    );
    expect((await patch("deepseek/unknown-model", { reasoningEnabled: true })).status).toBe(409);
    expect(configStore.get().inference?.modelSettings?.agent?.values).toEqual({});
    configStore.stop();
  });

  it("exposes and saves provider-native Codex reasoning efforts", async () => {
    const { app, configStore, inference } = await fixture();
    const updated = await configStore.put({
      inference: {
        allowRemoteInference: true,
        assignments: { agent: "codex/gpt-example-frontier" },
      },
    });
    if (!updated.ok) throw new Error("Codex fixture config failed");
    inference.codex = {
      type: "codex",
      configured: true,
      status: "ok",
      loggedIn: true,
      models: ["gpt-example-frontier"],
      modelDetails: [
        {
          id: "gpt-example-frontier",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        },
      ],
    };
    inference.assignments.agent = {
      role: "agent",
      kind: "codex",
      model: "gpt-example-frontier",
      allowRemoteInference: true,
      available: true,
    };

    const overview = await (await app.request("/admin/models")).json();
    expect(overview.modelControls["codex/gpt-example-frontier"]).toMatchObject({
      source: "provider",
      controls: [{ key: "reasoningEffort", values: ["low", "medium", "high", "xhigh"] }],
    });
    const response = await app.request("/admin/models/behavior/agent", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assignment: "codex/gpt-example-frontier",
        values: { reasoningEffort: "xhigh" },
      }),
    });
    expect(response.status).toBe(200);
    expect(configStore.get().inference?.modelSettings?.agent).toEqual({
      assignment: "codex/gpt-example-frontier",
      values: { reasoningEffort: "xhigh" },
    });
    configStore.stop();
  });

  it("rejects a concurrent stale replacement while old request bodies remain compatible", async () => {
    const { app, configStore } = await fixture();
    const patch = (values: object, expectedValues?: object) =>
      app.request("/admin/models/behavior/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assignment: "deepseek/deepseek-example",
          values,
          ...(expectedValues === undefined ? {} : { expectedValues }),
        }),
      });
    const [first, second] = await Promise.all([
      patch({ reasoningEnabled: false }, {}),
      patch({ reasoningEffort: "high" }, {}),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? { reasoningEnabled: false } : { reasoningEffort: "high" };
    expect(configStore.get().inference?.modelSettings?.agent?.values).toEqual(winner);
    expect((await patch({ reasoningEnabled: true }, {})).status).toBe(409);
    expect(configStore.get().inference?.modelSettings?.agent?.values).toEqual(winner);
    expect((await patch({ reasoningEffort: "low" })).status).toBe(200);
    expect(configStore.get().inference?.modelSettings?.agent?.values).toEqual({
      reasoningEffort: "low",
    });
    configStore.stop();
  });

  it("refuses reasoning updates on roles and runtime paths that cannot send them", async () => {
    const { app, configStore, inference } = await fixture();
    const body = JSON.stringify({
      assignment: "deepseek/deepseek-example",
      values: { reasoningEnabled: true },
    });
    const request = (role: string) =>
      app.request(`/admin/models/behavior/${role}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await request("embedder")).status).toBe(400);
    inference.assignments.agent = {
      role: "agent",
      kind: "anthropic",
      catalogId: "anthropic/claude-example",
      apiModelId: "claude-example",
      available: true,
      allowRemoteInference: true,
    };
    expect((await request("agent")).status).toBe(400);
    configStore.stop();
  });

  it("serves a passive cached SVG with no token and rejects unknown provider IDs", async () => {
    const { app, fetcher, configStore } = await fixture();
    const first = await app.request("/model-logos/deepseek.svg");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/svg+xml");
    expect(await first.text()).toContain("currentColor");
    expect((await app.request("/model-logos/deepseek.svg")).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await app.request("/model-logos/no-such-provider.svg")).status).toBe(400);
    configStore.stop();
  });
});
