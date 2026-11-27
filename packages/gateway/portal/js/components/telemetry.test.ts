// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getTelemetryStatus: vi.fn(), patchAdminConfig: vi.fn() }));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { TelemetryNotice, TelemetrySettings } from "./telemetry.js";

describe("installation telemetry notice", () => {
  let host: HTMLElement;
  const enabled = { enabled: true, configuredEnabled: true, acknowledged: false, forcedDisabled: false, runtimeAllowed: true };

  beforeEach(() => {
    vi.clearAllMocks();
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    vi.stubGlobal("document", parsed.document);
    vi.stubGlobal("window", parsed.window);
    vi.stubGlobal("EventSource", undefined);
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    let saved = { ...enabled };
    api.getTelemetryStatus.mockImplementation(async () => saved);
    api.patchAdminConfig.mockImplementation(async ({ telemetry }) => {
      saved = {
        ...saved,
        ...telemetry,
        ...(telemetry.enabled === undefined ? {} : {
          configuredEnabled: telemetry.enabled,
          enabled: telemetry.enabled && saved.runtimeAllowed && !saved.forcedDisabled,
        }),
      };
      return { ok: true };
    });
  });

  afterEach(() => {
    render(null, host);
    vi.unstubAllGlobals();
  });

  async function mount(component = TelemetryNotice) {
    await act(async () => { render(h(component, {}), host); });
    await vi.waitFor(() => expect(api.getTelemetryStatus).toHaveBeenCalled());
  }

  test("shows a non-modal notice with both choices and exact collection limits", async () => {
    await mount();
    expect(host.querySelector('[role="region"]')).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("Help us improve Omnesis");
    expect(host.textContent).toContain("identifier that changes every month");
    expect(host.textContent).toContain("IP addresses are not retained for analytics");
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.querySelector('a[href="/portal/settings/config"]')).not.toBeNull();
    await vi.waitFor(() => expect(api.patchAdminConfig).toHaveBeenCalledWith({ telemetry: { noticeShown: true } }));
    expect(api.patchAdminConfig).not.toHaveBeenCalledWith({ telemetry: { enabled: true } });
  });

  test("Agree persists only gateway acknowledgement and does not re-enable telemetry", async () => {
    await mount();
    await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
    expect(api.patchAdminConfig).toHaveBeenCalledWith({ telemetry: { acknowledged: true } });
    expect(host.querySelector(".telemetry-notice")).toBeNull();
    // A different browser reads the persisted acknowledgement from the gateway.
    render(null, host);
    api.patchAdminConfig.mockClear();
    api.getTelemetryStatus.mockResolvedValue({ ...enabled, acknowledged: true });
    await mount();
    expect(host.querySelector(".telemetry-notice")).toBeNull();
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
  });

  test("Disable persists disabled preference and acknowledgement before dismissing", async () => {
    await mount();
    await act(async () => { (host.querySelector(".btn-secondary") as HTMLButtonElement).click(); });
    expect(api.patchAdminConfig).toHaveBeenCalledWith({ telemetry: { enabled: false, acknowledged: true } });
    expect(host.querySelector(".telemetry-notice")).toBeNull();
  });

  test.each([
    { ...enabled, enabled: false, configuredEnabled: false },
    { ...enabled, enabled: false, forcedDisabled: true },
    { ...enabled, enabled: false, runtimeAllowed: false },
    { ...enabled, acknowledged: true },
  ])("never prompts when already acknowledged or disabled: %j", async (status) => {
    api.getTelemetryStatus.mockResolvedValue(status);
    await mount();
    expect(host.querySelector(".telemetry-notice")).toBeNull();
  });

  test("does not hide a failed opt-out as if it had been saved", async () => {
    api.patchAdminConfig.mockResolvedValue({ ok: false, status: 500 });
    await mount();
    await act(async () => { (host.querySelector(".btn-secondary") as HTMLButtonElement).click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
    expect(host.querySelector(".telemetry-notice")).not.toBeNull();
    expect((host.querySelector(".btn-secondary") as HTMLButtonElement).disabled).toBe(false);
  });

  test("refreshes another browser's opt-out when this browser becomes visible", async () => {
    await mount();
    api.getTelemetryStatus.mockResolvedValue({ ...enabled, enabled: false });
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    expect(host.querySelector(".telemetry-notice")).toBeNull();
  });

  test("unavailable telemetry status does not interrupt the portal", async () => {
    api.getTelemetryStatus.mockRejectedValue(new Error("Unavailable"));
    await mount();
    expect(host.textContent).toBe("");
  });

  test("a minimal EventSource shim does not interrupt a gateway with telemetry unavailable", async () => {
    vi.stubGlobal("EventSource", class { close() {} });
    api.getTelemetryStatus.mockResolvedValue({ ...enabled, enabled: false, runtimeAllowed: false });
    await mount();
    expect(host.textContent).toBe("");
  });

  test("an unavailable EventSource does not prevent displaying or acknowledging the notice", async () => {
    vi.stubGlobal("EventSource", class { constructor() { throw new Error("Unavailable"); } });
    await mount();
    expect(host.querySelector(".telemetry-notice")).not.toBeNull();
    await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
    expect(host.querySelector(".telemetry-notice")).toBeNull();
  });

  test("Settings explains environment precedence and links telemetry documentation", async () => {
    api.getTelemetryStatus.mockResolvedValue({ ...enabled, enabled: false, forcedDisabled: true });
    await mount(TelemetrySettings);
    expect(host.textContent).toContain("takes precedence over configuration");
    expect(host.querySelector('a[href$="/TELEMETRY.md"]')).not.toBeNull();
    expect((host.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("Settings disables and re-enables the persisted preference with an intentional acknowledgement", async () => {
    await mount(TelemetrySettings);
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    expect(api.patchAdminConfig).toHaveBeenLastCalledWith({ telemetry: { enabled: false, acknowledged: true } });
    expect(host.querySelector("button")?.textContent).toBe("Enable telemetry");
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    expect(api.patchAdminConfig).toHaveBeenLastCalledWith({ telemetry: { enabled: true, acknowledged: true } });
    expect(host.querySelector("button")?.textContent).toBe("Disable telemetry");
  });

  test("acknowledgement hides the explanatory Settings card while preserving preference controls", async () => {
    api.getTelemetryStatus.mockResolvedValue({ ...enabled, acknowledged: true });
    await mount(TelemetrySettings);
    expect(host.querySelector(".telemetry-settings")).toBeNull();
    expect(host.textContent).not.toContain("Minimal installation statistics");
    expect(host.querySelector("button")?.textContent).toBe("Disable telemetry");
    expect(host.querySelector('a[href$="/TELEMETRY.md"]')).not.toBeNull();
  });

  test("Agree dismisses both the notice and Settings explanation when gateway acknowledgement refreshes", async () => {
    const streams: Array<{ onmessage: (() => void) | null }> = [];
    vi.stubGlobal("EventSource", class {
      onmessage: (() => void) | null = null;
      constructor() { streams.push(this); }
      close() {}
    });
    await mount(() => h("div", {}, h(TelemetryNotice, {}), h(TelemetrySettings, {})));
    expect(host.querySelector(".telemetry-settings")).not.toBeNull();
    api.getTelemetryStatus.mockResolvedValue({ ...enabled, acknowledged: true });
    await act(async () => { (host.querySelector(".telemetry-notice .btn-primary") as HTMLButtonElement).click(); });
    await act(async () => { for (const stream of streams) stream.onmessage?.(); });
    expect(host.querySelector(".telemetry-notice")).toBeNull();
    expect(host.querySelector(".telemetry-settings")).toBeNull();
    expect(host.querySelector(".telemetry-preference button")?.textContent).toBe("Disable telemetry");
  });

  test.each(["missing", "unavailable"])("Agree immediately hides the Settings card when live events are %s", async (events) => {
    if (events === "unavailable") vi.stubGlobal("EventSource", class { constructor() { throw new Error("Unavailable"); } });
    await mount(() => h("div", {}, h(TelemetryNotice, {}), h(TelemetrySettings, {})));
    expect(host.querySelector(".telemetry-settings")).not.toBeNull();
    await act(async () => { (host.querySelector(".telemetry-notice .btn-primary") as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(host.querySelector(".telemetry-notice")).toBeNull();
      expect(host.querySelector(".telemetry-settings")).toBeNull();
      expect(host.querySelector(".telemetry-preference button")?.textContent).toBe("Disable telemetry");
    });
  });

  test("Settings cannot overwrite telemetry under an unsaved configuration draft", async () => {
    await act(async () => { render(h(TelemetrySettings, { draftPending: true }), host); });
    await vi.waitFor(() => expect(host.querySelector("button")).not.toBeNull());
    expect((host.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("Save or discard");
    expect(api.patchAdminConfig).not.toHaveBeenCalled();
  });
});
