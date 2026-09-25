// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Apple Health records. The fixture is a compact JSON template;
 * the loader expands it into per-table record arrays matching the iOS
 * sample shape (UUID id, account_id, metric, value, start_time, etc.).
 *
 * Static fixture only — no live HealthKit access, no live `analytics.db`
 * scrape. Numbers are plausible for a fit ~30s adult running ~70km/week.
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

interface MindfulSession {
  dateOf: string;
  startHour: number;
  durationMin: number;
}

interface Workout {
  type: string;
  dateOf: string;
  startHour: number;
  durationMin: number;
  distanceM: number | null;
  energyKcal: number;
}

interface HealthFixture {
  accountId: string;
  device: string;
  sourceApp: string;
  body: MetricSpec[];
  activity: MetricSpec[];
  vitals: MetricSpec[];
  nutrition: MetricSpec[];
  environment: MetricSpec[];
  sleep: SleepNight[];
  mindful: MindfulSession[];
  workouts: Workout[];
}

let cached: HealthFixture | null = null;
function loadFixture(): HealthFixture {
  if (cached) return cached;
  cached = loadSourceFixtureJson<HealthFixture>(
    loadActiveUniverse(),
    "apple-health",
    "health.json",
  );
  return cached;
}

/** Deterministic id from inputs — replaces HealthKit's per-sample UUID. */
function deterministicId(parts: string | number[] | (string | number)[]): string {
  return sha256Hex(Array.isArray(parts) ? parts.join(":") : String(parts)).slice(0, 32);
}

/** Build an ISO timestamp from a day-anchor (`YYYY-MM-DD`) + hour-of-day. */
function isoAt(dateStr: string, hour: number, minute = 0): string {
  return `${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

/** 14-day window ending today-ish so the data feels current relative to the cast. */
const DAY_ANCHOR = "2025-09-01";
function dayOffset(i: number): string {
  const base = new Date(`${DAY_ANCHOR}T00:00:00.000Z`).getTime();
  const d = new Date(base + i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

interface RowPerSample {
  id: string;
  account_id: string;
  metric: string;
  metric_slug: string;
  value: number | null;
  unit: string | null;
  start_time: string;
  end_time: string;
  source_app: string | null;
  source_device: string | null;
  metadata: unknown;
}

function rowPerSampleRecords(
  category: keyof Pick<HealthFixture, "body" | "activity" | "vitals" | "nutrition" | "environment">,
): RowPerSample[] {
  const f = loadFixture();
  const out: RowPerSample[] = [];
  // Daily-resolution metrics map one value per day starting at DAY_ANCHOR.
  // Multi-sample-per-day metrics (heart_rate has 4 per day) interleave at
  // realistic hours.
  for (const spec of f[category]) {
    const samplesPerDay =
      spec.slug === "heart_rate" ? 4 : spec.slug === "headphone_audio_db" ? 1 : 1;
    spec.values.forEach((v, i) => {
      const dayIdx = Math.floor(i / samplesPerDay);
      const subIdx = i % samplesPerDay;
      const day = dayOffset(dayIdx);
      // Hour spread: morning + workout + evening + night for HR; otherwise 09:00.
      const hour = spec.slug === "heart_rate" ? ([7, 12, 18, 22][subIdx] ?? 9) : 9;
      const start = isoAt(day, hour);
      out.push({
        id: deterministicId([spec.metric, day, subIdx]),
        account_id: f.accountId,
        metric: spec.metric,
        metric_slug: spec.slug,
        value: v,
        unit: spec.unit,
        start_time: start,
        end_time: start,
        source_app: f.sourceApp,
        source_device: f.device,
        metadata: null,
      });
    });
  }
  return out;
}

export function bodyRecords(): RowPerSample[] {
  return rowPerSampleRecords("body");
}
export function activityRecords(): RowPerSample[] {
  return rowPerSampleRecords("activity");
}
export function vitalsRecords(): RowPerSample[] {
  return rowPerSampleRecords("vitals");
}
export function nutritionRecords(): RowPerSample[] {
  return rowPerSampleRecords("nutrition");
}
export function environmentRecords(): RowPerSample[] {
  return rowPerSampleRecords("environment");
}

export interface SleepRecord {
  id: string;
  account_id: string;
  stage: string;
  start_time: string;
  end_time: string;
  source_app: string | null;
  source_device: string | null;
  metadata: unknown;
}

export function sleepRecords(): SleepRecord[] {
  const f = loadFixture();
  const out: SleepRecord[] = [];
  for (const night of f.sleep) {
    // Sleep starts at 22:30 local on `nightOf` and stages run forward in minutes.
    const baseMs = new Date(`${night.nightOf}T22:30:00.000Z`).getTime();
    night.stages.forEach((stage, idx) => {
      const [name, startMin, durMin] = stage as [string, number, number];
      const startMs = baseMs + startMin * 60_000;
      const endMs = startMs + durMin * 60_000;
      out.push({
        id: deterministicId([night.nightOf, idx, name]),
        account_id: f.accountId,
        stage: name,
        start_time: new Date(startMs).toISOString(),
        end_time: new Date(endMs).toISOString(),
        source_app: f.sourceApp,
        source_device: f.device,
        metadata: null,
      });
    });
  }
  return out;
}

export interface MindfulRecord {
  id: string;
  account_id: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  source_app: string | null;
  source_device: string | null;
  metadata: unknown;
}

export function mindfulRecords(): MindfulRecord[] {
  const f = loadFixture();
  return f.mindful.map((m) => {
    const start = isoAt(m.dateOf, m.startHour);
    const end = new Date(new Date(start).getTime() + m.durationMin * 60_000).toISOString();
    return {
      id: deterministicId([m.dateOf, m.startHour, m.durationMin]),
      account_id: f.accountId,
      start_time: start,
      end_time: end,
      duration_seconds: m.durationMin * 60,
      source_app: f.sourceApp,
      source_device: f.device,
      metadata: null,
    };
  });
}

export interface WorkoutRecord {
  id: string;
  account_id: string;
  workout_type: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  total_distance_m: number | null;
  total_energy_kcal: number | null;
  source_app: string | null;
  source_device: string | null;
  metadata: unknown;
}

export function workoutRecords(): WorkoutRecord[] {
  const f = loadFixture();
  return f.workouts.map((w) => {
    const start = isoAt(w.dateOf, w.startHour);
    const end = new Date(new Date(start).getTime() + w.durationMin * 60_000).toISOString();
    return {
      id: deterministicId([w.dateOf, w.type, w.startHour]),
      account_id: f.accountId,
      workout_type: w.type,
      start_time: start,
      end_time: end,
      duration_seconds: w.durationMin * 60,
      total_distance_m: w.distanceM,
      total_energy_kcal: w.energyKcal,
      source_app: f.sourceApp,
      source_device: f.device,
      metadata: null,
    };
  });
}

export interface MoodRecord {
  id: string;
  account_id: string;
  kind: string;
  valence: number;
  labels: string[];
  associations: string[];
  start_time: string;
  end_time: string;
  source_app: string | null;
}

export function moodRecords(): MoodRecord[] {
  const fixture = loadFixture();
  return [
    {
      kind: "momentaryEmotion",
      valence: 0.4,
      labels: ["calm"],
      associations: ["community"],
      date: "2025-09-07",
      hour: 18,
    },
    {
      kind: "dailyMood",
      valence: 0.2,
      labels: ["content"],
      associations: ["hobbies"],
      date: "2025-09-10",
      hour: 20,
    },
  ].map(({ kind, valence, labels, associations, date, hour }) => {
    const time = isoAt(date, hour);
    return {
      id: deterministicId([kind, date, hour]),
      account_id: fixture.accountId,
      kind,
      valence,
      labels,
      associations,
      start_time: time,
      end_time: time,
      source_app: fixture.sourceApp,
    };
  });
}

export function selfAccountId(): string {
  return loadFixture().accountId;
}
