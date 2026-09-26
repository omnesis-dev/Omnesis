// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn(),
  patchAdminConfig: vi.fn(), getRecentModels: vi.fn(), probeBackend: vi.fn(), addHttpBackend: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));
import { ModelsView } from "./models.js";

const overview = {
  capabilities: [{ role: "agent", title: "Agent", description: "Answers questions.", icon: "bot" }],
  catalog: [], installed: [], presets: [],
  inference: { allowRemoteInference: false, assignments: { agent: { kind: "disabled", available: false } }, backends: {},
    codex: { configured: true, loggedIn: true, status: "ok", models: ["example-model"], modelRoles: { "example-model": ["agent"] } } },
};

describe("Models cloud inference consent", () => {
  let host, originalDocument, originalWindow;
  const button = (text) => [...host.querySelectorAll("button")].find((entry) => entry.textContent.trim() === text);
  const click = async (text) => { expect(button(text), text).toBeTruthy(); await act(async () => { button(text).dispatchEvent(new window.Event("click", { bubbles: false })); await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const openRecent = async (assignment = "codex/example-model") => {
    api.getRecentModels.mockResolvedValue({ entries: [{ assignment, providerId: "codex", providerLabel: "Codex", modelName: "Example model", apply: { type: "assign", value: assignment } }] });
    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await act(async () => { await Promise.resolve(); });
    await click("Choose model");
    await act(async () => { await Promise.resolve(); });
    await click("Use");
  };
  beforeEach(() => {
    originalDocument = globalThis.document; originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    api.getModelsOverview.mockReset().mockResolvedValue(overview);
    api.getSystemInfo.mockReset().mockResolvedValue({});
    api.getCodexRuntimeUpdate.mockReset().mockResolvedValue({ plan: { state: "up-to-date" } });
    api.getRecentModels.mockReset().mockResolvedValue({ entries: [] });
    api.patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
    api.probeBackend.mockReset().mockResolvedValue({ ok: true });
    api.addHttpBackend.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("cancels a recent Codex assignment without changing config", async () => {
    await openRecent();
    expect(host.textContent).toContain("to OpenAI");
    expect(host.textContent).toContain("this gateway's configured remote inference backends");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    await click("Cancel");
    expect(host.querySelector(".confirm-modal-backdrop")).toBeNull();
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
  });

  it("drops an unconfirmed selection when the Models view is unmounted", async () => {
    await openRecent();
    await act(async () => { render(null, host); await Promise.resolve(); });
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
  });

  it.each(["codex/example-model", "anthropic/example-model", "remote/example-model"])("atomically saves permission and recent assignment %s", async (assignment) => {
    await openRecent(assignment);
    await click("Enable cloud inference");
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { allowRemoteInference: true, assignments: { agent: assignment } } });
  });

  it("requests consent from the Codex picker before applying the model", async () => {
    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await act(async () => { await Promise.resolve(); });
    await click("Choose model");
    const codex = [...host.querySelectorAll("button")].find((entry) => entry.querySelector(".backend-opt-title")?.textContent === "Codex");
    expect(codex).toBeTruthy();
    await act(async () => { codex.dispatchEvent(new window.Event("click", { bubbles: false })); });
    await click("Use for Agent");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    await click("Enable cloud inference");
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { allowRemoteInference: true, assignments: { agent: "codex/example-model" } } });
  });

  it("requires the same confirmation before adding a remote HTTP backend", async () => {
    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await act(async () => { await Promise.resolve(); });
    await click("Add backend");
    const custom = [...host.querySelectorAll("button")].find((entry) => entry.querySelector(".backend-opt-title")?.textContent === "Custom HTTP backend");
    await act(async () => { custom.dispatchEvent(new window.Event("click", { bubbles: false })); });
    const inputs = host.querySelectorAll(".backend-form input");
    await act(async () => {
      inputs[0].value = "example"; inputs[0].dispatchEvent(new window.Event("input"));
      inputs[1].value = "https://api.example.com"; inputs[1].dispatchEvent(new window.Event("input"));
    });
    const submitForm = async () => { await act(async () => { host.querySelector(".backend-form").dispatchEvent(new window.Event("submit", { bubbles: false, cancelable: true })); }); };
    await submitForm();
    expect(api.addHttpBackend).not.toHaveBeenCalled();
    await click("Cancel");
    expect(host.querySelector(".backend-form")).toBeTruthy();
    expect(api.addHttpBackend).not.toHaveBeenCalled();
    await submitForm();
    await click("Enable cloud inference");
    expect(api.addHttpBackend).toHaveBeenCalledExactlyOnceWith("example", "https://api.example.com", undefined, undefined, true);
  });

  it("shows a write failure without reporting success", async () => {
    api.patchAdminConfig.mockResolvedValue({ ok: false, body: { error: "Permission could not be saved" } });
    await openRecent();
    await click("Enable cloud inference");
    expect(host.querySelector(".config-banner.error")?.textContent).toContain("Permission could not be saved");
    expect(host.textContent).not.toContain("Switched agent");
  });

  it("does not ask again when cloud inference is enabled", async () => {
    api.getModelsOverview.mockResolvedValue({ ...overview, inference: { ...overview.inference, allowRemoteInference: true } });
    await openRecent();
    expect(host.querySelector(".confirm-modal-backdrop")).toBeNull();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { assignments: { agent: "codex/example-model" } } });
  });

  it("requires confirmation to enable the persistent setting and disables it directly", async () => {
    await act(async () => { render(h(ModelsView, {}), host); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[role="switch"]').getAttribute("aria-checked")).toBe("false");
    await click("Enable cloud inference…");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
    expect(host.querySelector('[role="switch"]').getAttribute("aria-checked")).toBe("false");
    api.getModelsOverview.mockResolvedValue({ ...overview, inference: { ...overview.inference, allowRemoteInference: true } });
    await click("Enable cloud inference");
    expect(api.patchAdminConfig).toHaveBeenCalledWith({ inference: { allowRemoteInference: true } });
    expect(host.querySelector('[role="switch"]').getAttribute("aria-checked")).toBe("true");
    await click("Disable cloud inference");
    expect(api.patchAdminConfig).toHaveBeenLastCalledWith({ inference: { allowRemoteInference: false } });
  });
});
