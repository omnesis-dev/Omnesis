// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeps the in-memory lexical index built and reasonably fresh.
 *
 * Between builds each ranker stays current on its own by following the
 * `chunks_fts_changes` log (see lexical-index.ts), but that costs a little more
 * per query as changes pile up, document frequencies age, and a ranker whose
 * delta fills hands its queries back to FTS5. So the service rebuilds once the
 * log holds {@link LexicalIndexServiceOptions.changeFraction} of the indexed
 * chunk count in changes since the last build, or once the index is older than
 * {@link LexicalIndexServiceOptions.maxAgeMs}. A failed build is retried with
 * exponential backoff; until a build lands, BM25 ranks with FTS5.
 *
 * It also completes a keyword-index rebuild to a new lexical version (see
 * indexer/lexical-index-store.ts). When the indexer reports that the new
 * version's index holds every chunk, the service builds the in-memory index
 * from it first, then asks for the switch, and publishes that index the moment
 * the switch lands, so search never falls back to slow FTS5 ranking for the
 * new version. Until then the current in-memory index keeps serving by its own
 * version's rules.
 */

import { createLogger } from "@omnesis/core";
import {
  lexicalIndexBytes,
  type LexicalIndexData,
  type LexicalIndexSource,
} from "./lexical-index-data.js";
import type { LexicalIndexBuild } from "../workers/lexical-index-build.js";

const log = createLogger("gateway:search:lexical");

/**
 * Builds of the new version's in-memory index a switch waits for. Past them it
 * switches without one rather than leave the rebuild waiting forever.
 */
const SWITCH_BUILD_ATTEMPTS = 3;

export interface LexicalIndexServiceOptions {
  /** Start one off-thread build of the active index, or of the one being rebuilt. */
  build: (source: LexicalIndexSource) => LexicalIndexBuild;
  /**
   * Make the backfilled rebuild of `version` the active keyword index. Resolves
   * false when that rebuild was superseded meanwhile.
   */
  switchVersion: (version: number) => Promise<boolean>;
  /** The active keyword index's version, or null when there is none. */
  activeVersion: () => number | null;
  /** Change-log entries written after `changeSeq`. */
  countChanges: (changeSeq: number) => number;
  /** Receives every freshly built index. */
  publish: (data: LexicalIndexData) => void;
  /** Rebuild once changes since the build reach this fraction of the indexed chunks. */
  changeFraction?: number;
  /** Rebuild an index older than this, whatever the changes. */
  maxAgeMs?: number;
  /** How often to check whether a rebuild is due. */
  checkIntervalMs?: number;
}

export class LexicalIndexService {
  private current: { data: LexicalIndexData; builtAt: number } | null = null;
  private building: LexicalIndexBuild | null = null;
  /** The version a switch is being prepared for, while one is. */
  private switching: number | null = null;
  /** A switch reported while a build or another switch ran; prepared when that finishes. */
  private pendingSwitch: number | null = null;
  /** Consecutive failed builds of the in-memory index a switch to `version` waits for. */
  private switchBuildFailures = { version: -1, count: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  private readonly changeFraction: number;
  private readonly maxAgeMs: number;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: LexicalIndexServiceOptions) {
    this.changeFraction = opts.changeFraction ?? 0.02;
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
    this.checkIntervalMs = opts.checkIntervalMs ?? 10 * 60 * 1000;
  }

  /** Build now, then keep checking whether a rebuild is due. A no-op once stopped. */
  start(): void {
    if (this.stopped || this.timer) return;
    void this.rebuild("initial build");
    this.timer = setInterval(() => this.checkDue(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.building?.terminate();
  }

  /**
   * Complete the rebuild to `version`, which holds every chunk: build its
   * in-memory index, switch, publish. Called each time the indexer reports the
   * rebuild waiting. A call that finds the service busy is remembered and
   * prepared as soon as the build or switch in progress finishes.
   */
  async prepareSwitch(version: number): Promise<void> {
    if (this.stopped) return;
    if (this.building || this.switching !== null) {
      this.pendingSwitch = version;
      return;
    }
    // A report sent before the switch it asked for: nothing is waiting.
    if (this.readActiveVersion() === version) return;
    if (this.switchBuildFailures.version !== version) {
      this.switchBuildFailures = { version, count: 0 };
    }
    const failures = this.switchBuildFailures;
    this.switching = version;
    let rebuildAfter = false;
    try {
      let built: { data: LexicalIndexData; ms: number } | null = null;
      if (failures.count < SWITCH_BUILD_ATTEMPTS) {
        log.info(`keyword index version ${version} is complete; building its in-memory index`);
        try {
          this.building = this.opts.build("building");
          built = await this.building.done;
          failures.count = 0;
        } catch (err) {
          failures.count++;
          log.warn(
            `in-memory index for keyword index version ${version} failed ` +
              `(${failures.count}/${SWITCH_BUILD_ATTEMPTS}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          if (failures.count < SWITCH_BUILD_ATTEMPTS) return;
          // Switch without it: the current in-memory index keeps answering by
          // its own version until a regular build of the new active index lands.
        } finally {
          this.building = null;
        }
      }
      if (this.stopped) return;
      if (!(await this.opts.switchVersion(version))) {
        log.info(`keyword index version ${version} was superseded before its switch`);
        return;
      }
      failures.count = 0;
      if (!built) {
        log.info(`keyword index switched to version ${version} without an in-memory index`);
        rebuildAfter = true;
        return;
      }
      this.current = { data: built.data, builtAt: Date.now() };
      this.failures = 0;
      this.retryAt = 0;
      this.opts.publish(built.data);
      log.info(
        `keyword index switched to version ${version}; its in-memory index serves ` +
          `(${built.data.docCount} chunks, built in ${built.ms}ms)`,
      );
    } catch (err) {
      log.warn(
        `keyword index switch to version ${version} failed; the current index keeps serving: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.switching = null;
      if (rebuildAfter) void this.rebuild("keyword index switched to a new version");
      else this.preparePendingSwitch();
    }
  }

  private preparePendingSwitch(): void {
    const version = this.pendingSwitch;
    this.pendingSwitch = null;
    if (version !== null) void this.prepareSwitch(version);
  }

  private checkDue(): void {
    if (this.building || this.switching !== null || Date.now() < this.retryAt) return;
    if (!this.current) {
      void this.rebuild(`retry ${this.failures} after a failed build`);
      return;
    }
    const { data, builtAt } = this.current;
    // A switch this service did not see through, such as one that finished
    // after its request timed out: build the index search now uses.
    const active = this.readActiveVersion();
    if (active !== null && active !== data.version) {
      void this.rebuild(`in-memory index is version ${data.version}; keyword index is ${active}`);
      return;
    }
    const age = Date.now() - builtAt;
    if (age >= this.maxAgeMs) {
      void this.rebuild(`index is ${Math.round(age / 60_000)} min old`);
      return;
    }
    let changes: number;
    try {
      changes = this.opts.countChanges(data.changeSeq);
    } catch (err) {
      log.warn(
        `could not count chunk changes: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (changes >= Math.max(1, data.docCount * this.changeFraction)) {
      void this.rebuild(`${changes} chunk changes since the last build`);
    }
  }

  private readActiveVersion(): number | null {
    try {
      return this.opts.activeVersion();
    } catch (err) {
      log.warn(
        `could not read the keyword index version: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // See #514 — planned: skip a build the host does not have the memory for.
  private async rebuild(reason: string): Promise<void> {
    if (this.stopped || this.building || this.switching !== null) return;
    try {
      await this.buildAndPublish(reason);
    } finally {
      this.preparePendingSwitch();
    }
  }

  private async buildAndPublish(reason: string): Promise<void> {
    log.info(`lexical index build started (${reason})`);
    let built: { data: LexicalIndexData; ms: number };
    try {
      this.building = this.opts.build("active");
      built = await this.building.done;
    } catch (err) {
      if (!this.stopped) this.recordFailure(err);
      return;
    } finally {
      this.building = null;
    }
    if (this.stopped) return;
    const { data, ms } = built;
    this.current = { data, builtAt: Date.now() };
    this.failures = 0;
    this.retryAt = 0;
    try {
      this.opts.publish(data);
    } catch (err) {
      log.warn(
        `lexical index built but could not be published: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    log.info(
      `lexical index ready in ${ms}ms: ${data.docCount} chunks, ${data.postingDoc.length} postings, ` +
        `${Math.round(lexicalIndexBytes(data) / (1024 * 1024))} MiB`,
    );
  }

  private recordFailure(err: unknown): void {
    this.failures++;
    // One check interval after the first failure, doubling up to the max age.
    const backoff = Math.min(this.checkIntervalMs * 2 ** (this.failures - 1), this.maxAgeMs);
    this.retryAt = Date.now() + backoff;
    log.warn(
      `lexical index build failed (retry in ${Math.round(backoff / 60_000)} min); ` +
        `BM25 keeps its current ranker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
