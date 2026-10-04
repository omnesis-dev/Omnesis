// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NOTES_PAGE_KEY, type NotesEditView } from "./notes-edit-service.js";
import { NOTES_STATE_KEY, type NotesView } from "./notes-service.js";

interface EditPanelApi {
  runtime: { sendMessage<T>(message: unknown): Promise<T> };
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>> };
    onChanged: {
      addListener(callback: (changes: Record<string, unknown>, area: string) => void): void;
    };
  };
}
export function initNotesEditPanel(
  document: Document,
  api: EditPanelApi,
  onAccepted?: () => Promise<void> | void,
): () => Promise<void> {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const section = element("saved-notes"),
    list = element("saved-notes-list"),
    status = element("saved-notes-status"),
    editor = element<HTMLFormElement>("saved-note-editor"),
    text = element<HTMLTextAreaElement>("saved-note-text"),
    save = element<HTMLButtonElement>("saved-note-save"),
    newNote = element<HTMLButtonElement>("saved-note-new");
  let url = "",
    view: NotesEditView | undefined,
    generation = 0,
    dirty = false,
    saving = false;
  let writes: Promise<unknown> = Promise.resolve();
  let showEditor = false;
  let initial = true;
  function editing(active: boolean): void {
    element("notes-section").dataset.savedEdit = String(active);
    showEditor = active;
    editor.hidden = !active;
    const creationStatus = element("notes-status");
    creationStatus.hidden =
      active && creationStatus.textContent === "Write a note about this page.";
    const composer = element<HTMLFormElement>("notes-form");
    if (active) composer.hidden = true;
    else
      void api.runtime.sendMessage<NotesView>({ type: "notes-view" }).then((notes) => {
        composer.hidden = !notes?.enabled || !notes.draft;
      });
  }
  function render(next: NotesEditView): void {
    view = next;
    section.hidden = !next?.enabled;
    if (!next?.enabled) {
      editing(false);
      return;
    }
    status.textContent =
      next.error ??
      (next.notes.length ? "Saved notes on this page" : "No saved notes on this page yet.");
    list.replaceChildren();
    for (const note of next.notes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary saved-note-item";
      button.dataset.noteId = note.id;
      button.setAttribute("aria-current", String(next.draft?.id === note.id));
      button.textContent = note.text.replace(/\s+/g, " ").slice(0, 110) || "Note";
      button.disabled = saving || !note.editable;
      button.addEventListener("click", () => {
        void action({ type: "notes-edit-select", id: note.id, url }, true);
      });
      list.appendChild(button);
    }
    const context = element<HTMLAnchorElement>("saved-note-url");
    if (next.draft) {
      context.textContent = next.draft.url;
      context.href = next.draft.url;
    }
    save.disabled = saving || !text.value.trim();
  }
  async function action(message: unknown, open = false): Promise<boolean> {
    try {
      const next = await api.runtime.sendMessage<NotesEditView & { ok?: boolean; reason?: string }>(
        message,
      );
      if (next?.ok === false) throw new Error(next.reason);
      if (!next || typeof next.enabled !== "boolean" || !Array.isArray(next.notes)) return false;
      if (open && next.draft) {
        text.value = next.draft.text;
        dirty = false;
        editing(true);
        text.focus();
      }
      render(next);
      return true;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Your edit is kept. Try again.";
      return false;
    }
  }
  async function refresh(): Promise<void> {
    const request = ++generation;
    const stored = await api.storage.local.get(NOTES_PAGE_KEY);
    const page = stored[NOTES_PAGE_KEY] as { url?: unknown } | null;
    if (typeof page?.url === "string") url = page.url;
    if (!url) {
      const notes = await api.runtime.sendMessage<NotesView>({ type: "notes-view" });
      url = notes?.draft?.url ?? "";
    }
    if (!url) return;
    try {
      const next = await api.runtime.sendMessage<NotesEditView & { ok?: boolean }>({
        type: "notes-edit-list",
        url,
      });
      if (request !== generation || !next || typeof next.enabled !== "boolean") return;
      render(next);
      if (initial && next.draft) showEditor = true;
      initial = false;
      if (showEditor && next.draft && !dirty && !saving) {
        text.value = next.draft.text;
        editing(true);
        if (document.activeElement?.closest("[hidden]")) text.focus();
      }
    } catch {
      status.textContent = "Saved notes are unavailable. Your edit is kept.";
    }
  }
  text.addEventListener("input", () => {
    dirty = true;
    save.disabled = saving || !text.value.trim();
    const value = text.value;
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        const result = await api.runtime.sendMessage<{ ok?: boolean; reason?: string }>({
          type: "notes-edit-update",
          text: value,
        });
        if (result?.ok === false) throw new Error(result.reason);
        if (text.value === value) dirty = false;
      })
      .catch(() => {
        status.textContent =
          "Your edit could not be saved in this browser. Keep this panel open and try again.";
        throw new Error("Edit draft not saved");
      });
    void writes.catch(() => undefined);
  });
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    if (saving || save.disabled || !view?.draft) return;
    saving = true;
    save.disabled = true;
    text.disabled = true;
    void (async () => {
      try {
        await writes;
        const next = await api.runtime.sendMessage<
          NotesEditView & { ok?: boolean; reason?: string }
        >({ type: "notes-edit-save" });
        if (next?.ok === false) throw new Error(next.reason);
        render(next);
        if (!next.error && next.draft) {
          text.value = next.draft.text;
          status.textContent = "Changes saved to Omnesis.";
          await onAccepted?.();
        }
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : "Your edit was not sent. Try again.";
      } finally {
        saving = false;
        text.disabled = false;
        save.disabled = !text.value.trim();
      }
    })();
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      editor.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  newNote.addEventListener("click", () => {
    if (saving) return;
    editing(false);
    void api.runtime.sendMessage<NotesView>({ type: "notes-view" }).then((notes) => {
      if (notes?.enabled && notes.draft) {
        element<HTMLTextAreaElement>("note-text").focus();
      }
    });
  });
  element("saved-note-discard").addEventListener("click", () => {
    if (saving) return;
    void writes
      .catch(() => undefined)
      .then(() => action({ type: "notes-edit-discard" }))
      .then((accepted) => {
        if (accepted) editing(false);
      });
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (NOTES_PAGE_KEY in changes || NOTES_STATE_KEY in changes))
      void refresh();
  });
  void refresh();
  return async () => {
    // Include keystrokes arriving while a slower storage write is still pending.
    let pending: Promise<unknown>;
    do {
      pending = writes;
      await pending;
    } while (pending !== writes);
  };
}
