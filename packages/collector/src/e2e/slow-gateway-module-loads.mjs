// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Test-only `--import` preload for a spawned gateway. Every module of the
// gateway package that its main thread loads takes a few milliseconds longer,
// so loading the runtime's module graph lasts seconds on any machine. The wait
// is synchronous, as module loading is: the startup listener can answer during
// it only if the gateway lets the event loop turn between modules.

import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

const DELAY_MS = 3;
const GATEWAY_SOURCE = "/packages/gateway/src/";

if (isMainThread) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  registerHooks({
    load(url, context, nextLoad) {
      if (url.includes(GATEWAY_SOURCE)) Atomics.wait(pause, 0, 0, DELAY_MS);
      return nextLoad(url, context);
    },
  });
}
