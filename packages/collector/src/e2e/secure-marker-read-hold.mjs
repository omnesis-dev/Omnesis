// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Test-only `--import` preload for a spawned gateway. It holds the main
// thread's read of one fail-closed marker file until the test closes the
// gateway's stdin, so the test can probe the startup listener while storage
// encryption is still being verified. The gateway's event loop stays free
// during the hold, and the gateway then reads and judges the real marker.
// Closing stdin is the only release: a test that dies releases the hold too.

import { createRequire, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { isMainThread } = require("node:worker_threads");
const target = process.env.OMNESIS_E2E_HOLD_MARKER_READ;
if (isMainThread && target) {
  const markerPath = resolve(target);
  const fsPromises = require("node:fs/promises");
  const readFile = fsPromises.readFile;
  let released;
  fsPromises.readFile = function heldReadFile(path, ...rest) {
    if (typeof path === "string" && resolve(path) === markerPath) {
      released ??= hold();
      return released.then(() => readFile.call(this, path, ...rest));
    }
    return readFile.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}

function hold() {
  return new Promise((release) => {
    process.stdin.once("end", release);
    process.stdin.once("error", release);
    process.stdin.once("close", release);
    process.stdin.resume();
    process.stderr.write("secure-marker-read-hold: held\n");
  });
}
