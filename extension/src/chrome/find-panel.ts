// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { findQueryTerms } from "./find-results.js";
import { FIND_STATE_KEY, type FindResult, type FindView } from "./find-service.js";
import { NOTES_STATE_KEY, type NotesView } from "./notes-service.js";
import { PANEL_VIEW_KEY } from "./panel-surface.js";

export interface FindPanelView extends FindView {
  openResults?: string[];
  tabsPermission?: boolean;
  faviconPermission?: boolean;
}
interface PanelApi {
  runtime: { sendMessage<T>(message: unknown): Promise<T>; getURL(path: string): string };
  permissions: { request(permission: { permissions: string[] }): Promise<boolean> };
  storage: {
    local: {
      get(keys: string): Promise<Record<string, unknown>>;
      set(value: Record<string, unknown>): Promise<void>;
    };
    onChanged: {
      addListener(
        callback: (changes: Record<string, { newValue?: unknown }>, area: string) => void,
      ): void;
    };
  };
}

/** Highlight query words with text nodes; indexed snippets never become HTML. */
export function highlightFindText(
  document: Document,
  element: HTMLElement,
  text: string,
  query: string,
): void {
  const words = findQueryTerms(query);
  element.replaceChildren();
  if (!words.length) {
    element.textContent = text;
    return;
  }
  const pattern = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    element.appendChild(document.createTextNode(text.slice(offset, index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    element.appendChild(mark);
    offset = index + match[0].length;
  }
  element.appendChild(document.createTextNode(text.slice(offset)));
}

export function initFindPanel(document: Document, api: PanelApi): void {
  const element = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing #${id}`);
    return value as T;
  };
  const input = element<HTMLInputElement>("find-query");
  const form = element<HTMLFormElement>("find-form");
  const list = element<HTMLOListElement>("find-results");
  const status = element("find-status");
  const more = element<HTMLButtonElement>("find-more");
  const matchTabs = element<HTMLButtonElement>("find-match-tabs");
  const findSection = element("find-section"),
    notesSection = element("notes-section");
  const findNav = element<HTMLButtonElement>("panel-find"),
    notesNav = element<HTMLButtonElement>("panel-notes");
  let view: FindPanelView | undefined,
    selected = 0,
    generation = 0,
    searching = false;
  let mode: "find" | "notes" = "notes";
  let dirtyInput = false;
  let refreshGeneration = 0;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const cancel = element<HTMLButtonElement>("find-cancel");
  function selectMode(next: "find" | "notes"): void {
    mode = next;
    findSection.hidden = next !== "find";
    notesSection.hidden = next !== "notes";
    findNav.setAttribute("aria-pressed", String(next === "find"));
    notesNav.setAttribute("aria-pressed", String(next === "notes"));
    if (next === "find") {
      input.focus();
      input.select?.();
    } else {
      const textarea = document.getElementById("note-text") as HTMLTextAreaElement | null;
      if (textarea && !textarea.closest("[hidden]")) textarea.focus();
    }
  }
  findNav.addEventListener("click", () => {
    selectMode("find");
    void api.storage.local.set({ [PANEL_VIEW_KEY]: "find" });
  });
  notesNav.addEventListener("click", () => {
    selectMode("notes");
    void api.storage.local.set({ [PANEL_VIEW_KEY]: "notes" });
  });
  function select(index: number, focus = false, scroll = true): void {
    selected = Math.max(0, Math.min(index, (view?.results.length ?? 1) - 1));
    const rows = [...list.children];
    for (let i = 0; i < rows.length; i++) {
      rows[i]!.classList.toggle("selected", i === selected);
      rows[i]!.querySelector(".find-result-open")?.setAttribute(
        "aria-current",
        String(i === selected),
      );
    }
    if (scroll) rows[selected]?.scrollIntoView?.({ block: "nearest" });
    if (focus)
      (rows[selected]?.querySelector(".find-result-open") as HTMLButtonElement | null)?.focus();
  }
  async function activate(result: FindResult, newCopy = false): Promise<void> {
    try {
      const response = await api.runtime.sendMessage<{ ok?: boolean; reason?: string }>({
        type: "find-result",
        resultId: result.id,
        newCopy,
      });
      if (!response?.ok) throw new Error(response?.reason ?? "This result could not open");
      void refresh(true);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Try again";
    }
  }
  function render(next: FindPanelView): void {
    if (!next || typeof next.supported !== "boolean") return;
    view = next;
    if (next.running && !keepalive)
      keepalive = setInterval(() => {
        void refresh(true);
      }, 20000);
    else if (!next.running && keepalive) {
      clearInterval(keepalive);
      keepalive = undefined;
    }
    findNav.hidden = !next.enabled;
    form.hidden = !next.enabled;
    const footer = document.querySelector<HTMLElement>(".find-footer");
    if (footer) footer.hidden = !next.enabled;
    if (!dirtyInput) {
      input.value = next.query;
      if (mode === "find") input.select?.();
    }
    matchTabs.hidden = !next.enabled || next.tabsPermission === true;
    more.hidden = !next.enabled || !next.hasMore;
    const currentResults = next.resultsQuery === input.value;
    cancel.hidden = !next.running || !currentResults;
    more.hidden ||= !currentResults;
    status.textContent = !next.supported
      ? "Find is unavailable on this gateway."
      : !next.enabled
        ? "Enable Find in the extension settings to search your Omnesis data."
        : next.running && currentResults
          ? next.activity
            ? `Omnesis · ${next.activity}`
            : next.decision?.mode === "agentic"
              ? "Omnesis is investigating…"
              : "Searching your Omnesis…"
          : ((currentResults ? next.error : undefined) ??
            (next.interrupted && currentResults
              ? "Search was interrupted. Results are kept; search again to continue."
              : undefined) ??
            (!input.value.trim()
              ? "Find something you remember."
              : !currentResults
                ? "Press Enter to search."
                : !next.results.length
                  ? "No browser links found. Try a different query or search more results."
                  : `${next.results.length} ${next.results.length === 1 ? "result" : "results"} · ↑ ↓ to choose · Enter to open`));
    const decision = element("find-decision"),
      agent = element("find-agent");
    decision.hidden = !next.decision || !currentResults;
    decision.textContent = next.decision
      ? `${next.decision.mode === "agentic" ? "Agent search" : "Direct search"}${next.decision.model ? ` · ${next.decision.model}` : ""} · ${next.decision.reason}`
      : "";
    agent.hidden = !next.agentText || !currentResults;
    agent.textContent = next.agentText ?? "";
    const focusedResult = (document.activeElement?.closest(".find-result") as HTMLElement | null)
      ?.dataset.resultId;
    const focusedAction = document.activeElement?.classList.contains("find-new-copy")
      ? ".find-new-copy"
      : ".find-result-open";
    const tools = element("find-tools");
    tools.replaceChildren();
    tools.hidden = !currentResults || !next.running || !next.tools?.length;
    if (!tools.hidden)
      for (const tool of next.tools ?? []) {
        const card = document.createElement("article");
        card.className = "find-tool-card";
        const head = document.createElement("div");
        head.className = "find-tool-head";
        const title = document.createElement("strong");
        title.textContent = tool.tool;
        const state = document.createElement("span");
        state.textContent =
          tool.status === "preparing"
            ? "Preparing…"
            : tool.status === "running"
              ? "Running…"
              : tool.status === "error"
                ? "Failed"
                : "Done";
        state.className = `find-tool-state ${tool.status}`;
        head.append(title, state);
        card.appendChild(head);
        if (tool.summary) {
          const summary = document.createElement("p");
          summary.textContent = tool.summary;
          card.appendChild(summary);
        }
        if (tool.result) {
          const result = document.createElement("p");
          result.className = "find-tool-result";
          result.textContent = tool.result;
          card.appendChild(result);
        }
        tools.appendChild(card);
      }
    list.replaceChildren();
    if (!next.enabled || !currentResults) {
      return;
    }
    for (const [index, result] of next.results.entries()) {
      const row = document.createElement("li");
      row.id = `find-result-${index}`;
      row.className = "find-result";
      row.dataset.resultId = result.id;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "find-result-open";
      const icon = document.createElement("span");
      icon.className = "find-icon";
      const fallback = document.createElement("span");
      fallback.textContent = new URL(result.url).hostname[0]?.toUpperCase() ?? "↗";
      fallback.setAttribute("aria-hidden", "true");
      icon.appendChild(fallback);
      if (next.faviconPermission) {
        const img = document.createElement("img");
        img.alt = "";
        img.width = 20;
        img.height = 20;
        const url = new URL(api.runtime.getURL("_favicon/"));
        url.searchParams.set("pageUrl", result.url);
        url.searchParams.set("size", "32");
        img.src = url.href;
        img.addEventListener("error", () => {
          img.hidden = true;
        });
        icon.appendChild(img);
      }
      const body = document.createElement("span");
      body.className = "find-result-body";
      const title = document.createElement("strong");
      title.className = "find-result-title";
      highlightFindText(document, title, result.title, next.resultsQuery);
      body.appendChild(title);
      const meta = document.createElement("span");
      meta.className = "find-result-meta";
      meta.textContent = `${new URL(result.url).hostname} · ${result.source}`;
      if (next.openResults?.includes(result.id)) {
        const badge = document.createElement("span");
        badge.className = "find-open-badge";
        badge.textContent = "Open tab";
        meta.appendChild(badge);
      }
      body.appendChild(meta);
      const snippet = document.createElement("span");
      snippet.className = "find-snippet";
      highlightFindText(document, snippet, result.snippet, next.resultsQuery);
      body.appendChild(snippet);
      if (result.evidence?.length) {
        const evidence = document.createElement("span");
        evidence.className = "find-result-meta";
        evidence.textContent = `From ${result.evidence.map((ref) => ref.title).join(" · ")}`;
        body.appendChild(evidence);
      }
      if (result.attribution) {
        const footer = document.createElement("span");
        footer.className = "find-result-meta";
        footer.textContent = result.attribution;
        body.appendChild(footer);
      }
      open.append(icon, body);
      open.addEventListener("click", () => {
        select(index);
        void activate(result);
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "find-new-copy secondary";
      copy.textContent = "↗";
      copy.title = "Open a new copy";
      copy.setAttribute("aria-label", `Open a new copy of ${result.title}`);
      copy.addEventListener("click", () => {
        void activate(result, true);
      });
      row.append(open, copy);
      list.appendChild(row);
    }
    select(selected, false, false);
    if (focusedResult)
      (
        [...list.children]
          .find((row) => (row as HTMLElement).dataset.resultId === focusedResult)
          ?.querySelector(focusedAction) as HTMLButtonElement | null
      )?.focus({ preventScroll: true });
  }
  async function refresh(cached = false): Promise<void> {
    const request = ++refreshGeneration;
    try {
      const next = await api.runtime.sendMessage<FindPanelView>({
        type: cached ? "find-view" : "find-status",
      });
      if (request === refreshGeneration) render(next);
    } catch (error) {
      if (request === refreshGeneration)
        status.textContent = error instanceof Error ? error.message : "Gateway unavailable";
    }
  }
  async function search(moreResults = false): Promise<void> {
    const request = ++generation,
      query = input.value;
    searching = true;
    selected = 0;
    status.textContent = "Searching your Omnesis…";
    form.setAttribute("aria-busy", "true");
    try {
      const next = await api.runtime.sendMessage<FindPanelView & { ok?: boolean; reason?: string }>(
        { type: "find-query", query, more: moreResults },
      );
      if (request !== generation) return;
      if (next?.ok === false) throw new Error(next.reason ?? "Search failed");
      searching = false;
      render(next);
    } catch (error) {
      if (request === generation) {
        searching = false;
        status.textContent = error instanceof Error ? error.message : "Search failed. Try again.";
      }
    } finally {
      if (request === generation) form.setAttribute("aria-busy", "false");
    }
  }
  input.addEventListener("input", () => {
    dirtyInput = true;
    generation++;
    searching = false;
    void api.runtime
      .sendMessage({ type: "find-update", query: input.value })
      .catch(() => undefined);
    if (view) render(view);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void search();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(selected + (event.key === "ArrowDown" ? 1 : -1), true);
    } else if (
      event.key === "Enter" &&
      view?.resultsQuery === input.value &&
      view.results[selected] &&
      !searching
    ) {
      event.preventDefault();
      void activate(view.results[selected]!, event.metaKey || event.ctrlKey);
    }
  });
  list.addEventListener("focusin", (event) => {
    const row = (event.target as Element | null)?.closest(".find-result") as HTMLElement | null;
    const index = view?.results.findIndex((result) => result.id === row?.dataset.resultId) ?? -1;
    if (index >= 0) select(index, false, false);
  });
  list.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(selected + (event.key === "ArrowDown" ? 1 : -1), true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.focus();
    } else if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      view?.results[selected]
    ) {
      event.preventDefault();
      void activate(view.results[selected]!, true);
    }
  });
  cancel.addEventListener("click", () => {
    void api.runtime.sendMessage({ type: "find-cancel" }).then(() => refresh(true));
  });
  more.addEventListener("click", () => {
    void search(true);
  });
  matchTabs.addEventListener("click", () => {
    void api.permissions
      .request({ permissions: ["tabs"] })
      .then(() => refresh(true))
      .catch(() => {
        status.textContent = "Open-tab matching uses only the sites this extension may access.";
      });
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes[PANEL_VIEW_KEY]?.newValue === "find" ||
      changes[PANEL_VIEW_KEY]?.newValue === "notes"
    )
      selectMode(changes[PANEL_VIEW_KEY]!.newValue as "find" | "notes");
    if (FIND_STATE_KEY in changes) void refresh(true);
    if (NOTES_STATE_KEY in changes)
      void api.runtime.sendMessage<NotesView>({ type: "notes-view" }).then((notes) => {
        notesNav.hidden = !notes.enabled;
      });
  });
  void api.storage.local.get(PANEL_VIEW_KEY).then((state) => {
    selectMode(state[PANEL_VIEW_KEY] === "find" ? "find" : "notes");
  });
  void api.runtime.sendMessage<NotesView>({ type: "notes-status" }).then((notes) => {
    notesNav.hidden = !notes?.enabled;
  });
  void refresh().then(() => {
    if (mode === "find") input.focus();
  });
}
