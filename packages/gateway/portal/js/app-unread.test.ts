// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sidebar's unread dot, and the mark that clears it.
 *
 * Two properties: a conversation the gateway reports as unread is visibly
 * different in the list, and the conversation actually on screen tells the
 * gateway so — which is what clears the dot everywhere else.
 *
 * All fixture data is invented.
 */

import { render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/agent/conversations?")) {
      return {
        ok: true,
        json: async () => ({
          conversations: [
            { id: "conv-open", title: "Budget review", pinned: false, unread: true },
            { id: "conv-unread", title: "Permit decision", pinned: false, unread: true },
            { id: "conv-read", title: "Trip planning", pinned: false, unread: false },
          ],
          nextCursor: null,
        }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }),
}));

vi.mock("./api.js", () => ({
  apiFetch,
  checkSession: vi.fn(async () => ({ authenticated: true })),
  getStatus: vi.fn(async () => ({ experimental: false, developer: false })),
  getHostFleetUpdate: vi.fn(async () => ({ plan: null, operation: null })),
  isAuthenticated: vi.fn(() => true),
  login: vi.fn(async () => ({ ok: true })),
  logout: vi.fn(async () => {}),
  listPrivacyApprovals: vi.fn(async () => ({ totalCount: 0 })),
  listSubscriptionApprovals: vi.fn(async () => ({ totalCount: 0 })),
  startHostFleetUpdate: vi.fn(),
}));
vi.mock("./lib/format.js", () => ({ loadSourceMeta: vi.fn(async () => {}) }));
vi.mock("./lib/router.js", () => ({
  navigate: vi.fn(),
  onRouteChange: vi.fn(() => () => {}),
  parseRoute: vi.fn(() => ({ view: "agent", convoId: "conv-open" })),
  replaceUrl: vi.fn(),
}));
vi.mock("./lib/lazy.js", () => ({ lazy: () => () => null }));

describe("portal conversation list — unread", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  // Vitest clears mock calls before each test, so the marks the first render
  // sent are captured here, where that render happens.
  let firstRenderMarks: unknown[][] = [];

  beforeAll(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true,
      value: { href: "https://localhost/portal/agent/conv-open", reload: vi.fn() },
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#app") as unknown as HTMLElement;

    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    await import("./app.js");
    await vi.waitFor(() =>
      expect(host.querySelectorAll(".sidebar-convo-row").length).toBeGreaterThan(0),
    );
    firstRenderMarks = apiFetch.mock.calls.filter(([path]) => String(path).includes("/seen"));
  });

  afterAll(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  function seenCalls(): Array<[string, { viewing: boolean }]> {
    return apiFetch.mock.calls
      .filter(([path]) => String(path).includes("/seen"))
      .map(([path, init]) => {
        const id = decodeURIComponent(
          String(path).replace("/agent/conversations/", "").replace("/seen", ""),
        );
        return [id, JSON.parse(String((init as { body: string }).body))] as [
          string,
          { viewing: boolean },
        ];
      });
  }

  function rowFor(id: string): Element {
    const rows = [...host.querySelectorAll(".sidebar-convo-row")];
    const row = rows.find((candidate) =>
      candidate.querySelector<HTMLAnchorElement>(".sidebar-convo-item")?.
        getAttribute("href")?.endsWith(encodeURIComponent(id)),
    );
    expect(row, `no sidebar row for ${id}`).toBeDefined();
    return row!;
  }

  test("draws a dot only on the conversation holding something unseen", () => {
    expect(rowFor("conv-unread").querySelector(".sidebar-convo-unread")).not.toBeNull();
    expect(rowFor("conv-read").querySelector(".sidebar-convo-unread")).toBeNull();
  });

  test("weights the unread row's title so the dot is not the only cue", () => {
    expect(rowFor("conv-unread").querySelector(".sidebar-convo-title")?.className).toContain(
      "unread",
    );
    expect(rowFor("conv-read").querySelector(".sidebar-convo-title")?.className).not.toContain(
      "unread",
    );
  });

  test("tells the gateway the open conversation is on screen", () => {
    expect(firstRenderMarks.length).toBeGreaterThan(0);
    const [path, init] = firstRenderMarks[0] as [string, { method: string; body: string }];
    expect(path).toBe("/agent/conversations/conv-open/seen");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ viewing: true });
  });

  test("never dots the conversation being read, whatever the last list said", async () => {
    // The list is fetched asynchronously and may still call this conversation
    // unread; the operator is looking straight at it, so the row does not.
    await act(async () => {});
    expect(rowFor("conv-open").querySelector(".sidebar-convo-unread")).toBeNull();
    expect(rowFor("conv-unread").querySelector(".sidebar-convo-unread")).not.toBeNull();
  });

  test("withdraws the mark when the operator moves to another conversation", async () => {
    apiFetch.mockClear();
    await act(async () => {
      // linkedom supplies its own Event classes; the global CustomEvent is a
      // different implementation its dispatcher rejects.
      const { CustomEvent: DomCustomEvent } = window as unknown as {
        CustomEvent: typeof CustomEvent;
      };
      window.dispatchEvent(
        new DomCustomEvent("omnesis:agent-active-convo", { detail: { id: "conv-unread" } }),
      );
    });
    const marks = seenCalls();
    // The surface it left says so before the new one claims the screen, so a
    // conversation nobody is showing never keeps a viewing lease.
    expect(marks).toEqual([
      ["conv-open", { viewing: false }],
      ["conv-unread", { viewing: true }],
    ]);
  });

});
