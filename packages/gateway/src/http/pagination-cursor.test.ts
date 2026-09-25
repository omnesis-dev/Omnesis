// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { BadRequestError } from "./errors.js";
import { decodePageCursor, encodePageCursor } from "./pagination-cursor.js";

interface TestKey {
  at: number;
  id: string;
}

function parseKey(value: unknown): TestKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.at === "number" && typeof candidate.id === "string"
    ? { at: candidate.at, id: candidate.id }
    : null;
}

describe("scoped opaque pagination cursors", () => {
  test("round-trips a valid endpoint-owned payload", () => {
    const cursor = encodePageCursor("runs", { at: 42, id: "run_1" });
    expect(cursor).not.toContain("run_1");
    expect(decodePageCursor(cursor, "runs", parseKey)).toEqual({ at: 42, id: "run_1" });
  });

  test("returns null when no cursor was supplied", () => {
    expect(decodePageCursor(undefined, "runs", parseKey)).toBeNull();
  });

  test.each([
    ["malformed", "not-json"],
    [
      "wrong version",
      Buffer.from(JSON.stringify({ v: 2, scope: "runs", payload: {} })).toString("base64url"),
    ],
    ["wrong scope", encodePageCursor("briefs", { at: 42, id: "run_1" })],
    ["wrong payload", encodePageCursor("runs", { at: "42", id: "run_1" })],
  ])("rejects a %s cursor as a canonical 400", (_label, cursor) => {
    expect(() => decodePageCursor(cursor, "runs", parseKey)).toThrowError(BadRequestError);
  });
});
