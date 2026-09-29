// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
//
// Settings → Models for the decision capability: its picker offers TypeSafe and
// nothing else, asks for the API key through the credentials wizard when none
// is configured, and assigns `typesafe/<model>` — the default Jev model unless
// the operator edits it.

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

const DECISION = { role: "decision", title: "Decision model", description: "Answers typed questions about a document.", icon: "scale", experimental: true, section: "cognition" };

function overviewWith(assignment, extra = {}) {
  return {
    capabilities: [DECISION],
    catalog: [], installed: [], presets: [{ id: "openai", name: "OpenAI", defaultUrl: "https://api.example.com/v1" }],
    inference: {
      allowRemoteInference: true,
      assignments: { decision: assignment },
      backends: { openai: { type: "http", status: "ok", modelRoles: { "gpt-example": ["agent"] } } },
      codex: { configured: true, loggedIn: true, status: "ok", models: ["codex-a"], modelRoles: { "codex-a": ["agent"] } },
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
  const openPicker = async () => {
    await act(async () => { render(h(ModelsView, { section: "decision" }), host); });
    await flush();
    await click("Choose model");
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

  it("offers no way to add a chat backend to the Decision model", async () => {
    await act(async () => { render(h(ModelsView, { section: "decision" }), host); });
    await flush();
    expect(host.textContent).toContain("Decision model");
    expect(button("Choose model")).toBeTruthy();
    expect(button("Add backend")).toBeUndefined();
  });

  it("opens on TypeSafe with the default Jev model, and its grid holds TypeSafe alone", async () => {
    await openPicker();
    const input = host.querySelector("input[aria-label='TypeSafe model id']");
    expect(input.value).toBe("jev-1.13.0");
    expect(host.textContent).toContain("Not configured");
    await click("← Back");
    const titles = [...host.querySelectorAll(".backend-opt-title")].map((n) => n.textContent);
    expect(titles).toEqual(["TypeSafe"]);
  });

  it("asks for the key first when none is configured, then assigns the model", async () => {
    await openPicker();
    await click("Use");
    expect(host.querySelector(".wizard-stub")?.textContent).toContain("Wizard for typesafe");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    await click("Save key");
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "typesafe/jev-1.13.0" } } });
  });

  it("assigns nothing when the key wizard is abandoned", async () => {
    await openPicker();
    await click("Use");
    await click("Abandon");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
  });

  it("assigns an edited model id directly when the key is configured", async () => {
    api.getModelCredentialsStatus.mockResolvedValue(typesafeCredential(true));
    await openPicker();
    expect(host.textContent).toContain("Configured");
    const input = host.querySelector("input[aria-label='TypeSafe model id']");
    await act(async () => { input.value = "jev-2.0.0"; input.dispatchEvent(new window.Event("input")); });
    await click("Use");
    expect(host.querySelector(".wizard-stub")).toBeNull();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { decision: "typesafe/jev-2.0.0" } } });
  });

  it("treats an environment key the resolved assignment reports as configured", async () => {
    api.getModelsOverview.mockResolvedValue(overviewWith({ role: "decision", kind: "typesafe", model: "jev-1.13.0", hasApiKey: true, allowRemoteInference: true, available: true }));
    await openPicker();
    expect(button("Current")).toBeTruthy();
    await click("Current");
    expect(host.querySelector(".wizard-stub")).toBeNull();
    expect(api.patchAdminConfig).toHaveBeenCalledOnce();
  });

  it("asks for cloud-inference consent before assigning TypeSafe when it is off", async () => {
    api.getModelsOverview.mockResolvedValue({ ...overviewWith({ kind: "disabled", role: "decision" }), inference: { ...overviewWith({ kind: "disabled" }).inference, allowRemoteInference: false } });
    api.getModelCredentialsStatus.mockResolvedValue(typesafeCredential(true));
    await openPicker();
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
