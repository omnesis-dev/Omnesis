// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { confirmNotesUnpair, initNotesEntry } from "./notes-entry.js";
import { PAIRING_KEY } from "./pairing-record.js";
import { loadPage } from "./page-test-fakes.js";
import type { NotesView } from "./notes-service.js";

function entry(name: "options.html" | "popup.html") {
  const { document, window } = loadPage(name);
  let view: NotesView = {
    supported: false,
    enabled: false,
    pendingApproval: false,
    draft: null,
    pending: 0,
  };
  let changed: ((changes: Record<string, unknown>, area: string) => void) | undefined;
  const sendMessage = vi.fn(async (_message: unknown) => view);
  const query = vi.fn(async () => [
    { id: 1, url: "https://example.org/article", title: "Example article" },
  ]);
  initNotesEntry(document, {
    tabs: { query },
    runtime: {
      sendMessage: async <T>(message: unknown): Promise<T> => {
        const result: unknown = await sendMessage(message);
        return result as T;
      },
    },
    storage: {
      onChanged: {
        addListener: (callback) => {
          changed = callback;
        },
      },
    },
  });
  return {
    document,
    window,
    query,
    sendMessage,
    setView: (value: Partial<NotesView>) => {
      view = { ...view, ...value };
    },
    pair: () => changed?.({ [PAIRING_KEY]: {} }, "local"),
  };
}
describe("notes discovery", () => {
  it("does not offer notes on unsupported gateways", async () => {
    const e = entry("popup.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    expect(e.document.getElementById("notes-entry")?.hidden).toBe(true);
  });
  it("uses the tab cached before the popup click without delaying the opening message", async () => {
    const e = entry("popup.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    e.setView({ supported: true, enabled: true });
    e.pair();
    await vi.waitFor(() => expect(e.document.getElementById("tell-omnesis")?.hidden).toBe(false));
    e.document.getElementById("tell-omnesis")!.dispatchEvent(new e.window.Event("click"));
    expect(e.sendMessage).toHaveBeenCalledWith({
      type: "notes-open",
      tabId: 1,
      page: { url: "https://example.org/article", title: "Example article", selection: "" },
    });
    expect(e.query).toHaveBeenCalledTimes(1);
  });
  it("refreshes capabilities when an already-open options page finishes pairing", async () => {
    const e = entry("options.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    e.setView({ supported: true });
    e.pair();
    await vi.waitFor(() => expect(e.document.getElementById("enable-notes")?.hidden).toBe(false));
    expect(e.document.getElementById("notes-entry")?.hidden).toBe(false);
    expect(e.sendMessage).toHaveBeenLastCalledWith({ type: "notes-status" });
  });
});

describe("unpairing with manual notes", () => {
  function api(value: unknown) {
    return { runtime: { sendMessage: async <T>(_message: unknown): Promise<T> => value as T } };
  }
  it("lets the user cancel deletion of a written draft", async () => {
    const confirm = vi.fn(() => false);
    expect(
      await confirmNotesUnpair(api({ draft: { text: "An unsent thought" }, pending: 0 }), confirm),
    ).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "Unpairing deletes this browser’s draft and unsent notes. Saved notes remain in Omnesis. Unpair?",
    );
  });
  it("confirms pending notes and recovery entries even after gateway downgrade", async () => {
    const confirm = vi.fn(() => true);
    expect(
      await confirmNotesUnpair(api({ supported: false, draft: null, pending: 2 }), confirm),
    ).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("does not prompt for an empty draft or notes already saved", async () => {
    const confirm = vi.fn(() => false);
    expect(
      await confirmNotesUnpair(
        api({ draft: { text: "  " }, pending: 0, lastSavedId: "saved" }),
        confirm,
      ),
    ).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("preserves existing unpair behavior when notes are unavailable", async () => {
    const confirm = vi.fn(() => false);
    for (const value of [undefined, null, { supported: false }, { ok: false }])
      expect(await confirmNotesUnpair(api(value), confirm)).toBe(true);
    expect(
      await confirmNotesUnpair(
        {
          runtime: {
            sendMessage: async <T>(): Promise<T> => {
              throw new Error("Worker unavailable");
            },
          },
        },
        confirm,
      ),
    ).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
