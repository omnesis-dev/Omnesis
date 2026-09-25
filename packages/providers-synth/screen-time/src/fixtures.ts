// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Screen Time records. Deterministic sessions generated from a
 * fixed app catalog + 14-day window; rolls up to daily aggregates the same
 * way the real provider does. Bundle IDs are common macOS apps — Chrome,
 * iTerm2, Slack, VSCode, Notion, etc.
 */
import {
  sha256Hex,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";

interface AppSpec {
  bundleId: string;
  name: string;
  /** Average hours/day this app gets foregrounded. */
  weight: number;
}

interface Fixture {
  apps: AppSpec[];
  days: string[];
}

let cached: Fixture | null = null;
function loadFixture(): Fixture {
  if (cached) return cached;
  cached = loadSourceFixtureJson<Fixture>(loadActiveUniverse(), "screen-time", "apps.json");
  return cached;
}

/** Tiny deterministic PRNG seeded by the input — gives same numbers each run. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

export interface ScreenTimeSession {
  id: string;
  bundle_id: string;
  app_name: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  date: string;
  day_of_week: number;
}

export interface ScreenTimeDaily {
  id: string;
  bundle_id: string;
  app_name: string;
  date: string;
  total_seconds: number;
  session_count: number;
  longest_session_seconds: number;
}

const SESSION_MIN_SECONDS = 30;
const SESSION_TYPICAL_SECONDS = 25 * 60; // 25 min average focused session

/**
 * Generate a day's foreground sessions for one app. Total time roughly tracks
 * the app's weight (hours/day) but with deterministic jitter so weekends look
 * lighter than weekdays. Sessions are spread across waking hours (07:00-23:00).
 */
function sessionsForAppDay(app: AppSpec, date: string, deviceVariant: string): ScreenTimeSession[] {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const isWeekend = dow === 0 || dow === 6;
  const seed = hash(`${app.bundleId}:${date}`);
  const dayHours = app.weight * (isWeekend ? 0.45 : 1.0) * (0.8 + seed * 0.4);
  const deviceScale = deviceVariant === "" ? 1 : 0.8 + hash(`device:${deviceVariant}`) * 0.4;
  const targetSeconds = Math.round(dayHours * deviceScale * 3600);
  if (targetSeconds < SESSION_MIN_SECONDS) return [];

  const sessions: ScreenTimeSession[] = [];
  let remaining = targetSeconds;
  let cursorSeconds = 7 * 3600; // start at 07:00
  let idx = 0;
  while (remaining > SESSION_MIN_SECONDS && cursorSeconds < 23 * 3600) {
    const jitter = hash(`${app.bundleId}:${date}:${idx}`);
    const target = Math.min(
      remaining,
      Math.max(SESSION_MIN_SECONDS, Math.round(SESSION_TYPICAL_SECONDS * (0.4 + jitter * 1.2))),
    );
    const startSec = cursorSeconds;
    const endSec = startSec + target;
    const startHour = Math.floor(startSec / 3600);
    const startMin = Math.floor((startSec % 3600) / 60);
    const endHour = Math.floor(endSec / 3600);
    const endMin = Math.floor((endSec % 3600) / 60);
    const startTime = `${date}T${pad2(startHour)}:${pad2(startMin)}:00.000Z`;
    const endTime = `${date}T${pad2(endHour)}:${pad2(endMin)}:00.000Z`;
    sessions.push({
      id: sha256Hex(`${app.bundleId}:${startTime}`).slice(0, 32),
      bundle_id: app.bundleId,
      app_name: app.name,
      start_time: startTime,
      end_time: endTime,
      duration_seconds: target,
      date,
      day_of_week: dow,
    });
    // Gap between sessions, plus the session itself.
    const gap = Math.round(8 * 60 + jitter * 25 * 60);
    cursorSeconds = endSec + gap;
    remaining -= target;
    idx += 1;
    if (idx > 12) break; // safety cap on sessions/app/day
  }
  return sessions;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const cachedSessions = new Map<string, ScreenTimeSession[]>();
export function allSessions(deviceVariant = ""): ScreenTimeSession[] {
  const cachedVariant = cachedSessions.get(deviceVariant);
  if (cachedVariant) return cachedVariant;
  const f = loadFixture();
  const out: ScreenTimeSession[] = [];
  for (const day of f.days) {
    for (const app of f.apps) {
      out.push(...sessionsForAppDay(app, day, deviceVariant));
    }
  }
  cachedSessions.set(deviceVariant, out);
  return out;
}

export function allDaily(deviceVariant = ""): ScreenTimeDaily[] {
  const sessions = allSessions(deviceVariant);
  const byKey = new Map<string, ScreenTimeDaily>();
  for (const s of sessions) {
    const key = `${s.bundle_id}:${s.date}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.total_seconds += s.duration_seconds;
      existing.session_count += 1;
      if (s.duration_seconds > existing.longest_session_seconds) {
        existing.longest_session_seconds = s.duration_seconds;
      }
    } else {
      byKey.set(key, {
        id: key,
        bundle_id: s.bundle_id,
        app_name: s.app_name,
        date: s.date,
        total_seconds: s.duration_seconds,
        session_count: 1,
        longest_session_seconds: s.duration_seconds,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.date === b.date ? a.bundle_id.localeCompare(b.bundle_id) : a.date.localeCompare(b.date),
  );
}
