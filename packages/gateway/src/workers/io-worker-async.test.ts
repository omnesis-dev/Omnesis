// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { IoOps, ioGateFromScheduler } from "../scheduler/io-ops.js";
import type { TaskContext } from "../scheduler/types.js";
import type { ConversationRetentionFile } from "../agent/conversation-retention.js";
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
const methods = ["conversationRetentionCandidates", "conversationCleanupCandidates"] as const;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "io-async-"));
  const path = join(root, "gateway.db");
  const db = createDatabase(path);
  db.close();
  const files: ConversationRetentionFile[] = [];
  for (let n = 0; n < 32; n++) {
    const id = "invented-" + n;
    const path = join(root, id + ".json");
    writeFileSync(
      path,
      JSON.stringify({ id, updatedAt: "2030-01-01T00:00:00.000Z", pinned: false, messages: [] }),
    );
    files.push({ id, path });
  }
  const sent: string[] = [];
  const workers: Worker[] = [];
  const runner = new IoTaskRunner({
    gatewayDbPath: path,
    concurrency: 1,
    workerUrl: new URL("./io-worker.ts", import.meta.url),
    workerExecArgv: ["--import", new URL("./register-tsx.mjs", import.meta.url).href],
    createWorker: (url, opts) => {
      const worker = new Worker(url, opts);
      workers.push(worker);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (value, transfer) => {
        if (value?.type === "call") sent.push(value.op);
        post(value, transfer);
      };
      return worker;
    },
  });
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(runner);
  close.push(async () => {
    try {
      await scheduler.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await scheduler.start();
  return { runner, scheduler, io: ioGateFromScheduler(scheduler), files, sent, workers };
}
const cutoff = Date.parse("2032-01-01T00:00:00.000Z");
test.each(methods)(
  "real IO worker resolves asynchronous %s instead of posting a Promise",
  async (method) => {
    const f = await fixture();
    const result = await f.io[method](f.files, cutoff);
    expect(result).toHaveLength(32);
    expect(result[0]).toMatchObject(
      method === "conversationRetentionCandidates"
        ? {
            id: "invented-0",
            updatedAt: "2030-01-01T00:00:00.000Z",
            fileIdentity: expect.any(String),
          }
        : { id: "invented-0", candidate: { id: "invented-0", fileIdentity: expect.any(String) } },
    );
    expect(await f.io.echo("reader remains usable")).toBe("reader remains usable");
  },
);
test.each(methods)(
  "an asynchronous %s rejection is transported and leaves the worker usable",
  async (method) => {
    const f = await fixture();
    // Malformed internal arguments reject inside the real async handler before
    // its per-file recovery. This exercises rejection, not a forged worker error.
    await expect(
      f.io[method](null as unknown as ConversationRetentionFile[], cutoff),
    ).rejects.toThrow(/not iterable/);
    expect(await f.io.echo("worker survived rejection")).toBe("worker survived rejection");
  },
);
test.each(methods)(
  "disposal drains asynchronous %s and never dispatches its queued sibling",
  async (method) => {
    const f = await fixture();
    const task = IoOps.get("io." + method)!;
    const current = f.runner.exec(task, [f.files, cutoff], {} as TaskContext);
    const queued = f.runner.exec(
      IoOps.get("io.echo")!,
      ["must remain undispatched"],
      {} as TaskContext,
    );
    const rejected = expect(queued).rejects.toThrow(/shut down/);
    const stopped = f.runner.dispose();
    expect(f.runner.dispose()).toBe(stopped);
    const [outcome] = await Promise.all([current, stopped, rejected]);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.value).toHaveLength(32);
    expect(f.sent).toEqual(["io." + method]);
    expect(f.workers.every((worker) => worker.threadId === -1)).toBe(true);
  },
);
