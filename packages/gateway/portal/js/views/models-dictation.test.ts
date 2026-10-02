// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getStatus: vi.fn(), patchAdminConfig: vi.fn() }));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));
import { GatewayDictationSetting } from "./models.js";

const dictation = (overrides = {}) => ({
  visible: true, enabled: false, modelAssigned: true, active: false, maxAudioBytes: 1024, ...overrides,
});

describe("Gateway dictation setting", () => {
  let host, originalDocument, originalWindow;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const mount = async () => {
    await act(async () => { render(h(GatewayDictationSetting, {}), host); });
    await settle();
  };
  const toggle = () => host.querySelector("[role=switch]");

  beforeEach(() => {
    originalDocument = globalThis.document; originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    api.getStatus.mockReset();
    api.patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("renders nothing when the gateway does not support the feature", async () => {
    api.getStatus.mockResolvedValue({ dictation: dictation({ visible: false }) });
    await mount();
    expect(host.textContent).toBe("");

    api.getStatus.mockResolvedValue({ experimental: true });
    await mount();
    expect(host.textContent).toBe("");
  });

  it("shows the default-on setting on a stable gateway", async () => {
    api.getStatus.mockResolvedValue({ experimental: false, dictation: dictation({ enabled: true, active: true }) });
    await mount();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector(".experimental-tag")).toBeNull();
  });

  it("switches the opt-in on through the config and shows the gateway's new state", async () => {
    api.getStatus.mockResolvedValueOnce({ dictation: dictation() })
      .mockResolvedValueOnce({ dictation: dictation({ enabled: true, active: true }) });
    await mount();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).not.toContain("Experimental");
    expect(host.querySelector("h2").textContent).toBe("Transcribe voice notes in the Gateway");
    expect(host.textContent).toContain("When enabled, the raw audio will be sent to your gateway to be transcribed. The watch/phone’s local audio transcription will still be sent as fallback.");

    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(api.patchAdminConfig).toHaveBeenCalledExactlyOnceWith({
      inference: { dictation: { transcribeOnGateway: true } },
    });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("On");
  });

  it("explains why an enabled setting has no effect without a runnable transcriber", async () => {
    api.getStatus.mockResolvedValue({
      dictation: dictation({ enabled: true, modelAssigned: false, reason: "No transcriber model is assigned." }),
    });
    await mount();
    expect(host.textContent).toContain("Not in use yet.");
    expect(host.textContent).toContain("No transcriber model is assigned.");
  });

  it("surfaces a save that could not reach the gateway and re-enables the switch", async () => {
    api.getStatus.mockResolvedValue({ dictation: dictation() });
    api.patchAdminConfig.mockRejectedValue(new Error("network down"));
    await mount();
    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Failed to save the setting.");
    expect(toggle().hasAttribute("disabled")).toBe(false);
  });

  it("keeps the section when a later status read fails", async () => {
    api.getStatus.mockResolvedValueOnce({ dictation: dictation() }).mockRejectedValueOnce(new Error("offline"));
    await mount();
    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(toggle()).toBeTruthy();
  });

  it("surfaces a failed save", async () => {
    api.getStatus.mockResolvedValue({ dictation: dictation() });
    api.patchAdminConfig.mockResolvedValue({ ok: false, body: { error: "Validation failed" } });
    await mount();
    await act(async () => { toggle().dispatchEvent(new window.Event("click")); });
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Validation failed");
  });
});
