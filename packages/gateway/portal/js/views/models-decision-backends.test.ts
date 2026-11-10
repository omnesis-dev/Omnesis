// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
//
// Settings → Models for the Decision model on a gateway that advertises
// decision presets: the provider picker, a provider's form (one config write,
// then a test decision whose answer shows inline), the calibration panel on
// the Decision model's card, and the decision backends on the Backends page.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn(),
  patchAdminConfig: vi.fn(), getRecentModels: vi.fn(), probeBackend: vi.fn(),
  getModelCredentialsStatus: vi.fn(), setModelProviderCredentials: vi.fn(),
  probeDecisionBackend: vi.fn(), probeDecisionEndpoint: vi.fn(), verifyDecisionBackend: vi.fn(), verifyTypeSafeDecision: vi.fn(),
  getDecisionCalibration: vi.fn(), startDecisionCalibration: vi.fn(), cancelDecisionCalibration: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));
import { ModelsView } from "./models.js";
import { CAPABILITY_METADATA } from "@omnesis/core";

const DECISION = CAPABILITY_METADATA.decision;

const PRESETS = [
  {
    id: "ollaya", name: "Ollaya", kind: "local", url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone",
    auth: "bearer", keyRequired: false, docsUrl: "https://docs.example.com/ollaya",
    note: "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
    models: [{ id: "kev", source: "preset" }, { id: "laya", source: "preset" }],
  },
  {
    id: "typesafe", name: "TypeSafe", kind: "cloud", url: "https://api.example.com/v1/systemone", protocol: "systemone",
    auth: "bearer", keyRequired: true, builtIn: "typesafe", docsUrl: "https://docs.example.com/typesafe", models: [{ id: "jev-1.14.0", source: "preset" }],
  },
  {
    id: "cloudflare", name: "Edgeworks AI", kind: "cloud", modelsDevId: "cloudflare-workers-ai",
    url: "https://api.example.com/client/v4/accounts/{account}/ai/run", protocol: "workers-ai", auth: "bearer", keyRequired: true,
    docsUrl: "https://docs.example.com/workers-ai", keyUrl: "https://dash.example.com/tokens",
    urlParams: [{ key: "account", label: "Account ID", placeholder: "0123456789abcdef" }],
    note: "Workers AI shortens long text to fit the model's context without saying so.",
    models: [{ id: "@cf/example/clef-flash", contextTokens: 25000, inputCostPerMillion: 0.04, source: "models.dev" }],
  },
];

const OLLAYA_BACKEND = { preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", auth: "bearer", onHost: true, hasApiKey: false, calibrations: {} };

function overviewWith({ assignment = { kind: "disabled", role: "decision" }, decisionBackends = {}, allowRemoteInference = false, display } = {}) {
  return {
    capabilities: [DECISION],
    catalog: [], installed: [], presets: [],
    decisionPresets: PRESETS,
    assignmentDisplays: display ? { decision: display } : {},
    inference: {
      allowRemoteInference,
      assignments: { decision: assignment },
      backends: {},
      decisionBackends,
      decisionChatModels: false,
    },
  };
}

const onOllaya = (extra = {}) => ({
  assignment: { role: "decision", kind: "decision", backendKey: "ollaya", preset: "ollaya", model: "kev", url: OLLAYA_BACKEND.url, protocol: "systemone", onHost: true, allowRemoteInference: false, hasApiKey: false, calibrated: false, available: true, ...extra },
  decisionBackends: { ollaya: OLLAYA_BACKEND },
  display: { providerId: "ollaya", providerLabel: "Ollaya", modelName: "kev", available: true, configured: true },
});

describe("Models — decision backends", () => {
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
  const card = (title) => [...host.querySelectorAll(".backend-opt")].find((n) => n.querySelector(".backend-opt-title")?.textContent === title);
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
    api.probeBackend.mockReset().mockResolvedValue({ ok: true });
    api.getModelCredentialsStatus.mockReset().mockResolvedValue({ items: [] });
    api.setModelProviderCredentials.mockReset().mockResolvedValue({ ok: true });
    api.probeDecisionBackend.mockReset().mockResolvedValue({ ok: true, models: ["kev", "winnow"], listed: true });
    api.probeDecisionEndpoint.mockReset().mockResolvedValue({ ok: true, models: ["kev", "tiny-decider"], listed: true });
    api.verifyDecisionBackend.mockReset().mockResolvedValue({ ok: true, answeredBy: "kev", latencyMs: 240 });
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

  describe("provider picker", () => {
    it("groups this machine (Other server last) before the cloud, TypeSafe first", async () => {
      await openPicker();
      const headings = [...host.querySelectorAll(".decision-provider-heading")].map((n) => n.textContent.trim());
      expect(headings).toEqual(["On this machine", "Cloud"]);
      const groups = [...host.querySelectorAll(".decision-provider-group")].map((g) => [...g.querySelectorAll(".backend-opt-title")].map((n) => n.textContent));
      expect(groups).toEqual([["Ollaya", "Other server"], ["TypeSafe", "Edgeworks AI"]]);
    });

    it("lists configured decision backends first for reuse", async () => {
      current = overviewWith({ decisionBackends: { ollaya: OLLAYA_BACKEND } });
      await openPicker();
      expect(host.querySelector(".decision-provider-heading").textContent).toBe("Your decision backends");
      expect(card("ollaya").textContent).toContain("On this host");
    });

    it("opens TypeSafe's own pane rather than a decision backend form", async () => {
      await openPicker();
      await click(card("TypeSafe"));
      expect(host.querySelector("input[aria-label='TypeSafe model id']")).toBeTruthy();
      expect(host.querySelector(".decision-form")).toBeNull();
    });
  });

  describe("provider form", () => {
    it("saves a local server and assigns its model in one write, then shows the test decision's answer", async () => {
      api.patchAdminConfig.mockImplementation(async () => {
        current = overviewWith(onOllaya());
        return { ok: true };
      });
      await openPicker();
      await click(card("Ollaya"));
      expect(host.textContent).toContain("Pull a model with");
      expect(host.querySelector(".decision-form code")?.textContent).toBe("ollaya pull <model>");
      expect(host.querySelector("input[aria-label='Backend name']").value).toBe("ollaya");
      expect(host.querySelector("input[aria-label='URL']").value).toBe("http://127.0.0.1:11435/v1/systemone");
      expect(button("Save and use").disabled).toBe(true);
      const kev = [...host.querySelectorAll(".decision-model-opt")].find((n) => n.textContent.includes("kev"));
      await click(kev);
      expect(modelInput().value).toBe("kev");
      expect(kev.getAttribute("role")).toBe("option");
      expect(kev.getAttribute("aria-selected")).toBe("true");
      expect(host.querySelector(".decision-model-list").getAttribute("role")).toBe("listbox");
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          decisionBackends: { ollaya: { preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone", protocol: "systemone", auth: "bearer" } },
          assignments: { decision: "ollaya/kev" },
        },
      });
      await flush();
      expect(api.verifyDecisionBackend).toHaveBeenCalledWith("ollaya", "kev");
      expect(api.probeDecisionBackend).toHaveBeenCalledWith("ollaya");
      expect(host.querySelector(".modal .decision-check--ok, .decision-form .decision-check--ok")?.textContent).toContain("Answered in 240 ms.");
      expect(button("Done")).toBeTruthy();
      expect([...host.querySelectorAll(".decision-model-opt")].map((n) => n.textContent)).toEqual(
        expect.arrayContaining([expect.stringContaining("winnow")]),
      );
    });

    it("shows the reason a test decision failed, verbatim", async () => {
      api.verifyDecisionBackend.mockResolvedValue({ ok: false, status: 404, reason: 'The server has no model "kev", or the URL is not its decision endpoint (HTTP 404).' });
      api.patchAdminConfig.mockImplementation(async () => { current = overviewWith(onOllaya()); return { ok: true }; });
      await openPicker();
      await click(card("Ollaya"));
      await type("Model id", "kev");
      await submit();
      await flush();
      expect(host.querySelector(".decision-form .decision-check--fail")?.textContent).toContain('The server has no model "kev"');
    });

    it("keeps the form open with the gateway's refusal when the write fails", async () => {
      api.patchAdminConfig.mockResolvedValue({ ok: false, body: { errors: [{ message: "url: Invalid url" }] } });
      await openPicker();
      await click(card("Ollaya"));
      await type("Model id", "kev");
      await submit();
      expect(host.querySelector(".decision-form .modal-error")?.textContent).toBe("url: Invalid url");
      expect(api.verifyDecisionBackend).not.toHaveBeenCalled();
      expect(button("Save and use")).toBeTruthy();
    });

    it("refuses a reserved backend name", async () => {
      await openPicker();
      await click(card("Ollaya"));
      await type("Model id", "kev");
      await type("Backend name", "typesafe");
      expect(host.querySelector(".field-error")?.textContent).toBe('"typesafe" is reserved.');
      expect(button("Save and use").disabled).toBe(true);
    });

    it("asks for the account and key of a hosted provider, fills its URL, and folds the cloud consent into the write", async () => {
      await openPicker();
      await click(card("Edgeworks AI"));
      expect(host.querySelector("input[aria-label='URL']")).toBeNull();
      expect(host.querySelector(".decision-field-label a")?.getAttribute("href")).toBe("https://dash.example.com/tokens");
      expect(host.textContent).toContain("25k context · $0.04/M input tokens");
      await click(host.querySelector(".decision-model-opt"));
      expect(button("Save and use").disabled).toBe(true);
      await type("Account ID", "abc123");
      expect(button("Save and use").disabled).toBe(true);
      await type("API key", "example-key");
      expect(button("Save and use").disabled).toBe(false);
      await submit();
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Enable cloud inference?");
      expect(host.textContent).toContain("Edgeworks AI");
      await clickText("Enable cloud inference");
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: {
          allowRemoteInference: true,
          decisionBackends: {
            cloudflare: {
              preset: "cloudflare", url: "https://api.example.com/client/v4/accounts/abc123/ai/run",
              protocol: "workers-ai", auth: "bearer", apiKey: "example-key",
            },
          },
          assignments: { decision: "cloudflare/@cf/example/clef-flash" },
        },
      });
    });

    it("saves nothing when the cloud consent is declined", async () => {
      await openPicker();
      await click(card("Edgeworks AI"));
      await type("Account ID", "abc123");
      await type("API key", "example-key");
      await type("Model id", "@cf/example/clef-flash");
      await submit();
      await clickText("Cancel");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(button("Save and use")).toBeTruthy();
    });

    it("reuses a configured backend: lists its server's models and keeps its key", async () => {
      current = overviewWith({ decisionBackends: { ollaya: { ...OLLAYA_BACKEND, hasApiKey: true } }, allowRemoteInference: false });
      await openPicker();
      await click(card("ollaya"));
      expect(api.probeDecisionBackend).toHaveBeenCalledWith("ollaya");
      expect(host.querySelector("input[aria-label='Backend name']")).toBeNull();
      expect(host.querySelector("input[aria-label='API key']").getAttribute("placeholder")).toBe("Saved · leave blank to keep it");
      const winnow = [...host.querySelectorAll(".decision-model-opt")].find((n) => n.textContent.includes("winnow"));
      expect(winnow.textContent).toContain("On server");
      await click(winnow);
      await submit();
      // The backend itself is unchanged, so only the assignment is written.
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "ollaya/winnow" } } });
    });

    it("writes nothing when the backend and model are unchanged, and only checks the model again", async () => {
      current = overviewWith(onOllaya());
      await openPicker();
      await click(card("ollaya"));
      expect(modelInput().value).toBe("kev");
      await submit();
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(api.verifyDecisionBackend).toHaveBeenCalledWith("ollaya", "kev");
    });

    it("lists a new local server's models before it is saved, once typing pauses", async () => {
      await openPicker();
      await click(card("Other server"));
      await type("URL", "http://127.0.0.1:18990/v1/systemone");
      await type("API key", "local-secret");
      expect(api.probeDecisionEndpoint).not.toHaveBeenCalled();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
      await flush();
      expect(api.probeDecisionEndpoint).toHaveBeenCalledExactlyOnceWith({
        url: "http://127.0.0.1:18990/v1/systemone", auth: "bearer", apiKey: "local-secret", protocol: "systemone", preset: undefined,
      });
      const tiny = [...host.querySelectorAll(".decision-model-opt")].find((n) => n.textContent.includes("tiny-decider"));
      expect(tiny.textContent).toContain("On server");
    });

    it("asks a new preset server with its preset, and stays quiet on a gateway without the unsaved-server probe", async () => {
      api.probeDecisionEndpoint.mockRejectedValue(Object.assign(new Error("POST → 404"), { status: 404 }));
      await openPicker();
      await click(card("Ollaya"));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
      await flush();
      expect(api.probeDecisionEndpoint).toHaveBeenCalledWith(expect.objectContaining({ url: "http://127.0.0.1:11435/v1/systemone", preset: "ollaya" }));
      expect(host.textContent).not.toContain("Could not list");
      expect([...host.querySelectorAll(".decision-model-opt")].map((n) => n.textContent)).toEqual(["kev", "laya"]);
    });

    it("never asks a hosted provider for its models", async () => {
      await openPicker();
      await click(card("Edgeworks AI"));
      await type("Account ID", "abc123");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
      expect(api.probeDecisionEndpoint).not.toHaveBeenCalled();
    });

    it("says which URL value is missing once a value was touched", async () => {
      await openPicker();
      await click(card("Edgeworks AI"));
      expect(host.querySelector(".field-error")).toBeNull();
      await type("Account ID", "abc");
      await type("Account ID", "  ");
      expect(host.querySelector(".field-error")?.textContent).toBe("Enter your account id.");
    });

    it("verifies a configured backend's model without saving", async () => {
      current = overviewWith({ decisionBackends: { ollaya: OLLAYA_BACKEND } });
      await openPicker();
      await click(card("ollaya"));
      await type("Model id", "laya");
      await clickText("Verify");
      expect(api.verifyDecisionBackend).toHaveBeenCalledExactlyOnceWith("ollaya", "laya");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      expect(host.querySelector(".decision-form .decision-check--ok")).toBeTruthy();
    });
  });

  describe("Decision model card", () => {
    it("brands the assigned backend and verifies it on request", async () => {
      current = overviewWith(onOllaya());
      await mount();
      expect(host.querySelector(".cap-detail-active-provider").textContent).toBe("Ollaya · On this host");
      await clickText("Verify");
      expect(api.verifyDecisionBackend).toHaveBeenCalledWith("ollaya", "kev");
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
      const calibration = { points: [[0, 0], [1, 1]], reference: "jev-worth/v1/jev", fittedAt: "2026-03-04T10:00:00Z", samples: 300, agreement: 0.91, agreementBefore: 0.78 };
      api.getDecisionCalibration.mockResolvedValue({ state: "done", assignment: "ollaya/kev", done: 300, total: 300, failed: 0, result: calibration });
      current = overviewWith({ ...onOllaya({ calibrated: true }), decisionBackends: { ollaya: { ...OLLAYA_BACKEND, calibrations: { kev: calibration } } } });
      // The status poll runs every 2 s while a calibration runs.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
      await flush();
      await flush();
      expect(api.getModelsOverview.mock.calls.length).toBeGreaterThan(loads);
      expect(host.querySelector(".decision-calibration--calibrated .decision-calibration-text").textContent).toMatch(/agrees with Jev on 91% of the reference emails \(was 78%\)\.$/);
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
    it("lists decision backends and removes one, turning off the Decision model it served", async () => {
      current = overviewWith(onOllaya());
      await mount("backends");
      const section = host.querySelector(".decision-backends-section");
      expect(section.textContent).toContain("Ollaya");
      expect(section.textContent).toContain("Decision model: kev");
      await click(section.querySelector("button[aria-label='Remove decision backend ollaya']"));
      expect(host.textContent).toContain("model uses it and will be turned off.");
      await click([...host.querySelectorAll(".confirm-modal button")].find((b) => b.textContent.trim() === "Remove"));
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { decisionBackends: { ollaya: null }, assignments: { decision: null } } });
    });

    it("edits a backend's URL without touching the assignment", async () => {
      current = overviewWith(onOllaya());
      await mount("backends");
      await click(host.querySelector("button[aria-label='Edit decision backend ollaya']"));
      expect(modelInput()).toBeNull();
      await type("URL", "http://127.0.0.1:11500/v1/systemone");
      await submit();
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: { decisionBackends: { ollaya: { url: "http://127.0.0.1:11500/v1/systemone" } } },
      });
      expect(host.querySelector(".decision-form")).toBeNull();
    });

    it("keeps a custom backend's protocol and auth when its key is replaced", async () => {
      current = overviewWith({
        allowRemoteInference: false,
        decisionBackends: {
          lab: { url: "https://decide.example.org/v1/decisions", protocol: "openai-decisions", auth: "api-key", onHost: false, hasApiKey: true, calibrations: {} },
        },
      });
      await mount("backends");
      await click(host.querySelector("button[aria-label='Edit decision backend lab']"));
      await type("API key", "replacement-key");
      await submit();
      // Not the Decision model's backend: saving sends nothing off-host, so no consent is asked.
      expect(host.textContent).not.toContain("Enable cloud inference?");
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { decisionBackends: { lab: { apiKey: "replacement-key" } } } });
    });

    it("asks consent when moving the Decision model's own backend off this host", async () => {
      current = overviewWith(onOllaya());
      await mount("backends");
      await click(host.querySelector("button[aria-label='Edit decision backend ollaya']"));
      await type("URL", "https://decide.example.org/v1/systemone");
      await submit();
      expect(host.textContent).toContain("Enable cloud inference?");
      expect(api.patchAdminConfig).not.toHaveBeenCalled();
      await clickText("Enable cloud inference");
      expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
        inference: { allowRemoteInference: true, decisionBackends: { ollaya: { url: "https://decide.example.org/v1/systemone" } } },
      });
    });
  });
});
