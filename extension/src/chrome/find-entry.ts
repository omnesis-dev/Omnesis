// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { FIND_STATE_KEY, type FindView } from "./find-service.js";
import { PAIRING_KEY } from "./pairing-record.js";

export function initFindEntry(
  document: Document,
  api: {
    tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<chrome.tabs.Tab[]> };
    runtime: { sendMessage<T>(message: unknown): Promise<T> };
    storage: {
      onChanged: {
        addListener(callback: (changes: Record<string, unknown>, area: string) => void): void;
      };
    };
  },
): void {
  const wrap = document.getElementById("find-entry");
  const open = document.getElementById("find-omnesis") as HTMLButtonElement | null;
  const hint = document.getElementById("find-entry-hint");
  if (!wrap || !open || !hint) return;
  const options = document.querySelector('script[src="options.js"]') !== null;
  let tab: chrome.tabs.Tab | undefined;
  let generation = 0;
  open.disabled = true;
  if (!options)
    void api.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        tab = tabs[0];
        open.disabled = tab?.id === undefined || tab.incognito === true;
      })
      .catch(() => undefined);
  async function refresh(cached = false): Promise<void> {
    const request = ++generation;
    try {
      const view = await api.runtime.sendMessage<FindView>({
        type: cached ? "find-view" : "find-status",
      });
      if (request !== generation) return;
      wrap!.hidden = !view?.supported || view.enabled;
      open!.hidden = !view?.enabled || options;
      hint!.textContent = "";
    } catch {
      if (request === generation) {
        wrap!.hidden = true;
        open!.hidden = true;
      }
    }
  }
  async function action(message: unknown): Promise<void> {
    try {
      const result = await api.runtime.sendMessage<{ ok?: boolean; reason?: string }>(message);
      if (!result?.ok) throw new Error(result?.reason ?? "Try again");
      if (!options) document.defaultView?.close();
      else await refresh();
    } catch (error) {
      wrap!.hidden = false;
      hint!.textContent = error instanceof Error ? error.message : "Try again";
    }
  }
  open.addEventListener("click", () => {
    if (tab?.id !== undefined && !open.disabled) void action({ type: "find-open", tabId: tab.id });
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (PAIRING_KEY in changes) void refresh();
    else if (FIND_STATE_KEY in changes) void refresh(true);
  });
  void refresh();
}
