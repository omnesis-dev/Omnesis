// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getStatus: vi.fn(), patchAdminConfig: vi.fn(), getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn() }));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));
import { ModelsView, NoteAgentSetting } from "./models.js";

const noteAgent = (overrides = {}) => ({
  enabled: true, modelAssigned: true, active: true, ...overrides,
});

describe("Note agent setting", () => {
  let host, originalDocument, originalWindow;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const mount = async () => {
    await act(async () => { render(h(NoteAgentSetting, {}), host); });
    await settle();
  };
  const toggle = () => host.querySelector("[role=switch]");

  beforeEach(() => {
    originalDocument = globalThis.document; originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    api.getStatus.mockReset();
    api.getModelsOverview.mockReset();
    api.getSystemInfo.mockReset().mockResolvedValue({});
    api.getCodexRuntimeUpdate.mockReset().mockResolvedValue(null);
    api.patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("places note processing under Agent and leaves Brain model settings separate", async () => {
    api.getStatus.mockResolvedValue({ noteAgent: noteAgent() });
    api.getModelsOverview.mockResolvedValue({
      capabilities: [
        { role: "agent", title: "Agent", description: "Owner chat and notes", icon: "bot" },
        { role: "background-agent", title: "Brain agent", description: "Runs autonomous workflows", icon: "bot" },
      ],
      inference: { assignments: {}, backends: {} }, catalog: [], installed: [], presets: [],
    });
    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await settle();
    await settle();
    expect(host.textContent).toContain("Act on Tell Omnesis notes");
    await act(async () => { render(h(ModelsView, { section: "background-agent" }), host); });
    await settle();
    expect(host.textContent).not.toContain("Act on Tell Omnesis notes");
  });

  it("rechecks readiness when model settings refresh without remounting", async () => {
    api.getStatus.mockResolvedValueOnce({ noteAgent: noteAgent({ modelAssigned: false, active: false }) })
      .mockResolvedValueOnce({ noteAgent: noteAgent() })
      .mockResolvedValueOnce({ noteAgent: noteAgent({ modelAssigned: false, active: false }) });
    await act(async () => { render(h(NoteAgentSetting, { statusRevision: 1 }), host); });
    await settle();
    expect(host.textContent).toContain("Not in use yet.");
    await act(async () => { render(h(NoteAgentSetting, { statusRevision: 2 }), host); });
    await settle();
    expect(host.textContent).not.toContain("Not in use yet.");
    await act(async () => { render(h(NoteAgentSetting, { statusRevision: 3 }), host); });
    await settle();
    expect(host.textContent).toContain("Not in use yet.");
    expect(api.getStatus).toHaveBeenCalledTimes(3);
  });

  it("renders nothing against a gateway without the setting", async () => {
    api.getStatus.mockResolvedValue({ tasks: { available: true, noteAgent: true } });
    await mount();
    expect(host.textContent).toBe("");
  });

  it("switches the note agent off through the config and shows the gateway's new state", async () => {
    api.getStatus.mockResolvedValueOnce({ noteAgent: noteAgent() })
      .mockResolvedValueOnce({ noteAgent: noteAgent({ enabled: false, active: false }) });
    await mount();
    expect(host.querySelector("h2").textContent).toBe("Act on Tell Omnesis notes");
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ agent: { noteAgent: false } });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Off");
  });

  it("switches a switched-off note agent back on", async () => {
    api.getStatus.mockResolvedValueOnce({ noteAgent: noteAgent({ enabled: false, active: false }) })
      .mockResolvedValueOnce({ noteAgent: noteAgent() });
    await mount();
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ agent: { noteAgent: true } });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("explains why a switched-on note agent reads nothing without a runnable model", async () => {
    api.getStatus.mockResolvedValue({ noteAgent: noteAgent({ modelAssigned: false, active: false }) });
    await mount();
    expect(host.textContent).toContain("Not in use yet.");
  });

  it("surfaces a failed save", async () => {
    api.getStatus.mockResolvedValue({ noteAgent: noteAgent() });
    api.patchAdminConfig.mockResolvedValue({ ok: false, body: { error: "Validation failed" } });
    await mount();
    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Validation failed");
    expect(toggle().hasAttribute("disabled")).toBe(false);
  });
});
