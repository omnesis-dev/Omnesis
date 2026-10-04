// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { initNotesEditPanel } from "./notes-edit-panel.js";
import type { NotesEditView } from "./notes-edit-service.js";
function panel() {
  const { document, window } = parseHTML(
    readFileSync(new URL("../../public/notes.html", import.meta.url), "utf8"),
  );
  const textarea = document.getElementById("saved-note-text") as unknown as HTMLTextAreaElement;
  textarea.focus = vi.fn();
  const newText = document.getElementById("note-text") as unknown as HTMLTextAreaElement;
  newText.focus = vi.fn();
  let view: NotesEditView = {
    enabled: true,
    url: "https://example.org/guide",
    notes: [
      {
        id: "note",
        documentId: "day",
        text: "Invented saved thought",
        revision: "1".repeat(64),
        page: null,
        editable: true,
        capturedAt: "2030-01-01",
        updatedAt: "2030-01-01",
      },
    ],
  };
  const accepted = vi.fn();
  let rejectDiscard = false,
    release: (() => void) | undefined;
  const send = vi.fn(async (message: unknown) => {
    const msg = message as { type: string; text?: string };
    if (msg.type === "notes-view")
      return { enabled: true, draft: { id: "new", text: "", url: view.url } };
    if (msg.type === "notes-edit-select")
      view = {
        ...view,
        draft: {
          id: "note",
          url: view.url,
          revision: "1".repeat(64),
          text: "Invented saved thought",
          original: "Invented saved thought",
        },
      };
    if (msg.type === "notes-edit-update") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      view = { ...view, draft: { ...view.draft!, text: msg.text! } };
    }
    if (msg.type === "notes-edit-discard") {
      if (rejectDiscard) return { ok: false, reason: "Invented persistence failure" };
      delete view.draft;
    }
    return view;
  });
  const flush = initNotesEditPanel(
    document as unknown as Document,
    {
      runtime: { sendMessage: async <T>(message: unknown) => (await send(message)) as T },
      storage: {
        local: { get: async () => ({ "omnesis.notes.page.v1": { url: view.url } }) },
        onChanged: { addListener: vi.fn() },
      },
    },
    accepted,
  );
  return {
    document,
    window,
    textarea,
    newText,
    flush,
    send,
    accepted,
    release: () => release?.(),
    rejectDiscard: () => {
      rejectDiscard = true;
    },
  };
}
describe("saved-note editor", () => {
  it("selects a saved note explicitly, keeps writes durable before dismissal and returns to the creation composer", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll("[data-note-id]")).toHaveLength(1));
    p.document.querySelector<HTMLButtonElement>("[data-note-id]")!.click();
    await vi.waitFor(() => expect(p.textarea.value).toBe("Invented saved thought"));
    p.textarea.value = "New invented thought";
    p.textarea.dispatchEvent(new p.window.Event("input"));
    let persisted = false;
    void p.flush().then(() => {
      persisted = true;
    });
    await vi.waitFor(() =>
      expect(p.send).toHaveBeenCalledWith({
        type: "notes-edit-update",
        text: "New invented thought",
      }),
    );
    expect(persisted).toBe(false);
    p.release();
    await vi.waitFor(() => expect(persisted).toBe(true));
    p.document.getElementById("saved-note-new")!.click();
    await vi.waitFor(() => expect(p.newText.focus).toHaveBeenCalledOnce());
    expect(p.document.getElementById("saved-note-editor")?.hidden).toBe(true);
  });
  it("keeps the editor visible when discarding changes fails", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.querySelectorAll("[data-note-id]")).toHaveLength(1));
    p.document.querySelector<HTMLButtonElement>("[data-note-id]")!.click();
    await vi.waitFor(() => expect(p.textarea.value).toBe("Invented saved thought"));
    p.rejectDiscard();
    p.document.getElementById("saved-note-discard")!.click();
    await vi.waitFor(() =>
      expect(p.document.getElementById("saved-notes-status")?.textContent).toContain("failure"),
    );
    expect(p.document.getElementById("saved-note-editor")?.hidden).toBe(false);
  });
});
