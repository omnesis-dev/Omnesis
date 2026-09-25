// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach } from "vitest";
import { resolvePatterns, configSourceEntries, buildResultUrl, GATEWAY_URL } from "./utils.js";

const entries = [
  { id: "gmail:alice@example.com", providerId: "google:alice@example.com" },
  { id: "gmail:bob@example.com", providerId: "google:bob@example.com" },
  { id: "google-calendar:alice@example.com", providerId: "google:alice@example.com" },
  { id: "outlook-email:carol@example.com", providerId: "outlook:carol@example.com" },
  { id: "apple-notes", providerId: "apple" },
];

describe("resolvePatterns", () => {
  test("exact source id matches one entry", () => {
    expect(resolvePatterns(["gmail:alice@example.com"], entries)).toEqual([
      "gmail:alice@example.com",
    ]);
  });

  test("type prefix `gmail:` matches every gmail account", () => {
    const got = resolvePatterns(["gmail:"], entries).sort();
    expect(got).toEqual(["gmail:alice@example.com", "gmail:bob@example.com"]);
  });

  test("provider id matches every source under that provider", () => {
    const got = resolvePatterns(["google:alice@example.com"], entries).sort();
    expect(got).toEqual(["gmail:alice@example.com", "google-calendar:alice@example.com"]);
  });

  test("`all` matches every entry", () => {
    expect(resolvePatterns(["all"], entries).length).toBe(entries.length);
  });

  test("multiple patterns union without duplicates", () => {
    const got = resolvePatterns(["gmail:alice@example.com", "gmail:"], entries).sort();
    expect(got).toEqual(["gmail:alice@example.com", "gmail:bob@example.com"]);
  });

  test("no-match returns empty array", () => {
    expect(resolvePatterns(["nonexistent:"], entries)).toEqual([]);
  });

  test("trailing wildcard `gmail:*` is normalized to `gmail:`", () => {
    const got = resolvePatterns(["gmail:*"], entries).sort();
    expect(got).toEqual(["gmail:alice@example.com", "gmail:bob@example.com"]);
  });

  test("trailing `*` (no colon) is stripped, then matched as a bare prefix", () => {
    // `gmail*` → `gmail` → bare-type prefix, so it picks up every
    // `gmail:<account>` entry. The old behavior was to return [] (you
    // had to type `gmail:` explicitly for a prefix match); the new
    // behavior treats the bare token as a type prefix for both source
    // types and provider types, which matches what search-filter users
    // type (`source:gmail` / `source:google`).
    const got = resolvePatterns(["gmail*"], entries).sort();
    expect(got).toEqual(["gmail:alice@example.com", "gmail:bob@example.com"]);
  });

  test("bare source type (no colon, no wildcard) acts as a prefix", () => {
    const got = resolvePatterns(["gmail"], entries).sort();
    expect(got).toEqual(["gmail:alice@example.com", "gmail:bob@example.com"]);
  });

  test("bare provider type (no colon) matches every source under that provider", () => {
    const got = resolvePatterns(["google"], entries).sort();
    expect(got).toEqual([
      "gmail:alice@example.com",
      "gmail:bob@example.com",
      "google-calendar:alice@example.com",
    ]);
  });

  test("source id without account part still matches as exact", () => {
    expect(resolvePatterns(["apple-notes"], entries)).toEqual(["apple-notes"]);
  });
});

describe("configSourceEntries", () => {
  test("derives providerId from source-type lookup", () => {
    const sourceKeys = ["gmail:alice@example.com", "apple-notes"];
    const descriptors = [
      { id: "gmail", provider: { id: "google" } },
      { id: "apple-notes", provider: { id: "apple" } },
    ];
    const got = configSourceEntries(sourceKeys, descriptors);
    expect(got).toEqual([
      { id: "gmail:alice@example.com", providerId: "google" },
      { id: "apple-notes", providerId: "apple" },
    ]);
  });

  test("missing descriptor yields empty providerId", () => {
    const got = configSourceEntries(["unknown:foo"], [{ id: "gmail", provider: { id: "google" } }]);
    expect(got).toEqual([{ id: "unknown:foo", providerId: "" }]);
  });
});

describe("buildResultUrl", () => {
  afterEach(() => {
    delete process.env.OMNESIS_RESULT_URI;
  });

  test("defaults to the result's sourceUrl when present and no template is set", () => {
    expect(buildResultUrl("doc-1", "https://mail.example.com/thread/abc")).toBe(
      "https://mail.example.com/thread/abc",
    );
  });

  test("falls back to the portal doc page when there is no sourceUrl", () => {
    expect(buildResultUrl("doc-2", null)).toBe(`${GATEWAY_URL}/portal/doc/doc-2`);
    expect(buildResultUrl("doc-2")).toBe(`${GATEWAY_URL}/portal/doc/doc-2`);
  });

  test("OMNESIS_RESULT_URI template overrides and substitutes {id}/{sourceUrl}/{portal}", () => {
    process.env.OMNESIS_RESULT_URI = "obsidian://open?path={sourceUrl}";
    expect(buildResultUrl("doc-3", "file:///vault/note.md")).toBe(
      "obsidian://open?path=file:///vault/note.md",
    );

    process.env.OMNESIS_RESULT_URI = "{portal}#{id}";
    expect(buildResultUrl("doc-4", "https://example.com/x")).toBe(
      `${GATEWAY_URL}/portal/doc/doc-4#doc-4`,
    );
  });

  test("template {sourceUrl} substitutes to empty when the result has none", () => {
    process.env.OMNESIS_RESULT_URI = "app://open?u={sourceUrl}";
    expect(buildResultUrl("doc-5", null)).toBe("app://open?u=");
  });
});
