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
/** Experimental actions appear automatically for a compatible paired gateway. */
export function initNotesEntry(document: Document, api: EntryChrome): void {
  const wrap = document.getElementById("notes-entry");
  const open = document.getElementById("tell-omnesis") as HTMLButtonElement | null;
  const hint = document.getElementById("notes-entry-hint");
  if (!wrap || !open || !hint) return;
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
      wrap!.hidden = !view?.supported || view.enabled;
      open!.hidden = !view?.enabled || options;
      hint!.textContent = "";
    } catch {
      if (generation === renderRequest) {
        wrap!.hidden = true;
        open!.hidden = true;
      }
    }
  }
  async function action(message: { type: string; tabId?: number; page?: unknown }): Promise<void> {
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
    if (currentTab?.id === undefined || open.disabled) return;
    void action({
      type: "notes-open",
      tabId: currentTab.id,
      page: { url: currentTab.url, title: (currentTab.title ?? "").slice(0, 512), selection: "" },
    });
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (PAIRING_KEY in changes) void refresh();
    else if (NOTES_STATE_KEY in changes) void refresh(true);
  });
  void refresh();
}

/** Ask only when unpairing would remove a written draft or an undelivered note. */
export async function confirmNotesUnpair(
  api: Pick<EntryChrome, "runtime">,
  confirm: (message: string) => boolean,
): Promise<boolean> {
  let view: (Partial<NotesView> & { ok?: unknown; pendingEdit?: unknown }) | null | undefined;
  try {
    view = await api.runtime.sendMessage<
      (Partial<NotesView> & { ok?: unknown; pendingEdit?: unknown }) | null | undefined
    >({
      type: "notes-view",
    });
  } catch {
    throw new Error("Could not check unsent notes. Try unpairing again.");
  }
  if (view?.ok === false) throw new Error("Could not check unsent notes. Try unpairing again.");
  const writtenDraft = typeof view?.draft?.text === "string" && view.draft.text.trim().length > 0;
  const pendingNotes =
    typeof view?.pending === "number" && Number.isInteger(view.pending) && view.pending > 0;
  return (
    (!writtenDraft && !pendingNotes && view?.pendingEdit !== true) ||
    confirm(
      "Unpairing deletes this browser’s drafts, unsaved edits and unsent notes. Saved notes remain in Omnesis. Unpair?",
    )
  );
}
