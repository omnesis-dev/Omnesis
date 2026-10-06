// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { boundKnowledgeReview } from "./planner.js";
import { readKnowledgeOwner } from "./owner-adapters.js";
import type Database from "better-sqlite3";
import type { KnowledgeNode } from "./types.js";
import type { ResolvedBrainSettings } from "../config.js";

export function knowledgeReviewSignals(db: Database.Database, node: KnowledgeNode, now: number) {
  const owner =
    node.kind === "loop" ? readKnowledgeOwner(db, "loop", node.ownerId ?? node.id) : null;
  const fields = owner?.canonicalFields ?? node.canonicalFields;
  const deadline = fields.deadline;
  const deadlineText =
    typeof deadline === "string"
      ? deadline
      : deadline && typeof deadline === "object" && "date" in deadline
        ? deadline.date
        : null;
  const parsed = typeof deadlineText === "string" ? Date.parse(deadlineText) : NaN;
  const deadlineAt =
    node.kind === "loop" && fields.state === "open" && Number.isFinite(parsed) ? parsed : null;
  const importance =
    typeof fields.importance === "number" ? fields.importance : (node.metadata.importance ?? 0);
  const claims = db
    .prepare<
      [string],
      { total: number; uncertain: number }
    >("SELECT COUNT(*) AS total,COALESCE(SUM(verification!='verified' OR epistemic_status!='asserted'),0) AS uncertain FROM knowledge_claims WHERE node_id=?")
    .get(node.id)!;
  const last = Math.max(
    node.metadata.lastVerifiedAt ?? node.createdAt,
    node.metadata.lastReviewedAt ?? node.createdAt,
  );
  const checkpointAt = [node.metadata.checkpointAt, deadlineAt].filter(
    (value): value is number =>
      typeof value === "number" && value > (node.metadata.lastReviewedAt ?? 0),
  );
  return {
    id: node.id,
    kind: node.kind,
    now,
    validity: node.validity,
    metadata: node.metadata,
    importance,
    deadlineAt,
    canonicalState: typeof fields.state === "string" ? fields.state : null,
    claims,
    lastMeaningfulReviewAt: last,
    checkpointAt: checkpointAt.length ? Math.min(...checkpointAt) : null,
    ageSinceReviewMs: Math.max(0, now - last),
  };
}

/** A bounded score protocol: very low => dormant, low => defer, uncertainty => now. */
export function decideKnowledgeReview(
  signals: ReturnType<typeof knowledgeReviewSignals>,
  score: number | null,
  cfg: ResolvedBrainSettings["knowledge"],
): { decision: "now" | "defer" | "dormant"; nextReviewAt: number; reason: string } {
  const now = signals.now;
  const bound = (proposedAt: number | null) =>
    boundKnowledgeReview({
      now,
      lastVerifiedAt: signals.lastMeaningfulReviewAt,
      createdAt: signals.lastMeaningfulReviewAt,
      proposedAt,
      checkpointAt:
        signals.checkpointAt !== null &&
        signals.checkpointAt - cfg.checkpointLeadMs > (signals.metadata.lastReviewedAt ?? 0)
          ? signals.checkpointAt
          : null,
      maxIntervalMs: cfg.maxReviewIntervalMs,
      checkpointLeadMs: cfg.checkpointLeadMs,
    });
  const maximum = bound(null);
  if (
    maximum <= now ||
    signals.validity === "stale" ||
    score === null ||
    !Number.isFinite(score) ||
    score >= 0.75
  )
    return {
      decision: "now",
      nextReviewAt: now,
      reason:
        maximum <= now
          ? "fairness_or_checkpoint"
          : signals.validity === "stale"
            ? "stale_support"
            : score === null || !Number.isFinite(score)
              ? "decision_unavailable"
              : "decision_review",
    };
  if (score < 0.25)
    return { decision: "dormant", nextReviewAt: maximum, reason: "decision_dormant_with_backstop" };
  const importance = Math.max(0, Math.min(1, signals.importance));
  const volatility = Math.max(0, Math.min(1, signals.metadata.volatility ?? 0));
  const delay = importance >= 0.7 || volatility >= 0.7 ? cfg.soonDelayMs : cfg.routineDelayMs;
  return {
    decision: "defer",
    nextReviewAt: bound(now + Math.max(60_000, delay)),
    reason: "decision_bounded_deferral",
  };
}
