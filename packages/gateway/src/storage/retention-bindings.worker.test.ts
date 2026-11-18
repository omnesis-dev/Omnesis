// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase, openReadOnlyDatabase } from "../db.js";
import { createSource } from "../data/repositories/SourceRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { runWithPriority } from "../priority.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { WriterTaskRunner } from "../scheduler/runners/writer.js";
import { writeGateFromScheduler } from "../scheduler/write-ops.js";
import {
  captureStorageRetentionBindingInputs,
  readBoundStorageRetentionPolicies,
  readStorageRetentionBinding,
  readStorageSourceIncarnation,
} from "./retention-bindings.js";

it("both real writer binding gates reject stale queued config fences and accept current ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "storage-binding-worker-"));
  const path = join(dir, "gateway.db");
  const seed = createDatabase(path);
  const device = createDevice(seed, { name: "Fictional collector", kind: "collector" });
  const source = createSource(seed, {
    type: SourceType("fictional-notes"),
    accountId: AccountId("archive"),
    deviceId: device.id,
  });
  const policy = { sourceId: source.id, maxAgeDays: 365 };
  seed.close();
  const db = openReadOnlyDatabase(path);
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new WriterTaskRunner({
      gatewayDbPath: path,
      journalMode: "WAL",
      workerUrl: new URL("../workers/writer-worker.ts", import.meta.url),
      workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
    }),
  );
  try {
    await scheduler.start();
    const writer = writeGateFromScheduler(scheduler);
    const revision = new Int32Array(new SharedArrayBuffer(4));
    const inputs = captureStorageRetentionBindingInputs(db, [policy]);
    scheduler.pauseBackground();
    const queuedReconcile = runWithPriority("background", () =>
      writer.reconcileStorageRetentionBindings({
        policies: inputs,
        authority: { buffer: revision.buffer, revision: 0 },
      }),
    );
    Atomics.store(revision, 0, 1);
    scheduler.resumeBackground();
    expect(await queuedReconcile).toEqual({ stale: true, changed: 0 });
    expect(readStorageRetentionBinding(db, policy.sourceId)).toBeNull();
    expect(
      await writer.reconcileStorageRetentionBindings({
        policies: inputs,
        authority: { buffer: revision.buffer, revision: 1 },
      }),
    ).toEqual({ stale: false, changed: 1 });
    const first = readBoundStorageRetentionPolicies(db, [policy])[0]!;
    scheduler.pauseBackground();
    const queuedBind = runWithPriority("background", () =>
      writer.bindStorageRetentionPolicy({
        ...policy,
        sourceIncarnation: readStorageSourceIncarnation(db, policy.sourceId)!,
        authority: { buffer: revision.buffer, revision: 1 },
      }),
    );
    Atomics.store(revision, 0, 2);
    scheduler.resumeBackground();
    expect(await queuedBind).toEqual({ stale: true, changed: 0 });
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([first]);
    expect(
      await writer.bindStorageRetentionPolicy({
        ...policy,
        sourceIncarnation: first.sourceIncarnation,
        authority: { buffer: revision.buffer, revision: 2 },
      }),
    ).toEqual({ stale: false, changed: 1 });
    expect(readBoundStorageRetentionPolicies(db, [policy])[0]!.bindingId).not.toBe(first.bindingId);
  } finally {
    await scheduler.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
