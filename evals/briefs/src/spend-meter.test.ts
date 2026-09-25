// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type PriceSheet,
  SpendCapError,
  SpendMeter,
  ledgerTotalUsd,
  loadBudget,
  loadPriceSheet,
  priceUsageUsd,
  priceWorstCaseUsd,
  readSpendRecords,
} from "./spend-meter.js";

/** Fake price feed with easy round numbers: hit $1, miss $10, output $20 per 1M tokens. */
const fakePrices: PriceSheet = {
  model: "fake-model-under-test",
  currency: "USD",
  per1MTokensUsd: { inputCacheHit: 1, inputCacheMiss: 10, output: 20 },
  sourceUrl: "https://example.com/pricing",
  retrievedAt: "2026-01-01",
};

const briefsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");

let dir: string;
let committedLedger: string;
let onBoxLedger: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "briefs-spend-meter-"));
  committedLedger = join(dir, "repo", "ledger.jsonl");
  onBoxLedger = join(dir, "out-of-repo", "briefs-spend.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function meter(capUsd: number, now?: () => Date): SpendMeter {
  return new SpendMeter(fakePrices, {
    budget: { capUsd, refusalFraction: 0.9 },
    ledgerPaths: [committedLedger, onBoxLedger],
    now,
  });
}

describe("pricing", () => {
  it("prices cache-hit, cache-miss, and output tokens at their separate rates", () => {
    const usd = priceUsageUsd(
      {
        promptCacheHitTokens: 1_000_000,
        promptCacheMissTokens: 500_000,
        completionTokens: 100_000,
      },
      fakePrices,
    );
    // 1M hit @ $1 + 0.5M miss @ $10 + 0.1M output @ $20 = 1 + 5 + 2
    expect(usd).toBeCloseTo(8, 10);
  });

  it("prices the worst case with every prompt token at the cache-miss rate", () => {
    const usd = priceWorstCaseUsd(
      { promptTokens: 1_000_000, completionTokens: 100_000 },
      fakePrices,
    );
    expect(usd).toBeCloseTo(12, 10); // 10 + 2
  });
});

describe("reserve-then-run", () => {
  it("appends an identical reservation receipt to every ledger before returning", () => {
    const record = meter(1000, () => new Date("2026-07-02T05:00:00Z")).reserve("run-1", {
      promptTokens: 100_000,
      completionTokens: 10_000,
    });
    expect(record.projectedUsd).toBeCloseTo(1.2, 10);
    expect(record.at).toBe("2026-07-02T05:00:00.000Z");
    expect(record.model).toBe("fake-model-under-test");
    for (const path of [committedLedger, onBoxLedger]) {
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(record);
    }
  });

  it("counts an unsettled reservation at its worst-case projection", () => {
    const m = meter(1000);
    m.reserve("run-1", { promptTokens: 100_000, completionTokens: 0 }); // $1 worst case
    expect(m.cumulativeSpendUsd()).toBeCloseTo(1, 10);
  });

  it("settling replaces the projection with the actual priced usage", () => {
    const m = meter(1000);
    m.reserve("run-1", { promptTokens: 1_000_000, completionTokens: 0 }); // $10 worst case
    const settle = m.settle("run-1", {
      promptCacheHitTokens: 900_000,
      promptCacheMissTokens: 100_000,
      completionTokens: 0,
    });
    expect(settle.usd).toBeCloseTo(1.9, 10); // 0.9 + 1.0 — far below the $10 projection
    expect(m.cumulativeSpendUsd()).toBeCloseTo(1.9, 10);
  });

  it("rejects a duplicate reservation and a settle without a reservation", () => {
    const m = meter(1000);
    m.reserve("run-1", { promptTokens: 1, completionTokens: 1 });
    expect(() => m.reserve("run-1", { promptTokens: 1, completionTokens: 1 })).toThrow(
      /already has a reservation/,
    );
    expect(() =>
      m.settle("run-2", { promptCacheHitTokens: 0, promptCacheMissTokens: 0, completionTokens: 0 }),
    ).toThrow(/no reservation/);
    m.settle("run-1", { promptCacheHitTokens: 1, promptCacheMissTokens: 0, completionTokens: 1 });
    expect(() =>
      m.settle("run-1", { promptCacheHitTokens: 1, promptCacheMissTokens: 0, completionTokens: 1 }),
    ).toThrow(/already settled/);
  });
});

describe("cap enforcement", () => {
  it("refuses a run whose worst-case projection would pass 90% of the cap", () => {
    // Cap $10 → refusal limit $9. Recorded spend $5 + projected $5 = $10 > $9.
    const m = meter(10);
    m.reserve("run-1", { promptTokens: 500_000, completionTokens: 0 }); // $5
    expect(() => m.reserve("run-2", { promptTokens: 500_000, completionTokens: 0 })).toThrow(
      SpendCapError,
    );
    // The refusal appends nothing.
    expect(readSpendRecords(committedLedger)).toHaveLength(1);
    expect(readSpendRecords(onBoxLedger)).toHaveLength(1);
  });

  it("allows a run that lands exactly on the refusal limit", () => {
    // Cap $10 → limit $9. $5 recorded + $4 projected = $9, not past it.
    const m = meter(10);
    m.reserve("run-1", { promptTokens: 500_000, completionTokens: 0 }); // $5
    expect(() => m.reserve("run-2", { promptTokens: 400_000, completionTokens: 0 })).not.toThrow();
  });

  it("carries the numbers on the refusal error", () => {
    const m = meter(10);
    m.reserve("run-1", { promptTokens: 500_000, completionTokens: 0 });
    try {
      m.reserve("run-2", { promptTokens: 900_000, completionTokens: 0 });
      expect.unreachable("reserve must refuse");
    } catch (error) {
      const capError = error as SpendCapError;
      expect(capError).toBeInstanceOf(SpendCapError);
      expect(capError.cumulativeUsd).toBeCloseTo(5, 10);
      expect(capError.projectedUsd).toBeCloseTo(9, 10);
      expect(capError.capUsd).toBe(10);
      expect(capError.refusalFraction).toBe(0.9);
    }
  });

  it("settling under projection frees budget for later runs", () => {
    const m = meter(10);
    m.reserve("run-1", { promptTokens: 800_000, completionTokens: 0 }); // $8 projected
    expect(() => m.reserve("run-2", { promptTokens: 200_000, completionTokens: 0 })).toThrow(
      SpendCapError,
    );
    m.settle("run-1", {
      promptCacheHitTokens: 800_000,
      promptCacheMissTokens: 0,
      completionTokens: 0,
    }); // $0.80 actual
    expect(() => m.reserve("run-2", { promptTokens: 200_000, completionTokens: 0 })).not.toThrow();
  });
});

describe("dual-ledger max semantics", () => {
  it("uses the higher of the two ledgers when they diverge", () => {
    const m = meter(1000);
    m.reserve("run-1", { promptTokens: 500_000, completionTokens: 0 }); // $5 in both
    // Simulate the committed ledger losing history (rebase, eviction): wipe it.
    writeFileSync(committedLedger, "");
    expect(m.cumulativeSpendUsd()).toBeCloseTo(5, 10);
    // And the reverse: extra spend recorded only on-box still counts.
    appendFileSync(
      onBoxLedger,
      `${JSON.stringify({
        kind: "spend-reserve",
        runId: "run-elsewhere",
        at: "2026-07-01T00:00:00.000Z",
        model: "fake-model-under-test",
        worstCase: { promptTokens: 100_000, completionTokens: 0 },
        projectedUsd: 1,
      })}\n`,
    );
    expect(m.cumulativeSpendUsd()).toBeCloseTo(6, 10);
  });

  it("counts an orphan settle (reservation lost to divergence) at its actual cost", () => {
    const records = [
      {
        kind: "spend-settle" as const,
        runId: "run-orphan",
        at: "2026-07-01T00:00:00.000Z",
        model: "fake-model-under-test",
        usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 100_000, completionTokens: 0 },
        usd: 1,
      },
    ];
    expect(ledgerTotalUsd(records, "test")).toBeCloseTo(1, 10);
  });

  it("treats a missing ledger file as empty", () => {
    expect(meter(10).cumulativeSpendUsd()).toBe(0);
  });
});

describe("ledger hygiene", () => {
  it("fails loud on a malformed ledger line", () => {
    const m = meter(10);
    m.reserve("run-1", { promptTokens: 1, completionTokens: 1 });
    appendFileSync(committedLedger, "not json\n");
    expect(() => m.cumulativeSpendUsd()).toThrow(/malformed ledger line/);
  });

  it("fails loud on duplicate records for one run id within a ledger", () => {
    const reserve = {
      kind: "spend-reserve",
      runId: "run-1",
      at: "2026-07-01T00:00:00.000Z",
      model: "fake-model-under-test",
      worstCase: { promptTokens: 1, completionTokens: 1 },
      projectedUsd: 0.01,
    };
    mkdirSync(dirname(committedLedger), { recursive: true });
    writeFileSync(committedLedger, `${JSON.stringify(reserve)}\n${JSON.stringify(reserve)}\n`);
    expect(() => meter(10).cumulativeSpendUsd()).toThrow(/duplicate spend-reserve/);
  });

  it("ignores non-spend record kinds sharing the ledger (scorecard iteration rows)", () => {
    const m = meter(1000);
    m.reserve("run-1", { promptTokens: 100_000, completionTokens: 0 }); // $1
    appendFileSync(
      committedLedger,
      `${JSON.stringify({ kind: "iteration", iter: 1, verdict: "pass" })}\n`,
    );
    expect(m.cumulativeSpendUsd()).toBeCloseTo(1, 10);
  });
});

describe("committed artifacts", () => {
  it("deepseek-prices.json is a valid price sheet", () => {
    const sheet = loadPriceSheet(join(briefsDir, "deepseek-prices.json"));
    expect(sheet.model).toBe("deepseek-v4-flash");
    expect(sheet.per1MTokensUsd.inputCacheHit).toBeGreaterThan(0);
    expect(sheet.per1MTokensUsd.inputCacheMiss).toBeGreaterThan(sheet.per1MTokensUsd.inputCacheHit);
    expect(sheet.per1MTokensUsd.output).toBeGreaterThan(0);
    expect(sheet.sourceUrl).toMatch(/^https:\/\//);
    expect(sheet.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("budget.json is a valid budget with the spec-pinned refusal fraction", () => {
    const budget = loadBudget(join(briefsDir, "budget.json"));
    expect(budget.capUsd).toBeGreaterThan(0);
    expect(budget.refusalFraction).toBe(0.9);
  });

  it("rejects a price sheet with a missing rate", () => {
    const bad = join(dir, "bad-prices.json");
    writeFileSync(
      bad,
      JSON.stringify({
        model: "m",
        currency: "USD",
        per1MTokensUsd: { inputCacheHit: 1, output: 2 },
        sourceUrl: "https://example.com",
        retrievedAt: "2026-01-01",
      }),
    );
    expect(() => loadPriceSheet(bad)).toThrow(/inputCacheMiss/);
  });

  it("rejects a budget with a refusal fraction outside (0, 1]", () => {
    const bad = join(dir, "bad-budget.json");
    writeFileSync(bad, JSON.stringify({ capUsd: 200, refusalFraction: 1.5 }));
    expect(() => loadBudget(bad)).toThrow(/refusalFraction/);
  });
});
