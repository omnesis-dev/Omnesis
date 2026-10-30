// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { ConfigStore } from "../config-store.js";
import { createDatabase } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { ModelManager } from "../models/manager.js";
import { getSystemInfo } from "../system-info.js";
import { createServer } from "../server.js";
import { DecisionService } from "./decision/decision-service.js";
import { InferenceRegistry } from "./registry.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ModelHealth, ModelsOverview } from "@omnesis/core";

/** Exercises the real TypeSafe adapter and authenticated status/models projections. */
describe("model health API", () => {
  it("surfaces repeated decision quota failures and removes them after recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-health-api-"));
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    const registry = new InferenceRegistry({
      modelsDir: dir,
      configDir: dir,
      modelHealthPath: join(dir, "health.json"),
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
      hasTypeSafeApiKey: () => true,
    });
    try {
      const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
      await configStore.load();
      const configuration = {
        inference: {
          allowRemoteInference: true,
          assignments: { decision: "typesafe/example-model" },
          typesafe: { url: "http://127.0.0.1:9/v1/systemone" },
        },
      };
      expect((await configStore.put(configuration)).ok).toBe(true);
      registry.loadConfig(configStore.get());
      let quotaExceeded = true;
      const service = new DecisionService({
        health: registry.health,
        resolveAssignment: () => registry.resolve("decision"),
        readTypeSafeApiKey: () => "test-key",
        fetchFn: async () =>
          quotaExceeded
            ? new Response("quota exhausted: private request body", { status: 402 })
            : Response.json({
                model: "example-model",
                answers: { worth: { type: "score", score: 1 } },
              }),
      });
      const app = createServer(db, dbPath, {
        configStore,
        modelManager: new ModelManager({ modelsDir: dir }),
        getSystemInfo: () => getSystemInfo(dir),
        getInferenceOverview: () => registry.getOverview(),
        probeBackend: (key) => registry.probeBackend(key),
        verifyModel: (key, model, role, opts) => registry.verifyModel(key, model, role, opts),
        getModelHealth: () => registry.health.snapshot(),
      });
      const device = createDevice(db, { name: "Test operator", kind: "cli" });
      const { token } = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]);
      const headers = { Authorization: `Bearer ${token}` };
      const readHealth = async () => {
        const status = await app.request("/status", { headers });
        const models = await app.request("/admin/models", { headers });
        expect(status.status).toBe(200);
        expect(models.status).toBe(200);
        const statusHealth = ((await status.json()) as { modelHealth: ModelHealth }).modelHealth;
        const modelHealth = ((await models.json()) as ModelsOverview).inference.health;
        expect(statusHealth).toEqual(modelHealth);
        expect(JSON.stringify(statusHealth)).not.toContain("private request body");
        return statusHealth;
      };
      const request = {
        state: {},
        questions: {
          worth: {
            type: "score" as const,
            instructions: "Score the example.",
            criteria: ["low", "medium", "high"],
          },
        },
      };
      for (let i = 0; i < 2; i++)
        await expect(service.get()!.decide(request)).rejects.toThrow("quota");
      expect((await readHealth()).warnings).toEqual([]);
      await expect(service.get()!.decide(request)).rejects.toThrow("quota");
      expect((await readHealth()).warnings[0]).toMatchObject({
        role: "decision",
        category: "quota",
        consecutiveFailures: 3,
      });
      // Ordinary config refreshes preserve evidence for the same assignment.
      registry.loadConfig(configStore.get());
      expect((await readHealth()).warnings).toHaveLength(1);
      quotaExceeded = false;
      await service.get()!.decide(request);
      expect((await readHealth()).warnings).toEqual([]);
    } finally {
      await registry.health.flush();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("invalidates external credential rotations and configuration ABA results", async () => {
    let credential = "first-test-key";
    const registry = new InferenceRegistry({
      modelsDir: "/unused",
      configDir: "/unused",
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
      hasTypeSafeApiKey: () => true,
      getExternalCredential: () => credential,
    });
    const configuration = {
      inference: {
        allowRemoteInference: true,
        entailment: { promptStyle: "judge" },
        assignments: { decision: "typesafe/example-model" },
      },
    } satisfies OmnesisConfig;
    registry.loadConfig(configuration);
    const provider = registry.health.observe(
      registry.resolve("decision"),
      {
        async decide() {
          throw new Error("quota exhausted");
        },
      },
      ["decide"],
    );
    const fail = async () => {
      for (let i = 0; i < 3; i++) await expect(provider.decide()).rejects.toThrow();
    };
    await fail();
    expect(registry.modelHealth().warnings).toHaveLength(1);
    credential = "second-test-key";
    expect(registry.modelHealth().warnings).toEqual([]);
    await fail();
    expect(registry.modelHealth().warnings).toEqual([]);
    registry.loadConfig({
      ...configuration,
      inference: { ...configuration.inference, assignments: { decision: null } },
    });
    registry.loadConfig(configuration);
    await fail();
    expect(registry.modelHealth().warnings).toEqual([]);
  });
});
