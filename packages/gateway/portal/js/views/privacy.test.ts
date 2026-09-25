// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

vi.mock("../lib/markdown.js", () => ({
  renderMarkdown: (value: string) => value,
}));

vi.mock("../lib/router.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  navigate: vi.fn(),
}));

vi.mock("../api.js", () => ({
  approvePrivacyApproval: vi.fn(),
  deletePrivacyConversation: vi.fn(),
  denyPrivacyApproval: vi.fn(),
  getPrivacyApproval: vi.fn(),
  getPrivacyConversation: vi.fn(),
  getPrivacyReviewerHealth: vi.fn(),
  listPrivacyAuditEvents: vi.fn(),
  listPrivacyExchangeFeed: vi.fn(),
  listPrivacyExchanges: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate } from "../lib/router.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacyView } from "./privacy.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  PrivacyExchangeFeed,
  PrivacyFeedRow,
  PrivacyReviewCard,
  pinnedApprovalRecord,
  privacyFeedDays,
} from "./audit/activity.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  PrivacyExchangeSpine,
  PrivacyLedgerStep,
  privacyDayBreaks,
  privacySpineOrder,
} from "./audit/exchange-detail.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  PrivacyPolicyDiff,
  privacyPolicyDocument,
  restorePolicyDraft,
  serializePolicyDraft,
} from "./policies/policy.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  PRIVACY_FEED_FILTERS,
  PrivacyActivityLoadFailure,
  PrivacyAuditStatus,
  PrivacyFeedOutcome,
  PrivacyFindingChips,
  PrivacyHealthBanner,
  PrivacyOutcome,
  auditStatusDisplay,
  exchangeDecisionCopy,
  exchangeDetailPath,
  externalAgentName,
  externalAgentNarrativeName,
  privacyApprovalDocument,
  privacyConversationDocument,
  privacyFailureMessage,
  privacyAnswerGenerationFailed,
  privacyExchangeOutcomeDisplay,
  privacyFeedFilterMatches,
  privacyFeedOutcomeDisplay,
  privacyReviewFailed,
  privacyOutcomeDisplay,
  privacyPauseCopy,
  privacyResolutionCopy,
  reviewedPolicyFamily,
} from "./audit/shared.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  PRIVACY_STATUS_CODES,
  privacyCollection,
  privacyDateTimeAttribute,
  privacyStatusDisplay,
} from "./shared/privacy-vocabulary.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function expandToHostNodes(vnode: any, out: any[] = []): any[] {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const child of vnode) expandToHostNodes(child, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number" || !vnode.type) return out;
  if (typeof vnode.type === "function") return expandToHostNodes(vnode.type(vnode.props ?? {}), out);
  out.push({
    tag: vnode.type,
    class: vnode.props?.class ?? "",
    text: collectText(vnode.props?.children)
      + (vnode.props?.dangerouslySetInnerHTML?.__html ?? ""),
    props: vnode.props ?? {},
  });
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

function collectText(children: any): string {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type) {
    return typeof children.type === "function"
      ? collectText(children.type(children.props ?? {}))
      : collectText(children.props?.children);
  }
  return "";
}

function allText(nodes: any[]): string {
  return nodes.map((node) => node.text).join(" ");
}

const REVIEW = {
  fallbackCause: null,
  rationale: "Exact schedule details require a one-time decision.",
  findings: [
    {
      category: "schedule",
      detailLevel: "exact",
      subject: "user",
      disposition: "approval",
      description: "The answer includes exact schedule information.",
    },
  ],
};

const SHARED_EXCHANGE = {
  taskId: "task-shared-example",
  conversationId: "conversation-example",
  workflowId: "workflow-example",
  externalAgent: { displayName: "Atlas", source: "token" },
  workflow: {
    name: "Calendar coordinator",
    purpose: "Find a suitable meeting time.",
  },
  question: "Which afternoon is free next week?",
  status: "released_with_reductions",
  outcome: "shared_with_reductions",
  createdAt: 1_700_000_000_000,
  resolvedAt: 1_700_000_050_000,
  sharedAt: 1_700_000_060_000,
  sharedAnswer: "Thursday afternoon is free.",
  draftAnswer: "Thursday at 15:00 is free.",
  pendingCandidate: null,
  reductions: ["Removed the exact time."],
  approval: null,
  userDecision: null,
  review: { ...REVIEW },
  failure: null,
};

const PENDING_EXCHANGE = {
  ...SHARED_EXCHANGE,
  taskId: "task-pending-example",
  status: "approval_required",
  outcome: "needs_review",
  sharedAt: null,
  resolvedAt: null,
  sharedAnswer: null,
  pendingCandidate: "Thursday at 15:00 is free.",
  reductions: [],
  approval: {
    id: "approval-example",
    status: "pending",
    expiresAt: 1_700_003_600_000,
    resolvedAt: null,
  },
};

const APPROVAL = {
  id: "approval-example",
  taskId: PENDING_EXCHANGE.taskId,
  workflowId: "workflow-example",
  conversationId: "conversation-example",
  workflowName: "Calendar coordinator",
  workflowPurpose: "Find a suitable meeting time.",
  question: PENDING_EXCHANGE.question,
  candidateAnswer: "Thursday at 15:00 is free.",
  status: "pending",
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_003_600_000,
  resolvedAt: null,
  sharedAt: null,
  review: { ...REVIEW },
  externalAgent: { displayName: "Atlas", source: "token" },
};

const AUDIT_EVENTS = [
  {
    id: "event-request",
    taskId: SHARED_EXCHANGE.taskId,
    kind: "external_request",
    createdAt: 1_700_000_000_000,
    display: {
      title: "External request",
      text: SHARED_EXCHANGE.question,
      detail: null,
      status: null,
      provider: null,
      model: null,
      confidence: null,
      approvalId: null,
      releaseId: null,
      digest: null,
      reductions: [],
    },
    payloadAvailable: true,
    payloadDigest: "a".repeat(64),
    payloadBytes: 140,
    originalPayloadBytes: 140,
    payloadTruncated: false,
  },
  {
    id: "event-trace",
    taskId: SHARED_EXCHANGE.taskId,
    kind: "agent_trace",
    createdAt: 1_700_000_020_000,
    display: {
      title: "Agent activity",
      text: null,
      detail: "Searched the calendar index for open afternoons.",
      status: null,
      provider: null,
      model: null,
      confidence: null,
      approvalId: null,
      releaseId: null,
      digest: null,
      reductions: [],
    },
    payloadAvailable: false,
    payloadDigest: null,
    payloadBytes: 0,
    originalPayloadBytes: 0,
    payloadTruncated: false,
  },
  {
    id: "event-candidate",
    taskId: SHARED_EXCHANGE.taskId,
    kind: "candidate_generated",
    createdAt: 1_700_000_030_000,
    display: {
      title: "Candidate inside Omnesis",
      text: "Thursday at 15:00 is free.",
      detail: null,
      status: null,
      provider: "local",
      model: "drafting-model",
      confidence: null,
      approvalId: null,
      releaseId: null,
      digest: null,
      reductions: [],
    },
    payloadAvailable: true,
    payloadDigest: "b".repeat(64),
    payloadBytes: 90,
    originalPayloadBytes: 90,
    payloadTruncated: false,
  },
  {
    id: "event-review",
    taskId: SHARED_EXCHANGE.taskId,
    kind: "privacy_review",
    createdAt: 1_700_000_040_000,
    display: {
      title: "Privacy review",
      text: "The policy allowed this answer.",
      detail: "Exact schedule detail was generalized.",
      status: { code: "reduced", label: "Details removed" },
      provider: "local",
      model: "review-model",
      confidence: 0.82,
      approvalId: null,
      releaseId: null,
      digest: "c".repeat(64),
      reductions: ["Removed the exact time."],
    },
    payloadAvailable: true,
    payloadDigest: "d".repeat(64),
    payloadBytes: 220,
    originalPayloadBytes: 220,
    payloadTruncated: false,
  },
];

describe("privacy wire normalization", () => {
  test("accepts direct and enveloped policy, list, and approval responses", () => {
    const policy = { policy: "# Policy\n", revision: "revision", updatedAt: null };
    expect(privacyPolicyDocument(policy)).toBe(policy);
    expect(privacyPolicyDocument({ policy })).toBe(policy);
    expect(privacyCollection([SHARED_EXCHANGE], "exchanges")).toEqual([SHARED_EXCHANGE]);
    expect(privacyCollection({ exchanges: [SHARED_EXCHANGE] }, "exchanges"))
      .toEqual([SHARED_EXCHANGE]);
    expect(privacyCollection({ items: [SHARED_EXCHANGE] }, "exchanges")).toBeNull();
    expect(privacyApprovalDocument(APPROVAL)).toBe(APPROVAL);
    expect(privacyApprovalDocument({ approval: APPROVAL })).toBe(APPROVAL);
    const conversation = { id: "conversation-example", workflowName: "Calendar coordinator" };
    expect(privacyConversationDocument(conversation)).toBe(conversation);
    expect(privacyConversationDocument({ conversation })).toBe(conversation);
  });

  test("reads only a non-empty safe failure message from presentation fields", () => {
    expect(privacyFailureMessage({ failureMessage: "  Safe explanation.  " }))
      .toBe("Safe explanation.");
    expect(privacyFailureMessage({ failure: { message: "Object form." } })).toBe("Object form.");
    expect(privacyFailureMessage({ display: { failureMessage: "Audit explanation." } }))
      .toBe("Audit explanation.");
    expect(privacyFailureMessage({ failureMessage: "  ", failure: { message: 42 } })).toBeNull();
  });

  test("assigns a failed exchange to exactly the stage that failed", () => {
    const generation = { outcome: "failed", draftAnswer: null, pendingCandidate: null };
    const review = { outcome: "failed", draftAnswer: "Invented draft." };
    expect(privacyAnswerGenerationFailed(generation)).toBe(true);
    expect(privacyReviewFailed(generation)).toBe(false);
    expect(privacyAnswerGenerationFailed(review)).toBe(false);
    expect(privacyReviewFailed(review)).toBe(true);
    const legacyReview = {
      outcome: "failed",
      draftAnswer: null,
      review: { fallbackCause: "request_failed" },
    };
    expect(privacyAnswerGenerationFailed(legacyReview)).toBe(false);
    expect(privacyReviewFailed(legacyReview)).toBe(true);
    expect(privacyReviewFailed({ outcome: "needs_review", review: { fallbackCause: "request_failed" } }))
      .toBe(true);
    expect(privacyExchangeOutcomeDisplay(generation).label).toBe("Nothing shared; answer failed");
    expect(privacyExchangeOutcomeDisplay(review).label)
      .toBe("Nothing shared; privacy check failed");
  });
});

/** Every label the closed outcome set can put on screen. */
const OUTCOME_LABELS_ON_SCREEN = {
  checking: "Checking",
  needs_review: "Needs your review",
  ready: "Approved, waiting for agent",
  shared: "Shared with the agent",
  shared_with_reductions: "Shared with details removed",
  not_shared: "Not shared",
  failed: "Nothing shared; check failed",
  canceled: "Canceled",
};

describe("privacy status vocabulary", () => {
  test("a shared outcome says who received it, and wears the Privacy palette", () => {
    const display = privacyOutcomeDisplay("shared");
    expect(display.label).toBe("Shared with the agent");
    expect(display.tone).toBe("released");

    const nodes = expandToHostNodes(PrivacyOutcome({ outcome: "shared" }));
    const chip = nodes.find((node) => String(node.class).includes("privacy-chip"));
    expect(chip?.text.trim()).toBe("Shared with the agent");
    // Privacy owns its outcome tokens; a chip styled by the portal's generic
    // "success" class would drift the moment that class is retuned for a
    // surface with nothing to do with what left the machine.
    expect(chip?.class).toBe("privacy-chip privacy-chip--released");
    expect(chip?.class).not.toMatch(/success/);
  });

  test("an exchange outcome names its resolved principal", () => {
    const nodes = expandToHostNodes(PrivacyOutcome({
      exchange: {
        outcome: "shared",
        externalAgent: { displayName: "Mosaic assistant", source: "principal" },
      },
    }));
    const chip = nodes.find((node) => String(node.class).includes("privacy-chip"));
    expect(chip?.text.trim()).toBe("Shared with Mosaic assistant");
  });

  test("every lifecycle status this build labels also has a tone", () => {
    // Without this, a status added to the label map inherits the fallback and
    // is coloured by omission rather than by decision.
    for (const status of PRIVACY_STATUS_CODES) {
      expect(privacyStatusDisplay(status)).toBeTruthy();
    }
    expect(PRIVACY_STATUS_CODES.length).toBeGreaterThan(10);
  });

  test("a released status is not green, because release is not delivery", () => {
    // The privacy check clearing an answer and the caller collecting it are two
    // facts, and this status carries only the first. Green would assert the
    // second on the one screen whose job is reporting what left the machine.
    expect(privacyStatusDisplay("released")).toEqual({
      label: "Approved for release",
      tone: "waiting",
    });
    expect(privacyStatusDisplay("released_with_reductions")?.tone).toBe("waiting");
    expect(privacyStatusDisplay("delivered")?.tone).toBe("released");
    // An approval granted is its own event, and that one did happen.
    expect(privacyStatusDisplay("approved")?.tone).toBe("released");
  });

  test("a status this build has never heard of renders nothing at all", () => {
    expect(privacyStatusDisplay("teleported")).toBeNull();
  });

  test("an outcome where nothing left takes a withheld tone, not a released one", () => {
    expect(privacyOutcomeDisplay("not_shared"))
      .toEqual({ tone: "kept", label: "Not shared", known: true });
    expect(privacyOutcomeDisplay("canceled").tone).toBe("kept");
    expect(privacyOutcomeDisplay("needs_review").tone).toBe("review");
    // A reduced release still left, so it stays on the released side.
    expect(privacyOutcomeDisplay("shared_with_reductions").tone).toBe("reduced");
    expect(privacyOutcomeDisplay("shared_with_reductions").label)
      .toBe("Shared with details removed");
  });

  // A gateway newer than this portal can name an outcome the closed set above
  // does not carry. Reporting it as any known state would be a claim about what
  // left the machine; it is reported as unread instead.
  test("an outcome outside the closed set is neither shown raw nor read as a known state", () => {
    const display = privacyOutcomeDisplay("teleported");
    expect(display.known).toBe(false);
    expect(display.label).toBe("Outcome not recognised");
    expect(display.tone).toBe("unknown");

    const nodes = expandToHostNodes(PrivacyOutcome({ outcome: "teleported" }));
    const chip = nodes.find((node) => String(node.class).includes("privacy-chip"));
    expect(chip?.class).toBe("privacy-chip privacy-chip--unknown");
    expect(allText(nodes)).not.toContain("teleported");
    // Never borrows the copy of a state it might not be.
    for (const borrowed of Object.values(OUTCOME_LABELS_ON_SCREEN)) {
      expect(display.label).not.toBe(borrowed);
    }
  });

  test("an unreadable outcome never claims that nothing was shared", () => {
    const copy = exchangeDecisionCopy({ outcome: "teleported" });
    expect(copy).not.toContain("Nothing was shared");
    expect(copy).not.toContain("Nothing has been shared");
    expect(copy).toContain("cannot read");
    // The outcome that genuinely means nothing left still says so plainly.
    expect(exchangeDecisionCopy({ outcome: "not_shared" })).toBe("Nothing was shared.");
  });

  test("an audit status renders only from the gateway's closed code set", () => {
    expect(auditStatusDisplay({ code: "allowed", label: "Released" }))
      .toEqual({ tone: "released", label: "Released" });
    // A model's raw terminal stop reason, and the pre-mapping string form.
    expect(auditStatusDisplay({ code: "stop", label: "stop" })).toBeNull();
    expect(auditStatusDisplay("stop")).toBeNull();
    expect(auditStatusDisplay({ code: "allowed", label: "   " })).toBeNull();
    expect(auditStatusDisplay(null)).toBeNull();

    expect(PrivacyAuditStatus({ status: { code: "stop", label: "stop" } })).toBeNull();
    const rendered = expandToHostNodes(
      PrivacyLedgerStep({
        event: {
          ...AUDIT_EVENTS[1],
          display: { ...AUDIT_EVENTS[1].display, status: { code: "stop", label: "stop" } },
        },
      }),
    );
    expect(allText(rendered)).not.toContain("stop");
    expect(rendered.some((node) => String(node.class).includes("privacy-chip"))).toBe(false);
  });

  test("reviewer health warns without exposing model diagnostics", () => {
    const text = allText(expandToHostNodes(PrivacyHealthBanner({
      health: { status: "attention", recentOperationalFailureCount: 3, lastFailureAt: 123 },
    }))).replace(/\s+/g, " ");
    expect(text).toContain(
      "Some recent automatic privacy checks could not complete. Any affected answer stays inside Omnesis and requires your review.",
    );
    expect(text).not.toMatch(/provider|model|invalid_output|request_failed/i);
    expect(PrivacyHealthBanner({ health: { status: "ok" } })).toBeNull();
  });

  test("keys id-scoped controllers so route changes cannot reuse sensitive state", () => {
    expect(PrivacyView({ conversationId: "conversation-a" }).key).toBe("conversation-a:all");
    expect(PrivacyView({ conversationId: "conversation-a", taskId: "task-a" }).key)
      .toBe("conversation-a:task-a");
    expect(PrivacyView({ approvalId: "approval-a" }).key).toBe("approval-a");
  });

  test("an initial activity-page failure remains retryable", () => {
    const retry = vi.fn();
    const nodes = expandToHostNodes(PrivacyActivityLoadFailure({
      error: new Error("Activity is unavailable."),
      onRetry: retry,
    }));
    expect(nodes.find((node) => node.props.role === "alert")?.text)
      .toContain("Activity is unavailable.");
    const button = nodes.find((node) => node.tag === "button");
    expect(button?.text.trim()).toBe("Retry");
    button?.props.onClick();
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("what a finding chip is allowed to say", () => {
  function findingLabels(findings: any[]): string[] {
    return expandToHostNodes(PrivacyFindingChips({ findings }))
      .filter((node: any) => node.tag === "span")
      .map((node: any) => node.text.trim());
  }

  // The subject is a closed wire enum. Both values that mean "not the operator"
  // are named by that fact alone; which of the two would only narrow down who.
  test("every subject that means someone other than you reads the same", () => {
    for (const subject of ["other_person", "multiple_people"]) {
      const labels = findingLabels([{ subject, category: "health", detailLevel: "exact" }]);
      expect(labels).toEqual(["Another person"]);
      // Neither the wire token nor the category reaches the screen.
      expect(labels.join(" ")).not.toContain(subject);
      expect(labels.join(" ")).not.toContain("health");
    }
  });

  test("a category is presented as written, with underscores read as spaces", () => {
    const [written, blank, hyphenated] = findingLabels([
      { subject: "user", category: "private_communication", detailLevel: "summary" },
      { subject: "user", category: "  ", detailLevel: "summary" },
      { subject: "unknown", category: "e-mail", detailLevel: "summary" },
    ]);
    // Each word is capitalised, and `_` is the only word separator honoured.
    expect(written.split(" ")).toEqual(["Private", "Communication"]);
    // A blank category still names something rather than rendering an empty chip.
    expect(blank.split(" ")).toEqual(["Sensitive", "Information"]);
    // A hyphen is not a word boundary: this is one word, not two.
    expect(hyphenated).toBe("E-mail");
  });

  test("an exact finding says so, and never doubles the prefix", () => {
    const [schedule, alreadyExact] = findingLabels([
      { subject: "user", category: "schedule", detailLevel: "exact" },
      { subject: "user", category: "Exact location", detailLevel: "exact" },
    ]);
    expect(schedule).toBe("Exact schedule");
    expect(alreadyExact.split(" ")).toEqual(["Exact", "Location"]);
  });
});

describe("the caller's name in the narrative", () => {
  const SLUGGED = {
    ...SHARED_EXCHANGE,
    externalAgent: { displayName: "Atlas (openclaw)", source: "token" },
  };

  test("a trailing registry slug is implementation detail, not part of the story", () => {
    expect(externalAgentName(SLUGGED)).toBe("Atlas (openclaw)");
    expect(externalAgentNarrativeName(SLUGGED)).toBe("Atlas");
    // Only a bare lowercase token reads as a slug; a real parenthetical stays.
    expect(externalAgentNarrativeName({ displayName: "Acme (support desk)" }))
      .toBe("Acme (support desk)");
    // A name that is nothing but a slug still has to say something.
    expect(externalAgentNarrativeName({ displayName: "(openclaw)" })).toBe("(openclaw)");
  });

  test("prefers the narrative name produced by the gateway", () => {
    expect(externalAgentNarrativeName({
      displayName: "Mosaic assistant (custom label)",
      narrativeName: "Mosaic assistant",
    })).toBe("Mosaic assistant");
  });

  test("no surface that tells the story prints the slug", () => {
    const surfaces = [
      allText(expandToHostNodes(PrivacyFeedRow({ exchange: SLUGGED }))),
      allText(expandToHostNodes(PrivacyReviewCard({
        approval: { ...APPROVAL, externalAgent: SLUGGED.externalAgent },
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }))),
    ];
    for (const text of surfaces) {
      expect(text).toContain("Atlas asked");
      expect(text).not.toContain("openclaw");
    }
  });

  /**
   * The exchange's own page is the one place both names belong. The story says
   * "Atlas asked"; the block of the caller's own claims about itself answers
   * "Atlas which?" with the registered name, slug and all.
   */
  test("the exchange states the caller's registered name among its claims", () => {
    const nodes = expandToHostNodes(
      PrivacyExchangeSpine({ exchange: SLUGGED, events: AUDIT_EVENTS }),
    );
    expect(allText(nodes)).toContain("Atlas asked");

    const facts = nodes.find((node) => node.class === "privacy-card-facts");
    expect(facts?.text).toContain("Atlas (openclaw)");
    // And nowhere else: the prose around it keeps the narrative name.
    const prose = nodes
      .filter((node) => node.class !== "privacy-card-facts")
      .map((node) => (node.class === "privacy-card-facts" ? "" : node.text))
      .join(" ");
    expect(prose.replace(/Atlas \(openclaw\)/g, "")).not.toContain("openclaw");
  });
});

describe("the activity feed", () => {
  test("one row is one exchange, identified by the question that was asked", () => {
    const nodes = expandToHostNodes(PrivacyFeedRow({ exchange: SHARED_EXCHANGE }));
    const text = allText(nodes);
    expect(text).toContain("Atlas asked");
    expect(text).toContain(SHARED_EXCHANGE.question);
    // The row opens with the caller's name, so the outcome does not repeat it.
    expect(text).toContain("Shared, details removed");
    expect(text).not.toContain("Shared with Atlas");
    // The row is a summary: the answer itself belongs to the detail.
    expect(text).not.toContain(SHARED_EXCHANGE.sharedAnswer);
    expect(text).not.toContain(SHARED_EXCHANGE.taskId);

    const row = nodes.find((node) => node.class === "privacy-feed-row");
    expect(row?.props.href).toBe(
      exchangeDetailPath(SHARED_EXCHANGE.conversationId, SHARED_EXCHANGE.taskId),
    );
    expect(row?.props.href).toBe(
      "/portal/audit/conversations/conversation-example/exchanges/task-shared-example",
    );
  });

  test("a device that asked is drawn with its device kind's icon, everywhere it is named", () => {
    const deviceAsked = {
      ...SHARED_EXCHANGE,
      externalAgent: { displayName: "Studio voice", source: "token", deviceKind: "cli" },
    };
    const classes = (nodes: { class?: unknown }[]) => nodes.map((node) => String(node.class ?? ""));
    expect(classes(expandToHostNodes(PrivacyFeedRow({ exchange: deviceAsked })))).toContain(
      "privacy-feed-device",
    );
    expect(
      classes(
        expandToHostNodes(
          PrivacyReviewCard({
            approval: { ...APPROVAL, externalAgent: deviceAsked.externalAgent },
            onApprove: vi.fn(),
            onDeny: vi.fn(),
          }),
        ),
      ),
    ).toContain("privacy-glyph privacy-glyph--device");
    // A caller no device accounts for keeps the generic mark.
    expect(classes(expandToHostNodes(PrivacyFeedRow({ exchange: SHARED_EXCHANGE })))).not.toContain(
      "privacy-feed-device",
    );
  });

  test("every exchange is one row in one flat run, whatever workflow it came from", () => {
    const other = {
      ...SHARED_EXCHANGE,
      taskId: "task-other",
      workflowId: "workflow-other",
      workflow: { name: "Trip planner", purpose: "Plan a trip." },
      question: "Where am I staying in March?",
    };
    const second = { ...SHARED_EXCHANGE, taskId: "task-second", question: "What about the following week?" };

    const nodes = expandToHostNodes(
      PrivacyExchangeFeed({ exchanges: [SHARED_EXCHANGE, second, other] }),
    );
    expect(nodes.filter((node) => node.class === "privacy-feed-row")).toHaveLength(3);
    const text = allText(nodes);
    expect(text).toContain("What about the following week?");
    expect(text).toContain("Where am I staying in March?");
    // No heading interrupts the chronology where the workflow changes.
    expect(nodes.filter((node) => node.class === "privacy-feed-group-label")).toHaveLength(0);
    // And no glyph opens the row: the question is the row's identity.
    expect(nodes.filter((node) => node.class === "privacy-feed-avatar")).toHaveLength(0);
  });

  test("an empty feed says nothing has left rather than showing a broken list", () => {
    const text = allText(expandToHostNodes(PrivacyExchangeFeed({ exchanges: [] })));
    expect(text).toContain("Nothing has left this machine");
  });

  // `new Date(x).toISOString()` throws on a non-finite instant, and an
  // exception raised while rendering one row unmounts the whole portal through
  // the root error boundary. A row with no usable time must cost that row its
  // timestamp, never the page.
  test("a row whose timestamps are all missing renders without a machine time", () => {
    const undated = {
      ...SHARED_EXCHANGE,
      sharedAt: undefined,
      resolvedAt: undefined,
      createdAt: undefined,
    };
    const nodes = expandToHostNodes(PrivacyFeedRow({ exchange: undated }));
    const time = nodes.find((node) => node.tag === "time");
    expect(time?.props.datetime).toBeNull();
    expect(time?.text).toContain("Unknown");
    expect(allText(nodes)).toContain(SHARED_EXCHANGE.question);
  });

  test("a row with no usable instant keeps its own day heading rather than a guess", () => {
    const undated = {
      ...SHARED_EXCHANGE,
      taskId: "task-undated",
      sharedAt: undefined,
      resolvedAt: undefined,
      createdAt: undefined,
    };
    const days = privacyFeedDays([SHARED_EXCHANGE, undated]);
    expect(days).toHaveLength(2);
    expect(days[1].heading).toBe("Date unknown");
    expect(days[1].exchanges.map((exchange: { taskId: string }) => exchange.taskId))
      .toEqual(["task-undated"]);
  });

  test("consecutive rows from one day sit under one heading", () => {
    const sameDay = { ...SHARED_EXCHANGE, taskId: "task-same-day", sharedAt: SHARED_EXCHANGE.sharedAt + 3_600_000 };
    const otherDay = { ...SHARED_EXCHANGE, taskId: "task-other-day", sharedAt: SHARED_EXCHANGE.sharedAt - 86_400_000 };
    const days = privacyFeedDays([SHARED_EXCHANGE, sameDay, otherDay]);
    expect(days.map((day: { exchanges: unknown[] }) => day.exchanges.length)).toEqual([2, 1]);
    expect(new Set(days.map((day: { key: string }) => day.key)).size).toBe(2);
  });

  test("a settled outcome is a mark on the row; one that is not settled keeps the chip", () => {
    const settled = expandToHostNodes(PrivacyFeedOutcome({ exchange: SHARED_EXCHANGE }));
    expect(settled.some((node) => String(node.class).includes("privacy-status--reduced"))).toBe(true);
    expect(settled.some((node) => String(node.class).includes("privacy-chip"))).toBe(false);

    const failed = expandToHostNodes(
      PrivacyFeedOutcome({ exchange: { ...SHARED_EXCHANGE, outcome: "failed", sharedAt: null } }),
    );
    expect(failed.some((node) => String(node.class).includes("privacy-chip--failed"))).toBe(true);
  });

  test("the short outcome never drops a word an unrecognised outcome needs", () => {
    expect(privacyFeedOutcomeDisplay({ ...SHARED_EXCHANGE, outcome: "shared" }).label).toBe("Shared");
    const unknown = privacyFeedOutcomeDisplay({ ...SHARED_EXCHANGE, outcome: "invented_by_a_newer_gateway" });
    expect(unknown.label).toBe("Outcome not recognised");
    expect(unknown.known).toBe(false);
  });

  test("every outcome the feed can render belongs to exactly one filter", () => {
    const outcomes = [
      "checking",
      "needs_review",
      "ready",
      "shared",
      "shared_with_reductions",
      "not_shared",
      "failed",
      "canceled",
    ];
    const narrowing = PRIVACY_FEED_FILTERS.filter((option: { value: string }) => option.value !== "all");
    for (const outcome of outcomes) {
      const matched = narrowing.filter((option: { value: string }) =>
        privacyFeedFilterMatches(option.value, { outcome }),
      );
      expect([outcome, matched.length]).toEqual([outcome, 1]);
      expect(privacyFeedFilterMatches("all", { outcome })).toBe(true);
    }
  });

  test("an outcome this build cannot classify is shown under every filter, never hidden", () => {
    for (const option of PRIVACY_FEED_FILTERS) {
      expect(privacyFeedFilterMatches(option.value, { outcome: "invented_by_a_newer_gateway" })).toBe(true);
    }
  });

  test("the filtered feed says the list is narrowed rather than claiming nothing was shared", () => {
    const text = allText(expandToHostNodes(PrivacyExchangeFeed({ exchanges: [], filter: "failed" })));
    expect(text).toContain("No matching activity");
    expect(text).not.toContain("Nothing has left this machine");
  });

  test("a null timestamp does not become 1970 in the datetime attribute", () => {
    expect(privacyDateTimeAttribute(null)).toBeNull();
    expect(privacyDateTimeAttribute(undefined)).toBeNull();
    expect(privacyDateTimeAttribute(Number.NaN)).toBeNull();
    expect(privacyDateTimeAttribute("1700000000000")).toBeNull();
    expect(privacyDateTimeAttribute(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  test("a ledger step keeps its narrative and leaves the instant to the gutter", () => {
    const nodes = expandToHostNodes(PrivacyLedgerStep({ event: AUDIT_EVENTS[0] }));
    expect(nodes.find((node) => node.tag === "time")).toBeUndefined();
    expect(allText(nodes)).toContain("External request");
  });

  test("a moment with an unusable time renders without a machine time", () => {
    // `new Date(x).toISOString()` throws on a non-finite instant, and an
    // exception raised while rendering one moment unmounts the whole portal
    // through the root error boundary.
    const undated = {
      ...SHARED_EXCHANGE,
      createdAt: undefined,
      resolvedAt: undefined,
      sharedAt: undefined,
    };
    const nodes = expandToHostNodes(
      PrivacyExchangeSpine({ exchange: undated, events: [] }),
    );
    for (const node of nodes.filter((entry) => entry.tag === "time")) {
      expect(node.props.datetime ?? null).toBeNull();
    }
    expect(allText(nodes)).toContain(SHARED_EXCHANGE.question);
  });

  test("the day is printed on the first moment of each day and nowhere else", () => {
    expect([
      ...privacyDayBreaks([
        { key: "a", at: 1_700_000_000_000 },
        { key: "b", at: 1_700_000_010_000 },
        { key: "c", at: 1_700_200_000_000 },
        { key: "d", at: null },
      ]),
    ]).toEqual(["a", "c"]);
  });
});

describe("the pinned review card", () => {
  const handlers = { onApprove: vi.fn(), onDeny: vi.fn() };

  test("shows the exact held answer and both decisions inline", () => {
    const nodes = expandToHostNodes(PrivacyReviewCard({ approval: APPROVAL, ...handlers }));
    expect(nodes.find((node) => String(node.class).includes("privacy-held-answer"))?.text)
      .toBe(APPROVAL.candidateAnswer);
    const buttons = nodes.filter((node) => node.tag === "button").map((node) => node.text.trim());
    expect(buttons).toEqual(["Share once", "Don’t share"]);

    const text = allText(nodes);
    expect(text).toContain("Atlas asked");
    expect(text).toContain(APPROVAL.question);
    expect(text).toContain("Your privacy policy asks you to decide");
    expect(text).toContain(REVIEW.rationale);
    expect(text).not.toContain("Only you can decide this");
    // No navigation is required to decide.
    expect(nodes.some((node) => node.tag === "a")).toBe(false);
  });

  test("approval progress does not claim the answer is already leaving Omnesis", () => {
    const nodes = expandToHostNodes(
      PrivacyReviewCard({ approval: APPROVAL, busy: "approve", ...handlers }),
    );
    const buttons = nodes.filter((node) => node.tag === "button").map((node) => node.text.trim());
    expect(buttons).toEqual(["Approving…", "Don’t share"]);
    expect(buttons.join(" ")).not.toContain("Sharing");
  });

  test("a missing held answer cannot be shared, but can still be refused", () => {
    const nodes = expandToHostNodes(
      PrivacyReviewCard({ approval: { ...APPROVAL, candidateAnswer: null }, ...handlers }),
    );
    const share = nodes.find((node) => node.tag === "button" && node.text.trim() === "Share once");
    const deny = nodes.find((node) => node.tag === "button" && node.text.trim() === "Don’t share");
    expect(share?.props.disabled).toBe(true);
    expect(deny?.props.disabled).toBeFalsy();
    expect(allText(nodes)).toContain("The exact answer is unavailable.");
  });

  test("the activity row carries everything the decision needs", () => {
    const record = pinnedApprovalRecord(PENDING_EXCHANGE);
    expect(record.id).toBe("approval-example");
    expect(record.candidateAnswer).toBe(PENDING_EXCHANGE.pendingCandidate);
    expect(record.question).toBe(PENDING_EXCHANGE.question);
    expect(record.review).toBe(PENDING_EXCHANGE.review);
  });

  test("invalid reviewer output gets calm copy without implementation details", () => {
    const copy = privacyPauseCopy({ fallbackCause: "invalid_output" });
    expect(copy.title).toBe("Automatic privacy check unavailable");
    expect(`${copy.title} ${copy.message}`).not.toMatch(/invalid response|schema|json/i);

    const diagnostic = "Reviewer JSON failed schema validation at findings[0].";
    const text = allText(expandToHostNodes(PrivacyReviewCard({
      approval: {
        ...APPROVAL,
        review: {
          ...REVIEW,
          fallbackCause: "invalid_output",
          rationale: diagnostic,
          findings: [{ ...REVIEW.findings[0], description: diagnostic }],
        },
      },
      ...handlers,
    })));
    expect(text).not.toContain(diagnostic);
  });

  test("resolution copy follows the gateway outcome rather than the clicked action", () => {
    expect(privacyResolutionCopy({ status: "released" })).toEqual({
      title: "Answer approved",
      message: "The answer is ready for the external agent when it returns.",
    });
    expect(privacyResolutionCopy({ status: "released" }, SHARED_EXCHANGE).message)
      .toBe("The answer is ready for Atlas when it returns.");
    expect(privacyResolutionCopy({ status: "denied", reason: "hard_stop" })).toEqual({
      title: "Answer blocked",
      message: "You approved this answer once, but Omnesis blocked it before anything was shared.",
    });
    expect(privacyResolutionCopy({ status: "denied", reason: "expired" }).title)
      .toBe("Approval expired");
  });
});

describe("the policy a review ran under", () => {
  const FAMILY_REVIEW = {
    ...REVIEW,
    policyFamilyId: "family/one",
    policyFamilyName: "Fictional research policy",
  };
  const POLICY_HREF = "/portal/settings/policies/family%2Fone";
  const handlers = { onApprove: vi.fn(), onDeny: vi.fn() };

  test("a feed row names the policy in text, because the row is itself the link", () => {
    const nodes = expandToHostNodes(
      PrivacyFeedRow({ exchange: { ...SHARED_EXCHANGE, review: FAMILY_REVIEW } }),
    );
    const line = nodes.find((node) => node.class === "privacy-reviewed-under");
    expect(line?.text.replace(/\s+/g, " ").trim()).toBe("Reviewed under Fictional research policy");
    // One anchor: the row. A link nested inside it would be invalid markup.
    expect(nodes.filter((node) => node.tag === "a")).toHaveLength(1);
  });

  test("the review card and the decision card link the name to the policy's page", () => {
    const card = expandToHostNodes(
      PrivacyReviewCard({ approval: { ...APPROVAL, review: FAMILY_REVIEW }, ...handlers }),
    );
    const cardLink = card.find((node) => node.tag === "a");
    expect(cardLink?.props.href).toBe(POLICY_HREF);
    expect(cardLink?.text).toBe("Fictional research policy");

    const spine = expandToHostNodes(PrivacyExchangeSpine({
      exchange: {
        ...SHARED_EXCHANGE,
        status: "released",
        outcome: "shared",
        reductions: [],
        review: FAMILY_REVIEW,
      },
      events: AUDIT_EVENTS,
    }));
    const sentence = spine.find((node) => node.class === "privacy-decision-sentence");
    // The sentence the check already spoke stays; the policy is named beside it.
    expect(sentence?.text).toContain("Your policy allowed this answer, and Atlas received it.");
    expect(sentence?.text).toContain("Reviewed under");
    const spineLink = spine.find((node) => node.tag === "a" && node.props.href === POLICY_HREF);
    expect(spineLink?.text).toBe("Fictional research policy");
  });

  test("the link stays inside the portal's own router", () => {
    const card = expandToHostNodes(
      PrivacyReviewCard({ approval: { ...APPROVAL, review: FAMILY_REVIEW }, ...handlers }),
    );
    const link = card.find((node) => node.tag === "a");
    const preventDefault = vi.fn();
    link?.props.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(POLICY_HREF);
  });

  test("a record that names no family renders exactly as before", () => {
    for (const nodes of [
      expandToHostNodes(PrivacyFeedRow({ exchange: SHARED_EXCHANGE })),
      expandToHostNodes(PrivacyReviewCard({ approval: APPROVAL, ...handlers })),
      expandToHostNodes(PrivacyExchangeSpine({ exchange: SHARED_EXCHANGE, events: AUDIT_EVENTS })),
    ]) {
      expect(allText(nodes)).not.toContain("Reviewed under");
      expect(nodes.some((node) => String(node.class).includes("privacy-reviewed-under")))
        .toBe(false);
    }
    // Half a family — an id with no name, or a name with no id — is not one
    // this page can name or link, so it is read as none.
    expect(reviewedPolicyFamily({ policyFamilyId: "family/one" })).toBeNull();
    expect(reviewedPolicyFamily({ policyFamilyName: "Orphaned" })).toBeNull();
    expect(reviewedPolicyFamily(null)).toBeNull();
  });
});

describe("the exchange spine", () => {
  function spine(overrides: Record<string, unknown> = {}, events = AUDIT_EVENTS) {
    return expandToHostNodes(
      PrivacyExchangeSpine({ exchange: { ...SHARED_EXCHANGE, ...overrides }, events }),
    );
  }

  test("every card names its actor in text, so the design survives monochrome", () => {
    const labels = spine()
      .filter((node) => node.class === "privacy-actor-label")
      .map((node) => node.text);
    expect(labels).toEqual(["Atlas asked", "Omnesis drafted an answer", "Privacy check"]);
  });

  test("marks only the failed stage red and puts the safe reason on that card", () => {
    const nodes = spine({
      outcome: "failed",
      status: "failed",
      draftAnswer: null,
      pendingCandidate: null,
      sharedAnswer: null,
      failure: {
        code: "http_request_timeout",
        message: "The model request timed out.",
        stage: "answer_generation",
      },
    }, []);
    const cards = nodes.filter((node) => String(node.class).includes("privacy-card--inside"));
    expect(cards[0]?.class).toContain("privacy-card--error");
    expect(cards[1]?.class).not.toContain("privacy-card--error");
    expect(cards[0]?.text).toContain("Omnesis could not draft an answer");
    expect(cards[0]?.text).toContain("The model request timed out.");
    expect(cards[1]?.text).toContain("The privacy check did not run");
  });

  test("an authoritative privacy-check stage owns the failure even without a draft", () => {
    const nodes = spine({
      outcome: "failed",
      status: "failed",
      draftAnswer: null,
      pendingCandidate: null,
      sharedAnswer: null,
      failure: {
        code: "review_request_failed",
        message: "The privacy check could not finish.",
        stage: "privacy_check",
      },
    }, []);
    const cards = nodes.filter((node) => String(node.class).includes("privacy-card--inside"));
    expect(cards[0]?.class).not.toContain("privacy-card--error");
    expect(cards[1]?.class).toContain("privacy-card--error");
    expect(cards[1]?.text).toContain("The privacy check could not finish.");
    expect(privacyExchangeOutcomeDisplay({
      outcome: "failed",
      failure: { stage: "privacy_check" },
    }).label).toBe("Nothing shared; privacy check failed");
  });

  test("renders observable local answer activity without hidden model reasoning", () => {
    const nodes = spine({
      agentTraces: [{
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-example",
        terminalStopReason: "end_turn",
        messages: [{ role: "assistant", parts: [
          { kind: "thinking", text: "Check the fictional schedule." },
          { kind: "tool_use", toolCallId: "tool-1", tool: "search_documents", args: { query: "fictional schedule" } },
          { kind: "text", text: "The fictional review is Thursday." },
        ] }],
        subagentEvents: [],
      }],
    });
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("Agent transcript");
    expect(text).not.toContain("Check the fictional schedule.");
    expect(text).toContain("The fictional review is Thursday.");
  });

  test("keeps original attempt numbers and explains incomplete bounded transcripts", () => {
    const trace = (attempt: number, truncated = false) => ({
      attempt,
      provider: "synthetic-provider",
      model: "synthetic-model",
      sessionId: `session-example-${attempt}`,
      terminalStopReason: "error",
      truncated,
      omittedParts: truncated ? 17 : null,
      messages: [],
    });
    const text = allText(spine({
      agentTraces: [trace(2, true), trace(3), trace(4)],
      agentTraceOmittedAttempts: 1,
    }));
    expect(text).toContain("Attempt 2");
    expect(text).toContain("Attempt 3");
    expect(text).toContain("Attempt 4");
    expect(text).toMatch(/1 additional stored attempt could\s*not be shown/);
    expect(text).toContain("17 observable transcript parts were omitted from this stored transcript.");
  });

  test("uses a generic incomplete-transcript warning for legacy traces without an exact count", () => {
    const text = allText(spine({
      agentTraces: [{
        attempt: 1,
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-example-1",
        terminalStopReason: "end_turn",
        truncated: true,
        messages: [],
      }],
    }));
    expect(text).toContain("This stored transcript is incomplete; some activity could not be shown.");
  });

  test("the actor glyphs are three fixed marks, never a per-vendor logo", () => {
    const nodes = spine();
    const glyphs = nodes.filter((node) => String(node.class).startsWith("privacy-glyph"));
    expect(glyphs).toHaveLength(3);
    expect(glyphs.map((node) => node.class)).toEqual([
      "privacy-glyph privacy-glyph--external",
      "privacy-glyph privacy-glyph--omnesis omnesis-mark",
      "privacy-glyph privacy-glyph--check",
    ]);
    // The caller's name is self-asserted, so nothing in the markup keys off it.
    for (const glyph of glyphs) {
      expect(JSON.stringify(glyph.props)).not.toMatch(/atlas|openclaw|hermes/i);
    }
    expect(nodes.every((node) => node.tag !== "img")).toBe(true);
  });

  test("the trust boundary is structural: outside, a hairline, then a tinted inside", () => {
    const nodes = spine();
    const order = nodes
      .map((node) => String(node.class))
      .filter((cls) =>
        cls.includes("privacy-card--outside")
        || cls === "privacy-boundary-line"
        || cls === "privacy-inside"
        || cls.startsWith("privacy-zone"));
    expect(order[0]).toBe("privacy-zone privacy-zone--outside");
    expect(order).toContain("privacy-boundary-line");
    expect(order.indexOf("privacy-inside")).toBeGreaterThan(order.indexOf("privacy-boundary-line"));

    const boundaries = nodes.filter((node) => node.class === "privacy-boundary-line");
    // Something left, so the re-crossing is marked too.
    expect(boundaries.map((node) => node.text)).toEqual(["your machine", "left your machine"]);
  });

  test("the spine is three zones, so its line never breaks between cards", () => {
    const nodes = spine();
    // One zone per band, in story order. Each draws its own full-height line;
    // there are no per-gap stubs left to leave holes in it.
    expect(nodes.filter((node) => String(node.class).startsWith("privacy-zone"))
      .map((node) => node.class))
      .toEqual([
        "privacy-zone privacy-zone--outside",
        "privacy-zone privacy-zone--inside",
        "privacy-zone privacy-zone--received",
      ]);
    expect(nodes.some((node) => String(node.class).includes("privacy-rail"))).toBe(false);

    // Nothing left, so the spine stops at the inside zone.
    const kept = spine({ outcome: "not_shared", sharedAnswer: null, sharedAt: null });
    expect(kept.filter((node) => String(node.class).startsWith("privacy-zone"))
      .map((node) => node.class))
      .toEqual(["privacy-zone privacy-zone--outside", "privacy-zone privacy-zone--inside"]);
  });

  test("nothing that stayed inside is drawn as having crossed back out", () => {
    const nodes = spine({
      outcome: "not_shared",
      status: "denied",
      sharedAnswer: null,
      sharedAt: null,
      pendingCandidate: "Thursday at 15:00 is free.",
      reductions: [],
    });
    const boundaries = nodes.filter((node) => node.class === "privacy-boundary-line");
    expect(boundaries.map((node) => node.text)).toEqual(["your machine"]);
    expect(allText(nodes)).toContain("This draft has not left this machine.");
  });

  test("a card with no draft says so once, not twice", () => {
    const nodes = spine({
      outcome: "not_shared",
      status: "denied",
      sharedAnswer: null,
      sharedAt: null,
      pendingCandidate: null,
      draftAnswer: null,
    });
    const text = allText(nodes);
    expect(text).toContain("The draft is not available. Nothing about it left this machine.");
    // The follow-up note only has something to say when there is a draft to
    // say it about; with none, it would restate the sentence above it.
    expect(text).not.toContain("This draft has not left this machine.");
    expect(nodes.some((node) => String(node.class) === "privacy-card-note")).toBe(false);
  });

  test("shows a locally recorded draft when an unattended request could not ask for approval", () => {
    const nodes = spine({
      outcome: "not_shared",
      status: "denied",
      sharedAnswer: null,
      sharedAt: null,
      draftAnswer: "The fictional reception desk is open until 17:00.",
      pendingCandidate: null,
      approval: null,
      denialReason: "approval_not_available",
    });
    const text = allText(nodes);
    expect(text).toContain("The fictional reception desk is open until 17:00.");
    expect(text).toContain(
      "The privacy check recommended approval, but this request has no approval flow.",
    );
    expect(text).toContain("Omnesis did not share the answer.");
    expect(text).not.toContain("The draft is not available.");
    expect(nodes.some((node) => node.tag === "button" && node.text.trim() === "Share once"))
      .toBe(false);
  });

  test("the caller's own account of itself is on the card, not behind a toggle", () => {
    const nodes = spine();
    const text = allText(nodes);
    expect(text).toContain("Calendar coordinator");
    expect(text).toContain("Find a suitable meeting time.");
    // Nothing on the asked card has to be opened to be read.
    const asked = nodes.find((node) => node.class === "privacy-card privacy-card--outside");
    expect(asked).toBeTruthy();
    expect(nodes.filter((node) => node.tag === "details" && node.class === "privacy-card-more"))
      .toHaveLength(0);
  });

  test("the decision reads as a full sentence, with the reductions it applied", () => {
    const text = allText(spine());
    expect(text).toContain(
      "Omnesis removed details from this answer, then Atlas received the rest.",
    );
    expect(text).toContain("Details removed before sharing");
    expect(text).toContain("Removed the exact time.");
    expect(text).toContain("Checked by local / review-model.");
  });

  test("a pending exchange decides in place, on the privacy card", () => {
    const nodes = spine({
      ...PENDING_EXCHANGE,
      approval: { ...PENDING_EXCHANGE.approval },
    });
    const decision = nodes.find((node) => String(node.class).includes("privacy-card--decision"));
    expect(decision).toBeTruthy();
    const buttons = nodes.filter((node) => node.tag === "button").map((node) => node.text.trim());
    expect(buttons).toEqual(["Share once", "Don’t share"]);
    expect(allText(nodes))
      .toContain("Omnesis is holding this answer until you decide. Nothing has been shared.");
  });

  test.each([
    [
      { userDecision: "approved_but_blocked" },
      "You approved this once, but Omnesis blocked it. Nothing was shared.",
    ],
    [
      { outcome: "not_shared", approval: null, review: { ...REVIEW, fallbackCause: "hard_stop" } },
      "Omnesis blocked this answer automatically. Nothing was shared.",
    ],
    [
      {
        outcome: "not_shared",
        review: { ...REVIEW, fallbackCause: "hard_stop" },
        approval: { id: "approval-example", status: "denied", expiresAt: 1 },
      },
      "You approved this once, but Omnesis blocked it. Nothing was shared.",
    ],
    [
      { outcome: "failed", review: { ...REVIEW, fallbackCause: "request_failed" } },
      "Omnesis could not verify this automatically. Nothing was shared.",
    ],
    [{ outcome: "canceled", review: null }, "The request was canceled. Nothing was shared."],
  ])("phrases each terminal outcome without implying the wrong egress", (patch, sentence) => {
    expect(exchangeDecisionCopy({ ...SHARED_EXCHANGE, ...patch })).toBe(sentence);
  });

  test("only the exchange's own words are drawn as quotes", () => {
    const nodes = spine();
    const quoted = (cls: string) =>
      nodes.find((node) => String(node.class).startsWith(cls))?.class ?? "";

    // The request, the answer, and the reviewer's account of it were each
    // written by something other than this page, so each sits on the surface
    // the released-answer comparison also uses.
    expect(quoted("privacy-card-question")).toContain("privacy-quote");
    expect(quoted("privacy-card-answer")).toContain("privacy-quote");
    expect(quoted("privacy-decision-reason")).toContain("privacy-quote");

    // The sentences Omnesis writes about the exchange must not take it: the
    // contrast is what tells a reader whose words they are looking at.
    expect(quoted("privacy-decision-sentence")).not.toContain("privacy-quote");
    expect(quoted("privacy-card-caveat")).not.toContain("privacy-quote");
    expect(quoted("privacy-card-outside-note")).not.toContain("privacy-quote");

    const held = spine({
      outcome: "not_shared",
      sharedAnswer: null,
      sharedAt: null,
      pendingCandidate: "Thursday at 15:00 is free.",
    });
    expect(held.find((node) => node.class === "privacy-card-note")?.text)
      .toBe("This draft has not left this machine.");
    expect(held.find((node) => String(node.class).startsWith("privacy-card-answer"))?.class)
      .toContain("privacy-quote");
  });

  test("the drafting model is stated on the card that drafted", () => {
    const nodes = spine();
    expect(nodes.filter((node) => String(node.class).startsWith("privacy-card ")).length)
      .toBeLessThanOrEqual(3);
    expect(allText(nodes)).toContain("local / drafting-model");
  });

  test("every recorded step is on the spine, none of it behind a toggle", () => {
    const nodes = spine();
    const text = allText(nodes);
    // Three of the four recorded steps are the spine's landmarks — the request,
    // the draft and the review — so one is a row of its own.
    expect(nodes.filter((node) => node.class === "privacy-ledger-step")).toHaveLength(1);
    expect(text).toContain("Agent activity");
    expect(text).toContain("Searched the calendar index for open afternoons.");
    expect(text).toContain("Privacy check");
    expect(text).toContain("local / review-model");

    // Nothing has to be expanded, and nothing navigates away to be read.
    expect(nodes.some((node) => node.class === "privacy-technical-toggle")).toBe(false);
    expect(nodes.some((node) => node.tag === "button" && node.text.trim() === "Copy record"))
      .toBe(false);

    // Integrity digests and the raw audit payload stay off screen on a page
    // whose whole claim is that answers stay inside Omnesis.
    expect(text).not.toMatch(/SHA-256|Show audit data|Trusted audit data/);
  });

  /**
   * An exchange whose record kept no rationale still recorded the sentence the
   * reviewer wrote. Reading only the record would lose the reviewer's account
   * entirely on those, on the one screen that exists to show it.
   */
  test("the reviewer's own words survive an exchange whose record kept none", () => {
    const nodes = spine({ review: { ...REVIEW, rationale: null } });
    const quoted = nodes.find((node) => String(node.class).includes("privacy-decision-reason"));

    expect(quoted?.text).toContain("The policy allowed this answer.");
    expect(quoted?.class).toContain("privacy-quote");
  });

  test("the spine's order is the ledger's order, and both cards always render", () => {
    // The agent's step was recorded before the draft, so it is above the draft
    // card on the spine — the ledger decides, not the card's importance.
    const order = privacySpineOrder(SHARED_EXCHANGE, AUDIT_EVENTS);
    expect(order.inside.map((item) => item.kind)).toEqual(["step", "draft", "check"]);

    // A ledger that recorded neither landmark still gets both cards: one says
    // Omnesis is drafting, the other carries the decision.
    const bare = privacySpineOrder(SHARED_EXCHANGE, []);
    expect(bare.inside.map((item) => item.kind)).toEqual(["draft", "check"]);
    expect(bare.askedAt).toBe(SHARED_EXCHANGE.createdAt);
    expect(bare.released).toBeNull();
  });
});

describe("the policy editor", () => {
  test("restored drafts retain and detect their base revision", () => {
    const base = { policy: "# Current\n", revision: "revision-a" };
    const saved = serializePolicyDraft("# Draft\n", base);
    expect(restorePolicyDraft(saved, base)).toEqual({ draft: "# Draft\n", stale: false });
    expect(restorePolicyDraft(saved, { ...base, revision: "revision-b" })).toEqual({
      draft: "# Draft\n",
      stale: true,
    });
  });

  test("the save review shows line and character changes without relying on colour", () => {
    const nodes = expandToHostNodes(PrivacyPolicyDiff({
      before: "# Policy\nKeep exact detail blocked.\nOld line",
      after: "# Policy\nKeep summary detail blocked.\nNew line",
    }));
    expect(nodes.some((node) => String(node.class).includes("privacy-policy-diff-row--remove"))).toBe(true);
    expect(nodes.some((node) => String(node.class).includes("privacy-policy-diff-row--add"))).toBe(true);
    expect(nodes.some((node) => String(node.class).includes("privacy-diff-char--remove"))).toBe(true);
    expect(nodes.some((node) => String(node.class).includes("privacy-diff-char--add"))).toBe(true);
    expect(allText(nodes)).toContain("−");
    expect(allText(nodes)).toContain("+");
  });

});
