// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal component in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getBrief: vi.fn(), navigate: vi.fn() }));
vi.mock("../../api.js", () => ({ getConversationBrief: mocks.getBrief }));
vi.mock("../../lib/router.js", () => ({ navigate: mocks.navigate }));
vi.mock("../doc-chip.js", async () => {
  const { h: hh } = await import("preact");
  return {
    DocChip: ({ documentId, title, className }) =>
      hh("a", { class: `doc-chip ${className}`, "data-doc": documentId }, title || "Untitled"),
  };
});
vi.mock("./parts.js", async () => {
  const { h: hh } = await import("preact");
  return {
    MessageBubble: ({ turn, header, footer }) =>
      hh("div", { class: `msg msg-${turn.role}`, "data-turn": turn.id }, header, turn.parts[0].text, footer),
  };
});
import { BriefThread } from "./brief-thread.js";

const TODAY = "2026-10-14";
const turns = [
  {
    id: "a-0",
    role: "assistant",
    parts: [{ kind: "text", text: "Monday's brief." }],
    brief: { day: "2026-10-12", messageId: "mb_1", sentAt: null },
  },
  { id: "u-1", role: "user", parts: [{ kind: "text", text: "Which one?" }] },
  { id: "a-2", role: "assistant", parts: [{ kind: "text", text: "The first." }] },
  {
    id: "a-3",
    role: "assistant",
    parts: [{ kind: "text", text: "Today's brief." }],
    brief: { day: TODAY, messageId: "mb_2", sentAt: "2026-10-14T06:02:40.055Z" },
  },
  { id: "u-4", role: "user", parts: [{ kind: "text", text: "Thanks." }] },
];
const detail = (day, items) => ({ day, messageId: "mb", items });
const ITEMS = [
  {
    rank: 1,
    observationId: "obs_offer",
    summary: "The loan offer expires on Friday.",
    sources: [{ id: "doc_offer", title: "Loan offer letter", sourceType: "gmail", createdAt: null }],
    tasks: [{ id: "loop_boiler", title: "Book the boiler engineer", state: "open" }],
  },
  { rank: 2, observationId: "obs_venue", summary: "The venue moved.", sources: [], tasks: [] },
];

let host;
let originalDocument;
let originalWindow;

async function mount() {
  await act(async () => {
    render(h(BriefThread, { conversationId: "conv_brief", turns, today: TODAY }), host);
  });
  await act(async () => {});
}
const text = () => host.textContent;
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new window.Event("click", { bubbles: true }));
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
  mocks.getBrief.mockImplementation(async (_id, day) =>
    detail(day, day === TODAY ? ITEMS : [ITEMS[1]]),
  );
});

afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

describe("BriefThread", () => {
  test("today is open with its sources listed; an earlier day is folded", async () => {
    await mount();
    expect([...host.querySelectorAll(".brief-day-label")].map((el) => el.textContent)).toEqual([
      "Mon 12 Oct",
      "Today",
    ]);
    // Only the latest brief is fetched up front.
    expect(mocks.getBrief.mock.calls).toEqual([["conv_brief", TODAY]]);
    expect(text()).not.toContain("Monday's brief.");
    expect(host.querySelector(".brief-day-folded").textContent).toContain("Morning brief · 1 reply");
    // Today's brief: header, text, and the expanded list with its chips.
    expect(host.querySelector(".brief-header").textContent).toContain("Morning brief");
    expect(text()).toContain("Today's brief.");
    expect(host.querySelector(".brief-footer-toggle").textContent).toContain("Based on 2 things");
    expect(host.querySelector(".brief-footer-toggle").getAttribute("aria-expanded")).toBe("true");
    expect([...host.querySelectorAll(".brief-item-summary")].map((el) => el.textContent)).toEqual([
      "The loan offer expires on Friday.",
      "The venue moved.",
    ]);
    expect(host.querySelector("[data-doc='doc_offer']").textContent).toBe("Loan offer letter");
    const task = host.querySelector(".brief-task-chip");
    expect(task.getAttribute("href")).toBe("/portal/tasks?task=loop_boiler");
    await click(task);
    expect(mocks.navigate).toHaveBeenCalledWith("/portal/tasks?task=loop_boiler");
  });

  test("opening an earlier day fetches its list and keeps its footer closed", async () => {
    await mount();
    await click(host.querySelector(".brief-day-folded"));
    expect(mocks.getBrief).toHaveBeenCalledWith("conv_brief", "2026-10-12");
    expect(text()).toContain("Monday's brief.");
    expect(text()).toContain("Which one?");
    const toggles = host.querySelectorAll(".brief-footer-toggle");
    expect(toggles[0].textContent).toContain("Based on 1 thing");
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    await click(toggles[0]);
    expect(text()).toContain("The venue moved.");
    // Folding it again shows the count it now knows.
    await click(host.querySelector(".brief-day-toggle"));
    expect(host.querySelector(".brief-day-folded").textContent).toContain(
      "Morning brief · 1 thing · 1 reply",
    );
  });

  test("a brief based on nothing shows no footer", async () => {
    mocks.getBrief.mockResolvedValue(detail(TODAY, []));
    await mount();
    expect(host.querySelector(".brief-footer")).toBeNull();
  });

  test("a failed read shows a quiet retry line that reloads", async () => {
    mocks.getBrief.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(text()).toContain("Today's brief.");
    expect(host.querySelector(".brief-footer-error").textContent).toContain("Retry");
    await click(host.querySelector(".brief-retry"));
    expect(host.querySelector(".brief-footer-error")).toBeNull();
    expect(text()).toContain("Based on 2 things");
  });
});
