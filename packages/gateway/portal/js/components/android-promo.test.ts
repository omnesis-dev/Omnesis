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
import {
  ANDROID_TESTER_GROUP_URL,
  ANDROID_OPT_IN_URL,
  ANDROID_PAIR_PATH,
  ANDROID_LOGO_URL,
} from "../lib/android-links.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { AndroidPromoCard } from "./android-promo.js";

describe("AndroidPromoCard", () => {
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

  test("links the tester group and Play opt-in in new tabs and deep-links pairing with android preselected", async () => {
    await act(async () => {
      render(h(AndroidPromoCard, {}), host);
    });
    expect(host.textContent).toContain("Get the Android app");
    expect(host.querySelector(".modal-panel")).toBeNull();
    const learnMore = host.querySelector("button.ext-promo-open") as HTMLButtonElement;
    expect(learnMore.textContent).toBe("Learn more");
    await act(async () => {
      learnMore.click();
    });
    expect(host.querySelector(".modal-panel")?.getAttribute("role")).toBe("dialog");
    expect(host.textContent).toMatch(/closed testing on google play/i);
    const logo = host.querySelector("img.ext-promo-logo") as HTMLImageElement;
    expect(logo?.getAttribute("src")).toBe(ANDROID_LOGO_URL);
    expect(logo?.classList.contains("ext-promo-logo-apple")).toBe(false);
    for (const url of [ANDROID_TESTER_GROUP_URL, ANDROID_OPT_IN_URL]) {
      const link = host.querySelector(`a[href="${url}"]`) as HTMLAnchorElement;
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    const steps = [...host.querySelectorAll(".promo-modal-steps a")].map((a) => a.getAttribute("href"));
    expect(steps).toEqual([ANDROID_TESTER_GROUP_URL, ANDROID_OPT_IN_URL]);
    const pairLink = host.querySelector(`a[href="${ANDROID_PAIR_PATH}"]`) as HTMLAnchorElement;
    expect(pairLink.textContent).toContain("Already have it? Pair it");
    await act(async () => {
      pairLink.click();
    });
    expect(vi.mocked(navigate)).toHaveBeenCalledWith(ANDROID_PAIR_PATH);
  });
});
