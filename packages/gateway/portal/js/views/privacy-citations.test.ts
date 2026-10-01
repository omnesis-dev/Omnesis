// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

// These pure VNode walkers exercise privacy narrative structure, not mounted hooks.
// Copy controls and Markdown safety are covered by mounted and browser suites.
vi.mock("../components/agent/assistant-markdown.js", async () => {
  const { h } = await import("preact");
  return {
    AssistantMarkdown: ({ text, className }: { text: string; className?: string }) =>
      h("div", { class: className ?? "agent-part-text", dangerouslySetInnerHTML: { __html: text } }),
  };
});

vi.mock("../lib/markdown.js", () => ({
  renderMarkdown: (value: string) => value,
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
import { PrivacyReviewCard, pinnedApprovalRecord } from "./audit/activity.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacyCitationList, privacyCitationRows, sameCitations } from "./audit/citations.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacyExchangeSpine } from "./audit/exchange-detail.js";

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
    text: collectText(vnode.props?.children),
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

function citationRows(nodes: any[]): any[] {
  return nodes.filter((node) => node.tag === "li" && String(node.class).startsWith("privacy-citation"));
}

function citationBlocks(nodes: any[]): string[] {
  return nodes
    .filter((node) => node.class === "privacy-citations-heading")
    .map((node) => node.text);
}

const BUDGET_EMAIL = {
  documentId: "doc-budget",
  sourceType: "gmail",
  title: "Q4 budget review",
  timestamp: "2026-03-14T10:00:00.000Z",
  sourceUrl: "https://mail.example.com/thread/budget-q4",
  appUrl: "examplemail://thread/budget-q4",
};

const PLANNING_CHAT = {
  documentId: "doc-chat",
  sourceType: "whatsapp",
  title: "Offsite planning",
  timestamp: "2026-03-15T08:30:00.000Z",
  appUrl: "whatsapp://send?phone=15550100123",
};

const UNTITLED_NOTE = {
  documentId: "doc-note",
  sourceType: "drive",
  sourceUrl: "https://drive.example.org/file/42",
};

const EXCHANGE = {
  taskId: "task-citations",
  conversationId: "conversation-citations",
  workflowId: "workflow-citations",
  externalAgent: { displayName: "Atlas", source: "token" },
  workflow: { name: "Finance helper", purpose: "Summarize the budget thread." },
  question: "What did the Q4 budget review conclude?",
  status: "released_with_reductions",
  outcome: "shared_with_reductions",
  createdAt: 1_700_000_000_000,
  resolvedAt: 1_700_000_050_000,
  sharedAt: 1_700_000_060_000,
  sharedAnswer: "The review kept spending flat.",
  draftAnswer: "The review kept spending flat, as agreed in the planning chat.",
  pendingCandidate: null,
  sharedCitations: [] as unknown[],
  draftCitations: [] as unknown[],
  pendingCitations: [] as unknown[],
  reductions: ["Removed the planning chat."],
  approval: null,
  userDecision: null,
  review: { fallbackCause: null, rationale: "The chat is private.", findings: [] },
  failure: null,
};

const PENDING = {
  ...EXCHANGE,
  status: "approval_required",
  outcome: "needs_review",
  sharedAt: null,
  resolvedAt: null,
  sharedAnswer: null,
  pendingCandidate: "The review kept spending flat.",
  reductions: [],
  approval: { id: "approval-citations", status: "pending", expiresAt: 1_700_003_600_000, resolvedAt: null },
};

const handlers = { busy: null, error: null, onApprove: vi.fn(), onDeny: vi.fn() };

describe("a citation list", () => {
  test("renders nothing when there are no citations", () => {
    expect(PrivacyCitationList({ citations: [], heading: "Citations shared" })).toBeNull();
    expect(PrivacyCitationList({ citations: undefined, heading: "Citations shared" })).toBeNull();
  });

  test("prints title, source and date on one line, then every link in full", () => {
    const nodes = expandToHostNodes(
      PrivacyCitationList({ citations: [BUDGET_EMAIL], heading: "Citations shared" }),
    );
    const [row] = citationRows(nodes);
    expect(row.text).toContain("Q4 budget review");
    expect(row.text).toContain("Gmail");
    expect(row.text).toContain("2026");
    expect(row.text).toContain("Link");
    expect(row.text).toContain("App link");
    expect(row.text).toContain("https://mail.example.com/thread/budget-q4");
    expect(row.text).toContain("examplemail://thread/budget-q4");
  });

  test("only a web link is an anchor, and it opens without opener or referrer", () => {
    const nodes = expandToHostNodes(
      PrivacyCitationList({ citations: [BUDGET_EMAIL, PLANNING_CHAT], heading: "Citations shared" }),
    );
    const anchors = nodes.filter((node) => node.tag === "a");
    expect(anchors.map((node) => node.props.href)).toEqual(["https://mail.example.com/thread/budget-q4"]);
    expect(anchors[0].props.target).toBe("_blank");
    expect(anchors[0].props.rel).toBe("noopener noreferrer");
    // The app links are shown, as text.
    const texts = nodes.filter((node) => node.tag === "span" && node.class === "privacy-citation-url");
    expect(texts.map((node) => node.text)).toEqual([
      "examplemail://thread/budget-q4",
      "whatsapp://send?phone=15550100123",
    ]);
  });

  test("an untitled citation says so, and an absent link prints no row", () => {
    const nodes = expandToHostNodes(
      PrivacyCitationList({ citations: [UNTITLED_NOTE], heading: "Citations shared" }),
    );
    const [row] = citationRows(nodes);
    expect(row.text).toContain("Untitled");
    expect(row.text).toContain("Drive");
    expect(row.text).not.toContain("App link");
  });

  test("against the draft, marks a dropped citation and a dropped field as withheld", () => {
    const shared = [{ ...BUDGET_EMAIL, appUrl: undefined }];
    const rows = privacyCitationRows(shared, [BUDGET_EMAIL, PLANNING_CHAT]);
    expect(rows.map((row: any) => [row.citation.documentId, row.removed, row.withheld])).toEqual([
      ["doc-budget", false, ["appUrl"]],
      ["doc-chat", true, []],
    ]);

    const nodes = expandToHostNodes(PrivacyCitationList({
      citations: shared,
      baseline: [BUDGET_EMAIL, PLANNING_CHAT],
      heading: "Citations shared",
    }));
    // Nothing withheld is clickable, and the withheld app link is struck through.
    expect(nodes.filter((node) => node.tag === "a").map((node) => node.props.href))
      .toEqual(["https://mail.example.com/thread/budget-q4"]);
    const struck = nodes.filter((node) => node.tag === "del").map((node) => node.text);
    expect(struck).toContain("examplemail://thread/budget-q4");
    expect(struck).toContain("whatsapp://send?phone=15550100123");
    const [kept, dropped] = citationRows(nodes);
    expect(kept.class).toBe("privacy-citation");
    expect(kept.text).toContain("withheld");
    expect(dropped.class).toContain("privacy-citation--withheld");
    expect(dropped.text).toContain("Withheld");
    expect(allText(nodes)).toContain("did not leave this machine");
  });

  test("without a baseline nothing is marked withheld", () => {
    const nodes = expandToHostNodes(
      PrivacyCitationList({ citations: [BUDGET_EMAIL], heading: "Citations shared" }),
    );
    expect(allText(nodes)).not.toContain("withheld");
    expect(nodes.some((node) => node.tag === "del")).toBe(false);
  });
});

describe("sameCitations", () => {
  test("is true only for the same documents with the same fields in the same order", () => {
    expect(sameCitations([BUDGET_EMAIL, PLANNING_CHAT], [BUDGET_EMAIL, PLANNING_CHAT])).toBe(true);
    expect(sameCitations([PLANNING_CHAT, BUDGET_EMAIL], [BUDGET_EMAIL, PLANNING_CHAT])).toBe(false);
    expect(sameCitations([BUDGET_EMAIL], [BUDGET_EMAIL, PLANNING_CHAT])).toBe(false);
    const { sourceUrl: _withheld, ...withoutLink } = BUDGET_EMAIL;
    expect(sameCitations([withoutLink], [BUDGET_EMAIL])).toBe(false);
  });
});

describe("citations on the exchange spine", () => {
  test("an exchange without citations shows no citation block", () => {
    const nodes = expandToHostNodes(PrivacyExchangeSpine({ exchange: EXCHANGE, events: [] }));
    expect(citationBlocks(nodes)).toEqual([]);
  });

  test("citations shared exactly as drafted are not listed a second time", () => {
    const nodes = expandToHostNodes(PrivacyExchangeSpine({
      exchange: {
        ...EXCHANGE,
        draftCitations: [BUDGET_EMAIL, PLANNING_CHAT],
        sharedCitations: [BUDGET_EMAIL, PLANNING_CHAT],
      },
      events: [],
    }));
    expect(citationBlocks(nodes)).toEqual(["Cited in this draft"]);
  });

  test("with no recorded draft, the shared citations are the only list", () => {
    const nodes = expandToHostNodes(PrivacyExchangeSpine({
      exchange: { ...EXCHANGE, draftAnswer: null, sharedCitations: [BUDGET_EMAIL] },
      events: [],
    }));
    expect(citationBlocks(nodes)).toEqual(["Citations shared"]);
  });

  test("the draft lists its citations and the release lists what left, with what was withheld", () => {
    const nodes = expandToHostNodes(PrivacyExchangeSpine({
      exchange: {
        ...EXCHANGE,
        draftCitations: [BUDGET_EMAIL, PLANNING_CHAT],
        sharedCitations: [BUDGET_EMAIL],
      },
      events: [],
    }));
    expect(citationBlocks(nodes)).toEqual(["Cited in this draft", "Citations shared"]);
    const rows = citationRows(nodes);
    // Draft: two plain rows. Shared: the kept email, then the withheld chat.
    expect(rows).toHaveLength(4);
    expect(rows[3].class).toContain("privacy-citation--withheld");
    expect(rows[3].text).toContain("Offsite planning");
  });

  test("a pending approval shows the links it would release beside the decision", () => {
    const nodes = expandToHostNodes(PrivacyExchangeSpine({
      exchange: {
        ...PENDING,
        draftCitations: [BUDGET_EMAIL],
        pendingCitations: [BUDGET_EMAIL],
      },
      events: [],
      ...handlers,
    }));
    expect(citationBlocks(nodes)).toEqual(["Cited in this draft", "Citations that would be shared"]);
    expect(allText(nodes)).toContain("Share once releases these documents");
    // Nothing is shared yet, so there is no shared block.
    expect(allText(nodes)).not.toContain("Citations shared");
  });
});

describe("citations on the pinned review card", () => {
  test("the feed record carries the held citations into the card", () => {
    const record = pinnedApprovalRecord({ ...PENDING, pendingCitations: [PLANNING_CHAT] });
    expect(record.candidateCitations).toEqual([PLANNING_CHAT]);
    const nodes = expandToHostNodes(PrivacyReviewCard({ approval: record, ...handlers }));
    expect(citationBlocks(nodes)).toEqual(["Citations that would be shared"]);
    expect(allText(nodes)).toContain("whatsapp://send?phone=15550100123");
    expect(nodes.some((node) => node.tag === "a" && String(node.props.href).startsWith("whatsapp:")))
      .toBe(false);
  });

  test("the card marks what the check withheld from the recorded draft", () => {
    const record = pinnedApprovalRecord({
      ...PENDING,
      draftCitations: [BUDGET_EMAIL, PLANNING_CHAT],
      pendingCitations: [BUDGET_EMAIL],
    });
    expect(record.candidateCitationBaseline).toEqual([BUDGET_EMAIL, PLANNING_CHAT]);
    const nodes = expandToHostNodes(PrivacyReviewCard({ approval: record, ...handlers }));
    expect(allText(nodes)).toContain("Withheld");
    expect(allText(nodes)).toContain("Offsite planning");
  });

  test("a card whose draft was not recorded compares nothing", () => {
    const record = pinnedApprovalRecord({
      ...PENDING,
      draftAnswer: null,
      pendingCitations: [BUDGET_EMAIL],
    });
    expect(record.candidateCitationBaseline).toBeNull();
  });

  test("a card without citations shows no citation block", () => {
    const record = pinnedApprovalRecord(PENDING);
    expect(record.candidateCitations).toEqual([]);
    const nodes = expandToHostNodes(PrivacyReviewCard({ approval: record, ...handlers }));
    expect(citationBlocks(nodes)).toEqual([]);
  });
});
