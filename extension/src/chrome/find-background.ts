// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { loadConfig } from "./storage.js";
import {
  FIND_STATE_KEY,
  MAX_FIND_QUERY,
  FindService,
  type FindView,
  type FindResult,
} from "./find-service.js";
import { FIND_TOKEN_KEY } from "./find-credential.js";
import { findOpenTab } from "./find-tabs.js";
import { browserUrl } from "./find-results.js";

export function installFindBackground(): {
  clear(): Promise<void>;
  ensureRead(): Promise<FindView>;
  suggest(query: string, signal?: AbortSignal): Promise<FindResult[]>;
  message(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value?: unknown) => void,
  ): boolean;
  alarm(name: string): void;
} {
  const service = new FindService({
    config: loadConfig,
    read: async () => {
      const stored = await chrome.storage.local.get([FIND_STATE_KEY, FIND_TOKEN_KEY]);
      const state = stored[FIND_STATE_KEY] as { pairing?: unknown } | null;
      const credential = stored[FIND_TOKEN_KEY] as { pairing?: unknown; token?: unknown } | null;
      return state
        ? {
            ...state,
            ...(credential?.pairing === state.pairing && typeof credential?.token === "string"
              ? { token: credential.token }
              : {}),
          }
        : null;
    },
    write: async (value) => {
      const state = value as { token?: string; pairing?: string } | null;
      const { token, ...publicState } = state ?? {};
      const next = {
        [FIND_STATE_KEY]: state === null ? null : publicState,
        [FIND_TOKEN_KEY]: token ? { pairing: state?.pairing, token } : null,
      };
      const stored = await chrome.storage.local.get([FIND_STATE_KEY, FIND_TOKEN_KEY]);
      if (
        Object.entries(next).some(
          ([key, value]) => JSON.stringify(stored[key]) !== JSON.stringify(value),
        )
      )
        await chrome.storage.local.set(next);
    },
    fetch: (input, init) => fetch(input, init),
  });
  const detached = (task: Promise<unknown>): void => {
    void task.catch(() => undefined);
  };
  function refresh(fresh = true): Promise<FindView> {
    return service.status(fresh);
  }
  async function viewWithTabs(
    fresh = false,
  ): Promise<
    FindView & { openResults: string[]; tabsPermission: boolean; faviconPermission: boolean }
  > {
    const view = await refresh(fresh);
    const tabs = view.enabled ? await chrome.tabs.query({}) : [];
    return {
      ...view,
      openResults: view.results
        .filter((result) => findOpenTab(result, tabs, view.canonicalizers))
        .map((result) => result.id),
      tabsPermission: await chrome.permissions.contains({ permissions: ["tabs"] }),
      faviconPermission: await chrome.permissions.contains({ permissions: ["favicon"] }),
    };
  }
  const message = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value?: unknown) => void,
  ): boolean => {
    const senderPage = sender.url?.split(/[?#]/, 1)[0];
    const findPage = senderPage === chrome.runtime.getURL("find.html");
    if (sender.id !== chrome.runtime.id || !findPage || !message || typeof message !== "object")
      return false;
    const msg = message as {
      type?: string;
      query?: unknown;
      mode?: unknown;
      tabId?: unknown;
      resultId?: unknown;
      toolCallId?: unknown;
      progressId?: unknown;
      newCopy?: unknown;
    };
    let task: Promise<unknown>;
    if (msg.type === "find-status") task = viewWithTabs(true);
    else if (msg.type === "find-view") task = viewWithTabs();
    else if (
      findPage &&
      (msg.type === "find-update" || msg.type === "find-query") &&
      typeof msg.query === "string" &&
      msg.query.length <= MAX_FIND_QUERY &&
      (msg.mode === undefined ||
        msg.mode === null ||
        msg.mode === "direct" ||
        msg.mode === "agentic")
    )
      task = (
        msg.type === "find-query"
          ? service.search(msg.query, msg.mode)
          : service.update(msg.query, msg.mode)
      ).then(() => viewWithTabs());
    else if (
      findPage &&
      msg.type === "find-progress-flush" &&
      typeof msg.toolCallId === "string" &&
      msg.toolCallId.length <= 128 &&
      typeof msg.progressId === "string" &&
      msg.progressId.length <= 128
    )
      task = service.flushProgress(msg.toolCallId, msg.progressId).then(() => viewWithTabs());
    else if (findPage && msg.type === "find-cancel")
      task = service.cancel().then(() => viewWithTabs());
    else if (findPage && msg.type === "find-result" && typeof msg.resultId === "string")
      task = service.status().then(async (view) => {
        if (!view.enabled) throw new Error("Find access is no longer available");
        const result = view.results.find((result) => result.id === msg.resultId);
        if (!result) throw new Error("This result is no longer available. Search again.");
        const url = browserUrl(result.url);
        if (!url) throw new Error("This result cannot open in a browser");
        if (msg.newCopy === true) await chrome.tabs.create({ url });
        else {
          const tabId = sender.tab?.id;
          if (tabId === undefined || tabId < 0)
            throw new Error("Open Find in a browser tab to use this result");
          await chrome.tabs.update(tabId, { url });
        }
        return { ok: true };
      });
    else return false;
    void task.then(respond, (error: unknown) =>
      respond({
        ok: false,
        reason: error instanceof Error ? error.message : "Find could not open",
      }),
    );
    return true;
  };
  chrome.alarms.create("omnesis-find-refresh", { periodInMinutes: 1 });
  detached(
    (async () => {
      const stored = await chrome.storage.local.get([FIND_STATE_KEY, FIND_TOKEN_KEY]);
      const previous = stored[FIND_STATE_KEY] as { supported?: unknown } | null;
      const view = await service.status(false);
      await refresh(
        !!stored[FIND_TOKEN_KEY] || previous?.supported === true || view.pendingApproval,
      );
    })(),
  );
  return {
    message,
    ensureRead: () => refresh(),
    suggest: async (query, signal) => {
      const results = await service.suggest(query, signal);
      await refresh(false);
      return results;
    },
    alarm: (name) => {
      if (name === "omnesis-find-refresh") detached(refresh());
    },
    clear: async () => {
      await service.clear();
    },
  };
}
