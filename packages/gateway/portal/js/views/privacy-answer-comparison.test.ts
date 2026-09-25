// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

vi.mock("../lib/markdown.js", () => ({
  renderMarkdown: (value: string) => value,
}));

vi.mock("../api.js", () => ({
  approvePrivacyApproval: vi.fn(),
  deletePrivacyConversation: vi.fn(),
  denyPrivacyApproval: vi.fn(),
  getPrivacyConversation: vi.fn(),
  listPrivacyAuditEvents: vi.fn(),
  listPrivacyExchanges: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  PrivacyAnswerComparison,
  answerDiffLines,
} from "./audit/answer-comparison.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { PrivacyLedgerStep } from "./audit/exchange-detail.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface HostNode {
  tag: string;
  class: string;
  text: string;
  props: any;
}

function expandToHostNodes(vnode: any, out: HostNode[] = []): HostNode[] {
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

function allText(nodes: HostNode[]): string {
  return nodes.map((node) => node.text).join(" ");
}

function nodesOfTag(nodes: HostNode[], tag: string): HostNode[] {
  return nodes.filter((node) => node.tag === tag);
}

function lineNodes(nodes: HostNode[]): HostNode[] {
  return nodes.filter((node) => String(node.class).startsWith("privacy-diff-line "));
}

/** The visible text of one rendered line, markers and hidden labels excluded. */
function lineText(nodes: HostNode[], index: number): string {
  const text = nodes.filter((node) => node.class === "privacy-diff-text")[index];
  return String(text?.text ?? "")
    .replace("In the draft, not released: ", "")
    .replace("In the released answer: ", "");
}

const RELEASED_EVENT = {
  id: "event-released",
  taskId: "task-comparison-example",
  kind: "released",
  createdAt: 1_700_000_050_000,
  display: {
    title: "Released with reductions",
    text: "Rehearsal is booked at Stellar Sound on Thursday.",
    detail: null,
    status: { code: "reduced", label: "Details removed" },
    provider: null,
    model: null,
    confidence: null,
    approvalId: null,
    releaseId: "release-example",
    digest: "e".repeat(64),
    reductions: ["Removed the exact time."],
  },
  answerComparison: null as unknown,
  payloadAvailable: true,
  payloadDigest: "f".repeat(64),
  payloadBytes: 120,
  originalPayloadBytes: 120,
  payloadTruncated: false,
};

const DIFF_COMPARISON = {
  kind: "diff",
  lines: [
    { op: "equal", text: "Rehearsal is booked.", spans: null },
    {
      op: "removed",
      text: "Studio Northstar holds the room at 15:00.",
      spans: [
        { op: "equal", text: "Studio Northstar holds the room " },
        { op: "removed", text: "at 15:00." },
      ],
    },
    {
      op: "added",
      text: "Studio Northstar holds the room that afternoon.",
      spans: [
        { op: "equal", text: "Studio Northstar holds the room " },
        { op: "added", text: "that afternoon." },
      ],
    },
    { op: "removed", text: "Reach Maya Reeves on +1 (555) 010-0142.", spans: null },
  ],
};

describe("the released-answer comparison", () => {
  test("an identical release says so once and never reprints the answer", () => {
    const nodes = expandToHostNodes(
      PrivacyAnswerComparison({ comparison: { kind: "identical" } }),
    );
    expect(nodes.map((node) => node.class)).toEqual(["privacy-diff-note"]);
    expect(allText(nodes)).toBe(
      "The released answer is the drafted answer, byte for byte,"
      + " so it is not printed again here.",
    );
    expect(nodesOfTag(nodes, "ins")).toHaveLength(0);
    expect(nodesOfTag(nodes, "del")).toHaveLength(0);
  });

  test("a diff draws one marked line per line, in the order it was given", () => {
    const nodes = expandToHostNodes(PrivacyAnswerComparison({ comparison: DIFF_COMPARISON }));
    const lines = lineNodes(nodes);
    expect(lines.map((line) => line.class)).toEqual([
      "privacy-diff-line privacy-diff-line--equal",
      "privacy-diff-line privacy-diff-line--removed",
      "privacy-diff-line privacy-diff-line--added",
      "privacy-diff-line privacy-diff-line--removed",
    ]);
    // The marker is a channel of its own: it survives greyscale, and it is what
    // the legend above the block names.
    expect(nodes.filter((node) => node.class === "privacy-diff-marker").map((node) => node.text))
      .toEqual(["", "−", "+", "−"]);
    expect(allText(nodes)).toContain(
      "− was in the draft and did not leave this machine. + is in the released answer.",
    );
    // The list is height-capped, so the caption states how long it really is.
    expect(nodes.find((node) => node.class === "privacy-diff-count")?.text).toBe("4 lines");
    expect(
      expandToHostNodes(
        PrivacyAnswerComparison({
          comparison: { kind: "diff", lines: [DIFF_COMPARISON.lines[1]] },
        }),
      ).find((node) => node.class === "privacy-diff-count")?.text,
    ).toBe("1 line");
  });

  test("spans concatenate back to the line they came from", () => {
    const nodes = expandToHostNodes(PrivacyAnswerComparison({ comparison: DIFF_COMPARISON }));
    for (const [index, line] of DIFF_COMPARISON.lines.entries()) {
      expect(lineText(nodes, index)).toBe(line.text);
    }
  });

  test("removed and added text are marked up, not merely coloured", () => {
    const nodes = expandToHostNodes(PrivacyAnswerComparison({ comparison: DIFF_COMPARISON }));
    expect(nodesOfTag(nodes, "del").map((node) => node.text)).toEqual([
      "at 15:00.",
      "Reach Maya Reeves on +1 (555) 010-0142.",
    ]);
    expect(nodesOfTag(nodes, "ins").map((node) => node.text)).toEqual(["that afternoon."]);
    // An unchanged line is neither, so a reader is not told something changed.
    expect(lineText(nodes, 0)).toBe("Rehearsal is booked.");
  });

  test("each changed line announces its side to a reader who cannot see the marker", () => {
    const nodes = expandToHostNodes(PrivacyAnswerComparison({ comparison: DIFF_COMPARISON }));
    expect(nodes.filter((node) => node.class === "sr-only").map((node) => node.text)).toEqual([
      "In the draft, not released: ",
      "In the released answer: ",
      "In the draft, not released: ",
    ]);
    const list = nodesOfTag(nodes, "ol")[0];
    expect(list?.props["aria-label"]).toBe(
      "The drafted answer compared with the released answer",
    );
  });

  test("a whitespace-only reduction is still a marked run", () => {
    const nodes = expandToHostNodes(
      PrivacyAnswerComparison({
        comparison: {
          kind: "diff",
          lines: [
            {
              op: "removed",
              text: "Doors    open.",
              spans: [
                { op: "equal", text: "Doors" },
                { op: "removed", text: "   " },
                { op: "equal", text: " open." },
              ],
            },
          ],
        },
      }),
    );
    expect(nodesOfTag(nodes, "del").map((node) => node.text)).toEqual(["   "]);
    expect(lineText(nodes, 0)).toBe("Doors    open.");
  });

  test("no_diff explains the absent comparison without judging either text", () => {
    const dissimilar = allText(
      expandToHostNodes(
        PrivacyAnswerComparison({ comparison: { kind: "no_diff", reason: "dissimilar" } }),
      ),
    ).replace(/\s+/g, " ").trim();
    expect(dissimilar).toBe(
      "No line-by-line comparison is drawn for this release."
      + " The released answer is printed in this step; the draft it came from is the"
      + " candidate step above."
      + " Omnesis draws one only when the two texts are close enough for the lines to"
      + " describe an edit, and this pair was not.",
    );

    const tooLarge = allText(
      expandToHostNodes(
        PrivacyAnswerComparison({ comparison: { kind: "no_diff", reason: "too_large" } }),
      ),
    ).replace(/\s+/g, " ").trim();
    expect(tooLarge).toContain("The pair is longer than Omnesis will compare.");

    // A reason this build does not know still gets the sentence that is true.
    const unknownReason = allText(
      expandToHostNodes(
        PrivacyAnswerComparison({ comparison: { kind: "no_diff", reason: "rewritten" } }),
      ),
    ).replace(/\s+/g, " ").trim();
    expect(unknownReason).toBe(
      "No line-by-line comparison is drawn for this release."
      + " The released answer is printed in this step; the draft it came from is the"
      + " candidate step above.",
    );
  });

  test("an absent or unreadable comparison renders nothing rather than throwing", () => {
    expect(PrivacyAnswerComparison({ comparison: null })).toBeNull();
    expect(PrivacyAnswerComparison({ comparison: undefined })).toBeNull();
    expect(PrivacyAnswerComparison({})).toBeNull();
    // A gateway ahead of this portal, and malformed shapes of the kinds it knows.
    expect(PrivacyAnswerComparison({ comparison: { kind: "summarized" } })).toBeNull();
    expect(PrivacyAnswerComparison({ comparison: { kind: "diff" } })).toBeNull();
    expect(PrivacyAnswerComparison({ comparison: { kind: "diff", lines: [] } })).toBeNull();
    expect(PrivacyAnswerComparison({ comparison: { kind: "diff", lines: "two" } })).toBeNull();
  });

  test("only a drawable diff counts as one for the caller deciding what to print", () => {
    expect(answerDiffLines(DIFF_COMPARISON)).toHaveLength(4);
    expect(answerDiffLines({ kind: "identical" })).toBeNull();
    expect(answerDiffLines({ kind: "no_diff", reason: "too_large" })).toBeNull();
    expect(answerDiffLines({ kind: "diff", lines: [] })).toBeNull();
    expect(answerDiffLines(null)).toBeNull();
  });

  test("a line whose op this build cannot read keeps its text and claims nothing", () => {
    const nodes = expandToHostNodes(
      PrivacyAnswerComparison({
        comparison: { kind: "diff", lines: [{ op: "moved", text: "Doors open.", spans: null }] },
      }),
    );
    expect(lineNodes(nodes).map((node) => node.class))
      .toEqual(["privacy-diff-line privacy-diff-line--equal"]);
    expect(lineText(nodes, 0)).toBe("Doors open.");
    expect(nodesOfTag(nodes, "del")).toHaveLength(0);
    expect(nodesOfTag(nodes, "ins")).toHaveLength(0);
  });
});

describe("the release step that carries a comparison", () => {
  test("an identical release drops the body the gateway already withheld", () => {
    const nodes = expandToHostNodes(
      PrivacyLedgerStep({
        event: {
          ...RELEASED_EVENT,
          display: { ...RELEASED_EVENT.display, text: null, reductions: [] },
          answerComparison: { kind: "identical" },
        },
      }),
    );
    const text = allText(nodes);
    expect(text).toContain("Released with reductions");
    expect(text).toContain("byte for byte");
    expect(text).not.toContain("Stellar Sound");
  });

  test("a diff replaces the step's bounded preview of the same answer", () => {
    const nodes = expandToHostNodes(
      PrivacyLedgerStep({ event: { ...RELEASED_EVENT, answerComparison: DIFF_COMPARISON } }),
    );
    const text = allText(nodes);
    expect(lineNodes(nodes)).toHaveLength(4);
    expect(text).not.toContain(RELEASED_EVENT.display.text);
    // The reviewer's own account of what it removed still stands beside it.
    expect(text).toContain("Removed the exact time.");
  });

  test("no_diff keeps the released text and adds only the explanation", () => {
    const nodes = expandToHostNodes(
      PrivacyLedgerStep({
        event: {
          ...RELEASED_EVENT,
          answerComparison: { kind: "no_diff", reason: "dissimilar" },
        },
      }),
    );
    const text = allText(nodes);
    expect(text).toContain(RELEASED_EVENT.display.text);
    expect(text).toContain("No line-by-line comparison is drawn for this release.");
    expect(lineNodes(nodes)).toHaveLength(0);
  });

  test("a step with no comparison is unchanged", () => {
    const nodes = expandToHostNodes(PrivacyLedgerStep({ event: RELEASED_EVENT }));
    expect(allText(nodes)).toContain(RELEASED_EVENT.display.text);
    expect(nodes.some((node) => String(node.class).startsWith("privacy-diff"))).toBe(false);
  });
});

/** The `<p>` elements a ledger step renders, in order, with their classes. */
function stepParagraphs(event: Record<string, unknown>): { class: string; text: string }[] {
  return expandToHostNodes(PrivacyLedgerStep({ event }))
    .filter((node) => node.tag === "p")
    .map((node) => ({ class: String(node.class ?? ""), text: node.text.trim() }));
}

describe("what the record draws as quoted", () => {
  test("the comparison sits on the shared surface rather than a card of its own", () => {
    const list = expandToHostNodes(PrivacyAnswerComparison({ comparison: DIFF_COMPARISON }))
      .find((node) => node.tag === "ol");
    expect(list?.class).toBe("privacy-diff-lines privacy-quote");
  });

  test("a step's body is quoted only where the words are the exchange's own", () => {
    // The answer that left, quoted; the reviewer's account of it, quoted.
    expect(stepParagraphs(RELEASED_EVENT)).toEqual([
      { class: "privacy-quote privacy-quote--prose", text: RELEASED_EVENT.display.text },
    ]);
    expect(stepParagraphs({
      ...RELEASED_EVENT,
      kind: "privacy_review",
      display: { ...RELEASED_EVENT.display, text: "The exact answer named a home address." },
    })[0].class).toBe("privacy-quote privacy-quote--prose");

    // The request step carries two quotes: the question as it arrived and the
    // purpose the caller stated for it. Both are the caller's own words.
    expect(stepParagraphs({
      ...RELEASED_EVENT,
      kind: "external_request",
      display: {
        ...RELEASED_EVENT.display,
        text: "When is the quartet rehearsing?",
        detail: "Keep the booking calendar in step.",
      },
    })).toEqual([
      { class: "privacy-quote privacy-quote--prose", text: "When is the quartet rehearsing?" },
      { class: "privacy-quote privacy-quote--prose", text: "Keep the booking calendar in step." },
    ]);
  });

  test("the gateway's own account of a step stays in prose", () => {
    // Agent activity is a sentence the gateway wrote, not anyone's words.
    expect(stepParagraphs({
      ...RELEASED_EVENT,
      kind: "agent_trace",
      display: {
        ...RELEASED_EVENT.display,
        text: "Read-only model and tool activity inside Omnesis.",
        detail: null,
      },
    })).toEqual([{ class: "", text: "Read-only model and tool activity inside Omnesis." }]);

    // A note beside a quoted body is still the gateway's, so only the body is
    // quoted.
    expect(stepParagraphs({
      ...RELEASED_EVENT,
      kind: "released",
      display: { ...RELEASED_EVENT.display, detail: "Deterministic hard stop" },
    }).map((p) => p.class)).toEqual(["privacy-quote privacy-quote--prose", ""]);

    // A step kind this build has never heard of claims nothing about who wrote
    // it, so it is not attributed to the exchange.
    expect(stepParagraphs({ ...RELEASED_EVENT, kind: "summarized" })[0].class).toBe("");
  });
});

describe("the quote surface itself", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../css/style.css", import.meta.url)),
    "utf8",
  );

  function ruleBody(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `${selector} is missing`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  }

  test("is declared once and shared, not copied into the comparison", () => {
    const quote = ruleBody(".privacy-quote");
    expect(quote).toContain("background: var(--privacy-quote-bg)");
    expect(quote).toContain("border: 1px solid var(--privacy-quote-border)");
    expect(quote).toContain("border-radius:");

    // The comparison layers only its own list behaviour on top; repeating the
    // surface here is how the two drift apart.
    const lines = ruleBody(".privacy-diff-lines");
    expect(lines).not.toMatch(/\bbackground\b|\bborder(-radius)?\s*:/);
  });

  test("marks a quote with a surface, never a rule down its left edge", () => {
    // That column already means which side of the trust boundary you are on.
    expect(ruleBody(".privacy-quote")).not.toContain("border-left");
    expect(ruleBody(".privacy-quote--prose")).not.toContain("border-left");
  });

  test("carries a lift in both themes, so no quote can vanish into its card", () => {
    for (const token of ["--privacy-quote-bg", "--privacy-quote-border"]) {
      expect(css.match(new RegExp(`${token}:`, "g")) ?? []).toHaveLength(2);
    }
  });
});
