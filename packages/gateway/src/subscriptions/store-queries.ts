// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { externalAgentIdentity } from "../privacy/presentation.js";
import { getDocumentTitlesAndSources } from "../data/repositories/DocumentRepository.js";
import { isWatchV2Plan, watchV2FiringSeq } from "./watch-v2-plan.js";
import {
  conditionEvidenceKind,
  planEvidenceRule,
  parseStoredSubscriptionJson,
  storedSubscriptionCompiledPlanCodec,
  subscriptionConditionCodec,
  subscriptionEvidenceDocumentIdsCodec,
  subscriptionInterpretationCodec,
  subscriptionPrivacyCategoriesCodec,
  subscriptionReactionCodec,
  subscriptionWatchGroundingCodec,
} from "./store-codecs.js";
import type {
  SubscriptionApprovalDetail,
  SubscriptionApprovalSummary,
  SubscriptionDetail,
  SubscriptionFiringSummary,
  SubscriptionIosPushReaction,
  SubscriptionSummary,
} from "@omnesis/types";
import type { Db } from "../data/types.js";
import type {
  StoredSubscriptionApprovalRow,
  StoredSubscriptionRow,
  SubscriptionEvaluationJudgment,
  SubscriptionFiringAnswerAuthority,
  SubscriptionEvaluationDetail,
  SubscriptionEvaluationPromptContext,
  SubscriptionEvaluationStatus,
  ValidateSubscriptionFiringAnswerAuthorityResult,
} from "./store-types.js";
import type { SubscriptionCompiledPlan } from "./store-codecs.js";
import type { FiringAnswerEvidence } from "../privacy/firing-evidence.js";

/** How much of the judgment trail one trusted detail read carries by default. */
export const DEFAULT_SUBSCRIPTION_EVALUATION_LIMIT = 20;

/**
 * Who a record belongs to, derived from the device that asked for it.
 *
 * The owner scopes the idempotency key: `UNIQUE(owner_id, client_request_id)`
 * is what makes two concurrent retries of one request converge on one record
 * instead of minting two.
 */
export function subscriptionOwnerId(deviceId: string): string {
  return `device:${deviceId}`;
}

/**
 * The status of the record an idempotency key has already been spent on, or
 * null when the key is unused.
 *
 * A caller that *derives* its key from the shape of what it is asking for
 * needs this: two requests with the same shape are the same request only while
 * the first one's record is still alive. Once that record is terminal, an
 * identical-looking request is a new one, and converging on the dead record
 * would hand the caller something that does nothing.
 */
export function subscriptionStatusForRequest(
  db: Db,
  ownerId: string,
  clientRequestId: string,
): string | null {
  const row = db
    .prepare<
      [string, string],
      { status: string }
    >(`SELECT status FROM subscriptions WHERE owner_id = ? AND client_request_id = ?`)
    .get(ownerId, clientRequestId);
  return row?.status ?? null;
}

/**
 * Whether a subscription is an operator watch — one whose current revision
 * delivers by iOS push to the operator's own devices. The reaction kind IS
 * the distinction; no separate flag exists to drift from it. A missing or
 * corrupt row reads as `false`: callers use this to grant the agent rewrite
 * authority, and a row that cannot be parsed must not confer it.
 */
export function isOperatorWatchSubscription(db: Db, subscriptionId: string): boolean {
  return operatorWatchReaction(db, subscriptionId) !== null;
}

/**
 * The iOS-push reaction of an operator watch's current revision, or `null`
 * when the subscription is absent, delivers to an agent workflow instead, or
 * carries a reaction that no longer parses. Callers use it both to classify a
 * subscription and to render what its firing delivers.
 */
export function operatorWatchReaction(
  db: Db,
  subscriptionId: string,
): SubscriptionIosPushReaction | null {
  const row = db
    .prepare<[string], { reaction_json: string }>(
      `SELECT r.reaction_json
         FROM subscriptions s
         JOIN subscription_revisions r
           ON r.subscription_id = s.id AND r.revision = s.current_revision
        WHERE s.id = ?`,
    )
    .get(subscriptionId);
  if (!row) return null;
  try {
    const reaction = parseStoredSubscriptionJson(
      subscriptionReactionCodec,
      row.reaction_json,
      "reaction",
    );
    return reaction.kind === "ios-push" ? reaction : null;
  } catch {
    return null;
  }
}

/**
 * Full-admin projection. The per-candidate evaluation trail stays out of the
 * public SubscriptionDetail used by integration clients: a subscriber is
 * granted the existence of a match, not the scores and rationales behind every
 * candidate that was considered.
 */
export interface TrustedSubscriptionDetail extends SubscriptionDetail {
  /**
   * The `subscription_compile` cognition run that produced the current
   * revision's plan — the compile's transcript lives on that run
   * (`GET /admin/brain/runs/:id`). Null for revisions that predate recording
   * and for runs the ledger has since pruned, so a non-null id here is always
   * one a reader can still follow. Operator-only: an integration is granted a
   * plan, not the exchange that produced it.
   */
  compileRunId: string | null;
  /**
   * The watch this record authorises, read out of the compiled plan.
   *
   * Provenance runs both ways — the watch knows which record lets it wake an
   * agent, and this says which watch a record is about — so a caller holding
   * either id can reach the other. Null for a record whose plan is not a watch,
   * or one written by a build that predates them.
   */
  watchId: string | null;
}

/** Outbox state of the wake that carried one firing to the paired integration. */
interface TrustedSubscriptionFiringDelivery {
  id: string;
  status:
    | "pending"
    | "claimed"
    | "retry"
    | "cancel_pending"
    | "commit_authorized"
    | "manual_review"
    | "delivered"
    | "failed";
  attempts: number;
  acceptedAt: number | null;
  /** Identifier the integration reported for the background run it started. */
  localRunId: string | null;
  lastError: string | null;
  updatedAt: number;
}

/** The precision pass that decided whether a nominated document matched. */
interface TrustedSubscriptionFiringEvaluation {
  id: string;
  documentId: string;
  /** Null once the document has been privacy-deleted. */
  documentTitle: string | null;
  similarity: number;
  verdict: "pending" | "evaluating" | "matched" | "not_matched" | "retry" | "failed";
  rationale: string | null;
  evaluatorModel: string | null;
  attempts: number;
  settledAt: number;
}

/** An Answer task the integration opened against this firing's authority. */
interface TrustedSubscriptionFiringAnswerTask {
  taskId: string;
  conversationId: string;
  status:
    | "running"
    | "approval_required"
    | "released"
    | "released_with_reductions"
    | "denied"
    | "failed"
    | "canceled";
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * Full-admin projection of one firing.
 *
 * Everything added on top of {@link SubscriptionFiringSummary} — the nominated
 * document, the precision verdict and its rationale, the delivery's local run
 * identity, and the firing-bound Answer conversations — is operator-only. The
 * subscriber's surface stops at the summary, which discloses existence alone.
 */
export interface TrustedSubscriptionFiringDetail extends SubscriptionFiringSummary {
  indexEventKey: string;
  delivery: TrustedSubscriptionFiringDelivery | null;
  evidenceDocumentIds: string[];
  /** The same documents, named — minus any the corpus no longer holds. */
  evidenceDocuments: { id: string; title: string; sourceId: string }[];
  answerTasks: TrustedSubscriptionFiringAnswerTask[];
}

/** Firing totals for one subscription. */
export interface SubscriptionFiringStats {
  fireCount: number;
  lastFiredAt: number | null;
}

/**
 * Excludes the wake anchor of an *operator-installed* watch from a listing.
 *
 * Such an anchor is the record a watch the operator wrote wakes an agent
 * through. Nobody asked for it — they asked for the watch — so finding one on a
 * screen of "what agents have asked for" would be reading a request that was
 * never made, and on the approvals screen would be being asked to decide
 * something already decided.
 *
 * The test is *who authored it*, not which engine evaluates it. A watch an
 * integration asked for in prose is also evaluated by Watch V2 and also keeps a
 * record here, and that record is a request somebody made: it belongs in that
 * integration's listings and on the approvals screen, exactly like anything
 * else an agent has asked to be allowed to do. Keying on the engine would hide
 * it from both, which leaves an agent unable to see what it created and an
 * operator with no way to approve it.
 *
 * Excluded in SQL rather than filtered afterwards, for two reasons that both
 * bite: a page filtered after `LIMIT` returns short pages and a wrong total, and
 * a listing added later inherits the exclusion instead of having to remember it.
 *
 * By-id reads are deliberately *not* excluded. The only way to hold an anchor's
 * id is to have followed it from the watch that owns it, and at that point the
 * record is the answer to "what caused this egress entry" rather than a stranger
 * on a list.
 *
 * Requires the current revision to be joined as `r`.
 */
const NOT_AN_OPERATOR_WATCH_ANCHOR = `(
  COALESCE(json_extract(r.compiled_plan_json, '$.predicate.kind'), '') <> 'watch-v2'
  OR COALESCE(json_extract(r.compiled_plan_json, '$.predicate.authoredBy'), 'operator') = 'integration'
)`;

const CURRENT_SUBSCRIPTION_SELECT = `
  SELECT s.id, s.integration_device_id, s.workflow_id,
         s.current_revision,
         s.status, s.created_at, s.updated_at, s.expires_at, s.revoked_at,
         r.condition_json, r.reaction_json, r.interpretation_json,
         cr.id AS compile_run_id, r.privacy_categories_json, r.policy_revision,
         d.name AS integration_name, d.kind AS integration_kind,
         w.name AS workflow_name, w.purpose AS workflow_purpose,
         (SELECT COUNT(*) FROM subscription_firings f WHERE f.subscription_id = s.id)
           AS firing_count,
         (SELECT MAX(f.fired_at) FROM subscription_firings f WHERE f.subscription_id = s.id)
           AS last_fired_at
    FROM subscriptions s
    JOIN subscription_revisions r
      ON r.subscription_id = s.id AND r.revision = s.current_revision
    JOIN devices d ON d.id = s.integration_device_id
    JOIN answer_workflows w ON w.id = s.workflow_id
    -- The compile run is projected through the ledger rather than read off the
    -- revision, so the id resolves to null once the run ages out of a
    -- configured activity-retention window. A watch outlives its ledger
    -- entry; surfacing the stored id regardless would offer a link to a run
    -- that is gone.
    LEFT JOIN cognition_runs cr ON cr.id = r.compile_run_id
`;

type SubscriptionCursorKind = "subscriptions" | "firings";

export class SubscriptionCursorError extends Error {
  override readonly name = "SubscriptionCursorError";
}

function encodeSubscriptionCursor(
  kind: SubscriptionCursorKind,
  timestamp: number,
  id: string,
): string {
  return Buffer.from(JSON.stringify([kind, timestamp, id]), "utf8").toString("base64url");
}

function decodeSubscriptionCursor(
  cursor: string,
  expectedKind: SubscriptionCursorKind,
): { timestamp: number; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== expectedKind ||
      typeof value[1] !== "number" ||
      !Number.isSafeInteger(value[1]) ||
      typeof value[2] !== "string" ||
      value[2].length === 0
    ) {
      throw new SubscriptionCursorError();
    }
    return { timestamp: value[1], id: value[2] };
  } catch (error) {
    if (error instanceof SubscriptionCursorError) throw error;
    throw new SubscriptionCursorError();
  }
}

/** The sentence an ios-push reaction reads as on a client. */
const OPERATOR_WATCH_REACTION_SENTENCE = "Push a notification to your devices.";

/**
 * Wire projection of a stored reaction. An ios-push reaction is additionally
 * given its display `instruction` sentence: every client renders a watch's
 * reaction from that field and the older ones require it. Projection-only —
 * the strict stored codec never accepts it, and every write path rebuilds the
 * reaction from its own inputs, so the sentence cannot round-trip into a
 * revision row.
 */
function projectReactionForWire(
  reaction: ReturnType<(typeof subscriptionReactionCodec)["parse"]>,
): SubscriptionSummary["reaction"] {
  if (reaction.kind === "agent-workflow") return reaction;
  return { ...reaction, instruction: OPERATOR_WATCH_REACTION_SENTENCE };
}

export function projectSubscription(row: StoredSubscriptionRow): SubscriptionSummary {
  const condition = parseStoredSubscriptionJson(
    subscriptionConditionCodec,
    row.condition_json,
    "condition",
  );
  // External management clients only need the proposal they authored and its
  // lifecycle state. The deterministic compiler interpretation can contain
  // physical table/column dependencies; keep that detail on the trusted admin
  // approval projection instead of turning management into a schema probe.
  const externalInterpretation = {
    summary: condition.description,
    pushDetail: "existence" as const,
  };
  return {
    id: row.id,
    status: row.status,
    revision: row.current_revision,
    revisionId: String(row.current_revision),
    condition,
    reaction: projectReactionForWire(
      parseStoredSubscriptionJson(subscriptionReactionCodec, row.reaction_json, "reaction"),
    ),
    interpretation: externalInterpretation,
    interpretedCondition: externalInterpretation,
    workflowId: row.workflow_id,
    workflowHandle: row.workflow_id,
    integration: externalAgentIdentity(row.integration_name, "token"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? 0,
    revokedAt: row.revoked_at,
    firingCount: row.firing_count,
    lastFiredAt: row.last_fired_at,
  };
}

export function projectApprovalSummary(
  row: Omit<StoredSubscriptionApprovalRow, "grounding_json">,
  now = Number.NEGATIVE_INFINITY,
): SubscriptionApprovalSummary {
  const status = row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    revision: row.revision,
    revisionId: String(row.revision),
    workflowHandle: row.workflow_id,
    integration: externalAgentIdentity(row.integration_name, "token"),
    interpretedCondition: parseStoredSubscriptionJson(
      subscriptionInterpretationCodec,
      row.interpretation_json,
      "interpretation",
    ),
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

function projectSubscriptionDetail(
  db: Db,
  row: StoredSubscriptionRow,
  now: number,
): SubscriptionDetail {
  const approval = db
    .prepare<
      [string, number],
      Pick<
        StoredSubscriptionApprovalRow,
        | "id"
        | "subscription_id"
        | "revision"
        | "status"
        | "created_at"
        | "expires_at"
        | "resolved_at"
      >
    >(
      `SELECT id, subscription_id, revision, status, created_at, expires_at, resolved_at
         FROM subscription_approvals
        WHERE subscription_id = ? AND revision = ?`,
    )
    .get(row.id, row.current_revision);
  const subscription = projectSubscription(row);
  const approvalSummary = approval ? projectApprovalSummary({ ...row, ...approval }, now) : null;
  return {
    ...subscription,
    approval: approvalSummary
      ? { ...approvalSummary, interpretedCondition: subscription.interpretation }
      : null,
    categories: parseStoredSubscriptionJson(
      subscriptionPrivacyCategoriesCodec,
      row.privacy_categories_json,
      "privacy categories",
    ),
    policyRevision: row.policy_revision,
    integrationDevice: {
      id: row.integration_device_id,
      name: row.integration_name,
      kind: row.integration_kind,
    },
    workflow: {
      id: row.workflow_id,
      name: row.workflow_name,
      purpose: row.workflow_purpose,
    },
  };
}

export function getSubscriptionForDevice(
  db: Db,
  subscriptionId: string,
  integrationDeviceId: string,
  now = Number.NEGATIVE_INFINITY,
): SubscriptionDetail | null {
  const row = db
    .prepare<[string, string], StoredSubscriptionRow>(
      `${CURRENT_SUBSCRIPTION_SELECT}
       WHERE s.id = ? AND s.integration_device_id = ?`,
    )
    .get(subscriptionId, integrationDeviceId);
  if (!row) return null;
  return projectSubscriptionDetail(db, row, now);
}

export function listSubscriptionsForDevice(
  db: Db,
  integrationDeviceId: string,
): SubscriptionSummary[] {
  return db
    .prepare<[string], StoredSubscriptionRow>(
      `${CURRENT_SUBSCRIPTION_SELECT}
       WHERE s.integration_device_id = ? AND ${NOT_AN_OPERATOR_WATCH_ANCHOR}
       ORDER BY s.updated_at DESC, s.id`,
    )
    .all(integrationDeviceId)
    .map(projectSubscription);
}

export function getSubscriptionForRequest(
  db: Db,
  ownerId: string,
  clientRequestId: string,
  integrationDeviceId: string,
  now = Number.NEGATIVE_INFINITY,
): { requestFingerprint: string; subscription: SubscriptionDetail } | null {
  const row = db
    .prepare<[string, string], { id: string; request_fingerprint: string }>(
      `SELECT id, request_fingerprint FROM subscriptions
        WHERE owner_id = ? AND client_request_id = ?`,
    )
    .get(ownerId, clientRequestId);
  if (!row) return null;
  const subscription = getSubscriptionForDevice(db, row.id, integrationDeviceId, now);
  return subscription ? { requestFingerprint: row.request_fingerprint, subscription } : null;
}

export function listAllSubscriptions(
  db: Db,
  status: string | undefined,
  limit: number,
  cursor?: string,
): { subscriptions: SubscriptionSummary[]; nextCursor: string | null } {
  const after = cursor ? decodeSubscriptionCursor(cursor, "subscriptions") : null;
  const conditions: string[] = [NOT_AN_OPERATOR_WATCH_ANCHOR];
  const params: unknown[] = [];
  if (status && status !== "all") {
    conditions.push("s.status = ?");
    params.push(status);
  }
  if (after) {
    conditions.push("(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))");
    params.push(after.timestamp, after.timestamp, after.id);
  }
  const rows = db
    .prepare<unknown[], StoredSubscriptionRow>(
      `${CURRENT_SUBSCRIPTION_SELECT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    subscriptions: page.map(projectSubscription),
    nextCursor:
      hasMore && last ? encodeSubscriptionCursor("subscriptions", last.updated_at, last.id) : null,
  };
}

export function getSubscriptionById(
  db: Db,
  subscriptionId: string,
  now = Number.NEGATIVE_INFINITY,
  evaluationLimit = DEFAULT_SUBSCRIPTION_EVALUATION_LIMIT,
): TrustedSubscriptionDetail | null {
  const row = db
    .prepare<[string], StoredSubscriptionRow>(
      `${CURRENT_SUBSCRIPTION_SELECT}
       WHERE s.id = ?`,
    )
    .get(subscriptionId);
  if (!row) return null;
  const plan = getSubscriptionCompiledPlan(db, subscriptionId, row.current_revision);
  return {
    ...projectSubscriptionDetail(db, row, now),
    compileRunId: row.compile_run_id,
    watchId: plan && isWatchV2Plan(plan) ? plan.predicate.watchId : null,
  };
}

const APPROVAL_SELECT = `
  SELECT a.id, a.subscription_id, a.revision, a.status, a.created_at,
         a.expires_at, a.resolved_at, r.workflow_id, s.integration_device_id,
         r.condition_json, r.reaction_json, r.interpretation_json, r.grounding_json,
         r.privacy_categories_json, r.policy_revision,
         d.name AS integration_name, d.kind AS integration_kind,
         w.name AS workflow_name, w.purpose AS workflow_purpose
    FROM subscription_approvals a
    JOIN subscriptions s ON s.id = a.subscription_id
    JOIN subscription_revisions r
      ON r.subscription_id = a.subscription_id AND r.revision = a.revision
    JOIN devices d ON d.id = s.integration_device_id
    JOIN answer_workflows w ON w.id = r.workflow_id
`;

export function getSubscriptionApproval(
  db: Db,
  approvalId: string,
  now = Number.NEGATIVE_INFINITY,
): SubscriptionApprovalDetail | null {
  const row = db
    .prepare<[string], StoredSubscriptionApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = ?`)
    .get(approvalId);
  if (!row) return null;
  return {
    ...projectApprovalSummary(row, now),
    grounding:
      row.grounding_json === null
        ? null
        : parseStoredSubscriptionJson(
            subscriptionWatchGroundingCodec,
            row.grounding_json,
            "watch grounding",
          ),
    condition: parseStoredSubscriptionJson(
      subscriptionConditionCodec,
      row.condition_json,
      "condition",
    ),
    reaction: projectReactionForWire(
      parseStoredSubscriptionJson(subscriptionReactionCodec, row.reaction_json, "reaction"),
    ),
    interpretation: parseStoredSubscriptionJson(
      subscriptionInterpretationCodec,
      row.interpretation_json,
      "interpretation",
    ),
    workflowId: row.workflow_id,
    integrationDeviceId: row.integration_device_id,
    categories: parseStoredSubscriptionJson(
      subscriptionPrivacyCategoriesCodec,
      row.privacy_categories_json,
      "privacy categories",
    ),
    policyRevision: row.policy_revision,
    integrationDevice: {
      id: row.integration_device_id,
      name: row.integration_name,
      kind: row.integration_kind,
    },
    workflow: {
      id: row.workflow_id,
      name: row.workflow_name,
      purpose: row.workflow_purpose,
    },
  };
}

/**
 * Which approval rows a listing is about.
 *
 *   - `"decidable"` — the approvals a human is being asked to resolve. An
 *     operator watch delivers to the operator's own devices and is approved
 *     by the request that created it, so its approval row is internal
 *     bookkeeping the activation healer owns, never a question for anyone.
 *     This is what every client-facing surface must read.
 *   - `"all"` — every row, including that bookkeeping. Only the healer wants
 *     this.
 */
export type SubscriptionApprovalAudience = "decidable" | "all";

export interface SubscriptionApprovalPage {
  approvals: SubscriptionApprovalSummary[];
  nextCursor: string | null;
  totalCount: number;
}

/**
 * Ids of pending approvals for operator watches whose activation has not yet
 * landed — the healer's whole worklist.
 *
 * Filtered in SQL rather than by projecting every approval: pending
 * INTEGRATION approvals are a normal steady state (they wait up to a week for
 * the operator's tap), and the healer runs on every delivery drain. Scanning
 * and JSON-parsing that queue each pass would put a table scan on the main
 * runner seconds apart, forever, to find rows that are usually none.
 */
export function listPendingOperatorWatchApprovalIds(
  db: Db,
  now: number,
): Array<{ id: string; subscriptionId: string }> {
  return db
    .prepare<[number], { id: string; subscription_id: string }>(
      `SELECT a.id, a.subscription_id
         FROM subscription_approvals a
         JOIN subscriptions s ON s.id = a.subscription_id
         JOIN subscription_revisions r
           ON r.subscription_id = a.subscription_id AND r.revision = a.revision
        WHERE a.status = 'pending'
          AND a.expires_at > ?
          AND s.current_revision = a.revision
          AND (
                CASE WHEN json_valid(r.reaction_json)
                     THEN json_extract(r.reaction_json, '$.kind') END = 'ios-push'
                -- A Watch V2 anchor also carries the operator's own authority:
                -- the DSL delivery block is the grant. It is discriminated on
                -- the plan rather than the reaction, because its reaction is
                -- an agent workflow — the same shape as an integration's own
                -- subscription, which must wait for a privacy decision.
                OR CASE WHEN json_valid(r.compiled_plan_json)
                        THEN json_extract(r.compiled_plan_json, '$.predicate.kind') END
                     = 'watch-v2'
              )
        ORDER BY a.created_at, a.id`,
    )
    .all(now)
    .map((row) => ({ id: row.id, subscriptionId: row.subscription_id }));
}

export function listSubscriptionApprovals(
  db: Db,
  status?: SubscriptionApprovalSummary["status"],
  now = Date.now(),
  audience: SubscriptionApprovalAudience = "decidable",
  limit = 100,
): SubscriptionApprovalSummary[] {
  return listSubscriptionApprovalPage(db, status, limit, undefined, now, audience).approvals;
}

export function listSubscriptionApprovalPage(
  db: Db,
  status: SubscriptionApprovalSummary["status"] | undefined,
  limit: number,
  cursor?: string,
  now = Date.now(),
  audience: SubscriptionApprovalAudience = "decidable",
): SubscriptionApprovalPage {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const after = cursor ? decodeApprovalCursor(cursor, status, audience) : null;
  const audienceWhere =
    audience === "all"
      ? NOT_AN_OPERATOR_WATCH_ANCHOR
      : `${NOT_AN_OPERATOR_WATCH_ANCHOR} AND CASE WHEN json_valid(r.reaction_json) THEN (
           json_type(r.reaction_json, '$') = 'object'
           AND json_extract(r.reaction_json, '$.kind') = 'agent-workflow'
           AND json_type(r.reaction_json, '$.instruction') = 'text'
           AND length(json_extract(r.reaction_json, '$.instruction')) BETWEEN 1 AND 8000
           AND length(trim(json_extract(r.reaction_json, '$.instruction'))) > 0
           AND NOT EXISTS (
             SELECT 1 FROM json_each(r.reaction_json) reaction_field
              WHERE reaction_field.key NOT IN ('kind', 'instruction')
           )
         ) ELSE 0 END`;
  const [statusWhere, statusParams] =
    status === undefined
      ? ["1 = 1", []]
      : status === "pending"
        ? ["a.status = 'pending' AND a.expires_at > ?", [now]]
        : status === "expired"
          ? ["(a.status = 'expired' OR (a.status = 'pending' AND a.expires_at <= ?))", [now]]
          : ["a.status = ?", [status]];
  const cursorWhere = after ? "AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))" : "";
  const params = [
    ...statusParams,
    ...(after ? [after.createdAt, after.createdAt, after.id] : []),
    safeLimit + 1,
  ];
  const rows = db
    .prepare<unknown[], StoredSubscriptionApprovalRow>(
      `${APPROVAL_SELECT}
       WHERE ${audienceWhere} AND ${statusWhere}
       ${cursorWhere}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(...params);
  const hasMore = rows.length > safeLimit;
  const approvals = rows.slice(0, safeLimit).map((row) => projectApprovalSummary(row, now));
  const last = approvals.at(-1);
  const totalCount =
    db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count
           FROM subscription_approvals a
           JOIN subscription_revisions r
             ON r.subscription_id = a.subscription_id AND r.revision = a.revision
          WHERE ${audienceWhere} AND ${statusWhere}`,
      )
      .get(...statusParams)?.count ?? 0;
  return {
    approvals,
    nextCursor:
      hasMore && last ? encodeApprovalCursor(status, audience, last.createdAt, last.id) : null,
    totalCount,
  };
}

function encodeApprovalCursor(
  status: SubscriptionApprovalSummary["status"] | undefined,
  audience: SubscriptionApprovalAudience,
  createdAt: number,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify(["subscription-approvals", status ?? "all", audience, createdAt, id]),
    "utf8",
  ).toString("base64url");
}

function decodeApprovalCursor(
  cursor: string,
  expectedStatus: SubscriptionApprovalSummary["status"] | undefined,
  expectedAudience: SubscriptionApprovalAudience,
): { createdAt: number; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      value[0] !== "subscription-approvals" ||
      value[1] !== (expectedStatus ?? "all") ||
      value[2] !== expectedAudience ||
      typeof value[3] !== "number" ||
      !Number.isSafeInteger(value[3]) ||
      typeof value[4] !== "string" ||
      value[4].length === 0
    ) {
      throw new SubscriptionCursorError();
    }
    return { createdAt: value[3], id: value[4] };
  } catch (error) {
    if (error instanceof SubscriptionCursorError) throw error;
    throw new SubscriptionCursorError();
  }
}

export function listSubscriptionFirings(
  db: Db,
  subscriptionId: string,
  limit: number,
  cursor?: string,
): { firings: SubscriptionFiringSummary[]; nextCursor: string | null } {
  const after = cursor ? decodeSubscriptionCursor(cursor, "firings") : null;
  const rows = db
    .prepare<
      unknown[],
      {
        id: string;
        subscription_id: string;
        revision: number;
        workflow_id: string;
        status: SubscriptionFiringSummary["status"];
        fired_at: number;
        accepted_at: number | null;
        index_event_key: string;
        compiled_plan_json: string;
      }
    >(
      `SELECT f.id, f.subscription_id, f.revision, f.workflow_id, f.status,
              f.fired_at, d.accepted_at, f.index_event_key, r.compiled_plan_json
         FROM subscription_firings f
         LEFT JOIN subscription_deliveries d ON d.firing_id = f.id
         LEFT JOIN subscription_revisions r
           ON r.subscription_id = f.subscription_id AND r.revision = f.revision
        WHERE f.subscription_id = ?
          ${after ? "AND (f.fired_at < ? OR (f.fired_at = ? AND f.id < ?))" : ""}
        ORDER BY f.fired_at DESC, f.id DESC
        LIMIT ?`,
    )
    .all(subscriptionId, ...(after ? [after.timestamp, after.timestamp, after.id] : []), limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    firings: page.map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      revision: row.revision,
      revisionId: String(row.revision),
      workflowId: row.workflow_id,
      workflowHandle: row.workflow_id,
      status: row.status,
      firedAt: row.fired_at,
      createdAt: row.fired_at,
      deliveryStatus: row.status,
      acceptedAt: row.accepted_at,
      // Where this moment lives in the runtime that produced it. A wake and an
      // installed watch's firing are the same event seen from two sides, and
      // without these the wake side had no way to reach the canvas that
      // explains it — which read as the canvas not covering wakes at all.
      ...watchOrigin(row.compiled_plan_json, row.index_event_key),
    })),
    nextCursor:
      hasMore && last ? encodeSubscriptionCursor("firings", last.fired_at, last.id) : null,
  };
}

/**
 * The watch a firing belongs to and the journal event it happened on, when the
 * record is a watch's.
 *
 * Both or neither: a sequence without the watch that owns it addresses nothing,
 * and a watch id without a sequence opens the canvas on no particular moment.
 * A record whose plan is not a watch — or whose firing key predates the current
 * shape — gets neither, and the surfaces that would link there show no link
 * rather than one that lands on somebody else's event.
 */
/** The stored plan document for one revision, unparsed. */
function getSubscriptionCompiledPlanJson(
  db: Db,
  subscriptionId: string,
  revision: number,
): string | null {
  const row = db
    .prepare<[string, number], { compiled_plan_json: string }>(
      `SELECT compiled_plan_json
         FROM subscription_revisions
        WHERE subscription_id = ? AND revision = ?`,
    )
    .get(subscriptionId, revision);
  return row?.compiled_plan_json ?? null;
}

function watchOrigin(
  compiledPlanJson: string | null,
  indexEventKey: string,
): { watchId: string; seq: number } | Record<string, never> {
  if (!compiledPlanJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(compiledPlanJson);
  } catch {
    return {};
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { predicate?: { kind?: unknown } }).predicate?.kind !== "string"
  ) {
    return {};
  }
  const plan = parsed as { predicate: { kind: string } };
  if (!isWatchV2Plan(plan)) return {};
  const watchId = plan.predicate.watchId;
  const seq = watchV2FiringSeq(indexEventKey, watchId);
  return seq === null ? {} : { watchId, seq };
}

/**
 * Firing totals keyed by subscription id. Subscriptions that have never fired
 * are absent from the map.
 *
 * The count and the last instant are kept here, on the record, rather than
 * derived from the watch runtime's own ledger: a record survives the watch
 * behind it being rewritten, and its history is about the agreement rather
 * than about whichever definition was current when each firing happened.
 */
export function subscriptionFiringStats(
  db: Db,
  subscriptionIds: readonly string[],
): Map<string, SubscriptionFiringStats> {
  const stats = new Map<string, SubscriptionFiringStats>();
  const unique = [...new Set(subscriptionIds)];
  if (unique.length === 0) return stats;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare<
      string[],
      { subscription_id: string; fire_count: number; last_fired_at: number | null }
    >(
      `SELECT subscription_id, COUNT(*) AS fire_count, MAX(fired_at) AS last_fired_at
         FROM subscription_firings
        WHERE subscription_id IN (${placeholders})
        GROUP BY subscription_id`,
    )
    .all(...unique);
  for (const row of rows) {
    stats.set(row.subscription_id, {
      fireCount: row.fire_count,
      lastFiredAt: row.last_fired_at,
    });
  }
  return stats;
}

/**
 * One firing with the operator-only audit trail behind it: what was nominated,
 * how the precision pass ruled, how the wake was delivered, and which Answer
 * conversations the integration opened against it.
 *
 * Scoped by the owning subscription, so a firing id belonging to a different
 * subscription reads as missing rather than leaking a sibling's audit.
 */
export function getSubscriptionFiring(
  db: Db,
  subscriptionId: string,
  firingId: string,
): TrustedSubscriptionFiringDetail | null {
  const row = db
    .prepare<
      [string, string],
      {
        id: string;
        subscription_id: string;
        revision: number;
        workflow_id: string;
        status: SubscriptionFiringSummary["status"];
        fired_at: number;
        index_event_key: string;
        delivery_id: string | null;
        delivery_status: TrustedSubscriptionFiringDelivery["status"] | null;
        delivery_attempts: number | null;
        accepted_at: number | null;
        local_run_id: string | null;
        last_error: string | null;
        delivery_updated_at: number | null;
      }
    >(
      `SELECT f.id, f.subscription_id, f.revision, f.workflow_id, f.status,
              f.fired_at, f.index_event_key,
              d.id AS delivery_id, d.status AS delivery_status,
              d.attempts AS delivery_attempts, d.accepted_at, d.local_run_id,
              d.last_error, d.updated_at AS delivery_updated_at
         FROM subscription_firings f
         LEFT JOIN subscription_deliveries d ON d.firing_id = f.id
        WHERE f.id = ? AND f.subscription_id = ?`,
    )
    .get(firingId, subscriptionId);
  if (!row) return null;
  const evidenceDocumentIds = db
    .prepare<[string], { document_id: string }>(
      `SELECT document_id FROM subscription_firing_evidence WHERE firing_id = ? ORDER BY document_id`,
    )
    .all(row.id)
    .map((evidence) => evidence.document_id);
  // Resolved here rather than left to the client, which would otherwise render
  // a firing's evidence as a list of opaque ids until it had fetched each one.
  // A document the corpus no longer holds is simply absent: it can be deleted
  // after the firing that cited it, and a page that refused to render over one
  // is worse than one that shows what it still has.
  const evidenceTitles = getDocumentTitlesAndSources(db, [...evidenceDocumentIds]);
  const evidenceDocuments = evidenceDocumentIds.flatMap((id) => {
    const found = evidenceTitles.get(id);
    return found ? [{ id, title: found.title, sourceId: found.sourceId }] : [];
  });
  const answerTasks = db
    .prepare<
      [string],
      {
        id: string;
        conversation_id: string;
        status: TrustedSubscriptionFiringAnswerTask["status"];
        created_at: number;
        resolved_at: number | null;
      }
    >(
      `SELECT id, conversation_id, status, created_at, resolved_at
         FROM answer_tasks
        WHERE subscription_firing_id = ?
        ORDER BY created_at, id`,
    )
    .all(row.id)
    .map((task) => ({
      taskId: task.id,
      conversationId: task.conversation_id,
      status: task.status,
      createdAt: task.created_at,
      resolvedAt: task.resolved_at,
    }));
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    revision: row.revision,
    revisionId: String(row.revision),
    workflowId: row.workflow_id,
    workflowHandle: row.workflow_id,
    status: row.status,
    firedAt: row.fired_at,
    createdAt: row.fired_at,
    deliveryStatus: row.status,
    acceptedAt: row.accepted_at,
    indexEventKey: row.index_event_key,
    // The moment in the runtime that produced this, so the page can open the
    // canvas on it. Same projection the listing carries; absent together when
    // the record is not a watch's.
    ...watchOrigin(
      getSubscriptionCompiledPlanJson(db, subscriptionId, row.revision),
      row.index_event_key,
    ),
    delivery:
      row.delivery_id === null
        ? null
        : {
            id: row.delivery_id,
            status: row.delivery_status ?? "pending",
            attempts: row.delivery_attempts ?? 0,
            acceptedAt: row.accepted_at,
            localRunId: row.local_run_id,
            lastError: row.last_error,
            updatedAt: row.delivery_updated_at ?? row.fired_at,
          },
    evidenceDocumentIds,
    evidenceDocuments,
    answerTasks,
  };
}

interface StoredFiringAnswerAuthorityRow {
  id: string;
  token_id: string;
  delivery_id: string;
  firing_id: string;
  subscription_id: string;
  revision: number;
  workflow_id: string;
  owner_id: string;
  evidence_json: string;
  expected_evidence_count: number;
  observation_json: string | null;
  live_evidence_count: number;
  compiled_plan_json: string;
  interpretation_json: string;
  fired_at: number;
  policy_revision: string;
  created_at: number;
  expires_at: number;
  first_used_at: number | null;
  last_used_at: number | null;
  use_count: number;
  consumed_at: number | null;
  revoked_at: number | null;
  token_expires_at: number | null;
  subscription_revision: number;
  subscription_status: string;
  subscription_expires_at: number | null;
  subscription_revoked_at: number | null;
  revision_policy: string;
  grant_policy: string | null;
  grant_expires_at: number | null;
  grant_revoked_at: number | null;
  grant_integration_device_id: string | null;
  grant_workflow_id: string | null;
  workflow_owner_id: string;
  workflow_status: string;
  workflow_expires_at: number;
  delivery_status: string;
  delivery_claim_expires_at: number | null;
  delivery_integration_device_id: string;
}

/**
 * The observation a firing recorded, or null when it recorded none.
 *
 * Tolerant on purpose. This is context handed to an answering turn, not an
 * authority: a row whose JSON cannot be read should cost the answer its detail,
 * not refuse the whole firing and leave a woken agent unable to learn anything.
 */
function parseStoredObservation(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.keys(parsed).length > 0 ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function projectFiringAnswerAuthority(
  row: StoredFiringAnswerAuthorityRow,
): SubscriptionFiringAnswerAuthority {
  const plan = parseStoredSubscriptionJson(
    storedSubscriptionCompiledPlanCodec,
    row.compiled_plan_json,
    "compiled plan",
  );
  // A firing that carries no documents offers what the operator approved, the
  // instant it became true, and what the plan observed satisfying it. A plan
  // that must carry documents has no such shape, so an empty evidence list
  // there is corruption and the codec below says so.
  //
  // The observation is stored prose-free — the fields the watch's author chose
  // to report — and a row written before the column existed simply has none.
  const observation = parseStoredObservation(row.observation_json);
  const firingEvidence: FiringAnswerEvidence =
    row.expected_evidence_count === 0
      ? {
          kind: conditionEvidenceKind(plan),
          conditionSummary: parseStoredSubscriptionJson(
            subscriptionInterpretationCodec,
            row.interpretation_json,
            "interpretation",
          ).summary,
          firedAt: row.fired_at,
          ...(observation === null ? {} : { observation }),
        }
      : {
          kind: "documents",
          documentIds: parseStoredSubscriptionJson(
            subscriptionEvidenceDocumentIdsCodec,
            row.evidence_json,
            "firing evidence",
          ),
        };
  const evidenceDocumentIds =
    firingEvidence.kind === "documents" ? [...firingEvidence.documentIds] : [];
  return {
    id: row.id,
    tokenId: row.token_id,
    deliveryId: row.delivery_id,
    firingId: row.firing_id,
    subscriptionId: row.subscription_id,
    revision: row.revision,
    workflowId: row.workflow_id,
    ownerId: row.owner_id,
    evidenceDocumentIds,
    firingEvidence,
    policyRevision: row.policy_revision,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Read the immutable executable plan separately from the short-lived Answer
 * authority projection. Keeping it out of that projection prevents physical
 * analytics schema details from crossing an authority or transport boundary.
 */
export function getSubscriptionCompiledPlan(
  db: Db,
  subscriptionId: string,
  revision: number,
): SubscriptionCompiledPlan | null {
  const row = db
    .prepare<[string, number], { compiled_plan_json: string }>(
      `SELECT compiled_plan_json
         FROM subscription_revisions
        WHERE subscription_id = ? AND revision = ?`,
    )
    .get(subscriptionId, revision);
  if (!row) return null;
  return parseStoredSubscriptionJson(
    storedSubscriptionCompiledPlanCodec,
    row.compiled_plan_json,
    "compiled plan",
  );
}

/**
 * Validate the exact bearer-token + firing binding used by the firing answer
 * route. Callers still perform the final use through the writer mutation,
 * which repeats these checks and records the cumulative use audit atomically.
 */
export function validateSubscriptionFiringAnswerAuthority(
  db: Db,
  input: {
    tokenId: string;
    firingId: string;
    policyRevision: string;
    now: number;
  },
  options: {
    /**
     * Issuance verifies the freshly-created row while its delivery is still
     * claimed. External Answer use must never set this: prepare is not the
     * privacy release boundary.
     */
    allowClaimedForIssuance?: boolean;
  } = {},
): ValidateSubscriptionFiringAnswerAuthorityResult {
  const row = db
    .prepare<[string, string], StoredFiringAnswerAuthorityRow>(
      `SELECT a.*,
              COALESCE((
                SELECT json_group_array(e.document_id)
                  FROM subscription_firing_evidence e
                 WHERE e.firing_id = f.id
              ), '[]') AS evidence_json,
              f.evidence_count AS expected_evidence_count,
              f.observation_json,
              (SELECT COUNT(*) FROM subscription_firing_evidence e WHERE e.firing_id = f.id)
                AS live_evidence_count,
              r.compiled_plan_json,
              r.interpretation_json,
              f.fired_at,
              t.expires_at AS token_expires_at,
              s.current_revision AS subscription_revision,
              s.status AS subscription_status,
              s.expires_at AS subscription_expires_at,
              s.revoked_at AS subscription_revoked_at,
              r.policy_revision AS revision_policy,
              g.policy_revision AS grant_policy,
              g.expires_at AS grant_expires_at,
              g.revoked_at AS grant_revoked_at,
              g.integration_device_id AS grant_integration_device_id,
              g.workflow_id AS grant_workflow_id,
              w.owner_id AS workflow_owner_id,
              w.status AS workflow_status,
              w.expires_at AS workflow_expires_at,
              d.status AS delivery_status,
              d.claim_expires_at AS delivery_claim_expires_at,
              d.integration_device_id AS delivery_integration_device_id
         FROM subscription_firing_answer_authorities a
         JOIN tokens t ON t.id = a.token_id
         JOIN subscriptions s ON s.id = a.subscription_id
         JOIN subscription_revisions r
           ON r.subscription_id = a.subscription_id AND r.revision = a.revision
         LEFT JOIN subscription_grants g
           ON g.subscription_id = a.subscription_id AND g.revision = a.revision
         JOIN answer_workflows w ON w.id = a.workflow_id
         JOIN subscription_deliveries d ON d.id = a.delivery_id
         JOIN subscription_firings f ON f.id = a.firing_id
        WHERE a.token_id = ? AND a.firing_id = ?`,
    )
    .get(input.tokenId, input.firingId);
  if (!row) return { outcome: "not_found" };
  if (row.live_evidence_count !== row.expected_evidence_count) return { outcome: "inactive" };
  const plan = parseStoredSubscriptionJson(
    storedSubscriptionCompiledPlanCodec,
    row.compiled_plan_json,
    "compiled plan",
  );
  // A condition-only plan whose firing somehow recorded documents is a row that
  // disagrees with what the operator approved; no authority is issued over it.
  if (planEvidenceRule(plan) === "none" && row.expected_evidence_count !== 0) {
    return { outcome: "inactive" };
  }
  if (row.revoked_at !== null) return { outcome: "revoked" };
  if (row.consumed_at !== null) return { outcome: "consumed" };
  if (
    row.expires_at <= input.now ||
    (row.token_expires_at !== null && row.token_expires_at <= input.now)
  ) {
    return { outcome: "expired" };
  }
  if (
    row.subscription_status !== "active" ||
    row.subscription_revoked_at !== null ||
    (row.subscription_expires_at !== null && row.subscription_expires_at <= input.now) ||
    row.workflow_status !== "active" ||
    row.workflow_expires_at <= input.now ||
    (row.delivery_status !== "commit_authorized" &&
      row.delivery_status !== "manual_review" &&
      row.delivery_status !== "delivered" &&
      !(options.allowClaimedForIssuance === true && row.delivery_status === "claimed")) ||
    (row.delivery_status === "claimed" &&
      (row.delivery_claim_expires_at === null || row.delivery_claim_expires_at <= input.now))
  ) {
    return { outcome: "inactive" };
  }
  if (row.subscription_revision !== row.revision) return { outcome: "stale_revision" };
  if (
    row.policy_revision !== input.policyRevision ||
    row.revision_policy !== input.policyRevision ||
    (row.grant_policy !== null && row.grant_policy !== input.policyRevision)
  ) {
    return { outcome: "policy_changed" };
  }
  if (
    row.grant_policy === null ||
    row.grant_revoked_at !== null ||
    row.grant_expires_at === null ||
    row.grant_expires_at <= input.now ||
    row.workflow_owner_id !== row.owner_id ||
    row.grant_integration_device_id !== row.delivery_integration_device_id ||
    row.grant_workflow_id !== row.workflow_id
  ) {
    return { outcome: "grant_unavailable" };
  }
  return { outcome: "authorized", authority: projectFiringAnswerAuthority(row) };
}

/**
 * What became of the wakes a set of watch firings caused.
 *
 * Keyed by the watch runtime's own firing key, which the anchor stores as its
 * `index_event_key` — so a caller holding watch-side firings can ask what the
 * subscriptions side did with them without knowing anything about anchors.
 *
 * A firing with no row here was never reported into an anchor: the watch does
 * not wake an agent, or its anchor was retired. That is silence with a cause,
 * and distinguishing it from a wake nobody answered is the point.
 *
 * A key is unique per subscription and revision rather than outright, so a
 * watch whose anchor was re-minted can hold several rows under one key. They
 * are read oldest-first and the newest wins, which is both the useful answer
 * and a stable one — an unordered read would let two passes over an unchanged
 * install disagree.
 */
export function listWorkflowOutcomesForFiringKeys(
  db: Db,
  firingKeys: readonly string[],
): Map<string, StoredWatchWorkflowOutcome> {
  const found = new Map<string, StoredWatchWorkflowOutcome>();
  if (firingKeys.length === 0) return found;
  // Chunked because SQLite caps a statement's variables, and a day of firings
  // on a busy install is comfortably past that ceiling.
  const CHUNK = 200;
  for (let start = 0; start < firingKeys.length; start += CHUNK) {
    const chunk = firingKeys.slice(start, start + CHUNK);
    const rows = db
      .prepare<
        string[],
        {
          index_event_key: string;
          subscription_id: string;
          firing_id: string;
          delivery_status: string | null;
          accepted_at: number | null;
          local_run_id: string | null;
          outcome_status: string | null;
          outcome_report: string | null;
          outcome_reported_at: number | null;
        }
      >(
        `SELECT f.index_event_key, f.subscription_id, f.id AS firing_id,
                d.status AS delivery_status, d.accepted_at, d.local_run_id,
                o.status AS outcome_status, o.report AS outcome_report,
                o.reported_at AS outcome_reported_at
           FROM subscription_firings f
           LEFT JOIN subscription_deliveries d ON d.firing_id = f.id
           LEFT JOIN subscription_firing_outcomes o ON o.firing_id = f.id
          WHERE f.index_event_key IN (${chunk.map(() => "?").join(", ")})
          ORDER BY f.fired_at ASC, f.id ASC`,
      )
      .all(...chunk);
    for (const row of rows) {
      found.set(row.index_event_key, {
        subscriptionId: row.subscription_id,
        firingId: row.firing_id,
        deliveryStatus: row.delivery_status ?? "pending",
        acceptedAt: row.accepted_at,
        localRunId: row.local_run_id,
        outcome:
          row.outcome_status === null || row.outcome_reported_at === null
            ? null
            : {
                status: row.outcome_status,
                report: row.outcome_report,
                reportedAt: row.outcome_reported_at,
              },
      });
    }
  }
  return found;
}

export interface StoredWatchWorkflowOutcome {
  subscriptionId: string;
  firingId: string;
  deliveryStatus: string;
  acceptedAt: number | null;
  localRunId: string | null;
  outcome: { status: string; report: string | null; reportedAt: number } | null;
}
