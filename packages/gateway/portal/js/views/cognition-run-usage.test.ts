// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
// @ts-expect-error Plain JavaScript portal module.
import { formatRecordedUsage, runUsageLabel, TranscriptUsage } from "./cognition-run-usage.js";

function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object") {
    const v = node as { props?: { children?: unknown } };
    return text(v.props?.children);
  }
  return String(node);
}

it("shows failed-attempt usage even when the failed run has no usage row", () => {
  const transcript = {
    attempt: 2,
    outcome: "failed",
    usage: { promptTokens: 2500, completionTokens: 120, cacheReadTokens: 2000 },
    // Cumulative live events must not be summed into the recorded receipt.
    events: [{ usage: { inputTokens: 500 } }, { usage: { inputTokens: 500 } }],
  };
  expect(runUsageLabel({ status: "failed", usage: null }, [{ attempt: 2 }])).toContain(
    "each transcript attempt below",
  );
  const rendered = text(TranscriptUsage({ transcript }));
  expect(rendered).toContain("Attempt 2 tokens:");
  expect(rendered).toContain("2,500 input (2,000 cached) / 120 output");
  expect(rendered).toContain("not a run total");
});

it("does not duplicate a completed run receipt above its transcript", () => {
  expect(
    runUsageLabel({ usage: { promptTokens: 50, completionTokens: 5 } }, [{ attempt: 1 }]),
  ).not.toContain("50");
});

it("leaves missing attempt usage unknown even if cumulative events exist", () => {
  const rendered = text(
    TranscriptUsage({ transcript: { attempt: 3, usage: null, events: [{ inputTokens: 700 }] } }),
  );
  expect(rendered).toContain("Not reported");
  expect(rendered).toContain("does not mean zero tokens");
  expect(rendered).not.toContain("700");
  expect(runUsageLabel({ attempts: 3, usage: null }, [])).toBe("Not reported");
});

it("retains explicit zero usage and normalized cache creation without adding cache twice", () => {
  expect(formatRecordedUsage({ promptTokens: 0, completionTokens: 0 })).toBe("0 input / 0 output");
  expect(
    formatRecordedUsage({ promptTokens: 100, completionTokens: 3, cacheReadTokens: 60, cacheCreationTokens: 20 }),
  ).toBe("100 input (60 cached) (20 cache creation) / 3 output");
  expect(runUsageLabel({ usage: { promptTokens: 100, completionTokens: 3 } }, [])).toBe(
    "Run record: 100 input / 3 output",
  );
});
