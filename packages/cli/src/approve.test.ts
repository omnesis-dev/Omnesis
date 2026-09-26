// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { approveInteractive } from "./approve.js";

describe("approveInteractive", () => {
  test("--yes answers a skippable interruption without a terminal", async () => {
    await expect(approveInteractive("Restart openclaw now?", true)).resolves.toBe(true);
  });

  // vitest runs without a TTY on stdin, which is the unattended case.
  test.skipIf(process.stdin.isTTY)(
    "without --yes and without a terminal, the interruption is declined, never blocked on",
    async () => {
      await expect(approveInteractive("Restart openclaw now?", false)).resolves.toBe(false);
    },
  );
});
