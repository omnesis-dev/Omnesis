// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

// @ts-expect-error — Portal modules are plain JavaScript.
import * as grantBuilderState from "./grant-builder-state.js";

const {
  isSourceAllowed,
  newGrantRule,
  normalizeGrantRules,
  serializeGrantRules,
  setFutureSourcesAllowed,
  setSourceAllowed,
  setSourceMode,
  validateGrantRules,
} = grantBuilderState;

const POLICY = "00000000-0000-4000-8000-000000000002";
const SOURCES = ["calendar:work", "github:work", "mail:personal"];

describe("Grant Builder state", () => {
  it("creates a least-authority rule and serializes a strict deterministic DTO", () => {
    const state = {
      answer: {
        ...newGrantRule("answer", POLICY),
        sources: { mode: "allowlist", sourceIds: ["github:work", "calendar:work", "github:work"] },
      },
      direct: newGrantRule("direct"),
    };

    expect(serializeGrantRules(state)).toEqual([
      {
        capability: "answer",
        sources: { mode: "allowlist", sourceIds: ["calendar:work", "github:work"] },
        release: { mode: "reviewed", policyFamilyId: POLICY },
      },
      { capability: "direct", sources: { mode: "allowlist", sourceIds: [] } },
    ]);
  });

  it("keeps checked rows equal to allowed access in allowlist and denylist modes", () => {
    let rule = {
      ...newGrantRule("direct"),
      sources: { mode: "allowlist", sourceIds: ["github:work"] },
    };
    rule = setSourceMode(rule, "denylist", SOURCES);
    expect(rule.sources).toEqual({
      mode: "denylist",
      sourceIds: ["calendar:work", "mail:personal"],
    });
    expect(SOURCES.filter((id) => isSourceAllowed(rule, id))).toEqual(["github:work"]);

    rule = setSourceAllowed(rule, "calendar:work", true);
    expect(SOURCES.filter((id) => isSourceAllowed(rule, id))).toEqual([
      "calendar:work",
      "github:work",
    ]);
  });

  it("changes future-source behavior without changing current access", () => {
    const selected = {
      ...newGrantRule("direct"),
      sources: { mode: "allowlist", sourceIds: ["github:work"] },
    };
    const futureAllowed = setFutureSourcesAllowed(selected, true, SOURCES);
    expect(futureAllowed.sources).toEqual({
      mode: "denylist",
      sourceIds: ["calendar:work", "mail:personal"],
    });
    expect(SOURCES.filter((id) => isSourceAllowed(futureAllowed, id))).toEqual(["github:work"]);

    const futureBlocked = setFutureSourcesAllowed(futureAllowed, false, SOURCES);
    expect(futureBlocked.sources).toEqual({ mode: "allowlist", sourceIds: ["github:work"] });
  });

  it("normalizes V1 all-source rules but defaults newly enabled rules to an empty allowlist", () => {
    expect(normalizeGrantRules([
      { capability: "direct", sourceMode: "all", sourceIds: [] },
      { capability: "answer", sourceMode: "all", sourceIds: [], privacyPolicy: "default" },
    ], POLICY)).toEqual({
      direct: { capability: "direct", sources: { mode: "all", sourceIds: [] } },
      answer: {
        capability: "answer",
        sources: { mode: "all", sourceIds: [] },
        release: { mode: "reviewed", policyFamilyId: POLICY },
      },
    });
    expect(newGrantRule("direct").sources).toEqual({ mode: "allowlist", sourceIds: [] });
    expect(normalizeGrantRules({ direct: newGrantRule("direct") })).toEqual({
      direct: newGrantRule("direct"),
    });
  });

  it("requires a capability and an explicit Answer release decision", () => {
    expect(validateGrantRules({})).toBe("Choose at least one permission.");
    expect(validateGrantRules({
      answer: {
        ...newGrantRule("answer", ""),
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
      },
    })).toContain("Choose a privacy policy");
    // Unreviewed release is a choice the owner makes outright.
    expect(validateGrantRules({
      answer: {
        ...newGrantRule("answer", ""),
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
        release: { mode: "unreviewed" },
      },
    })).toBeNull();
  });

  it("names the capability whose list leaves it without a source, the way its own decision does", () => {
    const empty = { mode: "allowlist" as const, sourceIds: [] };
    // Two empty lists are refused one at a time, Answer first.
    expect(validateGrantRules({
      answer: { ...newGrantRule("answer", "policy-1"), sources: empty },
      direct: { ...newGrantRule("direct"), sources: empty },
    })).toBe("Select at least one source for Answer.");
    expect(validateGrantRules({
      answer: {
        ...newGrantRule("answer", "policy-1"),
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
      },
      direct: { ...newGrantRule("direct"), sources: empty },
    })).toBe("Select at least one source for Direct.");
  });

  it("refuses a boundary that allows none of the known sources, however it was reached", () => {
    const known = SOURCES.map((id) => ({ id }));
    // Nothing ticked, then "Allow it automatically": every current source is listed away.
    const noneNow = setFutureSourcesAllowed(newGrantRule("direct"), true, SOURCES);
    expect(noneNow.sources).toEqual({ mode: "denylist", sourceIds: SOURCES });
    expect(validateGrantRules({ direct: noneNow }, known)).toBe(
      "Direct would not be able to read any source.",
    );
    // Without the known sources the shape alone looks fine; the list is what catches it.
    expect(validateGrantRules({ direct: noneNow })).toBeNull();
    expect(validateGrantRules({ direct: setSourceAllowed(noneNow, "github:work", true) }, known)).toBeNull();
  });

  it("reports source selections that exceed the HTTP boundary", () => {
    const sourceIds = Array.from({ length: 257 }, (_, index) => `fictional:${index}`);
    expect(validateGrantRules({
      direct: {
        ...newGrantRule("direct"),
        sources: { mode: "allowlist", sourceIds },
      },
    })).toBe("Direct can record at most 256 source selections.");
  });

  describe("a filtered rule's sources on the wire", () => {
    const policy = {
      sourceId: "mail:personal",
      audience: { accessLevel: "level-1", capability: "answer" },
      rules: [{ action: "share", match: [{ capability: "membership", field: "extra.labelIds", id: "invented-label" }] }],
      otherwise: "hide",
    };
    const release = { mode: "reviewed", policyFamilyId: "policy-1" };

    it("edits the selection in scopeSources and sends it back as sources alone", () => {
      const wire = {
        capability: "answer",
        // Filtered accounts are left out of `sources` for clients that ignore filters.
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
        scopeSources: { mode: "allowlist", sourceIds: ["mail:personal", "github:work"] },
        release,
        filterRevision: 4,
        scopePolicies: [policy],
      };
      const state = normalizeGrantRules([wire], "policy-1");
      expect(state.answer.sources).toEqual({
        mode: "allowlist",
        sourceIds: ["github:work", "mail:personal"],
      });
      expect(isSourceAllowed(state.answer, "mail:personal")).toBe(true);
      expect(state.answer).not.toHaveProperty("scopeSources");
      expect(validateGrantRules(state)).toBeNull();
      expect(serializeGrantRules(state)).toEqual([
        {
          capability: "answer",
          sources: { mode: "allowlist", sourceIds: ["github:work", "mail:personal"] },
          release,
          filterRevision: 4,
          scopePolicies: [policy],
        },
      ]);
    });

    it("reads sources as the selection when the rule carries no scopeSources", () => {
      const wire = {
        capability: "answer",
        sources: { mode: "denylist", sourceIds: ["calendar:work"] },
        release,
        filterRevision: 4,
        scopePolicies: [policy],
      };
      const state = normalizeGrantRules([wire], "policy-1");
      expect(state.answer.sources).toEqual({ mode: "denylist", sourceIds: ["calendar:work"] });
      expect(serializeGrantRules(state)).toEqual([wire]);
    });
  });
});
