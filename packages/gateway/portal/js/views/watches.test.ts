// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

vi.mock("../api.js", () => ({
  approveSubscriptionApproval: vi.fn(),
  deleteWatchV2Watch: vi.fn(),
  denySubscriptionApproval: vi.fn(),
  getPrivacySubscription: vi.fn(),
  getPrivacySubscriptionFiring: vi.fn(),
  getSubscriptionApproval: vi.fn(),
  getWatchV2Watch: vi.fn(),
  listPrivacySubscriptionFirings: vi.fn(),
  listPrivacySubscriptions: vi.fn(),
  listSubscriptionApprovals: vi.fn(),
  listWatchV2Firings: vi.fn(),
  listWatchV2Watches: vi.fn(),
  purgePrivacySubscription: vi.fn(),
  revokePrivacySubscription: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  approveSubscriptionApproval,
  denySubscriptionApproval,
  getPrivacySubscription,
  getSubscriptionApproval,
  getWatchV2Watch,
  revokePrivacySubscription,
} from "../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { resolveWatchDetail } from "./watches.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  SubscriptionApprovalDetail,
  SubscriptionApprovalList,
  resolveSubscriptionApprovalRequest,
} from "./watches/approval.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacySubscriptionFiringDetail } from "./watches/firing.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  InstalledWatchDetail,
  InstalledWatchList,
  mergeWatchFirings,
  orderedInstalledWatches,
} from "./watches/installed.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { revokePrivacySubscriptionRequest } from "./watches/revoke.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  canPurgePrivacySubscription,
  canRevokePrivacySubscription,
  installedWatchDelivery,
  installedWatchDocument,
  installedWatchSummary,
  privacySubscriptionDocument,
  subscriptionApprovalDocument,
  subscriptionGroundingCopy,
  watchVerdictMark,
  watchVerdictSentence,
} from "./watches/vocabulary.js";


/* eslint-disable @typescript-eslint/no-explicit-any */
function expandToHostNodes(vnode: any, out: any[] = []): any[] {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const child of vnode) expandToHostNodes(child, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number" || !vnode.type) return out;
  if (typeof vnode.type === "function") {
    // Components are called directly, with no renderer behind them, so one
    // that uses hooks throws here. Record that it was present and keep
    // walking: a shared affordance like the copy button should not make the
    // surrounding screen untestable, and an assertion about the component's
    // own internals would be lying anyway.
    let rendered;
    try {
      rendered = vnode.type(vnode.props ?? {});
    } catch {
      out.push({
        tag: `<${vnode.type.name || "component"}>`,
        class: vnode.props?.class ?? "",
        text: "",
        props: vnode.props ?? {},
      });
      return out;
    }
    return expandToHostNodes(rendered, out);
  }
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
    if (typeof children.type !== "function") return collectText(children.props?.children);
    // Same limitation as the walker: no renderer, so a hooks component throws.
    // It contributes no text rather than failing the read around it.
    try {
      return collectText(children.type(children.props ?? {}));
    } catch {
      return "";
    }
  }
  return "";
}

const SUBSCRIPTION_APPROVAL = {
  id: "subscription-approval-example",
  subscriptionId: "subscription-example",
  workflowHandle: "workflow-example",
  integration: { displayName: "OpenClaw", source: "token" },
  status: "pending",
  interpretedCondition: {
    summary: "A new project update requests a decision",
    pushDetail: "existence",
  },
  interpretation: {
    summary: "A new project update requests a decision",
    pushDetail: "existence",
  },
  workflowId: "workflow-example",
  integrationDeviceId: "integration-device-example",
  integrationDevice: {
    id: "integration-device-example",
    name: "Fictional OpenClaw integration",
    kind: "agent",
  },
  workflow: {
    id: "workflow-example",
    name: "Fictional workflow",
    purpose: "Review fictional project updates",
  },
  revisionId: "subscription-revision-example",
  revision: 1,
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
  resolvedAt: null,
  condition: {
    kind: "natural-language",
    description: "a fictional launch update that requests a decision",
  },
  reaction: {
    kind: "agent-workflow",
    instruction: "Review the update, decide whether follow-up is required, and draft a response if useful.",
  },
  categories: ["private communication"],
  policyRevision: "policy-revision-example",
};

const SUBSCRIPTION = {
  ...SUBSCRIPTION_APPROVAL,
  id: SUBSCRIPTION_APPROVAL.subscriptionId,
  status: "active",
  firingCount: 2,
  lastFiredAt: 1_700_000_500_000,
};

const FIRING_DETAIL = {
  id: "sfiring_detail",
  subscriptionId: SUBSCRIPTION.id,
  revision: 1,
  revisionId: "1",
  workflowId: "workflow-example",
  workflowHandle: "workflow-example",
  status: "delivered",
  firedAt: 1_700_000_500_000,
  createdAt: 1_700_000_500_000,
  deliveryStatus: "delivered",
  acceptedAt: 1_700_000_520_000,
  indexEventKey: "document:created:firing-detail",
  delivery: {
    id: "sdel_sfiring_detail",
    status: "delivered",
    attempts: 1,
    acceptedAt: 1_700_000_520_000,
    localRunId: "run_fictional_background",
    lastError: null,
    updatedAt: 1_700_000_530_000,
  },
  evidenceDocumentIds: ["doc_firing_detail"],
  evidenceDocuments: [
    {
      id: "doc_firing_detail",
      title: "Northstar rollout plan",
      sourceId: "gmail:jamie.lopez@example.com",
    },
  ],
  answerTasks: [
    {
      taskId: "answer_task_detail",
      conversationId: "answer_conversation_detail",
      status: "released",
      createdAt: 1_700_000_540_000,
      resolvedAt: 1_700_000_560_000,
    },
  ],
};

describe("subscription privacy surfaces", () => {
  test.each([
    ["approve", "approved", approveSubscriptionApproval],
    ["deny", "denied", denySubscriptionApproval],
  ])("reconciles a lost %s response without repeating the action", async (
    action,
    status,
    actionRequest,
  ) => {
    vi.mocked(approveSubscriptionApproval).mockClear();
    vi.mocked(denySubscriptionApproval).mockClear();
    vi.mocked(getSubscriptionApproval).mockClear();
    const lostResponse = new Error("Connection closed before the response arrived.");
    vi.mocked(actionRequest).mockRejectedValueOnce(lostResponse);
    vi.mocked(getSubscriptionApproval).mockResolvedValueOnce({
      approval: { ...SUBSCRIPTION_APPROVAL, status },
    });

    await expect(
      resolveSubscriptionApprovalRequest(SUBSCRIPTION_APPROVAL.id, action),
    ).resolves.toMatchObject({
      id: SUBSCRIPTION_APPROVAL.id,
      status,
      subscriptionId: SUBSCRIPTION_APPROVAL.subscriptionId,
    });
    expect(actionRequest).toHaveBeenCalledTimes(1);
    expect(getSubscriptionApproval).toHaveBeenCalledWith(SUBSCRIPTION_APPROVAL.id);
  });

  test.each([
    [
      "still pending",
      () => Promise.resolve({ approval: SUBSCRIPTION_APPROVAL }),
    ],
    [
      "unavailable",
      () => Promise.reject(new Error("Gateway unavailable during reconciliation.")),
    ],
  ])("preserves the action failure when reconciliation is %s", async (_label, reconcile) => {
    vi.mocked(approveSubscriptionApproval).mockClear();
    vi.mocked(getSubscriptionApproval).mockClear();
    const actionFailure = new Error("Approval response was lost.");
    vi.mocked(approveSubscriptionApproval).mockRejectedValueOnce(actionFailure);
    vi.mocked(getSubscriptionApproval).mockImplementationOnce(reconcile);

    await expect(
      resolveSubscriptionApprovalRequest(SUBSCRIPTION_APPROVAL.id, "approve"),
    ).rejects.toBe(actionFailure);
    expect(approveSubscriptionApproval).toHaveBeenCalledTimes(1);
    expect(getSubscriptionApproval).toHaveBeenCalledWith(SUBSCRIPTION_APPROVAL.id);
  });

  test("unwraps only trusted subscription detail envelopes", () => {
    expect(subscriptionApprovalDocument({ approval: SUBSCRIPTION_APPROVAL })).toEqual(
      SUBSCRIPTION_APPROVAL,
    );
    expect(privacySubscriptionDocument({ subscription: SUBSCRIPTION })).toEqual(SUBSCRIPTION);
    expect(subscriptionApprovalDocument({ approval: {} })).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: { id: "partial-example", status: "pending" },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: { ...SUBSCRIPTION_APPROVAL, reaction: { kind: "agent-workflow" } },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: {
          ...SUBSCRIPTION_APPROVAL,
          integration: { displayName: "OpenClaw", source: "fallback" },
        },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: { ...SUBSCRIPTION_APPROVAL, categories: [] },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: { ...SUBSCRIPTION_APPROVAL, createdAt: 0 },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: { ...SUBSCRIPTION_APPROVAL, expiresAt: 0 },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: {
          ...SUBSCRIPTION_APPROVAL,
          integrationDevice: { ...SUBSCRIPTION_APPROVAL.integrationDevice, id: "wrong-device" },
        },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: {
          ...SUBSCRIPTION_APPROVAL,
          workflow: { ...SUBSCRIPTION_APPROVAL.workflow, id: "wrong-workflow" },
        },
      }),
    ).toBeNull();
    expect(
      subscriptionApprovalDocument({
        approval: {
          ...SUBSCRIPTION_APPROVAL,
          interpretation: {
            ...SUBSCRIPTION_APPROVAL.interpretation,
            summary: "A different interpretation",
          },
        },
      }),
    ).toBeNull();
    expect(privacySubscriptionDocument({ evidence: { documentId: "private" } })).toBeNull();
  });

  test.each(["cli", "ios", "collector", "browser"])(
    "accepts a watch owned by a %s device so its measurement still reaches the card",
    (kind) => {
      const approval = {
        ...SUBSCRIPTION_APPROVAL,
        integration: { displayName: "Fictional console", source: "token" },
        integrationDevice: { ...SUBSCRIPTION_APPROVAL.integrationDevice, kind },
        grounding: {
          matchesNow: false,
          matchCount: 10,
          recentMatchCount: 1,
          latestMatchAt: 1_700_000_000_000,
          liveness: "active",
          horizonMs: 30 * 24 * 60 * 60 * 1000,
        },
      };
      expect(subscriptionApprovalDocument({ approval })).toEqual(approval);
      const nodes = expandToHostNodes(SubscriptionApprovalDetail({
        approval,
        busy: null,
        error: null,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }));
      expect(nodes.some((node) => node.class.includes("privacy-subscription-grounding"))).toBe(true);
    },
  );

  test("still rejects an approval whose owning device carries no kind at all", () => {
    expect(
      subscriptionApprovalDocument({
        approval: {
          ...SUBSCRIPTION_APPROVAL,
          integrationDevice: { ...SUBSCRIPTION_APPROVAL.integrationDevice, kind: "" },
        },
      }),
    ).toBeNull();
  });

  test("reconciles a lost revoke response without repeating the mutation", async () => {
    vi.mocked(revokePrivacySubscription).mockClear();
    vi.mocked(getPrivacySubscription).mockClear();
    vi.mocked(revokePrivacySubscription).mockRejectedValueOnce(
      new Error("Connection closed before the response arrived."),
    );
    vi.mocked(getPrivacySubscription).mockResolvedValueOnce({
      subscription: { ...SUBSCRIPTION, status: "revoked" },
    });

    await expect(
      revokePrivacySubscriptionRequest(SUBSCRIPTION.id),
    ).resolves.toMatchObject({ id: SUBSCRIPTION.id, status: "revoked" });
    expect(revokePrivacySubscription).toHaveBeenCalledTimes(1);
    expect(getPrivacySubscription).toHaveBeenCalledTimes(1);
  });

  test("preserves the original revoke failure when reconciliation is non-terminal", async () => {
    vi.mocked(revokePrivacySubscription).mockClear();
    vi.mocked(getPrivacySubscription).mockClear();
    const actionFailure = new Error("Revoke response was lost.");
    vi.mocked(revokePrivacySubscription).mockRejectedValueOnce(actionFailure);
    vi.mocked(getPrivacySubscription).mockResolvedValueOnce({
      subscription: { ...SUBSCRIPTION, status: "active" },
    });

    await expect(
      revokePrivacySubscriptionRequest(SUBSCRIPTION.id),
    ).rejects.toBe(actionFailure);
    expect(revokePrivacySubscription).toHaveBeenCalledTimes(1);
    expect(getPrivacySubscription).toHaveBeenCalledTimes(1);
  });

  test("renders exact condition and reaction while explaining identifier-only delivery", () => {
    const nodes = expandToHostNodes(SubscriptionApprovalDetail({
      approval: SUBSCRIPTION_APPROVAL,
      busy: null,
      error: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    }));
    const text = nodes.map((node) => node.text).join(" ").replace(/\s+/g, " ");
    expect(text).toContain(SUBSCRIPTION_APPROVAL.condition.description);
    expect(text).toContain(SUBSCRIPTION_APPROVAL.reaction.instruction);
    expect(text).toContain(SUBSCRIPTION_APPROVAL.integrationDevice.name);
    expect(text).toContain(SUBSCRIPTION_APPROVAL.workflow.name);
    expect(text).toContain(SUBSCRIPTION_APPROVAL.workflow.purpose);
    expect(text).toContain("Document identifiers, titles, content, people, source metadata");
    expect(text).not.toContain("document-example-private");
    expect(nodes.some((node) => node.tag === "button" && node.text === "Approve watch")).toBe(true);
  });

  test("renders the live measurement under the interpreted condition", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const nodes = expandToHostNodes(SubscriptionApprovalDetail({
      approval: {
        ...SUBSCRIPTION_APPROVAL,
        grounding: {
          matchesNow: false,
          matchCount: 1,
          recentMatchCount: 0,
          latestMatchAt: Date.now() - 396 * DAY_MS,
          liveness: "dormant",
          horizonMs: 30 * DAY_MS,
        },
      },
      busy: null,
      error: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    }));
    const block = nodes.find((node) => node.class.includes("privacy-subscription-grounding"));
    expect(block).toBeDefined();
    expect(block.class).toContain("warning");
    expect(block.text).toBe(
      "Does not match right now · 0 matching rows in the last 30 days · latest matching data last year",
    );
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["malformed", { matchesNow: false, matchCount: "many" }],
  ])("omits the measurement when the gateway reported %s grounding", (_label, grounding) => {
    const nodes = expandToHostNodes(SubscriptionApprovalDetail({
      approval: { ...SUBSCRIPTION_APPROVAL, grounding },
      busy: null,
      error: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(nodes.some((node) => node.class.includes("privacy-subscription-grounding"))).toBe(false);
    expect(text).not.toContain("matching rows");
    expect(text).not.toContain("Does not match right now");
    expect(nodes.some((node) => node.tag === "button" && node.text === "Approve watch")).toBe(true);
  });

  test("describes a live watch without implying it already fired", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    expect(subscriptionGroundingCopy({
      matchesNow: true,
      matchCount: 400,
      recentMatchCount: 12,
      latestMatchAt: now - 2 * 60 * 60 * 1000,
      liveness: "active",
      horizonMs: 30 * DAY_MS,
    }, now)).toBe(
      "Matches right now · 12 matching rows in the last 30 days · latest matching data 2 hours ago",
    );
    expect(subscriptionGroundingCopy({
      matchesNow: false,
      matchCount: 0,
      recentMatchCount: 0,
      latestMatchAt: null,
      liveness: "empty",
      horizonMs: 30 * DAY_MS,
    }, now)).toBe("Does not match right now · no matching data yet");
  });

  test("offers revoke for every non-purged-terminal watch status", () => {
    // Denied included: denial leaves the watch open to revision, so revoking
    // it is the operator's path to making it purgeable.
    expect(
      ["pending_approval", "active", "paused", "denied"].map(canRevokePrivacySubscription),
    ).toEqual([true, true, true, true]);
    expect(["revoked", "expired"].map(canRevokePrivacySubscription)).toEqual([false, false]);
  });

  test("offers permanent delete only once a record is terminal", () => {
    expect(["revoked", "expired"].map(canPurgePrivacySubscription)).toEqual([true, true]);
    expect(
      ["pending_approval", "active", "paused", "denied"].map(canPurgePrivacySubscription),
    ).toEqual([false, false, false, false]);
  });

  test("firing detail names what it read, how it was delivered, and what came back", () => {
    const nodes = expandToHostNodes(PrivacySubscriptionFiringDetail({
      subscription: SUBSCRIPTION,
      firing: FIRING_DETAIL,
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("Northstar rollout plan");
    expect(text).toContain("Accepted by the agent");
    expect(text).toContain("run_fictional_background");
    // The evidence is reachable, not just named: this page exists to be the
    // start of "why did this fire?", and a title with no link ends the trail.
    expect(nodes.find((node) => node.props?.class?.startsWith("doc-chip"))?.props.href).toBe(
      "/portal/doc/doc_firing_detail",
    );
    expect(
      nodes.find((node) => node.props?.class === "privacy-conversation-row")?.props.href,
    ).toBe("/portal/audit/conversations/answer_conversation_detail");
  });

  test("says plainly when nothing in the corpus is behind a firing", () => {
    // A watch that comes true on a clock or a deadline has no evidence to
    // show, and that is the watch working. Rendering an empty list there
    // reads as something missing.
    const nodes = expandToHostNodes(PrivacySubscriptionFiringDetail({
      subscription: SUBSCRIPTION,
      firing: {
        ...FIRING_DETAIL,
        evidenceDocuments: [],
        answerTasks: [],
        evidenceDocumentIds: [],
      },
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("came true on a clock");
    expect(text).toContain("has not come back through the answer boundary");
    expect(nodes.some((node) => node.props?.class?.startsWith("doc-chip"))).toBe(false);
  });

  test("watch request list links into the Watches inbox", () => {
    const nodes = expandToHostNodes(SubscriptionApprovalList({
      approvals: [SUBSCRIPTION_APPROVAL],
    }));
    expect(nodes.find((node) => node.tag === "a")?.props.href).toBe(
      "/portal/watches/approvals/subscription-approval-example",
    );
  });
});

// A watch the operator asked for, as the listing hands it over: no definition,
// because the listing omits it, and the request in the words it was asked in.
const INSTALLED_WATCH_ENTRY = {
  id: "watch-shipment-example",
  name: "shipment-delay",
  status: "active",
  addedAt: "2026-05-04T09:00:00.000Z",
  fromSeq: 4210,
  note: null,
  request: "tell me when a supplier says a shipment will be late",
  firings: 3,
};

// The same watch as the detail read returns it: the definition verbatim, which
// is the only place the proposition and the delivery block live.
const INSTALLED_WATCH = {
  id: INSTALLED_WATCH_ENTRY.id,
  name: INSTALLED_WATCH_ENTRY.name,
  status: "active",
  addedAt: INSTALLED_WATCH_ENTRY.addedAt,
  fromSeq: INSTALLED_WATCH_ENTRY.fromSeq,
  note: null,
  dsl: {
    watch: {
      name: "shipment-delay",
      nl_query: "tell me when a supplier says a shipment will be late",
      firing_policy: { kind: "once_per_key" },
      nodes: [
        {
          id: "supplier-mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"] },
          recall: { semantic: { query: "shipment delayed", threshold: 0.35 } },
          judge: {
            proposition: "the message says a shipment will arrive later than promised",
            output_schema: { decision: "boolean" },
          },
        },
      ],
      sink: { input: "supplier-mail" },
    },
  },
};

/** A watch that wakes an integration, with the record that authorised it. */
const WAKE_DISCLOSURE = {
  authoredBy: "integration",
  subscriptionId: "subscription-example",
  status: "active",
  integrationName: "Fictional OpenClaw integration",
  revision: 1,
  interpretation: "A supplier says a shipment will be late",
  condition: "tell me when a supplier says a shipment will be late",
  instruction: "Draft a reply asking for a revised date",
  evidence: "documents",
  approval: { status: "approved" },
  expiresAt: 1_800_000_000_000,
  revokedAt: null,
  policyRevision: "policy-revision-example",
  firingCount: 2,
  lastFiredAt: 1_700_000_500_000,
};

describe("one watch, one page", () => {
  const detail = (props) =>
    expandToHostNodes(
      InstalledWatchDetail({
        watch: { ...INSTALLED_WATCH, disclosure: WAKE_DISCLOSURE },
        firings: [],
        onRemove: vi.fn(),
        onRevoke: vi.fn(),
        onPurge: vi.fn(),
        ...props,
      }),
    );

  // Who asked for a watch and where its firings go are facts on the row, not
  // sections the list divides into.
  test("says who asked and where a firing goes, on the row", () => {
    const nodes = expandToHostNodes(
      InstalledWatchList({
        watches: [
          { ...INSTALLED_WATCH_ENTRY, delivery: "omnesis-notify", disclosure: null },
          {
            ...INSTALLED_WATCH_ENTRY,
            id: "watch-wake-example",
            delivery: "agent-wake",
            disclosure: WAKE_DISCLOSURE,
          },
        ],
      }),
    );
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("You asked for this");
    expect(text).toContain("Notifies you");
    expect(text).toContain("Fictional OpenClaw integration asked for this");
    expect(text).toContain("Wakes Fictional OpenClaw integration");
    // One list, no headings dividing it, and no glyph opening each row.
    expect(text).not.toContain("Watches you asked for");
    expect(text).not.toContain("Watches an integration asked for");
    expect(nodes.some((node) => node.props?.class === "privacy-subscription-icon")).toBe(false);
  });

  test("says where a firing goes and leaves the record's bookkeeping off screen", () => {
    const text = detail({
      egress: [{ id: "firing-example", createdAt: 1_700_000_500_000, deliveryStatus: "delivered" }],
    })
      .map((node) => node.text)
      .join(" ");
    expect(text).toContain("Fictional OpenClaw integration");
    expect(text).toContain("Draft a reply asking for a revised date");
    expect(text).toContain("Revoke this watch's access");

    // The record's identity, its revision and the policy revision that judged
    // it are all readable from the address bar or the definition. Restating the
    // compiler's reading of the request under "Approved as" says what "What you
    // asked for" already said, in worse words.
    expect(text).not.toContain("policy-r…xample");
    expect(text).not.toContain("Approved as");
    expect(text).not.toContain("Policy revision");
    expect(text).not.toContain("A supplier says a shipment will be late");
  });

  test("a sent firing with no caught half still gets a row, and links to its audit", () => {
    const nodes = detail({
      egress: [{ id: "firing-example", createdAt: 1_700_000_500_000, deliveryStatus: "delivered" }],
    });
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("firing-example");
    expect(
      nodes.find((node) => node.text?.trim() === "audit")?.props.href,
    ).toBe("/portal/watches/subscription-example/firings/firing-example");
  });

  test("one firing caught and sent is one row, linked to both records", () => {
    const nodes = detail({
      firings: [{ seq: 41, firedAt: 1_700_000_500_000, delivery: { kind: "agent-wake", delivered: 1 } }],
      egress: [{
        id: "firing-example",
        seq: 41,
        createdAt: 1_700_000_500_000,
        deliveryStatus: "delivered",
      }],
    });
    const rows = nodes.filter((node) => node.props?.class === "privacy-subscription-firing-row");
    expect(rows).toHaveLength(1);
    const links = nodes.filter((node) => node.tag === "a").map((node) => node.text.trim());
    expect(links).toContain("debug");
    expect(links).toContain("audit");
    // Both records exist, so neither word is dimmed.
    expect(nodes.filter((node) => String(node.class).includes("watch-link--absent"))).toEqual([]);
  });

  // Every row of one watch carries the same pair of words, so the shape of the
  // list is a property of the page rather than of which records happen to
  // exist — and a reader who came looking for one of them is told it is not
  // there. The reason rides in the title and in a screen-reader sibling,
  // because a dim word alone says nothing to anyone who cannot see it.
  const dimmed = (nodes: any[]) =>
    nodes.filter((node) => String(node.class).includes("watch-link--absent"));

  test("a firing missing its sent half dims audit and says why", () => {
    const nodes = detail({
      firings: [{ seq: 41, firedAt: 1_700_000_500_000, delivery: { kind: "agent-wake", delivered: 1 } }],
    });
    expect(nodes.find((node) => node.tag === "a" && node.text.trim() === "debug")).toBeTruthy();
    const absent = dimmed(nodes);
    expect(absent).toHaveLength(1);
    expect(absent[0].text).toContain("audit");
    expect(absent[0].props.title).toContain("No egress record");
    // The same sentence, reachable without seeing the tooltip.
    expect(
      nodes.filter((node) => String(node.class).includes("sr-only")).map((node) => node.text),
    ).toContainEqual(expect.stringContaining("No egress record"));
  });

  test("a firing missing its caught half dims debug and says why", () => {
    const nodes = detail({
      egress: [{ id: "firing-example", createdAt: 1_700_000_500_000, deliveryStatus: "delivered" }],
    });
    expect(nodes.find((node) => node.tag === "a" && node.text.trim() === "audit")).toBeTruthy();
    const absent = dimmed(nodes);
    expect(absent).toHaveLength(1);
    expect(absent[0].text).toContain("debug");
    expect(absent[0].props.title).toContain("No runtime record");
  });

  // "This firing sent nothing" and "the ledger did not answer" are different
  // claims, and a failed egress read only supports the second. The banner above
  // the list carries it; the rows say nothing rather than the wrong thing.
  test("a failed egress read leaves audit off the rows rather than dimming it", () => {
    const nodes = detail({
      firings: [{ seq: 41, firedAt: 1_700_000_500_000, delivery: { kind: "agent-wake", delivered: 1 } }],
      egressError: "Gateway unreachable",
    });
    expect(nodes.map((node) => node.text).join(" ")).toContain("Failed to load what it has sent");
    expect(dimmed(nodes)).toEqual([]);
    expect(nodes.filter((node) => node.text?.trim() === "audit")).toEqual([]);
  });

  // A watch that wakes nobody has no egress ledger, so "audit" names a record
  // that cannot exist. Dimming it would report a permanent absence as a gap.
  test("a watch that tells nobody carries debug alone on its firings", () => {
    const nodes = expandToHostNodes(
      InstalledWatchDetail({
        watch: { ...INSTALLED_WATCH, disclosure: null },
        firings: [{ seq: 41, firedAt: 1_700_000_500_000, delivery: { kind: "none" } }],
        onRemove: () => {},
      }),
    );
    expect(nodes.find((node) => node.tag === "a" && node.text.trim() === "debug")).toBeTruthy();
    expect(dimmed(nodes)).toEqual([]);
    expect(nodes.map((node) => node.text?.trim()).filter(Boolean)).not.toContain("audit");
  });

  // Defensive: the gateway types a firing's sequence as required, so this is a
  // shape only a newer or broken one can produce. The row still draws, and the
  // dim word says which of the two absences it is — the runtime record is here,
  // its address is not.
  test("a caught firing with no journal sequence says its address is missing, not its record", () => {
    const nodes = detail({
      firings: [{ firedAt: 1_700_000_500_000, delivery: { kind: "agent-wake", delivered: 1 } }],
    });
    const absent = dimmed(nodes);
    expect(absent.map((node) => node.text.trim().split(" ")[0])).toContain("debug");
    expect(absent.find((node) => node.text.includes("debug"))?.props.title)
      .toContain("No journal sequence");
  });

  // A watch that wakes nobody has no disclosure to make. An empty section would
  // report that as something missing rather than as the ordinary case.
  test("shows no disclosure section for a watch that tells nobody", () => {
    const text = expandToHostNodes(
      InstalledWatchDetail({
        watch: { ...INSTALLED_WATCH, disclosure: null },
        firings: [],
        onRemove: vi.fn(),
      }),
    )
      .map((node) => node.text)
      .join(" ");
    expect(text).not.toContain("What it tells an integration");
    expect(text).not.toContain("Revoke this watch's access");
  });

  // The egress ledger is what left the machine; the firings above are what the
  // runtime caught. A watch can catch something and fail to send it, so a
  // failed read of one must never be reported as the other being empty.
  test("does not read a failed egress read as nothing having been sent", () => {
    const text = detail({ egressError: "Firing history is unavailable." })
      .map((node) => node.text)
      .join(" ");
    expect(text).toContain("Firing history is unavailable.");
    expect(text).not.toContain("It has never reached out.");
  });
});

describe("watches the runtime is running", () => {
  test("reads a watch out of the runtime's envelope, and refuses one it cannot address", () => {
    expect(installedWatchDocument({ watch: INSTALLED_WATCH })).toEqual(INSTALLED_WATCH);
    expect(installedWatchDocument(INSTALLED_WATCH)).toEqual(INSTALLED_WATCH);
    // The firings response names its watch under the same key, as a bare name.
    // Reading that as a watch would put a detail screen on screen with no id to
    // address, so the delete button would target nothing.
    expect(installedWatchDocument({ watch: "shipment-delay", firings: [] })).toBeNull();
    expect(installedWatchDocument({ watch: { ...INSTALLED_WATCH, id: "" } })).toBeNull();
    expect(installedWatchDocument({ watch: { ...INSTALLED_WATCH, name: "" } })).toBeNull();
    // A status outside the runtime's own vocabulary means this build is reading
    // a record it does not understand, and every label it would print is a guess.
    expect(installedWatchDocument({ watch: { ...INSTALLED_WATCH, status: "revoked" } })).toBeNull();
    expect(installedWatchDocument(null)).toBeNull();
  });

  test("names a watch by what was asked for, and by its handle when nothing was", () => {
    expect(installedWatchSummary(INSTALLED_WATCH_ENTRY)).toBe(INSTALLED_WATCH_ENTRY.request);
    // The detail read carries no `request` field at all — the request lives
    // inside the definition, and both reads have to name the watch the same way.
    expect(installedWatchSummary(INSTALLED_WATCH)).toBe(INSTALLED_WATCH_ENTRY.request);
    const handWritten = { ...INSTALLED_WATCH, dsl: { watch: { name: "shipment-delay" } } };
    expect(installedWatchSummary(handWritten)).toBe("shipment-delay");
  });

  test("states that a watch with no delivery block interrupts nobody", () => {
    // Silence from a watch that records and one that pushes look identical
    // from the outside, and only one of them is going to tell the operator
    // anything. The absence is stated rather than left to be inferred.
    const quiet = installedWatchDelivery(INSTALLED_WATCH);
    expect(quiet.delivers).toBe(false);
    expect(quiet.text).toContain("Delivers nowhere");

    const pushed = installedWatchDelivery(withDelivery({
      kind: "omnesis-notify",
      title: "Shipment delayed",
      body: "A supplier moved a delivery date.",
    }));
    expect(pushed.delivers).toBe(true);
    expect(pushed.text).toContain("Shipment delayed");
    expect(pushed.text).toContain("A supplier moved a delivery date.");

    const woken = installedWatchDelivery(withDelivery({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "Draft a reply asking for a revised delivery date.",
    }));
    expect(woken.delivers).toBe(true);
    expect(woken.text).toContain("openclaw");
    expect(woken.text).toContain("Draft a reply asking for a revised delivery date.");
    expect(woken.bindings).toEqual([]);
  });

  test("carries the referents a wake hands over, beside the sentence", () => {
    // The instruction is prose the operator reads; a referent is a value they
    // check against the thing it points at. Folded into the sentence, the one
    // fact that says *which* conversation would read as part of the prose.
    const woken = installedWatchDelivery(withDelivery({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "Reply in the conversation this came from.",
      bindings: { ticket: "RQ-4417", conversation: "thread-8821" },
    }));

    expect(woken.bindings).toEqual([
      ["conversation", "thread-8821"],
      ["ticket", "RQ-4417"],
    ]);
    // Not in the sentence: a referent read as prose is a referent nobody can
    // compare against anything.
    expect(woken.text).not.toContain("thread-8821");
  });

  test("gives a watch that delivers nowhere no referents to show", () => {
    expect(installedWatchDelivery(INSTALLED_WATCH).bindings).toEqual([]);
    expect(
      installedWatchDelivery(withDelivery({ kind: "omnesis-notify", title: "A delay" })).bindings,
    ).toEqual([]);
  });

  test("reads a watch stored under the old spelling of the notify kind", () => {
    // The stored DSL is served verbatim, so a watch written before the rename
    // still says `ios-push` on the wire. An unrecognised kind falls through to
    // "Delivers nowhere" — a confident false statement about a watch that
    // notifies on every firing, which is worse than a degraded one.
    const stored = installedWatchDelivery(withDelivery({
      kind: "ios-push",
      title: "Shipment delayed",
    }));

    expect(stored.delivers).toBe(true);
    expect(stored.text).toContain("Shipment delayed");
  });

  test("lists installed watches by what they were asked to catch", () => {
    const nodes = expandToHostNodes(InstalledWatchList({
      watches: [
        INSTALLED_WATCH_ENTRY,
        { ...INSTALLED_WATCH_ENTRY, id: "watch/other example", name: "quiet-week", firings: 1 },
      ],
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain(INSTALLED_WATCH_ENTRY.request);
    expect(text).toContain("3 firings");
    expect(text).toContain("1 firing");
    const hrefs = nodes.filter((node) => node.tag === "a").map((node) => node.props.href);
    expect(hrefs).toContain("/portal/watches/watch-shipment-example");
    // Watch ids are opaque strings from a store that never promised them to be
    // path-safe, so the row encodes rather than interpolates.
    expect(hrefs).toContain("/portal/watches/watch%2Fother%20example");
  });

  test("orders the running ones above the finished, under no headings at all", () => {
    const watches = [
      { ...INSTALLED_WATCH_ENTRY, id: "watch-done", status: "retired" },
      { ...INSTALLED_WATCH_ENTRY, id: "watch-held", status: "paused" },
      INSTALLED_WATCH_ENTRY,
      { ...INSTALLED_WATCH_ENTRY, id: "watch-second", status: "active" },
    ];
    expect(orderedInstalledWatches(watches).map((watch) => watch.id)).toEqual([
      INSTALLED_WATCH_ENTRY.id,
      "watch-second",
      "watch-held",
      "watch-done",
    ]);

    const nodes = expandToHostNodes(InstalledWatchList({ watches }));
    expect(nodes.filter((node) => node.tag === "h3")).toHaveLength(0);
    // Every row states its own status, so the list needs no heading to say it.
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("Active");
    expect(text).toContain("Paused");
    expect(text).toContain("Finished");
  });

  test("a status this build has not heard of sorts with the finished, not out of the list", () => {
    const unknown = { ...INSTALLED_WATCH_ENTRY, id: "watch-unknown", status: "hibernating" };
    const ordered = orderedInstalledWatches([unknown, INSTALLED_WATCH_ENTRY]);
    expect(ordered.map((watch) => watch.id)).toEqual([INSTALLED_WATCH_ENTRY.id, "watch-unknown"]);
  });

  test("a firing caught and a firing sent are folded into one row by their journal event", () => {
    const caught = { seq: 41, firedAt: "2026-05-04T09:15:00.000Z", documents: [] };
    const alsoCaught = { seq: 42, firedAt: "2026-05-05T09:15:00.000Z", documents: [] };
    const sent = { id: "sf-41", seq: 41, createdAt: 1_700_000_500_000, deliveryStatus: "delivered" };
    // Written before the runtime stamped a firing with its own identity, so
    // there is no sequence to join on and nothing caught to join it to.
    const unstamped = { id: "sf-old", createdAt: 1_600_000_000_000, deliveryStatus: "delivered" };

    const rows = mergeWatchFirings([alsoCaught, caught], [sent, unstamped]);
    expect(rows.map((row) => row.key)).toEqual(["seq:42", "seq:41", "sent:sf-old"]);
    expect(rows[0].sent).toBeNull();
    expect(rows[1].sent).toBe(sent);
    expect(rows[2].firing).toBeNull();
  });

  test("says where a watch would come from when there are none", () => {
    const nodes = expandToHostNodes(InstalledWatchList({ watches: [] }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("Ask your agent");
  });

  test("detail shows the request, the condition, and that it tells nobody", () => {
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [],
      onRemove: vi.fn(),
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain(INSTALLED_WATCH_ENTRY.request);
    expect(text).toContain("Delivers nowhere");
    expect(text).toContain("This watch has not fired.");
    expect(nodes.some((node) => node.tag === "button" && node.text === "Remove watch")).toBe(true);

    // How the watch is built is not what the page is for. The sentence a model
    // is asked to decide, the record's identifiers and the journal offset the
    // runtime resumes from are all in the definition, which is one disclosure
    // away.
    expect(text).not.toContain("the message says a shipment will arrive later than promised");
    expect(text).not.toContain("journal event 4210");
    expect(text).not.toContain("What it decides");
  });

  test("names the compile transcript beside the watch, not in a table below it", () => {
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: { ...INSTALLED_WATCH, compileRunId: "run-example" },
      firings: [],
      onRemove: vi.fn(),
    }));
    const link = nodes.find((node) => node.text?.trim() === "View compilation transcript");
    expect(link?.props.href).toBe("/portal/debug/cognition/runs/run-example");
    // On the header's own subtitle line, beside the name and the date added.
    expect(link).toBeTruthy();
    expect(nodes.find((node) => node.tag === "p" && node.text.includes("Added"))?.text)
      .toContain("View compilation transcript");
  });

  test("marks a firing an operator forced rather than passing it off as a catch", () => {
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [
        { seq: 41, firedAt: "2026-05-04T09:15:00.000Z", noticedAt: null, documents: [] },
        {
          seq: -1,
          firedAt: "2026-05-05T09:15:00.000Z",
          noticedAt: null,
          documents: [],
          forced: true,
        },
      ],
      onRemove: vi.fn(),
    }));
    const text = nodes.map((node) => node.text).join(" ");

    expect(text).toContain("By hand");
    // The count describes the list under it, and both rows are in the list.
    expect(nodes.some((node) => node.tag === "span" && node.text === "2")).toBe(true);
  });

  test("offers the definition without loading it, and shows it once asked", () => {
    // The definition is the largest field a watch has, and this screen is
    // about what the watch does. So the disclosure is offered closed and the
    // read only happens when somebody opens it — the same reasoning that keeps
    // the definition out of the polled listing.
    const closed = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [],
      onRemove: vi.fn(),
    }));
    expect(closed.some((node) => node.tag === "details")).toBe(true);
    const closedText = closed.map((node) => node.text).join(" ");
    expect(closedText).toContain("Definition");
    expect(closedText, "the definition was rendered before anyone asked").not.toContain(
      "source.document_event",
    );

    const dsl = JSON.stringify({ watch: { nodes: [{ type: "source.document_event" }] } }, null, 2);
    const open = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [],
      onRemove: vi.fn(),
      dsl,
    }));
    const openText = open.map((node) => node.text).join(" ");
    expect(openText).toContain("source.document_event");
    // Verbatim, not reformatted: the shape is how a definition is read.
    expect(open.some((node) => node.tag === "pre" && node.text === dsl)).toBe(true);
  });

  test("says why the definition could not be read, instead of showing nothing", () => {
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [],
      onRemove: vi.fn(),
      dslError: "The watch came back without its definition.",
    }));
    expect(nodes.map((node) => node.text).join(" ")).toContain(
      "The watch came back without its definition.",
    );
  });

  test("detail says why a held watch stopped rather than only that it is held", () => {
    // The runtime pauses a watch on its own — a node threw, or its ontology
    // moved — and the status alone leaves the operator with no idea which, or
    // whether resuming it would achieve anything.
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: { ...INSTALLED_WATCH, status: "paused", note: "held by an operator" },
      firings: [],
      onRemove: vi.fn(),
    }));
    const banner = nodes.find((node) => node.class.includes("privacy-banner warning"));
    expect(banner?.text).toContain("Paused: held by an operator");
  });

  test("a firing row names when the watch spoke, not when its subject was dated", () => {
    // A firing is stamped with the subject's time so a replay reaches the same
    // answers. Leading with that reads as a watch that fired months ago, so the
    // row leads with when the journal noticed and names the subject's date only
    // when the two genuinely differ.
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [
        {
          seq: 87,
          firedAt: "2026-03-01T12:00:00.000Z",
          noticedAt: "2026-05-06T08:30:00.000Z",
          payload: { docId: "doc-example" },
        },
        {
          seq: 91,
          firedAt: "2026-05-07T10:00:00.000Z",
          noticedAt: "2026-05-07T10:00:00.000Z",
          payload: { docId: "doc-other-example" },
        },
      ],
      onRemove: vi.fn(),
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("seq 87");
    expect(text).toContain("seq 91");
    // The subject's own time is a column of its own, filled only on the row
    // whose subject was dated somewhere else than when the watch noticed it.
    const about = nodes
      .filter((node) => node.class.includes("watch-firing-about"))
      .map((node) => node.text.trim());
    expect(about).toEqual([
      "—",
      new Date("2026-03-01T12:00:00.000Z").toLocaleString(),
    ]);
  });

  test("a firing links out to what the watch read to decide it", () => {
    // The ledger is read to answer "why did this fire?", and a title with no
    // link ends the trail one step short.
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [
        {
          seq: 91,
          firedAt: "2026-05-07T10:00:00.000Z",
          noticedAt: "2026-05-07T10:00:00.000Z",
          payload: {},
          documents: [
            {
              id: "doc-quote",
              title: "Your quote for the roof",
              sourceId: "gmail:jamie.lopez@example.com",
            },
            {
              id: "doc-attachment",
              title: "Schedule of works.pdf",
              sourceId: "gmail:jamie.lopez@example.com",
            },
          ],
        },
      ],
      onRemove: vi.fn(),
    }));

    const chips = nodes.filter((node) => node.tag === "a" && node.class.includes("doc-chip"));
    expect(chips.map((chip) => chip.props.href)).toEqual([
      "/portal/doc/doc-quote",
      "/portal/doc/doc-attachment",
    ]);
    expect(nodes.map((node) => node.text).join(" ")).toContain("Your quote for the roof");
  });

  test("a firing links out to the moment it happened on the watch's graph", () => {
    // The ledger says what the watch caught; it cannot say what it walked
    // through to decide so. A firing is addressed on the debug canvas by the
    // journal event it fired on, which is the one identifier both hold — and
    // the runtime journals its own timers with sequences counting down from
    // -1, so a deadline's firing has a negative one.
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [
        {
          seq: 91,
          firedAt: "2026-05-07T10:00:00.000Z",
          noticedAt: "2026-05-07T10:00:00.000Z",
          payload: {},
        },
        {
          seq: -4,
          firedAt: "2026-05-08T10:00:00.000Z",
          noticedAt: "2026-05-08T10:00:00.000Z",
          payload: {},
        },
      ],
      onRemove: vi.fn(),
    }));

    const links = nodes.filter(
      (node) => node.tag === "a" && node.class.includes("watch-firing-record"),
    );
    // Newest first, by when each fired rather than by sequence: the runtime
    // journals its own timers counting down from -1, so a deadline's firing
    // sorts by its instant like everything else.
    expect(links.map((link) => link.props.href)).toEqual([
      "/portal/debug/watch/watch-shipment-example/history/-4",
      "/portal/debug/watch/watch-shipment-example/history/91",
    ]);
  });

  test("shows no evidence block for a firing with nothing behind it", () => {
    // A watch that comes true on a clock or a deadline read nothing, and that
    // is the watch working. An empty block there reads as something missing.
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [
        {
          seq: 91,
          firedAt: "2026-05-07T10:00:00.000Z",
          noticedAt: "2026-05-07T10:00:00.000Z",
          payload: {},
          documents: [],
        },
      ],
      onRemove: vi.fn(),
    }));

    expect(nodes.some((node) => node.class.includes("watch-firing-evidence"))).toBe(false);
    expect(nodes.map((node) => node.text).join(" ")).toContain("seq 91");
  });

  test("reports a failed firing read rather than claiming the watch never fired", () => {
    const nodes = expandToHostNodes(InstalledWatchDetail({
      watch: INSTALLED_WATCH,
      firings: [],
      firingsError: "Firings are unavailable.",
      onRemove: vi.fn(),
    }));
    const text = nodes.map((node) => node.text).join(" ");
    expect(text).toContain("Firings are unavailable.");
    expect(text).not.toContain("This watch has not fired.");
  });

  test("resolves a watch id against the runtime before the subscription store", () => {
    // `/portal/watches/<id>` carries an opaque id and nothing that says which
    // store minted it. A watch the runtime owns has no subscription record at
    // all, so resolving the wrong way round renders "not found" for a watch
    // that plainly exists.
    vi.mocked(getWatchV2Watch).mockResolvedValueOnce({ watch: INSTALLED_WATCH });
    return expect(resolveWatchDetail(INSTALLED_WATCH.id)).resolves.toEqual({
      kind: "installed",
      watch: INSTALLED_WATCH,
    });
  });

  // Every address that used to open the second page now opens the watch that
  // page was about. The record knows which watch it authorised, so an old
  // bookmark, an approval notification and a firing row all land on the one
  // page for that watch rather than on a second description of it.
  test.each([
    ["the runtime has no such watch", () => Promise.reject(Object.assign(new Error("404"), { status: 404 }))],
    ["the routes are not mounted at all", () => Promise.reject(new Error("Not found"))],
    ["the answer is a shape this build cannot address", () => Promise.resolve({ watch: {} })],
  ])("sends a subscription id to the watch it authorised when %s", async (_label, answer) => {
    vi.mocked(getWatchV2Watch).mockImplementationOnce(answer);
    vi.mocked(getPrivacySubscription).mockResolvedValueOnce({
      subscription: { ...SUBSCRIPTION, watchId: INSTALLED_WATCH.id },
    });
    await expect(resolveWatchDetail("subscription-example")).resolves.toEqual({
      kind: "owned-by",
      watchId: INSTALLED_WATCH.id,
    });
  });

  // A record whose plan is not a watch has no page to send anyone to, and
  // guessing one would open a watch the reader never asked about.
  test("says so plainly when neither store claims the id", async () => {
    vi.mocked(getWatchV2Watch).mockRejectedValueOnce(
      Object.assign(new Error("404"), { status: 404 }),
    );
    vi.mocked(getPrivacySubscription).mockResolvedValueOnce({
      subscription: { ...SUBSCRIPTION, watchId: null },
    });
    await expect(resolveWatchDetail("subscription-example")).resolves.toEqual({ kind: "unknown" });
  });
});

/** The same watch, delivering somewhere. */
function withDelivery(delivery: unknown) {
  return {
    ...INSTALLED_WATCH,
    dsl: { watch: { ...INSTALLED_WATCH.dsl.watch, delivery } },
  };
}

describe("whether a watch is any good", () => {
  /** A row as the gateway sends it: the word and the asking come with it. */
  const withVerdict = (
    name: string,
    overrides: { because?: string; label?: string; actionable?: boolean } = {},
  ) => ({
    ...INSTALLED_WATCH_ENTRY,
    verdict: {
      name,
      because: overrides.because ?? "looked at 4,183 events",
      ...(overrides.label === undefined ? {} : { label: overrides.label }),
      ...(overrides.actionable === undefined ? {} : { actionable: overrides.actionable }),
    },
  });

  test("marks only the rows the gateway says there is something to do about", () => {
    // A badge on every row makes the badge mean nothing, and makes an unmarked
    // row read as unknown rather than as well.
    expect(watchVerdictMark(withVerdict("healthy", { label: "Working", actionable: false })))
      .toBeNull();
    expect(
      watchVerdictMark(withVerdict("never-matched", { label: "Never matched", actionable: true }))
        ?.label,
    ).toBe("Never matched");
  });

  test("marks a verdict this build has never heard of, because the gateway said to", () => {
    // The failure the field exists for, and it is silent: a page deciding from
    // a list of names it was written against renders no mark at all for a
    // verdict a newer gateway learned to raise.
    const mark = watchVerdictMark(
      withVerdict("arm-drifted", { label: "Arm has drifted", actionable: true }),
    );

    expect(mark?.label).toBe("Arm has drifted");
  });

  test("falls back to the bare name when the gateway sent no word for it", () => {
    // Still something an operator can act on; an empty mark is a row that says
    // a watch needs attention and will not say which.
    expect(watchVerdictMark(withVerdict("arm-drifted", { actionable: true }))?.label).toBe(
      "arm-drifted",
    );
  });

  test("marks nothing from a gateway that predates the field", () => {
    // Which is what its `healthy` and `resting` meant, and most of its rows.
    expect(watchVerdictMark(withVerdict("never-matched"))).toBeNull();
  });

  test("carries the numbers with the mark rather than recomposing them", () => {
    const mark = watchVerdictMark(
      withVerdict("never-matched", { because: "looked at 4,183 events", actionable: true }),
    );
    expect(mark?.because).toBe("looked at 4,183 events");
  });

  test("says nothing at all about a row from a build that sends no verdict", () => {
    // The list is polled by a phone and a page that update on their own
    // schedules; a row without the field must render as a row, not as a gap.
    expect(watchVerdictMark(INSTALLED_WATCH_ENTRY)).toBeNull();
    expect(watchVerdictSentence(INSTALLED_WATCH_ENTRY)).toBeNull();
  });

  test("spells the sentence the same way wherever it is read", () => {
    expect(
      watchVerdictSentence(
        withVerdict("silent-risk", { because: "has fired 12 times", label: "Reaching nobody" }),
      ),
    ).toBe("Reaching nobody — has fired 12 times");
  });
});
