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
  setAllSourcesAllowed,
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
      { capability: "direct", sources: { mode: "allowlist", sourceIds: [] } },
      {
        capability: "answer",
        sources: { mode: "allowlist", sourceIds: ["calendar:work", "github:work"] },
        release: { mode: "reviewed", policyFamilyId: POLICY },
      },
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
    expect(setAllSourcesAllowed(rule, SOURCES, false).sources).toEqual({
      mode: "allowlist",
      sourceIds: [],
    });
    expect(setAllSourcesAllowed(rule, SOURCES, true).sources).toEqual({
      mode: "denylist",
      sourceIds: [],
    });
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

  it("converts block-all into an empty allowlist so future sources stay blocked", () => {
    const rule = {
      ...newGrantRule("direct"),
      sources: { mode: "all", sourceIds: [] },
    };
    expect(setAllSourcesAllowed(rule, SOURCES, false).sources).toEqual({
      mode: "allowlist",
      sourceIds: [],
    });
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
    expect(validateGrantRules({})).toBe("Select at least one capability.");
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

  it("names both capabilities when one shared list leaves them without a source", () => {
    const empty = { mode: "allowlist" as const, sourceIds: [] };
    // One list standing for two capabilities earns one refusal naming both.
    expect(validateGrantRules({
      answer: { ...newGrantRule("answer", "policy-1"), sources: empty },
      direct: { ...newGrantRule("direct"), sources: empty },
    })).toBe("Select at least one source for Answer and Direct.");
    // Diverged lists are separate boundaries, so the empty one is named alone.
    expect(validateGrantRules({
      answer: {
        ...newGrantRule("answer", "policy-1"),
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
      },
      direct: { ...newGrantRule("direct"), sources: empty },
    })).toBe("Select at least one source for Direct.");
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

  it("keeps block-all fail-closed for sources connected later", () => {
    expect(
      setAllSourcesAllowed(
        {
          ...newGrantRule("direct"),
          sources: { mode: "denylist", sourceIds: ["fictional:already-blocked"] },
        },
        ["fictional:one", "fictional:two"],
        false,
      ).sources,
    ).toEqual({ mode: "allowlist", sourceIds: [] });
  });
});
