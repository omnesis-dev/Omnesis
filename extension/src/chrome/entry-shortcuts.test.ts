// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { initEntryShortcuts } from "./entry-shortcuts.js";

describe("popup shortcut tooltips", () => {
  it("uses the actual configured shortcuts without changing accessible action names", async () => {
    const { document } = parseHTML(
      '<button id="tell-omnesis" aria-label="Tell Omnesis"></button><button id="find-omnesis" aria-label="Find in Omnesis"></button>',
    );
    initEntryShortcuts(document as unknown as Document, {
      getAll: async () => [
        { name: "tell-omnesis", shortcut: "Alt+Shift+N" },
        { name: "find-omnesis", shortcut: "Ctrl+Shift+K" },
      ],
    });
    await vi.waitFor(() =>
      expect(document.getElementById("find-omnesis")?.title).toBe("Find in Omnesis · Ctrl+Shift+K"),
    );
    expect(document.getElementById("tell-omnesis")?.title).toBe("Tell Omnesis · Alt+Shift+N");
    expect(document.getElementById("find-omnesis")?.getAttribute("aria-label")).toBe(
      "Find in Omnesis",
    );
  });

  it("explains where to assign an unavailable shortcut", async () => {
    const { document } = parseHTML('<button id="find-omnesis"></button>');
    initEntryShortcuts(document as unknown as Document, {
      getAll: async () => [{ name: "find-omnesis", shortcut: "" }],
    });
    await vi.waitFor(() =>
      expect(document.getElementById("find-omnesis")?.title).toContain(
        "chrome://extensions/shortcuts",
      ),
    );
  });
});
