// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The failure summary and the detail cap are written twice: once in
 * `@omnesis/core`, for the collector, and once in `@omnesis/agent-integration`,
 * which is installed on harness machines with no workspace dependency to
 * import them from. Nothing at runtime would notice the copies drifting, so
 * this package, which depends on both, runs them against the same cases.
 */

import { describe, expect, test } from "vitest";
import {
  capDeviceUpdateDetail as coreCap,
  summarizeCommandFailure as coreSummary,
} from "@omnesis/core";
import {
  capDeviceUpdateDetail as pluginCap,
  summarizeCommandFailure as pluginSummary,
} from "@omnesis/agent-integration";

const OUTPUTS = [
  "",
  "\n\n",
  "single line",
  "Fetching…\nNo release v9.9.9 exists on this installation's remote.\n",
  "one\ntwo\nthree\nfour\n",
  "progress\n\nfirst\nsecond\n\n",
  "[31mred[0m\n]8;;https://example.orglink]8;;\nold\rnew\n",
  `Fetching\n${"x".repeat(20_000)}\nNo release v9.9.9 exists.\n`,
  `${"n".repeat(300)}\nCould not take a backup: ${"c".repeat(300)}\nPass --no-backup.\n`,
  `Could not take a backup: ${"c".repeat(565)}\nPass --no-backup to accept that risk.\n`,
  `${"y".repeat(30_000)}`,
  "\r\nwindows\r\nline endings\r\n",
];

describe("the failure summary as both packages state it", () => {
  test.each(OUTPUTS.map((output, index) => [index, output] as const))(
    "case %i summarizes the same way",
    (_index, output) => {
      expect(pluginSummary(output)).toBe(coreSummary(output));
    },
  );

  test.each([0, 1_999, 2_000, 2_001, 5_000].map((length) => [length] as const))(
    "a %i-character detail is capped the same way",
    (length) => {
      const detail = `${"d".repeat(Math.max(0, length - 2))}😀`.slice(0, length);
      expect(pluginCap(detail)).toBe(coreCap(detail));
    },
  );
});
