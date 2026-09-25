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
import { TESTFLIGHT_URL, IOS_PAIR_PATH, APPLE_LOGO_URL } from "../lib/ios-links.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { IosPromoCard } from "./ios-promo.js";

describe("IosPromoCard", () => {
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

  test("links to TestFlight in a new tab and deep-links pairing with ios preselected", async () => {
    await act(async () => {
      render(h(IosPromoCard, {}), host);
    });
    expect(host.textContent).toContain("Get the iPhone app");
    const logo = host.querySelector("img.ext-promo-logo-apple") as HTMLImageElement;
    expect(logo?.getAttribute("src")).toBe(APPLE_LOGO_URL);
    expect(logo?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(host.querySelector(".modal-panel")).toBeNull();
    const learnMore = host.querySelector("button.ext-promo-open") as HTMLButtonElement;
    expect(learnMore.textContent).toBe("Learn more");
    await act(async () => {
      learnMore.click();
    });
    expect(host.querySelector(".modal-panel")?.getAttribute("role")).toBe("dialog");
    expect(host.textContent).toContain("10,000 testers");
    expect(host.textContent).toContain("App Store");
    const storeLink = host.querySelector(
      `a[href="${TESTFLIGHT_URL}"]`,
    ) as HTMLAnchorElement;
    expect(storeLink.getAttribute("target")).toBe("_blank");
    expect(storeLink.getAttribute("rel")).toContain("noopener");
    const pairLink = host.querySelector(
      `a[href="${IOS_PAIR_PATH}"]`,
    ) as HTMLAnchorElement;
    expect(pairLink.textContent).toContain("Already have it? Pair it");
    await act(async () => {
      pairLink.click();
    });
    expect(vi.mocked(navigate)).toHaveBeenCalledWith(IOS_PAIR_PATH);
  });
});
