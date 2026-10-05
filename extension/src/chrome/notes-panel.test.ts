// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { initNotesPanel } from "./notes-panel.js";
import type { NotesView } from "./notes-service.js";

function panel(disabled = false, rejectSubmit = false) {
  const { document, window } = parseHTML(
    readFileSync(new URL("../../public/notes.html", import.meta.url), "utf8"),
  );
  let view: NotesView = {
    supported: !disabled,
    enabled: !disabled,
    rejected: disabled ? [{ id: "rejected", title: "Fictional page" }] : [],
    pendingApproval: false,
    pending: 0,
    draft: {
      id: "11111111-1111-4111-8111-111111111111",
      text: "",
      url: "https://example.org/article",
      title: "Fictional article",
      selection: "A quotation",
      capturedAt: "2026-01-01T00:00:00Z",
    },
  };
  const messages: unknown[] = [];
  const sendMessage = vi.fn(async (msg: unknown) => {
    messages.push(msg);
    const message = msg as { type: string; text?: string; selection?: string };
    if (message.type === "notes-update")
      view = {
        ...view,
        draft: { ...view.draft!, text: message.text!, selection: message.selection! },
      };
    if (message.type === "notes-submit") {
      if (rejectSubmit) return { ok: false, reason: "Invented save failure" };
      view = { ...view, pending: 1, draft: null };
    }
    return view;
  });
  const accepted = vi.fn();
  initNotesPanel(
    document as unknown as Document,
    {
      runtime: {
        sendMessage: async <T>(message: unknown): Promise<T> => {
          const result: unknown = await sendMessage(message);
          return result as T;
        },
      },
      storage: { onChanged: { addListener: vi.fn() } },
    },
    accepted,
  );
  return { document, window, messages, accepted };
}
describe("notes side panel", () => {
  it("renders frozen context and persists typing before submitting", async () => {
    const p = panel();
    await vi.waitFor(() =>
      expect(p.document.getElementById("note-title")?.textContent).toBe("Fictional article"),
    );
    const text = p.document.getElementById("note-text") as unknown as HTMLTextAreaElement;
    text.value = "An invented thought";
    text.dispatchEvent(new p.window.Event("input"));
    await vi.waitFor(() =>
      expect(p.messages).toContainEqual(
        expect.objectContaining({ type: "notes-update", text: "An invented thought" }),
      ),
    );
    p.document
      .getElementById("notes-form")!
      .dispatchEvent(new p.window.Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(p.document.getElementById("notes-status")?.textContent).toContain("waiting to sync"),
    );
    await vi.waitFor(() => expect(p.accepted).toHaveBeenCalledOnce());
    expect(p.document.getElementById("note-draft-status")?.textContent).toBe("");
    expect(p.messages).toContainEqual({
      type: "notes-submit",
      id: "11111111-1111-4111-8111-111111111111",
    });
  });
  it("keeps the panel and draft open when saving fails", async () => {
    const p = panel(false, true);
    await vi.waitFor(() => expect(p.document.getElementById("notes-form")?.hidden).toBe(false));
    const text = p.document.getElementById("note-text") as unknown as HTMLTextAreaElement;
    text.value = "An invented thought";
    text.dispatchEvent(new p.window.Event("input"));
    p.document
      .getElementById("notes-form")!
      .dispatchEvent(new p.window.Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(p.document.getElementById("notes-status")?.textContent).toBe("Invented save failure"),
    );
    expect(p.accepted).not.toHaveBeenCalled();
    expect(text.value).toBe("An invented thought");
    expect(p.document.getElementById("notes-form")?.hidden).toBe(false);
  });
  it("shows the selected passage ready to compose without extra explanatory controls", async () => {
    const p = panel();
    await vi.waitFor(() => expect(p.document.getElementById("notes-form")?.hidden).toBe(false));
    expect(p.document.getElementById("note-selection")?.textContent).toBe("A quotation");
    expect(p.document.getElementById("remove-selection")).toBeNull();
    expect(p.document.body.textContent).not.toContain("This note stays attached");
    expect(p.document.getElementById("note-url")?.textContent).toBe("https://example.org/article");
  });
  it("hides the composer and unsent-note recovery when experimental notes are unavailable", async () => {
    const p = panel(true);
    await vi.waitFor(() =>
      expect(p.document.getElementById("notes-status")?.textContent).toContain("unavailable"),
    );
    expect(p.document.getElementById("notes-form")?.hidden).toBe(true);
    expect(p.document.getElementById("notes-rejected")?.hidden).toBe(true);
    expect(p.document.querySelectorAll("#notes-rejected button")).toHaveLength(0);
  });
});
