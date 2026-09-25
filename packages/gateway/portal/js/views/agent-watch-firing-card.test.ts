// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WatchFiringContextCard } from "./agent.js";

describe("WatchFiringContextCard", () => {
  let host: HTMLElement | null = null;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalHistory: typeof globalThis.history | undefined;
  let originalCustomEvent: typeof globalThis.CustomEvent | undefined;

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    if (originalHistory === undefined) delete (globalThis as { history?: unknown }).history;
    else globalThis.history = originalHistory;
    if (originalCustomEvent === undefined) delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
    else globalThis.CustomEvent = originalCustomEvent;
  });

  function card(watchId?: string) {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalHistory = globalThis.history;
    originalCustomEvent = globalThis.CustomEvent;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    act(() => {
      render(h(WatchFiringContextCard, {
        snapshot: {
          name: "Quarterly budget changed",
          condition: "the approved quarterly budget changes",
          firedAt: 1_789_344_600_000,
        },
        watchId,
      }), host!);
    });
    return host!;
  }

  it("links the whole fired card to the owning watch", () => {
    const host = card("subscription/example");
    const link = host.querySelector("a.agent-brief-card-link");

    expect(link?.getAttribute("href")).toBe("/portal/watches/subscription%2Fexample");
    expect(link?.getAttribute("aria-label")).toBeNull();
    expect(host.textContent).toContain("View watch");
  });

  it("uses in-app navigation when the card is clicked", () => {
    const host = card("watch_example");
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    Object.assign(globalThis, {
      history: { pushState },
      CustomEvent: class {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    });
    Object.defineProperty(globalThis, "window", {
      value: { dispatchEvent },
      configurable: true,
      writable: true,
    });

    act(() => {
      host.querySelector("a")?.click();
    });

    expect(pushState).toHaveBeenCalledWith(null, "", "/portal/watches/watch_example");
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: "route-change" });
  });

  it("keeps legacy origins without a watch id readable and noninteractive", () => {
    const host = card();

    expect(host.querySelector(".agent-brief-card")).not.toBeNull();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).not.toContain("View watch");
  });
});
