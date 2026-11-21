// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Test-only `--import` preload for a spawned gateway. The gateway's module
// prewarm worker inherits the gateway's Node options, so this preload runs
// there too. In that worker only, every module load waits until the file named
// by OMNESIS_E2E_PREWARM_RELEASE exists; a test that never writes it holds the
// prewarm for good. The gateway's main thread is untouched.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread, workerData } from "node:worker_threads";

const release = process.env.OMNESIS_E2E_PREWARM_RELEASE;
if (!isMainThread && release && typeof workerData?.prewarmRoot === "string") {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  registerHooks({
    load(url, context, nextLoad) {
      while (!existsSync(release)) Atomics.wait(pause, 0, 0, 20);
      return nextLoad(url, context);
    },
  });
}
