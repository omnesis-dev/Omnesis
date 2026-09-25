// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { PROVIDER_PRESETS, getPreset } from "./provider-presets.js";
import { PROVIDER_BRANDS } from "./provider-brands.js";

describe("PROVIDER_PRESETS", () => {
  it("contains at least one preset", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
  });

  it("every preset has a unique id", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset has a name, defaultUrl, and capabilities", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.name).toBeTruthy();
      expect(p.defaultUrl).toMatch(/^https?:\/\//);
      expect(p.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("every defaultUrl ends without a trailing slash", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.defaultUrl.endsWith("/")).toBe(false);
    }
  });

  it("no defaultUrl carries a baked-in version path (those go in apiPathPrefix)", () => {
    // The request builders append the prefix; a version path in defaultUrl would
    // double up (the Gemini "…/v1beta/openai/v1/…" regression).
    for (const p of PROVIDER_PRESETS) {
      expect(p.defaultUrl, p.id).not.toMatch(/\/v1(beta)?\b/);
    }
  });

  it("every apiPathPrefix, when set, starts with a slash", () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.apiPathPrefix !== undefined) expect(p.apiPathPrefix, p.id).toMatch(/^\//);
    }
  });

  it("Google (Gemini) uses a bare host plus the /v1beta/openai prefix", () => {
    const google = getPreset("google");
    expect(google?.defaultUrl).toBe("https://generativelanguage.googleapis.com");
    expect(google?.apiPathPrefix).toBe("/v1beta/openai");
  });

  it("NVIDIA uses the bare integrate API host", () => {
    const nvidia = getPreset("nvidia");
    expect(nvidia?.name).toBe("NVIDIA");
    expect(nvidia?.defaultUrl).toBe("https://integrate.api.nvidia.com");
    expect(nvidia?.apiPathPrefix).toBeUndefined();
  });

  it("presets carry no model ids — suggestions come only from live probes", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p, p.id).not.toHaveProperty("knownModels");
    }
  });

  it("Cerebras uses its OpenAI-compatible host", () => {
    const cerebras = getPreset("cerebras");
    expect(cerebras?.name).toBe("Cerebras");
    expect(cerebras?.defaultUrl).toBe("https://api.cerebras.ai");
    expect(cerebras?.apiPathPrefix).toBeUndefined();
    expect(cerebras?.capabilities).toEqual(["agent"]);
  });

  it("xAI (Grok) uses the bare api.x.ai host on the default /v1 surface", () => {
    const xai = getPreset("xai");
    expect(xai?.name).toBe("xAI (Grok)");
    expect(xai?.defaultUrl).toBe("https://api.x.ai");
    expect(xai?.apiPathPrefix).toBeUndefined();
    expect(xai?.capabilities).not.toContain("embed");
  });

  it("Meta (Muse Spark) uses the Model API host", () => {
    const meta = getPreset("meta");
    expect(meta?.name).toBe("Meta (Muse Spark)");
    expect(meta?.defaultUrl).toBe("https://api.meta.ai");
    expect(meta?.apiPathPrefix).toBeUndefined();
    expect(meta?.capabilities).not.toContain("embed");
  });

  it("Moonshot AI (Kimi) uses the api.moonshot.ai host", () => {
    const moonshot = getPreset("moonshot");
    expect(moonshot?.name).toBe("Moonshot AI (Kimi)");
    expect(moonshot?.defaultUrl).toBe("https://api.moonshot.ai");
    expect(moonshot?.apiPathPrefix).toBeUndefined();
    expect(moonshot?.capabilities).not.toContain("embed");
  });

  it("OpenRouter keeps the /api path segment in the base URL", () => {
    // The OpenAI-compatible surface is `https://openrouter.ai/api/v1/…`: the
    // `/api` path segment belongs in defaultUrl and the default `/v1` prefix
    // completes it — no explicit apiPathPrefix.
    const openrouter = getPreset("openrouter");
    expect(openrouter?.name).toBe("OpenRouter");
    expect(openrouter?.defaultUrl).toBe("https://openrouter.ai/api");
    expect(openrouter?.apiPathPrefix).toBeUndefined();
    expect(openrouter?.capabilities).not.toContain("embed");
  });

  it("every preset id has a matching brand so its glyph resolves", () => {
    // A backend added from a preset keeps the preset id as its key, and
    // `httpProviderId` resolves the brand by that key. A preset without a
    // `PROVIDER_BRANDS` entry would silently fall back to the generic HTTP
    // glyph, so this invariant is what makes each provider's logo show up.
    for (const p of PROVIDER_PRESETS) {
      expect(PROVIDER_BRANDS[p.id], `brand for preset ${p.id}`).toBeDefined();
    }
  });
});

describe("getPreset", () => {
  it("returns a known preset by id", () => {
    const preset = getPreset("openai");
    expect(preset).toBeDefined();
    expect(preset!.name).toBe("OpenAI");
    expect(preset!.defaultUrl).toBe("https://api.openai.com");
  });

  it("returns undefined for an unknown id", () => {
    expect(getPreset("nonexistent-provider")).toBeUndefined();
  });
});
