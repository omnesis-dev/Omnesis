// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  activityRecords,
  bodyRecords,
  environmentRecords,
  moodRecords,
  nutritionRecords,
  vitalsRecords,
} from "./fixtures.js";
import {
  ALL_HEALTH_SCHEMAS,
  HEALTH_ACTIVITY,
  HEALTH_BODY,
  HEALTH_ENVIRONMENT,
  HEALTH_MOOD,
  HEALTH_NUTRITION,
  HEALTH_SLEEP,
  HEALTH_VITALS,
  HEALTH_WORKOUTS,
} from "./schemas.js";

describe("synthetic Apple Health schemas", () => {
  it("declares all nine native Apple Health tables", () => {
    expect(ALL_HEALTH_SCHEMAS.map(({ tableName }) => tableName).sort()).toEqual([
      "health_activity",
      "health_body",
      "health_environment",
      "health_mindful",
      "health_mood",
      "health_nutrition",
      "health_sleep",
      "health_vitals",
      "health_workouts",
    ]);
  });

  it("declares the complete vitals metric domain beyond the example query", () => {
    const values = HEALTH_VITALS.columns.find(
      (column) => column.name === "metric_slug",
    )?.allowedValues;

    expect(values).toContain("heart_rate");
    expect(values).toContain("respiratory_rate");
    expect(values).toContain("resting_hr");
    expect(values).toContain("spo2");
  });

  it("publishes closed and extensible source vocabularies", () => {
    const sleep = HEALTH_SLEEP.columns.find(({ name }) => name === "stage");
    expect(sleep?.allowedValues).toContain("asleepDeep");
    expect(sleep?.valueAliases?.asleepDeep).toContain("deep sleep");
    expect(sleep?.categoricalRole).toBe("selector");
    const workouts = HEALTH_WORKOUTS.columns.find(({ name }) => name === "workout_type");
    expect(workouts?.canonicalValues).toContain("running");
    expect(workouts?.valueAliases?.running).toContain("run");
    expect(workouts?.categoricalRole).toBe("selector");
    const mood = HEALTH_MOOD.columns.find(({ name }) => name === "kind");
    expect(mood?.allowedValues).toEqual(["momentaryEmotion", "dailyMood", "unknown"]);
    expect(mood?.categoricalRole).toBe("selector");
  });

  it("publishes exact source-owned aliases for every tall metric", () => {
    for (const schema of [
      HEALTH_BODY,
      HEALTH_ACTIVITY,
      HEALTH_VITALS,
      HEALTH_NUTRITION,
      HEALTH_ENVIRONMENT,
    ]) {
      const metric = schema.columns.find(({ name }) => name === "metric_slug");
      expect(metric?.categoricalRole).toBe("series");
      expect(Object.keys(metric?.valueAliases ?? {}).sort()).toEqual(metric?.allowedValues);
    }
    expect(
      HEALTH_BODY.columns.find(({ name }) => name === "metric_slug")?.valueAliases?.bmi,
    ).toContain("body mass index");
    expect(
      HEALTH_VITALS.columns.find(({ name }) => name === "metric_slug")?.valueAliases?.resting_hr,
    ).toContain("resting heart rate");
    const vitalsAliases = HEALTH_VITALS.columns.find(
      ({ name }) => name === "metric_slug",
    )?.valueAliases;
    expect(vitalsAliases?.hrv).toEqual([
      "heart rate variability",
      "heart rate variability sdnn",
      "hrv",
    ]);
    expect(vitalsAliases?.bp_systolic).toEqual([
      "blood pressure systolic",
      "bp systolic",
      "systolic blood pressure",
    ]);
    expect(
      HEALTH_NUTRITION.columns.find(({ name }) => name === "metric_slug")?.valueAliases?.vitamin_a,
    ).toEqual(["dietary vitamin a", "vitamin a"]);
  });

  it("keeps every generated tall metric inside its source-owned domain", () => {
    for (const { schema, records } of [
      { schema: HEALTH_BODY, records: bodyRecords() },
      { schema: HEALTH_ACTIVITY, records: activityRecords() },
      { schema: HEALTH_VITALS, records: vitalsRecords() },
      { schema: HEALTH_NUTRITION, records: nutritionRecords() },
      { schema: HEALTH_ENVIRONMENT, records: environmentRecords() },
    ]) {
      const values = schema.columns.find(({ name }) => name === "metric_slug")?.allowedValues;
      expect(values).toBeDefined();
      for (const record of records) {
        expect(values, `${schema.tableName}: ${record.metric_slug}`).toContain(record.metric_slug);
      }
    }
  });

  it("keeps synthetic mood records inside the source-owned kind domain", () => {
    const values = HEALTH_MOOD.columns.find(({ name }) => name === "kind")?.allowedValues;
    expect(values).toBeDefined();
    for (const record of moodRecords()) expect(values).toContain(record.kind);
  });
});
