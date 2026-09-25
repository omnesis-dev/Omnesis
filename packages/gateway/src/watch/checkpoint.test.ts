// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The keyset cursor's two properties, and the projection's one guard.
 *
 * Both sweeps page over a timestamp that is not unique, so the pair has to
 * order strictly where the timestamp alone does not — and the empty id has to
 * mean "the start of this group", because that is how a checkpoint declines to
 * step into a timestamp it may have only half received.
 */

import { describe, expect, it } from "vitest";

import { decodeCheckpoint, encodeCheckpoint, isAfter } from "./checkpoint.js";
import { declaredMetadata, parseMetadata } from "./declared-metadata.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";

describe("a position in the keyset", () => {
  it("survives a round trip through its stored form", () => {
    const at = "2026-03-01T09:00:00.000Z";
    const id = "11111111-2222-4333-8444-555555555555";
    expect(decodeCheckpoint(encodeCheckpoint({ at, id }))).toEqual({ at, id });
  });

  it("reads a stored value with no id as the start of its group", () => {
    // The safe direction: re-read the whole timestamp group rather than resume
    // after some particular row in it.
    expect(decodeCheckpoint("2026-03-01T09:00:00.000Z")).toEqual({
      at: "2026-03-01T09:00:00.000Z",
      id: "",
    });
  });

  it("has nothing stored as no position at all", () => {
    expect(decodeCheckpoint(null)).toBeNull();
  });

  it("orders by the id when the timestamp ties", () => {
    const at = "2026-03-01T09:00:00.000Z";
    expect(isAfter({ at, id: "b" }, { at, id: "a" })).toBe(true);
    expect(isAfter({ at, id: "a" }, { at, id: "b" })).toBe(false);
    expect(isAfter({ at, id: "a" }, { at, id: "a" })).toBe(false);
  });

  it("puts the start of a group before every row in it", () => {
    // What makes "stop before this timestamp" expressible at all.
    const at = "2026-03-01T09:00:00.000Z";
    expect(isAfter({ at, id: "" }, { at, id: "a" })).toBe(false);
    expect(isAfter({ at, id: "a" }, { at, id: "" })).toBe(true);
  });

  it("orders by the timestamp first, whatever the ids say", () => {
    expect(
      isAfter(
        { at: "2026-03-02T00:00:00.000Z", id: "a" },
        { at: "2026-03-01T00:00:00.000Z", id: "z" },
      ),
    ).toBe(true);
  });
});

describe("projecting metadata onto a source's declaration", () => {
  const profile = (paths: string[]): DocumentEventProfile => ({
    documentTypes: ["email"],
    personRoles: ["sender"],
    metadataFields: paths.map((path) => ({ path, type: "string", description: path })),
  });

  it("rebuilds the dotted path rather than flattening it", () => {
    const out = declaredMetadata(
      { extra: { threadId: "t-1", secret: "no" } },
      profile(["extra.threadId"]),
    );
    expect(out).toEqual({ extra: { threadId: "t-1" } });
  });

  it("carries nothing when the source declared nothing", () => {
    expect(declaredMetadata({ tags: ["INBOX"] }, null)).toEqual({});
  });

  it("skips a declared path the document does not have", () => {
    expect(declaredMetadata({}, profile(["tags"]))).toEqual({});
  });

  it("refuses a path that addresses the prototype", () => {
    // Declared paths arrive from a source and are read back out of a table, so
    // the projection is one bad stored declaration away from writing through
    // an object's prototype.
    const out = declaredMetadata(
      { __proto__: { polluted: true } },
      profile(["__proto__.polluted"]),
    );
    expect(out).toEqual({});
    expect(
      ({} as Record<string, unknown>)["polluted"],
      "the prototype was written",
    ).toBeUndefined();
  });

  it("reads unparseable metadata as a document with no declared fields", () => {
    expect(parseMetadata("not json")).toEqual({});
    expect(parseMetadata("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseMetadata('{"a":1}')).toEqual({ a: 1 });
  });
});
