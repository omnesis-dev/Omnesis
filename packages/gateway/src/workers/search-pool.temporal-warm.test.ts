// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The pool warms its workers' date recognizer one worker at a time, and only
 * once asked: building the models takes a second or more of CPU per worker, so
 * warming every worker the moment it is ready would occupy as many cores as
 * there are workers, just as the gateway starts serving.
 *
 * The workers are stand-ins that speak the pool's protocol. Each records the
 * start and end of its warm-up in a journal file and finishes only once the
 * test releases it, so which worker warms when is observed, not timed. A
 * reading of a query's temporal intent is answered with the worker's thread id,
 * which shows where the pool sent it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { SearchWorkerPool } from "./search-pool.js";
import type { Worker } from "node:worker_threads";
import type { TemporalIntent } from "../search/temporal-intent.js";

let dir: string;
let journal: string;
let pool: SearchWorkerPool | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-temporal-warm-"));
  journal = join(dir, "journal");
  writeFileSync(journal, "");
});

afterEach(async () => {
  await pool?.dispose();
  pool = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function standInWorker(): URL {
  const source = `
    import { parentPort, threadId } from "node:worker_threads";
    import { appendFileSync, existsSync } from "node:fs";
    const post = (msg) => parentPort.postMessage(msg);
    const journal = ${JSON.stringify(journal)};
    const gate = ${JSON.stringify(join(dir, "release-"))} + threadId;
    parentPort.on("message", (msg) => {
      switch (msg.type) {
        case "init": post({ type: "ready" }); break;
        case "temporalIntent":
          post({ type: "result", id: msg.id, ok: true, value: { culture: String(threadId) },
                 queueMs: 0, execMs: 0, cpuUserUs: 0, cpuSystemUs: 0 });
          break;
        case "warmTemporalIntent": {
          appendFileSync(journal, "start " + threadId + "\\n");
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            appendFileSync(journal, "end " + threadId + "\\n");
            post({ type: "temporalIntentWarm" });
          }, 5);
          break;
        }
        case "shutdown": post({ type: "shutdownComplete" }); break;
      }
    });`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function startPool(concurrency: number, warmTemporalIntent = true): SearchWorkerPool {
  pool = new SearchWorkerPool({
    indexDbPath: join(dir, "index.db"),
    configDir: dir,
    concurrency,
    workerUrl: standInWorker(),
    warmTemporalIntent,
    respawnBaseDelayMs: 10,
  });
  return pool;
}

function entries(): string[] {
  return readFileSync(journal, "utf8").split("\n").filter(Boolean);
}

function release(threadId: string): void {
  writeFileSync(join(dir, `release-${threadId}`), "");
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The thread id of the worker that answered a reading. */
async function readingThread(p: SearchWorkerPool): Promise<string> {
  const read = (await p.temporalIntent("invoice last week", {
    nowMs: Date.parse("2026-03-02T09:00:00Z"),
    timeZone: "UTC",
    numericDateOrder: "day-first",
  })) as TemporalIntent;
  return read.culture;
}

function workerThreads(p: SearchWorkerPool): string[] {
  const slots = (p as unknown as { slots: Array<{ worker: Worker | null }> }).slots;
  return slots.map((s) => String(s.worker?.threadId));
}

test("warms nothing until asked, then one worker at a time, serving readings meanwhile", async () => {
  const p = startPool(3);
  await p.start();
  // One reading per worker: each worker handles its messages in order, so a
  // warm-up sent at `ready` would be in the journal before these replies.
  const answered = new Set<string>();
  for (let i = 0; i < 3; i++) answered.add(await readingThread(p));
  expect(answered.size).toBe(3);
  expect(entries()).toEqual([]);

  p.warmDateRecognizers();
  await waitFor("a first warm-up", () => entries().length === 1);
  const [first] = entries()[0]!.split(" ").slice(1);
  expect(entries()).toEqual([`start ${first}`]);

  release(first!);
  await waitFor("the second warm-up", () => entries().length === 3);
  const second = entries()[2]!.split(" ")[1]!;
  expect(entries()).toEqual([`start ${first}`, `end ${first}`, `start ${second}`]);
  expect(second).not.toBe(first);

  // While the second warms, every worker still serves readings.
  const meanwhile = new Set<string>();
  for (let i = 0; i < 3; i++) meanwhile.add(await readingThread(p));
  expect(meanwhile).toEqual(new Set(workerThreads(p)));

  release(second);
  await waitFor("the third warm-up", () => entries().length === 5);
  const third = entries()[4]!.split(" ")[1]!;
  release(third);
  await waitFor("the last warm-up to end", () => entries().length === 6);
  expect(entries()).toEqual([
    `start ${first}`,
    `end ${first}`,
    `start ${second}`,
    `end ${second}`,
    `start ${third}`,
    `end ${third}`,
  ]);
  expect(new Set([first, second, third])).toEqual(new Set(workerThreads(p)));

  // Asking again warms nobody twice.
  p.warmDateRecognizers();
  await readingThread(p);
  expect(entries()).toHaveLength(6);
});

test("a worker that dies while warming hands the turn on, and its replacement is warmed", async () => {
  const p = startPool(2);
  await p.start();
  p.warmDateRecognizers();
  await waitFor("a first warm-up", () => entries().length === 1);
  const dying = entries()[0]!.split(" ")[1]!;
  const slots = (p as unknown as { slots: Array<{ worker: Worker | null }> }).slots;
  const index = slots.findIndex((s) => String(s.worker?.threadId) === dying);
  await slots[index]!.worker!.terminate();

  await waitFor("the sibling's warm-up", () => entries().length === 2);
  const sibling = entries()[1]!.split(" ")[1]!;
  expect(sibling).not.toBe(dying);
  release(sibling);

  await waitFor("the replacement's warm-up", () => entries().length === 4);
  const replacement = entries()[3]!.split(" ")[1]!;
  expect(entries()).toEqual([
    `start ${dying}`,
    `start ${sibling}`,
    `end ${sibling}`,
    `start ${replacement}`,
  ]);
  expect(replacement).not.toBe(dying);
  expect(replacement).toBe(String(slots[index]!.worker?.threadId));
  release(replacement);
  await waitFor("the replacement's warm-up to end", () => entries().length === 5);
});

test("a pool whose temporal lane is off warms nothing", async () => {
  const p = startPool(2, false);
  await p.start();
  p.warmDateRecognizers();
  // Both workers answer after any warm-up request would have reached them.
  const answered = new Set([await readingThread(p), await readingThread(p)]);
  expect(answered).toEqual(new Set(workerThreads(p)));
  expect(entries()).toEqual([]);
});

test("a warm-up asked for while the workers start begins as the first one is ready", async () => {
  const p = startPool(2);
  const started = p.start();
  p.warmDateRecognizers();
  await started;
  await waitFor("a first warm-up", () => entries().length === 1);
  const first = entries()[0]!.split(" ")[1]!;
  release(first);
  await waitFor("the second warm-up", () => entries().length === 3);
  const second = entries()[2]!.split(" ")[1]!;
  release(second);
  await waitFor("the last warm-up to end", () => entries().length === 4);
  expect(new Set([first, second])).toEqual(new Set(workerThreads(p)));
});
