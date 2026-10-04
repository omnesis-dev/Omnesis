// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { normalizeCaptureUrl, preferCanonicalUrl } from "../capture/normalize.js";
import { registerPanelFeature, selectPanelView, setPanelFeature } from "./panel-surface.js";
import { loadConfig } from "./storage.js";
import {
  NOTES_STATE_KEY,
  MAX_NOTE_CHARS,
  NotesService,
  notePage,
  type NotePage,
} from "./notes-service.js";

import { NOTES_TOKEN_KEY } from "./notes-credential.js";

/** Only extension-owned surfaces may invoke this worker's create-only notes credential. */
export function installNotesBackground(): {
  clear(): Promise<void>;
  message(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value?: unknown) => void,
  ): boolean;
  alarm(name: string): void;
} {
  registerPanelFeature("notes");
  const service = new NotesService({
    config: loadConfig,
    read: async () => {
      const stored = await chrome.storage.local.get([NOTES_STATE_KEY, NOTES_TOKEN_KEY]);
      const state = stored[NOTES_STATE_KEY] as { pairing?: unknown } | null;
      const credential = stored[NOTES_TOKEN_KEY] as { pairing?: unknown; token?: unknown } | null;
      return state
        ? {
            ...state,
            ...(credential &&
            credential.pairing === state.pairing &&
            typeof credential.token === "string"
              ? { token: credential.token }
              : {}),
          }
        : null;
    },
    write: async (state) => {
      const full = state as { pairing?: string; token?: string } | null;
      const { token, ...publicState } = full ?? {};
      const credential = token ? { pairing: full?.pairing, token } : null;
      const stored = await chrome.storage.local.get([NOTES_STATE_KEY, NOTES_TOKEN_KEY]);
      const nextState = state === null ? null : publicState;
      if (
        JSON.stringify(stored[NOTES_STATE_KEY]) !== JSON.stringify(nextState) ||
        JSON.stringify(stored[NOTES_TOKEN_KEY]) !== JSON.stringify(credential)
      ) {
        await chrome.storage.local.set({
          [NOTES_STATE_KEY]: nextState,
          [NOTES_TOKEN_KEY]: credential,
        });
      }
    },
    fetch: (input, init) => fetch(input, init),
  });
  const detached = (task: Promise<unknown>): void => {
    void task.catch(() => undefined);
  };
  let menusEnabled: boolean | undefined;
  let clearing = false;
  let surfaceWork: Promise<unknown> = Promise.resolve();
  function serializeSurface<T>(task: () => Promise<T>): Promise<T> {
    const result = surfaceWork.then(task, task);
    surfaceWork = result.catch(() => undefined);
    return result;
  }
  function refresh(fresh = true): Promise<void> {
    return serializeSurface(async () => {
      const state = fresh ? await service.drain() : await service.status(false);
      if (clearing || state.enabled === menusEnabled) return;
      await setPanelFeature("notes", state.enabled);
      if (clearing) return;
      await chrome.contextMenus.removeAll();
      if (clearing) return;
      if (!state.enabled) {
        menusEnabled = false;
        return;
      }
      chrome.contextMenus.create({
        id: "omnesis-note-page",
        title: "Tell Omnesis about this page",
        contexts: ["page"],
        documentUrlPatterns: ["https://*/*", "http://*/*"],
      });
      chrome.contextMenus.create({
        id: "omnesis-note-selection",
        title: "Tell Omnesis about this selection",
        contexts: ["selection"],
        documentUrlPatterns: ["https://*/*", "http://*/*"],
      });
      menusEnabled = true;
    });
  }
  async function open(tab: chrome.tabs.Tab, selection?: string, pageUrl?: string): Promise<void> {
    if (tab.id === undefined || tab.incognito) return;
    if (menusEnabled === false) return;
    const page: NotePage = {
      url: pageUrl ?? tab.url ?? "",
      title: (tab.title ?? "").slice(0, 512),
      selection: (selection ?? "").slice(0, MAX_NOTE_CHARS),
    };
    if (!notePage(page)) return;
    // Open before network work: Chrome's side panel API requires the invocation's user gesture.
    const opening = chrome.sidePanel.open({ tabId: tab.id });
    await opening;
    if (!pageUrl || pageUrl === tab.url) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            url: location.href,
            canonical:
              document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
            selection: window.getSelection()?.toString() ?? "",
          }),
        });
        const context = results[0]?.result;
        if (context?.url === page.url) {
          page.url = normalizeCaptureUrl(preferCanonicalUrl(page.url, context.canonical));
          if (selection === undefined) page.selection = context.selection.slice(0, MAX_NOTE_CHARS);
        }
      } catch {
        /* Restricted pages still support a page note when their URL is available. */
      }
    }
    page.url = normalizeCaptureUrl(page.url);
    const view = await service.begin(page);
    if (view.enabled) await selectPanelView("notes");
  }
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === "tell-omnesis" && tab) detached(open(tab));
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (tab && ["omnesis-note-page", "omnesis-note-selection"].includes(String(info.menuItemId)))
      detached(open(tab, info.selectionText ?? "", info.pageUrl));
  });
  const message = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value?: unknown) => void,
  ): boolean => {
    if (
      sender.id !== chrome.runtime.id ||
      !["popup.html", "options.html", "notes.html"].some(
        (path) => sender.url === chrome.runtime.getURL(path),
      )
    )
      return false;
    if (!message || typeof message !== "object") return false;
    const msg = message as {
      type?: string;
      id?: unknown;
      text?: unknown;
      selection?: unknown;
      tabId?: unknown;
      page?: unknown;
    };
    let task: Promise<unknown>;
    if (msg.type === "notes-status")
      task = service.status().then(async (state) => {
        await refresh(false);
        return state;
      });
    else if (msg.type === "notes-view") task = service.status(false);
    else if (msg.type === "notes-activate")
      task = service.activate().then(async (url) => {
        await chrome.tabs.create({ url });
        return { ok: true };
      });
    else if (
      msg.type === "notes-open" &&
      sender.url === chrome.runtime.getURL("popup.html") &&
      typeof msg.tabId === "number" &&
      Number.isInteger(msg.tabId) &&
      msg.tabId > 0 &&
      notePage(msg.page)
    ) {
      const page = notePage(msg.page)!;
      task = open({ id: msg.tabId, url: page.url, title: page.title }).then(() => ({ ok: true }));
    } else if (sender.url === chrome.runtime.getURL("notes.html") && typeof msg.id === "string") {
      if (
        msg.type === "notes-update" &&
        typeof msg.text === "string" &&
        msg.text.length <= MAX_NOTE_CHARS &&
        (msg.selection === undefined ||
          (typeof msg.selection === "string" && msg.selection.length <= MAX_NOTE_CHARS))
      ) {
        task = service.update(msg.id, msg.text, msg.selection as string | undefined);
      } else if (msg.type === "notes-discard") task = service.discard(msg.id);
      else if (msg.type === "notes-restore") task = service.restore(msg.id);
      else if (msg.type === "notes-submit")
        task = service.submit(msg.id).then((state) => {
          detached(refresh());
          return state;
        });
      else return false;
    } else return false;
    void task.then(respond, (error: unknown) =>
      respond({
        ok: false,
        reason: error instanceof Error ? error.message : "Tell Omnesis could not open",
      }),
    );
    return true;
  };
  chrome.alarms.create("omnesis-notes-refresh", { periodInMinutes: 1 });

  async function restoreSurfaces(): Promise<void> {
    const stored = await chrome.storage.local.get([NOTES_STATE_KEY, NOTES_TOKEN_KEY]);
    const previous = stored[NOTES_STATE_KEY] as { supported?: unknown } | null;
    const cached = await service.status(false);
    await refresh(
      !!stored[NOTES_TOKEN_KEY] ||
        previous?.supported === true ||
        cached.pendingApproval ||
        cached.pending > 0,
    );
  }
  chrome.runtime.onInstalled.addListener(() => {
    menusEnabled = false;
    detached(
      serializeSurface(async () => {
        await chrome.sidePanel.setOptions({ enabled: false, path: "notes.html" });
        await chrome.contextMenus.removeAll();
      }).then(restoreSurfaces),
    );
  });
  // Chrome persists whether this panel is enabled. A cold gesture uses that
  // platform gate immediately while this worker revalidates the stored grant.
  detached(restoreSurfaces());
  return {
    message,
    alarm: (name) => {
      if (name === "omnesis-notes-refresh") detached(refresh());
    },
    clear: () => {
      menusEnabled = false;
      clearing = true;
      return serializeSurface(async () => {
        await service.clear();
        await setPanelFeature("notes", false);
        await chrome.contextMenus.removeAll();
        menusEnabled = false;
        clearing = false;
      });
    },
  };
}
