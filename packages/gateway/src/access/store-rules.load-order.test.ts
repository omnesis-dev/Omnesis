// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";

// The rule schema is read while other access modules are still being
// evaluated, so the module that defines it must not import, however
// indirectly, a module that reads it. Loading it first is what shows a cycle.
test("the rule schema module loads when it is the first access module imported", async () => {
  const rules = await import("./store-rules.js");
  expect(rules.grantRulesSchema).toBeDefined();
  const helpers = await import("./store-helpers.js");
  expect(helpers).toBeDefined();
});
