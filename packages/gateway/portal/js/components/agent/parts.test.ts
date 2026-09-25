// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest;
// the module is untyped browser code, so type-checking is off here.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, it, expect, vi } from "vitest";
import { ephemeralResultArrived, MessageBubble, renderPart } from "./parts.js";

describe("ephemeralResultArrived", () => {
  it("is false until a result lands (spinner stays, rotation parked)", () => {
    expect(ephemeralResultArrived({ result: null })).toBe(false);
    expect(ephemeralResultArrived({})).toBe(false);
    expect(ephemeralResultArrived(null)).toBe(false);
  });

  it("is true for a success-shaped result", () => {
    expect(
      ephemeralResultArrived({ result: { kind: "sql.rows", columns: [], rows: [] } }),
    ).toBe(true);
    expect(
      ephemeralResultArrived({ result: { kind: "search.results", results: [] } }),
    ).toBe(true);
  });

  it("is true for an error result — the deadlock this guards against", () => {
    // The reducer's causality gate activates on ANY result regardless of
    // kind, so a failed tool's `{ kind: "error" }` result must also drive
    // the card's spinner-off + dismiss lifecycle. If this returned false,
    // the card would spin forever and the buffered following text would
    // never flush (only a page refresh recovered the answer).
    expect(
      ephemeralResultArrived({ result: { kind: "error", code: "sql_error", message: "boom" } }),
    ).toBe(true);
  });
});

describe("ephemeral card layout lifecycle", () => {
  let host: HTMLElement | null = null;
  let dispatch;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    dispatch = null;
    vi.useRealTimers();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function renderTurn(parts) {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    vi.useFakeTimers();
    dispatch = vi.fn();
    await act(async () => {
      render(h(MessageBubble, {
        turn: { role: "assistant", parts, done: false, citationCount: 0 },
        citations: [],
        dispatch,
      }), host!);
    });
  }

  async function finishEmptyResultLifecycle() {
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(host!.querySelector(".agent-ephemeral.is-dismissed")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(300); });
  }

  it("removes a dismissed card's DOM node so prose keeps only its normal flex gap", async () => {
    await renderTurn([
      { kind: "text", text: "" },
      {
        kind: "tool", toolCallId: "search-1", tool: "search_documents", args: { query: "status" },
        argsSummary: "", result: { kind: "search.results", query: "status", results: [] },
      },
      { kind: "text", text: "" },
    ]);

    expect(host!.querySelector(".agent-msg-body")!.children).toHaveLength(3);
    await finishEmptyResultLifecycle();
    expect(host!.querySelector(".agent-ephemeral")).toBeNull();
    expect(host!.querySelector(".agent-msg-body")!.children).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "ephemeral-tail-flush",
      toolCallId: "search-1",
    });
  });

  it("dismisses an interactive memory action after its result arrives", async () => {
    await renderTurn([
      {
        kind: "tool",
        toolCallId: "memory-1",
        tool: "annotate_person",
        args: {},
        argsSummary: "",
        result: {
          kind: "structured",
          resultType: "person_annotation.created",
          data: {},
        },
      },
    ]);

    expect(host!.querySelector(".agent-ephemeral")).not.toBeNull();
    await finishEmptyResultLifecycle();
    expect(host!.querySelector(".agent-ephemeral")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({
      kind: "ephemeral-tail-flush",
      toolCallId: "memory-1",
    });
  });

  it("removes every projected child DOM node of a dismissed batch card", async () => {
    await renderTurn([
      { kind: "text", text: "" },
      {
        kind: "tool", toolCallId: "batch-1", tool: "search_many",
        args: { queries: [{ query: "alpha" }, { query: "beta" }] }, argsSummary: "",
        result: {
          kind: "search.batch",
          items: [
            { kind: "search.results", query: "alpha", results: [] },
            { kind: "search.results", query: "beta", results: [] },
          ],
        },
      },
      { kind: "text", text: "" },
    ]);

    expect(host!.querySelectorAll(".agent-ephemeral")).toHaveLength(2);
    await finishEmptyResultLifecycle();
    expect(host!.querySelectorAll(".agent-ephemeral")).toHaveLength(0);
    expect(host!.querySelector(".agent-msg-body")!.children).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "ephemeral-tail-flush",
      toolCallId: "batch-1#0",
    });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "ephemeral-tail-flush",
      toolCallId: "batch-1#1",
    });
  });
});

describe("renderPart — subagent controls", () => {
  const toolPart = (tool) => ({
    kind: "tool",
    toolCallId: `tc-${tool}`,
    tool,
    args: {},
    argsSummary: "",
    result: null,
    durationMs: null,
  });

  it("renders spawn_subagent through the ephemeral action control", () => {
    const vnode = renderPart(toolPart("spawn_subagent"), 0, [], () => {}, null, false, true, false);
    expect(vnode).not.toBeNull();
    expect(vnode.type.name).toBe("EphemeralActionCard");
  });

  it("never renders join_subagents plumbing", () => {
    expect(renderPart(toolPart("join_subagents"), 0, [], () => {}, null, false, true, false)).toBeNull();
    expect(renderPart(toolPart("join_subagents"), 0, [], () => {}, null, false, false, true)).toBeNull();
  });

  it.each([
    "conversation_memory_evidence",
    "annotation_search",
    "annotate_durable",
    "annotation_revise",
    "annotation_retract",
    "annotation_supersede",
    "annotate_person",
    "person_annotation_revise",
    "person_annotation_retract",
    "person_annotation_supersede",
  ])("renders %s through the ephemeral action control", (tool) => {
    const vnode = renderPart(toolPart(tool), 0, [], () => {}, null, false, true, false);
    expect(vnode).not.toBeNull();
    expect(vnode.type.name).toBe("EphemeralActionCard");
  });

  it("renders an ephemeral tool in a static transcript", () => {
    const vnode = renderPart(
      toolPart("search_documents"),
      0,
      [],
      () => {},
      null,
      false,
      false,
      false,
    );

    expect(vnode).not.toBeNull();
    expect(vnode.type.name).toBe("StaticToolCard");
    expect(() => vnode.type(vnode.props)).not.toThrow();
  });
});

// ─── Inline researcher cards hide once the report is written (issue D) ──
//
// A subagent (researcher) part renders as a compact live card while the parent
// turn is live, then disappears once the turn is done. Timeline annotations
// retain its evidence; `renderPart` keys the progress row off `turnDone` (the
// same done-signal the thinking block uses).

describe("renderPart — inline researcher cards", () => {
  const subagentPart = {
    kind: "subagent",
    subagentId: "sa-1",
    specialist: "history-sweep",
    task: "Sweep mail",
    childTurns: [],
    docs: [],
    stepCount: 0,
    tokens: 0,
    status: null,
    summary: null,
    retainedCitationCount: 0,
    failureCode: null,
  };

  it("renders the subagent card while the turn is live (turnDone=false)", () => {
    // `renderPart` returns the SubagentCard VNode descriptor without invoking
    // the (hook-using) component body, so this stays a pure structural check.
    const vnode = renderPart(subagentPart, 0, [], () => {}, null, false, true, false);
    expect(vnode).not.toBeNull();
    expect(typeof vnode.type).toBe("function");
  });

  it("hides the subagent card once the turn is done (turnDone=true)", () => {
    const vnode = renderPart(subagentPart, 0, [], () => {}, null, false, true, true);
    expect(vnode).toBeNull();
  });

  it("a completed researcher card is also hidden once the turn is done", () => {
    const done = { ...subagentPart, status: "complete", summary: "Found 3 docs", stepCount: 5 };
    expect(renderPart(done, 0, [], () => {}, null, false, true, true)).toBeNull();
    // …but still shown while the turn is live.
    expect(renderPart(done, 0, [], () => {}, null, false, true, false)).not.toBeNull();
  });

  it("labels failed cited work as a partial result", () => {
    const component = renderPart(
      {
        ...subagentPart,
        status: "failed",
        summary: "Partial evidence collected before the worker reached its output limit:\n- Evidence",
        retainedCitationCount: 2,
        failureCode: "output_truncated",
      },
      0, [], () => {}, null, false, true, false,
    );
    const card = component.type(component.props);
    expect(findHostByClass(card, "agent-subagent-status").props.children).toBe("Partial result");
  });

  it("keeps uncited failures labelled couldn't finish", () => {
    const component = renderPart(
      { ...subagentPart, status: "failed", retainedCitationCount: 0 },
      0, [], () => {}, null, false, true, false,
    );
    const card = component.type(component.props);
    expect(findHostByClass(card, "agent-subagent-status").props.children).toBe("Couldn't finish");
  });

  it("keeps cited non-truncation failures labelled couldn't finish", () => {
    const component = renderPart(
      {
        ...subagentPart,
        status: "failed",
        summary: "HTTP model request failed.",
        retainedCitationCount: 2,
        failureCode: "http_api_error",
      },
      0, [], () => {}, null, false, true, false,
    );
    const card = component.type(component.props);
    expect(findHostByClass(card, "agent-subagent-status").props.children).toBe("Couldn't finish");
  });

  it("keeps source counts in a separate wrapping row below the stable header", () => {
    const withSources = {
      ...subagentPart,
      title: "A researcher title that needs the available header width",
      tokens: 12_400,
      docs: [
        ...Array.from({ length: 123 }, (_, index) => ({
          documentId: `mail-${index}`,
          sourceId: "alpha-mail:account",
        })),
        { documentId: "doc-3", sourceId: "beta-files:volume" },
        { documentId: "doc-4", sourceId: "gamma-notes:workspace" },
        { documentId: "doc-5", sourceId: "delta-chat:account" },
      ],
    };
    const component = renderPart(withSources, 0, [], () => {}, null, false, true, false);
    const card = component.type(component.props);
    const header = findHostByClass(card, "agent-subagent-header");
    const sources = findHostByClass(card, "agent-subagent-sources");

    expect(header).not.toBeNull();
    expect(sources).not.toBeNull();
    expect(findHostByClass(header, "agent-subagent-source")).toBeNull();
    expect(hostsByClass(sources, "agent-subagent-source")).toHaveLength(4);
    const sourceItems = hostsByClass(sources, "agent-subagent-source");
    expect(hostsByClass(sources, "agent-subagent-source-count").map(collectText)).toEqual(["99+", "1", "1", "1"]);
    expect(sourceItems[0].props.role).toBe("listitem");
    expect(sourceItems[0].props["aria-label"]).toContain("123 documents");
    expect(collectText(header)).toContain("Searching");
    expect(collectText(header)).toContain("12.4k tok");
    expect(header.props["aria-label"]).toContain("12.4k tokens");
  });

  it("styles budget exhaustion as an unsuccessful terminal state", () => {
    const component = renderPart(
      { ...subagentPart, status: "budget_exhausted", tokens: 980 },
      0, [], () => {}, null, false, true, false,
    );
    const card = component.type(component.props);

    expect(String(card.props.class).split(/\s+/)).toContain("unsuccessful");
    expect(collectText(card)).toContain("Stopped");
  });

  it("styles successful completion consistently with the native card", () => {
    const component = renderPart(
      { ...subagentPart, status: "complete", tokens: 1_250 },
      0, [], () => {}, null, false, true, false,
    );
    const card = component.type(component.props);

    expect(String(card.props.class).split(/\s+/)).toContain("complete");
    expect(collectText(card)).toContain("Done");
  });
});

function findHostByClass(vnode, className) {
  return hostsByClass(vnode, className)[0] ?? null;
}

function hostsByClass(vnode, className, matches = []) {
  if (vnode == null || typeof vnode === "boolean") return matches;
  if (Array.isArray(vnode)) {
    for (const child of vnode) hostsByClass(child, className, matches);
    return matches;
  }
  if (typeof vnode !== "object" || !vnode.type) return matches;
  if (typeof vnode.type === "function") {
    return hostsByClass(vnode.type(vnode.props ?? {}), className, matches);
  }
  const classes = String(vnode.props?.class ?? "").split(/\s+/);
  if (classes.includes(className)) matches.push(vnode);
  hostsByClass(vnode.props?.children, className, matches);
  return matches;
}

function collectText(vnode) {
  if (vnode == null || typeof vnode === "boolean") return "";
  if (Array.isArray(vnode)) return vnode.map(collectText).join("");
  if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
  if (typeof vnode.type === "function") return collectText(vnode.type(vnode.props ?? {}));
  return collectText(vnode.props?.children);
}

// ─── The watch card ───────────────────────────────────────────────────────
//
// The lightning chip is the user's receipt that the agent set a watch up
// without asking them to confirm it, and the way back to what it will do. It
// also has to keep rendering conversations recorded before the rename: a
// stored transcript is still theirs, and a card that resolved to nothing would
// leave a blank where an action happened.

describe("the watch card", () => {
  let host: HTMLElement | null = null;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  /** Render one tool part and hand back the card's text and link. */
  function card(tool: string, result: unknown): { text: string; href: string | null } {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    const part = {
      kind: "tool",
      toolCallId: "tc-watch",
      tool,
      args: {},
      argsSummary: "",
      result,
      durationMs: 12,
    };
    act(() => {
      render(renderPart(part, 0, [], () => {}, null, false, false, true), host!);
    });
    const anchor = host!.querySelector("a.agent-watch-card");
    return {
      text: (host!.textContent ?? "").replace(/\s+/g, " ").trim(),
      href: anchor ? anchor.getAttribute("href") : null,
    };
  }

  it("says what the agent did and links to the watch it did it to", () => {
    const { text, href } = card("watch_create", {
      kind: "watch.upserted",
      watchId: "w_1",
      name: "an-invoice-arrived",
      action: "created",
      enabled: true,
      summary: "Notify when a new invoice arrives.",
    });
    expect(text).toContain("Created watch");
    expect(text).toContain("an-invoice-arrived");
    expect(text).toContain("Notify when a new invoice arrives.");
    expect(href).toBe("/portal/watches/w_1");
  });

  it("still renders an upsert recorded before the rename", () => {
    const { text, href } = card("trigger_upsert", {
      kind: "trigger.upserted",
      triggerId: "trg_1",
      name: "old-one",
      action: "updated",
    });
    expect(text).toContain("Updated watch");
    expect(text).toContain("old-one");
    expect(href).toBe("/portal/watches/trg_1");
  });

  it("still renders a toggle recorded before the rename", () => {
    // The arm this covers is the one a demolition drops silently: the result
    // still decodes, still routes to the card, and would otherwise resolve to
    // nothing and render a blank where the user turned something off.
    const { text } = card("trigger_toggle", {
      kind: "trigger.toggled",
      triggerId: "trg_1",
      name: "old-one",
      enabled: false,
    });
    expect(text).toContain("Disabled watch");
    expect(text).toContain("old-one");
    expect(text).not.toContain("Setting up watch");
  });

  it("shows a placeholder only while the result is still in flight", () => {
    const { text } = card("watch_create", null);
    expect(text).toContain("Setting up watch");
  });

  it("renders nothing for the retired read-only tools", () => {
    // Background data fetches the agent used while answering, never an action
    // the user took — they had no card when they existed either.
    for (const tool of ["triggers_list", "trigger_get", "trigger_firings"]) {
      const part = {
        kind: "tool",
        toolCallId: "tc",
        tool,
        args: {},
        argsSummary: "",
        result: { kind: "triggers.listed", triggers: [] },
        durationMs: 1,
      };
      expect(renderPart(part, 0, [], () => {}, null, false, false, true), tool).toBeNull();
    }
  });
});

describe("a reopened stopped turn", () => {
  let host: HTMLElement | null = null;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  it("shows a muted stop note and no error block", () => {
    // The live view ends a stopped turn with no error affordance; the reopened
    // one says that it stopped, in the same quiet register. Prose is left out:
    // this harness has no DOM sanitizer for the markdown a text part renders.
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    act(() => {
      render(h(MessageBubble, {
        turn: {
          role: "assistant",
          parts: [],
          done: true,
          stopReason: "canceled",
          stopped: "You stopped this reply.",
          citationCount: 0,
        },
        citations: [],
        dispatch: () => {},
      }), host!);
    });
    expect(host!.querySelector(".agent-msg-error")).toBeNull();
    expect(host!.querySelector(".agent-msg-stopped")?.textContent).toBe("You stopped this reply.");
  });
});

describe("renderPart — after-the-fact card affordances", () => {
  let host: HTMLElement | null = null;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let win: Window;

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    vi.useRealTimers();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function renderStatic(part: Record<string, unknown>) {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    win = parsed.window as unknown as Window;
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    await act(async () => {
      render(
        h("div", null, renderPart(part as never, "tc", [], null, null, false, false, false)),
        host!,
      );
    });
    await act(async () => {});
  }

  function searchPart(overrides: Record<string, unknown> = {}) {
    return {
      kind: "tool",
      toolCallId: "tc-search",
      tool: "search_documents",
      args: { query: "invented" },
      argsSummary: "",
      result: {
        kind: "search.results",
        query: "invented",
        results: [{ sourceId: "gmail:invented@example.com", title: "Invented email" }],
      },
      durationMs: null,
      ...overrides,
    };
  }

  it("renders nothing trailing when the flags are absent", async () => {
    await renderStatic(searchPart());
    expect(host!.querySelector(".agent-ephemeral-time")).toBeNull();
    expect(host!.querySelector(".agent-ephemeral-raw")).toBeNull();
    expect(host!.querySelector(".agent-ephemeral-trailing")).toBeNull();
  });

  it("timestamps the card and opens the raw payload in an overlay", async () => {
    const rawPayload = { tool: "search_documents", marker: "raw-invented" };
    await renderStatic(searchPart({ timeText: "10:47 AM", rawPayload }));
    expect(host!.querySelector(".agent-ephemeral-time")?.textContent).toBe("10:47 AM");
    expect(host!.textContent).toContain("Invented email");
    expect(host!.textContent).not.toContain("raw-invented");
    const icon = host!.querySelector('button[aria-label="Show raw JSON"]');
    expect(icon).not.toBeNull();
    await act(async () => {
      icon!.dispatchEvent(new win.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host!.textContent).toContain("raw-invented");
  });

  it("renders a failed call through the shared collapsed error card", async () => {
    await renderStatic(
      searchPart({
        result: { kind: "error", code: "seed_not_found", message: "A requested seed was not found." },
      }),
    );
    const error = host!.querySelector(".agent-tool-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("seed_not_found");
    expect(error!.textContent).toContain("A requested seed was not found.");
  });

  it("propagates the instant to every batch child card", async () => {
    await renderStatic({
      kind: "tool",
      toolCallId: "tc-batch",
      tool: "search_many",
      args: { queries: [{ query: "alpha" }, { query: "beta" }] },
      argsSummary: "",
      result: {
        kind: "search.batch",
        items: [
          { kind: "search.results", query: "alpha", results: [] },
          { kind: "search.results", query: "beta", results: [] },
        ],
      },
      durationMs: null,
      timeText: "10:47 AM",
    });
    expect(host!.querySelectorAll(".agent-ephemeral-time")).toHaveLength(2);
  });

  function toolPart(tool: string, result: unknown, args: Record<string, unknown> = {}) {
    return {
      kind: "tool",
      toolCallId: `tc-${tool}`,
      tool,
      args,
      argsSummary: "",
      result,
      durationMs: null,
    };
  }

  function resultLinks(): (string | null)[] {
    return [...host!.querySelectorAll("a.agent-ephemeral-result-link")].map((a) =>
      a.getAttribute("href"),
    );
  }

  it("links search result rows to their documents, plain when id-less", async () => {
    await renderStatic(
      toolPart("search_documents", {
        kind: "search.results",
        query: "invented",
        results: [
          { documentId: "doc-1", sourceId: "gmail:invented@example.com", title: "First" },
          { sourceId: "gmail:invented@example.com", title: "No id" },
        ],
      }),
    );
    expect(resultLinks()).toEqual(["/portal/doc/doc-1"]);
    expect(host!.textContent).toContain("First");
    expect(host!.textContent).toContain("No id");
    expect(host!.querySelector(".agent-ephemeral-empty")).toBeNull();
  });

  it("lists looked-up people like search results, each linking to its page", async () => {
    await renderStatic(
      toolPart(
        "lookup_people",
        {
          kind: "person.results",
          query: "Invented Person",
          results: [
            { canonicalId: "person-1", displayName: "Invented Person" },
            { displayName: "No id Person" },
          ],
        },
        { name: "Invented Person" },
      ),
    );
    expect(resultLinks()).toEqual(["/portal/people/person-1"]);
    expect(host!.textContent).toContain("Invented Person");
  });

  it("links the opened document in the fetch header", async () => {
    await renderStatic(
      toolPart("fetch_document", {
        kind: "document",
        ref: { documentId: "doc-9", sourceId: "gmail:invented@example.com", title: "Opened" },
        document: { id: "doc-9", title: "Opened" },
      }),
    );
    expect(resultLinks()).toEqual(["/portal/doc/doc-9"]);
  });

  it("links trail documents and URL-lookup matches", async () => {
    await renderStatic(
      toolPart("trace_connections", {
        kind: "event_trail.built",
        seeds: ["doc-1"],
        events: [
          {
            eventId: "doc-1",
            at: "2026-03-12T09:14:00Z",
            kind: "document",
            doc: { documentId: "doc-1", title: "Lease", sourceId: "gmail:invented@example.com" },
          },
        ],
        truncated: false,
        stats: { visited: 1, elapsedMs: 1, maxDepthReached: 0 },
      }),
    );
    // The seed header links the resolved title, then the trail row links it again.
    expect(resultLinks()).toEqual(["/portal/doc/doc-1", "/portal/doc/doc-1"]);
    expect(host!.querySelector(".agent-ephemeral-doc-title")?.textContent).toContain("Lease");
    await renderStatic(
      toolPart(
        "lookup_document_by_url",
        {
          kind: "document.byUrl",
          url: "https://example.com/invented",
          ref: { documentId: "doc-2", sourceId: "gmail:invented@example.com", title: "By URL" },
        },
        { url: "https://example.com/invented" },
      ),
    );
    expect(resultLinks()).toEqual(["/portal/doc/doc-2"]);
  });

  it("reads No result for missing and empty results, never for errors", async () => {
    await renderStatic(toolPart("search_documents", null, { query: "invented" }));
    expect(host!.querySelector(".agent-ephemeral-empty")?.textContent).toBe("No result");
    await renderStatic(
      toolPart("search_documents", { kind: "search.results", query: "invented", results: [] }),
    );
    expect(host!.querySelector(".agent-ephemeral-empty")?.textContent).toBe("No result");
    await renderStatic(
      toolPart("lookup_document_by_url", { kind: "document.byUrl", url: "https://example.com/x" }),
    );
    expect(host!.querySelector(".agent-ephemeral-empty")?.textContent).toBe("No result");
    await renderStatic(
      toolPart("fetch_document", { kind: "error", code: "not_found", message: "gone" }),
    );
    expect(host!.querySelector(".agent-ephemeral-empty")).toBeNull();
    expect(host!.querySelector(".agent-tool-error")).not.toBeNull();
  });

  it("keeps citation tools silent even without a result", async () => {
    await renderStatic(toolPart("annotate", null));
    expect(host!.querySelector(".agent-ephemeral-empty")).toBeNull();
  });

  it("links loop rows and the fetched loop header", async () => {
    const loops = [
      { loopId: "loop-1", title: "First loop", state: "open" },
      { title: "No id loop", state: "open" },
    ];
    await renderStatic(
      toolPart("search_loops", { kind: "loops.searched", query: "invented", loops }),
    );
    const loopAnchors = [...host!.querySelectorAll("a.agent-loop-row")].map((a) =>
      a.getAttribute("href"),
    );
    expect(loopAnchors).toEqual(["/portal/debug/cognition/loops/loop-1"]);
    await renderStatic(
      toolPart("list_loops", { kind: "structured", resultType: "loops.listed", data: { loops } }),
    );
    expect(host!.querySelectorAll("a.agent-loop-row")).toHaveLength(1);
    await renderStatic(
      toolPart("fetch_loop", {
        kind: "loop.fetched",
        loop: { loopId: "loop-1", title: "First loop", state: "open" },
      }),
    );
    expect(resultLinks()).toEqual(["/portal/debug/cognition/loops/loop-1"]);
  });

  it("prints SQL rows statically with a more-rows note", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`a${i}`, `b${i}`]);
    await renderStatic(
      toolPart(
        "run_sql",
        { kind: "sql.rows", sql: "select 1", columns: ["a", "b"], rows, rowCount: 12 },
        { sql: "select 1" },
      ),
    );
    const cells = [...host!.querySelectorAll(".agent-ephemeral-sql-cell")].map((c) => c.textContent);
    expect(cells.slice(0, 4)).toEqual(["a0", "b0", "a1", "b1"]);
    expect(cells).toHaveLength(20);
    expect(host!.querySelector(".agent-ephemeral-note")?.textContent).toContain("+2 more rows");
    expect(host!.querySelector(".agent-ephemeral-empty")).toBeNull();
  });

  it("leaves the plan to its own surface and stays silent", async () => {
    await renderStatic(
      toolPart("plan", {
        kind: "plan.updated",
        items: [{ id: "p1", label: "Invented step", status: "done" }],
      }),
    );
    expect(host!.textContent).toBe("");
  });

  it("shows steward loop reads through the same loop cards", async () => {
    await renderStatic(
      toolPart("open_loop_search", {
        kind: "structured",
        resultType: "open_loop.search_results",
        data: { loops: [{ loopId: "loop-1", title: "Steward loop", state: "open" }], retired: 2 },
      }),
    );
    expect(host!.querySelector("a.agent-loop-row")?.getAttribute("href")).toBe(
      "/portal/debug/cognition/loops/loop-1",
    );
    expect(host!.querySelector(".agent-ephemeral-note")?.textContent).toBe("2 retired");
    await renderStatic(
      toolPart("open_loop_fetch", {
        kind: "structured",
        resultType: "open_loop.fetched",
        data: { loopId: "loop-1", title: "Steward loop", state: "open" },
      }),
    );
    expect(resultLinks()).toEqual(["/portal/debug/cognition/loops/loop-1"]);
  });

  it("lists entity neighborhoods", async () => {
    await renderStatic(
      toolPart("entity_context", {
        kind: "structured",
        resultType: "entity_context.reaped",
        data: {
          documents: [{ documentId: "doc-1", title: "Near doc", sourceId: "gmail:invented@example.com" }],
          people: [{ personId: "person-1", name: "Near Person" }],
          loops: [{ loopId: "loop-1", title: "Near loop", state: "open" }],
          temporalAnnotations: [{ annotationId: "a1", sentence: "Near moment" }],
        },
      }),
    );
    expect(resultLinks()).toEqual([
      "/portal/doc/doc-1",
      "/portal/people/person-1",
      "/portal/debug/cognition/loops/loop-1",
    ]);
    expect(host!.textContent).toContain("Near moment");
  });

  it("resolves trace seeds to titles, keeping unresolved ids", async () => {
    await renderStatic(
      toolPart(
        "trace_connections",
        {
          kind: "event_trail.built",
          seeds: ["doc-1", "doc-9"],
          events: [
            {
              eventId: "doc-1",
              kind: "document",
              doc: { documentId: "doc-1", title: "Lease", sourceId: "gmail:invented@example.com" },
            },
          ],
          truncated: false,
        },
        { seedIds: ["doc-1", "doc-9"] },
      ),
    );
    const header = host!.querySelector(".agent-ephemeral-doc-title");
    expect(header?.textContent).toContain("Lease, doc-9");
    expect(header?.querySelector(".agent-ephemeral-result-icon")).not.toBeNull();
    expect(host!.querySelector(".agent-ephemeral-arg")).toBeNull();
  });

  it("names the reaped entity in the header with its source icon", async () => {
    await renderStatic(
      toolPart(
        "entity_context",
        {
          kind: "structured",
          resultType: "entity_context.reaped",
          data: {
            seed: { kind: "document", id: "doc-1", label: "Near doc" },
            documents: [
              { documentId: "doc-1", title: "Near doc", sourceId: "gmail:invented@example.com" },
            ],
            people: [],
            loops: [],
            temporalAnnotations: [],
          },
        },
        { kind: "document", id: "doc-1" },
      ),
    );
    const header = host!.querySelector(".agent-ephemeral-doc-title");
    expect(header?.textContent).toContain("Near doc");
    expect(header?.querySelector(".agent-ephemeral-result-icon")).not.toBeNull();
    expect(resultLinks()[0]).toBe("/portal/doc/doc-1");
    expect(host!.querySelector(".agent-ephemeral-arg")).toBeNull();
  });

  it("falls back to kind and id when the reaped seed has no label", async () => {
    await renderStatic(
      toolPart(
        "entity_context",
        {
          kind: "structured",
          resultType: "entity_context.reaped",
          data: {
            seed: null,
            documents: [],
            people: [],
            loops: [],
            temporalAnnotations: [],
          },
        },
        { kind: "document", id: "doc-1" },
      ),
    );
    expect(host!.querySelector(".agent-ephemeral-doc-title")).toBeNull();
    expect(host!.querySelector(".agent-ephemeral-arg")?.textContent).toContain("document doc-1");
  });

  it("lists temporal query moments as plain rows", async () => {
    await renderStatic(
      toolPart("temporal_query", {
        kind: "structured",
        resultType: "temporal.results",
        data: { items: [{ label: "Invented morning" }] },
      }),
    );
    expect(host!.textContent).toContain("Invented morning");
    expect(resultLinks()).toEqual([]);
  });

  it("links the looked-up URL to its external target", async () => {
    await renderStatic(
      toolPart(
        "lookup_document_by_url",
        {
          kind: "document.byUrl",
          url: "https://example.com/invented",
          ref: { documentId: "doc-2", sourceId: "gmail:invented@example.com", title: "By URL" },
        },
        { url: "https://example.com/invented" },
      ),
    );
    const headerLink = host!.querySelector(".agent-ephemeral-arg a");
    expect(headerLink?.getAttribute("href")).toBe("https://example.com/invented");
    expect(headerLink?.getAttribute("target")).toBe("_blank");
  });

  it("stamps non-card tools and opens their raw payload", async () => {
    const rawPayload = { tool: "open_loop_create", marker: "raw-invented" };
    await renderStatic({
      ...toolPart(
        "open_loop_create",
        { kind: "structured", resultType: "open_loop.created", data: {} },
      ),
      timeText: "10:47 AM",
      rawPayload,
    });
    expect(host!.querySelector(".agent-toolcall")).not.toBeNull();
    expect(host!.querySelector(".agent-ephemeral-time")?.textContent).toBe("10:47 AM");
    expect(host!.textContent).not.toContain("raw-invented");
    expect(host!.querySelector('button[aria-label="Show raw JSON"]')).not.toBeNull();
  });
});
