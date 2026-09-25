// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const router = vi.hoisted(() => ({ replaceRoute: vi.fn() }));

vi.mock("../lib/lazy.js", () => ({
  lazy: () => () => h("div", { class: "stub-settings-tab" }),
}));
vi.mock("../lib/router.js", () => router);

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { SettingsView } from "./settings.js";

describe("Settings header actions", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
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

  test("renders logout in the settings header and invokes the app handler", async () => {
    const onLogout = vi.fn();
    await act(async () => {
      render(h(SettingsView, { tab: "config", onLogout }), host);
    });

    const header = host.querySelector(".settings-header");
    const button = header?.querySelector("button.settings-logout-btn") as HTMLButtonElement | null;
    expect(button?.textContent?.trim()).toBe("Logout");

    button?.click();
    expect(onLogout).toHaveBeenCalledOnce();
  });

  test("renders the theme toggle immediately left of logout", async () => {
    const onThemeToggle = vi.fn();
    await act(async () => {
      render(h(SettingsView, { tab: "config", theme: "dark", onThemeToggle }), host);
    });

    const buttons = host.querySelectorAll(".settings-actions > button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.classList.contains("settings-theme-btn")).toBe(true);
    expect(buttons[0]?.textContent?.trim()).toBe("Light mode");
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Switch to light mode");
    expect(buttons[1]?.classList.contains("settings-logout-btn")).toBe(true);

    (buttons[0] as HTMLButtonElement).click();
    expect(onThemeToggle).toHaveBeenCalledOnce();

    await act(async () => {
      render(h(SettingsView, { tab: "config", theme: "light", onThemeToggle }), host);
    });
    expect(host.querySelector(".settings-theme-btn")?.textContent?.trim()).toBe("Dark mode");
  });

  test("offers the Policies tab between Access and Devices, and walks back to the list from an editor", async () => {
    await act(async () => {
      render(h(SettingsView, { tab: "policies", policyId: "policy-a" }), host);
    });

    const labels = [...host.querySelectorAll(".config-tab")]
      .map((tab) => tab.textContent?.trim());
    const access = labels.indexOf("Access");
    expect(access).toBeGreaterThan(-1);
    expect(labels[access + 1]).toBe("Policies");
    expect(labels[access + 2]).toBe("Devices");

    // This tab labels both the list and one policy's editor, so
    // clicking it from the editor walks back to the list.
    const policiesTab = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Policies") as HTMLButtonElement;
    await act(async () => { policiesTab.click(); });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/policies");
  });

  test("walks back to the access inventory from every page the Access tab opens", async () => {
    const accessTab = () => [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Access") as HTMLButtonElement;

    for (const page of [
      { accessLevelId: "level-1" },
      { accessNewLevel: true },
      { accessAuthorizationId: "approval-1" },
      { accessConnect: true },
    ]) {
      vi.clearAllMocks();
      await act(async () => { render(h(SettingsView, { tab: "access", ...page }), host); });
      await act(async () => { accessTab().click(); });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
    }

    // The inventory itself is where the tab already is: clicking it there
    // does not push the address around.
    vi.clearAllMocks();
    await act(async () => { render(h(SettingsView, { tab: "access" }), host); });
    await act(async () => { accessTab().click(); });
    expect(router.replaceRoute).not.toHaveBeenCalled();
  });
});
