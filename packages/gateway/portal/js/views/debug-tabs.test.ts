// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Which tab the Debug page shows is read from the route, not held in state.
// These mount the view and assert the two consequences that has: which tab
// renders for a given route, and which clicks are allowed to rewrite the
// address bar. Both are one-expression behaviours with no other coverage.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// `vi.hoisted` because vi.mock is lifted above the imports — a plain const
// would not exist yet when the factory runs.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("../lib/router.js", () => ({ navigate }));
vi.mock("../api.js", () => ({
  getBackgroundJobs: vi.fn(async () => ({ jobs: [] })),
  getMetrics: vi.fn(async () => ({})),
  getProcessVitals: vi.fn(async () => ({})),
  getSchedulerMetrics: vi.fn(async () => ({})),
}));
// The heavy tab bodies are not under test — each is covered by its own view.
vi.mock("./graph.js", () => ({ GraphView: () => h("div", { class: "stub-graph" }) }));
vi.mock("./cognition.js", () => ({ CognitionView: () => h("div", { class: "stub-cognition" }) }));
vi.mock("./doctor.js", () => ({ DoctorTab: () => h("div", { class: "stub-doctor" }) }));
vi.mock("./watch-debug.js", () => ({ WatchDebugTab: () => h("div", { class: "stub-watch" }) }));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { DebugView } from "./debug.js";

describe("Debug tab bar", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
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

  async function mount(props: Record<string, unknown>) {
    await act(async () => {
      render(h(DebugView, props), host);
    });
  }

  function tabLink(label: string): HTMLElement {
    const match = [...host.querySelectorAll("a")].find(
      (b) => b.textContent?.trim() === label,
    );
    if (!match) throw new Error(`no tab labelled ${label}`);
    return match as unknown as HTMLElement;
  }

  function activeTabLabel(): string | undefined {
    return host.querySelector('a[aria-current="page"]')?.textContent?.trim() ?? undefined;
  }

  test("renders the tab the route names", async () => {
    await mount({ tab: "graph", experimental: false });
    expect(activeTabLabel()).toBe("Document graph");
    expect(host.querySelector(".stub-graph")).not.toBeNull();
  });

  test("selecting another tab rewrites the path to that tab", async () => {
    await mount({ tab: "graph", experimental: false });
    await act(async () => {
      tabLink("System").click();
    });
    expect(navigate).toHaveBeenCalledWith("/portal/debug/doctor");
  });

  test("re-selecting the open tab is a no-op, so its query and fragment survive", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("https://portal.example.org/portal/debug/graph?node=fixture#details"),
    });
    await mount({ tab: "graph", experimental: false });
    await act(async () => {
      tabLink("Document graph").click();
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?node=fixture");
    expect(window.location.hash).toBe("#details");
  });

  test("a Cognition route falls back to the default tab until experimental arrives", async () => {
    // The flag resolves async, so a cold deep link mounts with it still false.
    await mount({ tab: "cognition", experimental: false });
    expect(host.querySelector(".stub-cognition")).toBeNull();
    expect(activeTabLabel()).toBe("Tables");

    // While the two disagree, a click must still be able to repair the URL —
    // the no-op guard compares against the route, not the rendered tab.
    await act(async () => {
      tabLink("Tables").click();
    });
    expect(navigate).toHaveBeenCalledWith("/portal/debug/data");
  });

  test("the same route resolves to Cognition once experimental is on", async () => {
    await mount({ tab: "cognition", experimental: true });
    expect(activeTabLabel()).toBe("Agent runs");
    expect(host.querySelector(".stub-cognition")).not.toBeNull();
  });

  test("the Watch tab is gated the same way, and carries the watch id it was given", async () => {
    await mount({ tab: "watch", experimental: false, watchDebugId: "watch-01" });
    expect(host.querySelector(".stub-watch")).toBeNull();
    expect(activeTabLabel()).toBe("Tables");

    await mount({ tab: "watch", experimental: true, watchDebugId: "watch-01" });
    expect(activeTabLabel()).toBe("Watch runtime");
    expect(host.querySelector(".stub-watch")).not.toBeNull();
  });

  test("an unrenderable tab shows the default without claiming to be it", async () => {
    await mount({ tab: "nonexistent", experimental: false });
    expect(activeTabLabel()).toBe("Tables");
  });
});
