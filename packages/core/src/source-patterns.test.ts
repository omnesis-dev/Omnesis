// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { resolveSourcePatterns, type SourceEntry } from "./source-patterns.js";

// A fixed, fictional source set spanning the shapes the grammar must
// distinguish:
//   - two `gmail:*` sources under the SAME provider account (maya), so
//     bare-provider and exact-provider rules can be told apart from the
//     bare-type rule;
//   - a `gcal:` source sharing maya's provider id (so `google:maya...`
//     must pull it in but bare `gmail` must NOT);
//   - a second account (jamie) so exact-id never accidentally widens;
//   - an Apple source whose provider id has NO colon (`apple`) to exercise
//     the exact-providerId-no-colon branch;
//   - a bare-source-id source (`things`) with no `:` in the id.
const ENTRIES: readonly SourceEntry[] = [
  { id: "gmail:maya@example.com", providerId: "google:maya@example.com" },
  { id: "gcal:maya@example.com", providerId: "google:maya@example.com" },
  { id: "gmail:jamie@example.org", providerId: "google:jamie@example.org" },
  { id: "imessage:device-1", providerId: "apple" },
  { id: "things", providerId: "things" },
];

describe("resolveSourcePatterns grammar matrix", () => {
  test("exact source id resolves to exactly that one source", () => {
    expect(resolveSourcePatterns(["gmail:maya@example.com"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
    ]);
  });

  test("exact provider id resolves to every source under that provider account", () => {
    // `google:maya@example.com` is shared by the gmail AND gcal sources for
    // maya, but NOT by jamie's gmail (different provider account).
    expect(resolveSourcePatterns(["google:maya@example.com"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gcal:maya@example.com",
    ]);
  });

  test("bare source type expands to every source of that type, across accounts", () => {
    // `gmail` must hit both accounts' gmail sources but must NOT pull in
    // maya's gcal source even though it shares the google provider.
    expect(resolveSourcePatterns(["gmail"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gmail:jamie@example.org",
    ]);
  });

  test("bare provider type expands to every source whose provider id has that prefix", () => {
    // `google` is a provider TYPE prefix — it must pull in every source
    // whose providerId starts `google:`, i.e. both maya sources and jamie's.
    expect(resolveSourcePatterns(["google"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gcal:maya@example.com",
      "gmail:jamie@example.org",
    ]);
  });

  test("exact provider id with no colon matches the provider-id-equals branch", () => {
    // `apple` is the full provider id (no account suffix). It must match via
    // `providerId === normalized`, not via the synthesized `apple:` prefix
    // (no source's id/providerId starts `apple:`).
    expect(resolveSourcePatterns(["apple"], ENTRIES)).toEqual(["imessage:device-1"]);
  });

  test("trailing-colon prefix behaves identically to the bare type", () => {
    // CLI back-compat: `gmail:` means the same thing as `gmail`.
    expect(resolveSourcePatterns(["gmail:"], ENTRIES)).toEqual(
      resolveSourcePatterns(["gmail"], ENTRIES),
    );
  });

  test("trailing `*` wildcard is stripped, then matched as a bare type", () => {
    expect(resolveSourcePatterns(["gmail*"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gmail:jamie@example.org",
    ]);
  });

  test("`:*` wildcard collapses onto the trailing-colon form", () => {
    expect(resolveSourcePatterns(["gmail:*"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gmail:jamie@example.org",
    ]);
  });

  test("`all` resolves to every configured source id", () => {
    expect(resolveSourcePatterns(["all"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gcal:maya@example.com",
      "gmail:jamie@example.org",
      "imessage:device-1",
      "things",
    ]);
  });

  test("bare source id with no colon matches the id-equals branch only", () => {
    // `things` has no `:` and is not a type prefix of anything. It must
    // resolve to itself via `e.id === normalized` and nothing else — the
    // synthesized `things:` prefix matches no source.
    expect(resolveSourcePatterns(["things"], ENTRIES)).toEqual(["things"]);
  });

  test("an unmatched pattern resolves to the empty set (no implicit widening)", () => {
    expect(resolveSourcePatterns(["nonexistent"], ENTRIES)).toEqual([]);
    expect(resolveSourcePatterns(["whatsapp"], ENTRIES)).toEqual([]);
  });

  test("multiple patterns union, deduped, in first-seen insertion order", () => {
    // First pattern pins maya's gmail; second pattern (bare `gmail`) re-adds
    // maya's gmail (deduped) and introduces jamie's. The exact id must come
    // first because it was inserted first.
    expect(resolveSourcePatterns(["gmail:maya@example.com", "gmail"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gmail:jamie@example.org",
    ]);
  });

  test("overlapping patterns never duplicate a source in the output", () => {
    // `all` then `gmail` then the exact id all cover maya's gmail; it must
    // appear exactly once.
    const result = resolveSourcePatterns(["all", "gmail", "gmail:maya@example.com"], ENTRIES);
    expect(result.filter((id) => id === "gmail:maya@example.com")).toHaveLength(1);
    // `all` already covers everything, so the union is exactly the full set.
    expect(result).toHaveLength(ENTRIES.length);
  });

  test("empty pattern list and empty entry set both resolve to empty", () => {
    expect(resolveSourcePatterns([], ENTRIES)).toEqual([]);
    expect(resolveSourcePatterns(["all", "gmail"], [])).toEqual([]);
  });
});

describe("a qualified id names exactly one source", () => {
  const entries: SourceEntry[] = [
    { id: "gmail:maya@example.com", providerId: "google:maya@example.com" },
    { id: "gmail:maya-archive@example.com", providerId: "google:maya-archive@example.com" },
    { id: "obsidian-notes:vault", providerId: "obsidian:vault" },
    { id: "obsidian-notes:vault2", providerId: "obsidian:vault2" },
  ];

  test("a full source id does not reach a longer id that starts with it", () => {
    // `sources remove <id>` resolves through here: read as a prefix, one named
    // source also took every source whose id happened to extend it.
    expect(resolveSourcePatterns(["obsidian-notes:vault"], entries)).toEqual([
      "obsidian-notes:vault",
    ]);
    expect(resolveSourcePatterns(["gmail:maya@example.com"], entries)).toEqual([
      "gmail:maya@example.com",
    ]);
  });

  test("a full provider id reaches only that provider's sources", () => {
    expect(resolveSourcePatterns(["google:maya@example.com"], entries)).toEqual([
      "gmail:maya@example.com",
    ]);
  });

  test("a type, bare or with its colon, still widens to every account", () => {
    expect(resolveSourcePatterns(["obsidian-notes"], entries)).toEqual([
      "obsidian-notes:vault",
      "obsidian-notes:vault2",
    ]);
    expect(resolveSourcePatterns(["obsidian-notes:"], entries)).toEqual([
      "obsidian-notes:vault",
      "obsidian-notes:vault2",
    ]);
  });
});
