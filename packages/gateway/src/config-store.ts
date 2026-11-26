// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import {
  atomicWriteFile,
  createLogger,
  newerSettingsPath,
  restoreNewerSettings,
  speechToSpeechAssignment,
} from "@omnesis/core";
import {
  applyMergePatch,
  legacyStorageRetentionBindingsFromInput,
  type LegacyStorageRetentionBinding,
  diffConfigPaths,
  type ConfigValidationError,
  type OmnesisConfig,
  validateConfig,
} from "@omnesis/config";

const log = createLogger("gateway:config");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Preserve omitted raw input before parsing, so the schema still supplies every required default. */
function preserveRecordingReview(candidate: unknown, required: boolean): unknown {
  if (!required || !isRecord(candidate)) return candidate;
  const inference = candidate.inference;
  if (inference !== undefined && !isRecord(inference)) return candidate;
  const recordings = inference?.recordings;
  if (recordings !== undefined && !isRecord(recordings)) return candidate;
  if (recordings?.restoreReviewRequired !== undefined) return candidate;
  return applyMergePatch(candidate, { inference: { recordings: { restoreReviewRequired: true } } });
}

function mergeLegacyStorageBindings(
  pending: readonly LegacyStorageRetentionBinding[],
  incoming: readonly LegacyStorageRetentionBinding[],
): LegacyStorageRetentionBinding[] {
  const bySource = new Map(incoming.map((binding) => [binding.sourceId, binding]));
  for (const binding of pending) bySource.set(binding.sourceId, binding);
  return [...bySource.values()];
}

/** Keep pre-upgrade source authority on disk until SQLite has durably recorded it. */
function retainLegacyStorageInput(
  config: OmnesisConfig,
  legacy: readonly LegacyStorageRetentionBinding[],
): unknown {
  const policies = config.gateway?.storage?.retention;
  if (legacy.length === 0 || policies === undefined) return config;
  return {
    ...config,
    gateway: {
      ...config.gateway,
      storage: {
        ...config.gateway?.storage,
        retention: policies.map((policy) => {
          const binding = legacy.find((row) => row.sourceId === policy.sourceId);
          return binding ? { ...policy, sourceCreatedAt: binding.sourceCreatedAt } : policy;
        }),
      },
    },
  };
}

/**
 * Thrown by {@link ConfigStore.load} when the config file exists but cannot be
 * parsed or validated at boot. It is fatal by design: the gateway must refuse
 * to start rather than run on an empty default config it would then persist
 * over the real one. Distinct type so startup code can render a clear operator
 * message (and tests can assert the fail-loud behaviour).
 */
export class ConfigBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigBootError";
  }
}

/**
 * Successful mutation — returns the new config and the set of RFC 6901 paths
 * that actually differ from the previous state (deduped against the patch if
 * the value was already equal).
 */
export interface ConfigMutationOk {
  ok: true;
  version: number;
  config: OmnesisConfig;
  changedPaths: string[];
}

export interface ConfigMutationErr {
  ok: false;
  errors: ConfigValidationError[];
}

export type ConfigMutationResult = ConfigMutationOk | ConfigMutationErr;

export interface ConfigLoadError {
  at: number;
  message: string;
  errors?: ConfigValidationError[];
}

export interface ConfigStatus {
  ok: boolean;
  version: number;
  lastLoadedAt: number;
  lastWrittenAt: number | null;
  lastError: ConfigLoadError | null;
}

/** Shared with a worker so queued operations can reject authority revoked by a later config edit. */
export interface ConfigRevisionFence {
  buffer: SharedArrayBuffer;
  revision: number;
}

export type ConfigChangeListener = (
  before: OmnesisConfig,
  after: OmnesisConfig,
  changedPaths: string[],
) => void | Promise<void>;

export interface ConfigStoreOptions {
  /** Absolute path to `omnesis.json`. */
  filePath: string;
  /** Debounce window for file-watcher events (ms). Defaults to 150ms. */
  watchDebounceMs?: number;
  /**
   * The running release. Given, boot first restores the settings an update
   * saved beside the file before an older release took it over
   * (`restoreNewerSettings`).
   */
  release?: string;
}

/**
 * ConfigStore — single source of truth for the gateway's parsed config.
 *
 * Responsibilities:
 *   • load the file at boot, validate, hold the parsed object in memory;
 *   • watch the file for external edits (vim, CLI, etc.) — debounced — and
 *     reload + broadcast when valid, keep previous + record lastError when not;
 *   • serialize mutations through an in-process async mutex so concurrent
 *     PATCHes don't race;
 *   • write atomically (tmp + rename) and remember the sha256 of each write
 *     so the watcher ignores our own echo;
 *   • keep listeners notified on every valid change (external OR internal).
 *
 * Intentional non-goals:
 *   • cross-process locking (we're the only writer in this deployment);
 *   • history / undo (restore from `.bak` or git);
 *   • DB mirror of the config (single source of truth is the file).
 */

export class ConfigStore {
  private readonly filePath: string;
  private readonly watchDebounceMs: number;
  private readonly release: string | undefined;

  private current: OmnesisConfig = {};
  private rawText = "";
  private observedDiskHash: string | null = null;
  private legacyStorageBindings: LegacyStorageRetentionBinding[] = [];
  private version = 0;
  private readonly revisionFence = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  private lastLoadedAt = 0;
  private lastWrittenAt: number | null = null;
  private lastError: ConfigLoadError | null = null;

  private lastWrittenHash: string | null = null;
  private watcher: FSWatcher | null = null;
  private watcherDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Promise chain used as an async mutex. Head is replaced on every acquire;
  // concurrent callers wait on the previous tail.
  private writeChain: Promise<unknown> = Promise.resolve();

  private readonly listeners = new Set<ConfigChangeListener>();

  constructor(opts: ConfigStoreOptions) {
    this.filePath = opts.filePath;
    this.watchDebounceMs = opts.watchDebounceMs ?? 150;
    this.release = opts.release;
  }

  /** Read + validate the file (or start with {} when missing). Starts the watcher. */
  async load(): Promise<void> {
    if (this.release !== undefined) this.restoreNewerSettings(this.release);
    this.readAndApply({ source: "boot" });
    this.startWatcher();
  }

  /** Stop the file watcher — for tests / shutdown. */
  stop(): void {
    if (this.watcherDebounceTimer) clearTimeout(this.watcherDebounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  get(): OmnesisConfig {
    return this.current;
  }

  getRaw(): string {
    return this.rawText;
  }

  /** Pending upgrade metadata stays available until its SQLite binding is acknowledged. */
  takeLegacyStorageRetentionBindings(): readonly LegacyStorageRetentionBinding[] {
    return this.legacyStorageBindings.map((binding) => ({ ...binding }));
  }

  /** Normalize disk only after the matching config's binding transaction committed. */
  async finishLegacyStorageRetentionUpgrade(expected: ConfigRevisionFence): Promise<boolean> {
    return this.acquire(async () => {
      if (
        expected.buffer !== this.revisionFence.buffer ||
        Atomics.load(this.revisionFence, 0) !== expected.revision
      )
        return false;
      if (this.legacyStorageBindings.length === 0) return true;
      // The watcher is debounced: do not normalize over an external edit
      // that has reached disk but has not yet advanced the in-memory fence.
      if (
        !existsSync(this.filePath) ||
        hashContent(readFileSync(this.filePath, "utf8")) !== this.observedDiskHash
      )
        return false;
      const serialized = JSON.stringify(this.current, null, 2) + "\n";
      await atomicWriteFile(this.filePath, serialized, { mode: 0o600, ensureDir: true });
      this.rawText = serialized;
      this.lastWrittenHash = hashContent(serialized);
      this.observedDiskHash = this.lastWrittenHash;
      this.legacyStorageBindings = [];
      this.lastWrittenAt = Date.now();
      return true;
    });
  }

  captureRevisionFence(): ConfigRevisionFence {
    return { buffer: this.revisionFence.buffer, revision: Atomics.load(this.revisionFence, 0) };
  }

  getStatus(): ConfigStatus {
    return {
      ok: this.lastError === null,
      version: this.version,
      lastLoadedAt: this.lastLoadedAt,
      lastWrittenAt: this.lastWrittenAt,
      lastError: this.lastError,
    };
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** RFC 7396 JSON Merge Patch applied under the write mutex. */
  async patch(patch: unknown): Promise<ConfigMutationResult> {
    return this.acquire(async () => {
      const candidate = applyMergePatch(this.current, patch);
      return this.validateAndCommit(candidate);
    });
  }

  /** Full replace, under the write mutex. */
  async put(nextConfig: unknown): Promise<ConfigMutationResult> {
    return this.acquire(async () => this.validateAndCommit(nextConfig));
  }

  /**
   * Compute and commit a config replacement under the same write mutex used by
   * PUT/PATCH. Routes that need to inspect the current config while preparing
   * durable side effects use this to avoid racing concurrent mutations.
   */
  async update(transform: (current: OmnesisConfig) => unknown): Promise<ConfigMutationResult> {
    return this.acquire(async () => this.validateAndCommit(transform(this.current)));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private advanceVersion(): void {
    this.version += 1;
    Atomics.add(this.revisionFence, 0, 1);
  }

  private restoreNewerSettings(release: string): void {
    const copy = newerSettingsPath(this.filePath);
    try {
      const outcome = restoreNewerSettings(this.filePath, release);
      if (outcome.kind === "unusable") {
        log.warn(
          `Ignoring ${copy}: ${outcome.reason}. Settings a newer release saved there before a ` +
            `downgrade were not restored; delete the file once nothing in it is needed.`,
        );
      } else if (outcome.kind === "restored" && outcome.restored.length > 0) {
        log.info(
          `Restored ${outcome.restored.length} setting(s) an older release had dropped from ` +
            `${basename(this.filePath)}: ${outcome.restored.join(", ")}`,
        );
      }
    } catch (err) {
      log.warn(
        `Could not restore the settings saved in ${copy}; keeping it for the next start: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: () => void = () => {};
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
    } catch {
      // Upstream failure in the chain doesn't block subsequent acquires.
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async validateAndCommit(candidate: unknown): Promise<ConfigMutationResult> {
    const validation = validateConfig(
      preserveRecordingReview(
        candidate,
        this.current.inference?.recordings?.restoreReviewRequired === true,
      ),
    );
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const before = this.current;
    const after = validation.config;
    const speech = after.inference?.assignments?.["speech-to-speech"];
    if (speech != null && !speechToSpeechAssignment(speech, after.inference?.backends)) {
      return {
        ok: false,
        errors: [
          {
            path: "inference.assignments.speech-to-speech",
            message:
              "Speech to speech requires a declared HTTPS api.openai.com backend assigned to gpt-live-1.",
          },
        ],
      };
    }
    const changedPaths = diffConfigPaths(before, after);
    if (changedPaths.length === 0) {
      // No-op mutation — still bump version? No: keep semantics tight, only
      // bump on real changes.
      return { ok: true, version: this.version, config: after, changedPaths: [] };
    }
    // Write file atomically, remember the hash so the upcoming watcher event
    // for our own write is ignored.
    const legacyBindings = mergeLegacyStorageBindings(
      this.legacyStorageBindings,
      legacyStorageRetentionBindingsFromInput(candidate),
    );
    const serialized =
      JSON.stringify(retainLegacyStorageInput(after, legacyBindings), null, 2) + "\n";
    await atomicWriteFile(this.filePath, serialized, { mode: 0o600, ensureDir: true });
    this.legacyStorageBindings = legacyBindings;
    this.current = after;
    this.rawText = JSON.stringify(after, null, 2) + "\n";
    this.advanceVersion();
    this.lastLoadedAt = Date.now();
    this.lastWrittenAt = this.lastLoadedAt;
    this.lastError = null;
    this.lastWrittenHash = hashContent(serialized);
    this.observedDiskHash = this.lastWrittenHash;
    this.notify(before, after, changedPaths).catch((err) => {
      log.warn(`Change listener threw: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { ok: true, version: this.version, config: after, changedPaths };
  }

  private readAndApply(ctx: { source: "boot" | "watcher" }): void {
    if (!existsSync(this.filePath)) {
      // Missing file on boot is fine — start empty.
      const before = this.current;
      this.current = {};
      this.rawText = "";
      this.lastLoadedAt = Date.now();
      this.lastError = null;
      if (ctx.source === "watcher") {
        const changed = diffConfigPaths(before, this.current);
        if (changed.length > 0) {
          this.advanceVersion();
          this.notify(before, this.current, changed).catch((err) => {
            log.warn(`Change listener threw: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
      return;
    }
    let rawText: string;
    try {
      rawText = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = { at: Date.now(), message };
      if (ctx.source === "boot") {
        // An existing-but-unreadable config file at boot (permissions, EISDIR,
        // I/O error) must halt startup, same as invalid JSON / failed
        // validation below. Degrading to the empty default config and then
        // persisting it over the real file is the catastrophe this guard
        // exists to prevent.
        throw new ConfigBootError(
          `Config at ${this.filePath} could not be read (${message}). ` +
            `Refusing to start on defaults — fix the file's permissions/path, then restart.`,
        );
      }
      log.error(`Failed to read config at ${this.filePath}, keeping previous config: ${message}`);
      return;
    }
    // Skip watcher echoes: if the hash matches what we just wrote, ignore.
    if (
      ctx.source === "watcher" &&
      this.lastWrittenHash &&
      hashContent(rawText) === this.lastWrittenHash
    ) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = rawText.trim() === "" ? {} : JSON.parse(rawText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = { at: Date.now(), message: `invalid JSON: ${message}` };
      if (ctx.source === "boot") {
        // Fail loud on boot. Booting on the empty in-memory config when the
        // file holds unparseable content would run the gateway on defaults
        // (wrong embedder, no inference backends) AND let the next write
        // persist that emptiness over the real config — the exact shape of a
        // catastrophic config loss. Refuse to start so the operator can fix it.
        throw new ConfigBootError(
          `Config at ${this.filePath} is not valid JSON (${message}). ` +
            `Refusing to start on defaults — fix or remove the file, then restart.`,
        );
      }
      log.warn(`Invalid JSON in ${this.filePath}, keeping previous config: ${message}`);
      return;
    }

    // The file-load path is lenient about unrecognized keys: a config written
    // by an older build can carry a since-removed key, and rejecting it
    // wholesale would drop the whole config to defaults. Strip + warn instead.
    // Interactive mutations (validateAndCommit) stay strict so typos are caught.
    const legacyStorageBindings = legacyStorageRetentionBindingsFromInput(parsed);
    const validation = validateConfig(parsed, { stripUnknownKeys: true });
    if (!validation.ok) {
      const summary = validation.errors.map((e) => `${e.path || "/"}: ${e.message}`).join("; ");
      this.lastError = {
        at: Date.now(),
        message: `validation failed: ${summary}`,
        errors: validation.errors,
      };
      if (ctx.source === "boot") {
        // Same fail-loud reasoning as the JSON branch: a genuinely invalid
        // config (a real type/range error that stripping can't repair) must
        // halt startup rather than silently degrade to defaults.
        throw new ConfigBootError(
          `Config at ${this.filePath} failed validation (${summary}). ` +
            `Refusing to start on defaults — fix the file, then restart.`,
        );
      }
      log.warn(`Invalid config in ${this.filePath}, keeping previous: ${summary}`);
      return;
    }
    if (validation.strippedKeys.length > 0) {
      // Say what was lost, not just what was dropped. A stripped key means the
      // settings under it are now at their defaults — which is not necessarily
      // the quiet outcome the operator would assume, since a default can be
      // "on". Naming that here is the difference between one warn line they
      // skim and one they act on.
      log.warn(
        `Dropped ${validation.strippedKeys.length} unrecognized key(s) from ${this.filePath} ` +
          `(removed or renamed in a newer schema): ${validation.strippedKeys.join(", ")}. ` +
          `Everything under them is now running at its DEFAULT, which may differ from what ` +
          `you had set. The rest of the config was applied unchanged.`,
      );
    }
    const before = this.current;
    const after = validation.config;
    const changedPaths = diffConfigPaths(before, after);
    this.legacyStorageBindings = mergeLegacyStorageBindings(
      this.legacyStorageBindings,
      legacyStorageBindings,
    );
    this.observedDiskHash = hashContent(rawText);
    this.current = after;
    // Keep the cached raw text consistent with the parsed config. When keys
    // were stripped, the on-disk text still carries them, so re-serialize the
    // cleaned config — otherwise getRaw() would expose keys get() has dropped,
    // and a raw-read → edit → strict PUT round-trip would reject them.
    this.rawText =
      validation.strippedKeys.length > 0 || legacyStorageBindings.length > 0
        ? JSON.stringify(after, null, 2) + "\n"
        : rawText;
    this.lastLoadedAt = Date.now();
    this.lastError = null;
    if (ctx.source === "boot" || changedPaths.length > 0) {
      this.advanceVersion();
    }
    if (ctx.source === "watcher" && changedPaths.length > 0) {
      this.notify(before, after, changedPaths).catch((err) => {
        log.warn(`Change listener threw: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private async notify(
    before: OmnesisConfig,
    after: OmnesisConfig,
    changedPaths: string[],
  ): Promise<void> {
    // Run listeners sequentially so a slow side effect (e.g. a DB reconcile)
    // doesn't interleave with a WS broadcast further down the chain.
    for (const listener of this.listeners) {
      await listener(before, after, changedPaths);
    }
  }

  private startWatcher(): void {
    const dir = dirname(this.filePath);
    const file = basename(this.filePath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Directory likely exists; ignore.
    }
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename !== file) return;
        if (this.watcherDebounceTimer) clearTimeout(this.watcherDebounceTimer);
        this.watcherDebounceTimer = setTimeout(() => {
          this.watcherDebounceTimer = null;
          // A native atomic publication may finish before its async writer joins.
          // Reload only after that mutation commits its in-memory state and hash.
          void this.acquire(() => Promise.resolve(this.readAndApply({ source: "watcher" }))).catch(
            (err) => {
              log.warn(
                `Config watcher reload failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          );
        }, this.watchDebounceMs);
      });
      log.info(`Watching config at ${this.filePath}`);
    } catch (err) {
      log.warn(
        `Failed to start config watcher at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Resolve the config-file path the gateway should use. */
export function defaultConfigPath(configDir: string): string {
  return join(configDir, "omnesis.json");
}
