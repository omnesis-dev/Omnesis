// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { browserIdentity, findOpenTab } from "./find-tabs.js";
import type { FindResult } from "./find-service.js";

const result: FindResult = {
  id: "result-1",
  documentId: "document-1",
  title: "Invented guide",
  url: "https://example.org/guide",
  snippet: "",
  source: "Example",
};
describe("local document tab identity", () => {
  it("matches capture-equivalent trailing slashes without discarding query or fragment state", () => {
    const url = "https://example.org/guide/?edition=1#overview";
    expect(
      findOpenTab(
        { ...result, url },
        [{ id: 7, url: "https://example.org/guide?edition=1#overview" }],
        [],
      )?.id,
    ).toBe(7);
    for (const distinct of [
      "https://example.org/guide?edition=2#overview",
      "https://example.org/guide?edition=1#details",
    ]) {
      expect(findOpenTab({ ...result, url }, [{ id: 7, url: distinct }], [])).toBeUndefined();
    }
  });
  it("does not collapse domains, hash-only resources, account selectors or session parameters", () => {
    for (const [a, b] of [
      ["https://example.org/guide", "https://example.org/another-guide"],
      ["https://example.org/#doc=123", "https://example.org/#doc=456"],
      [
        "https://example.org/?authuser=alice@example.com",
        "https://example.org/?authuser=bob@example.com",
      ],
      ["https://example.org/?session=one", "https://example.org/?session=two"],
    ]) {
      expect(browserIdentity(a!, [])).not.toBe(browserIdentity(b!, []));
      expect(findOpenTab({ ...result, url: a! }, [{ id: 7, url: b! }], [])).toBeUndefined();
    }
  });
  it("uses provider-declared identity aliases and skips inaccessible/private tabs", () => {
    const canonicalizers = [
      {
        hosts: ["example.org"],
        rules: [],
        browserIdentity: { part: "path" as const, format: "uuid-suffix" as const },
      },
    ];
    const wanted = { ...result, url: "https://example.org/view-123456781234123412341234567890ab" };
    expect(
      findOpenTab(
        wanted,
        [
          { id: 1 },
          {
            id: 2,
            url: "https://example.org/edit-12345678-1234-1234-1234-1234567890ab",
            incognito: true,
          },
          { id: 3, url: "https://example.org/edit-12345678-1234-1234-1234-1234567890ab" },
        ],
        canonicalizers,
      )?.id,
    ).toBe(3);
  });
});
