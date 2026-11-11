// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  fillDecisionPresetUrl,
  findPreset,
  getPreset,
  getPresetByUrl,
} from "./provider-presets.js";
import { decisionUrlPlaceholders } from "./decision-api.js";
import { PROVIDER_BRANDS } from "./provider-brands.js";

describe("PROVIDER_PRESETS", () => {
  it("contains at least one preset", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
  });

  it("every preset has a unique id", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset has a name, capabilities, and an OpenAI-compatible URL or a decision API", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.name).toBeTruthy();
      if (p.defaultUrl !== undefined) expect(p.defaultUrl, p.id).toMatch(/^https?:\/\//);
      expect(p.defaultUrl ?? p.decision, p.id).toBeDefined();
      expect(p.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("every defaultUrl ends without a trailing slash", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.defaultUrl?.endsWith("/") ?? false).toBe(false);
    }
  });

  it("no defaultUrl carries a baked-in version path (those go in apiPathPrefix)", () => {
    // The request builders append the prefix; a version path in defaultUrl would
    // double up (the Gemini "…/v1beta/openai/v1/…" regression).
    for (const p of PROVIDER_PRESETS) {
      if (p.defaultUrl) expect(p.defaultUrl, p.id).not.toMatch(/\/v1(beta)?\b/);
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

  it("Regolo AI uses its OpenAI-compatible host and Models.dev alias", () => {
    expect(getPreset("regolo")).toEqual({
      id: "regolo",
      modelsDevId: "regolo-ai",
      name: "Regolo AI",
      kind: "cloud",
      defaultUrl: "https://api.regolo.ai",
      capabilities: ["agent", "embed"],
    });
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

describe("getPresetByUrl", () => {
  it("finds every preset by its default URL, with or without a trailing slash", () => {
    for (const p of PROVIDER_PRESETS) {
      if (!p.defaultUrl) continue;
      expect(getPresetByUrl(p.defaultUrl)?.id, p.id).toBe(p.id);
      expect(getPresetByUrl(`${p.defaultUrl}/`)?.id, p.id).toBe(p.id);
    }
  });

  it("returns undefined for a URL no preset uses", () => {
    expect(getPresetByUrl("https://llm.example.com")).toBeUndefined();
  });
});

describe("decision APIs", () => {
  const withDecision = PROVIDER_PRESETS.filter((p) => p.decision);

  it("gives the agent providers that offer one a decision API, with the same key", () => {
    expect(getPreset("openai")?.decision).toMatchObject({
      url: "https://api.openai.com/v1/decisions",
      protocol: "openai-decisions",
      auth: "bearer",
    });
    expect(getPreset("fireworks")?.decision).toMatchObject({
      url: "https://api.fireworks.ai/inference/v1/systemone",
      protocol: "systemone",
    });
    expect(getPreset("openrouter")?.decision).toMatchObject({
      url: "https://openrouter.ai/api/v1/systemone",
      modelsDevId: "openrouter",
    });
    for (const id of ["openai", "fireworks", "openrouter"]) {
      expect(getPreset(id)?.defaultUrl, id).toBeDefined();
      expect(getPreset(id)?.capabilities, id).toContain("decision");
    }
  });

  it("adds decision-only providers with no OpenAI-compatible URL", () => {
    const decisionOnly = [
      "ollaya",
      "ollama",
      "ollama-cloud",
      "perplexity",
      "baseten",
      "deepinfra",
      "vercel",
      "cloudflare",
      "azure-foundry",
      "fastino",
      "aimlapi",
    ];
    for (const id of decisionOnly) {
      const preset = getPreset(id);
      expect(preset?.decision, id).toBeDefined();
      expect(preset?.defaultUrl, id).toBeUndefined();
      expect(preset?.capabilities, id).toEqual(["decision"]);
    }
    expect(getPreset("cloudflare")?.decision?.protocol).toBe("workers-ai");
    expect(getPreset("azure-foundry")?.decision?.auth).toBe("api-key");
    expect(getPreset("fastino")?.decision).toMatchObject({
      auth: "x-api-key",
      scoreField: "expected_level",
    });
  });

  it("marks TypeSafe as built in rather than a backend to add", () => {
    expect(getPreset("typesafe")).toMatchObject({ builtIn: "typesafe", kind: "cloud" });
    expect(PROVIDER_PRESETS.filter((p) => p.builtIn).map((p) => p.id)).toEqual(["typesafe"]);
  });

  it("gives every decision API an https docs link and at least one model", () => {
    for (const { id, decision } of withDecision) {
      expect(decision!.docsUrl, id).toMatch(/^https:\/\//);
      if (decision!.keyUrl) expect(decision!.keyUrl, id).toMatch(/^https:\/\//);
      expect(decision!.suggestedModels.length, id).toBeGreaterThan(0);
    }
  });

  it("keeps local servers on this host and keyless, and cloud providers on https with a key", () => {
    for (const { id, kind, decision } of withDecision) {
      if (kind === "local") {
        expect(decision!.url, id).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
        expect(decision!.keyRequired, id).toBe(false);
      } else {
        expect(decision!.url, id).toMatch(/^https:\/\//);
        expect(decision!.keyRequired, id).toBe(true);
      }
    }
  });

  it("declares a field for every URL placeholder, and none it does not use", () => {
    for (const { id, decision } of withDecision) {
      const placeholders = decisionUrlPlaceholders(decision!.url).sort();
      const params = (decision!.urlParams ?? []).map((p) => p.key).sort();
      expect(placeholders, id).toEqual(params);
    }
  });
});

describe("fillDecisionPresetUrl", () => {
  it("fills and encodes each placeholder", () => {
    expect(fillDecisionPresetUrl(getPreset("cloudflare")!, { account: " abc123 " })).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run",
    );
    expect(fillDecisionPresetUrl(getPreset("azure-foundry")!, { resource: "a/b" })).toBe(
      "https://a%2Fb.services.ai.azure.com/providers/microsoft/v1/systemone",
    );
  });

  it("names the missing value", () => {
    expect(() => fillDecisionPresetUrl(getPreset("cloudflare")!, {})).toThrow(
      "Cloudflare Workers AI needs your account id",
    );
  });

  it("returns a URL without placeholders unchanged, and refuses a preset with no decision API", () => {
    expect(fillDecisionPresetUrl(getPreset("ollaya")!, {})).toBe(
      "http://127.0.0.1:11435/v1/systemone",
    );
    expect(() => fillDecisionPresetUrl(getPreset("groq")!, {})).toThrow(
      "Groq serves no decision models",
    );
  });
});

describe("findPreset", () => {
  it("prefers the recorded id, then the OpenAI-compatible URL, then the decision URL", () => {
    expect(findPreset("ollama", { decisionUrl: "http://192.0.2.9/v1/systemone" })?.id).toBe(
      "ollama",
    );
    expect(findPreset(undefined, { url: "https://api.fireworks.ai/inference/" })?.id).toBe(
      "fireworks",
    );
    expect(
      findPreset(undefined, { decisionUrl: "https://openrouter.ai/api/v1/systemone/" })?.id,
    ).toBe("openrouter");
    expect(
      findPreset("gone", { url: "http://192.0.2.9:9000", decisionUrl: "http://192.0.2.9/x" }),
    ).toBeUndefined();
  });

  it("never matches by a URL with placeholders, or TypeSafe's built-in endpoint", () => {
    expect(
      findPreset(undefined, {
        decisionUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
      }),
    ).toBeUndefined();
    expect(
      findPreset(undefined, { decisionUrl: "https://api.typesafe.ai/v1/systemone" }),
    ).toBeUndefined();
  });
});
