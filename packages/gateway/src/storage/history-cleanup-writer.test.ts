// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, openReadOnlyDatabase, upsertDocuments } from "../db.js";
import { initializeGatewayIndex } from "../startup/storage.js";
import { createIndexDatabase, openIndexDb } from "../indexer/db.js";
import { IndexerLifecycle, type IndexerLifecycleDeps } from "../indexer/indexer-lifecycle.js";
import { AgentLifecycle, type AgentLifecycleDeps } from "../agent/agent-lifecycle.js";
import { InferenceRegistry } from "../inference/registry.js";
import { FsConversationStore } from "../agent/conversation-store.js";
import { readConversationCleanupCandidates } from "../agent/conversation-retention.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { WriterTaskRunner } from "../scheduler/runners/writer.js";
import { writeGateFromScheduler } from "../scheduler/write-ops.js";
import { startHistoryCleanupJob, updateHistoryCleanupJob } from "./history-cleanup-store.js";
import { HistoryCleanupService } from "./history-cleanup-service.js";
import { conversationCleanupAdapter } from "./history-cleanup-conversations.js";

test("a disabled-model pending conversation drains 130 chunks through the runtime index callback and real writer thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-cleanup-writer-"));
  const mainPath = join(root, "gateway.db"),
    indexPath = join(root, "index.db");
  const before = "2032-01-01T00:00:00.000Z",
    older = "2030-01-01T00:00:00.000Z";
  const seed = createDatabase(mainPath);
  let index = createIndexDatabase(indexPath);
  const store = new FsConversationStore(join(root, "conversations"));
  await store.save({
    id: "invented-pending",
    callerId: "device:example",
    model: "scripted",
    backend: "scripted",
    createdAt: older,
    updatedAt: older,
    title: "Invented pending history",
    pinned: false,
    messages: [],
  });
  upsertDocuments(seed, [
    {
      providerId: ProviderId("system"),
      sourceId: SourceId("omnesis-chat"),
      externalId: "invented-pending",
      title: "Invented history",
      content: "Invented mirrored history",
      contentHash: "invented",
      metadata: {},
      sourceCreatedAt: older,
      sourceUpdatedAt: older,
    },
  ]);
  const docId = (
    seed.prepare("SELECT id FROM documents WHERE external_id=?").get("invented-pending") as {
      id: string;
    }
  ).id;
  const insert = index.prepare(
    "INSERT INTO chunks(id,document_id,chunk_index,content,source_id,title,source_created_at) VALUES(?,?,?,'Invented text','omnesis-chat','Invented title',?)",
  );
  for (let n = 0; n < 130; n++) insert.run("invented-chunk-" + n, docId, n, older);
  const inspected = (
    await readConversationCleanupCandidates(
      [{ id: "invented-pending", path: join(root, "conversations", "invented-pending.json") }],
      Date.parse(before),
    )
  )[0]!;
  const pending = startHistoryCleanupJob(seed, {
    request: { target: "conversations", before },
    now: 1,
  });
  updateHistoryCleanupJob(seed, {
    expectedRevision: pending.revision,
    job: {
      ...pending,
      state: "running",
      pending: {
        id: "invented-pending",
        identity: inspected.candidate!.fileIdentity,
        bytesEstimate: inspected.bytesEstimate,
        detail: older,
      },
    },
  });
  seed.close();
  index.close();
  await initializeGatewayIndex({
    gatewayDbPath: mainPath,
    indexDbPath: indexPath,
    configDir: root,
    storageEncryptionEnabled: false,
  });
  index = openIndexDb(indexPath);
  const db = openReadOnlyDatabase(mainPath);
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new WriterTaskRunner({
      gatewayDbPath: mainPath,
      journalMode: "WAL",
      workerUrl: new URL("../workers/writer-worker.ts", import.meta.url),
      workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
    }),
  );
  let agent: AgentLifecycle | undefined;
  let cleanup: HistoryCleanupService | undefined;
  try {
    await scheduler.start();
    const writes = writeGateFromScheduler(scheduler);
    const config = omnesisConfigSchema.parse({ inference: { assignments: {} } });
    const registry = new InferenceRegistry({
      modelsDir: join(root, "models"),
      configDir: root,
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
    });
    registry.loadConfig(config);
    const indexer = new IndexerLifecycle({
      indexDb: index,
      log: createLogger("test:history-indexer"),
      initialModelInfo: {
        name: "disabled",
        path: "",
        present: false,
        modelsDir: join(root, "models"),
      },
    } as unknown as IndexerLifecycleDeps);
    agent = new AgentLifecycle({
      config,
      configStore: { get: () => config },
      configDir: root,
      db,
      indexDb: index,
      writeGate: writes,
      inferenceRegistry: registry,
      conversationStore: store,
      log: createLogger("test:history-agent"),
      wsEventHandler: { attachAgentService: () => {} },
      deleteDocumentIndexBatch: (id: string, limit: number, sourceDeleted: boolean) =>
        indexer.deleteDocumentIndexBatch(id, limit, sourceDeleted),
    } as unknown as AgentLifecycleDeps);
    cleanup = new HistoryCleanupService({
      db,
      writes,
      adapters: { conversations: conversationCleanupAdapter(store, agent) },
    });
    await cleanup.initialize();
    await agent.bootAgent();
    expect(agent.routeDeps.agentService).toBeUndefined();
    for (let n = 0; n < 30; n++) {
      await cleanup.sweep();
      const job = cleanup.jobs().find((job) => job.id === pending.id)!;
      expect(job.state).not.toBe("failed");
      if (job.state === "completed") break;
    }
    expect(cleanup.jobs()[0]).toMatchObject({ state: "completed", removed: 1 });
    expect(await store.load("invented-pending")).toBeNull();
    expect(db.prepare("SELECT id FROM documents WHERE id=?").get(docId)).toBeUndefined();
    expect(index.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
  } finally {
    await cleanup?.dispose();
    await agent?.shutdown();
    await scheduler.dispose();
    await store.close();
    db.close();
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
