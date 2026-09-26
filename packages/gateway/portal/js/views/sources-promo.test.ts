// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// SourcesView wiring for the browser-extension promo: the card appears only
// after loading and only without a `web` source.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getAdminSources: vi.fn(async (): Promise<{ items: ReturnType<typeof gmailRow>[] }> => ({ items: [] })),
  getAdminSyncStatus: vi.fn(async () => ({ items: [] })),
  getOverallStatus: vi.fn(async () => ({})),
  getIndexStats: vi.fn(async () => null),
  getAccessOverview: vi.fn(async (): Promise<Record<string, unknown>> => ({ principals: [] })),
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

function webRow() {
  return { id: "web", type: "web", accountId: "", deviceId: "device-12345678", enabled: true };
}

describe("SourcesView extension promo", () => {
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

  test("shows the promo after loading when no web source exists", async () => {
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Install the Chrome extension"),
    );
    await act(async () => {
      (host.querySelector(".extension-promo .ext-promo-open") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".ext-promo-install")?.getAttribute("target")).toBe("_blank");
    expect(host.querySelector(".ext-promo-pair")?.getAttribute("href")).toBe(
      "/portal/settings/devices?pair=browser",
    );
  });

  test("hides the promo once the web source exists", async () => {
    apiMocks.getAdminSources.mockResolvedValue({ items: [gmailRow(), webRow()] });
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading…"));
    expect(host.textContent).not.toContain("Install the Chrome extension");
  });

  test("withholds the promo while loading", async () => {
    apiMocks.getAdminSources.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(h(SourcesView, {}), host);
    });
    expect(host.textContent).toContain("Loading…");
    expect(host.querySelector(".ext-promo")).toBeNull();
  });

});
