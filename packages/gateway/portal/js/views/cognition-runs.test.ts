// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-logic coverage for the Cognition view's run-queue presentation:
 * the pending→(running|retrying|scheduled|queued) fan-out, the per-state
 * lead timestamp, the brief filter buckets, the legacy-subtab alias, and
 * the two-unit relative-time formatter. Plain
 * function calls in the node env — same harness as cognition.test.ts.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error plain-JS portal module without type declarations
import * as cognition from "./cognition.js";

const NOW = Date.UTC(2026, 6, 6, 12, 0, 0); // 2026-07-06T12:00:00Z

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

afterEach(() => vi.unstubAllGlobals());

function run(over: Record<string, unknown>) {
  return {
    id: "run_x",
    kind: "data",
    status: "pending",
    running: false,
    attempts: 0,
    nextAttemptAt: iso(0),
    enqueuedAt: iso(-60_000),
    lastAttemptAt: null,
    completedAt: null,
    ...over,
  };
}

describe("runDisplayStatus", () => {
  test("fans pending out on the drainer flag, attempts, and schedule", () => {
    expect(cognition.runDisplayStatus(run({ running: true, attempts: 1 }), NOW)).toBe("running");
    expect(
      cognition.runDisplayStatus(run({ attempts: 1, nextAttemptAt: iso(60_000) }), NOW),
    ).toBe("retrying");
    expect(
      cognition.runDisplayStatus(run({ attempts: 0, nextAttemptAt: iso(3600_000) }), NOW),
    ).toBe("scheduled");
    expect(cognition.runDisplayStatus(run({ nextAttemptAt: iso(-1000) }), NOW)).toBe("queued");
  });

  test("settled statuses pass through untouched", () => {
    expect(cognition.runDisplayStatus(run({ status: "completed" }), NOW)).toBe("completed");
    expect(cognition.runDisplayStatus(run({ status: "failed" }), NOW)).toBe("failed");
  });
});

describe("runTimeLabel", () => {
  test("leads with the state's one meaningful timestamp", () => {
    const running = run({ running: true, attempts: 1, lastAttemptAt: iso(-30_000) });
    expect(cognition.runTimeLabel(running, NOW)).toEqual({
      label: "started 30s ago",
      iso: running.lastAttemptAt,
    });

    const scheduled = run({ nextAttemptAt: iso(2 * 24 * 3600_000) });
    expect(cognition.runTimeLabel(scheduled, NOW).label).toBe("fires in 2d");

    const completed = run({ status: "completed", completedAt: iso(-2 * 3600_000) });
    expect(cognition.runTimeLabel(completed, NOW).label).toBe("completed 2h ago");

    // A failed run without completedAt falls back to its last attempt.
    const failed = run({ status: "failed", completedAt: null, lastAttemptAt: iso(-60_000) });
    expect(cognition.runTimeLabel(failed, NOW)).toEqual({
      label: "failed 1m ago",
      iso: failed.lastAttemptAt,
    });
  });
});

describe("briefMatchesFilter", () => {
  test("buckets the eight stored states into the five filters", () => {
    const b = (state: string) => ({ state });
    expect(cognition.briefMatchesFilter(b("unread"), "unread")).toBe(true);
    expect(cognition.briefMatchesFilter(b("read"), "read")).toBe(true);
    expect(cognition.briefMatchesFilter(b("dismissed_snoozed"), "snoozed")).toBe(true);
    // "dismissed" = the four terminal dismissals, NOT snoozed.
    for (const s of [
      "dismissed_already_handled",
      "dismissed_acknowledged",
      "dismissed_not_relevant",
      "dismissed_wrong",
    ]) {
      expect(cognition.briefMatchesFilter(b(s), "dismissed")).toBe(true);
    }
    expect(cognition.briefMatchesFilter(b("dismissed_snoozed"), "dismissed")).toBe(false);
    expect(cognition.briefMatchesFilter(b("unread"), "all")).toBe(true);
  });
});

describe("resolveSection", () => {
  test("aliases the legacy scheduled tab to runs; junk falls back to overview", () => {
    expect(cognition.resolveSection("scheduled")).toBe("runs");
    expect(cognition.resolveSection("runs")).toBe("runs");
    expect(cognition.resolveSection("memory")).toBe("memory");
    expect(cognition.resolveSection("calendar")).toBe("calendar");
    expect(cognition.resolveSection("temporal-annotations")).toBe("calendar");
    expect(cognition.resolveSection("time-index")).toBe("calendar");
    expect(cognition.resolveSection(undefined)).toBe("overview");
    expect(cognition.resolveSection("bogus")).toBe("overview");
  });
});

describe("cognitionRailBadge", () => {
  test("uses exact collection totals while preserving the live run signal", () => {
    const pulse = {
      ready: true,
      running: [{ id: "run_live" }],
      totalRunCount: 127,
      totalLoopCount: 19,
      briefsTotal: 31,
      queuedCount: 4,
      upcomingCount: 8,
      openLoopCount: 3,
      unreadBriefCount: 5,
    };

    expect(cognition.cognitionRailBadge(pulse, "runs")).toEqual({
      badge: 127,
      live: true,
    });
    expect(cognition.cognitionRailBadge(pulse, "loops")).toEqual({
      badge: 19,
      live: false,
    });
    expect(cognition.cognitionRailBadge(pulse, "briefs")).toEqual({
      badge: 31,
      live: false,
    });
  });

  test("suppresses badges until the pulse has loaded", () => {
    expect(cognition.cognitionRailBadge({ ready: false }, "runs")).toEqual({
      badge: null,
      live: false,
    });
  });
});

describe("runFilterChangePath", () => {
  test("returns to the runs list when a selected run's filters actually change", () => {
    const listPath = "/portal/debug/cognition/runs";
    expect(cognition.runFilterChangePath("run_1", "all", "sweep")).toBe(listPath);
    expect(cognition.runFilterChangePath("run_1", "all", "completed")).toBe(listPath);
  });

  test("does not navigate from the list or for an already-active filter", () => {
    expect(cognition.runFilterChangePath(null, "all", "sweep")).toBeNull();
    expect(cognition.runFilterChangePath("run_1", "sweep", "sweep")).toBeNull();
  });
});

describe("applyRunFilterChange", () => {
  test("retains the chosen filter while replacing a selected run with the list route", () => {
    const setValue = vi.fn();
    const replaceState = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "CustomEvent",
      class {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    );

    expect(cognition.applyRunFilterChange("run_1", "all", "sweep", setValue)).toBe(true);
    expect(setValue).toHaveBeenCalledWith("sweep");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/portal/debug/cognition/runs");
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: "route-change" });
  });

  test("does nothing for the already-active filter", () => {
    const setValue = vi.fn();
    expect(cognition.applyRunFilterChange("run_1", "sweep", "sweep", setValue)).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });
});

describe("run-kind filter metadata", () => {
  const sweep = {
    kind: "sweep",
    label: "Sweep",
    description: "Looks for a configured kind of signal.",
  };

  test("builds filter labels from the canonical definitions", () => {
    expect(cognition.runKindFilterOptions([sweep])).toEqual([
      { value: "all", label: "All kinds" },
      { value: "sweep", label: "Sweep" },
    ]);
  });

  test("renders the selected kind's explanation and suppresses it for All kinds", () => {
    const description = cognition.RunKindDescription({ definition: sweep });
    expect(description.props.class).toBe("debug-sub cognition-run-kind-description");
    expect(description.props["aria-live"]).toBe("polite");
    expect(description.props.children.flat(Infinity).join("")).toContain(
      "Looks for a configured kind of signal.",
    );
    expect(cognition.RunKindDescription({ definition: undefined })).toBeNull();
  });
});

describe("fmtRel", () => {
  test("renders compact two-unit spans, past and future", () => {
    expect(cognition.fmtRel(iso(-12_000), NOW)).toBe("12s ago");
    expect(cognition.fmtRel(iso(-2 * 3600_000 - 5 * 60_000), NOW)).toBe("2h 5m ago");
    expect(cognition.fmtRel(iso(3 * 24 * 3600_000 + 4 * 3600_000), NOW)).toBe("in 3d 4h");
    expect(cognition.fmtRel(iso(45 * 60_000), NOW)).toBe("in 45m");
    expect(cognition.fmtRel(null, NOW)).toBe("—");
  });
});
