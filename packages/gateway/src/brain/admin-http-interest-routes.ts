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
import { listDecisionsForPurpose, type CognitionDecisionRecord } from "./storage/decisions.js";
import {
  countInterestSignals,
  countUnembeddedInterestSignals,
  listInterestSignals,
  listWithheldSuggestions,
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
  clock: () => number;
}

function interestSignalDto(signal: InterestSignal) {
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

/**
 * The newest suggestion-gate verdicts, newest first, their exact input
 * withheld where a cited document is no longer readable.
 */
function listTaskProposeDecisions(db: Database.Database, limit: number): CognitionDecisionRecord[] {
  return listDecisionsForPurpose(db, "task-propose", limit).map((decision) =>
    areDecisionSourcesReadable(db, decision)
      ? decision
      : { ...decision, requestJson: null, responseJson: null, error: null },
  );
}

export function mountCognitionInterestAdminRoutes(
  ctx: CognitionAdminRouteContext,
  deps: InterestAdminRouteDeps,
): void {
  const { app, requireVisible } = ctx;
  const { db, interest, clock } = deps;

  app.get("/admin/brain/interest", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    return c.json({
      enabled: interest.enabled(),
      backlog: countUnembeddedInterestSignals(db, clock()),
      counts: countInterestSignals(db),
      signals: listInterestSignals(db, { limit }).map(interestSignalDto),
      // Suggestions the gate kept out of Tasks, with the ledger entry undo takes.
      withheld: listWithheldSuggestions(db).map((w) => ({
        loopId: w.loopId,
        title: w.title,
        seq: w.seq,
        at: iso(w.at),
        note: w.note,
      })),
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
