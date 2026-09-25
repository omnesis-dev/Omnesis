// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/router.js", () => ({ navigate: vi.fn() }));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate } from "../lib/router.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { CHROME_WEB_STORE_URL, EXTENSION_PAIR_PATH, CHROME_LOGO_URL } from "../lib/extension-links.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { ExtensionPromoCard, hasWebSource } from "./extension-promo.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { isChromiumBrowser, shouldShowExtensionPromo } from "./extension-promo.js";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
// Token fragments that matter for the mobile exclusion: a Chrome token plus a
// mobile token (mobile-OS browser), and Chrome-iOS which carries neither a
// Chrome token nor installable extensions.
const ANDROID_CHROME_FRAGMENT =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile";
const CRIOS_FRAGMENT = "CriOS/131.0.0.0 Mobile/15E148 Safari/604.1";

describe("isChromiumBrowser", () => {
  test("source detection honors explicit type and opaque colon-bearing accounts", () => {
    expect(hasWebSource([{ id: "web:fixture:member" }])).toBe(true);
    expect(hasWebSource([{ id: "opaque", type: "web" }])).toBe(true);
    expect(hasWebSource([{ id: "web:fixture", type: "gmail" }])).toBe(false);
    expect(hasWebSource([{ id: ":web" }])).toBe(false);
  });
  test("matches Chrome via userAgentData brands", () => {
    expect(
      isChromiumBrowser({ brands: [{ brand: "Chromium", version: "131" }, { brand: "Google Chrome", version: "131" }] }),
    ).toBe(true);
  });

  test("matches Chrome via userAgent fallback", () => {
    expect(isChromiumBrowser({ userAgent: CHROME_UA })).toBe(true);
  });

  test("matches Edge — it installs Chrome Web Store extensions too", () => {
    expect(isChromiumBrowser({ userAgent: EDGE_UA })).toBe(true);
  });

  test("rejects Firefox and Safari", () => {
    expect(isChromiumBrowser({ userAgent: FIREFOX_UA })).toBe(false);
    expect(isChromiumBrowser({ userAgent: SAFARI_UA })).toBe(false);
  });

  test("rejects mobile browsers even with a Chrome token", () => {
    expect(isChromiumBrowser({ userAgent: ANDROID_CHROME_FRAGMENT })).toBe(false);
    expect(
      isChromiumBrowser({
        userAgent: ANDROID_CHROME_FRAGMENT,
        brands: [{ brand: "Chromium", version: "131" }],
      }),
    ).toBe(false);
    expect(isChromiumBrowser({ userAgent: CHROME_UA, mobile: true })).toBe(false);
  });

  test("rejects Chrome on iOS, which has no Chrome token", () => {
    expect(isChromiumBrowser({ userAgent: CRIOS_FRAGMENT })).toBe(false);
  });

  test("rejects empty input", () => {
    expect(isChromiumBrowser({})).toBe(false);
  });
});

describe("hasWebSource", () => {
  test("matches the web source id and scoped web ids", () => {
    expect(hasWebSource([{ id: "web" }])).toBe(true);
    expect(hasWebSource([{ id: "gmail" }, { id: "web:default" }])).toBe(true);
  });

  test("is false when no web source is present", () => {
    expect(hasWebSource([{ id: "gmail" }, { id: "webdav" }])).toBe(false);
    expect(hasWebSource([])).toBe(false);
  });

  test("tolerates malformed input", () => {
    expect(hasWebSource(null)).toBe(false);
    expect(hasWebSource(undefined)).toBe(false);
    expect(hasWebSource({ id: "web" })).toBe(false);
    expect(hasWebSource([{ id: null }, {}, { id: 42 }])).toBe(false);
  });
});

describe("shouldShowExtensionPromo", () => {
  const base = { sources: [{ id: "gmail" }], userAgent: CHROME_UA, brands: [] };

  test("shows when no web source exists on a Chromium browser", () => {
    expect(shouldShowExtensionPromo(base)).toBe(true);
  });

  test("hides once the web source exists", () => {
    expect(shouldShowExtensionPromo({ ...base, sources: [{ id: "web" }] })).toBe(false);
  });

  test("hides on non-Chromium browsers", () => {
    expect(shouldShowExtensionPromo({ ...base, userAgent: FIREFOX_UA })).toBe(false);
  });

  test("reads the live navigator when no signals are passed", () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: CHROME_UA },
      configurable: true,
      writable: true,
    });
    try {
      expect(shouldShowExtensionPromo({ sources: [{ id: "gmail" }] })).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("ExtensionPromoCard", () => {
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

  test("links to the store in a new tab and deep-links pairing with browser preselected", async () => {
    await act(async () => {
      render(h(ExtensionPromoCard, {}), host);
    });
    expect(host.textContent).toContain("Install the Chrome extension");
    const logo = host.querySelector("img.ext-promo-logo") as HTMLImageElement;
    expect(logo?.getAttribute("src")).toBe(CHROME_LOGO_URL);
    expect(logo?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(host.querySelector(".modal-panel")).toBeNull();
    const learnMore = host.querySelector("button.ext-promo-open") as HTMLButtonElement;
    expect(learnMore.textContent).toBe("Learn more");
    await act(async () => {
      learnMore.click();
    });
    expect(host.querySelector(".modal-panel")?.getAttribute("role")).toBe("dialog");
    const storeLink = host.querySelector(
      `a[href="${CHROME_WEB_STORE_URL}"]`,
    ) as HTMLAnchorElement;
    expect(storeLink.getAttribute("target")).toBe("_blank");
    expect(storeLink.getAttribute("rel")).toContain("noopener");
    const pairLink = host.querySelector(
      `a[href="${EXTENSION_PAIR_PATH}"]`,
    ) as HTMLAnchorElement;
    expect(pairLink.textContent).toContain("Already installed? Pair it");
    await act(async () => {
      pairLink.click();
    });
    expect(vi.mocked(navigate)).toHaveBeenCalledWith(EXTENSION_PAIR_PATH);
  });
});
