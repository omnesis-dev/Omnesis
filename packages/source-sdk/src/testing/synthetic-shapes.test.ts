// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The synthetic shapes are only worth having if they are themselves correct.
 *
 * These run the real conformance suite over every shape, so a shape that
 * declares a migration it cannot perform, or a decoder that does not settle,
 * fails here rather than misleading whatever contract change it was written to
 * prove.
 */

import { describe, expect, test } from "vitest";
import { defineSource } from "../define-source.js";
import { emptySync } from "../source.js";
import { resolveSourceState } from "../source-state.js";
import { formatConfigIssues } from "../config-schema.js";
import { runSourceConformance } from "./conformance.js";
import {
  allSyntheticShapes,
  chatShape,
  vaultShape,
  type SyntheticShape,
} from "./synthetic-shapes.js";

function asSource(shape: SyntheticShape) {
  return defineSource({
    id: shape.id,
    name: shape.id,
    description: shape.models,
    authType: "local",
    contract: {
      apiVersion: 2,
      state: shape.state,
      ...(shape.state.version > 1 || shape.state.legacyVersion
        ? { requires: ["state-envelope" as const] }
        : {}),
    },
    create: async () => ({ sync: async () => emptySync() }),
  });
}

describe("every shape is itself conformant", () => {
  test.each(allSyntheticShapes.map((s) => [s.id, s] as const))("%s", async (_id, shape) => {
    const report = await runSourceConformance(asSource(shape), {
      stateFixtures: shape.fixtures,
      legacyStateFixtures: shape.legacyFixtures,
      refusedStateFixtures: shape.refusedFixtures,
    });
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
  });

  test("each shape declares a fixture for every version it claims", () => {
    for (const shape of allSyntheticShapes) {
      for (let v = 1; v <= shape.state.version; v++) {
        expect(
          shape.fixtures[v],
          `${shape.id} is missing a fixture for version ${v}`,
        ).toBeDefined();
      }
    }
  });

  test("each shape says what it models and what it exercises", () => {
    // A shape nobody can explain is a shape nobody will maintain.
    for (const shape of allSyntheticShapes) {
      expect(shape.models.length, shape.id).toBeGreaterThan(10);
      expect(shape.exercises.length, shape.id).toBeGreaterThan(10);
    }
  });

  test("the ids are distinct, so a failure names one shape", () => {
    const ids = allSyntheticShapes.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the vault shape carries work forward, not just a position", () => {
  test("its migration stages the old ids for deletion", () => {
    const outcome = resolveSourceState(vaultShape.state, {
      e: 1,
      v: 1,
      state: vaultShape.fixtures[1] as Record<string, unknown>,
    });
    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;
    // Both halves: every fingerprint forgotten so each file re-emits, and the
    // old path-shaped ids staged so the corpus does not hold two generations.
    expect(outcome.state.files).toEqual({});
    expect(outcome.state.pendingRekeyDeletes).toEqual(["projects/orbit.md", "daily/2026-09-05.md"]);
  });

  test("a cursor caught mid-migration is not migrated a second time", () => {
    // Re-running the migration over already-rekeyed state would stage the new
    // ids for deletion, removing the documents that cycle just wrote.
    const midMigration = vaultShape.legacyFixtures![1];
    const outcome = resolveSourceState(vaultShape.state, midMigration);
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.pendingRekeyDeletes).toEqual(["daily/2026-09-05.md"]);
  });
});

describe("the chat shape floors its acknowledgement", () => {
  test("a legacy value with no sequence resumes at zero rather than starting over", () => {
    // Zero clears nothing, so the cost is one duplicate emission. Refusing the
    // value instead would park a wake-on-event source indefinitely.
    const outcome = resolveSourceState(chatShape.state, chatShape.legacyFixtures![0]);
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.committedSeq).toBe(0);
  });

  test("a nonsensical sequence is floored, not trusted", () => {
    const outcome = resolveSourceState(chatShape.state, {
      phase: "incremental",
      committedSeq: -5,
    });
    expect(outcome.kind === "resume" && outcome.state.committedSeq).toBe(0);
  });

  test("the store identity survives, because it is what makes a foreign sequence detectable", () => {
    const outcome = resolveSourceState(chatShape.state, {
      e: 1,
      v: 1,
      state: chatShape.fixtures[1] as Record<string, unknown>,
    });
    expect(outcome.kind === "resume" && outcome.state.storeId).toBe("store-8c1f0e42");
  });
});

describe("shapes carry no real-world data", () => {
  test("no fixture contains anything resembling a real address or handle", () => {
    const blob = JSON.stringify(allSyntheticShapes.map((s) => [s.fixtures, s.legacyFixtures]));
    // Invented identifiers only: no email domains, no dialled numbers.
    expect(blob).not.toMatch(/@(?!example\.(com|org|net))[a-z0-9-]+\.[a-z]{2,}/i);
    expect(blob).not.toMatch(/\+\d{6,}/);
  });
});

describe("formatConfigIssues is available to shape authors", () => {
  test("renders an empty list as an empty string", () => {
    expect(formatConfigIssues([])).toBe("");
  });
});
