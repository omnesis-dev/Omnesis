// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const router = vi.hoisted(() => ({ replaceRoute: vi.fn() }));
const lazyTab = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("../lib/lazy.js", () => ({
  lazy: () => (props: Record<string, unknown>) => {
    lazyTab.render(props);
    return h("div", { class: "stub-settings-tab" });
  },
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

  const attention = (devices: number, access: number) => ({
    devices: { cloud: [], tailscale: [], count: devices },
    access: { requests: [], count: access },
    answers: { count: 0 },
    watches: { count: 0 },
  });

  test("marks the Devices tab while devices wait for approval, with the count in words", async () => {
    await act(async () => {
      render(h(SettingsView, { tab: "config", attention: attention(2, 0) }), host);
    });
    const mark = host.querySelector(
      '.config-tab .attention-icon[aria-label="2 devices are waiting for your approval to pair to this gateway."]',
    );
    expect(mark).not.toBeNull();
    expect(mark?.closest("button")?.textContent).toContain("Devices");
    expect(host.querySelectorAll(".config-tab .attention-icon")).toHaveLength(1);
    await act(async () => {
      render(h(SettingsView, { tab: "config", attention: attention(0, 0) }), host);
    });
    expect(host.querySelector(".config-tab .attention-icon")).toBeNull();
  });

  test("marks the Access tab while agents wait for approval, beside a Devices mark when both wait", async () => {
    await act(async () => {
      render(h(SettingsView, { tab: "config", attention: attention(1, 3) }), host);
    });
    const access = host.querySelector(
      '.config-tab .attention-icon[aria-label="3 agents are waiting for your approval to connect."]',
    );
    expect(access?.closest("button")?.textContent).toContain("Access");
    expect(host.querySelectorAll(".config-tab .attention-icon")).toHaveLength(2);
  });

  test("without an attention answer no tab is marked", async () => {
    await act(async () => {
      render(h(SettingsView, { tab: "config" }), host);
    });
    expect(host.querySelector(".config-tab .attention-icon")).toBeNull();
  });

  test("marks the Models tab while another settings page is open and clears on recovery", async () => {
    await act(async () => {
      render(
        h(SettingsView, { tab: "config", modelHealth: { warnings: [{ role: "agent" }] } }),
        host,
      );
    });
    const warning = host.querySelector('.config-tab [aria-label="Models need attention"]');
    expect(warning).not.toBeNull();
    const tab = warning?.closest("button") as HTMLButtonElement;
    await act(async () => {
      tab.click();
    });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/models");
    await act(async () => {
      render(h(SettingsView, { tab: "config", modelHealth: { warnings: [] } }), host);
    });
    expect(host.querySelector(".warning-triangle")).toBeNull();
  });

  test("marks Storage independently and clears after recovery", async () => {
    await act(async () => { render(h(SettingsView, { tab: "config", storagePressure: { state: "blocked" } }), host); });
    const warning = host.querySelector('[aria-label="Storage needs attention"]');
    expect(warning).not.toBeNull();
    await act(async () => { (warning?.closest("button") as HTMLButtonElement).click(); });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/storage");
    await act(async () => { render(h(SettingsView, { tab: "config", storagePressure: { state: "normal" } }), host); });
    expect(host.querySelector('[aria-label="Storage needs attention"]')).toBeNull();
  });

  test("storage, model and approval marks remain independent on their settings tabs", async () => {
    await act(async () => {
      render(h(SettingsView, {tab: "config", storagePressure: {state: "blocked"},
        modelHealth: {warnings: [{role: "agent"}]}, attention: attention(1, 1)}), host);
    });
    expect(host.querySelector('[aria-label="Storage needs attention"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Models need attention"]')).not.toBeNull();
    expect(host.querySelectorAll(".config-tab .attention-icon")).toHaveLength(2);
    expect(host.querySelectorAll(".config-tab .warning-triangle")).toHaveLength(2);
  });

  test("every gateway has the Connectivity tab, last, and the pages behind it that need no feature", async () => {
    const labels = () => [...host.querySelectorAll(".config-tab")].map((tab) => tab.textContent?.trim());
    for (const flags of [{}, { tailscaleEmbed: true }]) {
      await act(async () => { render(h(SettingsView, { tab: "connectivity", ...flags }), host); });
      expect(host.querySelector(".settings-view")?.getAttribute("class")).toBe("settings-view");
      expect(labels().at(-1)).toBe("Connectivity");
      for (const detail of ["Omnesis account", "Omnesis relay", "Tailscale", "Tailscale on this computer", "Your own domain", "MCP server"]) {
        expect(labels()).not.toContain(detail);
      }
      expect(host.querySelector(".config-tab.active")?.textContent).toBe("Connectivity");
      expect(host.querySelector(".remote-access-back")).toBeNull();
    }
    for (const tab of ["host-tailscale", "own-address", "mcp"]) {
      await act(async () => { render(h(SettingsView, { tab }), host); });
      expect(host.querySelector(".config-tab.active")?.textContent).toBe("Connectivity");
      expect(host.querySelector(".remote-access-back")?.textContent).toBe("← Connectivity");
    }
  });

  test("each detail page shows Connectivity as current, with the way back to it", async () => {
    const pages = [
      ["account", {}],
      ["relay", {}],
      ["tailscale", { tailscaleEmbed: true }],
      ["host-tailscale", {}],
      ["own-address", {}],
      ["mcp", {}],
    ] as const;
    for (const [tab, flags] of pages) {
      router.replaceRoute.mockClear();
      await act(async () => { render(h(SettingsView, { tab, ...flags }), host); });
      expect(host.querySelector(".config-tab.active")?.textContent).toBe("Connectivity");
      const back = host.querySelector(".remote-access-back") as HTMLButtonElement;
      expect(back.textContent).toBe("← Connectivity");
      await act(async () => { back.click(); });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/connectivity");
      // The tab itself walks back up from its detail page too.
      router.replaceRoute.mockClear();
      const current = host.querySelector(".config-tab.active") as HTMLButtonElement;
      await act(async () => { current.click(); });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/connectivity");
    }
    // A page that needs a feature the gateway lacks lands on Config.
    for (const [tab, flags] of [["tailscale", {}]] as const) {
      await act(async () => { render(h(SettingsView, { tab, ...flags }), host); });
      expect(host.querySelector(".config-tab.active")?.textContent).toBe("Config");
      expect(host.querySelector(".remote-access-back")).toBeNull();
    }
    // On the Connectivity tab itself, re-selecting the tab stays put.
    router.replaceRoute.mockClear();
    await act(async () => { render(h(SettingsView, { tab: "connectivity" }), host); });
    await act(async () => { (host.querySelector(".config-tab.active") as HTMLButtonElement).click(); });
    expect(router.replaceRoute).not.toHaveBeenCalled();
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

    const labels = [...host.querySelectorAll(".config-tab")].map((tab) => tab.textContent?.trim());
    const access = labels.indexOf("Access");
    expect(access).toBeGreaterThan(-1);
    expect(labels[access + 1]).toBe("Policies");
    expect(labels[access + 2]).toBe("Devices");

    // This tab labels both the list and one policy's editor, so
    // clicking it from the editor walks back to the list.
    const policiesTab = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Policies",
    ) as HTMLButtonElement;
    await act(async () => {
      policiesTab.click();
    });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/policies");
  });

  test("keeps new and existing access levels inside Settings with the Access tab selected", async () => {
    for (const page of [{ accessLevelId: "level-1" }, { accessNewLevel: true }]) {
      vi.clearAllMocks();
      await act(async () => {
        render(h(SettingsView, { tab: "access", ...page }), host);
      });
      expect(host.querySelector(".settings-view--access-task > .stub-settings-tab")).not.toBeNull();
      expect(host.querySelector(".settings-header")).not.toBeNull();
      expect(host.querySelector(".config-tab.active")?.textContent?.trim()).toBe("Access");
      expect(lazyTab.render).toHaveBeenLastCalledWith({
        authorizationId: null,
        levelId: "accessLevelId" in page ? page.accessLevelId : null,
        newLevel: "accessNewLevel" in page ? page.accessNewLevel : false,
        connectOpen: false,
        completeInPortal: false,
        tailscaleEmbed: false,
      });
      expect(router.replaceRoute).not.toHaveBeenCalled();
      const accessTab = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Access",
      ) as HTMLButtonElement;
      await act(async () => {
        accessTab.click();
      });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
    }
  });

  test("walks back to the access inventory from authorization and connection pages", async () => {
    const accessTab = () =>
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Access",
      ) as HTMLButtonElement;

    for (const page of [{ accessAuthorizationId: "approval-1" }, { accessConnect: true }]) {
      vi.clearAllMocks();
      await act(async () => {
        render(h(SettingsView, { tab: "access", ...page }), host);
      });
      await act(async () => {
        accessTab().click();
      });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
    }

    // The inventory itself is where the tab already is: clicking it there
    // does not push the address around.
    vi.clearAllMocks();
    await act(async () => {
      render(h(SettingsView, { tab: "access" }), host);
    });
    await act(async () => {
      accessTab().click();
    });
    expect(router.replaceRoute).not.toHaveBeenCalled();
  });
  test("offers Lab after Config and withholds Sweeps when Brain is off", async () => {
    await act(async () => {
      render(h(SettingsView, { tab: "sweeps", experimental: true, labAvailable: true, lab: { brain: false } }), host);
    });
    const labels = [...host.querySelectorAll(".config-tab")].map((tab) => tab.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual(["Config", "Omnesis Lab"]);
    expect(labels).not.toContain("Sweeps");
    expect(host.querySelector('.config-tab.active')?.textContent).toBe("Config");
    await act(async () => {
      render(h(SettingsView, { tab: "lab", experimental: false, lab: { brain: false } }), host);
    });
    expect(host.textContent).not.toContain("Omnesis Lab");
  });

  test("cloud account access preserves Lab order and Brain-off deep-link fallback", async () => {
    const flags = { experimental: true, labAvailable: true, lab: { brain: false } };
    await act(async () => { render(h(SettingsView, { tab: "account", ...flags }), host); });
    const labels = [...host.querySelectorAll(".config-tab")].map((tab) => tab.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual(["Config", "Omnesis Lab"]);
    expect(labels).not.toContain("Sweeps");
    expect(host.querySelector(".config-tab.active")?.textContent).toBe("Connectivity");
    for (const tab of ["sweeps", "lab"]) {
      await act(async () => {
        render(h(SettingsView, { ...flags, tab, labAvailable: false }), host);
      });
      expect(host.querySelector(".config-tab.active")?.textContent).toBe("Config");
    }
  });

});
