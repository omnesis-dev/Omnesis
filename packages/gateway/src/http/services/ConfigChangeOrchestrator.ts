// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, makeEvent, type ResolvedAssignment } from "@omnesis/core";
import { type OmnesisConfig } from "@omnesis/config";
import { buildIndexerCutoffMap } from "../../workers/indexer-worker-proxy.js";
import { reconcileConfig } from "../../config-reconcile.js";
import { getSourceForMember, listSourceMembers } from "../../data/repositories/SourceRepository.js";
import { getDevice } from "../../data/repositories/DeviceRepository.js";
import { deviceSupportsExistingSourceExecution } from "../../data/repositories/SourceMemberConfigContractRepository.js";
import type { SourceId } from "@omnesis/types";
import type { InferenceRegistry } from "../../inference/registry.js";
import type Database from "better-sqlite3";
import type { ConfigStore } from "../../config-store.js";
import type { WriteGate } from "../../write-gate.js";
import type { DeviceWsServer } from "../../ws.js";
import type { IndexerWorkerProxy } from "../../workers/indexer-worker-proxy.js";

type Db = Database.Database;

const log = createLogger("gateway");

export interface ConfigChangeOrchestratorDeps {
  db: Db;
  writeGate: WriteGate;
  /** Lazy getter — the indexer proxy is null until startIndexer() finishes loading the model. */
  getIndexerProxy: () => IndexerWorkerProxy | null;
  inferenceRegistry: InferenceRegistry;
  applyEmbedSwap: () => Promise<void>;
  applyAgentSwap: () => Promise<void>;
}

/**
 * Extracted from index.ts: registers the four configStore.onChange listeners
 * (source reconciliation, broadcast, cutoff hot-reload, model swap) in a
 * single place. The wsServer reference is supplied via attachServer() because
 * the orchestrator may be constructed before the server in some bootstrap
 * orderings.
 */
export class ConfigChangeOrchestrator {
  private readonly db: Db;
  private readonly writeGate: WriteGate;
  private readonly getIndexerProxy: () => IndexerWorkerProxy | null;
  private readonly inferenceRegistry: InferenceRegistry;
  private readonly applyEmbedSwap: () => Promise<void>;
  private readonly applyAgentSwap: () => Promise<void>;
  private wsServer: DeviceWsServer | null = null;
  private sourceReconcileChain: Promise<void> = Promise.resolve();

  constructor(deps: ConfigChangeOrchestratorDeps) {
    this.db = deps.db;
    this.writeGate = deps.writeGate;
    this.getIndexerProxy = deps.getIndexerProxy;
    this.inferenceRegistry = deps.inferenceRegistry;
    this.applyEmbedSwap = deps.applyEmbedSwap;
    this.applyAgentSwap = deps.applyAgentSwap;
  }

  attachServer(server: DeviceWsServer): void {
    this.wsServer = server;
  }

  register(configStore: ConfigStore): void {
    // Reconcile listener runs first (registered first) — propagates file-side
    // source settings onto the DB sources.config column so runtime paths see
    // the new values without a restart.
    configStore.onChange((_before, after) => {
      // Separate file-watcher and API mutations may notify concurrently. Keep
      // their DB projections and member notifications in config-version order;
      // returning this run also makes the same event's config.changed follow it.
      const run = this.sourceReconcileChain
        .then(async () => {
          const report = await reconcileConfig(this.db, this.writeGate, after);
          if (report.sourcesUpdated > 0) {
            log.info(
              `Config reconcile: ${report.sourcesUpdated} source row${report.sourcesUpdated === 1 ? "" : "s"} updated from file`,
            );
          }
          await this.notifyReconciledSources(report.updatedSourceIds);
        })
        .catch((err) => {
          log.error(`Config reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      this.sourceReconcileChain = run;
      return run;
    });

    // Broadcast config changes (from PATCH/PUT and from external file edits) so
    // connected collectors re-fetch the current config. Payload is tiny — just
    // the changed JSON-pointer paths and a monotonically increasing version.
    configStore.onChange((_before, _after, changedPaths) => {
      this.wsServer?.broadcast(
        makeEvent("config.changed", {
          changedPaths,
          version: configStore.getStatus().version,
        }),
      );
    });

    // Hot-reload the indexer worker's per-source maxAge map whenever
    // dataRetention or sources.<id>.maxAge changes. The proxy may not be
    // ready at boot (model still loading) — the message is queued by Node's
    // MessageChannel and processed once the worker comes online. After ready,
    // every PATCH/PUT/file edit propagates without a restart.
    configStore.onChange((_before, after, changedPaths) => {
      const touchesCutoffs = changedPaths.some(
        (p) => p.startsWith("/dataRetention") || p.startsWith("/sources"),
      );
      if (!touchesCutoffs) return;
      const cutoffs = buildIndexerCutoffMap(after);
      this.getIndexerProxy()?.updateCutoffs(cutoffs);
    });

    // Model-switch listener. Compares the resolved model identity (not
    // the raw assignment string) so backend renames don't trigger a
    // reindex when the physical model hasn't changed.
    configStore.onChange((before: OmnesisConfig, after: OmnesisConfig) => {
      const assignmentChanged = (role: "embedder") =>
        JSON.stringify(before.inference?.assignments?.[role]) !==
        JSON.stringify(after.inference?.assignments?.[role]);

      // A standalone flip of `inference.allowRemoteInference` leaves every
      // assignment string identical, but the cached agent backend
      // (Anthropic/Codex SDK clients captured at boot) must be rebuilt so an
      // ON→OFF flip actually stops cloud egress — and OFF→ON re-enables an
      // already-assigned cloud backend — without a gateway restart.
      const egressChanged =
        (before.inference?.allowRemoteInference === true) !==
        (after.inference?.allowRemoteInference === true);

      if (assignmentChanged("embedder")) {
        this.inferenceRegistry.loadConfig(before);
        const beforeId = resolvedModelIdentity(this.inferenceRegistry.resolve("embedder"));
        this.inferenceRegistry.loadConfig(after);
        const afterId = resolvedModelIdentity(this.inferenceRegistry.resolve("embedder"));

        if (beforeId !== afterId) {
          log.info(`Embedder model identity changed: ${beforeId} → ${afterId}`);
          void this.applyEmbedSwap().catch((err) => {
            log.error(
              `embed swap failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
            );
          });
        } else {
          log.info(
            `Embedder assignment changed but model identity unchanged (${afterId}) — skipping reindex`,
          );
        }
      }

      const agentChanged =
        JSON.stringify(before.inference?.assignments?.agent) !==
        JSON.stringify(after.inference?.assignments?.agent);
      const agentBehaviorChanged =
        JSON.stringify(before.inference?.modelSettings?.agent) !==
        JSON.stringify(after.inference?.modelSettings?.agent);
      if (agentChanged || agentBehaviorChanged || egressChanged) {
        // Refresh the registry first so the rebuilt agent backend resolves
        // against the new assignment, model behavior, or egress flag.
        this.inferenceRegistry.loadConfig(after);
        void this.applyAgentSwap().catch((err) => {
          log.error(
            `agent swap failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          );
        });
      }

      const transcriberChanged =
        JSON.stringify(before.inference?.assignments?.transcriber) !==
        JSON.stringify(after.inference?.assignments?.transcriber);
      if (transcriberChanged) {
        // Refresh the registry so the TranscribeService — which resolves the
        // transcriber lazily through it and reloads the model when the resolved
        // assignment changes — picks up the new model on its next transcription.
        // No reprocessing of already-ingested audio: only future voice notes
        // are transcribed with the new model (resync a source to redo old ones).
        this.inferenceRegistry.loadConfig(after);
        log.info("Transcriber assignment changed — new model applies to future transcriptions");
      }

      const ocrChanged =
        JSON.stringify(before.inference?.assignments?.ocr) !==
          JSON.stringify(after.inference?.assignments?.ocr) ||
        JSON.stringify(before.inference?.ocr) !== JSON.stringify(after.inference?.ocr);
      if (ocrChanged) {
        // Refresh the registry so the OcrService — which resolves the `ocr`
        // assignment lazily through it and reloads the backend when the
        // resolved assignment changes — picks up the new backend on its next
        // request. No reprocessing of already-ingested attachments: only future
        // images are OCR'd with the new backend (resync a source to redo old
        // ones).
        this.inferenceRegistry.loadConfig(after);
        log.info("OCR assignment changed — new backend applies to future attachments");
      }
    });
  }

  private async notifyReconciledSources(sourceIds: readonly SourceId[]): Promise<void> {
    if (!this.wsServer) return;
    for (const sourceId of sourceIds) {
      for (const { deviceId } of listSourceMembers(this.db, sourceId)) {
        const source = getSourceForMember(this.db, sourceId, deviceId);
        const device = getDevice(this.db, deviceId);
        if (!source || !device || !deviceSupportsExistingSourceExecution(this.db, source, device)) {
          continue;
        }
        try {
          await this.wsServer.sendCommand(deviceId, "source.updated", { source });
        } catch (error) {
          log.debug(
            `Source config update not delivered to ${deviceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

/**
 * Extract a stable model identity string from a resolved assignment.
 * Two assignments with the same identity produce identical embeddings,
 * so a reindex is unnecessary when only the identity stays the same
 * (e.g. backend rename).
 */
function resolvedModelIdentity(r: ResolvedAssignment): string {
  switch (r.kind) {
    case "local":
      return `local:${r.catalogId}:${r.embedDim ?? "?"}`;
    case "http":
      return `http:${r.url}:${r.model}`;
    case "anthropic":
      return `anthropic:${r.apiModelId}`;
    case "codex":
      return `codex:${r.model}:${r.available}`;
    case "disabled":
      return "disabled";
    case "unresolved":
      return "unresolved";
    case "replay":
      return "replay";
  }
}
