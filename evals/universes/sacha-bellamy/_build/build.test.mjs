// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { context, londonAt, londonToday, anniversary, recordingWeek } from "./shared.mjs";
import { buildScenarios } from "./scenarios.mjs";
import { buildFinanceHealth } from "./finance-health.mjs";
import { mergeSources } from "./build.mjs";

const fixtures = (sources, id, file) => sources[id][file];

describe("Sacha demo chronology and evidence consistency", () => {
  it.each([
    ["2026-10-03", "2026-10-10", "2026-10-06", "2026-10-07"],
    ["2026-10-04", "2026-10-10", "2026-10-06", "2026-10-07"],
    ["2026-12-31", "2027-01-09", "2027-01-05", "2027-01-06"],
    ["2028-02-29", "2028-03-11", "2028-03-07", "2028-03-08"],
  ])("keeps next-week commitments coherent at %s", (asOf, party, pickup, gp) => {
    const result = buildScenarios(context(asOf));
    const facts = new Map(result.facts.map((f) => [f.id, f]));
    expect(facts.get("A11").expected.date).toBe(party);
    expect(facts.get("F05").expected.date).toBe(pickup);
    expect(facts.get("A12").expected.appointment).toBe(gp);
    const reminder = fixtures(result.sources, "apple-reminders", "reminders.json").find(
      (r) => r.externalId === "sb-reminder-lantern",
    );
    const london = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(reminder.dueAt));
    expect(london).toBe("17:30");
    expect(facts.get("F01").expected.actualMove).toBe("2023-04-22");
    expect(facts.get("F03").expected.start).toBe("2025-05-01");
    const task = fixtures(result.sources, "things", "tasks.json").find(
      (r) => r.externalId === "sb-task-complete",
    );
    expect(task.status).toBe("done");
  });

  it("uses the London calendar day at the UTC midnight boundary", () => {
    expect(londonToday(new Date("2026-06-07T23:30:00Z"))).toBe("2026-06-08");
    expect(londonToday(new Date("2026-12-06T23:30:00Z"))).toBe("2026-12-06");
    expect(recordingWeek("2026-06-08")).toBe("2026-06-08");
    expect(recordingWeek("2026-12-06")).toBe("2026-11-30");
    expect(londonAt("2026-03-28", "17:30")).toBe("2026-03-28T17:30:00.000Z");
    expect(londonAt("2026-03-29", "17:30")).toBe("2026-03-29T16:30:00.000Z");
    expect(londonAt("2026-10-25", "17:30")).toBe("2026-10-25T17:30:00.000Z");
    expect(anniversary("2028-02-29", 2)).toBe("2030-02-28");
    expect(() => recordingWeek("2026-02-30")).toThrow();
  });

  it("reconciles actual bank evidence rather than a prepared holiday answer", () => {
    const { sources } = buildFinanceHealth(context());
    const records = fixtures(sources, "lunchflow-accounts", "transactions.json")[0].transactions;
    const trip = records.filter((r) => r.id.startsWith("sb-txn-trip-"));
    const outflows = -trip.filter((r) => r.amount < 0).reduce((sum, r) => sum + r.amount, 0);
    const refund = trip.find((r) => r.id === "sb-txn-trip-refund").amount;
    const reimbursement = trip.find((r) => r.id === "sb-txn-trip-split").amount;
    expect(outflows).toBe(1220);
    expect(outflows - refund).toBe(1130);
    expect(outflows - refund - reimbursement).toBe(565);
    expect(records.some((r) => r.amount === 84 && r.amount > 0)).toBe(false);
    expect(records.find((r) => r.id === "sb-txn-refund-control").amount).toBe(18);
    expect(records.find((r) => r.id === "sb-txn-climbing").amount).toBe(-84);
  });

  it("produces non-overlapping measured sleep stages and the promised comparison", () => {
    const ctx = context(),
      { sources } = buildFinanceHealth(ctx);
    const sleep = fixtures(sources, "apple-health", "health.json").sleep;
    const hours = (start, end) => {
      const nights = sleep.filter((n) => n.nightOf >= start && n.nightOf <= end);
      expect(nights).toHaveLength(14);
      return (
        nights.reduce(
          (sum, n) =>
            sum +
            n.stages
              .filter(([stage]) => stage !== "awake" && stage !== "inBed")
              .reduce((s, [, , minutes]) => s + minutes, 0),
          0,
        ) /
        14 /
        60
      );
    };
    expect(hours(ctx.day(-29), ctx.day(-16))).toBe(7.5);
    expect(hours(ctx.day(-15), ctx.day(-2))).toBe(6);
    for (const night of sleep)
      for (let i = 1; i < night.stages.length; i++) {
        const previous = night.stages[i - 1],
          current = night.stages[i];
        expect(current[1]).toBeGreaterThanOrEqual(previous[1] + previous[2]);
      }
  });

  it("keeps scenario evidence additive and rejects conflicting structured templates", () => {
    const ctx = context(),
      scenarios = buildScenarios(ctx),
      finance = buildFinanceHealth(ctx);
    const merged = mergeSources(scenarios.sources, finance.sources);
    expect(
      merged["apple-notes"]["notes.json"].some((n) => n.externalId === "sb-home-current-note"),
    ).toBe(true);
    expect(
      merged["apple-notes"]["notes.json"].some((n) => n.externalId === "sb-bank-coverage"),
    ).toBe(true);
    expect([...scenarios.facts, ...finance.facts]).toHaveLength(16);
    expect(new Set([...scenarios.facts, ...finance.facts].map((f) => f.id)).size).toBe(16);
    expect(() =>
      mergeSources({ test: { "data.json": { x: 1 } } }, { test: { "data.json": { x: 2 } } }),
    ).toThrow("Duplicate non-array");
  });
});
