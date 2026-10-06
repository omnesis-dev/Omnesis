// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadActiveUniverse, UniverseError } from "./universe.js";
import type { Universe } from "./universe.js";

export interface SourceFixtureClock {
  readonly snapshotDay: string;
  readonly syncedAt: string;
}

const clocks = new WeakMap<Universe, Map<string, SourceFixtureClock>>();

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  return Boolean(
    parts &&
    validDay(parts[1]) &&
    Number(parts[2]) < 24 &&
    Number(parts[3]) < 60 &&
    Number(parts[4]) < 60 &&
    (parts[5] === undefined || (Number(parts[5]) < 24 && Number(parts[6]) < 60)) &&
    Number.isFinite(Date.parse(value)),
  );
}

/** Matches the universe reader's explicit boundary validation without a new runtime dependency. */
function parseClock(raw: unknown, context: string): SourceFixtureClock {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new UniverseError(`${context}: clock must be an object`);
  const fields = raw as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "snapshotDay" && key !== "syncedAt"))
    throw new UniverseError(`${context}: clock allows only snapshotDay and syncedAt`);
  if (!validDay(fields.snapshotDay))
    throw new UniverseError(`${context}: snapshotDay must be a real YYYY-MM-DD date`);
  if (!validInstant(fields.syncedAt))
    throw new UniverseError(
      `${context}: syncedAt must be an ISO instant with an explicit offset or Z`,
    );
  return Object.freeze({ snapshotDay: fields.snapshotDay, syncedAt: fields.syncedAt });
}

/**
 * Optional sources/<descriptor>/clock.json pins source-owned snapshot and ingest
 * clocks for one materialized universe. Legacy universes retain each caller's
 * defaults. The first read, including an absent file, is immutable for that
 * universe object; a fresh loaded universe is a fresh clock namespace.
 */
export function sourceFixtureClock(
  descriptorId: string,
  defaults: SourceFixtureClock,
  universe: Universe = loadActiveUniverse(),
): SourceFixtureClock {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(descriptorId))
    throw new UniverseError("Fixture clock descriptor must be a source identifier");
  let bySource = clocks.get(universe);
  if (!bySource) {
    bySource = new Map();
    clocks.set(universe, bySource);
  }
  const previous = bySource.get(descriptorId);
  if (previous) return previous;
  const context = `Universe '${universe.manifest.name}' fixture ${descriptorId}/clock.json`;
  const path = join(universe.dir, "sources", descriptorId, "clock.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new UniverseError(`${context}: could not read a valid JSON clock`);
    raw = defaults;
  }
  const clock = parseClock(raw, context);
  bySource.set(descriptorId, clock);
  return clock;
}
