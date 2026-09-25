// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const {
  clearOmnesisStorage, getStatus, listPrivacyApprovals, listSubscriptionApprovals, logout, reload, toggleTheme,
} = vi.hoisted(() => ({
  clearOmnesisStorage: vi.fn(),
  getStatus: vi.fn(async () => ({ experimental: false, developer: false })),
  listPrivacyApprovals: vi.fn(async () => ({ totalCount: 3 })),
  listSubscriptionApprovals: vi.fn(async () => ({ totalCount: 0 })),
  logout: vi.fn(async () => {}),
  reload: vi.fn(),
  toggleTheme: vi.fn(() => "light"),
}));

vi.mock("./api.js", () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ conversations: [], nextCursor: null }),
  })),
  checkSession: vi.fn(async () => ({ authenticated: true })),
  getStatus,
  getHostFleetUpdate: vi.fn(async () => ({ plan: null, operation: null })),
  isAuthenticated: vi.fn(() => true),
  login: vi.fn(async () => ({ ok: true })),
  logout,
  listPrivacyApprovals,
  listSubscriptionApprovals,
  startHostFleetUpdate: vi.fn(),
}));
vi.mock("./lib/format.js", () => ({ loadSourceMeta: vi.fn(async () => {}) }));
vi.mock("./lib/router.js", () => ({
  navigate: vi.fn(),
  onRouteChange: vi.fn(() => () => {}),
  parseRoute: vi.fn(() => ({ view: "settings", tab: "config", modelsSection: null })),
  replaceUrl: vi.fn(),
}));
vi.mock("./lib/storage.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  clearOmnesisStorage,
}));
vi.mock("./lib/theme.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getTheme: vi.fn(() => "dark"),
  toggleTheme,
}));
vi.mock("./lib/lazy.js", () => ({
  lazy: (load: () => unknown) => {
    return load.toString().includes("/views/settings.js")
      ? ({ theme, onThemeToggle, onLogout }: {
        theme?: string;
        onThemeToggle?: () => void;
        onLogout?: () => void;
      }) => h("div", { class: "settings-actions" },
        h(
          "button",
          { type: "button", class: "settings-theme-btn", onClick: onThemeToggle },
          theme === "light" ? "Dark mode" : "Light mode",
        ),
        h(
          "button",
          { type: "button", class: "settings-logout-btn", onClick: onLogout },
          "Logout",
        ),
      )
      : () => null;
  },
}));

describe("portal Settings actions", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeAll(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true,
      value: { href: "https://localhost/portal/settings/config", reload },
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#app") as unknown as HTMLElement;

    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    await import("./app.js");
    await vi.waitFor(() => expect(host.querySelector(".app-layout")).not.toBeNull());
  });

  afterAll(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("removes logout from the sidebar and wires it through Settings", async () => {
    expect(host.querySelector(".app-sidebar")?.textContent).not.toContain("Logout");

    const button = host.querySelector(".app-main .settings-logout-btn") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(logout).toHaveBeenCalledOnce();
    expect(clearOmnesisStorage).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  test("removes the theme toggle from the sidebar and wires it through Settings", async () => {
    expect(host.querySelector(".app-sidebar")?.textContent).not.toContain("Light mode");

    const button = host.querySelector(".app-main .settings-theme-btn") as HTMLButtonElement;
    expect(button.textContent).toBe("Light mode");
    await act(async () => {
      button.click();
    });

    expect(toggleTheme).toHaveBeenCalledOnce();
    expect(button.textContent).toBe("Dark mode");
  });

  test("shows Audit and the capture row when experimental mode is disabled", () => {
    expect(host.querySelector(".app-sidebar")?.textContent).toContain("Audit");
    expect(host.querySelector(".app-sidebar")?.textContent).toMatch(/tell omnesis/i);
    expect(host.querySelector(".app-sidebar")?.textContent).not.toContain("Watches");
  });

  test("badges Audit with the decisions waiting, and says so in words", () => {
    const badge = host.querySelector(".sidebar-badge");
    expect(badge?.textContent).toBe("3");
    // The numeral is decorative; the sentence beside it is what a screen
    // reader meets inside the link's accessible name.
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    const privacyItem = [...host.querySelectorAll(".sidebar-item")]
      .find((item) => item.textContent?.includes("Audit"));
    expect(privacyItem?.querySelector(".sr-only")?.textContent)
      .toContain("3 decisions waiting for you");
  });
});

describe("decisions waiting, badged on the nav item where each is decided", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    // Each case sets its own answers; nothing queued by a sibling may leak in.
    getStatus.mockReset().mockResolvedValue({ experimental: false, developer: false });
    listPrivacyApprovals.mockReset().mockResolvedValue({ totalCount: 0 });
    listSubscriptionApprovals.mockReset().mockResolvedValue({ totalCount: 0 });
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true,
      value: { href: "https://localhost/portal/settings/config", reload },
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#app") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  function itemNamed(label: string) {
    return [...host.querySelectorAll(".sidebar-item")].find((item) => item.textContent?.includes(label));
  }

  // app.js renders itself on import, so each case is a fresh import into a
  // fresh document.
  async function mount() {
    vi.resetModules();
    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    await import("./app.js");
    await vi.waitFor(() => expect(host.querySelector(".app-layout")).not.toBeNull());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  test("nothing waiting, nothing badged", async () => {
    listPrivacyApprovals.mockResolvedValue({ totalCount: 0 });
    await mount();
    expect(host.querySelector(".sidebar-badge")).toBeNull();
  });

  test("shows a quiet sidebar notice for a newer release", async () => {
    getStatus.mockResolvedValue({
      experimental: false,
      developer: false,
      release: {
        currentVersion: "1.4.0",
        latestVersion: "1.5.0",
        installMethod: "source",
        checkedAt: "2026-09-07T12:00:00.000Z",
        updateAvailable: true,
      },
    } as never);
    await mount();

    await vi.waitFor(() => expect(host.querySelector(".sidebar-release")).not.toBeNull());
    expect(host.querySelector(".sidebar-release")?.textContent).toContain("Omnesis 1.5.0 is available");
    expect(host.querySelector(".sidebar-release code")?.textContent).toBe("omnesis update --fleet");
  });

  test("malformed or failed status reads leave no release notice", async () => {
    getStatus.mockResolvedValue({
      experimental: false,
      developer: false,
      release: {
        currentVersion: "1.4.0",
        latestVersion: "1.5.0-beta.1",
        installMethod: "source",
        checkedAt: "2026-09-07T12:00:00.000Z",
        updateAvailable: true,
      },
    } as never);
    await mount();
    expect(host.querySelector(".sidebar-release")).toBeNull();

    render(null, host);
    getStatus.mockRejectedValue(new Error("unavailable"));
    await mount();
    expect(host.querySelector(".sidebar-release")).toBeNull();
    expect(host.querySelector(".app-sidebar")?.textContent).not.toMatch(/unavailable|error/i);
  });

  test("one decision reads in the singular", async () => {
    listPrivacyApprovals.mockResolvedValue({ totalCount: 1 });
    await mount();
    await vi.waitFor(() =>
      expect(itemNamed("Audit")?.querySelector(".sr-only")?.textContent).toContain("1 decision waiting for you"));
  });

  test("the pill caps at 99+ while the sentence keeps the true count", async () => {
    listPrivacyApprovals.mockResolvedValue({ totalCount: 140 });
    await mount();
    await vi.waitFor(() => expect(itemNamed("Audit")?.querySelector(".sidebar-badge")?.textContent).toBe("99+"));
    expect(itemNamed("Audit")?.querySelector(".sr-only")?.textContent).toContain("140 decisions waiting for you");
  });

  test("a gateway without the privacy boundary shows no badge and no error", async () => {
    listPrivacyApprovals.mockRejectedValue({ status: 503 });
    await mount();
    expect(host.querySelector(".sidebar-badge")).toBeNull();
    expect(host.querySelector(".app-sidebar")?.textContent).not.toMatch(/503|error/i);
  });

  test("watch requests badge Watches, not Audit, and only in experimental mode", async () => {
    getStatus.mockResolvedValue({ experimental: true, developer: false });
    listPrivacyApprovals.mockResolvedValue({ totalCount: 2 });
    listSubscriptionApprovals.mockResolvedValue({ totalCount: 5 });
    await mount();
    await vi.waitFor(() => expect(itemNamed("Watches")?.querySelector(".sidebar-badge")?.textContent).toBe("5"));
    await vi.waitFor(() => expect(itemNamed("Audit")?.querySelector(".sidebar-badge")?.textContent).toBe("2"));
  });

  test("one endpoint failing cannot hide the other's waiting decisions", async () => {
    getStatus.mockResolvedValue({ experimental: true, developer: false });
    listPrivacyApprovals.mockResolvedValue({ totalCount: 3 });
    listSubscriptionApprovals.mockRejectedValue({ status: 503 });
    await mount();
    await vi.waitFor(() => expect(itemNamed("Audit")?.querySelector(".sidebar-badge")?.textContent).toBe("3"));
    expect(itemNamed("Watches")?.querySelector(".sidebar-badge")).toBeNull();
  });
});
