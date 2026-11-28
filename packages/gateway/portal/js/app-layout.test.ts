// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const {
  clearOmnesisStorage, getPendingAccessRequests, getStatus, listPrivacyApprovals, listSubscriptionApprovals, logout, reload, toggleTheme,
} = vi.hoisted(() => ({
  clearOmnesisStorage: vi.fn(),
  getPendingAccessRequests: vi.fn(async (): Promise<Record<string, unknown>> => ({ pendingRequests: [] })),
  getStatus: vi.fn(async (): Promise<Record<string, unknown>> => ({ experimental: false, developer: false })),
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
  getPendingAccessRequests,
  getStatus,
  getHostFleetUpdate: vi.fn(async () => ({ plan: null, operation: null })),
  isAuthenticated: vi.fn(() => true),
  login: vi.fn(async () => ({ ok: true })),
  logout,
  listPrivacyApprovals,
  listSubscriptionApprovals,
  startHostFleetUpdate: vi.fn(),
}));
vi.mock("./lib/recording-restore-review-api.js", () => ({
  mayRequestRecordingReview: () => true,
  getRecordingRestoreReview: async () => ({ reviewRequired: true, hasPendingChunks: false, keepAudioDays: 0, transcriberAssignment: null, speakers: "off", version: "a".repeat(64) }),
  resumeRecordingRestoreReview: vi.fn(),
}));
vi.mock("./lib/format.js", () => ({ loadSourceMeta: vi.fn(async () => {}) }));
const joins = vi.hoisted(() => ({ tailscaleJoinRequests: vi.fn(async () => ({ requests: [] as unknown[] })) }));
vi.mock("./lib/tailscale-api.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...joins,
}));
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
      ? ({ theme, onThemeToggle, onLogout, onModelsRefresh }: {
        theme?: string;
        onThemeToggle?: () => void;
        onLogout?: () => void;
        onModelsRefresh?: () => void;
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
        h("button", { class: "models-refresh-stub", onClick: onModelsRefresh }, "Refresh models"),
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
    expect(host.querySelector(".app-sidebar")?.textContent).not.toContain("Recordings");
    expect(host.querySelector("[data-recording-restore-notice]")?.textContent).toContain("Restored recordings are paused");
    expect(host.querySelector("[data-recording-restore-notice] a")?.getAttribute("href")).toBe("/portal/settings/storage");
  });

  test("marks Audit while answers wait for review, with the count in words", () => {
    const privacyItem = [...host.querySelectorAll(".sidebar-item")]
      .find((item) => item.textContent?.includes("Audit"));
    const mark = privacyItem?.querySelector(".attention-icon");
    // The sentence is the mark's accessible name, so it is part of the link's.
    expect(mark?.getAttribute("role")).toBe("img");
    expect(mark?.getAttribute("aria-label")).toBe("3 answers are waiting for your review.");
    expect(privacyItem?.getAttribute("href")).toBe("/portal/audit");
  });
});

describe("decisions waiting, marked on the nav item where each is decided", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    // Each case sets its own answers; nothing queued by a sibling may leak in.
    getStatus.mockReset().mockResolvedValue({ experimental: false, developer: false });
    listPrivacyApprovals.mockReset().mockResolvedValue({ totalCount: 0 });
    listSubscriptionApprovals.mockReset().mockResolvedValue({ totalCount: 0 });
    getPendingAccessRequests.mockReset().mockResolvedValue({ pendingRequests: [] });
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

  test("in experimental mode, Recordings stays hidden until its Lab opt-in is on", async () => {
    getStatus.mockResolvedValue({
      experimental: true, developer: false, labAvailable: true,
      lab: { brain: false, tasks: false, watches: true, recordings: false },
    } as never);
    await mount();
    // Watches, on in Lab, shows once the status has been read.
    await vi.waitFor(() => expect(itemNamed("Watches")).toBeDefined());
    expect(itemNamed("Recordings")).toBeUndefined();
  });

  test("Recordings appears once its Lab opt-in is on", async () => {
    getStatus.mockResolvedValue({
      experimental: true, developer: false, labAvailable: true,
      lab: { brain: false, tasks: false, watches: false, recordings: true },
    } as never);
    await mount();
    await vi.waitFor(() => expect(itemNamed("Recordings")?.getAttribute("href")).toBe("/portal/recordings"));
    expect(itemNamed("Watches")).toBeUndefined();
  });

  test("flags Settings and routes directly to Models until runtime health recovers", async () => {
    getStatus.mockResolvedValue({
      experimental: false, developer: false,
      modelHealth: { warnings: [{ role: "agent", message: "Provider quota exceeded." }] },
    } as never);
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".warning-triangle")).not.toBeNull());
    const settings = itemNamed("Settings");
    expect(settings?.querySelector('[aria-label="Models need attention"]')).not.toBeNull();
    expect(settings?.getAttribute("href")).toBe("/portal/settings/models");
    expect(settings?.textContent).not.toContain("quota");
    // The visibility poll refreshes immediately when the operator returns.
    getStatus.mockResolvedValue({ experimental: false, developer: false } as never);
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".warning-triangle")).toBeNull());
    expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings");
  });

  test("prioritizes storage protection on Settings and preserves model warnings after recovery", async () => {
    getStatus.mockResolvedValue({ storagePressure: { state: "blocked" }, modelHealth: { warnings: [{ role: "agent" }] } } as never);
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings/storage"));
    expect(itemNamed("Settings")?.querySelector('[aria-label="Storage needs attention"]')).not.toBeNull();
    getStatus.mockResolvedValue({ storagePressure: { state: "normal" }, modelHealth: { warnings: [{ role: "agent" }] } } as never);
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await vi.waitFor(() => expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings/models"));
  });

  test("keeps storage warnings visible while an expiring device approval leads Settings", async () => {
    joins.tailscaleJoinRequests.mockResolvedValue({ requests: [{
      id: "waiting-storage-device", name: "Example collector", kind: "collector", machine: "example-machine",
      login: "maya@example.com", requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }] });
    getStatus.mockResolvedValue({ tailscaleEmbed: true, storagePressure: {state: "blocked"},
      modelHealth: {warnings: [{role: "agent"}]} } as never);
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings/devices"));
    expect(itemNamed("Settings")?.querySelector('[aria-label="Storage needs attention"]')).not.toBeNull();
    expect(itemNamed("Settings")?.querySelector(".attention-icon")).not.toBeNull();
    joins.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await vi.waitFor(() => expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings/storage"));
    expect(itemNamed("Settings")?.querySelector('[aria-label="Storage needs attention"]')).not.toBeNull();
  });

  test("flags Settings and its route with devices waiting for approval, and clears when none wait", async () => {
    const waiting = {
      id: "j1",
      name: "studio-mac",
      kind: "collector",
      machine: "studio-mac",
      login: "maya@example.com",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    joins.tailscaleJoinRequests.mockResolvedValue({ requests: [waiting] });
    getStatus.mockResolvedValue({ experimental: false, developer: false, tailscaleEmbed: true } as never);
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".attention-icon")).not.toBeNull());
    const settings = itemNamed("Settings");
    expect(
      settings?.querySelector('[aria-label="A device is waiting for your approval to pair to this gateway."]'),
    ).not.toBeNull();
    expect(settings?.getAttribute("href")).toBe("/portal/settings/devices");
    // The next read finds nothing waiting: the mark and the shortcut go.
    joins.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".attention-icon")).toBeNull());
    expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings");
  });

  test("without either way for devices to ask, nothing is read for them", async () => {
    joins.tailscaleJoinRequests.mockClear();
    getStatus.mockResolvedValue({ experimental: false, developer: false } as never);
    await mount();
    expect(joins.tailscaleJoinRequests).not.toHaveBeenCalled();
    expect(itemNamed("Settings")?.querySelector(".attention-icon")).toBeNull();
  });

  test("refreshes authoritative status after Models reads instead of accepting an old overview", async () => {
    getStatus.mockResolvedValue({
      experimental: false, developer: false,
      modelHealth: { warnings: [{ role: "agent" }] },
    } as never);
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".warning-triangle")).not.toBeNull());
    getStatus.mockResolvedValue({ experimental: false, developer: false } as never);
    await act(async () => { (host.querySelector(".models-refresh-stub") as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".warning-triangle")).toBeNull());
  });

  test("nothing waiting, nothing marked", async () => {
    listPrivacyApprovals.mockResolvedValue({ totalCount: 0 });
    await mount();
    expect(host.querySelector(".attention-icon")).toBeNull();
  });

  test("agents waiting for access mark Settings, which then opens Access", async () => {
    getPendingAccessRequests.mockResolvedValue({
      pendingRequests: [{ id: "r1", clientName: "Fictional planner", expiresAt: Date.now() + 300_000 }],
    });
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".attention-icon")).not.toBeNull());
    expect(itemNamed("Settings")?.querySelector(".attention-icon")?.getAttribute("aria-label"))
      .toBe("An agent is waiting for your approval to connect.");
    expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings/access");
  });

  test("a waiting decision leads Settings ahead of a model problem, which keeps its triangle", async () => {
    getStatus.mockResolvedValue({
      experimental: false, developer: false,
      modelHealth: { warnings: [{ role: "agent" }] },
    } as never);
    getPendingAccessRequests.mockResolvedValue({
      pendingRequests: [{ id: "r1", clientName: "Fictional planner", expiresAt: Date.now() + 300_000 }],
    });
    await mount();
    await vi.waitFor(() => expect(itemNamed("Settings")?.querySelector(".attention-icon")).not.toBeNull());
    expect(itemNamed("Settings")?.querySelector(".warning-triangle")).not.toBeNull();
    expect(itemNamed("Settings")?.getAttribute("href")).toBe("/portal/settings/access");
  });

  test("normal gateways have no test card", async () => {
    await mount();
    expect(host.querySelector(".sidebar-test-instance")).toBeNull();
  });

  test("an unlabelled test gateway still identifies itself", async () => {
    getStatus.mockResolvedValue({ testInstance: {} } as never);
    await mount();
    await vi.waitFor(() => expect(host.querySelector(".sidebar-test-instance")).not.toBeNull());
    const card = host.querySelector(".sidebar-test-instance");
    expect(card?.textContent?.trim()).toBe("Test gateway");
    expect(card?.parentElement?.id).toBe("global-navigation-panel");
    expect(host.querySelector(".sidebar-brand")).not.toBeNull();
    expect(card?.nextElementSibling?.className).toBe("sidebar-nav");
  });

  test("shows session and purpose as text, including HTML-looking labels", async () => {
    const session = '<img src=x onerror="alert(1)">';
    const purpose = "Review the new filters & keyboard navigation";
    getStatus.mockResolvedValue({ testInstance: { session, purpose } } as never);
    await mount();
    await vi.waitFor(() => expect(host.querySelector(".sidebar-test-instance")).not.toBeNull());
    const card = host.querySelector(".sidebar-test-instance");
    expect(card?.textContent).toContain(session);
    expect(card?.textContent).toContain(purpose);
    expect(card?.querySelector("img")).toBeNull();
    expect(card?.textContent).toContain("Session");
    expect(card?.textContent).toContain("Purpose");
  });

  test("partial labels omit empty fields and preserve long labels", async () => {
    const purpose = "test-feature-".repeat(40);
    getStatus.mockResolvedValue({ testInstance: { session: "  ", purpose } } as never);
    await mount();
    await vi.waitFor(() => expect(host.querySelector(".sidebar-test-instance")).not.toBeNull());
    const card = host.querySelector(".sidebar-test-instance");
    expect(card?.textContent).not.toContain("Session");
    expect(card?.textContent).toContain(purpose);
  });

  test("demo mode hides test identity and release cards while preserving navigation", async () => {
    getStatus.mockResolvedValue({
      demo: true,
      testInstance: { purpose: "Try navigation" },
      release: {
        currentVersion: "1.4.0",
        latestVersion: "1.5.0",
        installMethod: "source",
        checkedAt: "2026-09-07T12:00:00.000Z",
        updateAvailable: true,
      },
    } as never);
    await mount();
    expect(host.querySelector(".sidebar-test-instance")).toBeNull();
    expect(host.querySelector(".sidebar-release")).toBeNull();
    expect(host.querySelector(".sidebar-nav")?.textContent).toContain("Sources");
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

  const markOn = (label: string) => itemNamed(label)?.querySelector(".attention-icon")?.getAttribute("aria-label");

  test("one answer reads in the singular", async () => {
    listPrivacyApprovals.mockResolvedValue({ totalCount: 1 });
    await mount();
    await vi.waitFor(() => expect(markOn("Audit")).toBe("An answer is waiting for your review."));
  });

  test("the mark's sentence carries the true count, however many", async () => {
    listPrivacyApprovals.mockResolvedValue({ totalCount: 140 });
    await mount();
    await vi.waitFor(() => expect(markOn("Audit")).toBe("140 answers are waiting for your review."));
  });

  test("a gateway without the privacy boundary shows no mark and no error", async () => {
    listPrivacyApprovals.mockRejectedValue({ status: 503 });
    await mount();
    expect(host.querySelector(".attention-icon")).toBeNull();
    expect(host.querySelector(".app-sidebar")?.textContent).not.toMatch(/503|error/i);
  });

  test("watch requests mark Watches, not Audit, and only where watches are on", async () => {
    getStatus.mockResolvedValue({ experimental: true, developer: false, lab: { brain: false, tasks: false, watches: true } });
    listPrivacyApprovals.mockResolvedValue({ totalCount: 2 });
    listSubscriptionApprovals.mockResolvedValue({ totalCount: 5 });
    await mount();
    await vi.waitFor(() => expect(markOn("Watches")).toBe("5 watch requests are waiting for your approval."));
    await vi.waitFor(() => expect(markOn("Audit")).toBe("2 answers are waiting for your review."));
    expect(itemNamed("Watches")?.getAttribute("href")).toBe("/portal/watches");
  });

  test("one endpoint failing cannot hide the other's waiting decisions", async () => {
    getStatus.mockResolvedValue({ experimental: true, developer: false, lab: { brain: false, tasks: false, watches: true } });
    listPrivacyApprovals.mockResolvedValue({ totalCount: 3 });
    listSubscriptionApprovals.mockRejectedValue({ status: 503 });
    await mount();
    await vi.waitFor(() => expect(markOn("Audit")).toBe("3 answers are waiting for your review."));
    expect(markOn("Watches")).toBeUndefined();
  });
  test("experimental mode alone does not offer Tasks or Watches", async () => {
    getStatus.mockResolvedValue({ experimental: true, tasks: { available: true }, lab: { brain: false, tasks: false, watches: false } });
    await mount();
    expect(itemNamed("Tasks")).toBeUndefined();
    expect(itemNamed("Watches")).toBeUndefined();
    expect(listSubscriptionApprovals).not.toHaveBeenCalled();
  });

});
