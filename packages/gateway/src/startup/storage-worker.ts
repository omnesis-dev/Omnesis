// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { assertNever } from "@omnesis/core";
import { closeDrainingWal, createDatabase, openReadOnlyDatabase } from "../db.js";
import {
  createIndexDatabase,
  enqueueDocumentIndexPurge,
  reconcileIndexForGatewaySchema,
  scrubPendingSourceIndexPurges,
} from "../indexer/db.js";
import { listInterruptedOmnesisChatRetentionDocumentIds } from "../sources/omnesis-chat/wiring.js";
import { quarantineCorruptUsearchAsync } from "../indexer/usearch-boot-guard.js";
import { tryUnlink } from "../indexer/usearch-sidecar-crypto.js";
import { prepareEncryptedGraphForBoot } from "../indexer/usearch-sidecar-boot.js";
import { resolveActiveUsearchTarget } from "../indexer/usearch-read-registry.js";
import type { StorageBootMessage, StorageBootRequest } from "./storage.js";

if (!parentPort) throw new Error("storage-worker must run as a worker thread");
const port = parentPort;
const post = (message: StorageBootMessage): void => port.postMessage(message);
const request = workerData as StorageBootRequest;
const cancellation = new AbortController();
const onCancel = (message: unknown): void => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "cancel"
  )
    cancellation.abort();
};
port.on("message", onCancel);

try {
  switch (request.operation) {
    case "database": {
      const db = createDatabase(request.options.path, {
        encryptionKey: request.options.encryptionKeyHex
          ? Buffer.from(request.options.encryptionKeyHex, "hex")
          : null,
        onMigrationProgress: (progress) => post({ type: "migration", progress }),
      });
      try {
        post({ type: "done", result: closeDrainingWal(db, () => {}) });
      } finally {
        if (db.open) db.close();
      }
      break;
    }
    case "index": {
      const {
        gatewayDbPath,
        gatewayDbKeyHex,
        indexDbPath,
        configDir,
        indexDbKeyHex,
        storageEncryptionEnabled,
      } = request.options;
      const key = indexDbKeyHex ? Buffer.from(indexDbKeyHex, "hex") : null;
      const mainDb = openReadOnlyDatabase(gatewayDbPath, {
        encryptionKey: gatewayDbKeyHex ? Buffer.from(gatewayDbKeyHex, "hex") : null,
      });
      try {
        const db = createIndexDatabase(indexDbPath, { encryptionKey: key });
        try {
          const interrupted = listInterruptedOmnesisChatRetentionDocumentIds(mainDb);
          for (const documentId of interrupted) enqueueDocumentIndexPurge(db, documentId, true);
          const reconciled = reconcileIndexForGatewaySchema(mainDb, db);
          const scrubbed = scrubPendingSourceIndexPurges(db);
          const restore = storageEncryptionEnabled
            ? prepareEncryptedGraphForBoot(db, configDir, key)
            : undefined;
          const target = resolveActiveUsearchTarget(db, configDir);
          const existed = existsSync(target.path);
          const validated = await quarantineCorruptUsearchAsync(
            target.path,
            target.dim,
            cancellation.signal,
          );
          if (storageEncryptionEnabled && existed && !existsSync(target.path))
            tryUnlink(`${target.path}.enc`);
          post({
            type: "done",
            result: {
              reconciled,
              scrubbed,
              interruptedPurges: interrupted.length,
              graph: { ...(restore ? { restore } : {}), validated },
            },
          });
        } finally {
          db.close();
        }
      } finally {
        mainDb.close();
      }
      break;
    }
    default:
      assertNever(request);
  }
} catch (err) {
  post({ type: "error", message: err instanceof Error ? err.message : String(err) });
} finally {
  port.off("message", onCancel);
  port.close();
}
