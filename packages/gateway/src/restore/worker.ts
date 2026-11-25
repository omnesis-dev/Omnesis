// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { reconcileRestoredMainDatabase } from "./main-database.js";
import { reconcileRestoredMainEntry, inspectRestoredMainEntry } from "./entry-main.js";
const key = z.instanceof(Uint8Array).refine((value) => value.byteLength === 32);
const path = z.string().min(1).max(4096);
const base = z.object({
  targetPath: path,
  destinationPath: path,
  targetKey: key,
  destinationKey: key,
});
const entry = z
  .object({
    path,
    scope: path,
    targetRootKey: z.string().min(1).max(256),
    sourceRootKey: z.string().min(1).max(256),
    logicalName: z.enum(["omnesis.db", "omnesis.db.enc"]),
    sourceScope: path.nullable(),
    bytes: z
      .number()
      .int()
      .positive()
      .safe()
      .max(1024 ** 4),
  })
  .strict();
const inputSchema = z.union([
  base.extend({ action: z.literal("reconcile"), sourcePath: path, sourceKey: key }).strict(),
  base
    .extend({
      action: z.literal("reconcile"),
      sourceImage: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 64 * 1024 * 1024),
    })
    .strict(),
  base
    .extend({
      action: z.literal("entry"),
      sourceCipherPath: path,
      sourceKey: key.nullable(),
      entry,
    })
    .strict(),
  z
    .object({
      action: z.literal("entry-inspect"),
      sourceCipherPath: path,
      sourceKey: key.nullable(),
      entry,
    })
    .strict(),
]);
if (!parentPort) throw new Error("Restore worker requires its owned parent");
const keys: Buffer[] = [];
try {
  const input = inputSchema.parse(workerData);
  let result;
  if (input.action === "entry-inspect") {
    const sourceKey = input.sourceKey ? Buffer.from(input.sourceKey) : null;
    if (sourceKey) keys.push(sourceKey);
    result = await inspectRestoredMainEntry({ ...input, sourceKey });
  } else if (input.action === "entry") {
    const sourceKey = input.sourceKey ? Buffer.from(input.sourceKey) : null,
      targetKey = Buffer.from(input.targetKey),
      destinationKey = Buffer.from(input.destinationKey);
    keys.push(targetKey, destinationKey);
    if (sourceKey) keys.push(sourceKey);
    result = await reconcileRestoredMainEntry({ ...input, sourceKey, targetKey, destinationKey });
  } else {
    const targetKey = Buffer.from(input.targetKey),
      destinationKey = Buffer.from(input.destinationKey);
    keys.push(targetKey, destinationKey);
    const source =
      "sourcePath" in input
        ? { sourcePath: input.sourcePath, sourceKey: Buffer.from(input.sourceKey) }
        : { sourceImage: Buffer.from(input.sourceImage) };
    if (source.sourceKey) keys.push(source.sourceKey);
    if (source.sourceImage) keys.push(source.sourceImage);
    result = reconcileRestoredMainDatabase({
      ...source,
      targetPath: input.targetPath,
      destinationPath: input.destinationPath,
      targetKey,
      destinationKey,
    });
  }
  parentPort.postMessage({ ok: true, result });
} catch {
  parentPort.postMessage({ ok: false });
} finally {
  for (const key of keys) key.fill(0);
  if (typeof workerData === "object" && workerData !== null) {
    for (const name of ["sourceKey", "targetKey", "destinationKey", "sourceImage"]) {
      if (workerData[name] instanceof Uint8Array) workerData[name].fill(0);
    }
    if (workerData.entry && typeof workerData.entry === "object") {
      workerData.entry.sourceRootKey = "";
      workerData.entry.targetRootKey = "";
    }
  }
  parentPort.close();
}
