// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { COGNITION_MUTATING_TOOL_NAMES } from "../steward/tools.js";
import {
  COGNITIVE_ARTIFACTS,
  allGrantableMutatingTools,
  mutationAuthorityFor,
  mutatingToolsFor,
  narrowedWorkflows,
  toolsForArtifact,
} from "./authority.js";
import { COGNITIVE_WORKFLOW_IDS, UNRECOGNIZED_WORKFLOW_ID } from "./workflows.js";

describe("the artifact → tool map", () => {
  it("covers every mutating tool the steward's own toolset builds", () => {
    // A verb missing here would be granted to nobody and silently disappear
    // from every workflow's toolset.
    const grantable = new Set(allGrantableMutatingTools());
    for (const name of COGNITION_MUTATING_TOOL_NAMES) {
      expect(grantable.has(name), name).toBe(true);
    }
  });

  it("assigns each tool to exactly one artifact", () => {
    // Overlap would make an authority grant ambiguous: narrowing a workflow to
    // one artifact would silently hand it a verb over another.
    const seen = new Map<string, string>();
    for (const artifact of COGNITIVE_ARTIFACTS) {
      for (const tool of toolsForArtifact(artifact)) {
        expect(
          seen.get(tool),
          `${tool} claimed by ${seen.get(tool)} and ${artifact}`,
        ).toBeUndefined();
        seen.set(tool, artifact);
      }
    }
  });
});

describe("per-workflow authority", () => {
  it("gives an unnarrowed workflow everything except a merge verdict", () => {
    const intake = mutatingToolsFor("datum-intake");
    expect(intake.has("open_loop_create")).toBe(true);
    expect(intake.has("brief_create")).toBe(true);
    expect(intake.has("annotate_durable")).toBe(true);
    // Only identity adjudication settles a person merge.
    expect(intake.has("merge_adjudicate")).toBe(false);
  });

  it("limits identity adjudication to issuing its verdict", () => {
    // Its prompt already says "issue the verdict through its dedicated tool
    // and touch nothing else"; this makes that a permission rather than a
    // request the model may ignore.
    const tools = mutatingToolsFor("identity-adjudication");
    expect([...tools]).toEqual(["merge_adjudicate"]);
  });

  it("limits the morning digest to the one card it composes", () => {
    // An editorial pass over state other workflows gathered — it revises its
    // own card and creates nothing beneath it.
    const tools = mutatingToolsFor("morning-digest");
    expect(tools.has("brief_create")).toBe(true);
    expect(tools.has("brief_update")).toBe(true);
    expect(tools.has("open_loop_create")).toBe(false);
    expect(tools.has("annotate_durable")).toBe(false);
    expect(tools.has("merge_adjudicate")).toBe(false);
  });

  it("stops memory re-grounding from turning a re-check into an interruption", () => {
    // The prompt builder already withholds the brief-claim hop from this lane
    // on the grounds that it "must not create briefs". Now it cannot.
    const tools = mutatingToolsFor("memory-regrounding");
    expect(tools.has("annotation_revise")).toBe(true);
    expect(tools.has("annotation_retract")).toBe(true);
    expect(tools.has("person_annotation_supersede")).toBe(true);
    expect(tools.has("brief_create")).toBe(false);
    expect(tools.has("open_loop_create")).toBe(false);
  });

  it("declares an authority for every workflow, and grants the unknown one nothing", () => {
    // Three workflows write nothing, and for each an empty authority IS the
    // declaration rather than an omission: watch compilation is a tool-less
    // closed-grammar exchange recorded inline, and the two precision batches
    // are work nothing produces any more — their ids survive only because
    // spend and attribution rows are keyed on them.
    const WRITES_NOTHING = ["subscription-compile", "subscription-precision", "watch-precision"];
    for (const id of COGNITIVE_WORKFLOW_IDS) {
      if (id === UNRECOGNIZED_WORKFLOW_ID) continue;
      if (WRITES_NOTHING.includes(id)) continue;
      expect(mutationAuthorityFor(id).length, id).toBeGreaterThan(0);
    }
    for (const id of WRITES_NOTHING) {
      expect(mutationAuthorityFor(id as (typeof COGNITIVE_WORKFLOW_IDS)[number]), id).toEqual([]);
    }
    // Work whose procedure could not be determined is the case we understand
    // least; it must not receive the widest authority in the system.
    expect(mutationAuthorityFor(UNRECOGNIZED_WORKFLOW_ID)).toEqual([]);
    expect([...mutatingToolsFor(UNRECOGNIZED_WORKFLOW_ID)]).toEqual([]);
  });

  it("narrows only the workflows whose job is genuinely narrower", () => {
    expect([...narrowedWorkflows()].sort()).toEqual([
      "identity-adjudication",
      "memory-regrounding",
      "morning-digest",
      "notes-compaction",
      "provenance-recheck",
      "subscription-compile",
      "subscription-precision",
      UNRECOGNIZED_WORKFLOW_ID,
      "watch-precision",
    ]);
  });

  it("limits notes compaction to the notes blob it curates", () => {
    // A housekeeping pass over the agent's own memory — it rewrites one
    // artifact and must not mint loops, briefs, or annotations while doing so.
    expect(mutationAuthorityFor("notes-compaction")).toEqual(["note"]);
    expect([...mutatingToolsFor("notes-compaction")].sort()).toEqual([
      "notes_append",
      "notes_edit",
      "notes_rewrite",
    ]);
  });

  it("leaves source catch-up at its existing authority", () => {
    // Bootstrap behaviour is deliberately untouched by this change; narrowing
    // it would be a change to the catch-up sweep, not to the authority model.
    expect(mutatingToolsFor("source-bootstrap")).toEqual(mutatingToolsFor("datum-intake"));
  });
});
