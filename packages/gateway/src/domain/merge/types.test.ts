// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { STRONG_IDENTIFIER_PLACEHOLDERS, STRONG_IDENTIFIER_TYPES } from "./types.js";

describe("the strong-identifier list", () => {
  test("is exactly the alias types that name one person on their own", () => {
    // What is in this list decides what Omnesis merges without asking. A name
    // is not here: as many people have one as happen to have it.
    expect([...STRONG_IDENTIFIER_TYPES]).toEqual(["email", "phone", "lid"]);
  });

  test("binds one placeholder per type, so a query and its parameters agree", () => {
    // The list is spliced into three SQL clauses and bound positionally. A
    // placeholder run that disagreed with the list would either bind the wrong
    // types or throw at prepare time, in a query that decides merges.
    expect(STRONG_IDENTIFIER_PLACEHOLDERS.split(",")).toHaveLength(STRONG_IDENTIFIER_TYPES.length);
    expect(STRONG_IDENTIFIER_PLACEHOLDERS).toBe("?,?,?");
  });
});
