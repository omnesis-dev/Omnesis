// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `/admin/brain/sweeps` — the sweep authoring and reporting surface.
 *
 * These are the only routes in the gateway that write operator-authored text
 * to the filesystem, so every id is validated against the sweep-id pattern
 * before it reaches a path, prose is capped at parse time, and the whole
 * surface sits behind admin scope and the same live feature gate as the rest
 * of `/admin/brain/*`.
 *
 * Reads return the resolved sweep set — system definitions layered with the
 * operator's files — beside each sweep's durable production tally, because the
 * two questions the page has to answer together are "what is this sweep" and
 * "has it ever been worth it".
 */

import { scope } from "../http/scope.js";
import { BadRequestError, NotFoundError } from "../http/errors.js";
import { listSweepTallies } from "./storage/sweep-tally.js";
import { formatClockTime, parseClockTime } from "./sweeps/anchor.js";
import { isValidSweepId, sweepFileContentSchema } from "./sweeps/file-format.js";
import type { SweepFileContent } from "./sweeps/file-format.js";
import type { SweepService } from "./sweeps/service.js";
import type { SweepDef, SweepIssue } from "./sweeps/types.js";
import type { SweepTallyRow } from "./storage/sweep-tally.js";
import type { CognitionAdminRouteContext } from "./admin-http-shared.js";
import type Database from "better-sqlite3";

interface SweepDto {
  id: string;
  name: string;
  origin: "system" | "user";
  /** True when a user file layers over a system sweep of the same id. */
  modified: boolean;
  /** True when the gateway ships a sweep of this id (so the action is Fork, not Edit). */
  hasSystemVersion: boolean;
  enabled: boolean;
  cadenceHours: number;
  at: string;
  anchorExplicit: boolean;
  steeringPrompt: string;
  temporalAnnotationPrimeDays: number | null;
  stats: {
    runs: number;
    failedRuns: number;
    promptTokens: number;
    completionTokens: number;
    briefsCreated: number;
    briefsHeld: number;
    loopsCreated: number;
    loopsTouched: number;
    annotationsCreated: number;
    firstRunAt: string | null;
    lastRunAt: string | null;
  };
}

const EMPTY_STATS = {
  runs: 0,
  failedRuns: 0,
  promptTokens: 0,
  completionTokens: 0,
  briefsCreated: 0,
  briefsHeld: 0,
  loopsCreated: 0,
  loopsTouched: 0,
  annotationsCreated: 0,
  firstRunAt: null,
  lastRunAt: null,
};

function sweepDto(
  sweep: SweepDef,
  tally: SweepTallyRow | undefined,
  isSystemId: boolean,
): SweepDto {
  return {
    id: sweep.id,
    name: sweep.name,
    origin: sweep.origin,
    modified: sweep.modified,
    hasSystemVersion: isSystemId,
    enabled: sweep.enabled,
    cadenceHours: sweep.cadenceHours,
    at: formatClockTime(sweep.anchorMinutes),
    anchorExplicit: sweep.anchorExplicit,
    steeringPrompt: sweep.steeringPrompt,
    temporalAnnotationPrimeDays: sweep.temporalAnnotationPrimeDays ?? null,
    stats: tally
      ? {
          runs: tally.runs,
          failedRuns: tally.failedRuns,
          promptTokens: tally.promptTokens,
          completionTokens: tally.completionTokens,
          briefsCreated: tally.briefsCreated,
          briefsHeld: tally.briefsHeld,
          loopsCreated: tally.loopsCreated,
          loopsTouched: tally.loopsTouched,
          annotationsCreated: tally.annotationsCreated,
          firstRunAt: tally.firstRunAt === null ? null : new Date(tally.firstRunAt).toISOString(),
          lastRunAt: tally.lastRunAt === null ? null : new Date(tally.lastRunAt).toISOString(),
        }
      : EMPTY_STATS,
  };
}

function issueDto(issue: SweepIssue): SweepIssue {
  return { id: issue.id, file: issue.file, message: issue.message };
}

/**
 * Read the editable fields off a request body.
 *
 * Validated against the same schema the serializer writes through, so a body
 * this route accepts is always a file the format can represent — and the
 * portal's `at` string is converted to the minutes the schema speaks here,
 * at the boundary, rather than deeper in.
 */
function readSweepBody(raw: unknown): SweepFileContent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("Body must be an object");
  }
  const body = { ...(raw as Record<string, unknown>) };
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== "string") throw new BadRequestError("at must be a string like 06:30");
    const minutes = parseClockTime(body.at);
    if (minutes === null) throw new BadRequestError("at must be a 24-hour local time like 06:30");
    body.anchorMinutes = minutes;
  }
  delete body.at;
  // Absent prose means "leave it alone" on an edit; the schema wants a string.
  if (body.steeringPrompt === undefined) body.steeringPrompt = "";
  if (body.temporalAnnotationPrimeDays === null) delete body.temporalAnnotationPrimeDays;

  const parsed = sweepFileContentSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(
      `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is invalid"}`,
    );
  }
  return parsed.data;
}

/** Reject an id that could not be a filename stem before it reaches one. */
function requireId(raw: string): string {
  if (!isValidSweepId(raw)) {
    throw new BadRequestError(
      "Sweep id must be lower-case letters, digits and hyphens (e.g. commitments-made)",
    );
  }
  return raw;
}

export interface SweepAdminRouteDeps {
  db: Database.Database;
  sweeps: SweepService;
  /**
   * Whether the sweep lane is switched on (`brain.sweepsEnabled`). Reported
   * because the authoring surface is reachable while it is off, and a page
   * showing schedules for sweeps that cannot run is a page that lies.
   */
  isLaneEnabled: () => boolean;
}

export function mountCognitionSweepAdminRoutes(
  ctx: CognitionAdminRouteContext,
  deps: SweepAdminRouteDeps,
): void {
  const { app, requireActive } = ctx;
  const { db, sweeps } = deps;

  const listBody = (): {
    items: SweepDto[];
    issues: SweepIssue[];
    directory: string;
    laneEnabled: boolean;
    digestWindowConflicts: { id: string; at: string }[];
  } => {
    const resolved = sweeps.resolve();
    const tallies = listSweepTallies(db);
    return {
      items: resolved.sweeps.map((s) => sweepDto(s, tallies.get(s.id), sweeps.isSystemId(s.id))),
      issues: resolved.issues.map(issueDto),
      directory: sweeps.directory,
      laneEnabled: deps.isLaneEnabled(),
      digestWindowConflicts: sweeps.digestWindowConflicts(resolved.sweeps),
    };
  };

  app.get("/admin/brain/sweeps", scope.admin(), (c) => {
    requireActive();
    return c.json(listBody());
  });

  app.put("/admin/brain/sweeps/:id", scope.admin(), async (c) => {
    requireActive();
    const id = requireId(c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as { at?: unknown } | null;
    const content = readSweepBody(body);
    const existing = sweeps.get(id);
    // A new sweep has nothing underneath to inherit from, so the two things
    // that make a sweep runnable have to be present at the moment it is
    // created — a half-written file would show up only as an issue later.
    if (!existing) {
      if (content.cadenceHours === undefined) {
        throw new BadRequestError("A new sweep needs a cadence");
      }
      if (content.steeringPrompt.trim() === "") {
        throw new BadRequestError("A new sweep needs steering prose saying what to look for");
      }
    }
    // `at: null` is the editor blanking the time — an explicit request to be
    // scheduled automatically again, which omitting the field cannot say.
    sweeps.patch(id, content, { clearAnchor: body?.at === null });
    return c.json(listBody());
  });

  /**
   * Seed a user file from a system sweep. Separate from PUT because the portal
   * does it without an edit — the operator clicks Fork, then edits the file
   * that action created.
   */
  app.post("/admin/brain/sweeps/:id/fork", scope.admin(), (c) => {
    requireActive();
    const id = requireId(c.req.param("id"));
    if (sweeps.fork(id) === null) throw new NotFoundError("Sweep not found");
    return c.json(listBody());
  });

  app.post("/admin/brain/sweeps/:id/enabled", scope.admin(), async (c) => {
    requireActive();
    const id = requireId(c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") throw new BadRequestError("enabled must be a boolean");
    if (sweeps.setEnabled(id, body.enabled) === null) throw new NotFoundError("Sweep not found");
    return c.json(listBody());
  });

  /**
   * Delete the user file. For a forked system sweep this is "revert to
   * system" and the shipped version reappears intact; for a sweep the
   * operator invented it removes the sweep. Its tally survives either way —
   * the record of what it produced is the point of keeping one.
   */
  app.delete("/admin/brain/sweeps/:id", scope.admin(), (c) => {
    requireActive();
    const id = requireId(c.req.param("id"));
    if (!sweeps.remove(id)) throw new NotFoundError("No sweep file to remove");
    return c.json(listBody());
  });
}
