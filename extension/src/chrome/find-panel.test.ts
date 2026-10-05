// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
import { highlightFindText, initFindPanel, type FindPanelView } from "./find-panel.js";
import { FIND_STATE_KEY } from "./find-service.js";
import type { FindMode } from "./find-query.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function panel(options: { initialQuery?: string; initialMode?: FindMode | null } = {}) {
  const { document, window } = parseHTML(
    readFileSync(new URL("../../public/notes.html", import.meta.url), "utf8"),
  );
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
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
  const openOptionsPage = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn(async (message: unknown) => {
    const msg = message as { type: string; query?: string; mode?: FindMode | null };
    if (msg.type === "notes-view") return { enabled: true };
    if (msg.type === "find-result") return { ok: true };
    if (msg.type === "find-update" || msg.type === "find-query")
      view = {
        ...view,
        query: msg.query!,
        mode: msg.mode ?? undefined,
        ...(msg.type === "find-query"
          ? { resultsQuery: msg.query!, resultsMode: msg.mode ?? undefined }
          : {}),
      };
    return view;
  });
  initFindPanel(
    document as unknown as Document,
    {
      runtime: {
        openOptionsPage,
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: async <T>(message: unknown): Promise<T> => {
          const value: unknown = await send(message);
          return value as T;
        },
      },
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
    },
    options,
  );
  return {
    document,
    window,
    openOptionsPage,
    input,
    send,
    focus: (element: Element) => {
      active = element;
    },
    update: (next: Partial<FindPanelView>) => {
      view = { ...view, ...next };
      changed?.({ [FIND_STATE_KEY]: { newValue: {} } }, "local");
    },
    mode: (mode: "notes" | "find") => {
      changed?.({ "omnesis.panel.view.v1": { newValue: mode } }, "local");
    },
  };
}
describe("Find panel", () => {
  it("opens a submitted full-page query using shared Find and keeps its workflow independent", async () => {
    const p = panel({ initialQuery: "invented full-page query" });
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "find-query",
        query: "invented full-page query",
        mode: null,
      }),
    );
    expect(p.input.value).toBe("invented full-page query");
    const result = p.document.querySelector(".find-result-open")!;
    p.focus(result);
    p.mode("notes");
    expect(p.document.activeElement).toBe(result);
    expect(p.document.getElementById("find-section")?.hidden).toBe(false);
    expect(p.document.getElementById("notes-section")?.hidden).toBe(true);
    expect(p.document.querySelector(".brand-title")?.textContent).toBe("OMNESIS");
  });
  it.each(["direct", "agentic"] as const)(
    "keeps %s mode separate from the visible query",
    async (mode) => {
      const p = panel({ initialQuery: "invented guide", initialMode: mode });
      await vi.waitFor(() =>
        expect(p.send).toHaveBeenCalledWith({
          type: "find-query",
          query: "invented guide",
          mode,
        }),
      );
      expect(p.input.value).toBe("invented guide");
    },
  );
  it("cleans a legacy prefixed link while keeping its mode", async () => {
    const p = panel({ initialQuery: "/agent invented guide" });
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "find-query",
        query: "invented guide",
        mode: "agentic",
      }),
    );
    expect(p.input.value).toBe("invented guide");
  });
  it("does not auto-submit a full-page query edited while initial status is loading", async () => {
    const p = panel({ initialQuery: "invented original query" });
    p.input.value = "a different unfinished thought";
    p.input.dispatchEvent(new p.window.Event("input"));
    await vi.waitFor(() => expect(p.document.getElementById("find-form")?.hidden).toBe(false));
    expect(
      p.send.mock.calls.some(([message]) => (message as { type: string }).type === "find-query"),
    ).toBe(false);
  });
  it("clears a running query through the search field without a separate cancel button", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    p.update({ running: true });
    p.input.value = "";
    p.input.dispatchEvent(new p.window.Event("input"));
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({ type: "find-update", query: "", mode: null }),
    );
    expect(p.document.querySelectorAll(".find-result")).toHaveLength(0);
    expect(p.document.getElementById("find-cancel")).toBeNull();
  });
  it("renders destination links without copy buttons and shows opening failures", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const link = p.document.querySelector<HTMLAnchorElement>(".find-result-open")!;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.org/guide");
    expect(p.document.querySelector(".find-new-copy")).toBeNull();
    p.send.mockRejectedValueOnce(new Error("Invented opening failure"));
    link.click();
    await vi.waitFor(() =>
      expect(p.document.getElementById("find-status")?.textContent).toBe(
        "Invented opening failure",
      ),
    );
  });
  it("keeps the query selection stable during progress and offers settings only for supported missing authority", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const select = vi.mocked(p.input.select);
    select.mockClear();
    p.update({ running: true, agentText: "Invented progress" });
    await vi.waitFor(() =>
      expect(p.document.getElementById("find-agent")?.textContent).toContain("Invented progress"),
    );
    expect(p.document.getElementById("find-cancel")).toBeNull();
    expect(select).not.toHaveBeenCalled();
    p.update({ running: false, enabled: false });
    await vi.waitFor(() => expect(p.document.getElementById("find-settings")?.hidden).toBe(false));
    p.document.getElementById("find-settings")!.click();
    expect(p.openOptionsPage).toHaveBeenCalledOnce();
    p.update({ supported: false });
    await vi.waitFor(() => expect(p.document.getElementById("find-settings")?.hidden).toBe(true));
    expect(p.document.querySelector(".panel-nav")).toBeNull();
  });
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
    const fallback = p.document.querySelector(".find-icon span") as HTMLElement;
    expect(img.hidden).toBe(true);
    expect(fallback.hidden).toBe(false);
    img.dispatchEvent(new p.window.Event("load"));
    expect(img.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
    img.dispatchEvent(new p.window.Event("error"));
    expect(img.hidden).toBe(true);
    expect(fallback.hidden).toBe(false);
    img.dispatchEvent(new p.window.Event("load"));
    expect(img.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
    expect(p.document.getElementById("find-mode")?.hidden).toBe(true);
    expect(p.document.querySelector('label[for="find-query"]')).toBeNull();
    expect(p.input.getAttribute("aria-label")).toBe("Find in Omnesis");
  });
  it("opens stable result identity with arrow/Enter and supports modified Enter", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    function key(key: string) {
      const event = new p.window.Event("keydown", { bubbles: true, cancelable: true });
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
    const modified = new p.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(modified, { key: "Enter", ctrlKey: true });
    p.input.dispatchEvent(modified);
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "find-result",
        resultId: "second",
        newCopy: true,
      }),
    );
  });
  it("navigates results after focus moves from the search box to the page or agent output", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    for (const [target, key, expected] of [
      [p.document.body, "ArrowDown", "second"],
      [p.document.getElementById("find-agent")!, "ArrowUp", "first"],
      [p.document.querySelector(".find-result-open")!, "ArrowDown", "second"],
    ] as const) {
      const event = new p.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, { key });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(
        p.document.querySelector(".find-result.selected")?.getAttribute("data-result-id"),
      ).toBe(expected);
      expect(p.document.querySelectorAll(".find-result.selected")).toHaveLength(1);
    }
  });
  it("leaves arrow keys available in other editable controls", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const field = p.document.createElement("textarea");
    p.document.body.appendChild(field);
    const event = new p.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key: "ArrowDown" });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(p.document.querySelector(".find-result.selected")?.getAttribute("data-result-id")).toBe(
      "first",
    );
  });
  it("does not offer a search-more control", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    expect(p.document.getElementById("find-more")).toBeNull();
  });
  it("tracks a result focused with native tab before ctrl/command+enter", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const copy = p.document.querySelectorAll(".find-result-open")[1]!;
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
        { kind: "text", text: "I found an invented link." },
        {
          kind: "tool",
          toolCallId: "tool-1",
          tool: "search_documents",
          argsSummary: "Invented query",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(p.document.getElementById("find-agent")?.textContent).toContain("invented link"),
    );
    expect(p.document.getElementById("find-cancel")).toBeNull();
    expect(p.document.getElementById("find-mode")?.hidden).toBe(false);
    expect(p.document.getElementById("find-mode")?.textContent).toContain(
      "Agentic mode auto enabled",
    );
    expect(p.document.getElementById("find-mode")?.textContent).not.toContain(
      "A relationship requires investigation",
    );
    expect(p.document.querySelectorAll("#find-mode-progress .agent-typing > span")).toHaveLength(3);
    expect(p.document.querySelector("#find-mode svg path")).not.toBeNull();
    expect(p.document.getElementById("find-status")?.hidden).toBe(true);
    expect(p.document.querySelector(".agent-ephemeral")?.textContent).toContain("Search");
    p.update({ running: false });
    await vi.waitFor(() =>
      expect(p.document.getElementById("find-mode-progress")?.hidden).toBe(true),
    );
    expect(p.document.getElementById("find-mode")?.hidden).toBe(false);
    p.input.value = "different";
    p.input.dispatchEvent(new p.window.Event("input"));
    expect(p.document.getElementById("find-mode")?.hidden).toBe(true);
    expect(p.document.getElementById("find-agent")?.hidden).toBe(true);
    expect(p.document.querySelectorAll(".agent-ephemeral")).toHaveLength(0);
    expect(p.document.querySelectorAll(".find-result")).toHaveLength(0);
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({ type: "find-update", query: "different", mode: null }),
    );
  });
  it("preserves focus on a result link while live result updates render", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    const copy = p.document.querySelector(".find-result-open")!;
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
        expect(p.document.activeElement?.classList.contains("find-result-open")).toBe(true);
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
      const event = new p.window.Event("keydown", { bubbles: true, cancelable: true });
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
    expect(p.document.getElementById("find-form")?.hidden).toBe(true);
    expect(p.document.getElementById("find-form")?.hidden).toBe(true);
    expect((p.document.querySelector(".find-footer") as unknown as HTMLElement).hidden).toBe(true);
  });
  it("offers results immediately without an additional tab-access action", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    expect(p.document.getElementById("find-match-tabs")).toBeNull();
  });
  it("typing saves the query without starting a billed decision or agent turn", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll(".find-result")).toHaveLength(2));
    vi.useFakeTimers();
    p.input.value = "A new invented question";
    p.input.dispatchEvent(new p.window.Event("input"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.send).toHaveBeenCalledWith({
      type: "find-update",
      query: "A new invented question",
      mode: null,
    });
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
      mode: null,
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
  it("excludes routing commands from snippet highlighting", () => {
    const { document } = parseHTML("<p></p>");
    const target = document.querySelector("p")!;
    highlightFindText(
      document as unknown as Document,
      target as unknown as HTMLElement,
      "An agent wrote the search guide",
      "/agent guide",
    );
    expect([...target.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["guide"]);
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
