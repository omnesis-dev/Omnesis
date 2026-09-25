// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Privacy's activity feed and its exchange detail page, rendered as units —
// mounted, with their effects and state running — rather than as expanded
// VNode trees. What is under test here
// is what only a real mount can show: which exchanges get pinned and which fall
// through to the feed, what an emptied detail page says, and whether the
// destructive overflow menu can be dismissed without taking its action.
//
// All fixture data is invented.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
  listPrivacyAuditEvents: vi.fn(),
  listPrivacyExchangeFeed: vi.fn(),
  listPrivacyExchanges: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  getPrivacyApproval,
  getPrivacyConversation,
  listPrivacyAuditEvents,
  listPrivacyExchangeFeed,
  listPrivacyExchanges,
} from "../api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate } from "../lib/router.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacyActivityPane } from "./audit/activity.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacyExchangeDetailRoute } from "./audit/exchange-detail.js";

const CONVERSATION_ID = "conversation-invented";

function sharedExchange(index: number) {
  return {
    taskId: `task-shared-${index}`,
    conversationId: CONVERSATION_ID,
    workflowId: "workflow-invented",
    externalAgent: { displayName: "Atlas", source: "token" },
    workflow: { name: "Calendar coordinator", purpose: "Find a suitable meeting time." },
    question: `Which afternoon is free in week ${index}?`,
    status: "released",
    outcome: "shared",
    createdAt: 1_700_000_000_000 + index,
    resolvedAt: 1_700_000_050_000 + index,
    sharedAt: 1_700_000_060_000 + index,
    sharedAnswer: "Thursday afternoon is free.",
    pendingCandidate: null,
    reductions: [],
    approval: null,
    userDecision: null,
    review: { fallbackCause: null, rationale: null, findings: [] },
  };
}

function pendingExchange(index: number) {
  return {
    ...sharedExchange(index),
    taskId: `task-pending-${index}`,
    status: "approval_required",
    outcome: "needs_review",
    sharedAt: null,
    resolvedAt: null,
    sharedAnswer: null,
    pendingCandidate: "Thursday at 15:00 is free.",
    approval: {
      id: `approval-${index}`,
      status: "pending",
      expiresAt: 1_700_003_600_000,
      resolvedAt: null,
    },
  };
}

function runningExchange(index: number) {
  return {
    ...sharedExchange(index),
    taskId: `task-running-${index}`,
    status: "running",
    outcome: "checking",
    resolvedAt: null,
    sharedAt: null,
    sharedAnswer: null,
    draftAnswer: null,
  };
}

describe("Privacy panes, mounted", () => {
  let host: HTMLElement;
  let doc: Document;
  let win: Window;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    doc = parsed.document as unknown as Document;
    win = parsed.window as unknown as Window;
    Object.assign(globalThis, { document: doc, window: win });
    host = doc.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    vi.unstubAllGlobals();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    vi.useRealTimers();
  });

  async function mountActivity(exchanges: unknown[]) {
    (listPrivacyExchangeFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      exchanges,
      nextCursor: null,
    });
    (getPrivacyApproval as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no detail"));
    await act(async () => {
      render(h(PrivacyActivityPane, {}), host);
    });
    await act(async () => {});
  }

  /**
   * One exchange's ledger, in the order the gateway returns it: the request,
   * the draft, a step that is nobody's landmark, the review, and the release.
   * All five instants fall on one day.
   */
  const auditEvents = (taskId: string) => [
    { id: "ev-1", taskId, kind: "external_request", createdAt: 1_700_000_000_000, display: { title: "Request received" } },
    { id: "ev-2", taskId, kind: "candidate_generated", createdAt: 1_700_000_010_000, display: { title: "Answer drafted", provider: "anthropic", model: "claude-sonnet-5" } },
    { id: "ev-3", taskId, kind: "agent_trace", createdAt: 1_700_000_012_000, display: { title: "Agent step", detail: "Searched the index." } },
    { id: "ev-4", taskId, kind: "privacy_review", createdAt: 1_700_000_020_000, display: { title: "Privacy review" } },
    { id: "ev-5", taskId, kind: "released", createdAt: 1_700_000_030_000, display: { title: "Answer released" } },
  ];

  async function mountDetail(exchanges: unknown[], taskId: string | null, events: unknown[] = []) {
    (getPrivacyConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: CONVERSATION_ID,
      workflowName: "Calendar coordinator",
      externalAgent: { displayName: "Atlas", source: "token" },
    });
    (listPrivacyExchanges as ReturnType<typeof vi.fn>).mockResolvedValue({ exchanges });
    (listPrivacyAuditEvents as ReturnType<typeof vi.fn>).mockResolvedValue({ events });
    await act(async () => {
      render(
        h(PrivacyExchangeDetailRoute, { conversationId: CONVERSATION_ID, taskId }),
        host,
      );
    });
    await act(async () => {});
  }

  const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

  test("a pending exchange is pinned as a review card and left out of the feed", async () => {
    await mountActivity([pendingExchange(1), sharedExchange(2)]);

    expect(host.querySelectorAll(".privacy-review-card")).toHaveLength(1);
    const rows = [...host.querySelectorAll(".privacy-feed-row")];
    expect(rows).toHaveLength(1);
    // The pinned exchange is not also listed below it.
    expect(rows[0]?.textContent).toContain("week 2");
    expect(text()).toContain("One answer is waiting for you");
  });

  test("pending exchanges past the pin cap stay visible as feed rows", async () => {
    // Six pending exchanges against a cap of five: the sixth must not vanish.
    const pending = [1, 2, 3, 4, 5, 6].map(pendingExchange);
    await mountActivity(pending);

    expect(host.querySelectorAll(".privacy-review-card")).toHaveLength(5);
    const rows = [...host.querySelectorAll(".privacy-feed-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("week 6");
    // It keeps the chip that says it still needs a decision.
    expect(rows[0]?.querySelector(".privacy-chip")?.textContent?.trim())
      .toBe("Needs your review");
  });

  test("the status filter narrows the feed and never hides what is waiting on you", async () => {
    const failed = {
      ...sharedExchange(9),
      taskId: "task-failed-9",
      status: "failed",
      outcome: "failed",
      sharedAt: null,
      sharedAnswer: null,
    };
    await mountActivity([pendingExchange(1), sharedExchange(2), failed]);

    const filter = host.querySelector(".privacy-feed-filter") as HTMLElement;
    const buttons = [...filter.querySelectorAll("button")] as HTMLButtonElement[];
    expect(buttons.map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim()))
      .toEqual(["All 2", "Shared 1", "Not shared 0", "Failed 1", "Waiting 0"]);

    await act(async () => {
      buttons[3]!.click();
    });

    const rows = [...host.querySelectorAll(".privacy-feed-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("week 9");
    // The pinned review is not part of the feed, so narrowing it leaves the
    // one thing that needs a decision on screen.
    expect(host.querySelectorAll(".privacy-review-card")).toHaveLength(1);
    expect(buttons[3]?.getAttribute("aria-pressed")).toBe("true");
  });

  test("a filter that matches nothing says the list is narrowed, not that nothing was shared", async () => {
    await mountActivity([sharedExchange(1)]);

    const buttons = [...host.querySelectorAll(".privacy-feed-filter button")] as HTMLButtonElement[];
    await act(async () => {
      buttons[3]!.click();
    });

    expect(host.querySelectorAll(".privacy-feed-row")).toHaveLength(0);
    expect(text()).toContain("No matching activity");
    expect(text()).not.toContain("Nothing has left this machine");
  });

  test("an empty feed says nothing has left rather than rendering nothing", async () => {
    await mountActivity([]);
    expect(text()).toContain("Nothing has left this machine");
  });

  test("a reviewed row names its policy in text, and rows without one stay as they were", async () => {
    const reviewed = {
      ...sharedExchange(1),
      review: {
        fallbackCause: null,
        rationale: null,
        findings: [],
        policyFamilyId: "family-one",
        policyFamilyName: "Fictional research policy",
      },
    };
    await mountActivity([reviewed, sharedExchange(2)]);

    const rows = [...host.querySelectorAll(".privacy-feed-row")];
    expect(rows).toHaveLength(2);
    const line = rows[0]?.querySelector(".privacy-reviewed-under");
    expect(line?.textContent?.replace(/\s+/g, " ").trim())
      .toBe("Reviewed under Fictional research policy");
    // The row is the link to the exchange; nothing inside it is another link.
    expect(rows[0]?.querySelector("a")).toBeNull();
    expect(rows[1]?.querySelector(".privacy-reviewed-under")).toBeNull();
  });

  test("the decision card links to the policy and the link stays in the portal", async () => {
    const reviewed = {
      ...sharedExchange(1),
      review: {
        fallbackCause: null,
        rationale: null,
        findings: [],
        policyFamilyId: "family-one",
        policyFamilyName: "Fictional research policy",
      },
    };
    await mountDetail([reviewed], reviewed.taskId);

    const link = host.querySelector(".privacy-decision-sentence a") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/portal/settings/policies/family-one");
    expect(link.textContent).toBe("Fictional research policy");
    await act(async () => { link.click(); });
    expect(navigate).toHaveBeenCalledWith("/portal/settings/policies/family-one");

    // The same exchange without a family on its record: no line, no link.
    render(null, host);
    await mountDetail([sharedExchange(1)], "task-shared-1");
    expect(host.querySelector(".privacy-decision-sentence")).toBeTruthy();
    expect(host.querySelector(".privacy-decision-sentence a")).toBeNull();
    expect(text()).not.toContain("Reviewed under");
  });

  test("a detail page whose exchange is gone says so", async () => {
    await mountDetail([sharedExchange(1)], "task-that-is-not-here");
    expect(text()).toContain("This exchange is no longer available");
    expect(host.querySelectorAll(".privacy-spine")).toHaveLength(0);
  });

  test("a principal-owned exchange identifies its connection separately", async () => {
    const exchange = {
      ...sharedExchange(1),
      externalAgent: {
        displayName: "Mosaic assistant",
        narrativeName: "Mosaic assistant",
        connectionName: "Mosaic on desktop",
        source: "principal",
      },
    };
    await mountDetail([exchange], exchange.taskId);

    const facts = new Map(
      [...host.querySelectorAll(".privacy-card-facts > div")].map((row) => [
        row.querySelector("dt")?.textContent?.trim(),
        row.querySelector("dd")?.textContent?.trim(),
      ]),
    );
    expect(facts.get("Principal")).toBe("Mosaic assistant");
    expect(facts.get("Connection")).toBe("Mosaic on desktop");
  });

  test("an unrecognised outcome titles the page by its subject, not by a guess", async () => {
    const exchange = { ...sharedExchange(1), outcome: "teleported" };
    await mountDetail([exchange], exchange.taskId);

    expect(host.querySelector("h1")?.textContent?.trim()).toBe("Calendar coordinator");
    expect(text()).not.toContain("Checking");
    expect(text()).toContain("cannot read");
  });

  test("a running exchange refreshes until its draft is recorded", async () => {
    vi.useFakeTimers();
    const running = runningExchange(1);
    const drafted = { ...running, draftAnswer: "A fictional draft answer." };
    const settled = { ...drafted, status: "denied", outcome: "not_shared", resolvedAt: 1_700_000_070_000 };
    (listPrivacyExchanges as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ exchanges: [running] })
      .mockResolvedValueOnce({ exchanges: [drafted] })
      .mockResolvedValueOnce({ exchanges: [settled] });
    (getPrivacyConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: CONVERSATION_ID,
      workflowName: "Calendar coordinator",
      externalAgent: { displayName: "Atlas", source: "token" },
    });
    (listPrivacyAuditEvents as ReturnType<typeof vi.fn>).mockResolvedValue({ events: [] });

    await act(async () => {
      render(
        h(PrivacyExchangeDetailRoute, {
          conversationId: CONVERSATION_ID,
          taskId: running.taskId,
        }),
        host,
      );
    });
    await act(async () => {});
    expect(text()).toContain("Omnesis is drafting an answer");
    expect(text()).toContain("No draft has been recorded yet");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(listPrivacyExchanges).toHaveBeenCalledTimes(2);
    expect(text()).toContain("A fictional draft answer.");
    expect(text()).toContain("Omnesis drafted an answer");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(listPrivacyExchanges).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(listPrivacyExchanges).toHaveBeenCalledTimes(3);
  });

  test("the overflow menu closes on Escape and returns focus to its toggle", async () => {
    await mountDetail([sharedExchange(1)], "task-shared-1");
    const toggle = host.querySelector(".privacy-overflow-toggle") as HTMLElement;
    expect(toggle).toBeTruthy();

    await act(async () => { toggle.click(); });
    expect(host.querySelector(".privacy-overflow-menu")).toBeTruthy();

    const focus = vi.fn();
    (toggle as unknown as { focus: () => void }).focus = focus;
    const escape = new win.Event("keydown", { bubbles: true }) as Event & { key: string };
    escape.key = "Escape";
    await act(async () => { doc.dispatchEvent(escape); });

    expect(host.querySelector(".privacy-overflow-menu")).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
    // Escape dismisses; it never takes the destructive action behind the menu.
    expect(text()).not.toContain("This removes the trusted audit transcript");
  });

  test("the overflow menu closes on a click outside it", async () => {
    await mountDetail([sharedExchange(1)], "task-shared-1");
    const toggle = host.querySelector(".privacy-overflow-toggle") as HTMLElement;

    await act(async () => { toggle.click(); });
    expect(host.querySelector(".privacy-overflow-menu")).toBeTruthy();

    await act(async () => {
      doc.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector(".privacy-overflow-menu")).toBeNull();
  });

  test("a click inside the menu leaves it open", async () => {
    await mountDetail([sharedExchange(1)], "task-shared-1");
    const toggle = host.querySelector(".privacy-overflow-toggle") as HTMLElement;
    await act(async () => { toggle.click(); });

    const item = host.querySelector(".privacy-overflow-item") as HTMLElement;
    await act(async () => {
      item.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector(".privacy-overflow-menu")).toBeTruthy();
  });

  describe("the recorded steps", () => {
    test("are on the spine on arrival, with nothing to open", async () => {
      await mountDetail([sharedExchange(1)], "task-shared-1", auditEvents("task-shared-1"));

      expect(host.querySelector(".privacy-ledger-step")).toBeTruthy();
      // Every step sits inside a zone, so each one reads as inside or outside
      // the machine rather than as a footnote with no side.
      for (const step of host.querySelectorAll(".privacy-ledger-step")) {
        expect(step.closest(".privacy-zone")).toBeTruthy();
      }
    });

    test("each carry an instant in the gutter", async () => {
      await mountDetail([sharedExchange(1)], "task-shared-1", auditEvents("task-shared-1"));

      const moments = [...host.querySelectorAll(".privacy-moment")];
      expect(moments.length).toBeGreaterThan(1);
      for (const moment of moments) {
        expect(moment.querySelector(".privacy-moment-at")).toBeTruthy();
      }
    });

    test("print the day once, on the moment that opens it", async () => {
      await mountDetail([sharedExchange(1)], "task-shared-1", auditEvents("task-shared-1"));

      // Every step of this exchange happens on one day, so exactly one moment
      // dates itself and the rest carry the time alone.
      expect(host.querySelectorAll(".privacy-moment-day").length).toBe(1);
    });
  });
});
