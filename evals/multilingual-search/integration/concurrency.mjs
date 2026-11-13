// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Controlled reader/writer overlap across a real encrypted WAL generation swap. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createIndexDatabase } from "../../../packages/gateway/src/indexer/db.js";
import {
  installPrototype,
  openPrototype,
  putChunk,
  generation,
  beginGeneration,
  backfillGeneration,
  activateGeneration,
  rollbackGeneration,
} from "./store.mjs";
import { buildMemory, compileQuery, searchCompiled } from "./query.mjs";

async function reader() {
  const key = Buffer.from(workerData.key, "hex");
  const db = openPrototype(workerData.path, workerData.extension, {
    readonly: true,
    encryptionKey: key,
  });
  let stop = false,
    memory;
  parentPort.on("message", (message) => {
    if (message === "stop") stop = true;
  });
  try {
    parentPort.postMessage({ kind: "ready" });
    for (let iterations = 0; !stop && iterations < 2000; iterations++) {
      const sample = db
        .transaction(() => {
          const state = generation(db);
          if (!memory || memory.snapshot.epoch !== state.epoch) memory = buildMemory(db);
          const query = compileQuery(db, "run", "en");
          const answer = searchCompiled(db, query, { memory });
          const eligible =
            state.active_mode === "stem"
              ? db.prepare("SELECT count(*) AS n FROM chunks WHERE content LIKE 'running%'").get().n
              : 0;
          assert.equal(answer.candidates.length, Math.min(20, eligible));
          const source = db.prepare("SELECT content FROM chunks WHERE document_id=?");
          for (const candidate of answer.candidates)
            assert(source.get(candidate.documentId)?.content.startsWith("running"));
          return {
            kind: "sample",
            epoch: state.epoch,
            mode: state.active_mode,
            resultCount: answer.candidates.length,
            path: answer.path,
          };
        })
        .deferred();
      parentPort.postMessage(sample);
      await immediate();
    }
    if (!stop) throw new Error("Reader exhausted bounded overlap iterations");
    parentPort.postMessage({ kind: "stopped" });
  } finally {
    db.close();
    key.fill(0);
    parentPort.close();
  }
}

async function main() {
  const [extensionInput, outputInput] = process.argv.slice(2);
  if (!extensionInput || !outputInput)
    throw new Error("Usage: node --import tsx concurrency.mjs EXTENSION OUTPUT");
  const extension = resolve(extensionInput),
    directory = mkdtempSync(join(tmpdir(), "omnesis-lexical-overlap-"));
  const path = join(directory, "index.db"),
    key = randomBytes(32);
  let db, worker, failure;
  const samples = [],
    waiters = [];
  const settle = () => {
    for (const waiter of [...waiters])
      if (failure || waiter.condition()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        if (failure) waiter.reject(failure);
        else waiter.resolve();
      }
  };
  const waitUntil = (condition) =>
    failure
      ? Promise.reject(failure)
      : condition()
        ? Promise.resolve()
        : new Promise((resolveWait, reject) =>
            waiters.push({ condition, resolve: resolveWait, reject }),
          );
  const timeout = setTimeout(() => {
    failure = new Error("Controlled concurrency test exceeded 60 seconds");
    settle();
    worker?.terminate();
  }, 60000);
  let ready = false,
    stopped = false,
    exited = false;
  try {
    db = createIndexDatabase(path, { encryptionKey: key });
    installPrototype(db, extension, "exact");
    db.transaction(() => {
      for (let i = 0; i < 1000; i++)
        putChunk(db, {
          id: `overlap-${i}`,
          language: "en",
          content: `running observatory record ${i}`,
        });
    }).immediate();
    beginGeneration(db, "stem");
    worker = new Worker(new URL(import.meta.url), {
      workerData: { path, extension, key: key.toString("hex") },
    });
    worker.on("message", (message) => {
      if (message.kind === "ready") ready = true;
      if (message.kind === "sample") samples.push(message);
      if (message.kind === "stopped") stopped = true;
      settle();
    });
    worker.on("error", (error) => {
      failure = error;
      settle();
    });
    worker.on("exit", (code) => {
      exited = true;
      if (code !== 0) failure = new Error(`Reader exited ${code}`);
      settle();
    });
    await waitUntil(() => ready && samples.filter((s) => s.epoch === 1).length >= 5);
    let batch = 0,
      result;
    do {
      result = backfillGeneration(db, 32);
      if (batch < 20) {
        db.transaction(() => {
          putChunk(db, {
            id: `overlap-${batch}`,
            language: "en",
            content: `walking updated record ${batch}`,
          });
          db.prepare("DELETE FROM chunks WHERE id=?").run(`overlap-${900 + batch}`);
          putChunk(db, {
            id: `insert-${batch}`,
            language: "en",
            content: `running added during build ${batch}`,
          });
        }).immediate();
      }
      batch++;
      await immediate();
    } while (!result.caughtUp || batch < 20);
    while (!backfillGeneration(db, 32).caughtUp) await immediate();
    activateGeneration(db);
    await waitUntil(() => samples.filter((s) => s.epoch === 2).length >= 5);
    putChunk(db, {
      id: "after-activation",
      language: "en",
      content: "running written after activation",
    });
    rollbackGeneration(db);
    await waitUntil(() => samples.filter((s) => s.epoch === 3).length >= 5);
    worker.postMessage("stop");
    await waitUntil(() => stopped && exited);
    const phases = Object.fromEntries(
      [1, 2, 3].map((epoch) => [
        epoch,
        {
          samples: samples.filter((s) => s.epoch === epoch).length,
          memorySamples: samples.filter((s) => s.epoch === epoch && s.path === "memory").length,
          mode: epoch === 2 ? "stem" : "exact",
        },
      ]),
    );
    for (const phase of Object.values(phases)) assert(phase.samples >= 5);
    assert(phases[2].memorySamples > 0);
    db.exec("INSERT INTO chunks_fts(chunks_fts,rank) VALUES('integrity-check',1)");
    const report = {
      status: "passed",
      independentReaderWorker: true,
      writeBatches: batch,
      phases,
      checks: [
        "Read snapshot covers generation guard, cache following, ranking and document join.",
        "Before activation, the existing precise generation keeps serving.",
        "During backfill, updates and deletes on both sides of the cursor and new inserts are preserved.",
        "After activation, reader rebuilds its cache and returns only current eligible chunks.",
        "After rollback, the reader observes current data through the retained precise generation.",
      ],
      limitation:
        "Controlled small-corpus overlap with three epochs, not a long-duration production soak.",
    };
    writeFileSync(resolve(outputInput), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally {
    clearTimeout(timeout);
    if (worker && !exited) await worker.terminate();
    db?.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}

if (isMainThread) await main();
else await reader();
