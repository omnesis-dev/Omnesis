// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  DECISION_PROVIDER_PRESETS,
  decisionUrlPlaceholders,
  fillDecisionPresetUrl,
  findDecisionPreset,
  getDecisionPreset,
} from "./decision-presets.js";
import { PROVIDER_BRANDS } from "./provider-brands.js";

describe("DECISION_PROVIDER_PRESETS", () => {
  it("has unique ids that are valid decision backend names", () => {
    const ids = DECISION_PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("gives every preset a brand, an https docs link and at least one model", () => {
    for (const preset of DECISION_PROVIDER_PRESETS) {
      expect(PROVIDER_BRANDS[preset.id], preset.id).toBeDefined();
      expect(preset.docsUrl, preset.id).toMatch(/^https:\/\//);
      if (preset.keyUrl) expect(preset.keyUrl, preset.id).toMatch(/^https:\/\//);
      expect(preset.suggestedModels.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("keeps local servers on this host, keyless, and cloud providers on https with a key", () => {
    for (const preset of DECISION_PROVIDER_PRESETS) {
      if (preset.kind === "local") {
        expect(preset.url, preset.id).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
        expect(preset.keyRequired, preset.id).toBe(false);
      } else {
        expect(preset.url, preset.id).toMatch(/^https:\/\//);
        expect(preset.keyRequired, preset.id).toBe(true);
      }
    }
  });

  it("declares a field for every URL placeholder, and none it does not use", () => {
    for (const preset of DECISION_PROVIDER_PRESETS) {
      const placeholders = decisionUrlPlaceholders(preset.url).sort();
      const params = (preset.urlParams ?? []).map((p) => p.key).sort();
      expect(placeholders, preset.id).toEqual(params);
    }
  });

  it("covers the providers the setup forms promise", () => {
    expect(DECISION_PROVIDER_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        "ollaya",
        "ollama",
        "typesafe",
        "openrouter",
        "ollama-cloud",
        "perplexity",
        "fireworks",
        "baseten",
        "deepinfra",
        "vercel",
        "cloudflare",
        "openai",
        "azure-foundry",
        "fastino",
        "aimlapi",
      ]),
    );
    expect(getDecisionPreset("typesafe")?.builtIn).toBe("typesafe");
    expect(getDecisionPreset("openai")?.protocol).toBe("openai-decisions");
    expect(getDecisionPreset("cloudflare")?.protocol).toBe("workers-ai");
    expect(getDecisionPreset("fastino")).toMatchObject({
      auth: "x-api-key",
      scoreField: "expected_level",
    });
    expect(getDecisionPreset("azure-foundry")?.auth).toBe("api-key");
  });
});

describe("fillDecisionPresetUrl", () => {
  it("fills and encodes each placeholder", () => {
    expect(fillDecisionPresetUrl(getDecisionPreset("cloudflare")!, { account: " abc123 " })).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run",
    );
    expect(fillDecisionPresetUrl(getDecisionPreset("azure-foundry")!, { resource: "a/b" })).toBe(
      "https://a%2Fb.services.ai.azure.com/providers/microsoft/v1/systemone",
    );
  });

  it("names the missing value", () => {
    expect(() => fillDecisionPresetUrl(getDecisionPreset("cloudflare")!, {})).toThrow(
      "Cloudflare Workers AI needs your account id",
    );
  });

  it("returns a preset without placeholders unchanged", () => {
    expect(fillDecisionPresetUrl(getDecisionPreset("ollaya")!, {})).toBe(
      "http://127.0.0.1:11435/v1/systemone",
    );
  });
});

describe("findDecisionPreset", () => {
  it("prefers the recorded id, then an exact URL match", () => {
    expect(findDecisionPreset("ollama", "http://anything/v1/systemone")?.id).toBe("ollama");
    expect(findDecisionPreset(undefined, "https://openrouter.ai/api/v1/systemone/")?.id).toBe(
      "openrouter",
    );
    expect(findDecisionPreset("gone", "http://192.0.2.9:9000/v1/systemone")).toBeUndefined();
  });

  it("never matches a preset whose URL has placeholders by URL alone", () => {
    expect(
      findDecisionPreset(
        undefined,
        "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
      ),
    ).toBeUndefined();
  });
});
