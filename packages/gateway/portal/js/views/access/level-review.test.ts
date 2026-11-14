// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  getSourceFilterEditor: vi.fn(),
  getSourceFilterOptions: vi.fn(),
  previewSourceFilter: vi.fn(),
  resyncSource: vi.fn(),
}));
vi.mock("../../api.js", () => api);
// @ts-expect-error — Portal modules are JavaScript.
import { LevelDecisionSummary, LevelReview, LevelTopicSummary } from "./level-review.js";
// @ts-expect-error — Portal modules are JavaScript.
import { LevelFlow } from "./level-flow.js";
// @ts-expect-error — Portal modules are JavaScript.
import { newGrantRule } from "../../components/grant-builder-state.js";

const source = {
  id: "invented:maya@example.com",
  displayName: "Invented provider",
  icon: "/icons/invented.svg",
  filterable: true,
};
const editor = {
  sourceId: source.id,
  sourceType: "invented",
  devices: [],
  showDeviceLevel: false,
  fields: [
    {
      field: "extra.labelIds",
      capability: "membership",
      noun: { one: "label", many: "labels" },
      picker: "search",
      scope: "global",
      state: { status: "ready" },
      counts: { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null },
    },
  ],
};
const ref = { capability: "membership", field: "extra.labelIds", id: "invented-design-label" };
const policy = {
  sourceId: source.id,
  audience: { accessLevel: "invented-level", capability: "answer" },
  rules: [{ action: "share", match: [ref] }],
  otherwise: "hide",
};
const answer = {
  ...newGrantRule("answer", "invented-policy"),
  sources: { mode: "allowlist", sourceIds: [source.id] },
  scopePolicies: [policy],
};
const policies = [{ id: "invented-policy", name: "Invented policy" }];
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
  api.previewSourceFilter.mockReset();
  api.getSourceFilterEditor.mockReset().mockResolvedValue(editor);
  api.previewSourceFilter.mockResolvedValue({
    sourceId: source.id,
    visible: 7,
    hidden: 4,
    status: "ready",
    tooOld: 0,
    unmatched: 1,
    tooOldText: null,
    unmatchedText: null,
    items: [{ ref, label: "Design", count: 7 }],
  });
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});

test("create and Direct summaries share typed filter tables and source headers without collapsed or sample details", async () => {
  const rules = { answer, direct: { ...answer, capability: "direct" } };
  await act(async () =>
    render(
      h(LevelReview, {
        rules,
        initial: rules,
        sources: [source],
        policies,
        onChange: vi.fn(),
        isNew: true,
      }),
      host,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Design"));
  expect(host.querySelectorAll(".compact-filter-table")).toHaveLength(2);
  expect(
    host.querySelectorAll('.compact-source-header img[src="/icons/invented.svg"]'),
  ).toHaveLength(2);
  expect([...host.querySelectorAll(".compact-filter-kind")].map((e) => e.textContent)).toEqual([
    "Label",
    "Label",
  ]);
  expect(host.textContent).toContain("Design");
  expect(host.textContent).not.toContain(ref.id);
  expect(
    host.querySelectorAll("details, .source-filter-samples, .compact-filter-action"),
  ).toHaveLength(0);
  expect(host.textContent).not.toContain("Unknown records");
});

test("edit review shows only changed accounts with before/after tables and a visible unchanged count", async () => {
  const other = { ...source, id: "invented:jamie@example.org" };
  const before = {
    answer: { ...answer, sources: { mode: "allowlist", sourceIds: [source.id, other.id] } },
  };
  const after = {
    answer: { ...before.answer, sources: { mode: "allowlist", sourceIds: [other.id] } },
  };
  await act(async () =>
    render(
      h(LevelReview, {
        rules: after,
        initial: before,
        sources: [source, other],
        policies,
        onChange: vi.fn(),
      }),
      host,
    ),
  );
  expect(host.querySelectorAll(".guided-account-delta")).toHaveLength(1);
  expect(host.querySelector(".guided-account-delta .compact-source-account")?.textContent).toBe(
    "maya@example.com",
  );
  const pair = host.querySelector(".guided-account-delta .guided-change-pair")!;
  expect(pair.querySelectorAll(":scope > section > strong")[0]?.textContent).toBe("Before");
  expect(pair.querySelectorAll(":scope > section > strong")[1]?.textContent).toBe("After");
  expect(pair.textContent).toContain("Not shared");
  // Accounts that did not change are not counted: only what changes is listed.
  expect(host.textContent).not.toContain("unchanged");
  expect(host.querySelectorAll("details")).toHaveLength(0);
});

test("a filter kept on an account that is not shared is not listed as something the level shares", async () => {
  await act(async () =>
    render(
      h(LevelDecisionSummary, {
        decision: "answer-data",
        rules: { answer: { ...answer, sources: { mode: "allowlist", sourceIds: [] } } },
        sources: [source],
        policies,
      }),
      host,
    ),
  );
  expect(host.textContent).toBe("No accounts selected.");
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
});

test("Future and Release use focusable description tips without changing a radio from an info click", async () => {
  const onRules = vi.fn();
  const props = {
    step: "future",
    onStep: vi.fn(),
    rules: { answer },
    initial: { answer },
    onRules,
    sources: [source],
    policies,
    sourceFiltersEnabled: true,
    accessLevel: "invented-level",
    isNew: true,
    linkDirect: true,
    onLinkDirect: vi.fn(),
    disabled: false,
  };
  await act(async () => render(h(LevelFlow, props), host));
  expect(host.querySelectorAll(".compact-info button[aria-describedby]")).toHaveLength(2);
  expect(host.querySelector(".guided-choice small")).toBeNull();
  const tip = host.querySelector<HTMLButtonElement>(".compact-info button")!;
  act(() => tip.click());
  expect(onRules).not.toHaveBeenCalled();
  expect(host.querySelector('input[type="radio"]')?.hasAttribute("checked")).toBe(true);
  const blur = vi.fn();
  tip.blur = blur;
  const escape = new window.Event("keydown", { bubbles: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  act(() => {
    tip.dispatchEvent(escape);
  });
  expect(blur).toHaveBeenCalledOnce();
  expect(tip.closest(".compact-info")?.getAttribute("data-dismissed")).toBe("true");
  await act(async () => render(h(LevelFlow, { ...props, step: "release" }), host));
  expect(host.querySelector(".guided-question p")).toBeNull();
  expect(host.querySelector('select[aria-label="Answer privacy policy"]')).not.toBeNull();
  const automatic = host.querySelector<HTMLInputElement>("#level-release-unreviewed")!;
  act(() => {
    automatic.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onRules).toHaveBeenCalledOnce();
  expect(onRules.mock.calls[0]![0].answer.release).toEqual({ mode: "unreviewed" });
});

test("overview counts filters only on selected accounts while preserving blocked restrictions", () => {
  const other = { ...source, id: "invented:jamie@example.org" };
  const rules = { answer: { ...answer, sources: { mode: "allowlist", sourceIds: [other.id] } } };
  act(() =>
    render(
      h(LevelTopicSummary, {
        decision: "answer-data",
        rules,
        sources: [source, other],
        policies,
      }),
      host,
    ),
  );
  expect(host.querySelector(".compact-topic-count")?.textContent?.trim()).toBe(
    "1 account selected · all content",
  );
  expect(rules.answer.scopePolicies).toEqual([policy]);
});

test("before and after distinguish different selections with the same display name", async () => {
  const replacement = { capability: "membership", field: "extra.labelIds", id: "invented-replacement-label" };
  const before = { answer };
  const after = {
    answer: {
      ...answer,
      scopePolicies: [{ ...policy, rules: [{ action: "share", match: [replacement] }] }],
    },
  };
  api.previewSourceFilter.mockImplementation(async (_sourceId: string, draft: typeof policy) => ({
    sourceId: source.id,
    visible: 7,
    hidden: 4,
    status: "ready",
    tooOld: 0,
    unmatched: 1,
    tooOldText: null,
    unmatchedText: null,
    items: draft.rules.flatMap((rule) =>
      rule.match.map((item) => ({ ref: item, label: "Design", count: 7 })),
    ),
  }));
  await act(async () => {
    render(
      h(LevelReview, {
        rules: after,
        initial: before,
        sources: [source],
        policies,
        onChange: vi.fn(),
      }),
      host,
    );
  });
  await vi.waitFor(() => expect(host.querySelectorAll(".compact-filter-ref")).toHaveLength(2));
  const ids = [...host.querySelectorAll(".compact-filter-ref")].map((item) => item.textContent);
  expect(ids).toEqual([
    "Selection ID: invented-replacement-label",
    "Selection ID: invented-design-label",
  ]);
  // One table carries the change: what it adds leads, what it removes follows.
  expect(host.querySelectorAll(".guided-account-delta .compact-filter-table")).toHaveLength(1);
  const rows = [...host.querySelectorAll(".guided-account-delta tbody tr")];
  expect(rows.map((row) => row.className)).toEqual(["is-added", "is-removed"]);
  expect(rows.map((row) => row.querySelector(".compact-filter-diff")?.textContent)).toEqual([
    "Added",
    "Removed",
  ]);
  expect(host.querySelectorAll("details")).toHaveLength(0);
});

describe("a filter's items show under the side that holds them", () => {
  const second = { ...source, id: "invented:jamie@example.org" };
  const travel = { capability: "membership", field: "extra.labelIds", id: "invented-travel-label" };
  const budget = { capability: "membership", field: "extra.labelIds", id: "invented-budget-label" };
  const labels: Record<string, string> = {
    [ref.id]: "Design",
    [travel.id]: "Travel",
    [budget.id]: "Budget",
  };
  const filter = (
    sourceId: string,
    capability: string,
    action: "share" | "hide",
    match: (typeof ref)[],
  ) => ({
    sourceId,
    audience: { accessLevel: "invented-level", capability },
    rules: [{ action, match }],
    otherwise: action === "share" ? "hide" : "share",
  });
  const rule = (capability: string, sourceIds: string[], scopePolicies: unknown[] = []) => ({
    ...newGrantRule(capability, "invented-policy"),
    sources: { mode: "allowlist", sourceIds },
    scopePolicies,
  });
  type Draft = Record<string, ReturnType<typeof rule>>;

  beforeEach(() => {
    // Sharing matches leaves 7 records shared; hiding them leaves 20.
    api.previewSourceFilter.mockImplementation(
      async (sourceId: string, draft: ReturnType<typeof filter>) => ({
        sourceId,
        visible: draft.rules[0]!.action === "share" ? 7 : 20,
        hidden: draft.rules[0]!.action === "share" ? 20 : 7,
        status: "ready",
        tooOld: 0,
        unmatched: 0,
        tooOldText: null,
        unmatchedText: null,
        items: draft.rules[0]!.match.map((item) => ({
          ref: item,
          label: labels[item.id],
          count: 3,
        })),
      }),
    );
  });

  async function review(initial: Draft, rules: Draft) {
    await act(async () =>
      render(
        h(LevelReview, { rules, initial, sources: [source, second], policies, onChange: vi.fn() }),
        host,
      ),
    );
    await vi.waitFor(() =>
      expect(host.querySelectorAll(".source-filter-spinner, .compact-filter-ref")).toHaveLength(0),
    );
  }
  /** One changed account as the review lays it out: each side's line and table, then the merged table. */
  function account(id: string, decision = "answer-data") {
    const delta = [
      ...host.querySelectorAll(`.compact-review-${decision} .guided-account-delta`),
    ].find((item) => item.querySelector(".compact-source-account")?.textContent === id.split(":")[1]);
    expect(delta, `${id} is listed as changed`).toBeDefined();
    const rows = (scope: Element | null | undefined) =>
      [...(scope?.querySelectorAll("tbody tr") ?? [])].map((row) =>
        [
          row.querySelector(".compact-filter-name")?.textContent,
          row.querySelector(".compact-filter-diff")?.textContent?.toLowerCase(),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const side = (index: number) => {
      const section = delta!.querySelectorAll(".guided-change-pair > section")[index]!;
      const counts = [...section.querySelectorAll(".compact-policy-impact > span")]
        .map((item) => item.textContent?.replace(/\s+/g, " ").trim())
        .join(" · ");
      const pill = section.querySelector(".guided-readable-boundary")?.textContent;
      return { line: [counts, pill].filter(Boolean).join(" "), items: rows(section) };
    };
    return {
      before: side(0),
      after: side(1),
      merged: rows(delta!.querySelector(".guided-change-filters")),
    };
  }

  test("Direct switched off: each account's filter stays under Before, After reads Not granted", async () => {
    const direct = rule("direct", [source.id, second.id], [filter(source.id, "direct", "share", [ref])]);
    await review({ answer, direct }, { answer });
    expect(account(source.id, "direct-data")).toEqual({
      before: { line: "7 shared · 20 hidden Share matching content", items: ["Design"] },
      after: { line: "Not granted", items: [] },
      merged: [],
    });
    expect(account(second.id, "direct-data")).toEqual({
      before: { line: "All content", items: [] },
      after: { line: "Not granted", items: [] },
      merged: [],
    });
  });

  test("Direct switched on: the filter follows the After line, unmarked", async () => {
    const direct = rule("direct", [source.id, second.id], [filter(source.id, "direct", "share", [ref])]);
    await review({ answer }, { answer, direct });
    expect(account(source.id, "direct-data")).toEqual({
      before: { line: "Not granted", items: [] },
      after: { line: "7 shared · 20 hidden Share matching content", items: ["Design"] },
      merged: [],
    });
    expect(account(second.id, "direct-data").after).toEqual({ line: "All content", items: [] });
  });

  test("a filter added to an account that shared all content shows under After", async () => {
    await review(
      { answer: rule("answer", [source.id]) },
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "hide", [ref])]) },
    );
    expect(account(source.id)).toEqual({
      before: { line: "All content", items: [] },
      after: { line: "20 shared · 7 hidden Hide matching content", items: ["Design"] },
      merged: [],
    });
  });

  test("the gateway's sentences for records a filter keeps hidden follow the side's counts, as the dialog shows them", async () => {
    const tooOldText = "3 older items could not be resynced and stay hidden from agents using this filter.";
    api.previewSourceFilter.mockImplementation(async (sourceId: string, draft: ReturnType<typeof filter>) => ({
      sourceId,
      visible: 20,
      hidden: 7,
      status: "ready",
      tooOld: 3,
      unmatched: 0,
      tooOldText,
      unmatchedText: null,
      items: draft.rules[0]!.match.map((item) => ({ ref: item, label: labels[item.id], count: 3 })),
    }));
    await review(
      { answer: rule("answer", [source.id]) },
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "hide", [ref])]) },
    );
    const sides = [...host.querySelectorAll(".guided-change-pair > section")];
    expect(sides[0]!.querySelector(".source-filter-unchecked")).toBeNull();
    expect(sides[1]!.querySelector(".source-filter-unchecked")?.textContent).toBe(tooOldText);
  });

  test("a filter removed shows under Before, and After reads All content", async () => {
    await review(
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "hide", [ref])]) },
      { answer: rule("answer", [source.id]) },
    );
    expect(account(source.id)).toEqual({
      before: { line: "20 shared · 7 hidden Hide matching content", items: ["Design"] },
      after: { line: "All content", items: [] },
      merged: [],
    });
  });

  test("items added and removed on one filter make one marked list after both lines", async () => {
    await review(
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "share", [ref, travel])]) },
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "share", [travel, budget])]) },
    );
    expect(account(source.id)).toEqual({
      before: { line: "7 shared · 20 hidden Share matching content", items: [] },
      after: { line: "7 shared · 20 hidden Share matching content", items: [] },
      merged: ["Budget added", "Design removed", "Travel"],
    });
  });

  test("a mode switch on the same items changes the pill and the counts, the items unmarked", async () => {
    await review(
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "share", [ref])]) },
      { answer: rule("answer", [source.id], [filter(source.id, "answer", "hide", [ref])]) },
    );
    expect(account(source.id)).toEqual({
      before: { line: "7 shared · 20 hidden Share matching content", items: [] },
      after: { line: "20 shared · 7 hidden Hide matching content", items: [] },
      merged: ["Design"],
    });
  });

  test("an unselected account keeps its filter under Before; a newly selected one shows it under After", async () => {
    const saved = filter(source.id, "answer", "share", [ref]);
    await review(
      { answer: rule("answer", [source.id], [saved]) },
      // The unselected account's filter is still in the draft until it is removed.
      { answer: rule("answer", [second.id], [saved, filter(second.id, "answer", "hide", [travel])]) },
    );
    expect(account(source.id)).toEqual({
      before: { line: "7 shared · 20 hidden Share matching content", items: ["Design"] },
      after: { line: "Not shared", items: [] },
      merged: [],
    });
    expect(account(second.id)).toEqual({
      before: { line: "Not shared", items: [] },
      after: { line: "20 shared · 7 hidden Hide matching content", items: ["Travel"] },
      merged: [],
    });
  });

  test("an account that is no longer connected shows its filter change by name, without counts", async () => {
    const gone = { id: "invented:gone@example.com", available: false };
    api.previewSourceFilter.mockImplementation(async (_sourceId: string, draft: typeof policy) => ({
      status: "ready",
      sourceId: gone.id,
      connected: false,
      total: 0,
      visible: 0,
      hidden: 0,
      tooOld: 0,
      unmatched: 0,
      tooOldText: null,
      unmatchedText: null,
      items: draft.rules[0]!.match.map((item) => ({ ref: item, label: "Last known name", count: 0 })),
    }));
    await act(async () =>
      render(
        h(LevelReview, {
          rules: { answer: rule("answer", [gone.id], [filter(gone.id, "answer", "share", [travel])]) },
          initial: {
            answer: rule("answer", [gone.id], [filter(gone.id, "answer", "share", [ref, travel])]),
          },
          sources: [gone],
          policies,
          onChange: vi.fn(),
        }),
        host,
      ),
    );
    await vi.waitFor(() => expect(host.textContent).toContain("Last known name"));
    expect(
      [...host.querySelectorAll(".compact-policy-impact")].map((item) => item.textContent?.trim()),
    ).toEqual(["", ""]);
    expect(host.textContent).toContain("Last known name");
    expect(
      [...host.querySelectorAll("tbody .compact-filter-count")].every((cell) => cell.textContent === "—"),
    ).toBe(true);
    expect(host.querySelectorAll(".guided-change-filters .is-removed")).toHaveLength(1);
  });

  test("an account read on neither side is not a change", async () => {
    // Answer switched on for one account: the other goes from Not granted to Not shared.
    const direct = rule("direct", [source.id]);
    await review({ direct }, { direct, answer: rule("answer", [source.id]) });
    const listed = [...host.querySelectorAll(".compact-review-answer-data .guided-account-delta")];
    expect(listed.map((item) => item.querySelector(".compact-source-account")?.textContent)).toEqual([
      "maya@example.com",
    ]);
    expect(listed).toHaveLength(1);
  });

  test("a Direct that follows Answer is summarised in one line where it is unchanged or new", async () => {
    const both = { answer: rule("answer", [source.id]), direct: rule("direct", [source.id]) };
    const props = { rules: both, initial: both, sources: [source, second], policies, onChange: vi.fn() };
    await act(async () => render(h(LevelReview, { ...props, linked: true }), host));
    expect(
      [...host.querySelectorAll(".guided-unchanged .compact-topic-count")].map((item) => item.textContent),
    ).toEqual(["1 account selected · all content", "Same sources and filters as Answer"]);
    await act(async () => render(h(LevelReview, { ...props, linked: true, isNew: true }), host));
    expect(host.querySelector(".compact-review-direct-data > p")?.textContent).toBe(
      "Same sources and filters as Answer",
    );
    expect(host.querySelectorAll(".compact-review-direct-data .compact-source-summary")).toHaveLength(0);
  });

  test("a capability switched off reads Not granted in every decision it leaves", async () => {
    const release = { answer: rule("answer", [source.id]) };
    await act(async () =>
      render(
        h("div", null, [
          h(LevelDecisionSummary, { decision: "release", rules: {}, sources: [source], policies }),
          h(LevelDecisionSummary, { decision: "future", rules: {}, sources: [source], policies }),
          h(LevelDecisionSummary, { decision: "direct-data", rules: release, sources: [source], policies }),
        ]),
        host,
      ),
    );
    expect([...host.querySelectorAll(".guided-not-granted")].map((item) => item.textContent)).toEqual([
      "Not granted",
      "Not granted",
      "Not granted",
    ]);
  });
});
