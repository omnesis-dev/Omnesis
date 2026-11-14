// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  assignedDecisionBackend,
  canProbeDecisionModels,
  currentDecisionAssignment,
  decisionModelHint,
  decisionModelOptions,
  decisionPickerGroups,
  decisionVerifyText,
  decisionWhere,
  newDecisionPresets,
  // @ts-expect-error — portal modules are plain JS.
} from "./decision-models.js";

const decisionApi = <T extends Record<string, unknown>>(extra: T) => ({ protocol: "systemone", auth: "bearer", keyRequired: true, docsUrl: "https://docs.example.com", suggestedModels: [], models: [], ...extra });
const LOCAL = {
  id: "ollaya", name: "Ollaya", kind: "local", capabilities: ["decision"],
  decision: decisionApi({ url: "http://127.0.0.1:11435/v1/systemone", keyRequired: false, models: [{ id: "kev", source: "preset" }, { id: "laya", source: "preset" }] }),
};
const BOTH = {
  id: "fireworks", name: "Fireworks AI", kind: "cloud", defaultUrl: "https://api.example.com/inference", capabilities: ["agent", "decision"],
  decision: decisionApi({ url: "https://api.example.com/inference/v1/systemone", models: [{ id: "rune", contextTokens: 65536, inputCostPerMillion: 0.24, source: "models.dev" }] }),
};
const CHAT_ONLY = { id: "groq", name: "Groq", kind: "cloud", defaultUrl: "https://api.example.org/openai", capabilities: ["agent"] };
const TYPESAFE = { id: "typesafe", name: "TypeSafe", kind: "cloud", builtIn: "typesafe", capabilities: ["decision"], decision: decisionApi({ url: "https://api.example.net/v1/systemone" }) };

const OLLAYA = { type: "http", status: "ok", preset: "ollaya", decision: { url: LOCAL.decision.url, protocol: "systemone", auth: "bearer", onHost: true, hasApiKey: false } };

function overview(inference: Record<string, unknown> = {}) {
  return {
    presets: [CHAT_ONLY, BOTH],
    decisionProviders: [LOCAL, TYPESAFE],
    inference: {
      backends: {
        vllm: { type: "http", status: "ok", url: "http://127.0.0.1:8000" },
        fireworks: { type: "http", status: "ok", preset: "fireworks", url: BOTH.defaultUrl, hasApiKey: true },
        groq: { type: "http", status: "ok", preset: "groq", url: CHAT_ONLY.defaultUrl },
        ollaya: OLLAYA,
        anthropic: { type: "anthropic", status: "ok" },
      },
      assignments: { decision: { role: "decision", kind: "disabled" } },
      ...inference,
    },
  };
}

describe("decision picker", () => {
  it("lists backends that serve decisions, then those whose preset offers them, and never a chat-only one", () => {
    const { ready, enable } = decisionPickerGroups(overview());
    expect(ready.map((entry: { key: string }) => entry.key)).toEqual(["ollaya"]);
    expect(ready[0].preset.name).toBe("Ollaya");
    expect(enable.map((entry: { key: string }) => entry.key)).toEqual(["fireworks"]);
    expect(enable[0].preset.id).toBe("fireworks");
  });

  it("stops offering to enable a backend once it serves decisions", () => {
    const o = overview();
    (o.inference.backends as Record<string, unknown>).fireworks = { ...(o.inference.backends as Record<string, Record<string, unknown>>).fireworks, decision: { url: BOTH.decision.url, onHost: false } };
    const { ready, enable } = decisionPickerGroups(o);
    expect(ready.map((entry: { key: string }) => entry.key)).toEqual(["fireworks", "ollaya"]);
    expect(enable).toEqual([]);
  });

  it("adds only providers with decisions that no backend was made from, never the built-in TypeSafe", () => {
    // Fireworks and Ollaya already have backends; they are offered above, with their own key.
    expect(newDecisionPresets(overview()).map((p: { id: string }) => p.id)).toEqual([]);
    const { presets, decisionProviders } = overview();
    expect(newDecisionPresets({ presets, decisionProviders, inference: { backends: { vllm: { type: "http", url: "http://127.0.0.1:8000" } } } }).map((p: { id: string }) => p.id))
      .toEqual(["fireworks", "ollaya"]);
    expect(newDecisionPresets({})).toEqual([]);
  });
});

describe("assigned decision backend", () => {
  it("reads the backend and preset behind a decision assignment", () => {
    const o = overview({ assignments: { decision: { role: "decision", kind: "decision", backendKey: "ollaya", model: "kev", available: true } } });
    const assigned = assignedDecisionBackend(o);
    expect(assigned.key).toBe("ollaya");
    expect(assigned.model).toBe("kev");
    expect(assigned.preset.name).toBe("Ollaya");
    expect(assigned.backend.decision.onHost).toBe(true);
    expect(currentDecisionAssignment(o)).toBe("ollaya/kev");
  });

  it("is null for TypeSafe, a disabled role and an empty overview", () => {
    expect(assignedDecisionBackend(overview({ assignments: { decision: { kind: "typesafe", model: "jev" } } }))).toBeNull();
    expect(assignedDecisionBackend(overview())).toBeNull();
    expect(assignedDecisionBackend({})).toBeNull();
    expect(currentDecisionAssignment(overview())).toBeNull();
  });

  it("says where a decision API runs", () => {
    expect(decisionWhere({ onHost: true, url: LOCAL.decision.url })).toBe("On this host");
    expect(decisionWhere({ onHost: false, url: "https://api.example.com/v1" })).toBe("api.example.com");
    expect(decisionWhere(undefined)).toBe("");
  });
});

describe("model suggestions", () => {
  it("puts the models a server reported first, marked installed, then the preset's", () => {
    expect(decisionModelOptions(LOCAL, ["winnow", "kev", "kev"])).toEqual([
      { id: "winnow", installed: true },
      { id: "kev", source: "preset", installed: true },
      { id: "laya", source: "preset" },
    ]);
    expect(decisionModelOptions(undefined, [])).toEqual([]);
  });

  it("hints context and price when known", () => {
    expect(decisionModelHint(BOTH.decision.models[0])).toBe("66k context · $0.24/M input tokens");
    expect(decisionModelHint({ id: "a", contextTokens: 1_048_576 })).toBe("1M context");
    expect(decisionModelHint({ id: "a", inputCostPerMillion: 0.004 })).toBe("$0.004/M input tokens");
    expect(decisionModelHint({ id: "a", inputCostPerMillion: 0 })).toBe("free");
    expect(decisionModelHint({ id: "a" })).toBe("");
  });

  it("asks only servers of the operator's own for their models", () => {
    expect(canProbeDecisionModels(LOCAL)).toBe(true);
    expect(canProbeDecisionModels(undefined)).toBe(true);
    expect(canProbeDecisionModels(BOTH)).toBe(false);
  });
});

describe("status sentences", () => {
  it("states the answer time, names a resolved alias, and keeps a failure's reason verbatim", () => {
    expect(decisionVerifyText({ ok: true, latencyMs: 239.6, answeredBy: "kev" }, "kev")).toBe("Answered in 240 ms.");
    expect(decisionVerifyText({ ok: true, latencyMs: 80, answeredBy: "kev-1.2" }, "kev")).toBe("Answered by kev-1.2 in 80 ms.");
    expect(decisionVerifyText({ ok: true })).toBe("Answered.");
    expect(decisionVerifyText({ ok: false, reason: "The API key was refused (HTTP 401)." })).toBe("The API key was refused (HTTP 401).");
    expect(decisionVerifyText({ ok: false })).toBe("The model did not answer.");
    expect(decisionVerifyText(null)).toBe("");
  });
});
