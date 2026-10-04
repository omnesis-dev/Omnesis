// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightFindText, initFindPanel, type FindPanelView } from "./find-panel.js";
import { FIND_STATE_KEY } from "./find-service.js";

afterEach(() => vi.useRealTimers());
function panel() {
  const { document, window } = parseHTML(
    readFileSync(new URL("../../public/notes.html", import.meta.url), "utf8"),
  );
  let active: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => active });
  const input = document.getElementById("find-query") as unknown as HTMLInputElement;
  input.focus = () => {
    active = input as unknown as Element;
  };
  input.select = vi.fn();
  let view: FindPanelView = {
    canonicalizers: [],
    supported: true,
    enabled: true,
    pendingApproval: false,
    query: "invented",
    resultsQuery: "invented",
    hasMore: false,
    running: false,
    interrupted: false,
    tabsPermission: false,
    faviconPermission: true,
    openResults: ["first"],
    decision: { mode: "direct", status: "not_configured", reason: "Decision model not configured" },
    results: [
      {
        id: "first",
        documentId: "same-evidence",
        title: "Invented guide",
        url: "https://example.org/guide",
        snippet: "An invented matching passage <img src=x>",
        source: "Example",
      },
      {
        id: "second",
        documentId: "same-evidence",
        title: "Another guide",
        url: "https://example.org/another",
        snippet: "More invented context",
        source: "Example",
      },
    ],
  };
  let changed:
    | ((changes: Record<string, { newValue?: unknown }>, area: string) => void)
    | undefined;
  const request = vi.fn().mockResolvedValue(true);
  const send = vi.fn(async (message: unknown) => {
    const msg = message as { type: string; query?: string };
    if (msg.type === "notes-view") return { enabled: true };
    if (msg.type === "find-result") return { ok: true };
    if (msg.type === "find-update" || msg.type === "find-query")
      view = {
        ...view,
        query: msg.query!,
        ...(msg.type === "find-query" ? { resultsQuery: msg.query! } : {}),
      };
    return view;
  });
  initFindPanel(document as unknown as Document, {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async <T>(message: unknown): Promise<T> => {
        const value: unknown = await send(message);
        return value as T;
      },
    },
    permissions: { request },
    storage: {
      local: {
        get: async () => ({ "omnesis.panel.view.v1": "find" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: (callback) => {
          changed = callback;
        },
      },
    },
  });
  return {
    document,
    window,
    input,
    send,
    request,
    focus: (element: Element) => {
      active = element;
    },
    update: (next: Partial<FindPanelView>) => {
      view = { ...view, ...next };
      changed?.({ [FIND_STATE_KEY]: { newValue: {} } }, "local");
    },
  };
}
describe("Find panel", () => {
  it("renders ranked highlighted cards with local favicon, source and open-tab badge", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    expect(p.document.querySelector(".find-open-badge")?.textContent).toBe("Open tab");
    expect(p.document.querySelector(".find-result-meta")?.textContent).toContain(
      "example.org · Example",
    );
    expect(p.document.querySelector(".find-snippet mark")?.textContent).toBe("invented");
    expect(p.document.querySelector(".find-snippet img")).toBeNull();
    const img = p.document.querySelector(".find-icon img") as unknown as HTMLImageElement;
    expect(img.src).toContain("chrome-extension://test/_favicon/");
    img.dispatchEvent(new p.window.Event("error"));
    expect(img.hidden).toBe(true);
    expect(p.document.getElementById("find-decision")?.textContent).toContain(
      "Decision model not configured",
    );
  });
  it("opens stable result identity with arrow/Enter and offers an explicit new copy", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    function key(key: string) {
      const event = new p.window.Event("keydown", { cancelable: true });
      Object.assign(event, { key });
      p.input.dispatchEvent(event);
    }
    key("ArrowDown");
    key("Enter");
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "find-result",
        resultId: "second",
        newCopy: false,
      }),
    );
    p.document.querySelector(".find-new-copy")!.dispatchEvent(new p.window.Event("click"));
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "find-result",
        resultId: "first",
        newCopy: true,
      }),
    );
  });
  it("tracks a result focused with native tab before ctrl/command+enter", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const copy = p.document.querySelectorAll(".find-new-copy")[1]!;
    p.focus(copy);
    copy.dispatchEvent(new p.window.Event("focusin", { bubbles: true }));
    const event = new p.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key: "Enter", ctrlKey: true });
    copy.dispatchEvent(event);
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "find-result",
        resultId: "second",
        newCopy: true,
      }),
    );
  });
  it("streams current decision/explanation/cards and hides stale decisions during a different typed query", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    p.update({
      running: true,
      decision: {
        mode: "agentic",
        status: "decided",
        reason: "A relationship requires investigation",
      },
      agentText: "I found an invented link.",
      activity: "search documents",
      tools: [
        { id: "tool-1", tool: "Searching documents", summary: "Invented query", status: "running" },
      ],
    });
    await vi.waitFor(() =>
      expect(p.document.getElementById("find-agent")?.textContent).toContain("invented link"),
    );
    expect(p.document.getElementById("find-cancel")?.hidden).toBe(false);
    expect(p.document.querySelector(".find-tool-card")?.textContent).toContain(
      "Searching documents",
    );
    p.update({ running: false });
    p.input.value = "different";
    p.input.dispatchEvent(new p.window.Event("input"));
    expect(p.document.getElementById("find-decision")?.hidden).toBe(true);
    expect(p.document.getElementById("find-tools")?.hidden).toBe(true);
    expect(p.document.querySelectorAll(".find-tool-card")).toHaveLength(0);
    expect(p.document.querySelectorAll(".find-result")).toHaveLength(0);
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({ type: "find-update", query: "different" }),
    );
  });
  it("preserves focus on the new-copy action while live result updates render", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const copy = p.document.querySelector(".find-new-copy")!;
    p.focus(copy);
    // A browser's native button focus is modeled for newly rendered nodes.
    p.document.addEventListener("focus", (event) => p.focus(event.target as Element));
    const prototype = Object.getPrototypeOf(copy) as { focus?: () => void };
    const original = prototype.focus;
    prototype.focus = function (this: Element) {
      p.focus(this);
    };
    try {
      p.update({ running: true });
      await vi.waitFor(() => {
        expect(p.document.activeElement?.classList.contains("find-new-copy")).toBe(true);
        expect(p.document.activeElement).not.toBe(copy);
      });
    } finally {
      prototype.focus = original;
    }
  });
  it("does not force scroll during stream renders but scrolls explicit keyboard selection", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const row = p.document.querySelector(".find-result")!;
    const prototype = Object.getPrototypeOf(row) as { scrollIntoView?: () => void };
    const original = prototype.scrollIntoView,
      scroll = vi.fn();
    prototype.scrollIntoView = scroll;
    try {
      p.update({ running: true, agentText: "Invented progress" });
      await vi.waitFor(() => expect(p.document.querySelector(".find-result")).not.toBe(row));
      expect(scroll).not.toHaveBeenCalled();
      const event = new p.window.Event("keydown", { cancelable: true });
      Object.assign(event, { key: "ArrowDown" });
      p.input.dispatchEvent(event);
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      prototype.scrollIntoView = original;
    }
  });
  it("does not offer unsupported features or persistently expose revoked results", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    p.update({ supported: false, enabled: false, results: [] });
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(0));
    expect(p.document.getElementById("panel-find")?.hidden).toBe(true);
    expect(p.document.getElementById("find-form")?.hidden).toBe(true);
  });
  it("requests broader tabs access only from its explicit action", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    expect(p.request).not.toHaveBeenCalled();
    p.document.getElementById("find-match-tabs")!.dispatchEvent(new p.window.Event("click"));
    expect(p.request).toHaveBeenCalledWith({ permissions: ["tabs"] });
  });
  it("typing saves the query without starting a billed decision or agent turn", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    vi.useFakeTimers();
    p.input.value = "A new invented question";
    p.input.dispatchEvent(new p.window.Event("input"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.send).toHaveBeenCalledWith({ type: "find-update", query: "A new invented question" });
    expect(
      p.send.mock.calls.some(([message]) => (message as { type: string }).type === "find-query"),
    ).toBe(false);
    p.document
      .getElementById("find-form")!
      .dispatchEvent(new p.window.Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.send).toHaveBeenCalledWith({
      type: "find-query",
      query: "A new invented question",
      more: false,
    });
  });
  it("treats indexed HTML as text", () => {
    const { document } = parseHTML("<div id=snippet></div>");
    const snippet = document.getElementById("snippet")!;
    highlightFindText(
      document as unknown as Document,
      snippet as unknown as HTMLElement,
      "<script>invented</script>",
      "invented",
    );
    expect(snippet.querySelector("script")).toBeNull();
    expect(snippet.textContent).toBe("<script>invented</script>");
  });
  it("highlights meaningful terms without highlighting every common function word", () => {
    const { document } = parseHTML("<div id='target'></div>");
    const target = document.getElementById("target")!;
    highlightFindText(
      document as unknown as Document,
      target as unknown as HTMLElement,
      "The project brief uses UI design",
      "the project brief UI",
    );
    expect([...target.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "project",
      "brief",
      "UI",
    ]);
  });
});
