// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// SourcesView wiring for the phone-app promos: the iOS and Android cards
// appear together, only after loading, only without any mobile-pushed
// source — a source from either phone hides both.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getAdminSources: vi.fn(async (): Promise<{ items: ReturnType<typeof gmailRow>[] }> => ({ items: [] })),
  getAdminSyncStatus: vi.fn(async () => ({ items: [] })),
  getOverallStatus: vi.fn(async () => ({})),
  getIndexStats: vi.fn(async () => null),
  listDevices: vi.fn(async () => ({ items: [] })),
  triggerSourceSync: vi.fn(),
  joinSourceMember: vi.fn(),
  detachSourceMember: vi.fn(),
  getSourceDebug: vi.fn(),
  getSourceWatermark: vi.fn(),
  resyncSource: vi.fn(),
  removeAdminSource: vi.fn(),
  pauseSource: vi.fn(),
  resumeSource: vi.fn(),
  getSourceDescriptorsUnion: vi.fn(async () => ({ items: [] })),
}));

vi.mock("../api.js", () => apiMocks);

// @ts-expect-error — portal is plain JS without sibling declarations.
import { SourcesView } from "./sources.js";

// A desktop UA built from single-word tokens only, so the PII guard has no
// product-name bigrams to flag.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function gmailRow() {
  return { id: "gmail", type: "gmail", accountId: "a", deviceId: "device-12345678", enabled: true };
}

function appleHealthRow() {
  return {
    id: "apple-health:local",
    type: "apple-health",
    accountId: "local",
    deviceId: "device-12345678",
    enabled: true,
  };
}

function healthConnectRow() {
  return {
    id: "health-connect:phone",
    type: "health-connect",
    accountId: "phone",
    deviceId: "device-12345678",
    enabled: true,
  };
}

describe("SourcesView phone-app promos", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalNavigator: typeof globalThis.navigator | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalNavigator = globalThis.navigator;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: CHROME_UA },
      configurable: true,
      writable: true,
    });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    apiMocks.getAdminSources.mockResolvedValue({ items: [gmailRow()] });
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  test("shows both promos after loading when no mobile source exists", async () => {
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Get the iPhone app"),
    );
    expect(host.textContent).toContain("Get the Android app");
    await act(async () => {
      (host.querySelector(".android-promo .ext-promo-open") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".android-promo-pair")?.getAttribute("href")).toBe(
      "/portal/settings/devices?pair=android",
    );
    await act(async () => {
      (host.querySelector(".android-promo .modal-close") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".modal-panel")).toBeNull();
    await act(async () => {
      (host.querySelector(".ios-promo .ext-promo-open") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".ios-promo-install")?.getAttribute("target")).toBe("_blank");
    expect(host.querySelector(".ios-promo-pair")?.getAttribute("href")).toBe(
      "/portal/settings/devices?pair=ios",
    );
  });

  test("hides both promos once an iOS source exists", async () => {
    apiMocks.getAdminSources.mockResolvedValue({ items: [gmailRow(), appleHealthRow()] });
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading…"));
    expect(host.textContent).not.toContain("Get the iPhone app");
    expect(host.textContent).not.toContain("Get the Android app");
  });

  test("hides both promos once an Android source exists", async () => {
    apiMocks.getAdminSources.mockResolvedValue({ items: [gmailRow(), healthConnectRow()] });
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading…"));
    expect(host.textContent).not.toContain("Get the iPhone app");
    expect(host.textContent).not.toContain("Get the Android app");
  });

  test("withholds the promos while loading", async () => {
    apiMocks.getAdminSources.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    expect(host.textContent).toContain("Loading…");
    expect(host.querySelector(".ios-promo")).toBeNull();
    expect(host.querySelector(".android-promo")).toBeNull();
  });

  test("all three promos share one row: Chrome, then iOS, then Android", async () => {
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() =>
      expect(host.querySelector(".sources-promo-row")).not.toBeNull(),
    );
    const row = host.querySelector(".sources-promo-row") as HTMLElement;
    const cards = [...row.children].filter((el) => el.classList.contains("ext-promo"));
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain("Install the Chrome extension");
    expect(cards[1].textContent).toContain("Get the iPhone app");
    expect(cards[2].textContent).toContain("Get the Android app");
  });

  test("without the Chrome promo the row holds only the phone-app cards", async () => {
    apiMocks.getAdminSources.mockResolvedValue({
      items: [gmailRow(), { id: "web", type: "web", accountId: "", deviceId: "device-12345678", enabled: true }],
    });
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading…"));
    const row = host.querySelector(".sources-promo-row") as HTMLElement;
    expect([...row.children].filter((el) => el.classList.contains("ext-promo"))).toHaveLength(2);
    expect(row.textContent).toContain("Get the iPhone app");
    expect(row.textContent).toContain("Get the Android app");
    expect(row.textContent).not.toContain("Install the Chrome extension");
  });
});
