// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { buildFinanceHealth } from "./finance-health.mjs";
import { context, londonAt } from "./shared.mjs";
import { buildBackground } from "./background.mjs";
import { buildScenarios } from "./scenarios.mjs";

const cents = (amount) => Math.round(Number(amount) * 100);
const sum = (rows, amount) => rows.reduce((total, row) => total + cents(amount(row)), 0);

describe("financial export reconciliation", () => {
  it("avoids simultaneous distinct morning workouts and sleep/mindfulness overlap", () => {
    const ctx = context();
    const health = buildFinanceHealth(ctx).sources["apple-health"]["health.json"];
    const recreation = buildBackground(ctx)["strava-activities"]["activities.json"];
    const interval = (date, hour, minutes) => {
      const start = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
      return [start, start + minutes * 60000];
    };
    const overlaps = ([start, end], [otherStart, otherEnd]) => start < otherEnd && otherStart < end;
    const workouts = health.workouts.map((row) =>
      interval(row.dateOf, row.startHour, row.durationMin),
    );
    for (const run of recreation) {
      const start = Date.parse(run.startTime);
      expect(
        workouts.some((other) => overlaps([start, start + run.movingTimeSeconds * 1000], other)),
      ).toBe(false);
    }
    for (const session of health.mindful)
      expect(
        workouts.some((other) =>
          overlaps(interval(session.dateOf, session.startHour, session.durationMin), other),
        ),
      ).toBe(false);
    for (const night of health.sleep) {
      const start = Date.parse(`${night.nightOf}T22:30:00Z`);
      const duration = Math.max(...night.stages.map(([, offset, minutes]) => offset + minutes));
      expect(workouts.some((other) => overlaps([start, start + duration * 60000], other))).toBe(
        false,
      );
    }
  });

  it.each(["2026-10-03", "2026-12-31", "2027-03-28", "2028-02-29"])(
    "reconciles openings, dated flows, current snapshots and internal transfers at %s",
    (asOf) => {
      const ctx = context(asOf);
      const { sources } = buildFinanceHealth(ctx);
      for (const id of ["lunchflow-accounts", "enable-banking-accounts", "coinbase"])
        expect(sources[id]["clock.json"]).toEqual({
          snapshotDay: asOf,
          syncedAt: londonAt(asOf, "00:00"),
        });

      const coverage = sources["apple-notes"]["notes.json"].find(
        (row) => row.externalId === "sb-bank-coverage",
      );
      expect(coverage.createdAt).toBe(londonAt(ctx.monday, "00:00"));
      expect(coverage.modifiedAt).toBe(coverage.createdAt);
      expect(Date.parse(coverage.modifiedAt)).toBeGreaterThan(
        Date.parse(`${ctx.day(-1)}T12:00:00Z`),
      );

      const groups = sources["lunchflow-accounts"]["transactions.json"];
      const balances = sources["lunchflow-accounts"]["balances.json"];
      for (const [id, opening] of [
        [901, 500000],
        [902, 170000],
      ]) {
        const rows = groups.find((group) => group.account_id === id).transactions;
        const closing = balances.find((balance) => balance.account_id === id).balance.amount;
        expect(cents(closing)).toBe(opening + sum(rows, (row) => row.amount));
        expect(rows.every((row) => row.date <= ctx.day(-1) && !row.isPending)).toBe(true);
        let running = opening;
        for (const row of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
          running += cents(row.amount);
          expect(running).toBeGreaterThanOrEqual(0);
        }
      }
      const coveredDates = new Set(
        groups[0].transactions
          .filter((row) => row.id.startsWith("sb-bg-gbp-"))
          .map((row) => row.date),
      );
      expect(coveredDates.has("2022-06-12")).toBe(true);
      expect(coveredDates.has("2023-08-20")).toBe(true);
      expect(coveredDates.has(ctx.day(-1))).toBe(true);
      expect(coveredDates.size).toBe(
        Math.round(
          (Date.parse(`${ctx.monday}T12:00:00Z`) - Date.parse("2021-10-24T12:00:00Z")) / 86400000,
        ),
      );

      const debits = groups[0].transactions.filter((row) => row.id.startsWith("sb-saving-debit-"));
      const credits = groups[1].transactions;
      expect(debits).toHaveLength(credits.length);
      expect(sum(debits, (row) => row.amount) + sum(credits, (row) => row.amount)).toBe(0);
      for (const credit of credits) {
        const debit = debits.find((row) => row.id === `sb-saving-debit-${credit.id}`);
        expect(debit.date).toBe(credit.date);
        expect(debit.amount).toBe(-credit.amount);
      }

      const eur = sources["enable-banking-accounts"]["transactions.json"][0].transactions;
      const eurBalance = sources["enable-banking-accounts"]["balances.json"][0].balances[0];
      expect(
        eur.every((row) => row.booking_date <= asOf && row.credit_debit_indicator === "DBIT"),
      ).toBe(true);
      expect(cents(eurBalance.balance_amount.amount)).toBe(
        500000 - sum(eur, (row) => row.transaction_amount.amount),
      );
      expect(Number(eurBalance.balance_amount.amount)).toBeGreaterThan(0);
      expect(eurBalance.reference_date).toBe(asOf);

      const plaid = sources.plaid["responses.json"];
      const usd = plaid.transactionsSyncPages[0].added;
      expect(usd.every((row) => row.date <= asOf && row.amount > 0 && !row.pending)).toBe(true);
      expect(cents(plaid.accountsGet.accounts[0].balances.current)).toBe(
        350000 - sum(usd, (row) => row.amount),
      );
      expect(plaid.accountsGet.accounts[0].balances.current).toBeGreaterThan(0);
      expect(plaid.snapshotDay).toBe(asOf);
      expect(new Set(groups.flatMap((group) => group.transactions.map((row) => row.id))).size).toBe(
        groups.reduce((total, group) => total + group.transactions.length, 0),
      );
    },
  );

  it("keeps the trip refund separate from reimbursement and excludes the absent course refund", () => {
    const rows =
      buildFinanceHealth(context()).sources["lunchflow-accounts"]["transactions.json"][0]
        .transactions;
    const trip = rows.filter((row) => row.id.startsWith("sb-txn-trip-"));
    expect(
      sum(
        trip.filter((row) => row.amount < 0),
        (row) => row.amount,
      ),
    ).toBe(-122000);
    expect(trip.find((row) => row.id.endsWith("refund")).amount).toBe(90);
    expect(trip.find((row) => row.id.endsWith("split")).amount).toBe(565);
    expect(sum(trip, (row) => row.amount)).toBe(-56500);
    expect(rows.filter((row) => row.amount > 0 && /RC-8400/.test(row.description))).toEqual([]);
  });

  it("reconciles the exact paid gift receipts against covered card transactions", () => {
    const ctx = context();
    const rows =
      buildFinanceHealth(ctx).sources["lunchflow-accounts"]["transactions.json"][0].transactions;
    const receipts = buildScenarios(ctx).sources.gmail["messages.json"];
    for (const [reference, amount, date] of [
      ["WK-220716", 120, "2022-06-12"],
      ["LR-230908", 68, "2023-08-20"],
    ]) {
      const receipt = receipts.find((row) => `${row.subject} ${row.body}`.includes(reference));
      expect(receipt).toBeDefined();
      expect(receipt.body).toContain(`Paid £${amount}`);
      const matching = rows.filter((row) => row.description.includes(reference));
      expect(matching).toHaveLength(1);
      expect(matching[0].amount).toBe(-amount);
      expect(matching[0].date).toBe(date);
    }
  });

  it.each(["2027-03-28", "2026-10-25"])(
    "keeps late workouts aligned with London through DST at %s",
    (asOf) => {
      const ctx = context(asOf);
      const { sources } = buildFinanceHealth(ctx);
      const runs = sources["strava-activities"]["activities.json"];
      const health = sources["apple-health"]["health.json"];
      for (const run of runs) {
        const date = run.startTime.slice(0, 10);
        expect(run.startTime).toBe(londonAt(date, "21:00"));
        const corresponding = health.workouts.find(
          (row) => row.dateOf === date && row.durationMin === 65,
        );
        expect(corresponding.startHour).toBe(new Date(run.startTime).getUTCHours());
        expect(date <= asOf).toBe(true);
      }
      for (const night of health.sleep) {
        let end = 0;
        for (const [, start, duration] of night.stages) {
          expect(start).toBe(end);
          expect(duration).toBeGreaterThan(0);
          end = start + duration;
        }
        expect(end).toBeLessThan(24 * 60);
      }
    },
  );
});
