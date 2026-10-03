// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PAIRING_KEY } from "./pairing-record.js";
import { NOTES_STATE_KEY, notePage, type NotesView } from "./notes-service.js";
interface EntryChrome {
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<chrome.tabs.Tab[]>;
  };
  runtime: { sendMessage<T>(message: unknown): Promise<T> };
  storage: {
    onChanged: {
      addListener(callback: (changes: Record<string, unknown>, area: string) => void): void;
    };
  };
}
/** Discovery lives in the popup; one-time owner approval lives alongside pairing settings. */
export function initNotesEntry(document: Document, api: EntryChrome): void {
  const wrap = document.getElementById("notes-entry");
  const open = document.getElementById("tell-omnesis") as HTMLButtonElement | null;
  const enable = document.getElementById("enable-notes") as HTMLButtonElement | null;
  const hint = document.getElementById("notes-entry-hint");
  if (!wrap || !open || !enable || !hint) return;
  const options = document.querySelector('script[src="options.js"]') !== null;
  let currentTab: chrome.tabs.Tab | undefined;
  if (!options) {
    open.disabled = true;
    void api.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        currentTab = tabs[0];
        open.disabled =
          currentTab?.id === undefined ||
          currentTab.incognito === true ||
          !notePage({
            url: currentTab.url ?? "",
            title: (currentTab.title ?? "").slice(0, 512),
            selection: "",
          });
      })
      .catch(() => {
        open.disabled = true;
      });
  }
  let renderRequest = 0;
  async function refresh(cached = false): Promise<void> {
    const generation = ++renderRequest;
    try {
      const view = await api.runtime.sendMessage<NotesView>({
        type: cached ? "notes-view" : "notes-status",
      });
      if (generation !== renderRequest) return;
      wrap!.hidden = !view?.supported || (options && view.enabled);
      open!.hidden = !view?.enabled || options;
      enable!.hidden = view?.enabled ?? true;
      hint!.textContent = view?.enabled
        ? "Alt / Option + Shift + N · Include selected text automatically"
        : view?.pendingApproval
          ? "Approve access in the gateway portal. Capture keeps working."
          : "Allow this browser to create notes. Gateway-owner approval is required.";
      enable!.textContent = view?.pendingApproval ? "Open approval page" : "Enable Tell Omnesis";
    } catch {
      if (generation === renderRequest) wrap!.hidden = true;
    }
  }
  async function action(message: { type: string; tabId?: number; page?: unknown }): Promise<void> {
    try {
      const result = await api.runtime.sendMessage<{ ok?: boolean; reason?: string }>(message);
      if (!result?.ok) throw new Error(result?.reason ?? "Try again");
      await refresh();
    } catch (error) {
      hint!.textContent = error instanceof Error ? error.message : "Try again";
    }
  }
  open.addEventListener("click", () => {
    if (currentTab?.id === undefined || open.disabled) return;
    void action({
      type: "notes-open",
      tabId: currentTab.id,
      page: { url: currentTab.url, title: (currentTab.title ?? "").slice(0, 512), selection: "" },
    });
  });
  enable.addEventListener("click", () => {
    void action({ type: "notes-activate" });
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (PAIRING_KEY in changes) void refresh();
    else if (NOTES_STATE_KEY in changes) void refresh(true);
  });
  void refresh();
}
