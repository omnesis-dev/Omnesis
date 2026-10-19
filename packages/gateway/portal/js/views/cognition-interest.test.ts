// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The interest ledger panel: its pure helpers (source wording stays data-driven,
 * polarity badges by kind, signal links, the status lines, the probe's three
 * lists), and the tab mounted in a lightweight DOM against a mocked gateway —
 * an empty ledger, a ledger that is off, a seeded ledger with its badges,
 * dimmed superseded row, links and backlog line, and the lookup probe's
 * disabled, failed and empty answers.
 */

// @ts-nocheck — exercises the plain-JS portal component in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getInterest: vi.fn(), probe: vi.fn(), undo: vi.fn() }));
vi.mock("../api.js", () => ({
  getBrainInterest: mocks.getInterest,
  probeBrainInterest: mocks.probe,
  undoTask: mocks.undo,
}));
// The host page's shared bits, stubbed to what the tab reads from them.
vi.mock("./cognition.js", async () => {
  const { h: hh } = await import("preact");
  const { useEffect, useState } = await import("preact/hooks");
  return {
    BrainInactiveBanner: () => null,
    LoadState: ({ loading, error }) =>
      error ? hh("div", { class: "debug-error" }, String(error)) : loading ? hh("div", { class: "debug-loading" }, "Loading…") : null,
    Pill: ({ color, children }) => hh("span", { class: "debug-pill", "data-color": color }, children),
    cognitionPath: (section, id) => `/portal/debug/cognition/${section}/${encodeURIComponent(id)}`,
    fmtRel: () => "2d ago",
    fmtTs: (iso) => String(iso),
    useLoader: (fetcher) => {
      const [state, setState] = useState({ data: null, error: null, loading: true });
      const [nonce, setNonce] = useState(0);
      useEffect(() => {
        fetcher().then(
          (data) => setState({ data, error: null, loading: false }),
          (err) => setState({ data: null, error: err?.message ?? String(err), loading: false }),
        );
      }, [nonce]);
      return { ...state, reload: () => setNonce((n) => n + 1) };
    },
  };
});
vi.mock("../components/decision-card.js", async () => {
  const { h: hh } = await import("preact");
  return {
    DecisionList: ({ decisions, emptyText }) =>
      hh("section", { class: "decision-list" }, decisions.length ? decisions.map((d) => hh("div", { class: "decision-card", "data-decision-id": d.id })) : emptyText),
  };
});
import * as interest from "./cognition-interest.js";
import { InterestTab } from "./cognition-interest.js";

// ── Pure helpers ─────────────────────────────────────────────────────

describe("sourceLabel", () => {
  test("words every known reaction and passes an unknown one through", () => {
    expect(interest.sourceLabel("task_accepted")).toBe("accepted a suggestion");
    expect(interest.sourceLabel("brief_not_interested")).toBe("brief item not interested");
    expect(interest.sourceLabel("statement")).toBe("said so in the brief");
    // A source the gateway grows later must still render, not vanish.
    expect(interest.sourceLabel("calendar_rsvp")).toBe("calendar_rsvp");
  });
});

describe("polarityBadge", () => {
  test("reactions read wanted / not wanted; statements read more / less", () => {
    expect(interest.polarityBadge({ kind: "task", polarity: 1 }).label).toBe("wanted");
    expect(interest.polarityBadge({ kind: "observation", polarity: -1 }).label).toBe("not wanted");
    expect(interest.polarityBadge({ kind: "statement", polarity: 1 }).label).toBe("more");
    expect(interest.polarityBadge({ kind: "statement", polarity: -1 }).label).toBe("less");
    // Same colour for the same polarity whatever the kind.
    expect(interest.polarityBadge({ kind: "task", polarity: -1 }).color).toBe(
      interest.polarityBadge({ kind: "statement", polarity: -1 }).color,
    );
  });
});

describe("signalHref", () => {
  test("links a task signal to its task and an observation signal to its observation", () => {
    expect(interest.signalHref({ loopId: "loop_a", observationId: null })).toEqual({
      label: "Task",
      href: "/portal/debug/cognition/knowledge/loop_a?kind=loop",
    });
    expect(interest.signalHref({ loopId: null, observationId: "obs/1" })).toEqual({
      label: "Observation",
      href: "/portal/debug/cognition/observations/obs%2F1",
    });
    // The task wins when a signal carries both.
    expect(interest.signalHref({ loopId: "loop_a", observationId: "obs_1" }).label).toBe("Task");
    expect(interest.signalHref({ loopId: null, observationId: null })).toBeNull();
  });
});

describe("status lines", () => {
  test("backlogLabel counts what waits and is silent when nothing does", () => {
    expect(interest.backlogLabel(0)).toBeNull();
    expect(interest.backlogLabel(undefined)).toBeNull();
    expect(interest.backlogLabel(1)).toBe("1 signal waiting for a vector");
    expect(interest.backlogLabel(4)).toBe("4 signals waiting for a vector");
  });

  test("countsLine renders every count and treats a missing one as zero", () => {
    expect(
      interest.countsLine({ live: 12, superseded: 3, positive: 8, negative: 3, statements: 1 }),
    ).toBe("12 live · 3 superseded · 8 wanted · 3 not wanted · 1 statement");
    expect(interest.countsLine(undefined)).toBe("0 live · 0 superseded · 0 wanted · 0 not wanted · 0 statements");
  });

  test("age and similarity formatting", () => {
    expect(interest.ageDaysLabel(0)).toBe("today");
    expect(interest.ageDaysLabel(3)).toBe("3d ago");
    expect(interest.ageDaysLabel(undefined)).toBe("—");
    expect(interest.similarityLabel(0.625)).toBe("0.63");
    expect(interest.similarityLabel(null)).toBe("—");
    expect(interest.similarityText({ similarity: 0.71, basis: "vector" })).toBe("similarity 0.71 by vector");
    expect(interest.similarityText({ similarity: 0.2, basis: "words" })).toBe("similarity 0.20 by words");
    // An example without a basis, or with one this page does not know, says only the number.
    expect(interest.similarityText({ similarity: 0.5 })).toBe("similarity 0.50");
    expect(interest.similarityText({ similarity: 0.5, basis: "magic" })).toBe("similarity 0.50");
  });
});

describe("probeSections", () => {
  test("always yields the three lists, empty for a null result", () => {
    const sections = interest.probeSections(null);
    expect(sections.map((s) => s.key)).toEqual(["positive", "negative", "statements"]);
    expect(sections.every((s) => s.items.length === 0)).toBe(true);
    const result = {
      positive: [{ text: "a", source: "task_accepted", ageDays: 1, similarity: 0.5 }],
      negative: [],
      statements: [{ text: "b", direction: "less", ageDays: 0, similarity: 0.3 }],
    };
    expect(interest.probeSections(result).map((s) => s.items.length)).toEqual([1, 0, 1]);
  });
});

// ── The mounted tab ──────────────────────────────────────────────────

const EMPTY = {
  enabled: true,
  backlog: 0,
  counts: { live: 0, superseded: 0, positive: 0, negative: 0, statements: 0 },
  signals: [],
  withheld: [],
  decisions: [],
};
const signal = (id, extra) => ({
  id,
  polarity: 1,
  kind: "task",
  source: "task_accepted",
  text: `Signal ${id}`,
  note: null,
  loopId: null,
  observationId: null,
  conversationId: null,
  embedded: false,
  createdAt: "2026-10-12T08:00:00.000Z",
  supersededAt: null,
  ...extra,
});
const SEEDED = {
  enabled: true,
  backlog: 2,
  counts: { live: 3, superseded: 1, positive: 1, negative: 1, statements: 1 },
  signals: [
    signal("int_say", { kind: "statement", source: "statement", polarity: -1, text: "less about retail promotions", note: "Stop showing me shop offers" }),
    signal("int_no", { kind: "observation", source: "brief_not_interested", polarity: -1, text: "A sale on garden furniture", observationId: "obs_sale" }),
    signal("int_yes", { text: "Book the boiler engineer", loopId: "loop_boiler", embedded: true }),
    signal("int_old", { source: "task_created", text: "Renew the parking permit", loopId: "loop_permit", supersededAt: "2026-10-13T08:00:00.000Z" }),
  ],
  withheld: [
    { loopId: "loop_deals", title: "Compare broadband deals", seq: 41, at: "2026-10-13T08:00:00.000Z", note: "Like the broadband offers the owner ignored" },
    { loopId: "loop_sale", title: "Check the garden furniture sale", seq: 37, at: "2026-10-12T08:00:00.000Z", note: null },
  ],
  decisions: [{ id: "dec_1", purpose: "task-propose", verdict: "pass", score: 2 }],
};

let host;
let originalDocument;
let originalWindow;

async function mount() {
  await act(async () => {
    render(h(InterestTab, {}), host);
  });
  await act(async () => {});
}
const text = () => host.textContent;
const rows = () => [...host.querySelectorAll("tbody tr")];
const input = () => host.querySelector(".cognition-interest-probe-input");
const lookup = () => host.querySelector(".cognition-interest-probe button[type=submit]");
const type = async (value) => {
  await act(async () => {
    input().value = value;
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const submitProbe = async () => {
  await act(async () => {
    host.querySelector(".cognition-interest-probe form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><div id='host'></div></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = parsed.document.querySelector("#host");
  mocks.getInterest.mockResolvedValue(EMPTY);
});

afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

describe("InterestTab", () => {
  test("an empty ledger shows the counts at zero and says how to fill it", async () => {
    await mount();
    expect(mocks.getInterest).toHaveBeenCalledWith({ limit: 200 });
    expect(text()).toContain("Interest ledger on");
    expect(text()).toContain("0 live · 0 superseded · 0 wanted · 0 not wanted · 0 statements");
    expect(text()).not.toContain("waiting for a vector");
    expect(host.querySelector(".debug-empty").textContent).toBe(interest.EMPTY_LEDGER_TEXT);
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector(".decision-list").textContent).toContain("No suggestion has been judged yet");
    expect(text()).toContain("Withheld suggestions (0)");
    expect(host.querySelector(".cognition-interest-withheld-empty").textContent).toBe("Nothing withheld.");
    expect(host.querySelector(".cognition-interest-offer")).toBeNull();
  });

  test("withheld suggestions list their title, note and age, and Offer again undoes the one row", async () => {
    mocks.getInterest.mockResolvedValue(SEEDED);
    let answer;
    mocks.undo.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await mount();
    expect(text()).toContain("Withheld suggestions (2)");
    const items = [...host.querySelectorAll(".cognition-interest-withheld-row")];
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".cognition-interest-withheld-title").textContent).toBe("Compare broadband deals");
    expect(items[0].querySelector(".cognition-interest-withheld-title").getAttribute("href")).toBe(
      "/portal/debug/cognition/knowledge/loop_deals?kind=loop",
    );
    expect(items[0].textContent).toContain("Like the broadband offers the owner ignored");
    expect(items[0].textContent).toContain("2d ago");
    expect(items[1].textContent).not.toContain("null");
    expect(host.querySelector(".cognition-interest-withheld-empty")).toBeNull();

    const buttons = [...host.querySelectorAll(".cognition-interest-offer")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Offer again", "Offer again"]);
    await act(async () => {
      buttons[1].dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(mocks.undo).toHaveBeenCalledTimes(1);
    expect(mocks.undo).toHaveBeenCalledWith(37);
    // While the undo is in flight every button waits and the pressed one says so.
    const pending = [...host.querySelectorAll(".cognition-interest-offer")];
    expect(pending.map((b) => b.textContent)).toEqual(["Offer again", "Offering…"]);
    expect(pending.every((b) => b.hasAttribute("disabled"))).toBe(true);
    expect(mocks.getInterest).toHaveBeenCalledTimes(1);
    // Landed: the list is read again, and the gateway no longer lists that row.
    mocks.getInterest.mockResolvedValue({ ...SEEDED, withheld: [SEEDED.withheld[0]] });
    await act(async () => {
      answer({ task: { id: "loop_sale" }, receipt: { text: "Offered again", undoSeq: 42 } });
    });
    await act(async () => {});
    expect(mocks.getInterest).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll(".cognition-interest-withheld-row")).toHaveLength(1);
    expect(text()).toContain("Withheld suggestions (1)");
  });

  test("a refused Offer again shows the error and keeps the row", async () => {
    mocks.getInterest.mockResolvedValue(SEEDED);
    mocks.undo.mockRejectedValueOnce(new Error("ledger entry already undone"));
    await mount();
    await act(async () => {
      host.querySelector(".cognition-interest-offer").dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(mocks.undo).toHaveBeenCalledWith(41);
    expect(host.querySelector(".cognition-interest-withheld .debug-error").textContent).toContain("ledger entry already undone");
    expect(host.querySelectorAll(".cognition-interest-withheld-row")).toHaveLength(2);
    expect(host.querySelector(".cognition-interest-offer").hasAttribute("disabled")).toBe(false);
    expect(mocks.getInterest).toHaveBeenCalledTimes(1);
  });

  test("a ledger that is off says so and why", async () => {
    mocks.getInterest.mockResolvedValue({ ...EMPTY, enabled: false });
    await mount();
    expect(text()).toContain("Interest ledger off");
    expect(text()).toContain("brain.interest.enabled");
    expect(text()).not.toContain("Interest ledger on");
  });

  test("a failed read shows the error", async () => {
    mocks.getInterest.mockRejectedValue(new Error("gateway away"));
    await mount();
    expect(host.querySelector(".debug-error").textContent).toContain("gateway away");
    expect(host.querySelector("table")).toBeNull();
  });

  test("a seeded ledger lists every signal with its badge, link, vector and backlog", async () => {
    mocks.getInterest.mockResolvedValue(SEEDED);
    await mount();
    expect(text()).toContain("3 live · 1 superseded · 1 wanted · 1 not wanted · 1 statement");
    expect(host.querySelector(".cognition-interest-backlog").textContent).toContain("2 signals waiting for a vector");
    expect(text()).toContain("Signals (4)");
    expect(rows()).toHaveLength(4);
    expect(rows().map((row) => row.querySelector(".debug-pill").textContent)).toEqual([
      "less",
      "not wanted",
      "wanted",
      "wanted",
    ]);
    // The same colour for the same polarity, whatever the kind.
    const colours = rows().map((row) => row.querySelector(".debug-pill").getAttribute("data-color"));
    expect(colours[0]).toBe(colours[1]);
    expect(colours[2]).toBe(colours[3]);
    expect(colours[0]).not.toBe(colours[2]);
    // The owner's words sit under the subject.
    expect(rows()[0].textContent).toContain("“Stop showing me shop offers”");
    expect(rows()[0].textContent).toContain("said so in the brief");
    // Links go to the observation or the task.
    expect(rows()[1].querySelector("a").getAttribute("href")).toBe("/portal/debug/cognition/observations/obs_sale");
    expect(rows()[1].querySelector("a").textContent).toBe("Observation");
    expect(rows()[2].querySelector("a").getAttribute("href")).toBe("/portal/debug/cognition/knowledge/loop_boiler?kind=loop");
    expect(rows()[2].querySelector("a").textContent).toBe("Task");
    expect(rows()[0].querySelector("a")).toBeNull();
    // Only the embedded signal carries a tick.
    expect(rows().map((row) => row.querySelector("td.num").textContent)).toEqual(["—", "—", "✓", "—"]);
    // The superseded row is dimmed and says so.
    expect(rows().map((row) => row.classList.contains("cognition-interest-superseded"))).toEqual([false, false, false, true]);
    expect(rows()[3].textContent).toContain("superseded");
    expect(host.querySelector(".debug-empty")).toBeNull();
    expect(host.querySelector("[data-decision-id='dec_1']")).not.toBeNull();
  });

  test("the probe is disabled on whitespace, shows an error inline, and reads an empty answer", async () => {
    await mount();
    expect(lookup().hasAttribute("disabled")).toBe(true);
    await type("   ");
    expect(lookup().hasAttribute("disabled")).toBe(true);
    await submitProbe();
    expect(mocks.probe).not.toHaveBeenCalled();

    await type("  parking permit ");
    expect(lookup().hasAttribute("disabled")).toBe(false);
    mocks.probe.mockRejectedValueOnce(new Error("lookup failed"));
    await submitProbe();
    expect(mocks.probe).toHaveBeenCalledWith("parking permit");
    expect(host.querySelector(".cognition-interest-probe .debug-error").textContent).toContain("lookup failed");

    mocks.probe.mockResolvedValueOnce({ text: "parking permit", result: null });
    await submitProbe();
    expect(host.querySelector(".cognition-interest-probe .debug-error")).toBeNull();
    expect(host.querySelector(".cognition-interest-probe-result").textContent).toContain(
      "Nothing in the ledger resembles “parking permit”",
    );
  });

  test("the probe lists what resembles the text by polarity, with age and similarity", async () => {
    await mount();
    await type("boiler");
    mocks.probe.mockResolvedValueOnce({
      text: "boiler",
      result: {
        positive: [{ text: "Book the boiler engineer", source: "task_accepted", ageDays: 6, similarity: 0.71, basis: "vector" }],
        negative: [],
        statements: [{ text: "less about the boiler", direction: "less", note: "Enough", ageDays: 0, similarity: 0.4, basis: "words" }],
      },
    });
    await submitProbe();
    const titles = [...host.querySelectorAll(".cognition-interest-probe-title")].map((el) => el.textContent);
    expect(titles).toEqual(["Wanted things like it (1)", "Did not want things like it (0)", "Said about things like it (1)"]);
    const examples = [...host.querySelectorAll(".cognition-interest-examples li")].map((el) => el.textContent);
    expect(examples[0]).toContain("Book the boiler engineer");
    expect(examples[0]).toContain("accepted a suggestion · 6d ago · similarity 0.71 by vector");
    expect(examples[1]).toContain("less about the boiler — “Enough” · less · today · similarity 0.40 by words");
  });
});
