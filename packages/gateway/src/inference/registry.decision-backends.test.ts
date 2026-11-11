// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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
let fetchSpy: MockInstance<typeof fetch>;

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
  // Loading a backend with an OpenAI-compatible URL probes its /models.
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "chat-1" }] })));
});

afterEach(() => {
  fetchSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function load(inference: Record<string, unknown>): void {
  registry.loadConfig({ inference } as unknown as OmnesisConfig);
}

/** A backend that serves only decision models. */
const decisionOnly = (decision: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "http",
  ...extra,
  decision,
});

const OLLAYA = decisionOnly({ url: "http://127.0.0.1:11435/v1/systemone" }, { preset: "ollaya" });
const OPENROUTER_DECISION = { url: "https://openrouter.ai/api/v1/systemone" };
const FIREWORKS = {
  type: "http",
  preset: "fireworks",
  url: "https://api.fireworks.ai/inference",
  apiKey: "fw-key",
  decision: { url: "https://api.fireworks.ai/inference/v1/systemone" },
};

describe("InferenceRegistry — decision role on a backend's decision API", () => {
  it("serves a local decision API on the stable path, with no key or consent", () => {
    load({ backends: { ollaya: OLLAYA }, assignments: { decision: "ollaya/kev" } });
    expect(registry.resolve("decision")).toEqual({
      role: "decision",
      kind: "decision",
      backendKey: "ollaya",
      preset: "ollaya",
      model: "kev",
      url: "http://127.0.0.1:11435/v1/systemone",
      protocol: "systemone",
      onHost: true,
      allowRemoteInference: false,
      hasApiKey: false,
      calibrated: false,
      available: true,
    });
  });

  it("uses the decision API of a backend that also serves chat, with the backend's one key", () => {
    load({ allowRemoteInference: true, backends: { fireworks: FIREWORKS } });
    expect(
      registry.resolveValue("decision", "fireworks/accounts/fireworks/models/rune"),
    ).toMatchObject({
      kind: "decision",
      backendKey: "fireworks",
      preset: "fireworks",
      url: "https://api.fireworks.ai/inference/v1/systemone",
      hasApiKey: true,
      available: true,
    });
    expect(registry.getDecisionEndpoint("fireworks")).toMatchObject({
      url: "https://api.fireworks.ai/inference/v1/systemone",
      preset: "fireworks",
      apiKey: "fw-key",
    });
    // The chat side resolves as before.
    expect(registry.resolveValue("agent", "fireworks/some-chat-model")).toMatchObject({
      kind: "http",
      backendKey: "fireworks",
      url: "https://api.fireworks.ai/inference",
    });
  });

  it("keeps a backend without a decision API on the experimental chat-model path", () => {
    load({ backends: { vllm: { type: "http", url: "http://127.0.0.1:8000" } } });
    const stable = registry.resolveValue("decision", "vllm/qwen3-4b");
    expect(stable).toMatchObject({ kind: "unresolved" });
    expect((stable as { reason: string }).reason).toContain("only in experimental mode");
    expect((stable as { reason: string }).reason).toContain("<backend>/<model>");
    vi.mocked(experimentalEnabled).mockReturnValue(true);
    expect(registry.resolveValue("decision", "vllm/qwen3-4b")).toMatchObject({
      kind: "http",
      backendKey: "vllm",
    });
    expect(registry.getDecisionEndpoint("vllm")).toBeUndefined();
  });

  it("keeps a model id with colons and slashes whole", () => {
    load({ backends: { ollama: decisionOnly({ url: "http://localhost:11434/v1/systemone" }) } });
    expect(registry.resolveValue("decision", "ollama/d3:4b")).toMatchObject({
      model: "d3:4b",
      available: true,
    });
    load({
      backends: { or: decisionOnly(OPENROUTER_DECISION, { preset: "openrouter", apiKey: "k" }) },
      allowRemoteInference: true,
    });
    expect(
      registry.resolveValue("decision", "or/perplexity/pplx-decider-flash-v1.2"),
    ).toMatchObject({ model: "perplexity/pplx-decider-flash-v1.2", preset: "openrouter" });
  });

  it("needs remote-inference consent for a decision API off this host", () => {
    const backends = {
      openrouter: decisionOnly(OPENROUTER_DECISION, { preset: "openrouter", apiKey: "sk-test" }),
    };
    load({ backends, assignments: { decision: "openrouter/liquid/d1.1" } });
    expect(registry.resolve("decision")).toMatchObject({
      available: false,
      reason: CLOUD_EGRESS_DISABLED_REASON,
    });
    load({
      allowRemoteInference: true,
      backends,
      assignments: { decision: "openrouter/liquid/d1.1" },
    });
    expect(registry.resolve("decision")).toMatchObject({ available: true, hasApiKey: true });
  });

  it("names the backend whose key is missing for a provider that needs one", () => {
    load({
      allowRemoteInference: true,
      backends: { openrouter: decisionOnly(OPENROUTER_DECISION, { preset: "openrouter" }) },
      assignments: { decision: "openrouter/liquid/d1.1" },
    });
    expect(registry.resolve("decision")).toMatchObject({
      available: false,
      reason:
        'OpenRouter needs an API key. Add it to the "openrouter" backend in Settings → Models.',
    });
  });

  it("lets a hand-added server decide whether it needs a key", () => {
    const url = "http://192.0.2.5:8000/v1/systemone";
    load({ allowRemoteInference: true, backends: { lab: decisionOnly({ url }) } });
    expect(registry.resolveValue("decision", "lab/drex-9b")).toMatchObject({ available: true });
    load({
      allowRemoteInference: true,
      backends: { lab: decisionOnly({ url, keyRequired: true }) },
    });
    expect(registry.resolveValue("decision", "lab/drex-9b")).toMatchObject({
      available: false,
      reason: expect.stringContaining("lab needs an API key"),
    });
  });

  it("asks for a model id when the assignment has none", () => {
    load({ backends: { ollaya: OLLAYA } });
    expect(registry.resolveValue("decision", "ollaya/")).toMatchObject({
      available: false,
      reason: 'Decision assignment must include a model id, e.g. "ollaya/kev"',
    });
  });

  it("reads the backend's one key from the secret store for both APIs, and reports one it cannot read", () => {
    const ref = writeConfigSecretSync("inference.backend.test.apiKey.x", "sk-secret", {
      configDir: dir,
    });
    const { apiKey: _inline, ...fireworks } = FIREWORKS;
    load({
      allowRemoteInference: true,
      backends: { fireworks: { ...fireworks, apiKeySecret: ref } },
    });
    expect(registry.getDecisionEndpoint("fireworks")?.apiKey).toBe("sk-secret");
    expect(registry.getBackendApiKey("fireworks")).toBe("sk-secret");
    expect(registry.resolveValue("decision", "fireworks/rune")).toMatchObject({
      hasApiKey: true,
      available: true,
    });

    load({
      allowRemoteInference: true,
      backends: {
        fireworks: { ...fireworks, apiKeySecret: "config-secret:inference.missing.apiKey" },
      },
    });
    expect(registry.resolveValue("decision", "fireworks/rune")).toMatchObject({
      available: false,
      reason: 'HTTP backend "fireworks" API key secret is missing or unreadable',
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
    load({
      backends: {
        ollaya: { ...OLLAYA, decision: { ...OLLAYA.decision, calibration: { kev: calibration } } },
      },
    });
    expect(registry.resolveValue("decision", "ollaya/kev")).toMatchObject({ calibrated: true });
    expect(registry.resolveValue("decision", "ollaya/laya")).toMatchObject({ calibrated: false });
  });

  it("brands a backend by the preset whose decision URL it uses when it names none", () => {
    load({ backends: { mine: decisionOnly({ url: "http://127.0.0.1:11434/v1/systemone" }) } });
    expect(registry.resolveValue("decision", "mine/d3:4b")).toMatchObject({ preset: "ollama" });
  });

  it("makes an id that is not a Workers AI path unavailable instead of failing later", () => {
    load({
      allowRemoteInference: true,
      backends: {
        cf: decisionOnly(
          {
            url: "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
            protocol: "workers-ai",
          },
          { preset: "cloudflare", apiKey: "cf" },
        ),
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

describe("InferenceRegistry — a backend that serves only decision models", () => {
  it("leaves every other role unavailable, naming why", () => {
    load({ backends: { ollaya: OLLAYA } });
    for (const role of ["agent", "embedder", "transcriber", "watch-judge"] as const) {
      expect(registry.resolveValue(role, "ollaya/kev")).toEqual({
        role,
        kind: "unresolved",
        reason: 'Backend "ollaya" serves only decision models',
      });
    }
  });

  it("is never probed, and the chat probe and verify say why", async () => {
    load({ backends: { ollaya: OLLAYA } });
    await registry.probeBackends();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await registry.probeBackend("ollaya")).toMatchObject({
      status: "unreachable",
      reason: 'Backend "ollaya" serves only decision models; it has no OpenAI-compatible API',
    });
    expect(await registry.verifyModel("ollaya", "kev", "agent")).toMatchObject({
      supported: false,
      detail: 'Backend "ollaya" serves only decision models; it has no OpenAI-compatible API',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await registry.probeBackend("gone")).toMatchObject({
      reason: 'unknown backend "gone"',
    });
  });

  it("probes a backend that also serves chat on its OpenAI-compatible URL only", async () => {
    load({ allowRemoteInference: true, backends: { fireworks: FIREWORKS } });
    await registry.probeBackends();
    const urls = new Set(fetchSpy.mock.calls.map(([url]) => String(url)));
    expect([...urls]).toEqual(["https://api.fireworks.ai/inference/v1/models"]);
  });
});

describe("InferenceRegistry — overview", () => {
  it("lists each backend once, with what it serves and no key", () => {
    load({
      allowRemoteInference: true,
      backends: {
        ollaya: OLLAYA,
        fireworks: FIREWORKS,
        foundry: decisionOnly(
          {
            url: "https://my-foundry.services.ai.azure.com/providers/microsoft/v1/systemone",
            auth: "api-key",
          },
          { preset: "azure-foundry", apiKey: "sk-foundry" },
        ),
        vllm: { type: "http", url: "http://127.0.0.1:8000" },
      },
    });
    const overview = registry.getOverview();
    expect(overview).not.toHaveProperty("decisionBackends");
    expect(overview.backends.ollaya).toEqual({
      type: "http",
      hasApiKey: false,
      preset: "ollaya",
      decision: {
        url: "http://127.0.0.1:11435/v1/systemone",
        protocol: "systemone",
        auth: "bearer",
        onHost: true,
        hasApiKey: false,
        calibrations: {},
      },
    });
    expect(overview.backends.foundry).toEqual({
      type: "http",
      hasApiKey: true,
      preset: "azure-foundry",
      decision: {
        url: "https://my-foundry.services.ai.azure.com/providers/microsoft/v1/systemone",
        protocol: "systemone",
        auth: "api-key",
        onHost: false,
        hasApiKey: true,
        calibrations: {},
      },
    });
    expect(overview.backends.fireworks).toMatchObject({
      type: "http",
      url: "https://api.fireworks.ai/inference",
      status: "probing",
      hasApiKey: true,
      preset: "fireworks",
      decision: {
        url: "https://api.fireworks.ai/inference/v1/systemone",
        hasApiKey: true,
      },
    });
    expect(overview.backends.vllm).toMatchObject({ url: "http://127.0.0.1:8000" });
    expect(overview.backends.vllm).not.toHaveProperty("decision");
    expect(overview.backends.vllm).not.toHaveProperty("preset");
    expect(JSON.stringify(overview)).not.toContain("sk-foundry");
    expect(JSON.stringify(overview)).not.toContain("fw-key");
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

  it("tells a stable operator only what stable mode accepts for a cloud chat runtime", () => {
    registry.loadConfig({ inference: {} } as OmnesisConfig);
    const stable = registry.resolveValue("decision", "anthropic/claude-sonnet-5-5");
    expect((stable as { reason: string }).reason).not.toContain("GGUF");
    expect((stable as { reason: string }).reason).toContain("<backend>/<model>");
    vi.mocked(experimentalEnabled).mockReturnValue(true);
    const experimental = registry.resolveValue("decision", "anthropic/claude-sonnet-5-5");
    expect((experimental as { reason: string }).reason).toContain("local GGUF chat model");
  });
});
