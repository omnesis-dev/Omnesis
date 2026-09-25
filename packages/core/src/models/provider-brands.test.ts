// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { PROVIDER_BRANDS, getProviderBrand, resolveModelDisplay } from "./provider-brands.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";
import type { ResolvedAssignment } from "./backends.js";

describe("provider brands", () => {
  it("has a brand entry for every cloud provider preset", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(PROVIDER_BRANDS[preset.id], `brand for preset ${preset.id}`).toBeDefined();
    }
  });

  it("getProviderBrand falls back to the 'none' brand for unknown ids", () => {
    expect(getProviderBrand("anthropic").label).toBe("Anthropic");
    expect(getProviderBrand("does-not-exist").id).toBe("none");
  });
});

describe("resolveModelDisplay", () => {
  it("projects an Anthropic assignment to its catalog name + brand", () => {
    const a: ResolvedAssignment = {
      role: "agent",
      kind: "anthropic",
      catalogId: "anthropic/claude-sonnet-4-5",
      catalogEntry: {
        kind: "anthropic-api",
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        roles: ["agent"],
        author: "Anthropic",
        license: "proprietary",
        description: "",
        apiModelId: "claude-sonnet-4-5",
      },
      apiModelId: "claude-sonnet-4-5",
      available: true,
    };
    const d = resolveModelDisplay(a);
    expect(d).toMatchObject({
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelName: "Claude Sonnet 4.5",
      available: true,
      configured: true,
    });
  });

  it("falls back to the raw model id for an HTTP backend that matches a preset key", () => {
    const a: ResolvedAssignment = {
      role: "agent",
      kind: "http",
      backendKey: "openai",
      url: "https://api.openai.com",
      model: "gpt-5.1",
      allowRemoteInference: true,
      available: true,
    };
    const d = resolveModelDisplay(a);
    expect(d.providerId).toBe("openai");
    expect(d.providerLabel).toBe("OpenAI");
    expect(d.modelName).toBe("gpt-5.1");
  });

  it("uses the generic HTTP brand for an unrecognised backend key", () => {
    const a: ResolvedAssignment = {
      role: "agent",
      kind: "http",
      backendKey: "my-vllm-box",
      url: "http://localhost:8000",
      model: "Qwen/Qwen3-8B",
      allowRemoteInference: false,
      available: false,
    };
    const d = resolveModelDisplay(a);
    expect(d.providerId).toBe("http");
    expect(d.modelName).toBe("Qwen/Qwen3-8B");
    expect(d.available).toBe(false);
  });

  it("reports Codex assignments with the Codex brand and raw model id", () => {
    const a: ResolvedAssignment = {
      role: "agent",
      kind: "codex",
      model: "gpt-5.4",
      available: true,
    };
    const d = resolveModelDisplay(a);
    expect(d.providerId).toBe("codex");
    expect(d.providerLabel).toBe("Codex");
    expect(d.modelName).toBe("gpt-5.4");
    expect(d.available).toBe(true);
    expect(d.configured).toBe(true);
  });

  it("marks a disabled assignment as not configured", () => {
    const d = resolveModelDisplay({ role: "agent", kind: "disabled" });
    expect(d.configured).toBe(false);
    expect(d.available).toBe(false);
    expect(d.providerId).toBe("none");
  });

  it("reports a local GGUF model with its catalog name", () => {
    const a: ResolvedAssignment = {
      role: "embedder",
      kind: "local",
      catalogId: "nomic-embed-text-v1.5.Q8_0",
      modelPath: "/models/nomic.gguf",
      available: true,
    };
    const d = resolveModelDisplay(a);
    expect(d.providerId).toBe("local");
    expect(d.providerLabel).toBe("Local");
    expect(d.modelName).toBe("nomic-embed-text-v1.5.Q8_0");
  });
});
