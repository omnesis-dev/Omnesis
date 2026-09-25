// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch discloses, and to whom, read from the record that authorised it.
 *
 * A watch that wakes an agent has a second half: a subscription record naming
 * the integration it wakes, what the operator approved it to react to, whether
 * that approval still stands, and every time it has actually reached out. That
 * record used to be a page of its own, which made one watch look like two
 * things — a runtime object here and a privacy object there, with no way to get
 * from either to the other.
 *
 * It is one thing. The runtime side is the authority on what the watch does;
 * this is the authority on what it is allowed to say and to whom, and it hangs
 * off the same watch. A watch that wakes nobody has no disclosure at all, which
 * is a complete answer rather than a missing one.
 *
 * Unlike {@link readAnchors}, which answers "where does this watch wake through
 * *now*" and therefore skips anything revoked, this answers "what has this
 * watch been authorised to say" — so a revoked record is still read. Dropping
 * it would take the egress ledger with it, leaving disclosures that happened
 * with nothing on any screen accounting for them.
 */

import { isWatchV2Plan } from "../subscriptions/watch-v2-plan.js";
import { getSubscriptionById } from "../subscriptions/store-queries.js";
import { ANCHOR_ORDER } from "./anchor-order.js";

import type { Db } from "../data/types.js";
import type { SubscriptionApprovalSummary } from "@omnesis/types";
import type {
  WatchV2Author,
  WatchV2EvidenceKind,
  WatchV2Plan,
} from "../subscriptions/watch-v2-plan.js";

/**
 * The one line a listing needs: who asked for this watch, and who hears it.
 *
 * Both are indicators on a row rather than a section it belongs to — a watch is
 * a watch however it was asked for.
 */
export interface WatchDisclosureSummary {
  /** Whose request this watch is. */
  readonly authoredBy: WatchV2Author;
  /** The record that authorises the wake. */
  readonly subscriptionId: string;
  /** Where it stands — active, pending an approval, revoked, expired. */
  readonly status: string;
  /** The integration woken, named as the operator named its device. */
  readonly integrationName: string | null;
}

/** Everything the watch's own page shows about the disclosure it carries. */
export interface WatchDisclosure extends WatchDisclosureSummary {
  readonly revision: number;
  /** What the operator approved, in the compiler's reading of the request. */
  readonly interpretation: string;
  /** The condition as the record states it. */
  readonly condition: string;
  /** What the woken agent is asked to do. */
  readonly instruction: string;
  /** How much of a firing the agent may be handed. */
  readonly evidence: WatchV2EvidenceKind;
  /** The approval itself, when one was asked for; null for an operator's own. */
  readonly approval: SubscriptionApprovalSummary | null;
  /** Epoch milliseconds, as the subscription store keeps its instants. */
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly policyRevision: string;
  /** How many times it has actually reached out, and when it last did. */
  readonly firingCount: number;
  readonly lastFiredAt: number | null;
}

interface DisclosureRow {
  subscription_id: string;
  revision: number;
  status: string;
  watch_id: string;
  integration_name: string | null;
  compiled_plan_json: string;
  instruction: string | null;
}

/**
 * Every subscription that authorises a watch, newest-and-liveliest first.
 *
 * Ordered by {@link ANCHOR_ORDER} so that a watch whose delivery has changed —
 * and therefore owns a retired record and a live one — is described by the live
 * one. Only when nothing is live does a terminal record answer, which is what
 * keeps a revoked watch's egress history reachable.
 *
 * The watch id comes out of the compiled plan rather than a column: the plan is
 * the authority on what a subscription is, and a second marker beside it could
 * disagree with it.
 */
const DISCLOSURE_SELECT = `
  SELECT s.id            AS subscription_id,
         s.current_revision AS revision,
         s.status        AS status,
         d.name          AS integration_name,
         r.compiled_plan_json,
         json_extract(r.compiled_plan_json, '$.predicate.watchId') AS watch_id,
         CASE WHEN json_valid(r.reaction_json)
              THEN json_extract(r.reaction_json, '$.instruction') END AS instruction
    FROM subscriptions s
    JOIN subscription_revisions r
      ON r.subscription_id = s.id AND r.revision = s.current_revision
    LEFT JOIN devices d ON d.id = s.integration_device_id
   WHERE json_valid(r.compiled_plan_json)
     AND json_extract(r.compiled_plan_json, '$.predicate.kind') = 'watch-v2'
`;

const DISCLOSURE_ORDER = ` ${ANCHOR_ORDER}`;

/**
 * The plan a record carries, when this build can read it as a watch's.
 *
 * A record it cannot read is not a disclosure as far as it is concerned:
 * throwing would take down the whole listing because of one row written by a
 * newer version, and the SQL has already narrowed to the watch-v2 kind.
 */
function planOf(row: DisclosureRow): WatchV2Plan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.compiled_plan_json);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { predicate?: { kind?: unknown } }).predicate?.kind !== "string"
  ) {
    return null;
  }
  const shaped = parsed as { predicate: { kind: string } };
  return isWatchV2Plan(shaped) ? shaped : null;
}

function summaryOf(row: DisclosureRow): WatchDisclosureSummary | null {
  const plan = planOf(row);
  if (!plan) return null;
  return {
    // Read defensively rather than through the schema: a record written before
    // the field existed genuinely has no author, and all of those are the
    // operator's — which is what the schema's own default says too.
    authoredBy: (plan.predicate as { authoredBy?: WatchV2Author }).authoredBy ?? "operator",
    subscriptionId: row.subscription_id,
    status: row.status,
    integrationName: row.integration_name,
  };
}

/** Every watch that discloses to somebody, by watch id. */
export function watchDisclosureSummaries(db: Db): Map<string, WatchDisclosureSummary> {
  const rows = db.prepare<[], DisclosureRow>(`${DISCLOSURE_SELECT}${DISCLOSURE_ORDER}`).all();
  const summaries = new Map<string, WatchDisclosureSummary>();
  for (const row of rows) {
    if (typeof row.watch_id !== "string" || summaries.has(row.watch_id)) continue;
    const summary = summaryOf(row);
    if (summary) summaries.set(row.watch_id, summary);
  }
  return summaries;
}

/**
 * One watch's disclosure, or null when it wakes nobody.
 *
 * Reads the subscription record rather than restating it: the approval, the
 * expiry and the egress count are that record's answers, and a second copy here
 * could tell the operator a watch was still approved after the record said
 * otherwise.
 */
export function watchDisclosure(db: Db, watchId: string): WatchDisclosure | null {
  const rows = db
    .prepare<
      [string],
      DisclosureRow
    >(`${DISCLOSURE_SELECT} AND json_extract(r.compiled_plan_json, '$.predicate.watchId') = ?${DISCLOSURE_ORDER}`)
    .all(watchId);
  for (const row of rows) {
    const summary = summaryOf(row);
    const plan = planOf(row);
    if (!summary || !plan) continue;
    const record = getSubscriptionById(db, row.subscription_id);
    if (!record) continue;
    return {
      ...summary,
      // The record's own status, because it is the row this page describes and
      // the listing's copy of it is a projection taken at a different moment.
      status: record.status,
      revision: row.revision,
      interpretation: record.interpretedCondition.summary,
      condition: record.condition.description,
      instruction: row.instruction ?? "",
      evidence: plan.predicate.evidence,
      approval: record.approval,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
      policyRevision: record.policyRevision,
      firingCount: record.firingCount,
      lastFiredAt: record.lastFiredAt,
    };
  }
  return null;
}
