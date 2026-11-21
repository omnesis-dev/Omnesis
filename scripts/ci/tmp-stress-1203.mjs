// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Temporary load generator for a flaky-test measurement; not for merge.
import { Worker } from "node:worker_threads";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
const cpu = `for(;;){Math.sqrt(Math.random());}`;
for (let i = 0; i < cpus().length; i++) new Worker(cpu, { eval: true });
const file = join(tmpdir(), `stress-1203-${process.pid}.bin`);
const buf = Buffer.alloc(64 * 1024, 1);
process.on("SIGTERM", () => {
  rmSync(file, { force: true });
  process.exit(0);
});
for (;;) {
  const fd = openSync(file, "w");
  for (let i = 0; i < 64; i++) {
    writeSync(fd, buf);
    fsyncSync(fd);
  }
  closeSync(fd);
  await new Promise((r) => setImmediate(r));
}
