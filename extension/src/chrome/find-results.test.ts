// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { readCanonicalizers, findSnippet, findQueryTerms } from "./find-results.js";

describe("Find provider identity boundary", () => {
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
