// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_EGRESS_DISABLED_REASON, writeConfigSecretSync } from "@omnesis/core";
import { InferenceRegistry } from "./registry.js";
import type { OmnesisConfig } from "@omnesis/config";

vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return { ...actual, experimentalEnabled: vi.fn(() => false) };
});

const { experimentalEnabled } = await import("@omnesis/core");

let dir: string;
let registry: InferenceRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-decision-backends-"));
  registry = new InferenceRegistry({
    modelsDir: join(dir, "models"),
    configDir: dir,
    manifest: () => ({ version: 1, models: [] }),
    hasAnthropicApiKey: () => false,
    hasTypeSafeApiKey: () => false,
  });
  vi.mocked(experimentalEnabled).mockReturnValue(false);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(inference: Record<string, unknown>): void {
  registry.loadConfig({ inference } as unknown as OmnesisConfig);
}

const OLLAYA = { preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone" };
const OPENROUTER = { preset: "openrouter", url: "https://openrouter.ai/api/v1/systemone" };

describe("InferenceRegistry — decision backends", () => {
  it("serves a local decision backend on the stable path, with no key or consent", () => {
    load({ decisionBackends: { ollaya: OLLAYA }, assignments: { decision: "ollaya/kev" } });
    expect(registry.resolve("decision")).toEqual({
      role: "decision",
      kind: "decision",
      backendKey: "ollaya",
      preset: "ollaya",
      model: "kev",
      url: OLLAYA.url,
      protocol: "systemone",
      onHost: true,
      allowRemoteInference: false,
      hasApiKey: false,
      calibrated: false,
      available: true,
    });
  });

  it("keeps a model id with colons and slashes whole", () => {
    load({ decisionBackends: { ollama: { url: "http://localhost:11434/v1/systemone" } } });
    expect(registry.resolveValue("decision", "ollama/d3:4b")).toMatchObject({
      model: "d3:4b",
      available: true,
    });
    load({ decisionBackends: { or: OPENROUTER }, allowRemoteInference: true });
    expect(
      registry.resolveValue("decision", "or/perplexity/pplx-decider-flash-v1.2"),
    ).toMatchObject({ model: "perplexity/pplx-decider-flash-v1.2", preset: "openrouter" });
  });

  it("needs remote-inference consent for a backend off this host", () => {
    load({
      decisionBackends: { openrouter: { ...OPENROUTER, apiKey: "sk-test" } },
      assignments: { decision: "openrouter/liquid/d1.1" },
    });
    expect(registry.resolve("decision")).toMatchObject({
      available: false,
      reason: CLOUD_EGRESS_DISABLED_REASON,
    });
    load({
      allowRemoteInference: true,
      decisionBackends: { openrouter: { ...OPENROUTER, apiKey: "sk-test" } },
      assignments: { decision: "openrouter/liquid/d1.1" },
    });
    expect(registry.resolve("decision")).toMatchObject({ available: true, hasApiKey: true });
  });

  it("names the missing key for a provider that needs one", () => {
    load({
      allowRemoteInference: true,
      decisionBackends: { openrouter: OPENROUTER },
      assignments: { decision: "openrouter/liquid/d1.1" },
    });
    expect(registry.resolve("decision")).toMatchObject({
      available: false,
      reason: expect.stringContaining("OpenRouter needs an API key"),
    });
  });

  it("lets a hand-added server decide whether it needs a key", () => {
    const url = "http://192.0.2.5:8000/v1/systemone";
    load({ allowRemoteInference: true, decisionBackends: { lab: { url } } });
    expect(registry.resolveValue("decision", "lab/drex-9b")).toMatchObject({ available: true });
    load({ allowRemoteInference: true, decisionBackends: { lab: { url, keyRequired: true } } });
    expect(registry.resolveValue("decision", "lab/drex-9b")).toMatchObject({
      available: false,
      reason: expect.stringContaining("lab needs an API key"),
    });
  });

  it("asks for a model id when the assignment has none", () => {
    load({ decisionBackends: { ollaya: OLLAYA } });
    expect(registry.resolveValue("decision", "ollaya/")).toMatchObject({
      available: false,
      reason: 'Decision assignment must include a model id, e.g. "ollaya/kev"',
    });
  });

  it("reads the key from the secret store, and reports one it cannot read", () => {
    const ref = writeConfigSecretSync("inference.decision-backend.test.apiKey.x", "sk-secret", {
      configDir: dir,
    });
    load({
      allowRemoteInference: true,
      decisionBackends: { openrouter: { ...OPENROUTER, apiKeySecret: ref } },
    });
    expect(registry.getDecisionBackend("openrouter")?.apiKey).toBe("sk-secret");
    expect(registry.resolveValue("decision", "openrouter/liquid/d1.1")).toMatchObject({
      hasApiKey: true,
      available: true,
    });

    load({
      allowRemoteInference: true,
      decisionBackends: {
        openrouter: { ...OPENROUTER, apiKeySecret: "config-secret:inference.missing.apiKey" },
      },
    });
    expect(registry.resolveValue("decision", "openrouter/liquid/d1.1")).toMatchObject({
      available: false,
      reason: 'Decision backend "openrouter" API key secret is missing or unreadable',
    });
  });

  it("serves only the Decision model", () => {
    load({ decisionBackends: { ollaya: OLLAYA } });
    expect(registry.resolveValue("agent", "ollaya/kev")).toEqual({
      role: "agent",
      kind: "unresolved",
      reason: '"ollaya" is a decision backend; it serves only the Decision model.',
    });
  });

  it("reports whether the assigned model is calibrated", () => {
    const calibration = {
      points: [
        [0.2, 0.1],
        [0.8, 0.9],
      ] as [number, number][],
      reference: "jev-worth/email-worth-v1/jev-1.13.0",
      fittedAt: "2026-11-10T12:00:00.000Z",
    };
    load({ decisionBackends: { ollaya: { ...OLLAYA, calibration: { kev: calibration } } } });
    expect(registry.resolveValue("decision", "ollaya/kev")).toMatchObject({ calibrated: true });
    expect(registry.resolveValue("decision", "ollaya/laya")).toMatchObject({ calibrated: false });
  });

  it("lists decision backends in the overview without their keys", () => {
    load({
      allowRemoteInference: true,
      decisionBackends: {
        ollaya: OLLAYA,
        foundry: {
          preset: "azure-foundry",
          url: "https://my-foundry.services.ai.azure.com/providers/microsoft/v1/systemone",
          auth: "api-key",
          apiKey: "sk-foundry",
        },
      },
    });
    const overview = registry.getOverview();
    expect(overview.decisionBackends).toEqual({
      ollaya: {
        preset: "ollaya",
        url: OLLAYA.url,
        protocol: "systemone",
        auth: "bearer",
        onHost: true,
        hasApiKey: false,
        calibrations: {},
      },
      foundry: {
        preset: "azure-foundry",
        url: "https://my-foundry.services.ai.azure.com/providers/microsoft/v1/systemone",
        protocol: "systemone",
        auth: "api-key",
        onHost: false,
        hasApiKey: true,
        calibrations: {},
      },
    });
    expect(JSON.stringify(overview)).not.toContain("sk-foundry");
  });

  it("brands a backend by the preset whose URL it uses when it names none", () => {
    load({ decisionBackends: { mine: { url: "http://127.0.0.1:11434/v1/systemone" } } });
    expect(registry.resolveValue("decision", "mine/d3:4b")).toMatchObject({ preset: "ollama" });
  });

  describe("chat models and cloud runtimes", () => {
    it("keeps a chat model on an HTTP backend experimental, naming decision backends", () => {
      load({ backends: { vllm: { type: "http", url: "http://127.0.0.1:8000" } } });
      const resolved = registry.resolveValue("decision", "vllm/qwen3-4b");
      expect(resolved).toMatchObject({ kind: "unresolved" });
      expect((resolved as { reason: string }).reason).toContain("<decision backend>/<model>");
    });

    it("tells a stable operator only what stable mode accepts for a cloud chat runtime", () => {
      const stable = registry.resolveValue("decision", "anthropic/claude-sonnet-5-5");
      expect((stable as { reason: string }).reason).not.toContain("GGUF");
      expect((stable as { reason: string }).reason).toContain("decision backend");
      vi.mocked(experimentalEnabled).mockReturnValue(true);
      const experimental = registry.resolveValue("decision", "anthropic/claude-sonnet-5-5");
      expect((experimental as { reason: string }).reason).toContain("local GGUF chat model");
    });
  });
});

describe("InferenceRegistry — decision assignments naming nothing", () => {
  it("names an unknown backend instead of the chat-model rule", () => {
    registry.loadConfig({ inference: {} } as OmnesisConfig);
    expect(registry.resolveValue("decision", "gone/kev")).toEqual({
      role: "decision",
      kind: "unresolved",
      reason: 'Unknown backend "gone" in assignment "gone/kev"',
    });
  });

  it("still keeps a bare local model file and local/<file> experimental", () => {
    registry.loadConfig({ inference: {} } as OmnesisConfig);
    for (const value of ["qwen3-4b.gguf", "local/qwen3-4b.gguf"]) {
      expect((registry.resolveValue("decision", value) as { reason: string }).reason).toContain(
        "only in experimental mode",
      );
    }
  });
});

describe("InferenceRegistry — Workers AI model ids", () => {
  it("makes an id that is not a Workers AI path unavailable instead of failing later", () => {
    load({
      allowRemoteInference: true,
      decisionBackends: {
        cf: {
          preset: "cloudflare",
          url: "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
          protocol: "workers-ai",
          apiKey: "cf",
        },
      },
    });
    expect(registry.resolveValue("decision", "cf/@cf/cloudflare/clef-flash")).toMatchObject({
      available: true,
    });
    expect(registry.resolveValue("decision", "cf/../../user/tokens")).toMatchObject({
      available: false,
      reason: expect.stringContaining("is not a Workers AI model id"),
    });
  });
});
