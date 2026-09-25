// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { runSyncCycleContract, expectUnchangedUpstreamIsNoOp } from "./sync-cycle.js";

/**
 * A miniature of the real shape: a sweep that lists items, and an enrichment
 * phase that fills in what the listing could not carry and stamps the row so
 * the sweep skips it next time.
 *
 * `agreeOnHash` is the seam. With both phases computing the stored digest the
 * same way the machine settles; with them disagreeing — the sweep hashing only
 * what a listing carries, enrichment folding in what only it can see — the
 * sweep never recognises its own work and clears the stamp forever.
 */
function twoPhaseSource(opts: { agreeOnHash: boolean }) {
  const upstream = [
    { id: 1, name: "first", detail: "a detail" },
    { id: 2, name: "second", detail: "another" },
  ];
  const digest = (item: (typeof upstream)[number], withDetail: boolean): string =>
    withDetail ? `${item.name}|${item.detail}` : `${item.name}|`;

  return {
    initialCursor: { phase: "sweep" as const },
    primaryKey: () => ["id"],
    volatileColumns: () => ["fetched_at"],
    step(cursor: unknown, rows: (table: string) => readonly Record<string, unknown>[]) {
      const at = cursor as { phase: "sweep" | "enrich" };
      const stored = new Map(rows("items").map((r) => [Number(r.id), r]));

      if (at.phase === "sweep") {
        const records = upstream
          .filter((item) => stored.get(item.id)?.hash !== digest(item, false))
          .map((item) => ({
            table: "items",
            row: {
              id: item.id,
              name: item.name,
              detail: null,
              hash: digest(item, false),
              fetched_at: null,
            },
          }));
        return { records, cursor: { phase: "enrich" as const }, hasMore: records.length > 0 };
      }

      const pending = rows("items").filter((r) => r.fetched_at === null);
      const records = pending.map((row) => {
        const item = upstream.find((u) => u.id === Number(row.id))!;
        return {
          table: "items",
          row: {
            ...row,
            detail: item.detail,
            hash: digest(item, !opts.agreeOnHash),
            fetched_at: "stamped",
          },
        };
      });
      return { records, cursor: { phase: "sweep" as const }, hasMore: records.length > 0 };
    },
  };
}

describe("the unchanged-upstream contract", () => {
  test("passes when both phases agree on what they persist", async () => {
    const report = await expectUnchangedUpstreamIsNoOp(twoPhaseSource({ agreeOnHash: true }));
    expect(report.converged).toBe(true);
    expect(report.rewritten).toEqual([]);
    // The property in one line: once settled, another whole cycle writes nothing.
    expect(report.rowsAfterConvergence).toBe(0);
  });

  test("fails, naming the column, when the two phases disagree", async () => {
    // Enrichment folds a detail-only field into the digest the sweep
    // recomputes without it, so the sweep never recognises its own row: it
    // clears the stamp on every pass and enrichment re-fetches on every pass.
    await expect(
      expectUnchangedUpstreamIsNoOp(twoPhaseSource({ agreeOnHash: false })),
    ).rejects.toThrow(/never settled|changed \d+ stored value/);
  });

  test("reports the disagreement rather than only failing", async () => {
    const report = await runSyncCycleContract(twoPhaseSource({ agreeOnHash: false }));
    // Non-convergence is the loop's signature; either that or a named rewrite
    // must be visible, or the helper would pass the bug it exists to catch.
    expect(report.converged === false || report.rewritten.length > 0).toBe(true);
  });

  test("a volatile column moving is not a rewrite", async () => {
    // A fetch stamp changing is the phase doing its job. Counting it would
    // make every correct multi-phase source fail this check.
    let stamped = 0;
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      volatileColumns: () => ["fetched_at"],
      step: (cursor) => {
        const n = cursor as number;
        stamped += 1;
        return {
          records: n === 0 ? [{ table: "t", row: { id: 1, v: "same", fetched_at: stamped } }] : [],
          cursor: n + 1,
          hasMore: false,
        };
      },
    });
    expect(report.rewritten).toEqual([]);
  });

  test("a meaningful column moving IS a rewrite, and is named", async () => {
    // Settles on "first" (one write, then `settleSteps` quiet calls), then the
    // very next cycle contradicts itself.
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      volatileColumns: () => ["fetched_at"],
      settleSteps: 2,
      step: (cursor) => {
        const n = cursor as number;
        const records =
          n === 0
            ? [{ table: "t", row: { id: 1, v: "first" } }]
            : n === 3
              ? [{ table: "t", row: { id: 1, v: "second" } }]
              : [];
        return { records, cursor: n + 1, hasMore: false };
      },
    });
    expect(report.rewritten).toHaveLength(1);
    expect(report.rewritten[0]).toMatchObject({
      table: "t",
      column: "v",
      before: "first",
      after: "second",
    });
  });

  test("a genuinely new row is not counted as a rewrite", async () => {
    // Upstream growing between cycles is ordinary; only re-writing what was
    // already settled is the defect.
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      step: (cursor) => {
        const n = cursor as number;
        return {
          records: n === 0 ? [{ table: "t", row: { id: 1, v: "a" } }] : [],
          cursor: n + 1,
          hasMore: false,
        };
      },
    });
    expect(report.rewritten).toEqual([]);
    expect(report.converged).toBe(true);
  });

  test("refuses to run forever, and says so", async () => {
    await expect(
      expectUnchangedUpstreamIsNoOp({
        initialCursor: 0,
        primaryKey: () => ["id"],
        maxSteps: 5,
        step: (cursor) => {
          const n = cursor as number;
          return { records: [{ table: "t", row: { id: n, v: n } }], cursor: n + 1, hasMore: true };
        },
      }),
    ).rejects.toThrow(/never settled: still working after 5 calls/);
  });

  test("a phase that misbehaves further round the ring than the quiet stretch", async () => {
    // The false pass this design exists to rule out. A long ring whose last
    // phase writes on every pass: if the settle cycle stops at the first quiet
    // stretch it never reaches that phase, twice, and reports a clean bill on
    // a source calling upstream every cycle forever.
    const PHASES = 12;
    let cycles = 0;
    await expect(
      expectUnchangedUpstreamIsNoOp({
        initialCursor: 0,
        primaryKey: () => ["id"],
        settleSteps: 4,
        step: (cursor) => {
          const phase = cursor as number;
          const last = phase === PHASES - 1;
          if (last) cycles += 1;
          return {
            records: last ? [{ table: "t", row: { id: 1, v: `cycle-${cycles}` } }] : [],
            cursor: (phase + 1) % PHASES,
            hasMore: false,
          };
        },
      }),
    ).rejects.toThrow(/changed \d+ stored value|never settled/);
  });

  test("a cycle that keeps inventing rows is not stable", async () => {
    // Append-only churn: nothing is rewritten, but each cycle adds a row that
    // was not there before, which is the same defect wearing a new key.
    let n = 0;
    await expect(
      expectUnchangedUpstreamIsNoOp({
        initialCursor: 0,
        primaryKey: () => ["id"],
        settleSteps: 3,
        step: () => {
          n += 1;
          return { records: [{ table: "t", row: { id: n, v: "x" } }], cursor: 0, hasMore: false };
        },
      }),
    ).rejects.toThrow(/never settled|changed \d+ stored value/);
  });

  test("a cursor carrying a set is not mistaken for a state that never moves", async () => {
    // `JSON.stringify` renders every Set as `{}`, so a cursor holding pending
    // ids would look identical on every call and the ring would appear to
    // close on step one — with the work still undone.
    const report = await runSyncCycleContract({
      initialCursor: { pending: new Set([1, 2, 3]) },
      primaryKey: () => ["id"],
      settleSteps: 3,
      step: (cursor) => {
        const { pending } = cursor as { pending: Set<number> };
        const next = [...pending];
        const id = next.shift();
        return {
          records: id === undefined ? [] : [{ table: "t", row: { id, v: "x" } }],
          cursor: { pending: new Set(next) },
          hasMore: false,
        };
      },
    });
    // All three were written, rather than the walk being cut short at one.
    expect(report.converged).toBe(true);
    expect(report.rewritten).toEqual([]);
  });

  test("a JSON-valued column re-asserted identically is not a rewrite", async () => {
    // Each cycle builds its rows fresh, so comparing objects by reference would
    // report every JSON column as changed on every run — which would fail every
    // correct source that has one.
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      settleSteps: 3,
      step: () => ({
        records: [{ table: "t", row: { id: 1, tags: ["a", "b"], meta: { k: 1 } } }],
        cursor: 0,
        hasMore: false,
      }),
    });
    expect(report.rewritten).toEqual([]);
    // …and it is genuinely re-emitting, so the comparison really ran.
    expect(report.rowsAfterConvergence).toBeGreaterThan(0);
  });

  test("a narrower enrichment page does not read as clearing the columns it omits", async () => {
    // The analytics writer merges: its upsert sets the columns a page carried
    // and leaves the rest. A replace model would call every omitted column
    // cleared, which is the ordinary shape of a multi-phase source.
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      settleSteps: 3,
      step: (cursor) => {
        const n = cursor as number;
        // The wide row while settling…
        if (n === 0) {
          return {
            records: [{ table: "t", row: { id: 1, name: "n", detail: "d" } }],
            cursor: 1,
            hasMore: false,
          };
        }
        if (n < 4) return { records: [], cursor: n + 1, hasMore: false };
        // …then, in the settle cycle, a page carrying only the column that
        // phase owns. A store that replaced rather than merged would read the
        // omitted `name` as cleared.
        return {
          records: [{ table: "t", row: { id: 1, detail: "d" } }],
          cursor: n + 1,
          hasMore: false,
        };
      },
    });
    expect(report.rewritten).toEqual([]);
  });

  test("a volatile column moving really is exercised, not vacuously ignored", async () => {
    // The earlier version of this test settled before the comparison ran, so
    // it passed whether or not volatile columns were excluded. Here the settle
    // cycle definitely writes, and the stamp definitely moves.
    let stamp = 0;
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      volatileColumns: () => ["fetched_at"],
      settleSteps: 3,
      step: () => {
        stamp += 1;
        return {
          records: [{ table: "t", row: { id: 1, v: "same", fetched_at: stamp } }],
          cursor: 0,
          hasMore: false,
        };
      },
    });
    expect(report.rowsAfterConvergence).toBeGreaterThan(0);
    expect(report.rewritten).toEqual([]);
    expect(stamp).toBeGreaterThan(2);
  });

  test("a column dropped between cycles is a change", async () => {
    // The clobber direction: a phase that stops writing a column it used to.
    let seen = 0;
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      settleSteps: 3,
      step: (cursor) => {
        const n = cursor as number;
        seen = Math.max(seen, n);
        // Writes the column while settling, then stops writing it — so the
        // drop happens in the settle cycle, where it must be noticed.
        if (n === 0) {
          return {
            records: [{ table: "t", row: { id: 1, v: "x", extra: "e" } }],
            cursor: 1,
            hasMore: false,
          };
        }
        if (n < 4) return { records: [], cursor: n + 1, hasMore: false };
        return {
          records: [{ table: "t", row: { id: 1, v: "x", extra: null } }],
          cursor: n + 1,
          hasMore: false,
        };
      },
    });
    expect(report.rewritten.map((r) => r.column)).toContain("extra");
  });

  test("composite keys made of adjacent values stay distinct", async () => {
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["a", "b"],
      settleSteps: 2,
      step: (cursor) =>
        (cursor as number) === 0
          ? {
              records: [
                { table: "t", row: { a: "x", b: "yz", v: 1 } },
                { table: "t", row: { a: "xy", b: "z", v: 2 } },
              ],
              cursor: 1,
              hasMore: false,
            }
          : { records: [], cursor: 1, hasMore: false },
    });
    expect(report.rewritten).toEqual([]);
    // Two rows, not one that overwrote the other.
    expect(report.converged).toBe(true);
  });

  test("a source that keeps asking to be called again has not settled", async () => {
    // `hasMore` interrupts a writeless run: two quiet calls then one asking
    // for another must never accumulate into quiescence, or a source that
    // never finishes a page would be reported as done.
    await expect(
      expectUnchangedUpstreamIsNoOp({
        initialCursor: 0,
        primaryKey: () => ["id"],
        maxSteps: 30,
        settleSteps: 3,
        step: (cursor) => {
          const n = cursor as number;
          return { records: [], cursor: n + 1, hasMore: n % 3 === 2 };
        },
      }),
    ).rejects.toThrow(/never settled/);
  });

  test("composite keys cannot be forged by adjacent values", async () => {
    // `{a:"x", b:"yz"}` and `{a:"xy", b:"z"}` must not collapse onto one row.
    // Asserted on the store, because a collision leaves the comparison clean:
    // one row simply overwrites the other and the second cycle changes nothing.
    let stored = -1;
    await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["a", "b"],
      settleSteps: 2,
      step: (cursor, rows) => {
        const n = cursor as number;
        stored = rows("t").length;
        if (n > 0) return { records: [], cursor: n + 1, hasMore: false };
        return {
          records: [
            { table: "t", row: { a: "x", b: "yz", v: "first" } },
            { table: "t", row: { a: "xy", b: "z", v: "second" } },
            // A null key part must not read as the literal string "null".
            { table: "t", row: { a: null, b: "q", v: "third" } },
            { table: "t", row: { a: "null", b: "q", v: "fourth" } },
          ],
          cursor: 1,
          hasMore: false,
        };
      },
    });
    expect(stored).toBe(4);
  });

  test("a short ring settles by coming round, not by waiting out the counter", async () => {
    // The cursor-recurrence rule, which is the principled one: a three-phase
    // ring that goes quiet is settled after it has come round once, and should
    // not have to wait for a writeless run as long as `settleSteps`. Without
    // that rule every source pays the full counter before anything is checked.
    let written = false;
    const report = await runSyncCycleContract({
      initialCursor: 0,
      primaryKey: () => ["id"],
      settleSteps: 12,
      step: (cursor) => {
        const n = cursor as number;
        const records = n === 0 && !written ? [{ table: "t", row: { id: 1, v: "x" } }] : [];
        if (records.length > 0) written = true;
        return { records, cursor: (n + 1) % 3, hasMore: false };
      },
    });
    expect(report.converged).toBe(true);
    expect(report.stepsToConverge).toBeLessThan(12);
    expect(report.rewritten).toEqual([]);
  });

  test("hasMore keeps the machine from being called settled", async () => {
    // A source asking to be called again has not settled, whatever it emitted.
    await expect(
      expectUnchangedUpstreamIsNoOp({
        initialCursor: 0,
        primaryKey: () => ["id"],
        maxSteps: 8,
        settleSteps: 2,
        step: (cursor) => ({ records: [], cursor: (cursor as number) + 1, hasMore: true }),
      }),
    ).rejects.toThrow(/never settled/);
  });
});
