// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { resolveSourcePatterns, type SourceEntry } from "./source-patterns.js";

// Boundary tests for the `:*` wildcard strip in resolveSourcePatterns.
//
// The product strips a trailing `:*` with `raw.slice(0, -1)` — removing ONLY
// the `*` and keeping the `:`, so `X:*` normalizes to `X:` (the trailing-colon
// / prefix form). An off-by-one to `slice(0, -2)` would also eat the `:`,
// turning `X:*` into bare `X`. For most type prefixes (`gmail:*`) both forms
// resolve identically, which is exactly why the margin fixtures don't pin this
// boundary. These fixtures are chosen so the kept-vs-dropped `:` flips the
// result set:
//   - `apple` is a complete providerId with NO colon suffix; no source's
//     id/providerId starts with `apple:`. So `apple:` (prefix) matches NOTHING,
//     while bare `apple` matches via `providerId === "apple"`.
//   - `google:maya@example.com` is a complete providerId; nothing starts with
//     `google:maya@example.com:`. So that prefix matches NOTHING, while the
//     bare form matches both of maya's sources via `providerId === ...`.
const ENTRIES: readonly SourceEntry[] = [
  { id: "gmail:maya@example.com", providerId: "google:maya@example.com" },
  { id: "gcal:maya@example.com", providerId: "google:maya@example.com" },
  { id: "gmail:jamie@example.org", providerId: "google:jamie@example.org" },
  { id: "imessage:device-1", providerId: "apple" },
  { id: "things", providerId: "things" },
];

describe("resolveSourcePatterns `:*` strip keeps the colon (off-by-one boundary)", () => {
  test("`apple:*` strips only the `*`, leaving the prefix form `apple:` which matches no source", () => {
    // `apple` is a bare providerId with no colon-suffixed children, so the
    // synthesized `apple:` prefix matches nothing — the correct, narrow result.
    // If the strip also ate the `:` (slice(0,-2)), normalized would be bare
    // `apple`, hitting `providerId === "apple"` and wrongly returning
    // imessage:device-1.
    expect(resolveSourcePatterns(["apple:*"], ENTRIES)).toEqual([]);
  });

  test("bare `apple` (without the `*`) DOES match the no-colon providerId — proving the two forms differ", () => {
    // This is the companion to the case above: it shows that `apple` and
    // `apple:` are genuinely different inputs, so the mutated strip changing
    // `apple:*` into `apple` is observable, not a no-op.
    expect(resolveSourcePatterns(["apple"], ENTRIES)).toEqual(["imessage:device-1"]);
  });

  test("`google:maya@example.com:*` strips only the `*`, leaving a prefix that matches no source", () => {
    // The kept trailing colon yields prefix `google:maya@example.com:`; no
    // id/providerId starts with that, so the result is empty. Eating the colon
    // (slice(0,-2)) would yield bare `google:maya@example.com`, matching both
    // of maya's sources via `providerId === ...`.
    expect(resolveSourcePatterns(["google:maya@example.com:*"], ENTRIES)).toEqual([]);
  });

  test("the exact provider id (without the `:*`) DOES match maya's two sources", () => {
    // Companion proof that the colon eaten by the mutant changes the outcome:
    // bare `google:maya@example.com` resolves to maya's gmail + gcal sources.
    expect(resolveSourcePatterns(["google:maya@example.com"], ENTRIES)).toEqual([
      "gmail:maya@example.com",
      "gcal:maya@example.com",
    ]);
  });
});
