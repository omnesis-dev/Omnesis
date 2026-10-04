// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { initFindEntry } from "./find-entry.js";
import { PAIRING_KEY } from "./pairing-record.js";
import { loadPage } from "./page-test-fakes.js";

function entry(name: "options.html" | "popup.html") {
  const { document, window } = loadPage(name);
  let view = { supported: false, enabled: false };
  let opening: { ok: boolean; reason?: string } = { ok: true };
  let changed: ((changes: Record<string, unknown>, area: string) => void) | undefined;
  const close = vi.fn();
  Object.defineProperty(window, "close", { configurable: true, value: close });
  const query = vi.fn(async () => [{ id: 7, url: "https://example.org/article" }]);
  const sendMessage = vi.fn(async (message: unknown) =>
    (message as { type?: string }).type === "find-open" ? opening : view,
  );
  initFindEntry(document, {
    tabs: { query },
    runtime: {
      sendMessage: async <T>(message: unknown): Promise<T> => (await sendMessage(message)) as T,
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
    close,
    enable: () => {
      view = { supported: true, enabled: true };
      changed?.({ [PAIRING_KEY]: {} }, "local");
    },
    failOpening: () => {
      opening = { ok: false, reason: "The side panel could not open. Try again." };
    },
  };
}

describe("Find entry", () => {
  it("hides the icon when the paired gateway does not offer experimental Find", async () => {
    const e = entry("popup.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    expect(e.document.getElementById("find-omnesis")?.hidden).toBe(true);
    expect(e.document.getElementById("find-entry")?.hidden).toBe(true);
    expect(e.document.getElementById("enable-find")).toBeNull();
  });
  it("uses the cached tab and closes the popup only after opening succeeds", async () => {
    const e = entry("popup.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    e.enable();
    await vi.waitFor(() => expect(e.document.getElementById("find-omnesis")?.hidden).toBe(false));
    e.document.getElementById("find-omnesis")!.dispatchEvent(new e.window.Event("click"));
    expect(e.sendMessage).toHaveBeenCalledWith({ type: "find-open", tabId: 7 });
    expect(e.query).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(e.close).toHaveBeenCalledOnce());
  });
  it("keeps a failed opening visible and explains how to retry", async () => {
    const e = entry("popup.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    e.enable();
    e.failOpening();
    await vi.waitFor(() => expect(e.document.getElementById("find-omnesis")?.hidden).toBe(false));
    e.document.getElementById("find-omnesis")!.dispatchEvent(new e.window.Event("click"));
    await vi.waitFor(() =>
      expect(e.document.getElementById("find-entry-hint")?.textContent).toBe(
        "The side panel could not open. Try again.",
      ),
    );
    expect(e.document.getElementById("find-entry")?.hidden).toBe(false);
    expect(e.close).not.toHaveBeenCalled();
  });
  it("refreshes pairing on options without showing an activation button or opening a popup", async () => {
    const e = entry("options.html");
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenCalled());
    e.enable();
    await vi.waitFor(() => expect(e.sendMessage).toHaveBeenLastCalledWith({ type: "find-status" }));
    expect(e.document.getElementById("find-omnesis")?.hidden).toBe(true);
    expect(e.document.getElementById("enable-find")).toBeNull();
    expect(e.query).not.toHaveBeenCalled();
  });
});
