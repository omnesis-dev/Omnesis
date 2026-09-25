// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Health Connect records. The fixture is a compact JSON template
 * (`health.json`); the loader expands it into per-table record arrays matching
 * the Health Connect-native column shapes in `schemas.ts`.
 *
 * Static fixture only — no live Health Connect access. All values are invented
 * (a fit ~30s adult), and `data_origin` is a fictional package id per the
 * corpus-privacy rule (never a real app the user actually has installed).
 */
import {
  sha256Hex,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";

interface MetricSpec {
  metric: string;
  slug: string;
  unit: string;
  values: number[];
}

interface SleepStageTuple extends Array<unknown> {
  0: string;
  1: number;
  2: number;
}

interface SleepNight {
  nightOf: string;
  stages: SleepStageTuple[];
}

interface MindfulnessSession {
  dateOf: string;
  startHour: number;
  durationMin: number;
  sessionType: string;
  title: string | null;
}

interface ExerciseSession {
  exerciseType: string;
  dateOf: string;
  startHour: number;
  durationMin: number;
  title: string | null;
  notes: string | null;
}

interface HealthConnectFixture {
  accountId: string;
  dataOrigin: string;
  deviceType: string;
  recordingMethod: string;
  body: MetricSpec[];
  activity: MetricSpec[];
  vitals: MetricSpec[];
  nutrition: MetricSpec[];
  sleep: SleepNight[];
  mindfulness: MindfulnessSession[];
  exercise: ExerciseSession[];
}

let cached: HealthConnectFixture | null = null;
function loadFixture(): HealthConnectFixture {
  if (cached) return cached;
  cached = loadSourceFixtureJson<HealthConnectFixture>(
    loadActiveUniverse(),
    "health-connect",
    "health.json",
  );
  return cached;
}

/**
 * Deterministic id — replaces the Health Connect per-record UUID so re-sync is
 * idempotent. Note the synthetic id SHAPE diverges from the real normalizer
 * (which suffixes fanned-out rows as `<recordId>:<idx>`): here every sample is
 * its own record with id == record_id. Column shapes are identical, so ingest
 * parity holds; only GROUP BY record_id cardinality differs from real data.
 */
function deterministicId(parts: (string | number)[]): string {
  return sha256Hex(parts.join(":")).slice(0, 32);
}

function isoAt(dateStr: string, hour: number, minute = 0): string {
  return `${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

const DAY_ANCHOR = "2025-09-01";
function dayOffset(i: number): string {
  const base = new Date(`${DAY_ANCHOR}T00:00:00.000Z`).getTime();
  return new Date(base + i * 86_400_000).toISOString().slice(0, 10);
}

interface HcSample {
  id: string;
  record_id: string;
  client_record_id: string | null;
  account_id: string;
  metric: string;
  metric_slug: string;
  value: number | null;
  unit: string | null;
  start_time: string;
  end_time: string;
  data_origin: string | null;
  recording_method: string | null;
  device_type: string | null;
  last_modified_time: string | null;
  metadata: unknown;
}

function tallRecords(
  category: keyof Pick<HealthConnectFixture, "body" | "activity" | "vitals" | "nutrition">,
): HcSample[] {
  const f = loadFixture();
  const out: HcSample[] = [];
  for (const spec of f[category]) {
    const samplesPerDay = spec.slug === "heart_rate" ? 4 : 1;
    spec.values.forEach((v, i) => {
      const dayIdx = Math.floor(i / samplesPerDay);
      const subIdx = i % samplesPerDay;
      const day = dayOffset(dayIdx);
      const hour = spec.slug === "heart_rate" ? ([7, 12, 18, 22][subIdx] ?? 9) : 9;
      const start = isoAt(day, hour);
      const recordId = deterministicId([spec.metric, day, subIdx]);
      out.push({
        id: recordId,
        record_id: recordId,
        client_record_id: null,
        account_id: f.accountId,
        metric: spec.metric,
        metric_slug: spec.slug,
        value: v,
        unit: spec.unit,
        start_time: start,
        end_time: start,
        data_origin: f.dataOrigin,
        recording_method: f.recordingMethod,
        device_type: f.deviceType,
        last_modified_time: start,
        metadata: null,
      });
    });
  }
  return out;
}

export function bodyRecords(): HcSample[] {
  return tallRecords("body");
}
export function activityRecords(): HcSample[] {
  return tallRecords("activity");
}
export function vitalsRecords(): HcSample[] {
  return tallRecords("vitals");
}
export function nutritionRecords(): HcSample[] {
  return tallRecords("nutrition");
}

export interface HcSleepRecord {
  id: string;
  account_id: string;
  session_id: string;
  stage: string;
  start_time: string;
  end_time: string;
  data_origin: string | null;
  recording_method: string | null;
  device_type: string | null;
  metadata: unknown;
}

export function sleepRecords(): HcSleepRecord[] {
  const f = loadFixture();
  const out: HcSleepRecord[] = [];
  for (const night of f.sleep) {
    const sessionId = deterministicId(["sleep", night.nightOf]);
    const baseMs = new Date(`${night.nightOf}T22:30:00.000Z`).getTime();
    night.stages.forEach((stage, idx) => {
      const [name, startMin, durMin] = stage as [string, number, number];
      const startMs = baseMs + startMin * 60_000;
      const endMs = startMs + durMin * 60_000;
      out.push({
        id: deterministicId([sessionId, idx, name]),
        account_id: f.accountId,
        session_id: sessionId,
        stage: name,
        start_time: new Date(startMs).toISOString(),
        end_time: new Date(endMs).toISOString(),
        data_origin: f.dataOrigin,
        recording_method: f.recordingMethod,
        device_type: f.deviceType,
        metadata: null,
      });
    });
  }
  return out;
}

export interface HcMindfulnessRecord {
  id: string;
  account_id: string;
  session_type: string;
  title: string | null;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  data_origin: string | null;
  recording_method: string | null;
  device_type: string | null;
  metadata: unknown;
}

export function mindfulnessRecords(): HcMindfulnessRecord[] {
  const f = loadFixture();
  return f.mindfulness.map((m) => {
    const start = isoAt(m.dateOf, m.startHour);
    const end = new Date(new Date(start).getTime() + m.durationMin * 60_000).toISOString();
    return {
      id: deterministicId([m.dateOf, m.startHour, m.durationMin, m.sessionType]),
      account_id: f.accountId,
      session_type: m.sessionType,
      title: m.title,
      start_time: start,
      end_time: end,
      duration_seconds: m.durationMin * 60,
      data_origin: f.dataOrigin,
      recording_method: f.recordingMethod,
      device_type: f.deviceType,
      metadata: null,
    };
  });
}

export interface HcExerciseRecord {
  id: string;
  account_id: string;
  exercise_type: string;
  title: string | null;
  notes: string | null;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  data_origin: string | null;
  recording_method: string | null;
  device_type: string | null;
  metadata: unknown;
}

export function exerciseRecords(): HcExerciseRecord[] {
  const f = loadFixture();
  return f.exercise.map((w) => {
    const start = isoAt(w.dateOf, w.startHour);
    const end = new Date(new Date(start).getTime() + w.durationMin * 60_000).toISOString();
    return {
      id: deterministicId([w.dateOf, w.exerciseType, w.startHour]),
      account_id: f.accountId,
      exercise_type: w.exerciseType,
      title: w.title,
      notes: w.notes,
      start_time: start,
      end_time: end,
      duration_seconds: w.durationMin * 60,
      data_origin: f.dataOrigin,
      recording_method: f.recordingMethod,
      device_type: f.deviceType,
      metadata: null,
    };
  });
}

export interface HcCycleRecord {
  id: string;
  record_id: string;
  account_id: string;
  metric: string;
  metric_slug: string;
  text_value: string | null;
  value: number | null;
  start_time: string;
  end_time: string;
  data_origin: string | null;
  recording_method: string | null;
  device_type: string | null;
  metadata: unknown;
}

export function cycleRecords(): HcCycleRecord[] {
  const fixture = loadFixture();
  return [
    {
      metric: "OvulationTest",
      metric_slug: "ovulation_test",
      text_value: "negative",
      date: "2025-09-08",
    },
    {
      metric: "MenstruationPeriod",
      metric_slug: "menstruation_period",
      text_value: "period",
      date: "2025-09-12",
    },
  ].map(({ metric, metric_slug, text_value, date }) => {
    const recordId = deterministicId([metric_slug, date]);
    const time = isoAt(date, 9);
    return {
      id: recordId,
      record_id: recordId,
      account_id: fixture.accountId,
      metric,
      metric_slug,
      text_value,
      value: null,
      start_time: time,
      end_time: time,
      data_origin: fixture.dataOrigin,
      recording_method: fixture.recordingMethod,
      device_type: fixture.deviceType,
      metadata: null,
    };
  });
}

export function selfAccountId(): string {
  return loadFixture().accountId;
}
