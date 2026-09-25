// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the synth Health Connect fixture expansion + schema contract.
 *
 * The fixtures and schemas together ARE the wire contract the real Android
 * source must satisfy (the Kotlin `Schemas.kt` mirrors `schemas.ts`), so we
 * lock the invariants the E2E relies on: deterministic primary keys (idempotent
 * re-sync), every record's columns existing in its table schema, and the
 * eight-table catalogue shape.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_HEALTH_CONNECT_SCHEMAS,
  HC_ACTIVITY,
  HC_BODY,
  HC_CYCLE,
  HC_EXERCISE,
  HC_MINDFULNESS,
  HC_NUTRITION,
  HC_SLEEP,
  HC_VITALS,
} from "./schemas.js";
import {
  activityRecords,
  bodyRecords,
  cycleRecords,
  exerciseRecords,
  mindfulnessRecords,
  nutritionRecords,
  sleepRecords,
  vitalsRecords,
} from "./fixtures.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const TABLES: Array<{ schema: AnalyticsTableSchema; load: () => Array<Record<string, unknown>> }> =
  [
    { schema: HC_BODY, load: () => bodyRecords() as unknown as Array<Record<string, unknown>> },
    {
      schema: HC_ACTIVITY,
      load: () => activityRecords() as unknown as Array<Record<string, unknown>>,
    },
    { schema: HC_VITALS, load: () => vitalsRecords() as unknown as Array<Record<string, unknown>> },
    { schema: HC_SLEEP, load: () => sleepRecords() as unknown as Array<Record<string, unknown>> },
    {
      schema: HC_NUTRITION,
      load: () => nutritionRecords() as unknown as Array<Record<string, unknown>>,
    },
    {
      schema: HC_MINDFULNESS,
      load: () => mindfulnessRecords() as unknown as Array<Record<string, unknown>>,
    },
    {
      schema: HC_EXERCISE,
      load: () => exerciseRecords() as unknown as Array<Record<string, unknown>>,
    },
    {
      schema: HC_CYCLE,
      load: () => cycleRecords() as unknown as Array<Record<string, unknown>>,
    },
  ];

describe("health-connect schemas", () => {
  it("declares all eight hc_* tables, each with primary key [id]", () => {
    expect(ALL_HEALTH_CONNECT_SCHEMAS.map((s) => s.tableName).sort()).toEqual([
      "hc_activity",
      "hc_body",
      "hc_cycle",
      "hc_exercise",
      "hc_mindfulness",
      "hc_nutrition",
      "hc_sleep",
      "hc_vitals",
    ]);
    for (const s of ALL_HEALTH_CONNECT_SCHEMAS) {
      expect(s.primaryKey, `${s.tableName} primary key`).toEqual(["id"]);
      expect(s.columns.length, `${s.tableName} columns`).toBeGreaterThan(0);
    }
  });

  it("round-trips through JSON (wire-serializable to /analytics/ingest)", () => {
    for (const s of ALL_HEALTH_CONNECT_SCHEMAS) {
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it("declares the complete vitals metric domain beyond the example query", () => {
    const values = HC_VITALS.columns.find((column) => column.name === "metric_slug")?.allowedValues;
    expect(values).toContain("heart_rate");
    expect(values).toContain("respiratory_rate");
    expect(values).toContain("blood_pressure_systolic");
    expect(values).toContain("skin_temperature_delta");
  });

  it("publishes closed and extensible source vocabularies", () => {
    const sleep = HC_SLEEP.columns.find(({ name }) => name === "stage");
    expect(sleep?.allowedValues).toContain("deep");
    expect(sleep?.valueAliases?.deep).toContain("deep sleep");
    expect(sleep?.categoricalRole).toBe("selector");
    const exercise = HC_EXERCISE.columns.find(({ name }) => name === "exercise_type");
    expect(exercise?.canonicalValues).toContain("running");
    expect(exercise?.canonicalValues).toContain("badminton");
    expect(exercise?.valueAliases?.running).toContain("run");
    expect(exercise?.categoricalRole).toBe("selector");
  });

  it("publishes exact source-owned aliases for every tall metric", () => {
    for (const schema of [HC_BODY, HC_ACTIVITY, HC_VITALS, HC_NUTRITION]) {
      const metric = schema.columns.find(({ name }) => name === "metric_slug");
      expect(metric?.categoricalRole).toBe("series");
      expect(Object.keys(metric?.valueAliases ?? {}).sort()).toEqual(metric?.allowedValues);
    }
    expect(
      HC_VITALS.columns.find(({ name }) => name === "metric_slug")?.valueAliases?.hrv,
    ).toContain("heart rate variability");
    expect(HC_VITALS.columns.find(({ name }) => name === "metric_slug")?.valueAliases?.hrv).toEqual(
      ["heart rate variability", "heart rate variability rmssd", "hrv"],
    );
    expect(
      HC_ACTIVITY.columns.find(({ name }) => name === "metric_slug")?.valueAliases?.active_calories,
    ).toEqual(["active calories", "active calories burned"]);
    const cycle = HC_CYCLE.columns.find(({ name }) => name === "metric_slug");
    expect(cycle?.allowedValues).toEqual([
      "cervical_mucus",
      "intermenstrual_bleeding",
      "menstruation_flow",
      "menstruation_period",
      "ovulation_test",
      "sexual_activity",
    ]);
    expect(cycle?.valueAliases?.ovulation_test).toEqual(["ovulation test"]);
    expect(cycle?.categoricalRole).toBe("series");
    const cycleText = HC_CYCLE.columns.find(({ name }) => name === "text_value");
    expect(cycleText?.categoricalRole).toBe("selector");
    expect(cycleText?.allowedValues).toContain("negative");
    expect(cycleText?.allowedValues).toContain("egg_white / heavy");
  });
});

describe("health-connect fixtures", () => {
  it("every record's keys are declared columns of its table schema", () => {
    for (const { schema, load } of TABLES) {
      const columns = new Set(schema.columns.map((c) => c.name));
      for (const record of load()) {
        for (const key of Object.keys(record)) {
          expect(columns.has(key), `${schema.tableName}: unexpected column '${key}'`).toBe(true);
        }
        expect(record.id, `${schema.tableName}: record must carry the primary key`).toBeTruthy();
      }
    }
  });

  it("keeps every generated tall metric inside its source-owned domain", () => {
    for (const { schema, load } of TABLES) {
      const values = schema.columns.find(({ name }) => name === "metric_slug")?.allowedValues;
      if (!values) continue;
      for (const record of load()) {
        expect(values, `${schema.tableName}: ${String(record.metric_slug)}`).toContain(
          record.metric_slug,
        );
      }
    }
  });

  it("produces at least one record per table", () => {
    for (const { schema, load } of TABLES) {
      expect(load().length, `${schema.tableName} fixture is empty`).toBeGreaterThan(0);
    }
  });

  it("ids are deterministic and unique within a table (idempotent re-sync contract)", () => {
    for (const { schema, load } of TABLES) {
      const first = load().map((r) => r.id as string);
      const second = load().map((r) => r.id as string);
      expect(second, `${schema.tableName}: ids must be stable across expansions`).toEqual(first);
      expect(new Set(first).size, `${schema.tableName}: duplicate ids`).toBe(first.length);
    }
  });

  it("sleep stages carry their parent session id and ordered intervals", () => {
    const stages = sleepRecords();
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect(stage.session_id).toBeTruthy();
      expect(new Date(stage.end_time).getTime()).toBeGreaterThan(
        new Date(stage.start_time).getTime(),
      );
    }
    const sessions = new Set(stages.map((s) => s.session_id));
    expect(sessions.size).toBeGreaterThanOrEqual(2);
  });

  it("sessions derive duration_seconds from their interval", () => {
    for (const rec of [...mindfulnessRecords(), ...exerciseRecords()]) {
      const ms = new Date(rec.end_time).getTime() - new Date(rec.start_time).getTime();
      expect(rec.duration_seconds).toBe(Math.round(ms / 1000));
    }
  });
});
