// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupConfigSecretMaterialization,
  materializeConfigSecrets,
} from "./config-secret-materialization.js";
import { readConfigSecretRefSync } from "./config-secrets.js";
import type { OmnesisConfig } from "@omnesis/config";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-materialize-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

type Inference = Record<string, Record<string, Record<string, unknown>>>;

describe("materializeConfigSecrets", () => {
  it("moves an HTTP backend's and a decision backend's inline keys into the secret store", () => {
    const body = {
      inference: {
        backends: { groq: { type: "http", url: "https://api.groq.com/openai", apiKey: "gsk-1" } },
        decisionBackends: {
          openrouter: {
            preset: "openrouter",
            url: "https://openrouter.ai/api/v1/systemone",
            apiKey: "sk-or-1",
          },
          ollaya: { url: "http://127.0.0.1:11435/v1/systemone" },
        },
      },
    };
    const result = materializeConfigSecrets(body, {}, configDir, "patch");
    const inference = (result.body as { inference: Inference }).inference;
    const openrouter = inference.decisionBackends!.openrouter!;
    expect(openrouter.apiKey).toBeNull();
    expect(openrouter.apiKeySecret).toMatch(/^config-secret:inference\.decision-backend\./);
    expect(readConfigSecretRefSync(openrouter.apiKeySecret as string, { configDir })).toBe(
      "sk-or-1",
    );
    expect(inference.backends!.groq!.apiKeySecret).toMatch(/^config-secret:inference\.backend\./);
    expect(inference.decisionBackends!.ollaya).toEqual({
      url: "http://127.0.0.1:11435/v1/systemone",
    });
    expect(result.newRefs).toHaveLength(2);
    expect(JSON.stringify(result.body)).not.toContain("sk-or-1");
  });

  it("drops the inline field outright on a whole-file write", () => {
    const body = {
      inference: {
        decisionBackends: { x: { url: "http://127.0.0.1:1/v1/systemone", apiKey: "k" } },
      },
    };
    const result = materializeConfigSecrets(body, {}, configDir, "put");
    const backend = (result.body as { inference: Inference }).inference.decisionBackends!.x!;
    expect("apiKey" in backend).toBe(false);
  });

  it("leaves a body with no inline key untouched", () => {
    const body = {
      inference: { decisionBackends: { x: { url: "http://127.0.0.1:1/v1/systemone" } } },
    };
    expect(materializeConfigSecrets(body, {}, configDir, "patch")).toEqual({
      body,
      newRefs: [],
      previousRefs: [],
    });
  });

  it("clears a decision backend's secret once the committed config no longer names it", () => {
    const first = materializeConfigSecrets(
      {
        inference: {
          decisionBackends: { x: { url: "http://127.0.0.1:1/v1/systemone", apiKey: "k1" } },
        },
      },
      {},
      configDir,
      "put",
    );
    const ref = (first.body as { inference: Inference }).inference.decisionBackends!.x!
      .apiKeySecret as string;
    const committed = {
      inference: {
        decisionBackends: { x: { url: "http://127.0.0.1:1/v1/systemone", apiKeySecret: ref } },
      },
    } as unknown as OmnesisConfig;

    const second = materializeConfigSecrets(
      { inference: { decisionBackends: { x: null } } },
      committed,
      configDir,
      "patch",
    );
    expect(second.previousRefs).toEqual([ref]);
    cleanupConfigSecretMaterialization(second, true, configDir, {} as OmnesisConfig);
    expect(readConfigSecretRefSync(ref, { configDir })).toBeNull();
  });
});
