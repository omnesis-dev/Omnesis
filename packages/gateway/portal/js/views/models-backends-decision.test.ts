// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
//
// Settings → Models with backends that serve chat models, decision models or
// both: the Decision model's picker (backends with decisions, backends whose
// provider offers them with the key they have, TypeSafe, "Add a provider"),
// the shared add form for each kind of provider, the Decision model's card,
// and the one Backends list.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn(),
  patchAdminConfig: vi.fn(), getRecentModels: vi.fn(), probeBackend: vi.fn(), removeHttpBackend: vi.fn(),
  getModelCredentialsStatus: vi.fn(), setModelProviderCredentials: vi.fn(),
  probeBackendDecisionModels: vi.fn(), probeDecisionEndpoint: vi.fn(), verifyBackendDecision: vi.fn(), verifyTypeSafeDecision: vi.fn(),
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
const FIREWORKS_DECISION = { url: "https://api.example.org/inference/v1/systemone", protocol: "systemone", auth: "bearer", onHost: false, hasApiKey: true };
const OLLAYA = {
  type: "http", status: "ok", preset: "ollaya",
  decision: { url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", auth: "bearer", onHost: true, hasApiKey: false },
};
const VLLM = { type: "http", status: "ok", url: "http://127.0.0.1:8000", models: ["example-chat"] };

function overviewWith({ assignment = { kind: "disabled", role: "decision" }, backends = {}, allowRemoteInference = false, display } = {}) {
  return {
    capabilities: [DECISION],
    catalog: [], installed: [],
    // The gateway serves providers with an OpenAI-compatible API in `presets`
    // and decision-only providers, TypeSafe among them, in `decisionProviders`.
    presets: PRESETS.filter((preset) => preset.defaultUrl),
    decisionProviders: PRESETS.filter((preset) => !preset.defaultUrl),
    assignmentDisplays: display ? { decision: display } : {},
    inference: {
      allowRemoteInference,
      assignments: { decision: assignment },
      backends,
      decisionChatModels: false,
    },
  };
}

const onOllaya = () => ({
  assignment: { role: "decision", kind: "decision", backendKey: "ollaya", preset: "ollaya", model: "kev", url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", onHost: true, allowRemoteInference: false, hasApiKey: false, available: true },
  backends: { ollaya: OLLAYA },
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
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  describe("Decision model picker", () => {
    it("lists backends with decisions, then those whose provider offers them, then TypeSafe and Add a provider", async () => {
      current = overviewWith({ backends: { ollaya: OLLAYA, fireworks: FIREWORKS, vllm: VLLM, groq: { ...VLLM, preset: "groq", url: "https://api.example.net/openai" } } });
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
          assignment: { role: "decision", kind: "decision", backendKey: "fireworks", preset: "fireworks", model: "accounts/example/models/rune", available: true },
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

    it("asks for a key when the backend has none and the provider needs one, and writes it beside the decision API", async () => {
      current = overviewWith({ backends: { fireworks: { ...FIREWORKS, hasApiKey: false } }, allowRemoteInference: true });
      await openPicker();
      expect(card("Fireworks AI").textContent).toContain("Needs a key");
      await click(card("Fireworks AI"));
      expect(host.querySelector(".decision-form .decision-form-sub").textContent).toBe("Needs a key");
      expect(host.textContent).toContain("It becomes this backend's key for its OpenAI-compatible and decision APIs.");
      await pickOption("rune");
      expect(button("Save and use").disabled).toBe(true);
      await type("API key", "example-key");
      expect(button("Save and use").disabled).toBe(false);
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          backends: {
            fireworks: { apiKey: "example-key", decision: { url: "https://api.example.org/inference/v1/systemone", protocol: "systemone", auth: "bearer" } },
          },
          assignments: { decision: "fireworks/accounts/example/models/rune" },
        },
      });
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
      current = overviewWith({ backends: { ollaya: OLLAYA } });
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
      current = overviewWith({ backends: { ollaya: OLLAYA } });
      await openPicker();
      await click(card("Ollaya"));
      await type("Model id", "laya");
      await clickText("Verify");
      expect(api.verifyBackendDecision).toHaveBeenCalledExactlyOnceWith("ollaya", "laya");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(host.querySelector(".decision-form .decision-check--ok")).toBeTruthy();
    });

    it("shows the reason a test decision failed, verbatim", async () => {
      current = overviewWith({ backends: { ollaya: OLLAYA } });
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

    it("leaves out providers that already have a backend, which the picker offers above", async () => {
      current = overviewWith({ backends: { fireworks: FIREWORKS, ollaya: OLLAYA, vllm: VLLM } });
      await openPicker();
      await click(card("Add a provider"));
      expect(cardTitles(host)).toEqual(["Other server", "OpenAI", "Edgeworks AI", "Fastino"]);
    });

    it("sets up both APIs of a provider that has both, with one key", async () => {
      current = overviewWith({ allowRemoteInference: true });
      await addProvider("OpenAI");
      expect(host.querySelector("input[aria-label='Base URL']")).toBeNull();
      expect(host.querySelector(".decision-field-label a")?.getAttribute("href")).toBe("https://platform.example.com/keys");
      expect(host.textContent).toContain("Sets up its OpenAI-compatible and decision APIs with one key.");
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
    });
  });

  describe("Backends page", () => {
    const row = (name) => [...host.querySelectorAll(".backend-item")].find((n) => n.querySelector(".backend-item-title")?.textContent.includes(name));
    const confirm = async (label) => {
      await click([...host.querySelectorAll(".confirm-modal button")].find((b) => b.textContent.trim() === label));
    };

    it("lists every backend once, saying what each serves", async () => {
      current = overviewWith({ ...onOllaya(), backends: { ollaya: OLLAYA, fireworks: { ...FIREWORKS, decision: FIREWORKS_DECISION }, vllm: VLLM } });
      await mount("backends");
      expect([...host.querySelectorAll("h2")].map((n) => n.textContent)).not.toContain("Decision backends");
      expect(row("Fireworks AI").querySelector(".backend-serves").textContent).toBe("OpenAI-compatible and decision models");
      expect(row("Ollaya").querySelector(".backend-serves").textContent).toBe("Decision models");
      expect(row("vllm").querySelector(".backend-serves").textContent).toBe("OpenAI-compatible models");
      // A decision-only backend is tested through its decision API, and shows its decision endpoint.
      expect([...row("Ollaya").querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Test", "Change key", "Remove"]);
      expect(row("Ollaya").querySelector("code").textContent).toBe("http://127.0.0.1:11435/v1/systemone");
      expect(row("Ollaya").textContent).toContain("Decision model: kev");
      expect([...row("Fireworks AI").querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Test", "Change key", "Disable decisions", "Remove"]);
      expect(row("vllm").textContent).not.toContain("Disable decisions");
      // Only backends with an OpenAI-compatible API are probed for models.
      expect(api.probeBackend.mock.calls.map(([key]) => key).sort()).toEqual(["fireworks", "vllm"]);
    });

    it("tests a decision-only backend with one decision to the Decision model it serves", async () => {
      current = overviewWith(onOllaya());
      await mount("backends");
      const test = () => [...row("Ollaya").querySelectorAll("button")].find((b) => /Test|Connected|Failed/.test(b.textContent));
      await click(test());
      expect(api.verifyBackendDecision).toHaveBeenCalledWith("ollaya", "kev");
      expect(api.probeBackend).not.toHaveBeenCalledWith("ollaya");
      expect(test().textContent.trim()).toBe("Connected ✓");
    });

    it("shows Failed when the Decision model's test decision fails", async () => {
      current = overviewWith(onOllaya());
      api.verifyBackendDecision.mockResolvedValue({ ok: false, failure: "unreachable", reason: "Could not reach the server" });
      await mount("backends");
      await click([...row("Ollaya").querySelectorAll("button")].find((b) => b.textContent.trim() === "Test"));
      expect([...row("Ollaya").querySelectorAll("button")].map((b) => b.textContent.trim())).toContain("Failed ✗");
    });

    it("tests an unassigned decision server on this host by listing its models", async () => {
      current = overviewWith({ backends: { ollaya: OLLAYA } });
      await mount("backends");
      await click([...row("Ollaya").querySelectorAll("button")].find((b) => b.textContent.trim() === "Test"));
      expect(api.probeBackendDecisionModels).toHaveBeenCalledWith("ollaya");
      expect(api.verifyBackendDecision).not.toHaveBeenCalled();
      expect([...row("Ollaya").querySelectorAll("button")].map((b) => b.textContent.trim())).toContain("Connected ✓");
    });

    it("offers no Test for a cloud decision API with no model assigned", async () => {
      current = overviewWith({ backends: { fireworks: { type: "http", status: "ok", preset: "fireworks", hasApiKey: true, decision: FIREWORKS_DECISION } } });
      await mount("backends");
      expect([...row("Fireworks AI").querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Change key", "Remove"]);
    });

    it("changes a backend's key in place, sending only the key", async () => {
      current = overviewWith({ backends: { fireworks: { ...FIREWORKS, decision: FIREWORKS_DECISION }, vllm: VLLM } });
      await mount("backends");
      await click(host.querySelector("button[aria-label='Change key for fireworks']"));
      const save = () => [...row("Fireworks AI").querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
      expect(save().disabled).toBe(true);
      expect(row("Fireworks AI").textContent).not.toContain("Change key");
      await type("New API key for fireworks", " rotated-key ");
      await act(async () => { row("Fireworks AI").querySelector(".backend-key-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); });
      await flush();
      // Only the key: the URLs and decision API are not in the write.
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
        assignment: { role: "decision", kind: "decision", backendKey: "fireworks", preset: "fireworks", model: "accounts/example/models/rune", available: true },
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
      expect(host.textContent).toContain("Any capability using this backend will become unavailable.");
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
      expect(card("OpenAI").textContent).toContain("OpenAI-compatible and decision models");
      expect(card("Groq").textContent).toContain("OpenAI-compatible models");
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
