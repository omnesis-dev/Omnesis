// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// `lazy()` mounted for real, because its whole contract is about time: what is
// on screen before the module lands, what happens on a second mount, and what
// a rejected import leaves behind. None of that is visible in an expanded
// VNode tree.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// @ts-expect-error — portal is plain JS without sibling declarations.
import { lazy } from "./lazy.js";

describe("lazy view loader", () => {
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
    vi.unstubAllGlobals();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  const Greeting = ({ name }: { name: string }) => h("p", { class: "greeting" }, `hi ${name}`);

  test("shows a placeholder until the module resolves, then the component with its props", async () => {
    let settle: (c: unknown) => void = () => {};
    const loader = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const View = lazy(loader);

    await act(async () => {
      render(h(View, { name: "Maya" }), host);
    });
    expect(host.querySelector(".lazy-view-loading")?.textContent).toBe("Loading…");
    expect(host.querySelector(".greeting")).toBeNull();

    await act(async () => {
      settle(Greeting);
    });
    expect(host.querySelector(".lazy-view-loading")).toBeNull();
    expect(host.querySelector(".greeting")?.textContent).toBe("hi Maya");
  });

  test("a second mount reuses the resolved module instead of importing again", async () => {
    const loader = vi.fn(async () => Greeting);
    const View = lazy(loader);

    await act(async () => {
      render(h(View, { name: "Jamie" }), host);
    });
    expect(loader).toHaveBeenCalledTimes(1);

    // Unmount and mount again — the closure cache must survive it.
    await act(async () => {
      render(null, host);
    });
    await act(async () => {
      render(h(View, { name: "David" }), host);
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".greeting")?.textContent).toBe("hi David");
  });

  test("two lazy views built from the same module each load once, not once per mount", async () => {
    const loader = vi.fn(async () => Greeting);
    const First = lazy(loader);

    await act(async () => {
      render(h("div", null, h(First, { name: "Sarah" }), h(First, { name: "Alex" })), host);
    });
    await act(async () => {});

    // Both instances share one closure, so one in-flight import serves both.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(".greeting")).toHaveLength(2);
  });

  test("a failed module shows an error with a full-document reload action", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const View = lazy(async () => {
      throw new Error("network down");
    });

    await act(async () => {
      render(h(View, {}), host);
    });

    await act(async () => {});
    expect(host.querySelector(".lazy-view-loading")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load this page");
    host.querySelector("button")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a failed view stays recoverable after navigating away and back", async () => {
    const loader = vi.fn(async () => { throw new Error("network down"); });
    const View = lazy(loader);
    await act(async () => { render(h(View, {}), host); });
    await act(async () => { render(null, host); });
    await act(async () => { render(h(View, {}), host); });
    await act(async () => {});
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector(".lazy-view-loading")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("a synchronous loader failure shows the same recovery", async () => {
    const View = lazy(() => { throw new Error("loader failed"); });
    await act(async () => { render(h(View, {}), host); });
    await act(async () => {});
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  test.each(["resolve", "reject"])("an import can %s after unmount without replacing the next page", async (outcome) => {
    let resolve: (component: unknown) => void = () => {};
    let reject: (cause: Error) => void = () => {};
    const loader = vi.fn(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const View = lazy(loader);
    await act(async () => { render(h(View, {}), host); });
    await act(async () => { render(h("p", null, "Another page"), host); });
    await act(async () => {
      if (outcome === "resolve") resolve(Greeting);
      else reject(new Error("network down"));
    });
    expect(host.textContent).toBe("Another page");
    await act(async () => { render(h(View, { name: "Maya" }), host); });
    expect(host.querySelector(".lazy-view-loading")).toBeNull();
    expect(host.querySelector(outcome === "resolve" ? ".greeting" : '[role="alert"]')).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
