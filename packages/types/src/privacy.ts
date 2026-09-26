// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Public outcomes from the answer privacy boundary. */
export const ANSWER_RELEASE_STATUSES = [
  "released",
  "released_with_reductions",
  "approval_required",
  "denied",
] as const;

export type AnswerReleaseStatus = (typeof ANSWER_RELEASE_STATUSES)[number];

export interface AnswerResponseBase {
  status: AnswerReleaseStatus;
  workflowId: string;
  conversationId: string;
  taskId: string;
}

export interface ReleasedAnswerResponse extends AnswerResponseBase {
  status: "released";
  releaseId: string;
  answer: string;
}

export interface ReducedAnswerResponse extends AnswerResponseBase {
  status: "released_with_reductions";
  releaseId: string;
  answer: string;
  reductions: string[];
}

export interface ApprovalRequiredAnswerResponse extends AnswerResponseBase {
  status: "approval_required";
  approvalId: string;
  approvalExpiresAt: number;
}

export interface DeniedAnswerResponse extends AnswerResponseBase {
  status: "denied";
  /** Deliberately generic: policy findings never cross the answer boundary. */
  reason:
    | "privacy_policy"
    | "hard_stop"
    | "user_denied"
    | "expired"
    | "canceled"
    | "approval_not_available";
}

export type AnswerResponse =
  | ReleasedAnswerResponse
  | ReducedAnswerResponse
  | ApprovalRequiredAnswerResponse
  | DeniedAnswerResponse;

export const PRIVACY_DETAIL_LEVELS = ["existence", "summary", "exact", "original"] as const;
export type PrivacyDetailLevel = (typeof PRIVACY_DETAIL_LEVELS)[number];

export const PRIVACY_FINDING_DISPOSITIONS = ["allow", "reduce", "approval", "deny"] as const;
export type PrivacyFindingDisposition = (typeof PRIVACY_FINDING_DISPOSITIONS)[number];

export interface PrivacyFinding {
  /** Semantic category such as schedule, health, money, or private communication. */
  category: string;
  detailLevel: PrivacyDetailLevel;
  subject: "user" | "other_person" | "multiple_people" | "unknown";
  disposition: PrivacyFindingDisposition;
  /** A category-level explanation that must not quote the held answer. */
  description: string;
}

export const PRIVACY_REVIEWER_FALLBACK_CAUSES = [
  "not_configured",
  "request_failed",
  "context_window_exceeded",
  "output_truncated",
  "invalid_output",
  "low_confidence",
  "policy_requires_review",
  "hard_stop",
] as const;

export type PrivacyReviewerFallbackCause = (typeof PRIVACY_REVIEWER_FALLBACK_CAUSES)[number];

export interface PrivacyReviewRecord {
  recipeVersion: string;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  policyRevision: string;
  /**
   * The policy family the release was reviewed under, when the reviewer knew
   * it; absent on records written before families were recorded.
   */
  policyFamilyId?: string;
  policyFamilyName?: string;
  /**
   * True only when the deterministic credential detector found a credential
   * and the reviewed policy explicitly requires one-time approval instead of
   * applying the default non-overridable hard stop.
   */
  credentialApprovalRequired?: boolean;
  /** SHA-256 of the exact review envelope supplied to the reviewer. */
  envelopeDigest?: string;
  /** Typed fail-closed cause. Optional for records written by older gateways. */
  fallbackCause?: PrivacyReviewerFallbackCause | null;
  findings: PrivacyFinding[];
  rationale: string;
}

/**
 * Who the external caller is presented as. A legacy token or integration may
 * supply its own label; an OAuth principal name is approved by the owner.
 * `narrativeName` is the display name with an integration slug removed, for
 * plain-language sentences where "Atlas asked" reads better than
 * "Atlas (openclaw) asked".
 *
 * The split is derived here rather than in each client, because recovering a
 * field by parsing a display string is the producer's job and three
 * independent regexes disagree about it.
 */
export interface PrivacyExternalAgentIdentity {
  displayName: string;
  /** `displayName` without its integration suffix; equal to it when there is none. */
  narrativeName: string;
  /** The agent integration named in `displayName`, or null when it names none. */
  integrationSlug: string | null;
  /** The specific OAuth installation using this principal, when known. */
  connectionName?: string | null;
  /**
   * The kind of the paired device that asked (`cli`, `ios`, `agent`, …), when
   * a device did — what a client draws its icon from. Absent for an OAuth
   * principal and for a caller no device accounts for.
   */
  deviceKind?: string | null;
  /**
   * Where the name came from: the caller's own token, an owner-approved OAuth
   * principal, the paired integration device a gateway-run answer was raised
   * on behalf of, or nothing at all.
   *
   * Clients must tolerate a value they do not know — provenance is a breadcrumb,
   * and a reader that refuses to render an approval because it cannot place the
   * name has traded the operator's decision for a detail none of the surfaces
   * display.
   */
  source: "token" | "integration" | "principal" | "fallback";
}

export interface PrivacyExternalMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PrivacyCumulativeCategory {
  category: string;
  detailLevel: PrivacyDetailLevel;
  subject: PrivacyFinding["subject"];
  count: number;
}

export interface PrivacyCumulativeDisclosure {
  /** Monotonic workflow release revision bound into the reviewer envelope. */
  revision: number;
  /** Monotonic revision of existence signals disclosed by Watch firings. */
  existenceRevision: number;
  /** Number of Watch existence signals disclosed in this workflow. */
  existenceSignals: number;
  releasedTurns: number;
  releasedCharacters: number;
  olderTurnsOmitted: number;
  categories: PrivacyCumulativeCategory[];
}

export interface PrivacyPolicyDocument {
  policy: string;
  /** Monotonic ledger position. Every effective change, including a revert, advances it. */
  generation: number;
  /** SHA-256 of the normalized policy text, used for commit-time mirror validation. */
  digest: string;
  revision: string;
  updatedAt: number | null;
  /**
   * The decision table projected as named controls, or null when `policy` no
   * longer matches the grammar those controls read. Derived from `policy` at
   * the one place it is loaded, so every response carrying a document — read,
   * write, or the conflict body of a rejected write — reports the same view.
   */
  schema: PrivacyPolicySchema | null;
  /** Stable reusable policy identity. Absent only on legacy wire responses. */
  familyId?: string;
  /** Human-readable family name. */
  familyName?: string;
  /** Monotonic version within the family. */
  familyVersion?: number;
}

export const DEFAULT_PRIVACY_POLICY_FAMILY_ID = "00000000-0000-4000-8000-000000000001";

export type PrivacyPolicyVersionAction =
  | "bootstrap"
  | "edit"
  | "revert"
  | "restore"
  | "fork"
  | "template";

export interface PrivacyPolicyVersionSummary {
  generation: number;
  revision: string;
  action: PrivacyPolicyVersionAction;
  revertedFromGeneration: number | null;
  createdAt: number;
  familyId?: string;
  familyVersion?: number;
  originRevision?: string | null;
  originTemplateId?: PrivacyPolicyTemplateId | null;
}

export interface PrivacyPolicyVersion extends PrivacyPolicyVersionSummary {
  policy: string;
  digest: string;
}

export const PRIVACY_POLICY_TEMPLATE_IDS = ["guarded", "balanced", "open", "unfiltered"] as const;

export type PrivacyPolicyTemplateId = (typeof PRIVACY_POLICY_TEMPLATE_IDS)[number];

/**
 * A built-in starting policy the user can adopt and then edit. Templates differ
 * in how much they release automatically and whether deterministically detected
 * credentials are denied or held for explicit one-time approval.
 */
export interface PrivacyPolicyTemplate {
  id: PrivacyPolicyTemplateId;
  name: string;
  /** One line describing the trade-off, including how often it asks for approval. */
  description: string;
  /** True for the template a fresh install starts from. */
  isDefault: boolean;
  policy: string;
}

export interface PrivacyPolicyFamilySummary {
  deletionBlockedReason?: string | null;
  id: string;
  name: string;
  currentRevision: string;
  currentVersion: number;
  updatedAt: number;
  archivedAt: number | null;
  affectedGrantIds: string[];
}

export interface PrivacyPolicyFamily extends PrivacyPolicyFamilySummary {
  current: PrivacyPolicyDocument;
}

export type PrivacyApprovalStatus = "pending" | "approved" | "denied" | "expired";

/** Metadata-only list item. The held answer is available only from the detail route. */
export interface PrivacyApprovalSummary {
  id: string;
  taskId: string;
  workflowId: string;
  conversationId: string;
  workflowName: string;
  externalAgent: PrivacyExternalAgentIdentity;
  status: PrivacyApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

export interface PrivacyApprovalDetail extends PrivacyApprovalSummary {
  workflowPurpose: string;
  question: string;
  /** Null only for approvals created by a gateway predating durable approval snapshots. */
  candidateAnswer: string | null;
  /** When the released answer was recorded as returned to the external caller. */
  sharedAt: number | null;
  review: PrivacyReviewRecord;
}

export interface PrivacyDecisionSummary {
  taskId: string;
  workflowId: string;
  conversationId: string;
  status: AnswerReleaseStatus;
  createdAt: number;
  resolvedAt: number | null;
  releaseId: string | null;
  answer: string | null;
  reductions: string[];
  review: PrivacyReviewRecord;
}

export const PRIVACY_AUDIT_EVENT_KINDS = [
  "external_request",
  "agent_trace",
  "candidate_generated",
  "privacy_review",
  "reduction_generated",
  "approval_requested",
  "approval_resolved",
  "released",
  "denied",
  "failed",
  "truncated",
  "egress",
] as const;

export type PrivacyAuditEventKind = (typeof PRIVACY_AUDIT_EVENT_KINDS)[number];

/**
 * The closed set of audit statuses a client may render. Audit rows persist the
 * status token their producer wrote — a reviewer decision, a task outcome, an
 * approval resolution — so the read path maps that token onto this set and
 * drops anything outside it. Without the mapping a protocol token such as
 * `stop` reaches the screen styled as if it were a meaningful status.
 *
 * A new code here is a wire change every client must learn before the gateway
 * may emit it, since each renders the four exhaustively.
 */
export type PrivacyAuditStatusCode = "allowed" | "reduced" | "held" | "blocked";

export interface PrivacyAuditStatusDisplay {
  code: PrivacyAuditStatusCode;
  /** Human label; the gateway owns the wording so all three clients agree. */
  label: string;
}

export interface PrivacyAuditEventDisplay {
  title: string;
  text: string | null;
  detail: string | null;
  status: PrivacyAuditStatusDisplay | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  approvalId: string | null;
  releaseId: string | null;
  digest: string | null;
  reductions: string[];
}

export type PrivacyAnswerDiffOp = "equal" | "removed" | "added";

/**
 * A run of characters inside one diffed line. `removed` text belongs to the
 * candidate only, `added` text to the released answer only, `equal` text to
 * both. Concatenating a line's spans reproduces that line's `text` exactly, so
 * a client that cannot render spans can render `text` instead.
 */
export interface PrivacyAnswerDiffSpan {
  op: PrivacyAnswerDiffOp;
  text: string;
}

/**
 * One line of the comparison, in reading order: `removed` lines come from the
 * candidate, `added` lines from the released answer, `equal` lines are present
 * in both. Line terminators are not part of `text` and are not compared, so a
 * file whose newlines changed shape still reads as unchanged lines.
 *
 * `spans` is non-null only when the line was matched to a counterpart line on
 * the other side and the two are close enough that a word-level breakdown
 * describes an edit rather than a coincidence. A null `spans` means the line
 * has no counterpart — never that the line is unchanged.
 */
export interface PrivacyAnswerDiffLine {
  op: PrivacyAnswerDiffOp;
  text: string;
  spans: PrivacyAnswerDiffSpan[] | null;
}

/**
 * How a released answer relates to the candidate Omnesis generated for the same
 * task. The gateway computes it from the two full recorded strings — not from
 * the bounded preview a step displays — so all clients show one comparison
 * instead of three implementations of one.
 *
 * - `identical` — the released bytes are the candidate's bytes. The release
 *   step carries no body text of its own, because it would repeat the
 *   candidate step verbatim.
 * - `diff` — the released answer is an edit of the candidate, described line by
 *   line.
 * - `no_diff` — the two texts differ, and no edit-shaped comparison was
 *   produced. Render both texts plainly instead.
 *
 * What a client must not infer from this: nothing here attributes a change to a
 * reduction the reviewer named — the lines describe the two strings, not the
 * reviewer's reasoning, and a reduction the reviewer claimed may appear nowhere
 * in them. `no_diff` is not a finding that the answer was rewritten from
 * scratch, only that Omnesis declined to present the change as an edit.
 */
export type PrivacyAnswerComparison =
  | { kind: "identical" }
  | { kind: "diff"; lines: PrivacyAnswerDiffLine[] }
  | {
      kind: "no_diff";
      /**
       * `dissimilar`: too little of the candidate survives in the released
       * answer for a line-by-line reading to be about editing.
       * `too_large`: the pair exceeded the work a read is allowed to spend.
       */
      reason: "dissimilar" | "too_large";
    };

export interface PrivacyAuditEventSummary {
  id: string;
  taskId: string;
  kind: PrivacyAuditEventKind | "unknown";
  createdAt: number;
  display: PrivacyAuditEventDisplay;
  /**
   * Set on a `released` event whose task also recorded the candidate it was
   * released from, and null on every other event — including a `released` event
   * whose candidate was never recorded or whose recorded text no longer matches
   * its digest. Null means "no comparison was computed", never "nothing
   * changed".
   */
  answerComparison: PrivacyAnswerComparison | null;
  payloadAvailable: boolean;
  payloadDigest: string | null;
  payloadBytes: number;
  originalPayloadBytes: number;
  payloadTruncated: boolean;
}

export interface PrivacyAuditEventDetail extends PrivacyAuditEventSummary {
  /** Trusted, admin-only event payload. Its shape is selected by `kind`. */
  payload: unknown | null;
}

export interface PrivacyConversationSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowPurpose: string;
  externalAgent: PrivacyExternalAgentIdentity;
  title: string;
  createdAt: number;
  updatedAt: number;
  taskCount: number;
  latestStatus: AnswerTaskAuditStatus;
  latestOutcome: PrivacyExchangeOutcome;
  pendingApprovalCount: number;
}

export type AnswerTaskAuditStatus = AnswerReleaseStatus | "running" | "failed" | "canceled";

export interface PrivacyConversationDetail extends PrivacyConversationSummary {
  workflowStatus: "active" | "closed" | "expired";
  workflowExpiresAt: number;
}

export interface PrivacyConversationPage {
  conversations: PrivacyConversationSummary[];
  nextCursor: string | null;
}

export interface PrivacyAuditEventPage {
  events: PrivacyAuditEventSummary[];
  previousCursor: string | null;
}

export const PRIVACY_POLICY_DECISIONS = ["allow", "reduce", "approve", "deny"] as const;

export type PrivacyPolicyDecision = (typeof PRIVACY_POLICY_DECISIONS)[number];

/** An existence signal is indivisible, so it cannot be released with reductions. */
export const PRIVACY_EXISTENCE_DECISIONS = ["allow", "approve", "deny"] as const;
export type PrivacyExistenceDecision = (typeof PRIVACY_EXISTENCE_DECISIONS)[number];

export interface PrivacyPolicyRow {
  /** The information category, verbatim from the policy table. */
  label: string;
  /** Whether truth and approximate timing may leave through a Watch firing. */
  existence: PrivacyExistenceDecision;
  summary: PrivacyPolicyDecision;
  exact: PrivacyPolicyDecision;
}

/**
 * The typed projection of a policy's decision table, so a client can offer
 * named controls instead of asking a person to hand-write markdown. Null
 * wherever a policy has been edited past the grammar the controls read; the
 * client then falls back to editing the text.
 */
export interface PrivacyPolicySchema {
  rows: PrivacyPolicyRow[];
  credentialApprovalEnabled: boolean;
}

export interface PrivacyPolicySchemaEdit {
  /** The row label to change; omit to change only the credential opt-in. */
  row?: string;
  existence?: PrivacyExistenceDecision;
  summary?: PrivacyPolicyDecision;
  exact?: PrivacyPolicyDecision;
  credentialApprovalEnabled?: boolean;
}

/**
 * The Privacy landing feed: every exchange the owner has, newest first, across
 * all conversations. Distinct from `PrivacyExchangePresentationPage`, which is
 * scoped to one conversation and ordered oldest-first so a detail view reads
 * top-down. Grouping the landing view by conversation collapses several
 * exchanges into one row whose title, timestamp and status each describe a
 * different event, so the feed is flat and an exchange is the unit.
 */
export interface PrivacyExchangeFeedPage {
  exchanges: PrivacyExchangePresentation[];
  nextCursor: string | null;
}

export const PRIVACY_EXCHANGE_OUTCOMES = [
  "checking",
  "needs_review",
  "ready",
  "shared",
  "shared_with_reductions",
  "not_shared",
  "failed",
  "canceled",
] as const;

export type PrivacyExchangeOutcome = (typeof PRIVACY_EXCHANGE_OUTCOMES)[number];

export interface PrivacyAnswerAgentTrace {
  /** Original one-based ordinal, including attempts omitted from this view. */
  attempt: number;
  provider: string;
  model: string;
  sessionId: string;
  messages: unknown[];
  terminalStopReason: string | null;
  createdAt: number;
  /** True when projection limits omitted part of this stored attempt. */
  truncated: boolean;
  /** Exact number of omitted observable parts, when the audit marker records it. */
  omittedParts: number | null;
}

/**
 * Why an exchange ended without a released answer, in three layers: a sentence
 * for the operator, the machine code that produced it, and — when a model
 * provider rejected the request — that provider's own disposition metadata
 * (`HTTP 404 · NOT_FOUND · param=model`), which distinguishes a bad model
 * assignment from a rate limit without reading the gateway log.
 *
 * `detail` never carries provider prose, only status and envelope codes.
 */
export interface PrivacyExchangeFailure {
  code: string;
  message: string;
  stage: "answer_generation" | "privacy_check";
  detail?: string;
}

export interface PrivacyExchangePresentation {
  taskId: string;
  conversationId: string;
  workflowId: string;
  externalAgent: PrivacyExternalAgentIdentity;
  workflow: {
    name: string;
    /** Caller-supplied description, not a verified statement of intent. */
    purpose: string;
  };
  question: string;
  status: AnswerTaskAuditStatus;
  outcome: PrivacyExchangeOutcome;
  createdAt: number;
  resolvedAt: number | null;
  /** The recorded external egress time; null until the caller receives the release. */
  sharedAt: number | null;
  /** Exact content durably recorded in answer_releases, and nothing else. */
  sharedAnswer: string | null;
  /** Exact locally generated content recovered from the trusted audit record. */
  draftAnswer: string | null;
  /** Exact held content, present only while the approval is pending. */
  pendingCandidate: string | null;
  reductions: string[];
  approval: {
    id: string;
    status: PrivacyApprovalStatus;
    expiresAt: number;
    resolvedAt: number | null;
  } | null;
  userDecision: "approved" | "approved_but_blocked" | "denied" | "expired" | null;
  /** Why a terminal request was not released; null for non-terminal or released requests. */
  denialReason: DeniedAnswerResponse["reason"] | null;
  review: {
    fallbackCause: PrivacyReviewerFallbackCause | null;
    findings: PrivacyFinding[];
    rationale: string;
    /** The policy family the review ran under; absent when the record carries none. */
    policyFamilyId?: string;
    policyFamilyName?: string;
  } | null;
  /** Safe, durable reason why Omnesis did not complete this exchange. */
  failure: PrivacyExchangeFailure | null;
  /** Local-only, bounded generation transcripts, oldest attempt first. */
  agentTraces: PrivacyAnswerAgentTrace[];
  /** Stored attempts omitted because of projection size/count/shape limits. */
  agentTraceOmittedAttempts: number;
}

export interface PrivacyExchangePresentationPage {
  exchanges: PrivacyExchangePresentation[];
  previousCursor: string | null;
}

export interface PrivacyReviewerHealth {
  status: "ok" | "attention";
  recentOperationalFailureCount: number;
  lastFailureAt: number | null;
}
