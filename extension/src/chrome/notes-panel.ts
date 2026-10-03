// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  NOTES_STATE_KEY,
  renderedNoteLength,
  MAX_NOTE_CHARS,
  type NotesView,
  type NoteDraft,
} from "./notes-service.js";

interface PanelChrome {
  runtime: { sendMessage<T>(message: unknown): Promise<T> };
  storage: {
    onChanged: {
      addListener(callback: (changes: Record<string, unknown>, area: string) => void): void;
    };
  };
}
export function initNotesPanel(document: Document, api: PanelChrome): void {
  const element = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing #${id}`);
    return value as T;
  };
  const form = element<HTMLFormElement>("notes-form");
  const textarea = element<HTMLTextAreaElement>("note-text");
  const send = element<HTMLButtonElement>("note-send");
  const status = element("notes-status");
  let draft: NoteDraft | null = null;
  let updates: Promise<unknown> = Promise.resolve();
  let submitting = false;
  let request = 0;
  let dirty = false;
  function render(view: NotesView): void {
    if (!view || typeof view.supported !== "boolean") return;
    form.hidden = !view.enabled || !view.draft;
    status.textContent = !view.supported
      ? "Tell Omnesis is unavailable on this gateway. Your draft is kept."
      : !view.enabled
        ? "Enable Tell Omnesis in the extension settings. Your draft is kept."
        : (view.error ??
          (view.pending
            ? `${view.pending} ${view.pending === 1 ? "note is" : "notes are"} waiting to sync. Kept safely in this browser.`
            : view.lastSavedId
              ? "Saved to Omnesis."
              : "Write a note about this page."));
    const rejected = element("notes-rejected");
    rejected.replaceChildren();
    for (const note of view.rejected ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = `Edit unsent note: ${note.title || "Page"}`;
      button.disabled = !!view.draft;
      button.addEventListener("click", () => {
        void api.runtime
          .sendMessage<NotesView & { ok?: boolean; reason?: string }>({
            type: "notes-restore",
            id: note.id,
          })
          .then((view) => {
            if (view?.ok === false) throw new Error(view.reason);
            render(view);
          })
          .catch((error: unknown) => {
            status.textContent =
              error instanceof Error ? error.message : "Your unsent note could not be reopened.";
          });
      });
      rejected.appendChild(button);
    }
    if (!view.draft) {
      if (!dirty && !submitting) draft = null;
      return;
    }
    if (draft?.id !== view.draft.id) {
      draft = view.draft;
      dirty = false;
      textarea.value = draft.text;
      element("note-title").textContent = draft.title || "Page";
      const url = element<HTMLAnchorElement>("note-url");
      url.textContent = draft.url;
      url.href = draft.url;
      textarea.focus();
    } else if (!dirty && !submitting) {
      draft = view.draft;
      textarea.value = draft.text;
    }
    element("note-quotation").hidden = !draft.selection;
    element("note-selection").textContent = draft.selection;
    updateBudget();
  }
  async function refresh(cached = false): Promise<void> {
    const generation = ++request;
    try {
      const view = await api.runtime.sendMessage<NotesView>({
        type: cached ? "notes-view" : "notes-status",
      });
      if (generation === request) render(view);
    } catch {
      status.textContent = "The extension is unavailable. Reopen this panel to continue.";
    }
  }
  function updateBudget(): void {
    if (!draft) return;
    const remaining = MAX_NOTE_CHARS - renderedNoteLength({ ...draft, text: textarea.value });
    element("note-budget").textContent =
      remaining < 0
        ? `${-remaining} characters over the limit. Shorten your note or remove the quotation.`
        : `${remaining} characters left, including page and quotation`;
    send.disabled = submitting || remaining < 0 || !textarea.value.trim();
  }
  function saveDraft(): void {
    if (!draft) return;
    dirty = true;
    updateBudget();
    const id = draft.id,
      text = textarea.value,
      selection = draft.selection;
    updates = updates
      .catch(() => undefined)
      .then(async () => {
        const result = await api.runtime.sendMessage<NotesView & { ok?: boolean; reason?: string }>(
          { type: "notes-update", id, text, selection },
        );
        if (result?.ok === false) throw new Error(result.reason);
        if (draft?.id === id && textarea.value === text && draft.selection === selection) {
          dirty = false;
          element("note-draft-status").textContent = "Draft saved";
        }
      })
      .catch(() => {
        element("note-draft-status").textContent =
          "Draft could not be saved. Keep this panel open and try again.";
        throw new Error("Draft not saved");
      });
    void updates.catch(() => undefined);
  }
  textarea.addEventListener("input", saveDraft);
  element("remove-selection").addEventListener("click", () => {
    if (!draft) return;
    draft.selection = "";
    element("note-quotation").hidden = true;
    saveDraft();
  });
  element("note-discard").addEventListener("click", () => {
    if (!draft || submitting) return;
    const id = draft.id;
    submitting = true;
    send.disabled = true;
    textarea.disabled = true;
    void (async () => {
      try {
        await updates;
        const view = await api.runtime.sendMessage<NotesView & { ok?: boolean; reason?: string }>({
          type: "notes-discard",
          id,
        });
        if (view?.ok === false) throw new Error(view.reason);
        draft = null;
        dirty = false;
        render(view);
        status.textContent =
          "Draft discarded. Use the shortcut, page menu or popup to start a new note.";
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : "Your draft was not discarded.";
      } finally {
        submitting = false;
        textarea.disabled = false;
        updateBudget();
      }
    })();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!draft || submitting || send.disabled) return;
    const id = draft.id;
    submitting = true;
    send.disabled = true;
    textarea.disabled = true;
    void (async () => {
      try {
        await updates;
        const view = await api.runtime.sendMessage<NotesView & { ok?: boolean; reason?: string }>({
          type: "notes-submit",
          id,
        });
        if (view?.ok === false) throw new Error(view.reason);
        draft = null;
        dirty = false;
        render(view);
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : "Your note was not sent. Your draft is kept.";
      } finally {
        submitting = false;
        textarea.disabled = false;
        updateBudget();
      }
    })();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && NOTES_STATE_KEY in changes) void refresh(true);
  });
  void refresh();
}
