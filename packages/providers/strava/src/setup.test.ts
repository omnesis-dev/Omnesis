// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import definition from "./index.js";

describe("Strava provider definition", () => {
  test("has correct provider metadata", () => {
    expect(definition.type).toBe("provider");
    expect(definition.provider.id).toBe("strava");
    expect(definition.authType).toBe("oauth");
  });

  test("has strava-activities source", () => {
    expect(definition.sources).toHaveLength(1);
    const source = definition.sources[0]!;
    expect(source.id).toBe("strava-activities");
    expect(source.unitName).toBe("activities");
  });

  test("strava-activities exposes analytics schemas including the parent + child tables", () => {
    const source = definition.sources[0]!;
    expect(source.analyticsSchemas).toBeDefined();
    const tableNames = source.analyticsSchemas!.map((s) => s.tableName);
    // Parent table for activities, plus per-tier child tables and athlete-level tables.
    expect(tableNames).toContain("strava_activities");
    expect(tableNames).toContain("strava_activity_splits");
    expect(tableNames).toContain("strava_activity_best_efforts");
    expect(tableNames).toContain("strava_activity_laps");
    expect(tableNames).toContain("strava_activity_segment_efforts");
    expect(tableNames).toContain("strava_activity_zones");
    expect(tableNames).toContain("strava_activity_comments");
    expect(tableNames).toContain("strava_activity_kudos");
    expect(tableNames).toContain("strava_activity_streams");
    expect(tableNames).toContain("strava_athlete");
    expect(tableNames).toContain("strava_athlete_zones");
    expect(tableNames).toContain("strava_athlete_stats");
    expect(tableNames).toContain("strava_gear");
    const activities = source.analyticsSchemas!.find((s) => s.tableName === "strava_activities")!;
    expect(activities.primaryKey).toEqual(["id"]);
  });

  test("strava-activities has a URL pattern for link resolution", () => {
    const source = definition.sources[0]!;
    expect(source.urlPatterns).toBeDefined();
    const pattern = source.urlPatterns![0]!;
    const match = "https://www.strava.com/activities/12345".match(new RegExp(pattern.regex));
    expect(match).not.toBeNull();
    expect(match![1]).toBe("12345");
  });

  test("has authFlow, discover, cleanupCredentials, createContext, isAuthenticated", () => {
    expect(typeof definition.authFlow).toBe("function");
    expect(typeof definition.discover).toBe("function");
    expect(typeof definition.cleanupCredentials).toBe("function");
    expect(typeof definition.createContext).toBe("function");
    expect(typeof definition.credentialState).toBe("function");
  });

  test("discover lists the athletes whose tokens are stored under the config directory", async () => {
    // A directory of its own: without one, discovery reads the operator's
    // real config directory.
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-strava-discover-"));
    try {
      mkdirSync(join(configDir, "strava", "4242"), { recursive: true });
      writeFileSync(join(configDir, "strava", "4242", "tokens.json"), "{}");
      // A directory without a grant is not an account.
      mkdirSync(join(configDir, "strava", "5151"), { recursive: true });
      expect(await definition.discover!({ configDir })).toEqual(["4242"]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
