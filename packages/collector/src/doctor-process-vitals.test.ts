// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { CollectorDoctorVitals } from "./doctor-process-vitals.js";

describe("CollectorDoctorVitals", () => {
  let vitals: CollectorDoctorVitals | null = null;

  afterEach(() => {
    vitals?.dispose();
    vitals = null;
    vi.useRealTimers();
  });

  test("reports bounded current process readings", () => {
    vi.useFakeTimers();
    vitals = new CollectorDoctorVitals();
    vitals.start();
    vi.advanceTimersByTime(1_000);

    const snapshot = vitals.snapshot();
    expect(snapshot.eventLoop?.current?.p95Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.memory?.current?.rssBytes).toBeGreaterThan(0);
    expect(snapshot.memory?.current?.heapUsedBytes).toBeGreaterThan(0);
  });

  test("start and dispose are idempotent", () => {
    vi.useFakeTimers();
    vitals = new CollectorDoctorVitals();
    vitals.start();
    vitals.start();
    expect(vi.getTimerCount()).toBe(1);
    vitals.dispose();
    vitals.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
