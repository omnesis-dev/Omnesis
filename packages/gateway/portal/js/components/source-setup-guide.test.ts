// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const navigation = vi.hoisted(() => vi.fn());
vi.mock("../lib/router.js", () => ({ navigate: navigation }));
// @ts-expect-error — portal is plain JS without sibling declarations.
import * as sourceGuide from "./source-setup-guide.js";

const { SourceSetupGuide, sourceSetupGuide, safeSetupLink, hasSourceSetupGuide } = sourceGuide;

function descriptor() {
  return {
    setupGuide: "invented-companion",
    setupGuideContent: {
      version: 1,
      title: "Install an invented companion",
      paragraphs: ["Use the companion's own setup."],
      links: [{ label: "Install companion", url: "https://companion.example.com/install" }],
      note: "Credentials remain scoped.",
      pairing: { deviceKind: "browser", label: "Connect companion" },
    },
  };
}

describe("bounded source setup guide", () => {
  test.each([
    "javascript:alert(1)",
    "file:///tmp/fixture",
    "data:text/plain,fixture",
    "http://companion.example.com",
    "https://user:pass@companion.example.com",
    "https://@companion.example.com",
    "https://companion.example.com/\nfixture",
  ])("refuses unsafe install link %s", (url) => {
    expect(safeSetupLink(url)).toBeNull();
    const item = descriptor();
    item.setupGuideContent.links[0].url = url;
    expect(sourceSetupGuide(item)).toBeNull();
  });

  test("preserves a legacy marker and accepts generic bounded content independently of its identity", () => {
    const item = descriptor();
    expect(sourceSetupGuide(item)).toEqual(item.setupGuideContent);
    expect(sourceSetupGuide({ ...item, setupGuide: "another-companion" })).toEqual(
      item.setupGuideContent,
    );
    expect(sourceSetupGuide({ setupGuide: "browser-extension" })).toBeNull();
    expect(sourceSetupGuide({ ...item, setupGuide: "" })).toBeNull();
    expect(sourceSetupGuide({ ...item, setupGuide: "x".repeat(129) })).toBeNull();
  });

  test("refuses unknown, malformed and out-of-bounds content instead of guessing actions", () => {
    for (const content of [
      null,
      "future",
      { version: 2 },
      { version: 1, title: 12 },
      { ...descriptor().setupGuideContent, paragraphs: [] },
      { ...descriptor().setupGuideContent, paragraphs: Array(9).fill("Invented paragraph") },
      { ...descriptor().setupGuideContent, title: "x".repeat(161) },
      { ...descriptor().setupGuideContent, paragraphs: ["x".repeat(2001)] },
      {
        ...descriptor().setupGuideContent,
        links: Array(5).fill({ label: "Install", url: "https://companion.example.com" }),
      },
      { ...descriptor().setupGuideContent, pairing: { deviceKind: "unknown", label: "Connect" } },
    ]) {
      expect(
        sourceSetupGuide({ setupGuide: "invented-companion", setupGuideContent: content }),
      ).toBeNull();
    }
  });

  test("UTF-8 byte limits agree for emoji and combining marks", () => {
    for (const [title, accepted] of [
      ["😀".repeat(40), true],
      ["😀".repeat(41), false],
      ["e\u0301".repeat(53), true],
      ["e\u0301".repeat(54), false],
    ] as const) {
      const item = descriptor();
      item.setupGuideContent.title = title;
      expect(sourceSetupGuide(item) !== null).toBe(accepted);
    }
  });

  test("declaration presence includes null and content without a marker", () => {
    expect(hasSourceSetupGuide({})).toBe(false);
    for (const item of [
      { setupGuide: null },
      { setupGuideContent: null },
      { setupGuideContent: descriptor().setupGuideContent },
      { setupGuide: 42 },
      { setupGuideContent: "malformed" },
    ]) {
      expect(hasSourceSetupGuide(item)).toBe(true);
      expect(sourceSetupGuide(item)).toBeNull();
    }
  });

  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  beforeEach(() => {
    navigation.mockClear();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("main") as unknown as HTMLElement;
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("renders escaped metadata and only navigates existing pairing presentation on a click", async () => {
    const item = descriptor();
    item.setupGuideContent.paragraphs = ["<script>invented markup</script>"];
    await act(async () => render(h(SourceSetupGuide, { descriptor: item }), host));
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("<script>invented markup</script>");
    expect(navigation).not.toHaveBeenCalled();
    const install = host.querySelector("[data-setup-install]") as HTMLAnchorElement;
    expect(install.getAttribute("href")).toBe("https://companion.example.com/install");
    expect(install.getAttribute("rel")).toContain("noopener");
    const pairing = host.querySelector("[data-setup-pairing]") as HTMLAnchorElement;
    expect(pairing.getAttribute("href")).toBe("/portal/settings/devices?pair=browser");
    await act(async () => pairing.click());
    expect(navigation).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices?pair=browser");
  });

  test("unsupported content renders an actionable explanation without unsafe links or false success", async () => {
    await act(async () =>
      render(
        h(SourceSetupGuide, {
          descriptor: { setupGuide: "future-companion", setupGuideContent: { version: 9 } },
        }),
        host,
      ),
    );
    expect(host.querySelector('[data-setup-guide="unavailable"]')).toBeTruthy();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("supported setup guide");
    expect(navigation).not.toHaveBeenCalled();
  });
});
