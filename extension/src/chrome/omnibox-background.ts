// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { browserUrl, dedupeFindResults, type FindResult } from "./find-results.js";
import { parseFindQuery, type FindMode } from "./find-query.js";
import { OMNIBOX_SUGGESTIONS, type FindView } from "./find-service.js";

interface OmniboxFind {
  ensureRead(): Promise<FindView>;
  suggest(query: string, signal?: AbortSignal): Promise<FindResult[]>;
}
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );

/** Keyword suggestions are ephemeral index reads; only Enter runs the full Find workflow. */
export function installOmniboxBackground(find: OmniboxFind): { clear(): void } {
  if (typeof chrome.omnibox === "undefined") return { clear: () => undefined };
  let generation = 0;
  let sessionGeneration = 0;
  let session = false;
  let activeTab: chrome.tabs.Tab | undefined;
  let tabLookup: Promise<chrome.tabs.Tab | undefined> | undefined;
  let view: FindView | undefined;
  let inputMode: FindMode | undefined;
  let ready: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const defaultSuggestion = (enabled: boolean, mode?: FindMode): void => {
    void chrome.omnibox
      .setDefaultSuggestion({
        description: enabled
          ? mode === "direct"
            ? "Search directly in Omnesis"
            : mode === "agentic"
              ? "Agentic search in Omnesis"
              : "Find in Omnesis"
          : "<dim>Find is unavailable on this paired gateway</dim>",
      })
      .catch(() => undefined);
  };
  function cancelPending(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }
  function clear(): void {
    generation++;
    sessionGeneration++;
    session = false;
    activeTab = undefined;
    tabLookup = undefined;
    view = undefined;
    inputMode = undefined;
    cancelPending();
    defaultSuggestion(false);
  }
  chrome.omnibox.onInputStarted.addListener(() => {
    clear();
    session = true;
    const request = sessionGeneration;
    tabLookup = chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => tabs.find((tab) => tab.id !== undefined && !tab.incognito));
    ready = Promise.all([tabLookup, find.ensureRead()])
      .then(([tab, current]) => {
        if (!session || request !== sessionGeneration) return;
        activeTab = tab;
        view = current;
        defaultSuggestion(current.enabled, inputMode);
      })
      .catch(() => {
        if (request === sessionGeneration) defaultSuggestion(false);
      });
  });
  chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    cancelPending();
    const request = ++generation;
    // InputStarted's gate belongs to this session even after its text changes.
    const query = text.trim();
    const parsed = parseFindQuery(query);
    inputMode = parsed.mode;
    if (view) defaultSuggestion(view.enabled, inputMode);
    if (!session || !parsed.text || query.length > 1024) {
      suggest([]);
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    timer = setTimeout(() => {
      timer = undefined;
      void ready
        .then(async () => {
          if (!session || request !== generation || signal.aborted || !view?.enabled) return;
          const cards = dedupeFindResults(
            await find.suggest(query, signal),
            view.canonicalizers,
          ).slice(0, OMNIBOX_SUGGESTIONS);
          if (!session || request !== generation || signal.aborted) return;
          suggest(
            cards.flatMap((card) => {
              const url = browserUrl(card.url);
              if (!url) return [];
              return [
                {
                  content: url,
                  description: `<match>${escape(card.title.slice(0, 180))}</match> <dim>${escape(new URL(url).hostname)}</dim>`,
                },
              ];
            }),
          );
        })
        .catch(() => {
          if (session && request === generation) suggest([]);
        });
    }, 150);
  });
  chrome.omnibox.onInputCancelled.addListener(clear);
  async function navigate(
    url: string,
    disposition: chrome.omnibox.OnInputEnteredDisposition,
    tabId: number | undefined,
    request: number,
  ): Promise<void> {
    if (request !== generation) return;
    if (disposition !== "currentTab") {
      await chrome.tabs.create({ url, active: disposition === "newForegroundTab" });
      return;
    }
    if (tabId === undefined) return;
    try {
      await chrome.tabs.update(tabId, { url });
    } catch {
      // A temporary edit failure is not a reason to navigate a different tab.
      // Only replace a tab that Chrome confirms has actually disappeared.
      const exists = await chrome.tabs.get(tabId).then(
        () => true,
        () => false,
      );
      if (!exists && request === generation) await chrome.tabs.create({ url });
    }
  }
  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    const selectedUrl = browserUrl(text);
    // Capture the session's pending lookup before Enter ends the input session.
    // Awaiting gateway authorization must not lose the originating tab identity.
    const origin = activeTab
      ? Promise.resolve(activeTab)
      : (tabLookup ??
        chrome.tabs
          .query({ active: true, lastFocusedWindow: true })
          .then((tabs) => tabs.find((tab) => tab.id !== undefined && !tab.incognito)));
    const originId = origin.then(
      (tab) => tab?.id,
      () => undefined,
    );

    cancelPending();
    session = false;
    generation++;
    const selectionGeneration = generation;
    if (selectedUrl) {
      if (view?.enabled === false) return;
      void find
        .ensureRead()
        .then(async (current) => {
          if (!current.enabled || selectionGeneration !== generation) return;
          await navigate(selectedUrl, disposition, await originId, selectionGeneration);
        })
        .catch(() => undefined);
      return;
    }
    const query = text.trim();
    if (
      view?.enabled === false ||
      text.startsWith("omnesis-result:") ||
      !query ||
      query.length > 1024
    )
      return;
    // Full-page Find does not depend on a native side-panel gesture. Verify
    // the gateway before opening Find; the page runs the normal search.
    void find
      .ensureRead()
      .then(async (current) => {
        if (!current.enabled || selectionGeneration !== generation) return;
        const url = new URL(chrome.runtime.getURL("find.html"));
        const parsed = parseFindQuery(query);
        url.searchParams.set("q", parsed.text);
        if (parsed.mode) url.searchParams.set("mode", parsed.mode);
        await navigate(
          url.href,
          disposition === "newBackgroundTab" ? "newBackgroundTab" : "newForegroundTab",
          await originId,
          selectionGeneration,
        );
      })
      .catch(() => defaultSuggestion(false));
  });
  defaultSuggestion(false);
  return { clear };
}
