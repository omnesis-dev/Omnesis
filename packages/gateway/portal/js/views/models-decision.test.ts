// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
//
// Settings → Models for the decision capability: its picker offers TypeSafe
// first, then the chat-completions HTTP backends, and never a cloud chat
// runtime. TypeSafe asks for the API key through the credentials wizard when
// none is configured — unless the endpoint is the operator's own — and assigns
// `typesafe/<model>`, the default Jev model unless the operator edits it.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn(),
  patchAdminConfig: vi.fn(), getRecentModels: vi.fn(), probeBackend: vi.fn(),
  getModelCredentialsStatus: vi.fn(), setModelProviderCredentials: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));
// The wizard's own steps are covered by its suite; here it only has to report
// whether the operator saved a key.
vi.mock("./credentials-wizard.js", async () => {
  const { html } = await import("htm/preact");
  return {
    CredentialsWizard: ({ entry, onClose }) => html`<div class="wizard-stub">
      Wizard for ${entry.fileKey}
      <button onClick=${() => onClose(true)}>Save key</button>
      <button onClick=${() => onClose(false)}>Abandon</button>
    </div>`,
  };
});
import { ModelsView } from "./models.js";
import { CAPABILITY_METADATA } from "@omnesis/core";

const DECISION = CAPABILITY_METADATA.decision;

function overviewWith(assignment, extra = {}) {
  return {
    capabilities: [DECISION],
    catalog: [], installed: [], presets: [{ id: "openai", name: "OpenAI", defaultUrl: "https://api.example.com/v1" }],
    inference: {
      allowRemoteInference: true,
      assignments: { decision: assignment },
      backends: {
        openai: { type: "http", status: "ok", modelRoles: { "gpt-example": ["agent"] } },
        "llama-box": { type: "http", status: "ok", url: "http://127.0.0.1:8080", modelRoles: { "decider-7b": ["agent"] } },
        "responses-host": { type: "http", status: "ok", protocol: "responses", modelRoles: { "r-model": ["agent"] } },
      },
      codex: { configured: true, loggedIn: true, status: "ok", models: ["codex-a"], modelRoles: { "codex-a": ["agent"] } },
      decisionChatModels: true,
      ...extra,
    },
  };
}

const typesafeCredential = (configured) => ({
  items: [
    { fileKey: "anthropic", providerType: "anthropic", providerName: "Anthropic", configured: true, spec: {} },
    { fileKey: "typesafe", providerType: "typesafe", providerName: "TypeSafe", configured, spec: {} },
  ],
});

describe("Models — the Decision model picker", () => {
  let host, originalDocument, originalWindow;
  const buttons = () => [...host.querySelectorAll("button")];
  const button = (text) => buttons().find((entry) => entry.textContent.trim() === text);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const click = async (text) => {
    expect(button(text), text).toBeTruthy();
    await act(async () => { button(text).dispatchEvent(new window.Event("click", { bubbles: false })); });
    await flush();
  };
  const cardTitles = () => [...host.querySelectorAll(".backend-opt-title")].map((n) => n.textContent);
  const openPicker = async () => {
    await act(async () => { render(h(ModelsView, { section: "decision" }), host); });
    await flush();
    await click("Choose model");
  };
  const openTypeSafe = async () => {
    await openPicker();
    const card = [...host.querySelectorAll(".backend-opt-title")].find((n) => n.textContent === "TypeSafe");
    expect(card, "TypeSafe card").toBeTruthy();
    await act(async () => { card.closest("button").dispatchEvent(new window.Event("click", { bubbles: false })); });
    await flush();
  };

  beforeEach(() => {
    originalDocument = globalThis.document; originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    api.getModelsOverview.mockReset().mockResolvedValue(overviewWith({ kind: "disabled", role: "decision" }));
    api.getSystemInfo.mockReset().mockResolvedValue({});
    api.getCodexRuntimeUpdate.mockReset().mockResolvedValue({ plan: { state: "up-to-date" } });
    api.getRecentModels.mockReset().mockResolvedValue({ entries: [] });
    api.patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
    api.probeBackend.mockReset().mockResolvedValue({ ok: true });
    api.getModelCredentialsStatus.mockReset().mockResolvedValue(typesafeCredential(false));
    api.setModelProviderCredentials.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("explains the decision uses beside the model picker", async () => {
    await openPicker();
    expect(host.querySelector(".cap-detail-desc")?.textContent).toBe(DECISION.description);
    expect(host.textContent).toContain("complication captures");
    expect(host.textContent).toContain("email dates");
    expect(host.textContent).toContain("TypeSafe");
  });

  it("outside experimental mode offers only TypeSafe and no Add backend", async () => {
    api.getModelsOverview.mockResolvedValue(overviewWith({ kind: "disabled", role: "decision" }, { decisionChatModels: false }));
    await act(async () => { render(h(ModelsView, { section: "decision" }), host); });
    await flush();
    expect(button("Add backend")).toBeFalsy();
    await openPicker();
    expect(cardTitles()).toEqual(["TypeSafe"]);
  });

  it("in experimental mode lets a chat backend be added for the Decision model", async () => {
    await act(async () => { render(h(ModelsView, { section: "decision" }), host); });
    await flush();
    expect(host.textContent).toContain("Decision model");
    expect(button("Choose model")).toBeTruthy();
    expect(button("Add backend")).toBeTruthy();
  });

  it("in experimental mode offers TypeSafe first, then chat-completions backends, and no cloud chat runtime", async () => {
    await openPicker();
    const titles = cardTitles();
    expect(titles[0]).toBe("TypeSafe");
    expect(titles).toContain("llama-box");
    expect(titles).not.toContain("responses-host");
    expect(titles).not.toContain("Codex");
    expect(titles).not.toContain("Anthropic");
  });

  it("starts the TypeSafe pane from the default Jev model", async () => {
    await openTypeSafe();
    const input = host.querySelector("input[aria-label='TypeSafe model id']");
    expect(input.value).toBe("jev-1.13.0");
    expect(host.textContent).toContain("Not configured");
    expect(host.textContent).toContain("sent to TypeSafe");
  });

  it("assigns a self-hosted TypeSafe endpoint on this host with no key and no consent", async () => {
    api.getModelsOverview.mockResolvedValue(overviewWith({ kind: "disabled", role: "decision" }, {
      allowRemoteInference: false,
      typesafe: { url: "http://127.0.0.1:18999/v1/systemone", selfHosted: true, onHost: true },
    }));
    await openTypeSafe();
    expect(host.textContent).toContain("optional for your own endpoint");
    expect(host.textContent).toContain("stay on this machine");
    await click("Use");
    expect(host.querySelector(".wizard-stub")).toBeNull();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "typesafe/jev-1.13.0" } } });
  });

  it("asks consent naming a self-hosted endpoint off this host, not TypeSafe", async () => {
    api.getModelsOverview.mockResolvedValue(overviewWith({ kind: "disabled", role: "decision" }, {
      allowRemoteInference: false,
      typesafe: { url: "http://10.1.2.3:8080/v1/systemone", selfHosted: true, onHost: false },
    }));
    await openTypeSafe();
    await click("Use");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    expect(host.textContent).toContain("10.1.2.3");
    await click("Enable cloud inference");
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { allowRemoteInference: true, assignments: { decision: "typesafe/jev-1.13.0" } } });
  });

  it("asks for the key first when none is configured, then assigns the model", async () => {
    await openTypeSafe();
    await click("Use");
    expect(host.querySelector(".wizard-stub")?.textContent).toContain("Wizard for typesafe");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    await click("Save key");
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "typesafe/jev-1.13.0" } } });
  });

  it("assigns nothing when the key wizard is abandoned", async () => {
    await openTypeSafe();
    await click("Use");
    await click("Abandon");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
  });

  it("assigns an edited model id directly when the key is configured", async () => {
    api.getModelCredentialsStatus.mockResolvedValue(typesafeCredential(true));
    await openTypeSafe();
    expect(host.textContent).toContain("Configured");
    const input = host.querySelector("input[aria-label='TypeSafe model id']");
    await act(async () => { input.value = "jev-2.0.0"; input.dispatchEvent(new window.Event("input")); });
    await click("Use");
    expect(host.querySelector(".wizard-stub")).toBeNull();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "typesafe/jev-2.0.0" } } });
  });

  it("treats an environment key the resolved assignment reports as configured", async () => {
    api.getModelsOverview.mockResolvedValue(overviewWith({ role: "decision", kind: "typesafe", model: "jev-1.13.0", hasApiKey: true, allowRemoteInference: true, available: true }));
    await openTypeSafe();
    expect(button("Current")).toBeTruthy();
    await click("Current");
    expect(host.querySelector(".wizard-stub")).toBeNull();
    expect(api.patchAdminConfig).toHaveBeenCalledOnce();
  });

  it("asks for cloud-inference consent before assigning TypeSafe when it is off", async () => {
    api.getModelsOverview.mockResolvedValue({ ...overviewWith({ kind: "disabled", role: "decision" }), inference: { ...overviewWith({ kind: "disabled" }).inference, allowRemoteInference: false } });
    api.getModelCredentialsStatus.mockResolvedValue(typesafeCredential(true));
    await openTypeSafe();
    await click("Use");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    expect(host.textContent).toContain("TypeSafe");
    await click("Enable cloud inference");
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { allowRemoteInference: true, assignments: { decision: "typesafe/jev-1.13.0" } } });
  });

  it("shows why an assigned TypeSafe model is unavailable", async () => {
    api.getModelsOverview.mockResolvedValue(overviewWith({
      role: "decision", kind: "typesafe", model: "jev-1.13.0", hasApiKey: false, allowRemoteInference: true, available: false,
      reason: "TypeSafe API key not configured. Set it from the portal's Settings → Models tab.",
    }));
    await act(async () => { render(h(ModelsView, { section: "decision" }), host); });
    await flush();
    expect(host.querySelector(".cap-detail-warn")?.textContent).toContain("TypeSafe API key not configured");
  });
});
