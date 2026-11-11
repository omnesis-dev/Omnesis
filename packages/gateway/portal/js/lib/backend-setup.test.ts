// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  addablePresets,
  allProviders,
  backendDisplayName,
  backendNameError,
  backendServes,
  disableDecisionPatch,
  enableDecisionPatch,
  fillDecisionUrl,
  freeBackendName,
  newBackendPatch,
  presetLogoId,
  presetServes,
  SERVES_LABEL,
  // @ts-expect-error — portal modules are plain JS.
} from "./backend-setup.js";

const BOTH = {
  id: "fireworks", name: "Fireworks AI", kind: "cloud", defaultUrl: "https://api.example.com/inference",
  decision: { url: "https://api.example.com/inference/v1/systemone", protocol: "systemone", auth: "bearer", keyRequired: true },
};
const SCORED = {
  id: "fastino", name: "Fastino", kind: "cloud",
  decision: { url: "https://api.example.org/v1/systemone", protocol: "systemone", auth: "x-api-key", scoreField: "expected_level", keyRequired: true },
};
const PARAMS = {
  id: "cloudflare", name: "Edgeworks AI", kind: "cloud",
  decision: {
    url: "https://api.example.com/client/v4/accounts/{account}/ai/run", protocol: "workers-ai", auth: "bearer", keyRequired: true,
    modelsDevId: "cloudflare-workers-ai", urlParams: [{ key: "account", label: "Account ID", placeholder: "0123" }],
  },
};
const CHAT = { id: "groq", name: "Groq", kind: "cloud", defaultUrl: "https://api.example.net/openai", apiPathPrefix: "/v2" };
const TYPESAFE = { id: "typesafe", name: "TypeSafe", kind: "cloud", builtIn: "typesafe", decision: { url: "https://api.example.net/v1/systemone" } };

const overview = {
  presets: [BOTH, CHAT],
  decisionProviders: [SCORED, PARAMS, TYPESAFE],
  inference: {
    backends: { fireworks: { type: "http", url: BOTH.defaultUrl }, vllm: { type: "http", url: "http://127.0.0.1:8000" } },
    assignments: { decision: { kind: "decision", backendKey: "fireworks", model: "rune" } },
  },
};

describe("what a backend serves", () => {
  it("names chat models, decision models, or both", () => {
    expect(SERVES_LABEL[backendServes({ url: "https://a.example.com" })]).toBe("OpenAI-compatible models");
    expect(SERVES_LABEL[backendServes({ decision: { url: "https://a.example.com" } })]).toBe("Decision models");
    expect(SERVES_LABEL[backendServes({ url: "https://a.example.com", decision: { url: "https://a.example.com/d" } })]).toBe("OpenAI-compatible and decision models");
    expect(presetServes(BOTH)).toBe("both");
    expect(presetServes(SCORED)).toBe("decision");
    expect(presetServes(CHAT)).toBe("chat");
  });

  it("offers every preset but the built-in TypeSafe, OpenAI-compatible providers first", () => {
    expect(addablePresets(overview).map((p: { id: string }) => p.id)).toEqual(["fireworks", "groq", "fastino", "cloudflare"]);
  });

  it("reads decision-only providers beside the presets, and copes without them", () => {
    expect(allProviders(overview).map((p: { id: string }) => p.id)).toEqual(["fireworks", "groq", "fastino", "cloudflare", "typesafe"]);
    expect(allProviders({ presets: [CHAT] }).map((p: { id: string }) => p.id)).toEqual(["groq"]);
    expect(allProviders({})).toEqual([]);
  });

  it("brands a preset by its decision catalog id when it has one, and names a backend by its preset", () => {
    expect(presetLogoId(PARAMS)).toBe("cloudflare-workers-ai");
    expect(presetLogoId(BOTH)).toBe("fireworks");
    expect(presetLogoId(TYPESAFE)).toBeNull();
    expect(backendDisplayName("fireworks", BOTH)).toBe("Fireworks AI");
    expect(backendDisplayName("fireworks-2", BOTH)).toBe("fireworks-2");
    expect(backendDisplayName("lab", undefined)).toBe("lab");
  });
});

describe("backend names", () => {
  it("refuses reserved names, slashes, blanks, long names and names already taken", () => {
    expect(backendNameError("typesafe", overview)).toBe('"typesafe" is reserved.');
    expect(backendNameError("local", overview)).toBe('"local" is reserved.');
    expect(backendNameError("a/b", overview)).toBe('A name cannot contain "/".');
    expect(backendNameError("  ", overview)).toBe("Enter a name.");
    expect(backendNameError("x".repeat(65), overview)).toBe("Use at most 64 characters.");
    expect(backendNameError("vllm", overview)).toBe('"vllm" is already a backend.');
    expect(backendNameError("lab", overview)).toBeNull();
  });

  it("defaults to the preset id, then the next free suffix", () => {
    expect(freeBackendName("fastino", overview)).toBe("fastino");
    expect(freeBackendName("fireworks", overview)).toBe("fireworks-2");
    expect(freeBackendName("", overview)).toBe("");
  });
});

describe("decision URL filling", () => {
  it("replaces each placeholder with the URL-encoded value", () => {
    expect(fillDecisionUrl(PARAMS.decision, { account: " a b/c " })).toEqual({ url: "https://api.example.com/client/v4/accounts/a%20b%2Fc/ai/run" });
  });

  it("names the missing value, and refuses a placeholder no param fills", () => {
    expect(fillDecisionUrl(PARAMS.decision, {})).toEqual({ error: "Enter your account id." });
    expect(fillDecisionUrl({ url: "https://{tenant}.example.com" }, {})).toEqual({ error: "The URL still has {tenant}." });
    expect(fillDecisionUrl(BOTH.decision, {})).toEqual({ url: BOTH.decision.url });
  });
});

describe("config patches", () => {
  it("adds a preset with both APIs as one backend with one key", () => {
    expect(newBackendPatch({
      key: "fireworks-2", preset: BOTH, url: BOTH.defaultUrl, decisionUrl: BOTH.decision.url, apiKey: " example-key ",
    })).toEqual({
      inference: {
        backends: {
          "fireworks-2": {
            type: "http", preset: "fireworks", url: BOTH.defaultUrl, apiKey: "example-key",
            decision: { url: BOTH.decision.url, protocol: "systemone", auth: "bearer" },
          },
        },
      },
    });
  });

  it("adds a decision-only preset with its wire format, assigns the model and folds consent in", () => {
    expect(newBackendPatch({
      key: "fastino", preset: SCORED, url: "", decisionUrl: SCORED.decision.url, apiKey: "example-key", decisionModel: "glide", enableRemote: true,
    })).toEqual({
      inference: {
        allowRemoteInference: true,
        backends: {
          fastino: {
            type: "http", preset: "fastino", apiKey: "example-key",
            decision: { url: SCORED.decision.url, protocol: "systemone", auth: "x-api-key", scoreField: "expected_level" },
          },
        },
        assignments: { decision: "fastino/glide" },
      },
    });
  });

  it("carries a chat preset's path prefix, and records no preset or key for a keyless server of one's own", () => {
    expect(newBackendPatch({ key: "groq", preset: CHAT, url: CHAT.defaultUrl, apiPathPrefix: CHAT.apiPathPrefix, apiKey: "" }))
      .toEqual({ inference: { backends: { groq: { type: "http", preset: "groq", url: CHAT.defaultUrl, apiPathPrefix: "/v2" } } } });
    expect(newBackendPatch({ key: "lab", preset: null, decisionUrl: "http://127.0.0.1:18990/v1/systemone" }))
      .toEqual({ inference: { backends: { lab: { type: "http", decision: { url: "http://127.0.0.1:18990/v1/systemone" } } } } });
  });

  it("enables a preset's decisions on an existing backend with no key, and assigns the model", () => {
    expect(enableDecisionPatch({ key: "fireworks", preset: BOTH, decisionUrl: BOTH.decision.url, model: "rune" })).toEqual({
      inference: {
        backends: { fireworks: { decision: { url: BOTH.decision.url, protocol: "systemone", auth: "bearer" } } },
        assignments: { decision: "fireworks/rune" },
      },
    });
    expect(enableDecisionPatch({ key: "fireworks", preset: BOTH, decisionUrl: BOTH.decision.url, model: "rune", enableRemote: true }).inference.allowRemoteInference).toBe(true);
  });

  it("writes a typed key onto a backend that has none, beside its decision API", () => {
    expect(enableDecisionPatch({ key: "fireworks", preset: BOTH, decisionUrl: BOTH.decision.url, model: "rune", apiKey: " example-key " })).toEqual({
      inference: {
        backends: { fireworks: { apiKey: "example-key", decision: { url: BOTH.decision.url, protocol: "systemone", auth: "bearer" } } },
        assignments: { decision: "fireworks/rune" },
      },
    });
  });

  it("disables a backend's decisions, turning the Decision model off only when it is assigned there", () => {
    expect(disableDecisionPatch("fireworks", overview)).toEqual({
      inference: { backends: { fireworks: { decision: null } }, assignments: { decision: null } },
    });
    expect(disableDecisionPatch("vllm", overview)).toEqual({ inference: { backends: { vllm: { decision: null } } } });
  });
});
