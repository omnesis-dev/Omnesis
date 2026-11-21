// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { grantRulesSchema } from "../../../../src/access/store-rules.js";

// @ts-expect-error — Portal modules are plain JavaScript.
import * as grantBuilderState from "../../components/grant-builder-state.js";
// @ts-expect-error — Portal modules are plain JavaScript.
import * as sourceFilterState from "../../components/source-filter-state.js";

const { newGrantRule, normalizeGrantRules, serializeGrantRules, serializeNewAuthorityRules } =
  grantBuilderState;
const { copyRuleFilters, expectedFilterRevisions } = sourceFilterState;

const POLICY = "00000000-0000-4000-8000-000000000002";

/**
 * The rules a gateway without source filters accepts: strict objects with the
 * keys below and no other. A body that parses here is one such a gateway
 * would have taken from the portal it served.
 */
const sources = z
  .object({
    mode: z.enum(["all", "allowlist", "denylist"]),
    sourceIds: z.array(z.string().min(1).max(512)).max(256),
  })
  .strict();
const rulesWithoutFilters = z.array(
  z.discriminatedUnion("capability", [
    z.object({ capability: z.literal("direct"), sources }).strict(),
    z.object({ capability: z.literal("notes"), sources }).strict(),
    z
      .object({
        capability: z.literal("answer"),
        sources,
        release: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("reviewed"), policyFamilyId: z.string().uuid() }).strict(),
          z.object({ mode: z.literal("unreviewed") }).strict(),
        ]),
      })
      .strict(),
  ]),
);

function unfilteredState() {
  return {
    answer: {
      ...newGrantRule("answer", POLICY),
      sources: { mode: "allowlist", sourceIds: ["mail:personal"] },
    },
    direct: { ...newGrantRule("direct"), sources: { mode: "all", sourceIds: [] } },
    notes: { ...newGrantRule("notes"), sources: { mode: "all", sourceIds: [] } },
  };
}

describe("the rules the portal sends for a level without filters", () => {
  it("carry only the keys a gateway without source filters accepts, for a level and for an approval", () => {
    for (const serialize of [serializeGrantRules, serializeNewAuthorityRules]) {
      const rules = serialize(unfilteredState());
      expect(rulesWithoutFilters.safeParse(rules).success).toBe(true);
      expect(grantRulesSchema.safeParse(rules).success).toBe(true);
    }
  });

  it("stay free of filter keys after a round trip through the rules a gateway serves", () => {
    const served = serializeGrantRules(unfilteredState());
    const rules = serializeGrantRules(normalizeGrantRules(served, POLICY));
    expect(rules).toEqual(served);
    expect(rulesWithoutFilters.safeParse(rules).success).toBe(true);
  });

  it("gain an empty filter list on Direct when it follows an unfiltered Answer, which only a gateway with source filters accepts", () => {
    const state = unfilteredState();
    const mirrored = { ...state, direct: copyRuleFilters(state.direct, state.answer) };
    const rules = serializeNewAuthorityRules(mirrored);
    const direct = rules.find((rule: { capability: string }) => rule.capability === "direct");
    expect(direct).toEqual({
      capability: "direct",
      sources: { mode: "all", sourceIds: [] },
      scopePolicies: [],
    });
    expect(grantRulesSchema.safeParse(rules).success).toBe(true);
    expect(rulesWithoutFilters.safeParse(rules).success).toBe(false);
  });

  it("name revision zero for each corpus capability when a level edit is saved", () => {
    expect(expectedFilterRevisions(normalizeGrantRules(serializeGrantRules(unfilteredState())))).toEqual({
      answer: 0,
      direct: 0,
    });
  });
});
