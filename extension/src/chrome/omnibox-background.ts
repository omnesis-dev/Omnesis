// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { browserUrl, dedupeFindResults, type FindResult } from "./find-results.js";
import { activateFindResult } from "./find-tabs.js";
import type { FindView } from "./find-service.js";

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
  let view: FindView | undefined;
  let ready: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const defaultSuggestion = (enabled: boolean): void => {
    void chrome.omnibox
      .setDefaultSuggestion({
        description: enabled
          ? "Find in Omnesis"
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
    view = undefined;
    cancelPending();
    defaultSuggestion(false);
  }
  chrome.omnibox.onInputStarted.addListener(() => {
    clear();
    session = true;
    const request = sessionGeneration;
    ready = Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (session && request === sessionGeneration)
          activeTab = tabs.find((tab) => tab.id !== undefined && !tab.incognito);
        return tabs;
      }),
      find.ensureRead(),
    ])
      .then(([tabs, current]) => {
        if (!session || request !== sessionGeneration) return;
        activeTab = tabs.find((tab) => tab.id !== undefined && !tab.incognito);
        view = current;
        defaultSuggestion(current.enabled);
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
    if (!session || !query || query.length > 1024) {
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
          ).slice(0, 5);
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
  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    const selectedUrl = browserUrl(text);
    const tabId = activeTab?.id;
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
          if (disposition === "newBackgroundTab")
            await chrome.tabs.create({ url: selectedUrl, active: false });
          else
            await activateFindResult(
              { url: selectedUrl },
              current.canonicalizers,
              disposition === "newForegroundTab",
            );
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
    // the gateway before replacing a tab; the page runs the normal search.
    void find
      .ensureRead()
      .then(async (current) => {
        if (!current.enabled || selectionGeneration !== generation) return;
        const url = new URL(chrome.runtime.getURL("find.html"));
        url.searchParams.set("q", query);
        if (disposition !== "currentTab") {
          await chrome.tabs.create({ url: url.href, active: disposition === "newForegroundTab" });
        } else {
          try {
            if (tabId === undefined) await chrome.tabs.create({ url: url.href });
            else await chrome.tabs.update(tabId, { url: url.href });
          } catch {
            if (selectionGeneration === generation) await chrome.tabs.create({ url: url.href });
          }
        }
      })
      .catch(() => defaultSuggestion(false));
  });
  defaultSuggestion(false);
  return { clear };
}
