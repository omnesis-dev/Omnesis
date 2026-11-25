// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SourceId } from "@omnesis/types";

import {
  assertMutableSource,
  isGatewayInternalSource,
  listInternalSources,
} from "./internal-sources.js";
import { OMNESIS_NOTES_SOURCE_ID } from "./sources/omnesis-notes/index.js";
import { OMNESIS_RECORDINGS_SOURCE_ID } from "./sources/omnesis-recordings/index.js";

describe("gateway-internal sources", () => {
  test("advertises the notes source and hides recordings while Recordings is off in Lab", () => {
    expect(listInternalSources(() => false)).toEqual([{ id: OMNESIS_NOTES_SOURCE_ID }]);
  });

  test("advertises the recordings source only while Recordings is on in Lab", () => {
    const asked: string[] = [];
    const listed = listInternalSources((feature) => {
      asked.push(feature);
      return feature === "recordings";
    });
    expect(listed).toEqual([{ id: OMNESIS_NOTES_SOURCE_ID }, { id: OMNESIS_RECORDINGS_SOURCE_ID }]);
    expect(asked).toEqual(["recordings"]);
  });

  test("recognises internal ids", () => {
    expect(isGatewayInternalSource(OMNESIS_NOTES_SOURCE_ID)).toBe(true);
    expect(isGatewayInternalSource("gmail:fictional-account")).toBe(false);
  });

  test("assertMutableSource refuses internal ids with INTERNAL_SOURCE", () => {
    expect(() => assertMutableSource(SourceId(OMNESIS_NOTES_SOURCE_ID))).toThrow(
      expect.objectContaining({ status: 409, code: "INTERNAL_SOURCE" }),
    );
  });

  test("assertMutableSource passes regular ids", () => {
    expect(() => assertMutableSource(SourceId("gmail:fictional-account"))).not.toThrow();
  });
});
