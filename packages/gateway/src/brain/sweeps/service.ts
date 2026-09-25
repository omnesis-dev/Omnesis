// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sweep service — the one place that knows the current sweep set.
 *
 * The enqueuer, the admin routes and `doctor` all read through it, so the list
 * the operator edits, the list the portal shows and the list the scheduler
 * fires are the same list by construction. Resolution is done on every call
 * rather than cached: the file store already caches on mtime, and re-layering
 * a handful of records is cheaper than any invalidation scheme would be to get
 * right. That is also what makes a hand-edited file take effect on the next
 * rhythm tick with no restart, matching the config store's behaviour.
 */

import { createLogger } from "@omnesis/core";
import { isValidSweepId } from "./file-format.js";
import { SweepFileStore } from "./file-store.js";
import { digestQuietWindow, resolveSweeps } from "./registry.js";
import { formatClockTime, isInQuietWindow } from "./anchor.js";
import { SYSTEM_SWEEP_IDS } from "./system-sweeps.js";
import type { SweepFileContent } from "./file-format.js";
import type { ResolvedSweeps, SweepDef } from "./types.js";
import type { Logger } from "@omnesis/core";

/** Edits a merge cannot express by value alone. */
export interface SweepPatchOptions {
  /**
   * Drop any pinned time, handing the sweep back to the resolver's derived
   * slot. Distinct from omitting `anchorMinutes`, which leaves it as it was.
   */
  clearAnchor?: boolean;
}

/** One entry of the deprecated `brain.sweeps` config record. */
export interface LegacySweepOverride {
  cadenceHours?: number;
  steeringPrompt?: string;
  enabled?: boolean;
  temporalAnnotationPrimeDays?: number;
}

/** The slice of resolved briefs settings the quiet window is derived from. */
export interface SweepScheduleContext {
  dailyRunHour: number;
  digestEnabled: boolean;
  digestHour: number;
  digestGraceMinutes: number;
}

export interface SweepServiceDeps {
  configDir: string;
  getScheduleContext: () => SweepScheduleContext;
  log?: Logger;
}

export class SweepService {
  private readonly store: SweepFileStore;
  private readonly getScheduleContext: () => SweepScheduleContext;
  private readonly log: Logger;

  constructor(deps: SweepServiceDeps) {
    this.store = new SweepFileStore(deps.configDir);
    this.getScheduleContext = deps.getScheduleContext;
    this.log = deps.log ?? createLogger("gateway:brain:sweeps");
  }

  /** Where user sweep files live — shown to the operator, used by backup. */
  get directory(): string {
    return this.store.directory;
  }

  /** The resolved set plus every problem found in the files behind it. */
  resolve(): ResolvedSweeps {
    const ctx = this.getScheduleContext();
    const quiet = digestQuietWindow(ctx);
    return resolveSweeps({
      files: this.store.list(),
      ...(quiet ? { quietWindow: quiet } : {}),
    });
  }

  /** Just the sweeps — the enqueuer's read. */
  list(): SweepDef[] {
    return this.resolve().sweeps;
  }

  get(id: string): SweepDef | null {
    return this.resolve().sweeps.find((s) => s.id === id) ?? null;
  }

  /** Whether an id is one the gateway ships (so the portal offers a fork, not an edit). */
  isSystemId(id: string): boolean {
    return SYSTEM_SWEEP_IDS.has(id);
  }

  /**
   * Apply a partial edit over whatever the file already holds.
   *
   * The editing surfaces send the fields they show, and a full replace would
   * make every one of them destructive by omission: saving an edited paragraph
   * would silently re-enable a sweep the operator had switched off, and on a
   * sweep they wrote themselves it would drop the cadence and make the sweep
   * vanish into the issue list.
   */
  patch(id: string, changes: SweepFileContent, opts: SweepPatchOptions = {}): ResolvedSweeps {
    const existing = this.fileContent(id) ?? { steeringPrompt: "" };
    const merged: SweepFileContent = {
      ...existing,
      ...changes,
      // An absent body means "leave the prose alone", which is what every
      // caller that omits it intends.
      steeringPrompt:
        changes.steeringPrompt !== "" ? changes.steeringPrompt : existing.steeringPrompt,
    };
    // Un-pinning has to be said explicitly, because a merge cannot express it:
    // omitting the time means "leave it alone", so without this an operator
    // could pin a time but never hand it back to the resolver's spreading.
    if (opts.clearAnchor) delete merged.anchorMinutes;
    return this.save(id, merged);
  }

  /**
   * Write a user sweep file, replacing it entirely. Returns the resolved
   * sweep set — a save that produces an unrunnable sweep is reported to the
   * caller rather than silently accepted, because the operator is looking at
   * the editor when it happens.
   */
  save(id: string, content: SweepFileContent): ResolvedSweeps {
    this.store.write(id, content);
    const resolved = this.resolve();
    this.log.info(`sweep '${id}' saved (${this.store.pathFor(id)})`);
    return resolved;
  }

  /** Delete a user sweep file. A system sweep of the same id reappears intact. */
  remove(id: string): boolean {
    const removed = this.store.remove(id);
    if (removed) this.log.info(`sweep '${id}' file removed`);
    return removed;
  }

  /** The file's own content, for the editor to open. Null when there is none. */
  fileContent(id: string): SweepFileContent | null {
    return this.store.get(id)?.content ?? null;
  }

  /**
   * Seed a user file from a resolved sweep — the "fork this sweep" action.
   * Writes every field explicitly, so the fork is a self-contained file the
   * operator can read and edit without knowing what it inherited.
   */
  fork(id: string): ResolvedSweeps | null {
    const sweep = this.get(id);
    if (!sweep) return null;
    return this.save(id, {
      name: sweep.name,
      cadenceHours: sweep.cadenceHours,
      anchorMinutes: sweep.anchorMinutes,
      enabled: sweep.enabled,
      steeringPrompt: sweep.steeringPrompt,
      ...(sweep.temporalAnnotationPrimeDays !== undefined
        ? { temporalAnnotationPrimeDays: sweep.temporalAnnotationPrimeDays }
        : {}),
    });
  }

  /**
   * Turn a sweep on or off with the smallest possible file. For a system sweep
   * that has not been forked this writes front matter only, so the prose keeps
   * tracking the shipped version and a later release still improves it.
   */
  setEnabled(id: string, enabled: boolean): ResolvedSweeps | null {
    const sweep = this.get(id);
    if (!sweep) return null;
    // No file yet means this is a shipped sweep being switched for the first
    // time; front matter alone is the whole change, so its prose keeps
    // tracking the version the gateway ships.
    const existing = this.fileContent(id) ?? { steeringPrompt: "" };
    return this.save(id, { ...existing, enabled });
  }

  /**
   * Convert `brain.sweeps` config overrides — the pre-file authoring surface —
   * into sweep files, once. Called at start-up behind an engine-state marker
   * so a later "revert to system" (deleting the file) is not undone on the
   * next boot. Files already present win: a conversion never overwrites
   * something the operator wrote.
   */
  migrateLegacyOverrides(overrides: Record<string, LegacySweepOverride>): string[] {
    const migrated: string[] = [];
    for (const [id, ov] of Object.entries(overrides)) {
      if (!isValidSweepId(id)) {
        this.log.warn(`legacy sweep override '${id}' is not a usable sweep id — not converted`);
        continue;
      }
      if (this.store.get(id) !== null) continue;
      const content: SweepFileContent = { steeringPrompt: ov.steeringPrompt ?? "" };
      if (ov.cadenceHours !== undefined) content.cadenceHours = ov.cadenceHours;
      if (ov.enabled !== undefined) content.enabled = ov.enabled;
      if (ov.temporalAnnotationPrimeDays !== undefined) {
        content.temporalAnnotationPrimeDays = ov.temporalAnnotationPrimeDays;
      }
      this.store.write(id, content);
      migrated.push(id);
    }
    if (migrated.length > 0) {
      this.log.info(
        `converted ${migrated.length} brain.sweeps override(s) to files in ${this.directory}: ${migrated.join(", ")}`,
      );
    }
    return migrated;
  }

  /**
   * Sweeps whose anchor sits inside the window the morning digest needs quiet.
   * Derived anchors avoid it by construction, so anything here was chosen
   * explicitly — which is why this reports rather than moves it. The day-ahead
   * pass is excluded: the digest waits for it on purpose.
   *
   * Takes an already-resolved set when the caller has one, so a request that
   * lists sweeps does not scan the directory twice.
   */
  digestWindowConflicts(sweeps: readonly SweepDef[] = this.list()): { id: string; at: string }[] {
    const quiet = digestQuietWindow(this.getScheduleContext());
    if (!quiet) return [];
    return sweeps
      .filter(
        (s) =>
          s.enabled &&
          s.anchorExplicit &&
          !s.expectedBeforeDigest &&
          isInQuietWindow(s.anchorMinutes, quiet),
      )
      .map((s) => ({ id: s.id, at: formatClockTime(s.anchorMinutes) }));
  }
}
