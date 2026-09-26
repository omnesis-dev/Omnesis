// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { patchAdminConfig } = vi.hoisted(() => ({ patchAdminConfig: vi.fn() }));
vi.mock("../api.js", () => ({ patchAdminConfig }));
import { AgentCloudInferenceRecovery } from "./agent-cloud-inference.js";

describe("Agent cloud inference recovery controls", () => {
  let host, originalDocument, originalWindow;
  let getConfig, onEnabled, onRetry;
  const button = (text) => [...host.querySelectorAll("button")].find((entry) => entry.textContent.trim() === text);
  const click = async (text) => {
    expect(button(text), text).toBeTruthy();
    await act(async () => { button(text).click(); });
  };
  const mount = async () => {
    await act(async () => {
      render(h(AgentCloudInferenceRecovery, {
        recovery: { key: "blocked-turn", message: "Summarize my notes", deepResearch: true },
        model: { modelName: "Example model", providerLabel: "OpenAI" },
        getConfig, onEnabled, onRetry,
      }), host);
    });
  };

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
    getConfig = vi.fn().mockResolvedValue({ enabled: true });
    onEnabled = vi.fn();
    onRetry = vi.fn();
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("shows provider disclosure and cancels without enabling or resending", async () => {
    await mount();
    expect(host.querySelector("a").getAttribute("href")).toBe("/portal/settings/models/agent");
    await click("Enable cloud inference…");
    expect(host.querySelector("[role='dialog']").textContent).toContain("to OpenAI");
    expect(host.textContent).toContain("this gateway's configured remote inference backends");
    await click("Cancel");
    expect(host.querySelector("[role='dialog']")).toBeNull();
    expect(patchAdminConfig).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("keeps confirmation busy until ready and retries only on a separate click", async () => {
    let finishReadiness;
    getConfig.mockImplementation(() => new Promise((resolve) => { finishReadiness = resolve; }));
    await mount();
    await click("Enable cloud inference…");
    await click("Enable cloud inference");
    expect(patchAdminConfig).toHaveBeenCalledExactlyOnceWith({ inference: { allowRemoteInference: true } });
    expect(button("Enabling…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(button("Retry message")).toBeUndefined();
    expect(onEnabled).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    await act(async () => { finishReadiness({ enabled: true, backend: "codex" }); });
    await vi.waitFor(() => expect(onEnabled).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(host.querySelector("[role='dialog']")).toBeNull();
    expect(host.textContent).toContain("Cloud inference enabled");
    expect(onEnabled).toHaveBeenCalledExactlyOnceWith({ enabled: true, backend: "codex" });
    expect(onRetry).not.toHaveBeenCalled();
    await click("Retry message");
    expect(onRetry).toHaveBeenCalledExactlyOnceWith("Summarize my notes", { deepResearch: true });
  });

  it("keeps a failed write in the modal and permits another confirmation", async () => {
    patchAdminConfig.mockResolvedValueOnce({ ok: false, body: { error: "Permission denied" } });
    await mount();
    await click("Enable cloud inference…");
    await click("Enable cloud inference");
    expect(host.querySelector("[role='dialog'] [role='alert']").textContent).toBe("Permission denied");
    expect(button("Enable cloud inference").disabled).toBe(false);
    expect(getConfig).not.toHaveBeenCalled();
    expect(onEnabled).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    await click("Enable cloud inference");
    expect(patchAdminConfig).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(onEnabled).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(host.querySelector("[role='dialog']")).toBeNull();
    expect(onEnabled).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
