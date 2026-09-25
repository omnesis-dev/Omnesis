// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Grouping a person's aliases for the terminal.
 *
 * The defect this guards against is a field name: the gateway serves
 * `aliasType`, this command read `type`, and every alias therefore grouped
 * under a single heading reading `undefined`. Nothing caught it, because the
 * command declared the shape it wished for rather than the shape it is sent,
 * and a wrong local declaration typechecks perfectly.
 */

import { describe, expect, test } from "vitest";

import { groupAliasesByType } from "./people.js";

describe("a person's aliases, as the terminal shows them", () => {
  test("are grouped under the type the gateway actually sends", () => {
    const grouped = groupAliasesByType([
      { aliasType: "email", alias: "maya@example.org" },
      { aliasType: "email", alias: "m.reeves@example.com" },
      { aliasType: "phone", alias: "+15550100123" },
    ]);
    expect(grouped).toEqual([
      ["email", ["maya@example.org", "m.reeves@example.com"]],
      ["phone", ["+15550100123"]],
    ]);
  });

  test("never invents a heading for a shape it did not recognise", () => {
    const grouped = groupAliasesByType([{ aliasType: "email", alias: "jamie@example.org" }]);
    // Stringified, because the heading is printed: reading the wrong field
    // yields the *value* `undefined`, and a check for the string would stay
    // green under precisely the bug this asserts against.
    expect(grouped.map(([type]) => String(type))).not.toContain("undefined");
  });

  test("says nothing at all when a person has none", () => {
    expect(groupAliasesByType([])).toEqual([]);
  });
});
