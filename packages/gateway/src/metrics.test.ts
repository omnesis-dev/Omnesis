// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach, vi } from "vitest";
import { MetricsRegistry, callerKindFromDeviceKind } from "./metrics.js";
import { callerKindToPriority } from "./priority.js";
import { retryOnBusy, setBusyRetryRecorder } from "./data/retry.js";

describe("MetricsRegistry", () => {
  test("buckets per (route, callerKind), returns p50/p95/p99 within window", () => {
    const m = new MetricsRegistry();
    const now = Date.now();

    // 100 samples for /status from cli, totalMs ranging 1..100
    for (let i = 1; i <= 100; i++) {
      m.recordRequest("/status", "cli", {
        ts: now,
        totalMs: i,
        writerQueueMs: 0,
        writerExecMs: 0,
        writerCalls: 0,
        status: 200,
      });
    }
    // 100 samples for /status from collector with bigger writer numbers
    for (let i = 1; i <= 100; i++) {
      m.recordRequest("/status", "collector", {
        ts: now,
        totalMs: i * 2,
        writerQueueMs: i,
        writerExecMs: i,
        writerCalls: 1,
        status: 200,
      });
    }

    const snap = m.snapshot(60);
    expect(snap.routes.length).toBe(2);
    const cli = snap.routes.find((r) => r.callerKind === "cli")!;
    const coll = snap.routes.find((r) => r.callerKind === "collector")!;
    expect(cli.count).toBe(100);
    expect(coll.count).toBe(100);
    // Percentile formula: sorted[floor(p*N)] — for N=100 samples
    // [1..100], p50=sorted[50]=51, p95=sorted[95]=96, p99=sorted[99]=100.
    expect(cli.totalP50).toBe(51);
    expect(cli.totalP95).toBe(96);
    expect(cli.totalP99).toBe(100);
    expect(coll.totalP50).toBe(102); // 51 * 2
    expect(coll.writerQueueP50).toBe(51);
    expect(coll.meanWriterCalls).toBe(1);
    // Routes sorted by totalP95 desc — collector wins (192 > 96).
    expect(snap.routes[0].callerKind).toBe("collector");
  });

  test("filters by window — old samples drop out", () => {
    const m = new MetricsRegistry();
    const now = Date.now();
    // One ancient sample, one recent.
    m.recordRequest("/x", "cli", {
      ts: now - 10 * 60 * 1000,
      totalMs: 999,
      writerQueueMs: 0,
      writerExecMs: 0,
      writerCalls: 0,
      status: 200,
    });
    m.recordRequest("/x", "cli", {
      ts: now,
      totalMs: 50,
      writerQueueMs: 0,
      writerExecMs: 0,
      writerCalls: 0,
      status: 200,
    });

    const recent = m.snapshot(60); // 1 min — drops the ancient one
    expect(recent.routes[0].count).toBe(1);
    expect(recent.routes[0].totalP50).toBe(50);

    const all = m.snapshot(3600); // 1 h — sees both
    expect(all.routes[0].count).toBe(2);
  });

  test("error count picks up 5xx responses", () => {
    const m = new MetricsRegistry();
    m.recordRequest("/y", "portal", {
      ts: Date.now(),
      totalMs: 10,
      writerQueueMs: 0,
      writerExecMs: 0,
      writerCalls: 0,
      status: 500,
    });
    m.recordRequest("/y", "portal", {
      ts: Date.now(),
      totalMs: 10,
      writerQueueMs: 0,
      writerExecMs: 0,
      writerCalls: 0,
      status: 200,
    });
    const snap = m.snapshot(60);
    expect(snap.routes[0].errorCount).toBe(1);
  });

  test("writer-queue depth gauge tracks current/peak/mean", () => {
    const m = new MetricsRegistry();
    m.recordWriterQueueDepth(0);
    m.recordWriterQueueDepth(5);
    m.recordWriterQueueDepth(10);
    m.recordWriterQueueDepth(3);
    const snap = m.snapshot(60);
    expect(snap.writerQueue.currentDepth).toBe(3);
    expect(snap.writerQueue.peakDepth).toBe(10);
    expect(snap.writerQueue.meanDepth).toBeCloseTo((0 + 5 + 10 + 3) / 4);
    expect(snap.writerQueue.samples.length).toBe(4);
  });

  test("writer-queue samples stay ascending by ts after the ring wraps", () => {
    const m = new MetricsRegistry();
    const t0 = 1_700_000_000_000;
    try {
      vi.useFakeTimers();
      // QUEUE_DEPTH_SAMPLES is 600. Push past a full wrap so physical
      // slot 0 is no longer the oldest retained sample; each push lands
      // at a distinct, increasing wall-clock so chronological order is
      // unambiguous.
      for (let i = 0; i < 700; i++) {
        vi.setSystemTime(t0 + i * 1000);
        m.recordWriterQueueDepth(i % 13);
      }
      const snap = m.snapshot(3600);
      // Only the most recent 600 are retained (ring capacity).
      expect(snap.writerQueue.samples.length).toBe(600);
      const samples = snap.writerQueue.samples;
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i].ts).toBeGreaterThanOrEqual(samples[i - 1].ts);
      }
      // Oldest retained sample is the 101st push (700 - 600 = 100).
      expect(samples[0].ts).toBe(t0 + 100 * 1000);
      expect(samples[samples.length - 1].ts).toBe(t0 + 699 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("callerKindFromDeviceKind maps known kinds, falls back to unknown", () => {
    expect(callerKindFromDeviceKind("cli")).toBe("cli");
    expect(callerKindFromDeviceKind("portal")).toBe("portal");
    expect(callerKindFromDeviceKind("ios")).toBe("ios");
    expect(callerKindFromDeviceKind("collector")).toBe("collector");
    expect(callerKindFromDeviceKind(null)).toBe("unknown");
    expect(callerKindFromDeviceKind(undefined)).toBe("unknown");
    expect(callerKindFromDeviceKind("nonsense")).toBe("unknown");
  });

  // The browser extension pushes captured pages the way a phone pushes its
  // health rows, so it takes the same tier as every other push contributor
  // rather than falling through to the collector's realtime lane.
  test("the browser extension's device kind lands on the user tier", () => {
    expect(callerKindFromDeviceKind("browser")).toBe("browser");
    expect(callerKindToPriority(callerKindFromDeviceKind("browser"))).toBe("user");
  });

  test("recordBusyRetry tracks total + per-op", () => {
    const m = new MetricsRegistry();
    m.recordBusyRetry("setSyncState");
    m.recordBusyRetry("setSyncState");
    m.recordBusyRetry("setSyncError");
    m.recordBusyRetry(); // unlabelled — counts toward total only
    const snap = m.snapshot(60);
    expect(snap.busyRetries.total).toBe(4);
    expect(snap.busyRetries.byOp.setSyncState).toBe(2);
    expect(snap.busyRetries.byOp.setSyncError).toBe(1);
    expect(Object.keys(snap.busyRetries.byOp).length).toBe(2);
  });

  test("recordAnalyticsWrite captures wait + duration percentiles", () => {
    const m = new MetricsRegistry();
    // 100 samples: waits 1..100ms, durations 2..200ms.
    for (let i = 1; i <= 100; i++) m.recordAnalyticsWrite(i, i * 2);
    const snap = m.snapshot(60);
    expect(snap.analyticsWrites.count).toBe(100);
    // Same percentile formula as request bucket: sorted[floor(p*N)]
    // for N=100 → p50=index 50, p95=index 95, p99=index 99.
    expect(snap.analyticsWrites.waitP50).toBe(51);
    expect(snap.analyticsWrites.waitP95).toBe(96);
    expect(snap.analyticsWrites.waitP99).toBe(100);
    expect(snap.analyticsWrites.durationP50).toBe(102);
    expect(snap.analyticsWrites.durationP95).toBe(192);
    expect(snap.analyticsWrites.durationP99).toBe(200);
  });

  test("clear() resets busyRetries + analyticsWrites state", () => {
    const m = new MetricsRegistry();
    m.recordBusyRetry("op-a");
    m.recordAnalyticsWrite(50, 100);
    let snap = m.snapshot(60);
    expect(snap.busyRetries.total).toBe(1);
    expect(snap.analyticsWrites.count).toBe(1);
    m.clear();
    snap = m.snapshot(60);
    expect(snap.busyRetries.total).toBe(0);
    expect(snap.busyRetries.byOp).toEqual({});
    expect(snap.analyticsWrites.count).toBe(0);
    // percentiles collapse to 0 on the empty slice.
    expect(snap.analyticsWrites.waitP50).toBe(0);
    expect(snap.analyticsWrites.durationP99).toBe(0);
  });
});

describe("setBusyRetryRecorder + retryOnBusy", () => {
  // Restore the global recorder slot between tests so a leaked hook
  // can't poison a sibling suite.
  afterEach(() => setBusyRetryRecorder(null));

  function busyError(): Error & { code: string } {
    const e = new Error("database is locked") as Error & { code: string };
    e.code = "SQLITE_BUSY";
    return e;
  }

  test("recorder fires once per retry, with the op label", () => {
    const m = new MetricsRegistry();
    setBusyRetryRecorder((op) => m.recordBusyRetry(op));

    let calls = 0;
    const out = retryOnBusy(
      () => {
        calls += 1;
        if (calls < 3) throw busyError();
        return "ok";
      },
      { initialBackoffMs: 1, op: "test-op" },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);

    const snap = m.snapshot(60);
    // Two retries (calls 1 and 2 raised; call 3 succeeded).
    expect(snap.busyRetries.total).toBe(2);
    expect(snap.busyRetries.byOp["test-op"]).toBe(2);
  });

  test("recorder doesn't fire when fn succeeds first try", () => {
    const m = new MetricsRegistry();
    setBusyRetryRecorder((op) => m.recordBusyRetry(op));
    const out = retryOnBusy(() => "ok", { op: "happy-path" });
    expect(out).toBe("ok");
    expect(m.snapshot(60).busyRetries.total).toBe(0);
  });

  test("recorder unset → retryOnBusy still works (no-op hook)", () => {
    setBusyRetryRecorder(null);
    let calls = 0;
    const out = retryOnBusy(
      () => {
        calls += 1;
        if (calls < 2) throw busyError();
        return "ok";
      },
      { initialBackoffMs: 1, op: "no-recorder" },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  test("non-BUSY errors don't trigger the recorder and propagate immediately", () => {
    const m = new MetricsRegistry();
    setBusyRetryRecorder((op) => m.recordBusyRetry(op));
    expect(() =>
      retryOnBusy(
        () => {
          const e = new Error("bad sql") as Error & { code: string };
          e.code = "SQLITE_ERROR";
          throw e;
        },
        { op: "non-busy" },
      ),
    ).toThrow("bad sql");
    expect(m.snapshot(60).busyRetries.total).toBe(0);
  });
});
