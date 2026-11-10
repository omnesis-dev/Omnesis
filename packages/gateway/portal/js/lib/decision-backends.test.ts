// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  assignedCalibration,
  assignedDecisionBackend,
  calibrationFraction,
  calibrationPanelState,
  calibrationProgressText,
  calibrationSummary,
  canProbeDecisionBackend,
  currentDecisionAssignment,
  CUSTOM_DECISION_PROVIDER,
  decisionBackendNameError,
  decisionBackendPatch,
  decisionBackendWhere,
  decisionLogoId,
  decisionModelHint,
  decisionModelOptions,
  decisionProviderGroups,
  decisionUrlPlaceholders,
  decisionVerifyText,
  defaultDecisionBackendName,
  fillDecisionUrl,
  removeDecisionBackendPatch,
  // @ts-expect-error — portal modules are plain JS.
} from "./decision-backends.js";

const LOCAL = {
  id: "ollaya", name: "Ollaya", kind: "local", url: "http://127.0.0.1:11435/v1/systemone",
  protocol: "systemone", auth: "bearer", keyRequired: false, models: [{ id: "kev", source: "preset" }, { id: "laya", source: "preset" }],
};
const TYPESAFE = {
  id: "typesafe", name: "TypeSafe", kind: "cloud", url: "https://api.example.com/v1/systemone",
  protocol: "systemone", auth: "bearer", keyRequired: true, builtIn: "typesafe", models: [],
};
const CLOUD = {
  id: "cloudflare", name: "Edgeworks AI", kind: "cloud", modelsDevId: "cloudflare-workers-ai",
  url: "https://api.example.com/client/v4/accounts/{account}/ai/run", protocol: "workers-ai", auth: "bearer", keyRequired: true,
  urlParams: [{ key: "account", label: "Account ID", placeholder: "0123" }],
  models: [{ id: "@cf/example/clef", contextTokens: 65536, inputCostPerMillion: 0.24, source: "models.dev" }],
};
const SCORED = {
  id: "fastino", name: "Fastino", kind: "cloud", url: "https://api.example.org/v1/systemone",
  protocol: "systemone", auth: "x-api-key", scoreField: "expected_level", keyRequired: true, models: [],
};

function overview(extra: Record<string, unknown> = {}, inference: Record<string, unknown> = {}) {
  return {
    decisionPresets: [CLOUD, LOCAL, TYPESAFE, SCORED],
    inference: {
      backends: { vllm: { type: "http", url: "http://127.0.0.1:8000" } },
      decisionBackends: {
        ollaya: { preset: "ollaya", url: LOCAL.url, protocol: "systemone", auth: "bearer", onHost: true, hasApiKey: false, calibrations: {} },
      },
      assignments: { decision: { role: "decision", kind: "disabled" } },
      ...inference,
    },
    ...extra,
  };
}

describe("decision provider groups", () => {
  it("lists configured backends, then this machine with Other server last, then the cloud with TypeSafe first", () => {
    const groups = decisionProviderGroups(overview());
    expect(groups.existing.map((e: { key: string }) => e.key)).toEqual(["ollaya"]);
    expect(groups.existing[0].preset.id).toBe("ollaya");
    expect(groups.local.map((p: { id: string }) => p.id)).toEqual(["ollaya", "custom"]);
    expect(groups.cloud.map((p: { id: string }) => p.id)).toEqual(["typesafe", "cloudflare", "fastino"]);
  });

  it("is empty but still offers Other server on a gateway without presets", () => {
    const groups = decisionProviderGroups({ inference: { assignments: {} } });
    expect(groups).toEqual({ existing: [], local: [CUSTOM_DECISION_PROVIDER], cloud: [] });
  });

  it("names a logo by the models.dev id and none for Other server or TypeSafe", () => {
    expect(decisionLogoId(CLOUD)).toBe("cloudflare-workers-ai");
    expect(decisionLogoId(LOCAL)).toBe("ollaya");
    expect(decisionLogoId(TYPESAFE)).toBeNull();
    expect(decisionLogoId(CUSTOM_DECISION_PROVIDER)).toBeNull();
    expect(decisionLogoId(undefined)).toBeNull();
  });
});

describe("URL filling", () => {
  it("replaces each placeholder with the URL-encoded value", () => {
    expect(fillDecisionUrl(CLOUD, { account: " ab/cd " })).toEqual({ url: "https://api.example.com/client/v4/accounts/ab%2Fcd/ai/run" });
  });

  it("names the missing value", () => {
    expect(fillDecisionUrl(CLOUD, {})).toEqual({ error: "Enter your account id." });
    expect(fillDecisionUrl(CLOUD, { account: "   " }).error).toBe("Enter your account id.");
  });

  it("refuses a URL that still has a placeholder no param fills", () => {
    expect(fillDecisionUrl({ url: "https://{tenant}.example.com/v1" }, {})).toEqual({ error: "The URL still has {tenant}." });
    expect(decisionUrlPlaceholders("https://{a}.example.com/{b-c}")).toEqual(["a", "b-c"]);
  });

  it("leaves a URL without placeholders as it is", () => {
    expect(fillDecisionUrl(LOCAL)).toEqual({ url: LOCAL.url });
  });
});

describe("backend names", () => {
  const o = overview();
  it("refuses reserved names, slashes, blanks and long names", () => {
    expect(decisionBackendNameError("", o)).toBe("Enter a name.");
    expect(decisionBackendNameError("typesafe", o)).toBe('"typesafe" is reserved.');
    expect(decisionBackendNameError("local", o)).toBe('"local" is reserved.');
    expect(decisionBackendNameError("a/b", o)).toBe('A name cannot contain "/".');
    expect(decisionBackendNameError("x".repeat(65), o)).toBe("Use at most 64 characters.");
  });

  it("refuses a name an HTTP backend or another decision backend already has", () => {
    expect(decisionBackendNameError("vllm", o)).toBe('"vllm" is already an HTTP backend.');
    expect(decisionBackendNameError("ollaya", o)).toBe('"ollaya" is already a decision backend.');
    expect(decisionBackendNameError("ollaya", o, { existingKey: "ollaya" })).toBeNull();
    expect(decisionBackendNameError("ollaya-lab", o)).toBeNull();
  });

  it("defaults to the provider id, then the next free suffix", () => {
    expect(defaultDecisionBackendName(CLOUD, o)).toBe("cloudflare");
    expect(defaultDecisionBackendName(LOCAL, o)).toBe("ollaya-2");
    expect(defaultDecisionBackendName(CUSTOM_DECISION_PROVIDER, o)).toBe("decision-server");
  });
});

describe("config patch", () => {
  it("saves a preset backend and assigns the model in one write", () => {
    expect(decisionBackendPatch({ key: "ollaya", provider: LOCAL, url: LOCAL.url, apiKey: "", model: "kev" })).toEqual({
      inference: {
        decisionBackends: { ollaya: { preset: "ollaya", url: LOCAL.url, protocol: "systemone", auth: "bearer" } },
        assignments: { decision: "ollaya/kev" },
      },
    });
  });

  it("folds consent in, carries the key and the preset's score field", () => {
    expect(decisionBackendPatch({ key: "fast", provider: SCORED, url: SCORED.url, apiKey: " sk-example ", model: "glide", enableRemote: true })).toEqual({
      inference: {
        allowRemoteInference: true,
        decisionBackends: {
          fast: { preset: "fastino", url: SCORED.url, protocol: "systemone", auth: "x-api-key", scoreField: "expected_level", apiKey: "sk-example" },
        },
        assignments: { decision: "fast/glide" },
      },
    });
  });

  it("leaves a blank key out so a stored one is kept, and records no preset for Other server", () => {
    const patch = decisionBackendPatch({ key: "lab", provider: CUSTOM_DECISION_PROVIDER, url: "http://127.0.0.1:9000/v1/systemone", apiKey: "   ", model: "m" });
    expect(patch.inference.decisionBackends.lab).toEqual({ url: "http://127.0.0.1:9000/v1/systemone", protocol: "systemone", auth: "bearer" });
  });

  it("sends only what changed on an existing backend, never its wire format", () => {
    // A hand-written backend speaking another protocol and auth, from no known preset.
    const existing = { url: "https://decide.example.org/v1/decisions", protocol: "openai-decisions", auth: "api-key", onHost: false, hasApiKey: true, calibrations: {} };
    expect(decisionBackendPatch({ key: "lab", provider: CUSTOM_DECISION_PROVIDER, url: "https://decide.example.org/v2/decisions", apiKey: "", model: "m", existing, currentAssignment: "lab/m" })).toEqual({
      inference: { decisionBackends: { lab: { url: "https://decide.example.org/v2/decisions" } } },
    });
    expect(decisionBackendPatch({ key: "lab", provider: CUSTOM_DECISION_PROVIDER, url: existing.url, apiKey: "new-key", existing })).toEqual({
      inference: { decisionBackends: { lab: { apiKey: "new-key" } } },
    });
  });

  it("leaves the assignment out when the model is unchanged, and returns null when nothing changes", () => {
    const existing = { url: LOCAL.url, protocol: "systemone", auth: "bearer", onHost: true, hasApiKey: false, calibrations: {} };
    expect(decisionBackendPatch({ key: "ollaya", provider: LOCAL, url: LOCAL.url, model: "kev", existing, currentAssignment: "ollaya/kev" })).toBeNull();
    expect(decisionBackendPatch({ key: "ollaya", provider: LOCAL, url: LOCAL.url, model: "laya", existing, currentAssignment: "ollaya/kev" })).toEqual({
      inference: { assignments: { decision: "ollaya/laya" } },
    });
    expect(decisionBackendPatch({ key: "ollaya", provider: LOCAL, url: LOCAL.url, model: "kev", existing, currentAssignment: "ollaya/kev", enableRemote: true })).toEqual({
      inference: { allowRemoteInference: true },
    });
  });

  it("reads the current decision assignment", () => {
    expect(currentDecisionAssignment(overview({}, { assignments: { decision: { kind: "decision", backendKey: "ollaya", model: "kev" } } }))).toBe("ollaya/kev");
    expect(currentDecisionAssignment(overview())).toBeNull();
  });

  it("changes only the backend when no model is given", () => {
    expect(decisionBackendPatch({ key: "ollaya", provider: LOCAL, url: LOCAL.url })).toEqual({
      inference: { decisionBackends: { ollaya: { preset: "ollaya", url: LOCAL.url, protocol: "systemone", auth: "bearer" } } },
    });
  });

  it("removes a backend and turns the Decision model off only when it is assigned there", () => {
    expect(removeDecisionBackendPatch("ollaya", overview())).toEqual({ inference: { decisionBackends: { ollaya: null } } });
    const assigned = overview({}, { assignments: { decision: { role: "decision", kind: "decision", backendKey: "ollaya", model: "kev", available: true } } });
    expect(removeDecisionBackendPatch("ollaya", assigned)).toEqual({ inference: { decisionBackends: { ollaya: null }, assignments: { decision: null } } });
  });
});

describe("assigned decision backend", () => {
  it("reads the backend and preset behind a decision assignment", () => {
    const o = overview({}, { assignments: { decision: { role: "decision", kind: "decision", backendKey: "ollaya", model: "kev", calibrated: false, available: true } } });
    const assigned = assignedDecisionBackend(o);
    expect(assigned.key).toBe("ollaya");
    expect(assigned.model).toBe("kev");
    expect(assigned.preset.name).toBe("Ollaya");
    expect(assigned.backend.onHost).toBe(true);
  });

  it("is null for TypeSafe, a disabled role and an older gateway", () => {
    expect(assignedDecisionBackend(overview({}, { assignments: { decision: { kind: "typesafe", model: "jev" } } }))).toBeNull();
    expect(assignedDecisionBackend(overview())).toBeNull();
    expect(assignedDecisionBackend({})).toBeNull();
  });

  it("says where a backend runs", () => {
    expect(decisionBackendWhere({ onHost: true, url: LOCAL.url })).toBe("On this host");
    expect(decisionBackendWhere({ onHost: false, url: "https://api.example.com/v1" })).toBe("api.example.com");
    expect(decisionBackendWhere(undefined)).toBe("");
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
    expect(decisionModelHint(CLOUD.models[0])).toBe("66k context · $0.24/M input tokens");
    expect(decisionModelHint({ id: "a", contextTokens: 1_048_576 })).toBe("1M context");
    expect(decisionModelHint({ id: "a", inputCostPerMillion: 0.004 })).toBe("$0.004/M input tokens");
    expect(decisionModelHint({ id: "a", inputCostPerMillion: 0 })).toBe("free");
    expect(decisionModelHint({ id: "a" })).toBe("");
  });

  it("probes only servers of the operator's own", () => {
    expect(canProbeDecisionBackend(LOCAL)).toBe(true);
    expect(canProbeDecisionBackend(CUSTOM_DECISION_PROVIDER)).toBe(true);
    expect(canProbeDecisionBackend(CLOUD)).toBe(false);
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

  it("summarises what a calibration keeps and skips, with the shares before it", () => {
    const text = calibrationSummary({
      points: [], reference: "r", fittedAt: "2026-03-04T10:00:00Z",
      keeps: 0.95, skips: 0.873, keepsBefore: 0.61, skipsBefore: 0.98, agreement: 0.9, agreementBefore: 0.8,
    });
    expect(text).toMatch(/^Calibrated against Jev on .+: keeps 95% of the reference emails Jev keeps and skips 87% of those it skips \(before: 61% and 98%\)\.$/);
    expect(calibrationSummary({ points: [], reference: "r", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, skips: 0.5 }))
      .toMatch(/: keeps 95% of the reference emails Jev keeps and skips 50% of those it skips\.$/);
    // Only one of the two shares: the older agreement sentence.
    expect(calibrationSummary({ points: [], reference: "r", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, agreement: 0.9 }))
      .toMatch(/: agrees with Jev on 90% of the reference emails\.$/);
  });

  it("summarises a finished run's result until the overview stores it", () => {
    const result = { points: [], reference: "r", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, skips: 0.8 };
    const assigned = { key: "ollaya", model: "kev", backend: { calibrations: {} }, assignment: { calibrated: false } };
    const done = { state: "done", assignment: "ollaya/kev", done: 300, total: 300, failed: 0, result };
    expect(calibrationPanelState(done, assigned)).toBe("calibrated");
    expect(assignedCalibration(assigned, done)).toBe(result);
    expect(assignedCalibration(assigned, { ...done, assignment: "other/kev" })).toBeUndefined();
    const stored = { ...result, keeps: 0.9 };
    expect(assignedCalibration({ ...assigned, backend: { calibrations: { kev: stored } } }, done)).toBe(stored);
  });

  it("summarises a calibration with its agreement before and after", () => {
    const text = calibrationSummary({ points: [], reference: "r", fittedAt: "2026-03-04T10:00:00Z", agreement: 0.914, agreementBefore: 0.78 });
    expect(text).toMatch(/^Calibrated against Jev on .+: agrees with Jev on 91% of the reference emails \(was 78%\)\.$/);
    expect(calibrationSummary({ points: [], reference: "r", fittedAt: "not a date" })).toBe("Calibrated against Jev.");
    expect(calibrationSummary(undefined)).toBe("");
  });

  it("reports progress in reference emails, with failures", () => {
    expect(calibrationProgressText({ state: "running", done: 120, total: 300, failed: 0 })).toBe("120 of 300 reference emails");
    expect(calibrationProgressText({ state: "running", done: 120, total: 300, failed: 3 })).toBe("120 of 300 reference emails · 3 failed");
    expect(calibrationProgressText({ state: "running", done: 0, total: 0, failed: 0 })).toBe("Starting…");
    expect(calibrationFraction({ done: 75, total: 300 })).toBe(0.25);
    expect(calibrationFraction({ done: 0, total: 0 })).toBe(0);
  });

  it("shows a job's state only for the assigned model", () => {
    const assigned = { key: "ollaya", model: "kev", assignment: { calibrated: false } };
    expect(calibrationPanelState({ state: "running", assignment: "ollaya/kev" }, assigned)).toBe("running");
    expect(calibrationPanelState({ state: "running", assignment: "other/kev" }, assigned)).toBe("other-running");
    expect(calibrationPanelState({ state: "failed", assignment: "ollaya/kev" }, assigned)).toBe("failed");
    expect(calibrationPanelState({ state: "cancelled", assignment: "ollaya/kev" }, assigned)).toBe("cancelled");
    expect(calibrationPanelState({ state: "done", assignment: "ollaya/kev" }, { ...assigned, assignment: { calibrated: true } })).toBe("calibrated");
    expect(calibrationPanelState(null, assigned)).toBe("uncalibrated");
    // A failed recalibration of a calibrated model keeps the calibration in force.
    expect(calibrationPanelState({ state: "failed", assignment: "ollaya/kev" }, { ...assigned, assignment: { calibrated: true } })).toBe("calibrated");
  });
});
