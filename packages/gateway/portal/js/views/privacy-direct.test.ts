// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// The audit transcript pane for Direct-tool reads, rendered as a unit —
// mounted, with its effects and state running. What is under test here is
// what only a real mount can show: the empty state, the explicit and
// heuristic session rows, opening a session into its calls, expanding one
// call into its payload, and the list error state.
//
// All fixture data is invented.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api.js", () => ({
  deleteDirectAuditSession: vi.fn(),
  getDirectAuditEvent: vi.fn(),
  listDirectAuditSessions: vi.fn(),
  listDirectSessionEvents: vi.fn(),
}));

vi.mock("../lib/router.js", () => ({
  navigate: vi.fn(),
  replaceRoute: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { deleteDirectAuditSession } from "../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { getDirectAuditEvent } from "../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { listDirectAuditSessions } from "../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { listDirectSessionEvents } from "../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { DirectAuditPane, DirectSessionDetailRoute } from "./audit/direct.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate } from "../lib/router.js";

function directMocks() {
  return {
    deleteDirectAuditSession:
      deleteDirectAuditSession as unknown as ReturnType<typeof vi.fn>,
    getDirectAuditEvent: getDirectAuditEvent as unknown as ReturnType<typeof vi.fn>,
    listDirectAuditSessions:
      listDirectAuditSessions as unknown as ReturnType<typeof vi.fn>,
    listDirectSessionEvents:
      listDirectSessionEvents as unknown as ReturnType<typeof vi.fn>,
  };
}

function session(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `direct-session-${index}`,
    ownerId: "owner-invented",
    principalId: "principal-invented",
    credentialId: "credential-invented",
    grantId: "grant-invented",
    explicitKey: null,
    heuristicKey: "principal-invented|credential-invented",
    principalName: null,
    createdAt: 1_700_000_000_000 + index,
    lastEventAt: 1_700_000_060_000 + index,
    eventCount: 2,
    bytesTotal: 512,
    ...overrides,
  };
}

function directEvent(index: number) {
  return {
    sequence: index + 1,
    id: `direct-event-${index}`,
    sessionId: "direct-session-0",
    tool: "search_many",
    outcome: index === 0 ? "ok" : "refused",
    requestId: `request-${index}`,
    display: { title: "Direct search_many", text: null },
    payloadTruncated: false,
    payloadBytes: 128,
    originalPayloadBytes: 128,
    createdAt: 1_700_000_000_000 + index,
  };
}

describe("Direct audit pane, mounted", () => {
  let host: HTMLElement;
  let doc: Document;
  let win: Window;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    doc = parsed.document as unknown as Document;
    win = parsed.window as unknown as Window;
    Object.assign(globalThis, { document: doc, window: win });
    host = doc.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    vi.unstubAllGlobals();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    vi.useRealTimers();
  });

  async function mountPane(props: Record<string, unknown> = {}) {
    await act(async () => {
      render(null, host);
      render(h(DirectAuditPane, props), host);
    });
    await act(async () => {});
  }

  async function mountDetailRoute(sessionId: string) {
    await act(async () => {
      render(null, host);
      render(h(DirectSessionDetailRoute, { sessionId }), host);
    });
    await act(async () => {});
    await act(async () => {});
    await act(async () => {});
  }

  function navigateMock() {
    return navigate as unknown as ReturnType<typeof vi.fn>;
  }

  function rowButtons() {
    return Array.from(host.querySelectorAll(".privacy-direct-row"));
  }

  test("shows the empty state when nothing was ever read", async () => {
    directMocks().listDirectAuditSessions.mockResolvedValue({ sessions: [] });
    await mountPane();
    expect(host.textContent).toContain("reads recorded");
  });

  test("lists explicit and heuristic sessions with their call counts", async () => {
    directMocks().listDirectAuditSessions.mockResolvedValue({
      sessions: [
        session(0, {
          explicitKey: "conversation:weekly-review",
          eventCount: 3,
          principalName: "Invented Agent",
        }),
        session(1, { eventCount: 1 }),
      ],
    });
    await mountPane();
    const text = host.textContent ?? "";
    expect(text).toContain("Invented Agent");
    expect(text).toContain("Conversation weekly-review");
    expect(text).toContain("3 calls");
    expect(text).toContain("External agent");
    expect(text).toContain("Grouped by activity");
    expect(text).toContain("heuristic");
  });

  test("opening a session renders each call as a timestamped card", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockResolvedValue({
      events: [directEvent(0), directEvent(1)],
    });
    mocks.getDirectAuditEvent.mockResolvedValue({
      event: {
        ...directEvent(0),
        payload: {
          tool: "search_many",
          args: { queries: [{ query: "invented" }] },
          result: {
            kind: "search.batch",
            items: [
              {
                kind: "search.results",
                query: "invented",
                results: [
                  {
                    documentId: "doc-invented",
                    sourceId: "gmail:invented@example.com",
                    title: "Invented email",
                  },
                ],
              },
            ],
          },
          outcome: "ok",
        },
      },
    });
    await mountPane();

    // Drilling in navigates to the session's own page (no Audit title/tabs).
    await act(async () => {
      rowButtons()[0].dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(navigateMock()).toHaveBeenCalledWith("/portal/audit/direct/direct-session-0");
    await mountDetailRoute("direct-session-0");
    expect(mocks.listDirectSessionEvents).toHaveBeenCalledWith("direct-session-0", {
      limit: 100,
    });
    await vi.waitFor(() => {
      expect(mocks.getDirectAuditEvent).toHaveBeenCalledWith("direct-event-0");
    });
    await act(async () => {});
    const back = host.querySelector(".doc-back");
    expect(back?.tagName).toBe("A");
    expect(back?.getAttribute("href")).toBe("/portal/audit/direct");

    // Linear transcript: the shared tool card is the item — no nested expand,
    // no redundant tool-name row, the call's time on the right.
    const text = host.textContent ?? "";
    expect(text).not.toContain("search_many");
    expect(text).toContain("invented");
    expect(text).toContain("Invented email");
    expect(host.querySelector(".agent-ephemeral-time")).not.toBeNull();
    // Success is silent: no outcome chip anywhere.
    expect(host.querySelector('[class*="outcome"]')).toBeNull();
    // …while the exact bytes stay one icon-click away in an overlay.
    expect(text).not.toContain("doc-invented");
    const rawIcon = host.querySelector('button[aria-label="Show raw JSON"]');
    expect(rawIcon).not.toBeNull();
    await act(async () => {
      rawIcon!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(host.textContent).toContain("doc-invented");
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test("an unknown session id falls back to the list", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    // The capped-list probe misses too: only a truly unknown id reads not-found.
    mocks.listDirectSessionEvents.mockRejectedValue(new Error("not found"));
    await mountDetailRoute("direct-session-vanished");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Session not found");
    });
    expect(host.querySelector(".privacy-direct-events")).toBeNull();
  });

  test("a session older than the list page still opens via probe", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockImplementation((_id, { limit } = {}) =>
      limit === 1
        ? Promise.resolve({ events: [] })
        : Promise.resolve({ events: [directEvent(0)] }),
    );
    mocks.getDirectAuditEvent.mockResolvedValue({
      event: {
        ...directEvent(0),
        payload: {
          tool: "search_documents",
          args: { query: "invented" },
          result: { kind: "search.results", query: "invented", results: [] },
          outcome: "ok",
        },
      },
    });
    await mountDetailRoute("direct-session-older");
    await vi.waitFor(() => {
      expect(host.querySelector(".privacy-direct-events")).not.toBeNull();
    });
    expect(host.textContent).not.toContain("Session not found");
    expect(host.textContent).toContain("No result");
  });

  test("an entity_context call names its entity in the card header", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockResolvedValue({
      events: [{ ...directEvent(0), tool: "entity_context" }],
    });
    mocks.getDirectAuditEvent.mockResolvedValue({
      event: {
        ...directEvent(0),
        payload: {
          tool: "entity_context",
          args: { kind: "person", id: "person-invented" },
          result: {
            kind: "structured",
            resultType: "entity_context.reaped",
            data: { people: [] },
          },
          outcome: "ok",
        },
      },
    });
    await mountDetailRoute("direct-session-0");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Entity context");
    });
    expect(host.textContent).toContain("person person-invented");
  });

  test("a trace_connections call names its seeds in the card header", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockResolvedValue({
      events: [{ ...directEvent(0), tool: "trace_connections" }],
    });
    mocks.getDirectAuditEvent.mockResolvedValue({
      event: {
        ...directEvent(0),
        payload: {
          tool: "trace_connections",
          args: { seedIds: ["doc-invented-a", "doc-invented-b"] },
          result: { kind: "event_trail.built", events: [] },
          outcome: "ok",
        },
      },
    });
    await mountDetailRoute("direct-session-0");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Trace connections");
    });
    expect(host.textContent).toContain("doc-invented-a, doc-invented-b");
  });

  test("shows the events error state when calls fail to load", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockRejectedValue(new Error("calls are away"));
    await mountDetailRoute("direct-session-0");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("calls are away");
    });
    expect(host.querySelector(".privacy-direct-events")).toBeNull();
  });

  test("shows the empty state when a session holds no calls", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockResolvedValue({ events: [] });
    await mountDetailRoute("direct-session-0");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("No calls in this session");
    });
  });

  test("a failed delete keeps the transcript and reports the error", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockResolvedValue({ events: [directEvent(0)] });
    mocks.getDirectAuditEvent.mockResolvedValue({ event: { ...directEvent(0), payload: null } });
    mocks.deleteDirectAuditSession.mockRejectedValue(new Error("delete is away"));
    await mountDetailRoute("direct-session-0");
    const toggle = host.querySelector(".privacy-overflow-toggle");
    await act(async () => {
      toggle!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    const item = host.querySelector(".privacy-overflow-item");
    await act(async () => {
      item!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    const confirm = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    await act(async () => {
      confirm!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("delete is away");
    });
    expect(navigateMock()).not.toHaveBeenCalledWith("/portal/audit/direct");
  });

  test("deleting a transcript goes through the overflow menu and confirm", async () => {
    const mocks = directMocks();
    mocks.listDirectAuditSessions.mockResolvedValue({ sessions: [session(0)] });
    mocks.listDirectSessionEvents.mockResolvedValue({ events: [directEvent(0)] });
    mocks.deleteDirectAuditSession.mockResolvedValue({ deleted: true });
    await mountDetailRoute("direct-session-0");

    expect(host.querySelector(".privacy-overflow-menu")).toBeNull();
    const toggle = host.querySelector(".privacy-overflow-toggle");
    expect(toggle?.tagName).toBe("BUTTON");
    await act(async () => {
      toggle!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    const item = host.querySelector(".privacy-overflow-item");
    expect(item?.textContent).toBe("Delete transcript");
    await act(async () => {
      item!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(host.textContent).toContain("Delete transcript");
    const confirm = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(mocks.deleteDirectAuditSession).toHaveBeenCalledWith("direct-session-0");
    // Deleting navigates back to the session list.
    expect(navigateMock()).toHaveBeenCalledWith("/portal/audit/direct");
  });

  test("shows the list error state when sessions fail to load", async () => {
    directMocks().listDirectAuditSessions.mockRejectedValue(new Error("gateway is away"));
    await mountPane();
    expect(host.textContent).toContain("gateway is away");
    expect(host.textContent).not.toContain("reads recorded");
  });
});
