// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Resolving the sweep set: system definitions, layered with the operator's
 * files, into the list the enqueuer schedules.
 *
 * Layering, not shadowing. A user file whose id matches a system sweep
 * overrides only the keys it names — so silencing a built-in is a two-line
 * file, retiming one is a three-line file, and forking one is the same file
 * with a body. Deleting the file restores the system sweep exactly, which is
 * the property that lets a release improve prose for everyone who has not
 * forked it. A file with an id no system sweep uses defines a new sweep, and
 * then it must carry the things there is nothing to inherit: a cadence and a
 * body.
 *
 * Every rejection is returned as an issue rather than thrown. One unparseable
 * file must not stop the other sweeps running, and the operator needs to be
 * told which file and why — on the portal page, and in `omnesis doctor`.
 */

import { deriveAnchorMinutes, parseClockTime } from "./anchor.js";
import { SYSTEM_SWEEPS } from "./system-sweeps.js";
import type { QuietWindow } from "./anchor.js";
import type { SweepFileEntry } from "./file-store.js";
import type { ResolvedSweeps, SweepDef, SweepIssue, SystemSweepDef } from "./types.js";

export interface ResolveSweepsInput {
  /** Parsed contents of `<configDir>/sweeps/*.md`. */
  files: readonly SweepFileEntry[];
  /**
   * Local window the derived anchors avoid — between the daily boundary and
   * the morning digest's grace deadline. A sweep running in there holds the
   * digest's readiness barrier open and thins the morning brief.
   */
  quietWindow?: QuietWindow;
  /** Overridable for tests; defaults to the shipped set. */
  systemSweeps?: readonly SystemSweepDef[];
}

export function resolveSweeps(input: ResolveSweepsInput): ResolvedSweeps {
  const system = input.systemSweeps ?? SYSTEM_SWEEPS;
  const issues: SweepIssue[] = [];
  const byId = new Map<string, SweepDef>();

  for (const def of system) {
    const anchorMinutes = parseClockTime(def.at);
    byId.set(def.id, {
      id: def.id,
      name: def.name,
      origin: "system",
      modified: false,
      cadenceHours: def.cadenceHours,
      steeringPrompt: def.steeringPrompt,
      enabled: def.enabled,
      // A system sweep's `at` is a literal in this repo; a malformed one is a
      // programming error, and falling back to the derived slot keeps the
      // sweep running while the tests that pin the format go red.
      anchorMinutes: anchorMinutes ?? deriveAnchorMinutes(def.id, input.quietWindow),
      anchorExplicit: anchorMinutes !== null,
      expectedBeforeDigest: def.expectedBeforeDigest ?? false,
      ...(def.briefLane !== undefined ? { briefLane: def.briefLane } : {}),
      ...(def.temporalAnnotationPrimeDays !== undefined
        ? { temporalAnnotationPrimeDays: def.temporalAnnotationPrimeDays }
        : {}),
    });
  }

  for (const entry of input.files) {
    if (entry.error !== null || entry.content === null) {
      issues.push({
        id: entry.id,
        file: entry.file,
        message: entry.error ?? "could not be parsed",
      });
      continue;
    }
    const { content } = entry;
    const base = byId.get(entry.id);

    if (base === undefined) {
      // A brand-new sweep: nothing underneath to inherit from.
      if (content.cadenceHours === undefined) {
        issues.push({
          id: entry.id,
          file: entry.file,
          message: "a new sweep needs a `cadence` in its front matter (e.g. cadence: 7d)",
        });
        continue;
      }
      if (content.steeringPrompt === "") {
        issues.push({
          id: entry.id,
          file: entry.file,
          message: "a new sweep needs prose below the front matter saying what to look for",
        });
        continue;
      }
      byId.set(entry.id, {
        id: entry.id,
        name: content.name ?? entry.id,
        origin: "user",
        modified: false,
        cadenceHours: content.cadenceHours,
        steeringPrompt: content.steeringPrompt,
        enabled: content.enabled ?? true,
        anchorMinutes: content.anchorMinutes ?? deriveAnchorMinutes(entry.id, input.quietWindow),
        anchorExplicit: content.anchorMinutes !== undefined,
        expectedBeforeDigest: false,
        ...(content.temporalAnnotationPrimeDays !== undefined &&
        content.temporalAnnotationPrimeDays > 0
          ? { temporalAnnotationPrimeDays: content.temporalAnnotationPrimeDays }
          : {}),
      });
      continue;
    }

    // Layer over the system sweep of the same id. `0` on the prime is the
    // explicit "no prime" sentinel — it removes a built-in's window rather
    // than shipping a zero-day query.
    const prime = content.temporalAnnotationPrimeDays ?? base.temporalAnnotationPrimeDays;
    const name = content.name ?? base.name;
    const cadenceHours = content.cadenceHours ?? base.cadenceHours;
    const anchorMinutes = content.anchorMinutes ?? base.anchorMinutes;
    const steeringPrompt =
      content.steeringPrompt !== "" ? content.steeringPrompt : base.steeringPrompt;
    // `modified` asks whether the file PINS any content, not whether that
    // content currently differs. Pinning is what stops a later release
    // reaching this sweep, so a fork that starts out identical is still a
    // fork. Switching a built-in off pins nothing: the file carries only
    // `enabled`, the prose keeps tracking the shipped version, and the
    // surfaces should keep saying so.
    const modified =
      content.name !== undefined ||
      content.cadenceHours !== undefined ||
      content.anchorMinutes !== undefined ||
      content.temporalAnnotationPrimeDays !== undefined ||
      content.steeringPrompt !== "";
    byId.set(entry.id, {
      id: entry.id,
      name,
      origin: "user",
      modified,
      cadenceHours,
      steeringPrompt,
      enabled: content.enabled ?? base.enabled,
      anchorMinutes,
      anchorExplicit: content.anchorMinutes !== undefined || base.anchorExplicit,
      // Carried from the system sweep: a file cannot claim the digest should
      // wait for it.
      expectedBeforeDigest: base.expectedBeforeDigest,
      // The lane, by contrast, is granted for the PROSE it was written
      // against — retiming or renaming a sweep does not change what its cards
      // say, but replacing its prose does, so only that drops the grant.
      ...(content.steeringPrompt === "" && base.briefLane !== undefined
        ? { briefLane: base.briefLane }
        : {}),
      ...(prime !== undefined && prime > 0 ? { temporalAnnotationPrimeDays: prime } : {}),
    });
  }

  // System sweeps keep their declared order; user-defined ones append in id
  // order, which is the order the file store listed them in.
  const order = new Map(system.map((s, i) => [s.id, i]));
  const sweeps = [...byId.values()].sort((a, b) => {
    const ai = order.get(a.id);
    const bi = order.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
  return { sweeps, issues };
}

/**
 * The window derived anchors avoid: from the daily boundary through the
 * digest's grace deadline, which is exactly the span the digest's readiness
 * barrier wants quiet. Returns undefined when the digest is off — there is
 * then nothing to protect and the whole day is available.
 */
export function digestQuietWindow(input: {
  digestEnabled: boolean;
  dailyRunHour: number;
  digestHour: number;
  digestGraceMinutes: number;
}): QuietWindow | undefined {
  if (!input.digestEnabled) return undefined;
  return {
    startMinutes: (input.dailyRunHour * 60) % 1440,
    endMinutes: (input.digestHour * 60 + input.digestGraceMinutes) % 1440,
  };
}
