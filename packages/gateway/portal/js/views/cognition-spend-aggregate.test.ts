// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
// @ts-expect-error — the portal ships untyped ESM the gateway serves verbatim.
import { aggregateSpendByMechanism } from "./cognition.js";

interface SpendRow {
  day: string;
  mechanism: string;
  mechanismLabel?: string;
  modelId: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
}

const row = (over: Partial<SpendRow> & Pick<SpendRow, "mechanism">): SpendRow => ({
  day: "2026-07-02",
  modelId: "model-x",
  runs: 1,
  promptTokens: 10,
  completionTokens: 1,
  ...over,
});

describe("aggregateSpendByMechanism", () => {
  it("folds a mechanism's per-day, per-model rows into one line", () => {
    const out = aggregateSpendByMechanism([
      row({ mechanism: "noticing", mechanismLabel: "Noticing", promptTokens: 100 }),
      row({
        mechanism: "noticing",
        mechanismLabel: "Noticing",
        modelId: "model-y",
        day: "2026-07-03",
        promptTokens: 50,
        runs: 2,
      }),
    ]);
    expect(out).toEqual([{ mechanism: "noticing", label: "Noticing", runs: 3, tokens: 152 }]);
  });

  it("orders by total tokens, biggest spender first", () => {
    const out = aggregateSpendByMechanism([
      row({ mechanism: "small", promptTokens: 5 }),
      row({ mechanism: "large", promptTokens: 5_000 }),
      row({ mechanism: "medium", promptTokens: 500 }),
    ]);
    expect(out.map((m: { mechanism: string }) => m.mechanism)).toEqual([
      "large",
      "medium",
      "small",
    ]);
  });

  it("falls back to the raw id when the server sent no label", () => {
    // A gateway older than the label field, or a mechanism it has no name for.
    const out = aggregateSpendByMechanism([row({ mechanism: "entailment-gate" })]);
    expect(out[0].label).toBe("entailment-gate");
  });

  it("returns nothing for no rows", () => {
    expect(aggregateSpendByMechanism([])).toEqual([]);
  });
});
