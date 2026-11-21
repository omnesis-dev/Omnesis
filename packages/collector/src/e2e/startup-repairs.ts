// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { waitForCondition } from "./multi-collector-harness.js";
import type { StartupSnapshot } from "@omnesis/gateway/src/startup/manager.js";

export type StartupRepairsSnapshot = Pick<StartupSnapshot, "steps">;

/** Background job catalog entries can precede live registration behind boot repairs. */
export async function waitForStartupRepairs(
  read: (path: string) => Promise<StartupRepairsSnapshot>,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForCondition(
    async () => {
      const snapshot = await read("/.well-known/omnesis-startup");
      const repairs = snapshot.steps.find((step) => step.id === "repairs");
      if (repairs?.state === "failed" || repairs?.state === "blocked")
        throw new Error("Gateway startup repairs failed before background task registration");
      return repairs?.state === "succeeded";
    },
    timeoutMs,
    "gateway startup repairs to finish before running background tasks",
  );
}
