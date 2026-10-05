// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render as renderComponent, ThinkingDots } from "@omnesis/gateway/agent-ui";
import { createFindConversation } from "./find-conversation.js";
import { parseFindQuery, type FindMode } from "./find-query.js";
import { findQueryTerms } from "./find-results.js";
import { FIND_STATE_KEY, type FindResult, type FindView } from "./find-service.js";

export interface FindPanelView extends FindView {
  openResults?: string[];
  tabsPermission?: boolean;
  faviconPermission?: boolean;
}
interface PanelApi {
  runtime: {
    sendMessage<T>(message: unknown): Promise<T>;
    getURL(path: string): string;
    openOptionsPage?(): Promise<void>;
  };
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
  const words = findQueryTerms(parseFindQuery(query).text);
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

export function initFindPanel(
  document: Document,
  api: PanelApi,
  options: { initialQuery?: string; initialMode?: FindMode | null } = {},
): void {
  const element = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing #${id}`);
    return value as T;
  };
  const input = element<HTMLInputElement>("find-query");
  const form = element<HTMLFormElement>("find-form");
  const list = element<HTMLOListElement>("find-results");
  const status = element("find-status");
  const findSection = element("find-section"),
    notesSection = document.getElementById("notes-section");
  let view: FindPanelView | undefined,
    selected = 0,
    generation = 0,
    searching = false;
  let dirtyInput = options.initialQuery !== undefined;
  const initial = parseFindQuery(options.initialQuery ?? "");
  let mode: FindMode | null | undefined =
    options.initialQuery !== undefined ? (initial.mode ?? options.initialMode ?? null) : undefined;
  if (dirtyInput) input.value = initial.text;
  let refreshGeneration = 0;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const settings = element<HTMLButtonElement>("find-settings");
  settings.addEventListener("click", () => {
    void api.runtime.openOptionsPage?.();
  });
  findSection.hidden = false;
  if (notesSection) notesSection.hidden = true;
  const title = document.querySelector<HTMLElement>(".brand-title");
  if (title) title.textContent = "OMNESIS";
  const conversation = createFindConversation(element("find-agent"), (toolCallId, progressId) => {
    void api.runtime
      .sendMessage({ type: "find-progress-flush", toolCallId, progressId })
      .then(() => refresh(true));
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
    if (focus) (rows[selected]?.querySelector(".find-result-open") as HTMLElement | null)?.focus();
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
      status.hidden = false;
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
    form.hidden = !next.enabled;
    settings.hidden = !next.supported || next.enabled;
    const footer = document.querySelector<HTMLElement>(".find-footer");
    if (footer)
      footer.hidden = !next.enabled || next.resultsQuery !== input.value || !next.results.length;
    if (!dirtyInput) {
      input.value = parseFindQuery(next.query).text;
      mode = next.mode ?? null;
    }
    const currentResults =
      next.resultsQuery === input.value && (next.resultsMode ?? null) === (mode ?? null);
    const agentic = next.enabled && currentResults && next.decision?.mode === "agentic";
    status.hidden = agentic && next.running;
    status.textContent = !next.supported
      ? "Find is unavailable on this gateway."
      : !next.enabled
        ? "Find is unavailable. Check the gateway connection and experimental mode."
        : next.running && currentResults
          ? agentic
            ? ""
            : next.activity
              ? `Omnesis · ${next.activity}`
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
                  ? "No browser links found. Try a different query."
                  : `${next.results.length} ${next.results.length === 1 ? "result" : "results"} · ↑ ↓ to choose · Enter to open`));
    element("find-mode").hidden = !agentic;
    element("find-mode-label").textContent = next.decision?.requested
      ? "Agentic mode enabled"
      : "Agentic mode auto enabled";
    const modeProgress = element("find-mode-progress");
    modeProgress.hidden = !agentic || !next.running;
    renderComponent(agentic && next.running ? h(ThinkingDots, {}) : null, modeProgress);
    conversation.render(currentResults && next.enabled ? next : undefined);
    const focusedResult = (document.activeElement?.closest(".find-result") as HTMLElement | null)
      ?.dataset.resultId;
    list.replaceChildren();
    if (!next.enabled || !currentResults) {
      return;
    }
    for (const [index, result] of next.results.entries()) {
      const row = document.createElement("li");
      row.id = `find-result-${index}`;
      row.className = "find-result";
      row.dataset.resultId = result.id;
      const open = document.createElement("a");
      open.href = result.url;
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
        // Keep the local fallback until the favicon loads. Register both
        // transitions before src so cached images and later successful loads
        // cannot leave an earlier error permanently hiding the favicon.
        img.hidden = true;
        img.addEventListener("load", () => {
          img.hidden = false;
          fallback.hidden = true;
        });
        img.addEventListener("error", () => {
          img.hidden = true;
          fallback.hidden = false;
        });
        img.src = url.href;
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
      open.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        select(index);
        void activate(result);
      });
      row.append(open);
      list.appendChild(row);
    }
    select(selected, false, false);
    if (focusedResult)
      (
        [...list.children]
          .find((row) => (row as HTMLElement).dataset.resultId === focusedResult)
          ?.querySelector(".find-result-open") as HTMLElement | null
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
  async function search(): Promise<void> {
    const request = ++generation,
      parsed = parseFindQuery(input.value),
      query = parsed.text;
    if (parsed.mode) mode = parsed.mode;
    input.value = query;
    searching = true;
    selected = 0;
    status.textContent = "Searching your Omnesis…";
    form.setAttribute("aria-busy", "true");
    try {
      const next = await api.runtime.sendMessage<FindPanelView & { ok?: boolean; reason?: string }>(
        { type: "find-query", query, ...(mode !== undefined ? { mode } : {}) },
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
      .sendMessage({
        type: "find-update",
        query: input.value,
        ...(mode !== undefined ? { mode } : {}),
      })
      .catch(() => undefined);
    if (view) render(view);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void search();
  });
  // Navigation remains available when focus is on the page or streamed agent output.
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = (event.target as Element | null)?.closest ? (event.target as Element) : null;
      if (
        target !== input &&
        target?.closest("input, textarea, select, [contenteditable], [role=textbox]")
      )
        return;
      if (
        !view?.enabled ||
        view.resultsQuery !== input.value ||
        (view.resultsMode ?? null) !== (mode ?? null) ||
        !list.children.length
      )
        return;
      event.preventDefault();
      select(selected + (event.key === "ArrowDown" ? 1 : -1), true);
    },
    true,
  );
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (
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
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && view?.results[selected]) {
      event.preventDefault();
      void activate(view.results[selected]!, true);
    }
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (FIND_STATE_KEY in changes) void refresh(true);
  });
  void refresh().then(() => {
    if (
      options.initialQuery?.trim() &&
      view?.enabled &&
      generation === 0 &&
      input.value === initial.text
    )
      void search();
    input.focus();
  });
}
