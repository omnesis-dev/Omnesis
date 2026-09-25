// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import {
  CATALOG,
  type CapabilityRole,
  type CapabilityVerdict,
  type CatalogEntry,
  type CodexBackendStatus,
  type CodexLoginFlow,
  type CodexRuntimeUpdateSnapshot,
  type Manifest,
} from "@omnesis/core";

import { ConfigStore } from "../config-store.js";
import { HttpError, errorResponse } from "../http/errors.js";
import { strictRoute } from "../http/scope.js";
import { InferenceRegistry } from "../inference/registry.js";
import { getSystemInfo } from "../system-info.js";
import { ModelManager } from "./manager.js";
import { ModelHistoryStore } from "./model-history.js";
import { computeRecentModels } from "./recent-models.js";
import { CodexRuntimeUpdateConflictError } from "./codex-runtime-updater.js";
import { CodexRuntimeLifecycleConflictError } from "./codex-runtime-lifecycle.js";
import { registerModelRoutes } from "./routes.js";
import {
  CodexAgentSetupConflictError,
  setupCodexAgent,
  type CodexAgentSetupResult,
} from "./codex-agent-setup.js";
import type { AppEnv } from "../http/routes/types.js";

const DYNAMIC_ANTHROPIC_ENTRY: CatalogEntry = {
  kind: "anthropic-api",
  id: "anthropic/claude-sonnet-5",
  apiModelId: "claude-sonnet-5",
  name: "Claude Sonnet 5 (Anthropic API)",
  roles: ["agent"],
  author: "Anthropic",
  license: "Anthropic Commercial Terms",
  description: "Dynamic test model.",
  adaptiveThinking: true,
};

describe("POST /admin/models/activate", () => {
  let dir: string;
  let configStore: ConfigStore;
  let app: Hono<AppEnv>;
  let refreshAnthropicStatus: ReturnType<typeof vi.fn>;
  let refreshCodexStatus: ReturnType<typeof vi.fn<() => Promise<CodexBackendStatus>>>;
  let setupCodexAgentHook: (model: string) => Promise<CodexAgentSetupResult>;
  let getCodexRuntimeUpdate: ReturnType<typeof vi.fn>;
  let startCodexRuntimeUpdate: ReturnType<typeof vi.fn>;
  let cancelCodexRuntimeUpdate: ReturnType<typeof vi.fn>;
  let startCodexLogin: ReturnType<typeof vi.fn<() => Promise<CodexLoginFlow>>>;
  let logoutCodex: ReturnType<
    typeof vi.fn<() => Promise<{ ok: true; status: CodexBackendStatus }>>
  >;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-model-routes-"));
    configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
    await configStore.load();
    const initial = await configStore.put({
      inference: {
        allowRemoteInference: true,
        assignments: { agent: "anthropic/claude-haiku-4-5-20251001" },
      },
    });
    if (!initial.ok) throw new Error("test config should be valid");

    const manifest: Manifest = { version: 1, models: [] };
    const registry = new InferenceRegistry({
      modelsDir: dir,
      configDir: dir,
      manifest: () => manifest,
      hasAnthropicApiKey: () => true,
    });
    const overview = () => {
      registry.loadConfig(configStore.get());
      return registry.getOverview();
    };

    app = new Hono<AppEnv>();
    refreshAnthropicStatus = vi.fn(() =>
      Promise.resolve({
        type: "anthropic" as const,
        status: "ok" as const,
        hasApiKey: true,
        models: [DYNAMIC_ANTHROPIC_ENTRY.apiModelId],
      }),
    );
    refreshCodexStatus = vi.fn(async () => ({
      type: "codex",
      configured: true,
      status: "ok",
      loggedIn: true,
      models: ["gpt-5.6-luna"],
    }));
    setupCodexAgentHook = (model) => setupCodexAgent(configStore, refreshCodexStatus, model);
    const updateSnapshot: CodexRuntimeUpdateSnapshot = {
      plan: {
        state: "update-available",
        action: "update",
        currentVersion: "0.150.0",
        targetVersion: "0.151.0",
        canUpdate: true,
        preservesLogin: true,
        preservesAssignments: true,
        requiresGatewayRestart: false,
      },
      operation: null,
    };
    getCodexRuntimeUpdate = vi.fn(async () => updateSnapshot);
    startCodexRuntimeUpdate = vi.fn(async () => updateSnapshot);
    cancelCodexRuntimeUpdate = vi.fn(async () => updateSnapshot);
    startCodexLogin = vi.fn(async () => ({
      id: "synthetic-login",
      status: "pending" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    logoutCodex = vi.fn(async () => ({
      ok: true as const,
      status: {
        type: "codex" as const,
        configured: false,
        status: "unreachable" as const,
        loggedIn: false,
        models: [],
      },
    }));
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

    registerModelRoutes(strictRoute(app), {
      modelManager: new ModelManager({
        modelsDir: dir,
        catalog: () => [...CATALOG, DYNAMIC_ANTHROPIC_ENTRY],
      }),
      configStore,
      getSystemInfo: () => getSystemInfo(dir),
      getInferenceOverview: overview,
      probeBackend: vi.fn(),
      verifyModel: vi.fn(
        (_key: string, model: string, role: CapabilityRole): Promise<CapabilityVerdict> =>
          Promise.resolve({
            role,
            model,
            supported: true,
            detail: "test",
          }),
      ),
      refreshAnthropicStatus,
      refreshCodexStatus,
      setupCodexAgent: (model) => setupCodexAgentHook(model),
      getCodexRuntimeUpdate,
      startCodexRuntimeUpdate,
      cancelCodexRuntimeUpdate,
      startCodexLogin,
      logoutCodex,
    });
  });

  test("atomically opts into remote inference and assigns an available Codex model", async () => {
    const cleared = await configStore.patch({
      inference: {
        allowRemoteInference: false,
        assignments: { agent: null, "privacy-reviewer": "codex/gpt-5.4" },
      },
    });
    if (!cleared.ok) throw new Error("test config should be valid");

    const res = await app.request("/admin/inference/codex/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      assignment: "codex/gpt-5.6-luna",
      allowRemoteInference: true,
    });
    expect(configStore.get().inference).toMatchObject({
      allowRemoteInference: true,
      assignments: {
        agent: "codex/gpt-5.6-luna",
        "privacy-reviewer": "codex/gpt-5.4",
      },
    });
  });

  test("preserves an assignment made while Codex status is refreshing", async () => {
    const cleared = await configStore.patch({ inference: { assignments: { agent: null } } });
    if (!cleared.ok) throw new Error("test config should be valid");
    let releaseRefresh!: () => void;
    refreshCodexStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRefresh = () =>
            resolve({
              type: "codex",
              configured: true,
              status: "ok",
              loggedIn: true,
              models: ["gpt-5.6-luna"],
            });
        }),
    );

    const request = app.request("/admin/inference/codex/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    });
    await vi.waitFor(() => expect(refreshCodexStatus).toHaveBeenCalledOnce());
    await configStore.patch({ inference: { assignments: { agent: "local/fictional-model" } } });
    releaseRefresh();

    const res = await request;
    expect(res.status).toBe(409);
    expect(configStore.get().inference?.assignments?.agent).toBe("local/fictional-model");
  });

  test("rejects unavailable Codex models without changing config", async () => {
    const before = configStore.get();
    const res = await app.request("/admin/inference/codex/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-fictional-unavailable" }),
    });

    expect(res.status).toBe(400);
    expect(configStore.get()).toEqual(before);
  });

  test("reports lifecycle contention as a conflict", async () => {
    setupCodexAgentHook = async () => {
      throw new CodexAgentSetupConflictError(
        ["Another", "Codex lifecycle operation is in progress."].join(" "),
      );
    };
    const res = await app.request("/admin/inference/codex/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    });

    expect(res.status).toBe(409);
  });

  afterEach(() => {
    configStore.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("targets privacy-reviewer without overwriting the Agent assignment", async () => {
    const res = await app.request("/admin/models/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "anthropic/claude-sonnet-4-6",
        role: "agent",
        capability: "privacy-reviewer",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      role: "agent",
      capability: "privacy-reviewer",
      activeId: "anthropic/claude-sonnet-4-6",
    });
    expect(configStore.get().inference?.assignments).toEqual({
      agent: "anthropic/claude-haiku-4-5-20251001",
      "privacy-reviewer": "anthropic/claude-sonnet-4-6",
    });
  });

  test("targets watch-judge without overwriting the background agent assignment", async () => {
    const seeded = await configStore.patch({
      inference: { assignments: { "background-agent": "codex/gpt-5.6-luna" } },
    });
    if (!seeded.ok) throw new Error("test config should be valid");

    const res = await app.request("/admin/models/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "anthropic/claude-sonnet-4-6",
        role: "agent",
        capability: "watch-judge",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      role: "agent",
      capability: "watch-judge",
      activeId: "anthropic/claude-sonnet-4-6",
    });
    expect(configStore.get().inference?.assignments?.["background-agent"]).toBe(
      "codex/gpt-5.6-luna",
    );
    expect(configStore.get().inference?.assignments?.["watch-judge"]).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  test("keeps the legacy role-only request targeting Agent", async () => {
    const res = await app.request("/admin/models/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "anthropic/claude-sonnet-4-6", role: "agent" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "agent", capability: "agent" });
    expect(configStore.get().inference?.assignments?.agent).toBe("anthropic/claude-sonnet-4-6");
    expect(configStore.get().inference?.assignments?.["privacy-reviewer"]).toBeUndefined();
  });

  test("activates a dynamically discovered Anthropic model", async () => {
    const res = await app.request("/admin/models/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: DYNAMIC_ANTHROPIC_ENTRY.id,
        role: "agent",
      }),
    });

    expect(res.status).toBe(200);
    expect(configStore.get().inference?.assignments?.agent).toBe(DYNAMIC_ANTHROPIC_ENTRY.id);
  });

  test("refreshes the Anthropic model catalog on demand", async () => {
    const res = await app.request("/admin/inference/anthropic/refresh", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      type: "anthropic",
      status: "ok",
      models: [DYNAMIC_ANTHROPIC_ENTRY.apiModelId],
    });
    expect(refreshAnthropicStatus).toHaveBeenCalledOnce();
  });

  test("reads, starts, dry-runs, and cancels Codex runtime updates through service hooks", async () => {
    const read = await app.request("/admin/inference/codex/runtime/update");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ plan: { targetVersion: "0.151.0" } });
    expect(getCodexRuntimeUpdate).toHaveBeenCalledOnce();

    const start = await app.request("/admin/inference/codex/runtime/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(start.status).toBe(200);
    expect(startCodexRuntimeUpdate).toHaveBeenLastCalledWith({ dryRun: false });

    const dryRun = await app.request("/admin/inference/codex/runtime/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(dryRun.status).toBe(200);
    expect(startCodexRuntimeUpdate).toHaveBeenLastCalledWith({ dryRun: true });

    const cancel = await app.request("/admin/inference/codex/runtime/update", {
      method: "DELETE",
    });
    expect(cancel.status).toBe(200);
    expect(cancelCodexRuntimeUpdate).toHaveBeenCalledOnce();
  });

  test("strictly rejects invalid Codex runtime update bodies", async () => {
    for (const body of [
      "not-json",
      "null",
      JSON.stringify({ version: "latest" }),
      JSON.stringify({ dryRun: "yes" }),
    ]) {
      const res = await app.request("/admin/inference/codex/runtime/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(startCodexRuntimeUpdate).not.toHaveBeenCalled();
  });

  test("reports Codex lifecycle conflicts as HTTP 409", async () => {
    startCodexRuntimeUpdate.mockRejectedValueOnce(
      new CodexRuntimeUpdateConflictError("Codex login is pending."),
    );
    const res = await app.request("/admin/inference/codex/runtime/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });

  test.each([
    ["login", "POST"],
    ["logout", "DELETE"],
  ] as const)("reports Codex %s lifecycle contention as HTTP 409", async (operation, method) => {
    const conflict = new CodexRuntimeLifecycleConflictError(
      ["Another", "Codex lifecycle operation is in progress."].join(" "),
    );
    if (operation === "login") startCodexLogin.mockRejectedValueOnce(conflict);
    else logoutCodex.mockRejectedValueOnce(conflict);

    const path = operation === "login" ? "/admin/inference/codex/login" : "/admin/inference/codex";
    const res = await app.request(path, { method });
    expect(res.status).toBe(409);
  });

  test("does not disguise internal Codex update failures as lifecycle conflicts", async () => {
    startCodexRuntimeUpdate.mockRejectedValueOnce(new Error("Synthetic filesystem failure."));
    await expect(
      app.request("/admin/inference/codex/runtime/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow("Synthetic filesystem failure");
  });

  test("rejects a capability whose model class does not match the catalog role", async () => {
    const res = await app.request("/admin/models/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "anthropic/claude-sonnet-4-6",
        role: "agent",
        capability: "embedder",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/embedder.*role=agent/),
    });
    expect(configStore.get().inference?.assignments).toEqual({
      agent: "anthropic/claude-haiku-4-5-20251001",
    });
  });
});

describe("GET /admin/models/recent/:capability", () => {
  let dir: string;
  let configStore: ConfigStore;
  let app: Hono<AppEnv>;
  let history: ModelHistoryStore;

  const resolveValue = (role: CapabilityRole, value: string | null | undefined) => {
    if (value === "openai/gpt-4o") {
      return {
        role,
        kind: "http",
        backendKey: "openai",
        url: "https://api.openai.com",
        model: "gpt-4o",
        allowRemoteInference: true,
        available: true,
      } as const;
    }
    if (value === "codex/gpt-5.4") {
      return {
        role,
        kind: "codex",
        model: "gpt-5.4",
        allowRemoteInference: true,
        available: true,
      } as const;
    }
    return { role, kind: "disabled" } as const;
  };

  async function buildApp(wireRecent: boolean) {
    dir = mkdtempSync(join(tmpdir(), "omnesis-model-recent-routes-"));
    configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
    await configStore.load();
    const initial = await configStore.put({
      inference: {
        allowRemoteInference: true,
        assignments: { agent: "openai/gpt-4o", "privacy-reviewer": "codex/gpt-5.4" },
      },
    });
    if (!initial.ok) throw new Error("test config should be valid");
    history = new ModelHistoryStore({ filePath: join(dir, "model-history.json") });
    history.load();
    const registry = new InferenceRegistry({
      modelsDir: dir,
      configDir: dir,
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
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

    registerModelRoutes(strictRoute(app), {
      modelManager: new ModelManager({ modelsDir: dir, catalog: () => [...CATALOG] }),
      configStore,
      getSystemInfo: () => getSystemInfo(dir),
      getInferenceOverview: () => {
        registry.loadConfig(configStore.get());
        return registry.getOverview();
      },
      probeBackend: vi.fn(),
      verifyModel: vi.fn(),
      ...(wireRecent
        ? {
            getRecentModels: (capability: CapabilityRole) =>
              computeRecentModels({
                reference: capability,
                current: configStore.get().inference?.assignments ?? {},
                history: history.snapshot(),
                resolveValue,
              }),
          }
        : {}),
    });
  }

  beforeEach(async () => {
    await buildApp(true);
  });

  afterEach(() => {
    configStore.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("excludes the currently assigned model", async () => {
    const res = await app.request("/admin/models/recent/agent");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      capability: "agent",
      entries: [
        {
          assignment: "codex/gpt-5.4",
          providerId: "codex",
          providerLabel: "Codex",
          modelName: "gpt-5.4",
          apply: { type: "assign", value: "codex/gpt-5.4" },
        },
      ],
    });
  });

  test("includes remembered replacements and answers empty for the verifier", async () => {
    // Simulate a switch the onChange hook would have recorded: the config
    // moves on, the history remembers what was replaced.
    const patched = await configStore.patch({
      inference: { assignments: { agent: "codex/gpt-5.4" } },
    });
    if (!patched.ok) throw new Error("test config should be valid");
    history.record("agent", "openai/gpt-4o", "codex/gpt-5.4");

    const agent = await app.request("/admin/models/recent/agent");
    expect(await agent.json()).toMatchObject({
      entries: [{ assignment: "openai/gpt-4o" }],
    });

    const verifier = await app.request("/admin/models/recent/entailment-verifier");
    expect(verifier.status).toBe(200);
    expect(await verifier.json()).toEqual({ capability: "entailment-verifier", entries: [] });
  });

  test("includes recent entries in the models overview", async () => {
    const res = await app.request("/admin/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      recentModels: {
        agent: [{ assignment: "codex/gpt-5.4" }],
        "entailment-verifier": [],
      },
    });
  });

  test("rejects an unknown capability", async () => {
    const res = await app.request("/admin/models/recent/nonsense");
    expect(res.status).toBe(400);
  });

  test("answers empty entries when the history store is not wired", async () => {
    configStore.stop();
    rmSync(dir, { recursive: true, force: true });
    await buildApp(false);
    const res = await app.request("/admin/models/recent/agent");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capability: "agent", entries: [] });
  });
});
