// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { applyPrivateUmask, resolveWorkerEntry } from "@omnesis/core";

// This process retains stdin as a parent-liveness channel while native database
// work executes on its worker thread. Parent loss kills the whole owned process,
// including a thread blocked inside a synchronous database operation.
applyPrivateUmask();
const MAX_INPUT = 72 * 1024 * 1024;
let header = Buffer.alloc(0),
  expected: number | undefined,
  bytes = 0;
let blocks: Buffer[] = [],
  started = false,
  finished = false;
function refuse(): never {
  process.exit(70);
}
process.stdin.on("end", () => {
  if (!finished) refuse();
});
process.stdin.on("error", refuse);
process.stdin.on("data", (value: Buffer) => {
  if (started) refuse();
  let block = value;
  if (expected === undefined) {
    const take = Math.min(4 - header.length, block.length);
    header = Buffer.concat([header, block.subarray(0, take)]);
    block = block.subarray(take);
    if (header.length < 4) return;
    expected = header.readUInt32BE();
    if (expected < 1 || expected > MAX_INPUT) refuse();
  }
  bytes += block.length;
  if (bytes > expected) refuse();
  if (block.length) blocks.push(block);
  if (bytes === expected) {
    started = true;
    let input: unknown;
    const frame = Buffer.concat(blocks, bytes);
    blocks = [];
    try {
      input = deserialize(frame);
    } catch {
      refuse();
    }
    const entry = resolveWorkerEntry("./worker.ts", import.meta.url, "../workers/register-tsx.mjs");
    const worker = new Worker(entry.url, {
      workerData: input,
      execArgv: entry.execArgv,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    frame.fill(0);
    worker.stdout?.resume();
    worker.stderr?.resume();
    let result: unknown,
      seen = false,
      invalid = false;
    worker.on("message", (message: unknown) => {
      if (seen) {
        invalid = true;
        return;
      }
      seen = true;
      result = message;
    });
    worker.once("error", () => {
      invalid = true;
    });
    worker.once("exit", (code) => {
      const output = JSON.stringify(
        code === 0 && seen && !invalid ? result : { ok: false, failureCode: "worker-load-or-exit" },
      );
      if (!output || Buffer.byteLength(output) > 64 * 1024) refuse();
      finished = true;
      process.stdout.write(output, () => process.exit(0));
    });
  }
});
