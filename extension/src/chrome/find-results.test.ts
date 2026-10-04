// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  readCanonicalizers,
  findSnippet,
  findQueryTerms,
  readSourceIcons,
  dedupeFindResults,
  type FindResult,
} from "./find-results.js";

describe("Find provider identity boundary", () => {
  it("keeps the first ranked destination while preserving unknown routing and explicit account identities", () => {
    const card = (id: string, url: string): FindResult => ({
      id,
      url,
      title: id,
      snippet: id,
      source: "Example",
    });
    const specs = readCanonicalizers([
      { hosts: ["docs.example.org"], browserIdentity: { part: "path", format: "uuid-suffix" } },
      {
        hosts: ["mail.example.org"],
        browserIdentity: {
          part: "fragment",
          format: "hex-segment",
          pathPrefix: "/mail/",
          requiredQuery: ["account"],
        },
      },
    ]);
    const first = card("strongest-chunk", "https://example.org/article?edition=1#overview");
    const results = dedupeFindResults(
      [
        first,
        card("weaker-chunk", first.url),
        card("slash-copy", "https://example.org/article/?edition=1#overview"),
        card("another-query", "https://example.org/article?edition=2#overview"),
        card("another-fragment", "https://example.org/article?edition=1#details"),
        card("document", "https://docs.example.org/Page-123456781234123412341234567890ab"),
        card("document-alias", "https://docs.example.org/12345678-1234-1234-1234-1234567890ab"),
        card("account-one", "https://mail.example.org/mail/u/0/?account=one#inbox/abcdef"),
        card("account-one-alias", "https://mail.example.org/mail/u/0/?account=one#all/abcdef"),
        card("account-two", "https://mail.example.org/mail/u/0/?account=two#all/abcdef"),
      ],
      specs,
    );
    expect(results.map((result) => result.id)).toEqual([
      "strongest-chunk",
      "another-query",
      "another-fragment",
      "document",
      "account-one",
      "account-two",
    ]);
    expect(results[0]).toBe(first);
  });
  it("accepts only bounded local raster icons and rejects remote or active image content", () => {
    expect(
      readSourceIcons({
        example: "data:image/png;base64,AAAA",
        remote: "https://example.org/icon.png",
        active: "data:image/svg+xml;base64,AAAA",
        huge: "data:image/png;base64," + "A".repeat(100001),
      }),
    ).toEqual({ example: "data:image/png;base64,AAAA" });
  });
  it("accepts structured selectors while dropping all executable wire rules", () => {
    expect(
      readCanonicalizers([
        {
          hosts: ["example.org"],
          rules: [{ match: "(a+)+$", replacement: "" }],
          browserIdentity: { part: "path", format: "uuid-suffix" },
        },
      ]),
    ).toEqual([
      {
        hosts: ["example.org"],
        rules: [],
        browserIdentity: { part: "path", format: "uuid-suffix" },
      },
    ]);
    expect(
      readCanonicalizers([
        { hosts: ["example.org"], rules: [{ match: "(a+)+$", replacement: "" }] },
      ]),
    ).toEqual([]);
  });
  it("rejects unsupported selectors, account fields and unclaimed canonical hosts", () => {
    const base = {
      hosts: ["example.org"],
      browserIdentity: { part: "path", format: "uuid-suffix" },
    };
    for (const invalid of [
      { format: "regex" },
      { part: "query" },
      { canonicalHost: "another.example.org" },
      { requiredQuery: ["account", 19] },
      { pathPrefix: "relative" },
    ]) {
      expect(
        readCanonicalizers([{ ...base, browserIdentity: { ...base.browserIdentity, ...invalid } }]),
      ).toEqual([]);
    }
  });
  it("places a late meaningful match within the visible narrow-panel excerpt", () => {
    const excerpt = findSnippet(
      "The introduction. ".repeat(100) + "project brief" + " ending".repeat(100),
      "the project brief",
    );
    expect(excerpt.indexOf("project")).toBeLessThan(50);
    expect(findQueryTerms("the UI project and Q4 brief")).toEqual(["ui", "project", "q4", "brief"]);
    expect(findQueryTerms("the and")).toEqual(["the", "and"]);
  });
});
