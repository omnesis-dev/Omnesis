// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { loadConfig } from "./storage.js";
import { FIND_STATE_KEY, MAX_FIND_QUERY, FindService, type FindView } from "./find-service.js";
import { FIND_TOKEN_KEY } from "./find-credential.js";
import { activateFindResult, findOpenTab } from "./find-tabs.js";
import { registerPanelFeature, selectPanelView, setPanelFeature } from "./panel-surface.js";

export function installFindBackground(): {
  clear(): Promise<void>;
  message(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value?: unknown) => void,
  ): boolean;
  alarm(name: string): void;
} {
  registerPanelFeature("find");
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
  let enabled: boolean | undefined;
  let clearing = false;
  const detached = (task: Promise<unknown>): void => {
    void task.catch(() => undefined);
  };
  async function refresh(fresh = true): Promise<FindView> {
    const view = await service.status(fresh);
    enabled = !clearing && view.enabled;
    await setPanelFeature("find", enabled);
    return view;
  }
  async function open(tabId: number): Promise<{ ok: true }> {
    if (enabled === false || clearing) throw new Error("Enable Find in the extension settings");
    // The platform's persisted enabled gate supports a cold worker without losing the gesture.
    const opening = chrome.sidePanel.open({ tabId });
    await opening;
    const view = await refresh();
    if (view.enabled) await selectPanelView("find");
    return { ok: true };
  }
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === "find-omnesis" && tab?.id !== undefined && !tab.incognito)
      detached(open(tab.id));
  });
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
    if (
      sender.id !== chrome.runtime.id ||
      !["popup.html", "options.html", "notes.html"].some(
        (path) => sender.url === chrome.runtime.getURL(path),
      ) ||
      !message ||
      typeof message !== "object"
    )
      return false;
    const msg = message as {
      type?: string;
      query?: unknown;
      more?: unknown;
      tabId?: unknown;
      resultId?: unknown;
      newCopy?: unknown;
    };
    let task: Promise<unknown>;
    if (msg.type === "find-status") task = viewWithTabs(true);
    else if (msg.type === "find-view") task = viewWithTabs();
    else if (msg.type === "find-activate")
      task = service.activate().then(async (url) => {
        await chrome.tabs.create({ url });
        return { ok: true };
      });
    else if (
      msg.type === "find-open" &&
      sender.url === chrome.runtime.getURL("popup.html") &&
      typeof msg.tabId === "number" &&
      Number.isInteger(msg.tabId) &&
      msg.tabId > 0
    )
      task = open(msg.tabId);
    else if (
      sender.url === chrome.runtime.getURL("notes.html") &&
      (msg.type === "find-update" || msg.type === "find-query") &&
      typeof msg.query === "string" &&
      msg.query.length <= MAX_FIND_QUERY
    )
      task = (
        msg.type === "find-query"
          ? service.search(msg.query, msg.more === true)
          : service.update(msg.query)
      ).then(() => viewWithTabs());
    else if (sender.url === chrome.runtime.getURL("notes.html") && msg.type === "find-cancel")
      task = service.cancel().then(() => viewWithTabs());
    else if (
      sender.url === chrome.runtime.getURL("notes.html") &&
      msg.type === "find-result" &&
      typeof msg.resultId === "string"
    )
      task = service.status().then(async (view) => {
        if (!view.enabled) throw new Error("Find access is no longer available");
        const result = view.results.find((result) => result.id === msg.resultId);
        if (!result) throw new Error("This result is no longer available. Search again.");
        await activateFindResult(result, view.canonicalizers, msg.newCopy === true);
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
  detached(service.status(false).then((view) => refresh(view.supported || view.pendingApproval)));
  return {
    message,
    alarm: (name) => {
      if (name === "omnesis-find-refresh") detached(refresh());
    },
    clear: async () => {
      enabled = false;
      clearing = true;
      await service.clear();
      await setPanelFeature("find", false);
      clearing = false;
    },
  };
}
