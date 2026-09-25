// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelBehaviorEditor, modelBehaviorSummary } from "./model-behavior.js";

describe("model-native behavior editor", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  const model = {
    source: "models.dev",
    reasoning: true,
    controls: [
      { key: "reasoningEnabled", type: "boolean", label: "Reasoning" },
      { key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium", "high"], exclusiveWith: ["reasoningBudgetTokens"] },
      { key: "reasoningBudgetTokens", type: "integer", label: "Thinking budget", min: 128, max: 4096 },
    ],
  };

  async function choose(label: string, option: string) {
    const group = host.querySelector(`[role="group"][aria-label="${label}"]`);
    const button = [...(group?.querySelectorAll("button") ?? [])].find((entry) => entry.textContent === option) as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
  }

  it("summarizes saved settings and distinguishes missing catalog entries", () => {
    const settings = { assignment: "cloud/model", values: { reasoningEnabled: false, reasoningEffort: "high", reasoningBudgetTokens: 2048 } };
    expect(modelBehaviorSummary(settings, model)).toBe("Reasoning off · Effort high · Budget 2048 tokens");
    expect(modelBehaviorSummary({ ...settings, values: {} }, model)).toBeNull();
    expect(modelBehaviorSummary({ ...settings, values: { reasoningBudgetTokens: -1 } }, model)).toBe("No reasoning budget enforcement");
    expect(modelBehaviorSummary(settings, { source: "unknown" })).toBe("Saved behavior: controls unavailable");
    expect(modelBehaviorSummary({ ...settings, values: {} }, { source: "unknown" })).toBeNull();
    expect(modelBehaviorSummary({ ...settings, values: {} }, { source: "models.dev", controls: [] })).toBeNull();
    expect(modelBehaviorSummary(null, model)).toBeNull();
  });

  it("offers the provider's exact options and saves a role-bound assignment", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const settings = { assignment: "cloud/model", values: {} };
    await act(async () => { render(h(ModelBehaviorEditor, { settings, model, onSave }), host); });

    expect([...host.querySelectorAll('[role="group"][aria-label="Reasoning effort"] button')].map((node) => node.textContent)).toEqual([
      "Model default", "low", "medium", "high",
    ]);
    expect(host.querySelector('select[aria-label="Reasoning effort"]')).toBeNull();
    expect(host.textContent).not.toContain("Save behavior");

    await choose("Reasoning effort", "high");
    await choose("Reasoning", "Off");
    expect([...host.querySelectorAll('[role="group"][aria-label="Reasoning effort"] button')].every((entry) => (entry as HTMLButtonElement).disabled)).toBe(true);
    expect((host.querySelector('input[type="number"]') as HTMLInputElement).disabled).toBe(true);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", { reasoningEnabled: false }, {}));
  });

  it("clears mutually exclusive budget and effort choices", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, { settings: { assignment: "cloud/model", values: { reasoningBudgetTokens: 1024 } }, model, onSave }), host); });
    await choose("Reasoning effort", "medium");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", { reasoningEffort: "medium" }, { reasoningBudgetTokens: 1024 }));
  });

  it("clears an offered override through Model default without a Reset button", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, {
      settings: { assignment: "cloud/model", values: { reasoningEffort: "high" } }, model, onSave,
    }), host); });
    expect(host.textContent).not.toContain("Reset to model default");
    await choose("Reasoning effort", "Model default");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", {}, { reasoningEffort: "high" }));
  });

  it("keeps a menu for a provider with more than four total choices", async () => {
    const many = { ...model, controls: [
      { key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium", "high", "xhigh"] },
    ] };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, { settings: { assignment: "cloud/model", values: {} }, model: many, onSave }), host); });
    expect(host.querySelector('[role="group"][aria-label="Reasoning effort"]')).toBeNull();
    const effort = host.querySelector('select[aria-label="Reasoning effort"]') as HTMLSelectElement;
    expect([...effort.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Model default", "low", "medium", "high", "xhigh"]);
    await act(async () => {
      effort.querySelector('option[value="xhigh"]')?.setAttribute("selected", "");
      effort.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", { reasoningEffort: "xhigh" }, {}));
  });

  it("offers NVIDIA's explicit no-enforcement choice instead of asking users to type -1", async () => {
    const nvidia = { ...model, controls: [
      { key: "reasoningBudgetTokens", type: "integer", label: "Reasoning token budget", min: -1, max: 32768 },
    ] };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, { settings: { assignment: "nvidia/model", values: {} }, model: nvidia, onSave }), host); });
    const option = [...host.querySelectorAll(".model-behavior-number label")].find((node) => node.textContent?.includes("No reasoning budget enforcement"))?.querySelector("input") as HTMLInputElement;
    expect(option).toBeTruthy();
    await act(async () => { option.checked = true; option.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect((host.querySelector('input[type="number"]') as HTMLInputElement).disabled).toBe(true);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("nvidia/model", { reasoningBudgetTokens: -1 }, {}));
  });

  it("clears an overlapping budget when a provider thinking toggle is turned on", async () => {
    const google = { ...model, controls: [
      { key: "reasoningEnabled", type: "boolean", label: "Reasoning", exclusiveWith: ["reasoningBudgetTokens"] },
      { key: "reasoningBudgetTokens", type: "integer", label: "Thinking budget", min: 0, max: 4096, exclusiveWith: ["reasoningEnabled"] },
    ] };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, { settings: { assignment: "google/gemini", values: { reasoningBudgetTokens: 1024 } }, model: google, onSave }), host); });
    await choose("Reasoning", "On");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("google/gemini", { reasoningEnabled: true }, { reasoningBudgetTokens: 1024 }));
  });

  it("shows an inline error when the gateway refuses stale model settings", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Model assignment changed"));
    const settings = { assignment: "cloud/model", values: {} };
    await act(async () => { render(h(ModelBehaviorEditor, { settings, model, onSave }), host); });
    await choose("Reasoning effort", "medium");
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("Model assignment changed"));
  });

  it("replaces a draft when another client changes saved values for the same assignment", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, { settings: { assignment: "cloud/model", values: { reasoningEffort: "low" } }, model, onSave }), host); });
    await act(async () => { render(h(ModelBehaviorEditor, { settings: { assignment: "cloud/model", values: { reasoningEffort: "high" } }, model, onSave }), host); });
    await choose("Reasoning effort", "low");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", { reasoningEffort: "low" }, { reasoningEffort: "high" }));
  });

  it("does not restore an old draft when a save finishes after newer same-model settings arrive", async () => {
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    await act(async () => { render(h(ModelBehaviorEditor, {
      settings: { assignment: "cloud/model", values: { reasoningEffort: "low" } }, model, onSave,
    }), host); });
    await choose("Reasoning effort", "medium");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(
      "cloud/model", { reasoningEffort: "medium" }, { reasoningEffort: "low" },
    ));
    await act(async () => { render(h(ModelBehaviorEditor, {
      settings: { assignment: "cloud/model", values: { reasoningEffort: "high" } }, model, onSave,
    }), host); });
    expect(host.querySelector('[role="group"][aria-label="Reasoning effort"] button.active')?.textContent).toBe("high");
    await act(async () => { finishSave?.(); await Promise.resolve(); });
    expect(host.querySelector('[role="group"][aria-label="Reasoning effort"] button.active')?.textContent).toBe("high");
  });

  it("keeps unmatched models usable without inventing controls", async () => {
    await act(async () => {
      render(h(ModelBehaviorEditor, { settings: { assignment: "cloud/unknown", values: {} }, model: { source: "unknown", controls: [] }, onSave: vi.fn() }), host);
    });
    expect(host.textContent).not.toContain("Models.dev");
    expect(host.querySelector(".model-behavior")).toBeNull();
    expect(host.querySelectorAll("select, input")).toHaveLength(0);
  });

  it("clears a retired enum choice through Model default after a catalog refresh", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const settings = { assignment: "cloud/model", values: { reasoningEffort: "obsolete" } };
    await act(async () => { render(h(ModelBehaviorEditor, { settings, model, onSave }), host); });
    expect(host.textContent).toContain("no longer offered");
    expect(host.textContent).not.toContain("Reset to model default");
    await choose("Reasoning effort", "Model default");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", {}, { reasoningEffort: "obsolete" }));
    expect(host.textContent).not.toContain("no longer offered");
  });

  it("requires Reset before editing when a saved control disappears entirely", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const limited = { ...model, controls: [{ key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium"] }] };
    await act(async () => { render(h(ModelBehaviorEditor, {
      settings: { assignment: "cloud/model", values: { reasoningBudgetTokens: 1024 } }, model: limited, onSave,
    }), host); });
    const buttons = [...host.querySelectorAll('[role="group"][aria-label="Reasoning effort"] button')] as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const reset = [...host.querySelectorAll("button")].find((button) => button.textContent === "Reset to model default") as HTMLButtonElement;
    expect(reset).toBeTruthy();
    await act(async () => { reset.click(); });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("cloud/model", {}, { reasoningBudgetTokens: 1024 }));
    expect([...host.querySelectorAll('[role="group"][aria-label="Reasoning effort"] button')].every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("offers reset even when an unknown model has no current controls", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => { render(h(ModelBehaviorEditor, {
      settings: { assignment: "cloud/unknown", values: { reasoningBudgetTokens: 1024 } },
      model: { source: "unknown", controls: [] }, onSave,
    }), host); });
    expect(host.querySelectorAll("select, input")).toHaveLength(0);
    const reset = [...host.querySelectorAll("button")].find((button) => button.textContent === "Reset to model default") as HTMLButtonElement;
    expect(reset).toBeTruthy();
    await act(async () => { reset.click(); });
    expect(onSave).toHaveBeenCalledWith("cloud/unknown", {}, { reasoningBudgetTokens: 1024 });
  });
});
