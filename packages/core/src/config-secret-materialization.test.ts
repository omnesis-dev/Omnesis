// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMergePatch, type OmnesisConfig } from "@omnesis/config";
import {
  cleanupConfigSecretMaterialization,
  materializeConfigSecrets,
} from "./config-secret-materialization.js";
import { readConfigSecretRefSync } from "./config-secrets.js";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-materialize-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

type Inference = { backends: Record<string, Record<string, unknown>> };

const FIREWORKS_DECISION = {
  url: "https://api.fireworks.ai/inference/v1/systemone",
  protocol: "systemone",
  auth: "bearer",
};

/** Materialize a patch, then merge it into `current` as the config route does. */
function commit(current: unknown, patch: unknown) {
  const result = materializeConfigSecrets(patch, current as OmnesisConfig, configDir, "patch");
  return { result, next: applyMergePatch(current, result.body) as OmnesisConfig };
}

describe("materializeConfigSecrets", () => {
  it("stores one key for a backend that serves chat and decision models", () => {
    const { result } = commit(
      {},
      {
        inference: {
          backends: {
            fireworks: {
              type: "http",
              preset: "fireworks",
              url: "https://api.fireworks.ai/inference",
              apiKey: "fw-1",
              decision: FIREWORKS_DECISION,
            },
          },
        },
      },
    );
    const fireworks = (result.body as { inference: Inference }).inference.backends.fireworks!;
    expect(fireworks.apiKey).toBeNull();
    expect(fireworks.apiKeySecret).toMatch(/^config-secret:inference\.backend\./);
    expect(readConfigSecretRefSync(fireworks.apiKeySecret as string, { configDir })).toBe("fw-1");
    expect(fireworks.decision).toEqual(FIREWORKS_DECISION);
    expect(result.newRefs).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain("fw-1");
  });

  it("stores the key of a backend that serves only decision models", () => {
    const { result } = commit(
      {},
      {
        inference: {
          backends: {
            fastino: {
              type: "http",
              preset: "fastino",
              apiKey: "fa-1",
              decision: { url: "https://api.fastino.ai/v1/systemone", auth: "x-api-key" },
            },
          },
        },
      },
    );
    const fastino = (result.body as { inference: Inference }).inference.backends.fastino!;
    expect(readConfigSecretRefSync(fastino.apiKeySecret as string, { configDir })).toBe("fa-1");
  });

  it("keeps the stored key when a write adds decisions to an existing backend", () => {
    const first = commit(
      {},
      {
        inference: {
          backends: {
            fireworks: { type: "http", url: "https://api.fireworks.ai/inference", apiKey: "fw-1" },
          },
        },
      },
    );
    const second = commit(first.next, {
      inference: { backends: { fireworks: { decision: FIREWORKS_DECISION } } },
    });
    expect(second.result.newRefs).toEqual([]);
    const fireworks = second.next.inference!.backends!.fireworks!;
    expect(fireworks.decision).toEqual(FIREWORKS_DECISION);
    expect(readConfigSecretRefSync(fireworks.apiKeySecret!, { configDir })).toBe("fw-1");
    cleanupConfigSecretMaterialization(second.result, true, configDir, second.next);
    expect(readConfigSecretRefSync(fireworks.apiKeySecret!, { configDir })).toBe("fw-1");
  });

  it("replaces a rotated key for both endpoints and clears the old one", () => {
    const first = commit(
      {},
      {
        inference: {
          backends: {
            fireworks: {
              type: "http",
              url: "https://api.fireworks.ai/inference",
              apiKey: "fw-1",
              decision: FIREWORKS_DECISION,
            },
          },
        },
      },
    );
    const oldRef = first.next.inference!.backends!.fireworks!.apiKeySecret!;
    const second = commit(first.next, {
      inference: { backends: { fireworks: { apiKey: "fw-2" } } },
    });
    const fireworks = second.next.inference!.backends!.fireworks!;
    expect(fireworks.apiKeySecret).not.toBe(oldRef);
    expect(fireworks.decision).toEqual(FIREWORKS_DECISION);
    expect(readConfigSecretRefSync(fireworks.apiKeySecret!, { configDir })).toBe("fw-2");
    cleanupConfigSecretMaterialization(second.result, true, configDir, second.next);
    expect(readConfigSecretRefSync(oldRef, { configDir })).toBeNull();
  });

  it("leaves a body with no inline key untouched", () => {
    const body = {
      inference: {
        backends: { box: { type: "http", decision: { url: "http://127.0.0.1:1/v1/systemone" } } },
      },
    };
    expect(materializeConfigSecrets(body, {}, configDir, "patch")).toEqual({
      body,
      newRefs: [],
      previousRefs: [],
    });
  });

  it("clears a removed backend's secret once the committed config no longer names it", () => {
    const first = commit(
      {},
      {
        inference: {
          backends: {
            box: { type: "http", apiKey: "k1", decision: { url: "http://127.0.0.1:1/v1/x" } },
          },
        },
      },
    );
    const ref = first.next.inference!.backends!.box!.apiKeySecret!;
    const second = commit(first.next, { inference: { backends: { box: null } } });
    expect(second.result.previousRefs).toEqual([ref]);
    cleanupConfigSecretMaterialization(second.result, true, configDir, second.next);
    expect(readConfigSecretRefSync(ref, { configDir })).toBeNull();
  });
});
