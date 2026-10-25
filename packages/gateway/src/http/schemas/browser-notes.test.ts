// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { browserNoteBody, browserNoteEditBody } from "./browser-notes.js";
import { browserFindSuggestBody } from "./browser-find.js";

const note = {
  version: 1,
  id: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  text: "Compare with the other offer",
  page: { url: "https://example.com/offer", title: "Offer" },
};

describe("browser request bodies from a newer extension", () => {
  it("ignore fields this gateway does not know", () => {
    const parsed = browserNoteBody.safeParse({
      ...note,
      tags: ["later"],
      page: { ...note.page, favicon: "https://example.com/favicon.ico" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("tags");
    expect(parsed.data?.page).not.toHaveProperty("favicon");
    expect(
      browserNoteEditBody.safeParse({
        version: 1,
        url: note.page.url,
        text: "Edited",
        revision: "a".repeat(64),
        cursor: 3,
      }).success,
    ).toBe(true);
    expect(
      browserFindSuggestBody.safeParse({ version: 1, text: "offer", source: "omnibox" }).success,
    ).toBe(true);
  });

  it("still refuse a contract version this gateway does not speak", () => {
    expect(browserNoteBody.safeParse({ ...note, version: 2 }).success).toBe(false);
    expect(browserFindSuggestBody.safeParse({ version: 2, text: "offer" }).success).toBe(false);
  });
});
