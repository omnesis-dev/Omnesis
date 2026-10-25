// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The nav item for tasks counts today's open tasks: "Tasks (4)", plain "Tasks"
 * at zero. The shell reads `/tasks/counts` for the viewer's day, and takes
 * the counts the Tasks view announces after each of its own reads.
 *
 * Separate file because `app.js` mounts once per module load.
 */

import { render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const { getTaskCounts } = vi.hoisted(() => ({
  getTaskCounts: vi.fn(async (day: string) => ({
    day,
    counts: { today: 4, month: 2, future: 0, anytime: 0, waiting: 0, suggested: 0, proposals: 0, carried: 1 },
  })),
}));

vi.mock("./api.js", () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ conversations: [], nextCursor: null }),
  })),
  checkSession: vi.fn(async () => ({ authenticated: true })),
  getStatus: vi.fn(async () => ({ experimental: false, developer: false, tasks: { available: true } })),
  getTaskCounts,
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
  parseRoute: vi.fn(() => ({ view: "search" })),
  replaceUrl: vi.fn(),
}));
vi.mock("./lib/lazy.js", () => ({ lazy: () => () => null }));

describe("portal nav — today's open tasks", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  const tasksLabel = () =>
    [...host.querySelectorAll(".sidebar-item")]
      .find((item) => item.getAttribute("href") === "/portal/tasks")
      ?.querySelector(".sidebar-label")
      ?.textContent?.trim();

  beforeAll(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true,
      value: { href: "https://localhost/portal/search", reload: vi.fn() },
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#app") as unknown as HTMLElement;
    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    await import("./app.js");
  });

  afterAll(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("reads the counts for the viewer's day and shows today's", async () => {
    await vi.waitFor(() => expect(tasksLabel()).toBe("Tasks (4)"));
    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    const { localDay } = await import("./lib/tasks-model.js");
    expect(getTaskCounts).toHaveBeenCalledWith(localDay());
  });

  test("follows the counts the Tasks view announces, plain at zero", async () => {
    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    const { publishTaskCounts } = await import("./lib/task-counts.js");
    await act(async () => publishTaskCounts({ today: 0 }));
    expect(tasksLabel()).toBe("Tasks");
    await act(async () => publishTaskCounts({ today: 7 }));
    expect(tasksLabel()).toBe("Tasks (7)");
  });
});
