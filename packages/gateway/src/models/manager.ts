// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * ModelManager — gateway-side glue for model installation, removal,
 * and status. Composes:
 *
 *   - the bundled catalog (read-only data)
 *   - the on-disk manifest (`<modelsDir>/manifest.json`)
 *   - the resumable downloader
 *   - the system-info snapshot
 *
 * What it does NOT do:
 *
 *   - Activate a model. Assignment lives in the `inference.assignments`
 *     config block. Switching is a config write — `configStore.onChange`
 *     in ConfigChangeOrchestrator detects the change and orchestrates
 *     the wipe-and-reindex (embedder) or hot-reload (agent).
 *   - Browse HuggingFace. Only bundled catalog ids are installable
 *     today; sideloading and HF browse are planned (see #21).
 *
 * This split keeps the manager small and lets it be tested without a
 * running indexer or search pipeline.
 */

import { join } from "node:path";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
// Re-imported here — already used elsewhere — to keep adoption colocated.
import {
  CATALOG,
  loadManifest,
  saveManifest,
  upsertManifestEntry,
  removeManifestEntry,
  findManifestEntry,
  PROVIDER_PRESETS,
  CAPABILITY_METADATA,
  experimentalVisible,
  resolveModelDisplay,
  type CatalogEntry,
  type GgufCatalogEntry,
  type ManifestEntry,
  type ModelsOverview,
  type ModelDisplay,
  type InferenceOverview,
  type CapabilityRole,
  createLogger,
} from "@omnesis/core";
import { hasAnthropicApiKey as hasAnthropicApiKeyFromCreds } from "../model-credentials.js";
import {
  startDownload,
  clearPartial,
  sha256OfFile,
  DownloadError,
  type DownloadProgress,
} from "./downloader.js";
import { sha256WithCache } from "./hash-cache.js";

const log = createLogger("gateway:models");

/**
 * Live view of one in-flight download. Surfaced via
 * `GET /admin/models/downloads` and the WS progress stream.
 */
export interface ActiveDownload {
  /** Server-assigned id, used by the WS progress payload + cancel API. */
  downloadId: string;
  /** Catalog id of the model being installed. */
  modelId: string;
  /** Filename being written. */
  filename: string;
  /** Latest progress snapshot. */
  progress: DownloadProgress;
  /** ISO timestamp when the download started. */
  startedAt: string;
}

export interface ModelsOverviewExtra extends ModelsOverview {
  activeDownloads: ActiveDownload[];
}

export type ProgressBroadcast =
  | { kind: "started"; downloadId: string; modelId: string; filename: string }
  | { kind: "progress"; downloadId: string; modelId: string; progress: DownloadProgress }
  | { kind: "completed"; downloadId: string; modelId: string; manifest: ManifestEntry }
  | { kind: "failed"; downloadId: string; modelId: string; code: string; message: string }
  | { kind: "cancelled"; downloadId: string; modelId: string };

export interface ModelManagerOptions {
  modelsDir: string;
  /**
   * Gateway-host config dir. Used by the default `hasAnthropicApiKey`
   * to look up `<configDir>/anthropic-credentials.json`. Tests that
   * supply their own `hasAnthropicApiKey` may omit this.
   */
  configDir?: string;
  /** Override path for tests. Defaults to `<modelsDir>/manifest.json`. */
  manifestPath?: string;
  /**
   * Broadcast hook. The gateway maps this to `wsServer.broadcast(...)`
   * with a throttled `model.download.progress` event so portals/CLIs
   * see live updates without flooding the bus.
   */
  onBroadcast?: (event: ProgressBroadcast) => void;
  /**
   * Lookup that returns true when an Anthropic API key is configured
   * (via the gateway's model-credentials file). Defaults to inspecting
   * the live credentials file under `configDir`. Tests may override.
   */
  hasAnthropicApiKey?: () => boolean;
  /** Live catalog snapshot. Defaults to the bundled catalog. */
  catalog?: () => readonly CatalogEntry[];
}

export class ModelManager {
  private readonly modelsDir: string;
  private readonly manifestPath: string;
  private readonly onBroadcast?: (event: ProgressBroadcast) => void;
  private readonly hasAnthropicApiKey: () => boolean;
  private readonly catalogSnapshot: () => readonly CatalogEntry[];
  private active = new Map<
    string,
    {
      abort: () => void;
      entry: GgufCatalogEntry;
      downloadId: string;
      progress: DownloadProgress;
      startedAt: string;
    }
  >();

  constructor(opts: ModelManagerOptions) {
    this.modelsDir = opts.modelsDir;
    this.manifestPath = opts.manifestPath ?? join(opts.modelsDir, "manifest.json");
    this.onBroadcast = opts.onBroadcast;
    this.catalogSnapshot = opts.catalog ?? (() => CATALOG);
    if (opts.hasAnthropicApiKey) {
      this.hasAnthropicApiKey = opts.hasAnthropicApiKey;
    } else if (opts.configDir) {
      const dir = opts.configDir;
      this.hasAnthropicApiKey = () => hasAnthropicApiKeyFromCreds(dir);
    } else {
      // No configDir and no override — defensive default. Tests that
      // care about API-key-presence semantics should pass either.
      this.hasAnthropicApiKey = () => false;
    }
  }

  /**
   * Reconcile the manifest against what's actually in the models
   * directory:
   *
   *   1. Drop manifest entries whose file vanished.
   *   2. **Adopt** any catalog-matching GGUF that's on disk but missing
   *      from the manifest. This catches operators upgrading from
   *      pre-model-manager Omnesis (where the file was hand-curled into
   *      `~/.config/omnesis/models/`) and sideloads that drop a known
   *      filename. Without this step, the resolver would say "Ready"
   *      (file exists) while the catalog row would still show "Install"
   *      (no manifest entry) — confusing and pushes the user toward a
   *      150 MB redundant download.
   *   3. Scrub stale `.partial` stragglers from a crashed prior run.
   *
   * Sha-256 of an adopted file is resolved once at startup, through the
   * cross-boot digest cache — hashing a model file costs seconds, and the
   * manifest is per-config-directory while the file it describes is not, so
   * the same digest would otherwise be re-derived by every fresh instance.
   */
  async reconcileOnStartup(): Promise<void> {
    const { manifest, warning } = loadManifest(this.manifestPath);
    if (warning) log.warn(warning);

    let next = manifest;
    let changed = false;

    // 1. Prune manifest entries whose file is gone.
    for (const entry of manifest.models) {
      const path = join(this.modelsDir, entry.filename);
      if (!existsSync(path)) {
        log.warn(`Manifest entry ${entry.id} → ${entry.filename} not found on disk; pruning`);
        next = removeManifestEntry(next, entry.id);
        changed = true;
      }
    }

    // 2. Adopt files on disk that match a catalog entry but aren't in
    //    the manifest yet.
    for (const entry of CATALOG) {
      if (entry.kind !== "gguf") continue;
      if (findManifestEntry(next, entry.id)) continue;
      const path = join(this.modelsDir, entry.filename);
      if (!existsSync(path)) continue;

      log.info(`Adopting existing ${entry.id} into manifest (resolving sha256…)`);
      try {
        const sha = await sha256WithCache(path, sha256OfFile);
        const stat = statSync(path);
        next = upsertManifestEntry(next, {
          id: entry.id,
          filename: entry.filename,
          sizeBytes: stat.size,
          sha256: sha,
          downloadedAt: stat.mtime.toISOString(),
          downloadedFrom: "adopted-from-disk",
        });
        changed = true;
        if (entry.sha256 && entry.sha256 !== sha) {
          log.warn(
            `Adopted ${entry.id} sha256 ${sha.slice(0, 12)}… does not match catalog ${entry.sha256.slice(0, 12)}… — the file on disk differs from the bundled-catalog version. Use 'cli model uninstall ${entry.id}' followed by a fresh install to converge.`,
          );
        } else {
          log.info(`Adopted ${entry.id} (${formatBytes(stat.size)}, sha256=${sha.slice(0, 12)}…)`);
        }
      } catch (err) {
        log.warn(
          `Failed to adopt ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (changed) saveManifest(this.manifestPath, next);

    // 3. Drop any `.partial` files left over from a crashed download.
    for (const entry of CATALOG) {
      if (entry.kind !== "gguf") continue;
      const partial = join(this.modelsDir, `${entry.filename}.partial`);
      if (existsSync(partial)) {
        log.info(`Cleaning up stale partial download: ${partial}`);
        clearPartial(this.modelsDir, entry.filename);
      }
    }
  }

  /**
   * Compose the snapshot served by `GET /admin/models`. The caller
   * supplies the pre-resolved `InferenceOverview` from the registry;
   * this method adds the catalog, manifest, and active downloads.
   */
  getOverview(inference: InferenceOverview): ModelsOverviewExtra {
    const { manifest } = loadManifest(this.manifestPath);
    const assignmentDisplays: Partial<Record<CapabilityRole, ModelDisplay>> = {};
    for (const [role, assignment] of Object.entries(inference.assignments)) {
      assignmentDisplays[role as CapabilityRole] = resolveModelDisplay(assignment);
    }
    const overview: ModelsOverview = {
      catalog: [...this.catalogSnapshot()],
      installed: [...manifest.models],
      inference,
      modelsDir: this.modelsDir,
      presets: [...PROVIDER_PRESETS],
      assignmentDisplays,
      // Only surface capabilities that have a card; hidden roles are plumbed
      // through but get no portal card. Experimental-only roles are withheld
      // unless the gateway runs in experimental mode, so clients never render
      // a card for a model the operator can't use.
      capabilities: Object.values(CAPABILITY_METADATA).filter(
        (c) => !c.hidden && (!c.experimental || experimentalVisible()),
      ),
    };
    return {
      ...overview,
      activeDownloads: Array.from(this.active.values()).map((a) => ({
        downloadId: a.downloadId,
        modelId: a.entry.id,
        filename: a.entry.filename,
        progress: a.progress,
        startedAt: a.startedAt,
      })),
    };
  }

  /** True if the model file (for GGUF) is on disk and recorded in the manifest. */
  isInstalled(catalogId: string): boolean {
    const entry = this.getCatalogEntry(catalogId);
    if (!entry) return false;
    if (entry.kind === "anthropic-api") return true; // always "installed"; availability is the API key
    const { manifest } = loadManifest(this.manifestPath);
    const m = findManifestEntry(manifest, catalogId);
    if (!m) return false;
    return existsSync(join(this.modelsDir, m.filename));
  }

  /** True iff a download is currently running for this catalog id. */
  isDownloading(catalogId: string): boolean {
    return this.active.has(catalogId);
  }

  /**
   * Begin downloading a GGUF catalog entry. Resolves immediately with
   * the assigned download id; progress + completion are surfaced via
   * the broadcast hook. Throws synchronously on input/state errors
   * (unknown id, already installed, already downloading, kind mismatch).
   */
  install(catalogId: string): { downloadId: string } {
    const entry = this.getCatalogEntry(catalogId);
    if (!entry) throw new Error(`unknown catalog id: ${catalogId}`);
    if (entry.kind !== "gguf") {
      throw new Error(`${catalogId} is not installable — it's a remote API model`);
    }
    if (this.isInstalled(catalogId)) {
      throw new Error(`${catalogId} is already installed`);
    }
    if (this.isDownloading(catalogId)) {
      throw new Error(`${catalogId} is already downloading`);
    }

    const downloadId = randomUUID();
    const startedAt = new Date().toISOString();
    const initialProgress: DownloadProgress = {
      downloadedBytes: 0,
      totalBytes: entry.sizeBytes,
      speedBytesPerSec: 0,
      etaMs: -1,
    };

    const handle = startDownload(entry, {
      modelsDir: this.modelsDir,
      onProgress: (progress) => {
        const a = this.active.get(catalogId);
        if (!a) return;
        a.progress = progress;
        this.onBroadcast?.({ kind: "progress", downloadId, modelId: catalogId, progress });
      },
    });
    this.active.set(catalogId, {
      abort: handle.abort,
      entry,
      downloadId,
      progress: initialProgress,
      startedAt,
    });
    this.onBroadcast?.({
      kind: "started",
      downloadId,
      modelId: catalogId,
      filename: entry.filename,
    });

    handle.done
      .then((info) => {
        const { manifest } = loadManifest(this.manifestPath);
        const manifestEntry: ManifestEntry = {
          id: entry.id,
          filename: entry.filename,
          sizeBytes: info.sizeBytes,
          sha256: info.sha256,
          downloadedAt: new Date().toISOString(),
          downloadedFrom: info.downloadedFrom,
        };
        saveManifest(this.manifestPath, upsertManifestEntry(manifest, manifestEntry));
        log.info(`Installed ${entry.id} (${formatBytes(info.sizeBytes)})`);
        this.active.delete(catalogId);
        this.onBroadcast?.({
          kind: "completed",
          downloadId,
          modelId: catalogId,
          manifest: manifestEntry,
        });
      })
      .catch((err) => {
        const code = err instanceof DownloadError ? err.code : "internal";
        const message = err instanceof Error ? err.message : String(err);
        this.active.delete(catalogId);
        if (code === "aborted") {
          log.info(`Cancelled download for ${entry.id}`);
          this.onBroadcast?.({ kind: "cancelled", downloadId, modelId: catalogId });
        } else {
          log.error(`Install failed for ${entry.id}: ${message}`);
          this.onBroadcast?.({ kind: "failed", downloadId, modelId: catalogId, code, message });
        }
      });

    return { downloadId };
  }

  /** Cancel an in-flight download. No-op if not active. */
  cancel(catalogId: string): boolean {
    const a = this.active.get(catalogId);
    if (!a) return false;
    a.abort();
    return true;
  }

  /**
   * Remove an installed GGUF from disk and the manifest. Refuses if
   * `isActive` says so — callers should pre-check via the resolver.
   */
  uninstall(catalogId: string, opts?: { isActive?: (id: string) => boolean }): void {
    const entry = this.getCatalogEntry(catalogId);
    const { manifest } = loadManifest(this.manifestPath);
    const manifestEntry = findManifestEntry(manifest, catalogId);
    if (!manifestEntry && !entry) {
      throw new Error(`unknown model: ${catalogId}`);
    }
    if (entry?.kind === "anthropic-api") {
      throw new Error(`${catalogId} is a remote API model — there's nothing on disk to remove`);
    }
    if (opts?.isActive?.(catalogId)) {
      throw new Error(`${catalogId} is currently active — switch to another model first`);
    }
    if (manifestEntry) {
      const path = join(this.modelsDir, manifestEntry.filename);
      try {
        unlinkSync(path);
      } catch {
        /* file may already be gone */
      }
      saveManifest(this.manifestPath, removeManifestEntry(manifest, catalogId));
    }
    log.info(`Uninstalled ${catalogId}`);
  }

  /**
   * Verify an installed model: existence + size + sha256. Returns the
   * issues found; an empty array means the model is healthy.
   */
  async doctor(catalogId: string): Promise<{ issues: string[] }> {
    const entry = this.getCatalogEntry(catalogId);
    const { manifest } = loadManifest(this.manifestPath);
    const m = findManifestEntry(manifest, catalogId);
    const issues: string[] = [];
    if (!m) {
      issues.push("no manifest entry");
      return { issues };
    }
    const path = join(this.modelsDir, m.filename);
    if (!existsSync(path)) {
      issues.push(`file missing at ${path}`);
      return { issues };
    }
    const size = statSync(path).size;
    if (size !== m.sizeBytes) {
      issues.push(`size mismatch: manifest=${m.sizeBytes} disk=${size}`);
    }
    const sha = await sha256OfFile(path);
    if (sha !== m.sha256) {
      issues.push(`sha256 mismatch: manifest=${m.sha256} computed=${sha}`);
    }
    if (entry?.kind === "gguf" && entry.sha256 && entry.sha256 !== sha) {
      issues.push(`catalog-pinned sha256 mismatch: catalog=${entry.sha256} computed=${sha}`);
    }
    return { issues };
  }

  /** Look up a model from the same live snapshot served by GET /admin/models. */
  getCatalogEntry(id: string): CatalogEntry | undefined {
    return this.catalogSnapshot().find((entry) => entry.id === id);
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${n} B`;
}
