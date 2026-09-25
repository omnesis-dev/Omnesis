// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(),
  getSystemInfo: vi.fn(),
  getCodexRuntimeUpdate: vi.fn(),
  saveModelBehavior: vi.fn(),
  probeBackend: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));

import { ModelsView } from "./models.js";

describe("Models capability behavior page", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  const overview = {
    catalog: [],
    installed: [],
    capabilities: [{ role: "agent", title: "Agent", description: "Answers questions.", icon: "bot", section: "cognition" }],
    inference: { assignments: { agent: { kind: "http", available: true } }, backends: {} },
    assignmentDisplays: { agent: { providerId: "openai", providerLabel: "OpenAI", modelName: "Example model" } },
    modelSettings: { agent: { assignment: "openai/example-model", values: { reasoningEffort: "medium" } } },
    modelControls: { "openai/example-model": {
      providerId: "openai", source: "models.dev", reasoning: true,
      controls: [{ key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium", "high"] }],
    } },
  };

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    api.getModelsOverview.mockReset().mockResolvedValue(overview);
    api.getSystemInfo.mockReset().mockResolvedValue({});
    api.getCodexRuntimeUpdate.mockReset().mockResolvedValue({ plan: { state: "up-to-date" } });
    api.saveModelBehavior.mockReset().mockResolvedValue({ ok: true });
    api.probeBackend.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  it("shows the assigned model's options on /settings/models/agent and saves them", async () => {
    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector(".cap-detail-active-model")?.textContent).toContain("Example model");
    expect(host.querySelector(".cap-detail-active .model-behavior")).toBeTruthy();
    expect(host.textContent).not.toContain("Options supplied by Models.dev");

    const effort = [...host.querySelectorAll('[role="group"][aria-label="Reasoning effort"] button')].find((entry) => entry.textContent === "high") as HTMLButtonElement;
    await act(async () => { effort.click(); });
    await vi.waitFor(() => expect(api.saveModelBehavior).toHaveBeenCalledWith("agent", "openai/example-model", { reasoningEffort: "high" }, { reasoningEffort: "medium" }));
  });

  it("shows and saves Codex's provider-native effort options", async () => {
    const codexOverview = {
      ...overview,
      inference: { assignments: { agent: { kind: "codex", available: true } }, backends: {} },
      assignmentDisplays: { agent: { providerId: "codex", providerLabel: "Codex", modelName: "codex-example-model" } },
      modelSettings: { agent: { assignment: "codex/gpt-example", values: {} } },
      modelControls: { "codex/gpt-example": {
        providerId: "openai", source: "provider", reasoning: true,
        controls: [{ key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium", "high", "xhigh"] }],
      } },
    };
    api.getModelsOverview.mockResolvedValue(codexOverview);

    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await act(async () => { await Promise.resolve(); });
    const effort = host.querySelector('select[aria-label="Reasoning effort"]') as HTMLSelectElement;
    expect(effort).toBeTruthy();
    await act(async () => {
      effort.querySelector('option[value="xhigh"]')?.setAttribute("selected", "");
      effort.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(api.saveModelBehavior).toHaveBeenCalledWith(
      "agent", "codex/gpt-example", { reasoningEffort: "xhigh" }, {},
    ));
  });

  it("keeps saved controls reachable when a configured model becomes unavailable", async () => {
    api.getModelsOverview.mockResolvedValue({
      ...overview,
      inference: { ...overview.inference, assignments: { agent: { kind: "http", available: false, reason: "Backend unavailable" } } },
    });
    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector(".cap-detail-warn")).toBeTruthy();
    expect(host.querySelector(".cap-detail .model-behavior")).toBeTruthy();
    expect(host.querySelector(".cap-detail-active .model-behavior")).toBeNull();
  });

  it("ignores an old overview response that finishes after a newer behavior save", async () => {
    const withBackend = { ...overview, inference: {
      ...overview.inference, backends: { openai: { type: "http", status: "ok", models: ["example-model"] } },
    } };
    const newer = { ...withBackend, modelSettings: { agent: {
      assignment: "openai/example-model", values: { reasoningEffort: "high" },
    } } };
    let finishOldSystemInfo: (() => void) | undefined;
    const oldSystemInfo = new Promise((resolve) => { finishOldSystemInfo = () => resolve({}); });
    api.getModelsOverview.mockResolvedValueOnce(withBackend)
      .mockResolvedValueOnce(withBackend)
      .mockResolvedValue(newer);
    api.getSystemInfo.mockResolvedValueOnce({})
      .mockReturnValueOnce(oldSystemInfo)
      .mockResolvedValue({});

    await act(async () => { render(h(ModelsView, { section: "agent" }), host); });
    await vi.waitFor(() => expect(api.getSystemInfo).toHaveBeenCalledTimes(2));
    const high = [...host.querySelectorAll('[role="group"][aria-label="Reasoning effort"] button')]
      .find((entry) => entry.textContent === "high") as HTMLButtonElement;
    await act(async () => { high.click(); });
    await vi.waitFor(() => expect(api.saveModelBehavior).toHaveBeenCalledWith(
      "agent", "openai/example-model", { reasoningEffort: "high" }, { reasoningEffort: "medium" },
    ));
    await vi.waitFor(() => expect(api.getSystemInfo).toHaveBeenCalledTimes(3));
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[role="group"][aria-label="Reasoning effort"] button.active')?.textContent).toBe("high");
    await act(async () => { finishOldSystemInfo?.(); await Promise.resolve(); });
    expect(host.querySelector('[role="group"][aria-label="Reasoning effort"] button.active')?.textContent).toBe("high");
  });
});
