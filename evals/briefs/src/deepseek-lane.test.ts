// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The deepseek lane's safety properties, unit-tested with zero network
 * and zero spend: the CI hard-refusal (criterion 16's mandated test),
 * key resolution + the never-print-the-key projection, the worst-case
 * knob validation, and the reserve-then-run guard's pricing math over a
 * real SpendMeter on temp ledgers.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertDeepseekLaneAllowed,
  createMeteredRunGuard,
  DeepseekLaneRefusedError,
  defaultDurableLedgerPath,
  defaultOperatorConfigPath,
  describeDeepseekBackend,
  loadWorstCasePerRun,
  resolveDeepseekBackend,
} from "./deepseek-lane.js";
import { SpendMeter, readSpendRecords, type PriceSheet } from "./spend-meter.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "briefs-deepseek-lane-"));
  tempDirs.push(dir);
  return dir;
}

const PRICES: PriceSheet = {
  model: "test-model",
  currency: "USD",
  per1MTokensUsd: { inputCacheHit: 0.001, inputCacheMiss: 0.1, output: 0.2 },
  sourceUrl: "https://example.com/pricing",
  retrievedAt: "2026-07-01",
};

describe("assertDeepseekLaneAllowed", () => {
  test("hard-refuses when CI is set to ANY value, allows when unset or empty", () => {
    expect(() => assertDeepseekLaneAllowed({ CI: "true" })).toThrow(DeepseekLaneRefusedError);
    expect(() => assertDeepseekLaneAllowed({ CI: "false" })).toThrow(DeepseekLaneRefusedError);
    expect(() => assertDeepseekLaneAllowed({ CI: "0" })).toThrow(DeepseekLaneRefusedError);
    expect(() => assertDeepseekLaneAllowed({})).not.toThrow();
    expect(() => assertDeepseekLaneAllowed({ CI: "" })).not.toThrow();
  });
});

describe("resolveDeepseekBackend", () => {
  test("env overrides win and must come as a pair", () => {
    expect(
      resolveDeepseekBackend({
        env: {
          OMNESIS_BRIEFS_DEEPSEEK_URL: "https://api.example.com",
          OMNESIS_BRIEFS_DEEPSEEK_KEY: "sk-test",
        },
        configPath: "/nonexistent/omnesis.json",
      }),
    ).toEqual({ url: "https://api.example.com", apiKey: "sk-test", source: "env" });
    expect(() =>
      resolveDeepseekBackend({
        env: { OMNESIS_BRIEFS_DEEPSEEK_URL: "https://api.example.com" },
        configPath: "/nonexistent/omnesis.json",
      }),
    ).toThrow(/must be set together/);
  });

  test("falls back to inference.backends.deepseek in the operator config", () => {
    const dir = tempDir();
    const configPath = join(dir, "omnesis.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        inference: {
          backends: { deepseek: { url: "https://cfg.example.com", apiKey: "sk-cfg" } },
        },
      }),
    );
    expect(resolveDeepseekBackend({ env: {}, configPath })).toEqual({
      url: "https://cfg.example.com",
      apiKey: "sk-cfg",
      source: "config",
    });

    writeFileSync(configPath, JSON.stringify({ inference: { backends: {} } }));
    expect(() => resolveDeepseekBackend({ env: {}, configPath })).toThrow(/missing/);
    expect(() => resolveDeepseekBackend({ env: {}, configPath: join(dir, "absent.json") })).toThrow(
      /no deepseek backend/,
    );
  });

  test("the printable projection never contains the key", () => {
    const description = describeDeepseekBackend({
      url: "https://api.example.com",
      apiKey: "sk-supersecret",
      source: "env",
    });
    expect(description).not.toContain("sk-supersecret");
    expect(description).toContain("<redacted>");
  });
});

describe("config path helpers", () => {
  test("honour env overrides and fall back to the defaults", () => {
    expect(defaultOperatorConfigPath({ OMNESIS_CONFIG_DIR: "/x" })).toBe("/x/omnesis.json");
    expect(defaultOperatorConfigPath({})).toMatch(/\.config\/omnesis\/omnesis\.json$/);
    expect(defaultDurableLedgerPath({ OMNESIS_BRIEFS_SPEND_LEDGER: "/y/ledger.jsonl" })).toBe(
      "/y/ledger.jsonl",
    );
    expect(defaultDurableLedgerPath({})).toMatch(/\.config\/omnesis-epic\/briefs-spend\.jsonl$/);
  });
});

describe("loadWorstCasePerRun", () => {
  test("loads the committed knob shape and rejects malformed ones", () => {
    const dir = tempDir();
    const path = join(dir, "budget.json");
    writeFileSync(
      path,
      JSON.stringify({ worstCasePerRun: { promptTokens: 250_000, completionTokens: 8_000 } }),
    );
    expect(loadWorstCasePerRun(path)).toEqual({ promptTokens: 250_000, completionTokens: 8_000 });

    writeFileSync(path, JSON.stringify({}));
    expect(() => loadWorstCasePerRun(path)).toThrow(/worstCasePerRun/);
    writeFileSync(
      path,
      JSON.stringify({ worstCasePerRun: { promptTokens: 0, completionTokens: 1 } }),
    );
    expect(() => loadWorstCasePerRun(path)).toThrow(/positive/);
  });

  test("the committed budget.json parses", () => {
    const committed = join(import.meta.dirname, "..", "budget.json");
    const worstCase = loadWorstCasePerRun(committed);
    expect(worstCase.promptTokens).toBeGreaterThan(0);
    expect(worstCase.completionTokens).toBeGreaterThan(0);
  });
});

describe("createMeteredRunGuard", () => {
  test("reserve-then-settle prices the cache split and namespaces run ids", () => {
    const dir = tempDir();
    const ledger = join(dir, "ledger.jsonl");
    const meter = new SpendMeter(PRICES, {
      budget: { capUsd: 100, refusalFraction: 0.9 },
      ledgerPaths: [ledger],
    });
    const guard = createMeteredRunGuard(meter, "invocation-1", {
      promptTokens: 10_000,
      completionTokens: 500,
    });

    guard.reserve("doc-a#created");
    guard.settle("doc-a#created", {
      promptTokens: 2_000,
      completionTokens: 100,
      cacheReadTokens: 1_500,
    });

    const records = readSpendRecords(ledger);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "spend-reserve",
      runId: "invocation-1:doc-a#created",
    });
    // 1.5k prompt at cache-hit $0.001/M + 500 at cache-miss $0.1/M + 100 output at $0.2/M.
    expect(records[1]).toMatchObject({
      kind: "spend-settle",
      runId: "invocation-1:doc-a#created",
      usage: { promptCacheHitTokens: 1_500, promptCacheMissTokens: 500, completionTokens: 100 },
    });
    expect((records[1] as { usd: number }).usd).toBeCloseTo(0.0000715, 10);
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("the guard inherits the meter's cap refusal", () => {
    const dir = tempDir();
    const meter = new SpendMeter(PRICES, {
      // Cap so small the first worst-case reservation must refuse.
      budget: { capUsd: 0.0001, refusalFraction: 0.9 },
      ledgerPaths: [join(dir, "ledger.jsonl")],
    });
    const guard = createMeteredRunGuard(meter, "invocation-2", {
      promptTokens: 10_000,
      completionTokens: 500,
    });
    expect(() => guard.reserve("doc-b#created")).toThrow(/Spend cap/);
  });
});
