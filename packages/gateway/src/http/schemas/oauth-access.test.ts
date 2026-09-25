// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  accessConnectionLevelBody,
  accessDecisionBody,
  accessGrantUpdateBody,
  accessLevelCreateBody,
  accessLevelUpdateBody,
} from "./oauth-access.js";

const reviewedAnswer = {
  capability: "answer" as const,
  sources: { mode: "allowlist" as const, sourceIds: [] as string[] },
  release: {
    mode: "reviewed" as const,
    policyFamilyId: "00000000-0000-4000-8000-000000000001",
  },
};

describe("OAuth access schemas", () => {
  test("accepts Notes alone and alongside reading permissions without release or source filtering", () => {
    const notes = { capability: "notes", sources: { mode: "all", sourceIds: [] } };
    expect(accessGrantUpdateBody.safeParse({ expectedRevision: 1, rules: [notes] }).success).toBe(
      true,
    );
    expect(
      accessGrantUpdateBody.safeParse({
        expectedRevision: 1,
        rules: [
          notes,
          { ...reviewedAnswer, sources: { mode: "all", sourceIds: [] } },
          { capability: "direct", sources: { mode: "all", sourceIds: [] } },
        ],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...notes, sources: { mode: "allowlist", sourceIds: ["fictional:source"] } },
      { ...notes, release: { mode: "unreviewed" } },
    ])
      expect(
        accessGrantUpdateBody.safeParse({ expectedRevision: 1, rules: [invalid] }).success,
      ).toBe(false);
  });
  test("rejects an empty selected-sources boundary when approving a connection", () => {
    const result = accessDecisionBody.safeParse({
      decision: "approve",
      selection: {
        kind: "new-principal",
        principalName: "Fictional agent",
        grantName: "Example access",
        rules: [reviewedAnswer],
        credentialLabel: "Example desktop",
        expiresAt: null,
      },
    });

    expect(result.success).toBe(false);
  });

  test("rejects an existing grant update that selects no source", () => {
    const result = accessGrantUpdateBody.safeParse({
      expectedRevision: 1,
      rules: [reviewedAnswer],
    });

    expect(result.success).toBe(false);
  });

  test("accepts an intentionally unrestricted future-source boundary", () => {
    const result = accessGrantUpdateBody.safeParse({
      expectedRevision: 1,
      rules: [{ ...reviewedAnswer, sources: { mode: "all", sourceIds: [] } }],
    });

    expect(result.success).toBe(true);
  });

  test("accepts a new connection on a new or existing level, and a replacement", () => {
    const direct = { capability: "direct", sources: { mode: "all", sourceIds: [] } };
    const levelId = "00000000-0000-4000-8000-000000000002";
    const approve = (selection: unknown) =>
      accessDecisionBody.safeParse({ decision: "approve", selection }).success;
    expect(
      approve({
        kind: "new-connection",
        name: " Fictional notebook ",
        level: { kind: "new", name: "Reading only", rules: [direct] },
      }),
    ).toBe(true);
    expect(
      approve({
        kind: "new-connection",
        name: "Fictional notebook",
        level: { kind: "existing", levelId, expectedLevelRevision: 1 },
      }),
    ).toBe(true);
    expect(
      approve({ kind: "replace-connection", connectionId: levelId, expectedGrantRevision: 3 }),
    ).toBe(true);
    for (const invalid of [
      {
        kind: "new-connection",
        name: "  ",
        level: { kind: "new", name: "Level", rules: [direct] },
      },
      {
        kind: "new-connection",
        name: "N",
        level: { kind: "new", name: "L".repeat(121), rules: [direct] },
      },
      {
        kind: "new-connection",
        name: "N",
        level: { kind: "existing", levelId: "not-a-uuid", expectedLevelRevision: 1 },
      },
      { kind: "replace-connection", connectionId: levelId, expectedGrantRevision: 0 },
      { kind: "existing-grant", grantId: levelId, credentialLabel: "Laptop", replaces: true },
    ]) {
      expect(approve(invalid)).toBe(false);
    }
  });

  test("validates level bodies and a connection's level move", () => {
    const direct = { capability: "direct", sources: { mode: "all", sourceIds: [] } };
    const levelId = "00000000-0000-4000-8000-000000000002";
    expect(accessLevelCreateBody.safeParse({ name: "Reading only", rules: [direct] }).success).toBe(
      true,
    );
    expect(
      accessLevelCreateBody.safeParse({ name: "Reading only", fromConnectionId: levelId }).success,
    ).toBe(false);
    expect(accessLevelUpdateBody.safeParse({ expectedRevision: 2, name: "Renamed" }).success).toBe(
      true,
    );
    expect(accessLevelUpdateBody.safeParse({ name: "Renamed" }).success).toBe(false);
    expect(accessLevelUpdateBody.safeParse({ expectedRevision: 2 }).success).toBe(false);
    expect(accessLevelUpdateBody.safeParse({ expectedRevision: 2, rules: [direct] }).success).toBe(
      true,
    );
    expect(
      accessConnectionLevelBody.safeParse({
        levelId,
        expectedGrantRevision: 1,
        expectedLevelRevision: 3,
      }).success,
    ).toBe(true);
    expect(
      accessConnectionLevelBody.safeParse({
        levelId,
        expectedGrantRevision: 1,
        expectedLevelRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      accessConnectionLevelBody.safeParse({
        newLevel: { name: "Copied" },
        expectedGrantRevision: 1,
        expectedLevelRevision: 3,
      }).success,
    ).toBe(false);
    expect(accessConnectionLevelBody.safeParse({ levelId, expectedGrantRevision: 1 }).success).toBe(
      true,
    );
    expect(
      accessConnectionLevelBody.safeParse({
        newLevel: { name: "Copied" },
        expectedGrantRevision: 1,
      }).success,
    ).toBe(true);
    expect(
      accessConnectionLevelBody.safeParse({ levelId: null, expectedGrantRevision: 1 }).success,
    ).toBe(false);
    expect(
      accessConnectionLevelBody.safeParse({
        levelId,
        newLevel: { name: "Both" },
        expectedGrantRevision: 1,
      }).success,
    ).toBe(false);
  });
});
