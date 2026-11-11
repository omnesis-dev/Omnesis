// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
//
// Settings → Models with backends that serve chat models, decision models or
// both: the Decision model's picker (backends with decisions, backends whose
// provider offers them with the key they have, TypeSafe, "Add a provider"),
// the shared add form for each kind of provider, the calibration panel on the
// Decision model's card, and the one Backends list.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn(),
  patchAdminConfig: vi.fn(), getRecentModels: vi.fn(), probeBackend: vi.fn(), removeHttpBackend: vi.fn(),
  getModelCredentialsStatus: vi.fn(), setModelProviderCredentials: vi.fn(),
  probeBackendDecisionModels: vi.fn(), probeDecisionEndpoint: vi.fn(), verifyBackendDecision: vi.fn(), verifyTypeSafeDecision: vi.fn(),
  getDecisionCalibration: vi.fn(), startDecisionCalibration: vi.fn(), cancelDecisionCalibration: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));
import { ModelsView } from "./models.js";
import { CAPABILITY_METADATA } from "@omnesis/core";

const DECISION = CAPABILITY_METADATA.decision;

const decisionApi = (extra) => ({
  protocol: "systemone", auth: "bearer", keyRequired: true, suggestedModels: [], docsUrl: "https://docs.example.com/decisions", models: [], ...extra,
});
const PRESETS = [
  {
    id: "openai", name: "OpenAI", kind: "cloud", defaultUrl: "https://api.example.com", capabilities: ["agent", "decision"],
    decision: decisionApi({ url: "https://api.example.com/v1/decisions", protocol: "openai-decisions", keyUrl: "https://platform.example.com/keys", models: [{ id: "luna-decide", source: "preset" }] }),
  },
  {
    id: "fireworks", name: "Fireworks AI", kind: "cloud", defaultUrl: "https://api.example.org/inference", capabilities: ["agent", "decision"],
    decision: decisionApi({ url: "https://api.example.org/inference/v1/systemone", models: [{ id: "accounts/example/models/rune", contextTokens: 32000, inputCostPerMillion: 0.1, source: "models.dev" }] }),
  },
  { id: "groq", name: "Groq", kind: "cloud", defaultUrl: "https://api.example.net/openai", capabilities: ["agent"] },
  {
    id: "ollaya", name: "Ollaya", kind: "local", capabilities: ["decision"],
    decision: decisionApi({
      url: "http://127.0.0.1:11435/v1/systemone", keyRequired: false,
      note: "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
      models: [{ id: "kev", source: "preset" }, { id: "laya", source: "preset" }],
    }),
  },
  {
    id: "typesafe", name: "TypeSafe", kind: "cloud", builtIn: "typesafe", capabilities: ["decision"],
    decision: decisionApi({ url: "https://api.example.com/v1/systemone", models: [{ id: "jev-1.14.0", source: "preset" }] }),
  },
  {
    id: "cloudflare", name: "Edgeworks AI", kind: "cloud", capabilities: ["decision"],
    decision: decisionApi({
      url: "https://api.example.com/client/v4/accounts/{account}/ai/run", protocol: "workers-ai", modelsDevId: "cloudflare-workers-ai",
      keyUrl: "https://dash.example.com/tokens", urlParams: [{ key: "account", label: "Account ID", placeholder: "0123456789abcdef" }],
      note: "Workers AI shortens long text to fit the model's context without saying so.",
      models: [{ id: "@cf/example/clef-flash", contextTokens: 25000, inputCostPerMillion: 0.04, source: "models.dev" }],
    }),
  },
  {
    id: "fastino", name: "Fastino", kind: "cloud", capabilities: ["decision"],
    decision: decisionApi({ url: "https://api.example.io/v1/systemone", auth: "x-api-key", scoreField: "expected_level", models: [{ id: "fastino/glide", source: "preset" }] }),
  },
];

const FIREWORKS = { type: "http", status: "ok", preset: "fireworks", url: "https://api.example.org/inference", hasApiKey: true, models: ["accounts/example/models/chat-1"] };
const FIREWORKS_DECISION = { url: "https://api.example.org/inference/v1/systemone", protocol: "systemone", auth: "bearer", onHost: false, hasApiKey: true, calibrations: {} };
const ollayaWith = (calibrations = {}) => ({
  type: "http", status: "ok", preset: "ollaya",
  decision: { url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", auth: "bearer", onHost: true, hasApiKey: false, calibrations },
});
const VLLM = { type: "http", status: "ok", url: "http://127.0.0.1:8000", models: ["example-chat"] };

function overviewWith({ assignment = { kind: "disabled", role: "decision" }, backends = {}, allowRemoteInference = false, display } = {}) {
  return {
    capabilities: [DECISION],
    catalog: [], installed: [],
    presets: PRESETS,
    assignmentDisplays: display ? { decision: display } : {},
    inference: {
      allowRemoteInference,
      assignments: { decision: assignment },
      backends,
      decisionChatModels: false,
    },
  };
}

const onOllaya = (extra = {}) => ({
  assignment: { role: "decision", kind: "decision", backendKey: "ollaya", preset: "ollaya", model: "kev", url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", onHost: true, allowRemoteInference: false, hasApiKey: false, calibrated: false, available: true, ...extra },
  backends: { ollaya: ollayaWith() },
  display: { providerId: "ollaya", providerLabel: "Ollaya", modelName: "kev", available: true, configured: true },
});

describe("Models — backends that serve decisions", () => {
  let host, originalDocument, originalWindow, current;
  const buttons = () => [...host.querySelectorAll("button")];
  const button = (text) => buttons().find((entry) => entry.textContent.trim() === text);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const click = async (el) => {
    await act(async () => { el.dispatchEvent(new window.Event("click", { bubbles: false })); });
    await flush();
  };
  const clickText = async (text) => {
    expect(button(text), text).toBeTruthy();
    await click(button(text));
  };
  const cards = () => [...host.querySelectorAll(".backend-opt")];
  const card = (title) => cards().find((n) => n.querySelector(".backend-opt-title")?.textContent === title);
  const cardTitles = (section) => [...section.querySelectorAll(".backend-opt-title")].map((n) => n.textContent);
  const modelInput = () => host.querySelector(".decision-model-field input");
  const type = async (label, value) => {
    const input = label === "Model id" ? modelInput() : host.querySelector(`input[aria-label='${label}']`);
    expect(input, label).toBeTruthy();
    await act(async () => { input.value = value; input.dispatchEvent(new window.Event("input")); });
  };
  const submit = async () => {
    await act(async () => { host.querySelector(".decision-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); });
    await flush();
  };
  const mount = async (section = "decision") => {
    await act(async () => { render(h(ModelsView, { section }), host); });
    await flush();
  };
  const openPicker = async () => { await mount(); await clickText("Choose model"); };
  const addProvider = async (title) => {
    await openPicker();
    await click(card("Add a provider"));
    await click(card(title));
  };
  const pickOption = async (text) => {
    const option = [...host.querySelectorAll(".decision-model-opt")].find((n) => n.textContent.includes(text));
    expect(option, text).toBeTruthy();
    await click(option);
  };
  const waitForTypingPause = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    await flush();
  };

  beforeEach(() => {
    originalDocument = globalThis.document; originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    current = overviewWith();
    api.getModelsOverview.mockReset().mockImplementation(async () => current);
    api.getSystemInfo.mockReset().mockResolvedValue({});
    api.getCodexRuntimeUpdate.mockReset().mockResolvedValue({ plan: { state: "up-to-date" } });
    api.getRecentModels.mockReset().mockResolvedValue({ entries: [] });
    api.patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
    api.probeBackend.mockReset().mockResolvedValue({ status: "ok" });
    api.removeHttpBackend.mockReset().mockResolvedValue({ ok: true });
    api.getModelCredentialsStatus.mockReset().mockResolvedValue({ items: [] });
    api.setModelProviderCredentials.mockReset().mockResolvedValue({ ok: true });
    api.probeBackendDecisionModels.mockReset().mockResolvedValue({ ok: true, models: ["kev", "winnow"], listed: true });
    api.probeDecisionEndpoint.mockReset().mockResolvedValue({ ok: true, models: ["kev", "tiny-decider"], listed: true });
    api.verifyBackendDecision.mockReset().mockResolvedValue({ ok: true, answeredBy: "kev", latencyMs: 240 });
    api.verifyTypeSafeDecision.mockReset().mockResolvedValue({ ok: true, latencyMs: 300 });
    api.getDecisionCalibration.mockReset().mockResolvedValue({ state: "idle", done: 0, total: 0, failed: 0 });
    api.startDecisionCalibration.mockReset().mockResolvedValue({ state: "running", assignment: "ollaya/kev", done: 0, total: 300, failed: 0 });
    api.cancelDecisionCalibration.mockReset().mockResolvedValue({ state: "cancelled", assignment: "ollaya/kev", done: 40, total: 300, failed: 0 });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  describe("Decision model picker", () => {
    it("lists backends with decisions, then those whose provider offers them, then TypeSafe and Add a provider", async () => {
      current = overviewWith({ backends: { ollaya: ollayaWith(), fireworks: FIREWORKS, vllm: VLLM, groq: { ...VLLM, preset: "groq", url: "https://api.example.net/openai" } } });
      await openPicker();
      const groups = [...host.querySelectorAll(".decision-provider-group")];
      expect(groups.map((g) => g.querySelector(".decision-provider-heading").textContent.trim())).toEqual(["Your backends", "Other providers"]);
      expect(cardTitles(groups[0])).toEqual(["Ollaya", "Fireworks AI"]);
      expect(card("Ollaya").textContent).toContain("On this host");
      expect(card("Fireworks AI").textContent).toContain("Uses your existing key");
      expect(cardTitles(groups[1])).toEqual(["TypeSafe", "Add a provider"]);
    });

    it("opens TypeSafe's own pane", async () => {
      await openPicker();
      await click(card("TypeSafe"));
      expect(host.querySelector("input[aria-label='TypeSafe model id']")).toBeTruthy();
      expect(host.querySelector(".decision-form")).toBeNull();
    });

    it("adds decisions to a backend that has a key already: one write, no key", async () => {
      current = overviewWith({ backends: { fireworks: FIREWORKS }, allowRemoteInference: true });
      api.patchAdminConfig.mockImplementation(async () => {
        current = overviewWith({
          backends: { fireworks: { ...FIREWORKS, decision: FIREWORKS_DECISION } },
          allowRemoteInference: true,
          assignment: { role: "decision", kind: "decision", backendKey: "fireworks", preset: "fireworks", model: "accounts/example/models/rune", calibrated: false, available: true },
        });
        return { ok: true };
      });
      api.verifyBackendDecision.mockResolvedValue({ ok: true, latencyMs: 410 });
      await openPicker();
      await click(card("Fireworks AI"));
      expect(host.querySelector(".decision-form .decision-form-sub").textContent).toBe("Uses your existing key");
      expect(host.querySelector("input[aria-label='API key']")).toBeNull();
      expect(button("Verify")).toBeFalsy();
      expect(host.textContent).toContain("32k context · $0.10/M input tokens");
      expect(button("Save and use").disabled).toBe(true);
      await pickOption("rune");
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          backends: { fireworks: { decision: { url: "https://api.example.org/inference/v1/systemone", protocol: "systemone", auth: "bearer" } } },
          assignments: { decision: "fireworks/accounts/example/models/rune" },
        },
      });
      await flush();
      expect(api.verifyBackendDecision).toHaveBeenCalledWith("fireworks", "accounts/example/models/rune");
      expect(host.querySelector(".decision-form .decision-check--ok")?.textContent).toContain("Answered in 410 ms.");
      expect(button("Done")).toBeTruthy();
    });

    it("asks cloud consent naming the provider before enabling its decisions", async () => {
      current = overviewWith({ backends: { fireworks: FIREWORKS } });
      await openPicker();
      await click(card("Fireworks AI"));
      await pickOption("rune");
      await submit();
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Enable cloud inference?");
      expect(host.textContent).toContain("Fireworks AI");
      await clickText("Enable cloud inference");
      expect(api.patchAdminConfig.mock.calls[0][0].inference.allowRemoteInference).toBe(true);
      expect(api.patchAdminConfig.mock.calls[0][0].inference.backends.fireworks).not.toHaveProperty("apiKey");
    });

    it("uses a backend with decisions: lists its server's models and writes only the assignment", async () => {
      current = overviewWith({ backends: { ollaya: ollayaWith() } });
      await openPicker();
      await click(card("Ollaya"));
      expect(api.probeBackendDecisionModels).toHaveBeenCalledWith("ollaya");
      expect(host.querySelector("input[aria-label='API key']")).toBeNull();
      const winnow = [...host.querySelectorAll(".decision-model-opt")].find((n) => n.textContent.includes("winnow"));
      expect(winnow.textContent).toContain("On server");
      await click(winnow);
      expect(button("Use")).toBeTruthy();
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "ollaya/winnow" } } });
      expect(api.verifyBackendDecision).toHaveBeenCalledWith("ollaya", "winnow");
    });

    it("writes nothing when the model is unchanged, and only checks it again", async () => {
      current = overviewWith(onOllaya());
      await openPicker();
      await click(card("Ollaya"));
      expect(modelInput().value).toBe("kev");
      await submit();
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(api.verifyBackendDecision).toHaveBeenCalledWith("ollaya", "kev");
    });

    it("verifies a backend's model without saving", async () => {
      current = overviewWith({ backends: { ollaya: ollayaWith() } });
      await openPicker();
      await click(card("Ollaya"));
      await type("Model id", "laya");
      await clickText("Verify");
      expect(api.verifyBackendDecision).toHaveBeenCalledExactlyOnceWith("ollaya", "laya");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(host.querySelector(".decision-form .decision-check--ok")).toBeTruthy();
    });

    it("shows the reason a test decision failed, verbatim", async () => {
      current = overviewWith({ backends: { ollaya: ollayaWith() } });
      api.verifyBackendDecision.mockResolvedValue({ ok: false, status: 404, reason: 'The server has no model "kev", or the URL is not its decision endpoint (HTTP 404).' });
      await openPicker();
      await click(card("Ollaya"));
      await type("Model id", "kev");
      await submit();
      expect(host.querySelector(".decision-form .decision-check--fail")?.textContent).toContain('The server has no model "kev"');
    });
  });

  describe("Add a provider", () => {
    it("offers only the providers with decisions, and Other server", async () => {
      await openPicker();
      await click(card("Add a provider"));
      const titles = cardTitles(host);
      expect(titles).toEqual(["Ollaya", "Other server", "OpenAI", "Fireworks AI", "Edgeworks AI", "Fastino"]);
      expect(card("Fastino").textContent).toContain("1 model");
    });

    it("sets up both APIs of a provider that has both, with one key", async () => {
      current = overviewWith({ allowRemoteInference: true });
      await addProvider("OpenAI");
      expect(host.querySelector("input[aria-label='Base URL']")).toBeNull();
      expect(host.querySelector(".decision-field-label a")?.getAttribute("href")).toBe("https://platform.example.com/keys");
      expect(host.textContent).toContain("Sets up its chat and decision models with one key.");
      await type("API key", "example-key");
      await pickOption("luna-decide");
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          backends: {
            openai: {
              type: "http", preset: "openai", url: "https://api.example.com", apiKey: "example-key",
              decision: { url: "https://api.example.com/v1/decisions", protocol: "openai-decisions", auth: "bearer" },
            },
          },
          assignments: { decision: "openai/luna-decide" },
        },
      });
      await flush();
      // The chat side is probed for its models; the decision side is checked.
      expect(api.probeBackend).toHaveBeenCalledWith("openai");
      expect(api.verifyBackendDecision).toHaveBeenCalledWith("openai", "luna-decide");
    });

    it("sets up a provider that serves only decisions, with its key header and score field", async () => {
      current = overviewWith({ allowRemoteInference: true });
      await addProvider("Fastino");
      expect(button("Save and use").disabled).toBe(true);
      await pickOption("fastino/glide");
      expect(button("Save and use").disabled).toBe(true);
      await type("API key", "example-key");
      expect(button("Save and use").disabled).toBe(false);
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          backends: {
            fastino: {
              type: "http", preset: "fastino", apiKey: "example-key",
              decision: { url: "https://api.example.io/v1/systemone", protocol: "systemone", auth: "x-api-key", scoreField: "expected_level" },
            },
          },
          assignments: { decision: "fastino/fastino/glide" },
        },
      });
      expect(api.probeBackend).not.toHaveBeenCalledWith("fastino");
    });

    it("asks for an account to fill the URL, and folds the cloud consent into the write", async () => {
      await addProvider("Edgeworks AI");
      expect(host.querySelector("input[aria-label='Decision URL']")).toBeNull();
      expect(host.textContent).toContain("25k context · $0.04/M input tokens");
      await pickOption("clef-flash");
      await type("API key", "example-key");
      expect(button("Save and use").disabled).toBe(true);
      expect(host.querySelector(".field-error")).toBeNull();
      await type("Account ID", "abc");
      await type("Account ID", "  ");
      expect(host.querySelector(".field-error")?.textContent).toBe("Enter your account id.");
      await type("Account ID", "abc123");
      expect(button("Save and use").disabled).toBe(false);
      await submit();
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Enable cloud inference?");
      expect(host.textContent).toContain("Edgeworks AI");
      await clickText("Enable cloud inference");
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          allowRemoteInference: true,
          backends: {
            cloudflare: {
              type: "http", preset: "cloudflare", apiKey: "example-key",
              decision: { url: "https://api.example.com/client/v4/accounts/abc123/ai/run", protocol: "workers-ai", auth: "bearer" },
            },
          },
          assignments: { decision: "cloudflare/@cf/example/clef-flash" },
        },
      });
    });

    it("saves nothing when the cloud consent is declined", async () => {
      await addProvider("Edgeworks AI");
      await type("Account ID", "abc123");
      await type("API key", "example-key");
      await type("Model id", "@cf/example/clef-flash");
      await submit();
      await clickText("Cancel");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(button("Save and use")).toBeTruthy();
    });

    it("saves a local server, lists its models, and shows the test decision's answer", async () => {
      api.patchAdminConfig.mockImplementation(async () => { current = overviewWith(onOllaya()); return { ok: true }; });
      await addProvider("Ollaya");
      expect(host.querySelector(".decision-form code")?.textContent).toBe("ollaya pull <model>");
      expect(host.querySelector("input[aria-label='Backend name']").value).toBe("ollaya");
      expect(host.querySelector("input[aria-label='Decision URL']").value).toBe("http://127.0.0.1:11435/v1/systemone");
      await waitForTypingPause();
      expect(api.probeDecisionEndpoint).toHaveBeenCalledWith(expect.objectContaining({ url: "http://127.0.0.1:11435/v1/systemone", preset: "ollaya" }));
      await pickOption("tiny-decider");
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          backends: { ollaya: { type: "http", preset: "ollaya", decision: { url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", auth: "bearer" } } },
          assignments: { decision: "ollaya/tiny-decider" },
        },
      });
      await flush();
      expect(api.probeBackendDecisionModels).toHaveBeenCalledWith("ollaya");
      // The server answered under another name: the line says which.
      expect(host.querySelector(".decision-form .decision-check--ok")?.textContent).toContain("Answered by kev in 240 ms.");
      expect(button("Done")).toBeTruthy();
    });

    it("lists an Other server's models before it is saved, once typing pauses", async () => {
      await addProvider("Other server");
      expect(host.querySelector("input[aria-label='Base URL']")).toBeNull();
      await type("Decision URL", "http://127.0.0.1:18990/v1/systemone");
      await type("API key", "local-secret");
      expect(api.probeDecisionEndpoint).not.toHaveBeenCalled();
      await waitForTypingPause();
      expect(api.probeDecisionEndpoint).toHaveBeenCalledExactlyOnceWith({
        url: "http://127.0.0.1:18990/v1/systemone", apiKey: "local-secret", auth: undefined, protocol: undefined, preset: undefined,
      });
      expect([...host.querySelectorAll(".decision-model-opt")].find((n) => n.textContent.includes("tiny-decider")).textContent).toContain("On server");
    });

    it("never asks a hosted provider for its models", async () => {
      await addProvider("Edgeworks AI");
      await type("Account ID", "abc123");
      await waitForTypingPause();
      expect(api.probeDecisionEndpoint).not.toHaveBeenCalled();
    });

    it("keeps the form open with the gateway's refusal when the write fails", async () => {
      api.patchAdminConfig.mockResolvedValue({ ok: false, body: { errors: [{ message: "decision.url: Invalid url" }] } });
      await addProvider("Ollaya");
      await type("Model id", "kev");
      await submit();
      expect(host.querySelector(".decision-form .modal-error")?.textContent).toBe("decision.url: Invalid url");
      expect(api.verifyBackendDecision).not.toHaveBeenCalled();
      expect(button("Save and use")).toBeTruthy();
    });

    it("refuses a reserved or taken backend name", async () => {
      current = overviewWith({ backends: { vllm: VLLM } });
      await addProvider("Ollaya");
      await type("Model id", "kev");
      await type("Backend name", "typesafe");
      expect(host.querySelector(".field-error")?.textContent).toBe('"typesafe" is reserved.');
      expect(button("Save and use").disabled).toBe(true);
      await type("Backend name", "vllm");
      expect(host.querySelector(".field-error")?.textContent).toBe('"vllm" is already a backend.');
    });
  });

  describe("Decision model card", () => {
    it("brands the assigned backend and verifies it on request", async () => {
      current = overviewWith(onOllaya());
      await mount();
      expect(host.querySelector(".cap-detail-active-provider").textContent).toBe("Ollaya · On this host");
      await clickText("Verify");
      expect(api.verifyBackendDecision).toHaveBeenCalledWith("ollaya", "kev");
      expect(host.querySelector(".decision-active-status .decision-check--ok")?.textContent).toContain("Answered in 240 ms.");
    });

    it("verifies TypeSafe through its own route", async () => {
      current = overviewWith({
        assignment: { role: "decision", kind: "typesafe", model: "jev-1.14.0", hasApiKey: true, allowRemoteInference: true, available: true },
        display: { providerId: "typesafe", providerLabel: "TypeSafe", modelName: "jev-1.14.0", available: true, configured: true },
      });
      await mount();
      await clickText("Verify");
      expect(api.verifyTypeSafeDecision).toHaveBeenCalledWith("jev-1.14.0");
      expect(host.querySelector(".decision-calibration")).toBeNull();
    });

    it("warns that an uncalibrated model reads Jev's thresholds, and starts calibrating", async () => {
      current = overviewWith(onOllaya());
      await mount();
      expect(host.querySelector(".decision-calibration-warn").textContent).toBe("Thresholds were tuned on TypeSafe's Jev. Calibrate this model so they mean the same thing.");
      expect(host.textContent).toContain("Sends about 300 invented emails, no personal data");
      await clickText("Calibrate");
      expect(api.startDecisionCalibration).toHaveBeenCalledOnce();
      expect(host.querySelector(".decision-calibration--running .decision-calibration-meta").textContent).toBe("0 of 300 reference emails");
    });

    it("shows a running calibration on arrival, polls it, and reloads the models when it ends", async () => {
      current = overviewWith(onOllaya());
      api.getDecisionCalibration.mockResolvedValueOnce({ state: "running", assignment: "ollaya/kev", done: 120, total: 300, failed: 2 });
      await mount();
      expect(host.querySelector(".decision-calibration-meta").textContent).toBe("120 of 300 reference emails · 2 failed");
      expect(host.querySelector("[role='progressbar']").getAttribute("aria-valuenow")).toBe("120");
      const loads = api.getModelsOverview.mock.calls.length;
      const calibration = {
        points: [[0, 0], [1, 1]], reference: "jev-worth/v1/jev", fittedAt: "2026-03-04T10:00:00Z", samples: 300,
        agreement: 0.91, agreementBefore: 0.78, keeps: 0.95, skips: 0.87, keepsBefore: 0.61, skipsBefore: 0.98,
      };
      api.getDecisionCalibration.mockResolvedValue({ state: "done", assignment: "ollaya/kev", done: 300, total: 300, failed: 0, result: calibration });
      current = overviewWith({ ...onOllaya({ calibrated: true }), backends: { ollaya: ollayaWith({ kev: calibration }) } });
      // The status poll runs every 2 s while a calibration runs.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
      await flush();
      await flush();
      expect(api.getModelsOverview.mock.calls.length).toBeGreaterThan(loads);
      expect(host.querySelector(".decision-calibration--calibrated .decision-calibration-text").textContent).toMatch(/keeps 95% of the reference emails Jev keeps and skips 87% of those it skips \(before: 61% and 98%\)\.$/);
      expect(button("Recalibrate")).toBeTruthy();
    });

    it("shows a run for another model instead of nothing, and leaves the progress bar indeterminate before its size is known", async () => {
      current = overviewWith(onOllaya());
      api.getDecisionCalibration.mockResolvedValue({ state: "running", assignment: "other/laya", done: 12, total: 300, failed: 0 });
      await mount();
      expect(host.querySelector(".decision-calibration--other-running").textContent).toContain("A calibration of other/laya is running: 12 of 300 reference emails.");
      expect(button("Calibrate")).toBeFalsy();
      render(null, host);
      api.getDecisionCalibration.mockResolvedValue({ state: "running", assignment: "ollaya/kev", done: 0, total: 0, failed: 0 });
      await mount();
      const bar = host.querySelector("[role='progressbar']");
      expect(bar.hasAttribute("aria-valuemax")).toBe(false);
      expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    });

    it("picks up a run started elsewhere while the card is open", async () => {
      current = overviewWith(onOllaya());
      // Nothing runs, so the panel looks again only every 10 s.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        await mount();
        expect(host.querySelector(".decision-calibration--uncalibrated")).toBeTruthy();
        api.getDecisionCalibration.mockResolvedValue({ state: "running", assignment: "ollaya/kev", done: 5, total: 300, failed: 0 });
        await act(async () => { vi.advanceTimersByTime(9_000); });
        await flush();
        expect(host.querySelector(".decision-calibration--running")).toBeNull();
        await act(async () => { vi.advanceTimersByTime(1_000); });
        await flush();
      } finally {
        vi.useRealTimers();
      }
      expect(host.querySelector(".decision-calibration--running .decision-calibration-meta").textContent).toBe("5 of 300 reference emails");
    });

    it("shows a finished run's result even before the overview reloads", async () => {
      current = overviewWith(onOllaya());
      const result = { points: [[0, 0], [1, 1]], reference: "jev-worth/v1/jev", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, skips: 0.9, keepsBefore: 0.5, skipsBefore: 0.99 };
      api.getDecisionCalibration.mockResolvedValue({ state: "done", assignment: "ollaya/kev", done: 300, total: 300, failed: 0, result });
      await mount();
      expect(host.querySelector(".decision-calibration--calibrated .decision-calibration-text").textContent)
        .toMatch(/keeps 95% of the reference emails Jev keeps and skips 90% of those it skips \(before: 50% and 99%\)\.$/);
    });

    it("keeps showing a stored calibration when a recalibration fails", async () => {
      const calibration = { points: [[0, 0], [1, 1]], reference: "r", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, skips: 0.8, keepsBefore: 0.6, skipsBefore: 0.9 };
      current = overviewWith({ ...onOllaya({ calibrated: true }), backends: { ollaya: ollayaWith({ kev: calibration }) } });
      api.getDecisionCalibration.mockResolvedValue({ state: "failed", assignment: "ollaya/kev", done: 300, total: 300, failed: 0, error: "the server stopped answering" });
      await mount();
      const panel = host.querySelector(".decision-calibration--calibrated");
      expect(panel.textContent).toContain("Recalibration failed; the earlier calibration still applies. the server stopped answering");
      expect(panel.textContent).toContain("keeps 95% of the reference emails Jev keeps");
      expect(button("Recalibrate")).toBeTruthy();
    });

    it("cancels a running calibration", async () => {
      current = overviewWith(onOllaya());
      api.getDecisionCalibration.mockResolvedValueOnce({ state: "running", assignment: "ollaya/kev", done: 40, total: 300, failed: 0 });
      api.getDecisionCalibration.mockResolvedValue({ state: "cancelled", assignment: "ollaya/kev", done: 40, total: 300, failed: 0 });
      await mount();
      await clickText("Cancel");
      expect(api.cancelDecisionCalibration).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("Calibration cancelled.");
      expect(button("Calibrate")).toBeTruthy();
    });

    it("shows why calibration cannot start", async () => {
      current = overviewWith(onOllaya());
      api.startDecisionCalibration.mockRejectedValue(Object.assign(new Error("POST → 400"), { status: 400, serverMessage: "the decision model is unavailable" }));
      await mount();
      await clickText("Calibrate");
      expect(host.querySelector(".decision-calibration .field-error").textContent).toBe("the decision model is unavailable");
    });

    it("shows a failed run and offers to try again", async () => {
      current = overviewWith(onOllaya());
      api.getDecisionCalibration.mockResolvedValue({ state: "failed", assignment: "ollaya/kev", done: 300, total: 300, failed: 290, error: "Only 10 of 300 reference emails were answered" });
      await mount();
      expect(host.textContent).toContain("Calibration failed. Only 10 of 300 reference emails were answered");
      expect(button("Try again")).toBeTruthy();
    });

    it("marks an uncalibrated decision backend on the capability grid", async () => {
      current = overviewWith(onOllaya());
      await mount(null);
      expect(host.querySelector(".cap-card-behavior")?.textContent).toBe("Not calibrated");
    });
  });


  describe("Backends page", () => {
    const row = (name) => [...host.querySelectorAll(".backend-item")].find((n) => n.querySelector(".backend-item-title")?.textContent.includes(name));
    const confirm = async (label) => {
      await click([...host.querySelectorAll(".confirm-modal button")].find((b) => b.textContent.trim() === label));
    };

    it("lists every backend once, saying what each serves", async () => {
      current = overviewWith({ ...onOllaya(), backends: { ollaya: ollayaWith(), fireworks: { ...FIREWORKS, decision: FIREWORKS_DECISION }, vllm: VLLM } });
      await mount("backends");
      expect([...host.querySelectorAll("h2")].map((n) => n.textContent)).not.toContain("Decision backends");
      expect(row("Fireworks AI").querySelector(".backend-serves").textContent).toBe("Chat & decision models");
      expect(row("Ollaya").querySelector(".backend-serves").textContent).toBe("Decision models");
      expect(row("vllm").querySelector(".backend-serves").textContent).toBe("Chat models");
      // A decision-only backend has no model list to test, and shows its decision endpoint.
      expect([...row("Ollaya").querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Change key", "Remove"]);
      expect(row("Ollaya").querySelector("code").textContent).toBe("http://127.0.0.1:11435/v1/systemone");
      expect(row("Ollaya").textContent).toContain("Decision model: kev · not calibrated");
      expect([...row("Fireworks AI").querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Test", "Change key", "Disable decisions", "Remove"]);
      expect(row("vllm").textContent).not.toContain("Disable decisions");
      // Only backends with an OpenAI-compatible API are probed for models.
      expect(api.probeBackend.mock.calls.map(([key]) => key).sort()).toEqual(["fireworks", "vllm"]);
    });

    it("shows a backend's calibrated decision models", async () => {
      const calibration = { points: [[0, 0], [1, 1]], reference: "r", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, skips: 0.8 };
      current = overviewWith({ backends: { ollaya: ollayaWith({ kev: calibration, laya: calibration }) } });
      await mount("backends");
      expect(row("Ollaya").textContent).toContain("2 calibrated decision models");
    });

    it("changes a backend's key in place, sending only the key", async () => {
      const calibration = { points: [[0, 0], [1, 1]], reference: "r", fittedAt: "2026-03-04T10:00:00Z", keeps: 0.95, skips: 0.8 };
      current = overviewWith({ backends: { fireworks: { ...FIREWORKS, decision: { ...FIREWORKS_DECISION, calibrations: { "accounts/example/models/rune": calibration } } }, vllm: VLLM } });
      await mount("backends");
      await click(host.querySelector("button[aria-label='Change key for fireworks']"));
      const save = () => [...row("Fireworks AI").querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
      expect(save().disabled).toBe(true);
      expect(row("Fireworks AI").textContent).not.toContain("Change key");
      await type("New API key for fireworks", " rotated-key ");
      await act(async () => { row("Fireworks AI").querySelector(".backend-key-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); });
      await flush();
      // Only the key: the URLs, decision API and calibrations are not in the write.
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { backends: { fireworks: { apiKey: "rotated-key" } } } });
      expect(host.querySelector(".backend-key-form")).toBeNull();
      expect(host.textContent).toContain('Changed the key for "fireworks".');
    });

    it("keeps the key form open with the gateway's refusal, and cancels without writing", async () => {
      api.patchAdminConfig.mockResolvedValue({ ok: false, body: { errors: [{ message: "apiKey: too long" }] } });
      current = overviewWith(onOllaya());
      await mount("backends");
      await click(host.querySelector("button[aria-label='Change key for ollaya']"));
      await type("New API key for ollaya", "local-secret");
      await act(async () => { host.querySelector(".backend-key-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); });
      await flush();
      expect(host.querySelector(".backend-key-form .field-error")?.textContent).toBe("apiKey: too long");
      api.patchAdminConfig.mockClear();
      await clickText("Cancel");
      expect(host.querySelector(".backend-key-form")).toBeNull();
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
    });

    it("disables a backend's decisions, keeping its chat side, and turns off the Decision model it served", async () => {
      current = overviewWith({
        backends: { fireworks: { ...FIREWORKS, decision: FIREWORKS_DECISION } },
        assignment: { role: "decision", kind: "decision", backendKey: "fireworks", preset: "fireworks", model: "accounts/example/models/rune", calibrated: false, available: true },
      });
      await mount("backends");
      await click(host.querySelector("button[aria-label='Disable decisions on fireworks']"));
      expect(host.textContent).toContain("model uses it and will be turned off. Its chat models stay");
      await confirm("Disable decisions");
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: { backends: { fireworks: { decision: null } }, assignments: { decision: null } },
      });
    });

    it("removes a backend that serves only decisions whole", async () => {
      current = overviewWith(onOllaya());
      await mount("backends");
      await click(host.querySelector("button[aria-label='Remove backend ollaya']"));
      expect(host.textContent).toContain("Its decision calibrations are removed too.");
      await confirm("Remove");
      expect(api.removeHttpBackend).toHaveBeenCalledExactlyOnceWith("ollaya");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
    });

    it("adds any provider from one picker, whatever it serves", async () => {
      current = overviewWith({ backends: { fireworks: FIREWORKS }, allowRemoteInference: true });
      await mount("backends");
      await clickText("+ Add backend");
      expect(cards().map((n) => n.querySelector(".backend-opt-title").textContent)).not.toContain("TypeSafe");
      expect(card("Fastino").textContent).toContain("Decision models");
      expect(card("OpenAI").textContent).toContain("Chat & decision models");
      expect(card("Groq").textContent).toContain("Chat models");
      expect(card("Fireworks AI").textContent).toContain("Configured");
      await click(card("Fastino"));
      expect(modelInput()).toBeNull();
      await type("API key", "example-key");
      await act(async () => { host.querySelector(".backend-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); });
      await flush();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          backends: {
            fastino: {
              type: "http", preset: "fastino", apiKey: "example-key",
              decision: { url: "https://api.example.io/v1/systemone", protocol: "systemone", auth: "x-api-key", scoreField: "expected_level" },
            },
          },
        },
      });
      expect(host.querySelector(".backend-form")).toBeNull();
      expect(host.textContent).toContain('Added backend "fastino".');
    });

    it("asks both URLs of an Other server, and needs one of them", async () => {
      await mount("backends");
      await clickText("+ Add backend");
      await click(card("Other server"));
      await type("Backend name", "lab");
      expect(button("Add backend").disabled).toBe(true);
      await type("Decision URL", "http://127.0.0.1:18990/v1/systemone");
      expect(button("Add backend").disabled).toBe(false);
      await type("Base URL", "http://127.0.0.1:8000");
      await act(async () => { host.querySelector(".backend-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); });
      await flush();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: { backends: { lab: { type: "http", url: "http://127.0.0.1:8000", decision: { url: "http://127.0.0.1:18990/v1/systemone" } } } },
      });
    });
  });
});
