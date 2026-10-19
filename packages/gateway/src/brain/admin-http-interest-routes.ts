// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Operator reads over the interest ledger: what the owner reacted to, whether
 * each signal has its vector yet, the suggestion-gate verdicts those signals
 * fed, and a probe that runs one lookup the way a gate would. Read-only; a
 * reaction is only ever written by the owner through the product surfaces.
 */

import { BadRequestError } from "../http/errors.js";
import { scope } from "../http/scope.js";
import { areDecisionSourcesReadable } from "./decision-read-privacy.js";
import {
  decisionDto,
  iso,
  limitParam,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import { listDecisionsForRecord, type CognitionDecisionRecord } from "./storage/decisions.js";
import {
  countUnembeddedInterestSignals,
  listInterestSignals,
  type InterestSignal,
} from "./storage/interest.js";
import type { InterestEngine } from "./interest/engine.js";
import type Database from "better-sqlite3";

/** How many suggestion-gate verdicts the page lists, newest first. */
const DECISION_LIMIT = 50;
const PROBE_TEXT_MAX_CHARS = 2_000;

export interface InterestAdminRouteDeps {
  db: Database.Database;
  interest: InterestEngine;
}

export function interestSignalDto(signal: InterestSignal) {
  return {
    id: signal.id,
    polarity: signal.polarity,
    kind: signal.kind,
    source: signal.source,
    text: signal.subjectText,
    note: signal.note,
    loopId: signal.loopId,
    observationId: signal.observationId,
    conversationId: signal.conversationId,
    embedded: signal.embedding !== null,
    createdAt: iso(signal.createdAt),
    supersededAt: iso(signal.supersededAt),
  };
}

export interface InterestCounts {
  live: number;
  superseded: number;
  positive: number;
  negative: number;
  statements: number;
}

/** Whole-ledger counts; `positive`, `negative` and `statements` count live signals only. */
export function countInterestSignals(db: Database.Database): InterestCounts {
  const rows = db
    .prepare<[], { live: number; polarity: number; kind: string; n: number }>(
      `SELECT (superseded_at IS NULL) AS live, polarity, kind, COUNT(*) AS n
         FROM interest_signals GROUP BY live, polarity, kind`,
    )
    .all();
  const counts: InterestCounts = {
    live: 0,
    superseded: 0,
    positive: 0,
    negative: 0,
    statements: 0,
  };
  for (const row of rows) {
    if (!row.live) {
      counts.superseded += row.n;
      continue;
    }
    counts.live += row.n;
    if (row.kind === "statement") counts.statements += row.n;
    else if (row.polarity === 1) counts.positive += row.n;
    else counts.negative += row.n;
  }
  return counts;
}

/**
 * The newest suggestion-gate verdicts across every task, newest first. The
 * ledger is read per record, so the distinct records of the newest rows are
 * found first and each one's verdicts fetched through the storage reader.
 */
function listTaskProposeDecisions(db: Database.Database, limit: number): CognitionDecisionRecord[] {
  const recordIds = db
    .prepare<[number], { record_id: string }>(
      `SELECT DISTINCT record_id FROM cognition_decisions
        WHERE purpose = 'task-propose' AND record_id IS NOT NULL
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => row.record_id);
  return recordIds
    .flatMap((recordId) => listDecisionsForRecord(db, "task-propose", recordId, limit))
    .map((decision) =>
      areDecisionSourcesReadable(db, decision)
        ? decision
        : { ...decision, requestJson: null, responseJson: null, error: null },
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function mountCognitionInterestAdminRoutes(
  ctx: CognitionAdminRouteContext,
  deps: InterestAdminRouteDeps,
): void {
  const { app, requireVisible } = ctx;
  const { db, interest } = deps;

  app.get("/admin/brain/interest", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    return c.json({
      enabled: interest.enabled(),
      backlog: countUnembeddedInterestSignals(db),
      counts: countInterestSignals(db),
      signals: listInterestSignals(db, { limit }).map(interestSignalDto),
      decisions: listTaskProposeDecisions(db, DECISION_LIMIT).map((decision) =>
        decisionDto(decision, undefined),
      ),
    });
  });

  app.get("/admin/brain/interest/lookup", scope.admin(), async (c) => {
    requireVisible();
    const text = (c.req.query("text") ?? "").trim();
    if (text.length === 0) throw new BadRequestError("text is required");
    if (text.length > PROBE_TEXT_MAX_CHARS)
      throw new BadRequestError(`text must be at most ${PROBE_TEXT_MAX_CHARS} characters`);
    return c.json({ text, result: await interest.lookup({ text }) });
  });
}
