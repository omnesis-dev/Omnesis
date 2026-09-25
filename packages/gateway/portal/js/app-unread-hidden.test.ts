// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shell mounting while the tab is not on screen.
 *
 * A restored session, a background reload, or a cmd-clicked link all mount the
 * portal hidden. Reporting a conversation as seen from there would clear its
 * unread marker — on every surface, since the gateway holds the state — for a
 * conversation nobody has looked at.
 *
 * Separate from `app-unread.test.ts` because `app.js` mounts once per module
 * load, so the visibility at mount is a per-file condition.
 *
 * All fixture data is invented.
 */

import { render } from "preact";
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

describe("portal conversation list — mounted while hidden", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeAll(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true,
      value: { href: "https://localhost/portal/agent/conv-open", reload: vi.fn() },
    });
    Object.defineProperty(parsed.document, "hidden", {
      configurable: true,
      get: () => true,
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#app") as unknown as HTMLElement;

    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    await import("./app.js");
    await vi.waitFor(() =>
      expect(host.querySelectorAll(".sidebar-convo-row").length).toBeGreaterThan(0),
    );
  });

  afterAll(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("does not report a conversation as seen", () => {
    const marks = apiFetch.mock.calls.filter(([path]) => String(path).includes("/seen"));
    expect(marks).toEqual([]);
  });

});
