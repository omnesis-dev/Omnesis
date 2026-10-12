// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { knowledgeMaintenanceTask } from "./tasks.js";
import type { KnowledgeEngine } from "./engine.js";
import type { Scheduler } from "../../scheduler/scheduler.js";

beforeEach(() => {
  for (const key of ["INTERVAL", "IDLE", "START_DELAY"])
    vi.stubEnv(`OMNESIS_COGNITION_WAKER_${key}_MS`, undefined);
});
afterEach(() => vi.unstubAllEnvs());

function task(overrides: { intervalMs?: number; idleMs?: number; startDelayMs?: number } = {}) {
  return knowledgeMaintenanceTask({
    // Cadence construction does not call these collaborators.
    engine: {} as KnowledgeEngine,
    scheduler: {} as Scheduler,
    isEnabled: () => true,
    ...overrides,
  }).task;
}

test("maintenance keeps its production cadence when no override is configured", () => {
  expect(task()).toMatchObject({ periodMs: 1000, idlePeriodMs: 15000, startDelayMs: 1000 });
});

test("the existing bench cadence environment reaches maintenance as well as legacy ingestion", () => {
  vi.stubEnv("OMNESIS_COGNITION_WAKER_INTERVAL_MS", "100");
  vi.stubEnv("OMNESIS_COGNITION_WAKER_IDLE_MS", "200");
  vi.stubEnv("OMNESIS_COGNITION_WAKER_START_DELAY_MS", "300");
  expect(task()).toMatchObject({ periodMs: 100, idlePeriodMs: 200, startDelayMs: 300 });
  expect(task({ intervalMs: 7, idleMs: 8, startDelayMs: 9 })).toMatchObject({
    periodMs: 7,
    idlePeriodMs: 8,
    startDelayMs: 9,
  });
  // The existing all-cadences interval override still wins over environment.
  expect(task({ intervalMs: 7 })).toMatchObject({ periodMs: 7, idlePeriodMs: 7, startDelayMs: 7 });
});

test("malformed cadence values retain the existing fallback behavior", () => {
  vi.stubEnv("OMNESIS_COGNITION_WAKER_INTERVAL_MS", "100ms");
  vi.stubEnv("OMNESIS_COGNITION_WAKER_IDLE_MS", "-200");
  vi.stubEnv("OMNESIS_COGNITION_WAKER_START_DELAY_MS", "NaN");
  expect(task()).toMatchObject({ periodMs: 1000, idlePeriodMs: 15000, startDelayMs: 1000 });
});
