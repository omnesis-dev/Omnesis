// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal component in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getBrief: vi.fn(), setReaction: vi.fn(), navigate: vi.fn() }));
vi.mock("../../api.js", () => ({
  getConversationBrief: mocks.getBrief,
  setBriefItemReaction: mocks.setReaction,
}));
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
import { BriefThread, withItemReaction } from "./brief-thread.js";

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
  mocks.setReaction.mockImplementation(async (_id, _day, observationId, body) => ({
    observationId,
    reaction: body.reaction,
    ...(body.note ? { note: body.note } : {}),
    at: "2026-10-14T09:00:00.000Z",
  }));
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

describe("brief item thumbs", () => {
  const thumbs = (index) => {
    const item = host.querySelectorAll(".brief-item")[index];
    return {
      up: item.querySelector(".brief-thumb-up"),
      down: item.querySelector(".brief-thumb-down"),
      label: item.querySelector(".brief-thumb-label"),
      error: item.querySelector(".brief-thumb-error"),
    };
  };
  const pressed = (el) => el.getAttribute("aria-pressed");

  test("every item offers both thumbs and shows its reaction as the pressed one", async () => {
    mocks.getBrief.mockResolvedValue(
      detail(TODAY, [
        { ...ITEMS[0], reaction: { kind: "up", at: "2026-10-14T08:00:00.000Z" } },
        { ...ITEMS[1], reaction: { kind: "factual_error", note: "Wrong venue", at: "2026-10-14T08:00:00.000Z" } },
        { rank: 3, observationId: "obs_quiet", summary: "A quiet one.", sources: [], tasks: [] },
      ]),
    );
    await mount();
    expect(host.querySelectorAll(".brief-thumb-up")).toHaveLength(3);
    expect(host.querySelectorAll(".brief-thumb-down")).toHaveLength(3);
    expect(thumbs(0).up.getAttribute("aria-label")).toBe("Useful");
    expect(thumbs(0).down.getAttribute("aria-label")).toBe("Not useful");
    expect([pressed(thumbs(0).up), pressed(thumbs(0).down)]).toEqual(["true", "false"]);
    expect(thumbs(0).label).toBeNull();
    expect([pressed(thumbs(1).up), pressed(thumbs(1).down)]).toEqual(["false", "true"]);
    expect(thumbs(1).label.textContent).toBe("factual error");
    expect([pressed(thumbs(2).up), pressed(thumbs(2).down)]).toEqual(["false", "false"]);
  });

  test("thumbs up sends the reaction and shows it at once; a second press clears it", async () => {
    await mount();
    await click(thumbs(0).up);
    expect(mocks.setReaction).toHaveBeenCalledWith("conv_brief", TODAY, "obs_offer", { reaction: "up" });
    expect(pressed(thumbs(0).up)).toBe("true");
    // The other item is untouched.
    expect(pressed(thumbs(1).up)).toBe("false");
    await click(thumbs(0).up);
    expect(mocks.setReaction).toHaveBeenLastCalledWith("conv_brief", TODAY, "obs_offer", { reaction: null });
    expect(pressed(thumbs(0).up)).toBe("false");
  });

  test("a refused thumbs up goes back to unpressed with the error beside it", async () => {
    mocks.setReaction.mockRejectedValueOnce(new Error("gateway away"));
    await mount();
    await click(thumbs(0).up);
    expect(pressed(thumbs(0).up)).toBe("false");
    expect(thumbs(0).error.textContent).toContain("gateway away");
    expect(host.querySelector(".modal-panel")).toBeNull();
  });

  test("thumbs down asks why; a factual error with words sends both and closes", async () => {
    await mount();
    expect(host.querySelector(".modal-panel")).toBeNull();
    await click(thumbs(1).down);
    const dialog = host.querySelector(".modal-panel");
    expect(dialog.getAttribute("aria-label")).toBe("Not useful?");
    const radios = [...dialog.querySelectorAll("input[type=radio]")];
    expect(radios.map((r) => r.value)).toEqual(["not_interested", "factual_error"]);
    // linkedom has no `checked` property; Preact lands it as an attribute.
    expect(radios[0].hasAttribute("checked")).toBe(true);
    expect(dialog.textContent).toContain("Future briefs and task suggestions will follow this.");
    expect(dialog.textContent).toContain("a correction goes to Omnesis as a note");
    // Nothing is sent until the owner does.
    expect(mocks.setReaction).not.toHaveBeenCalled();
    await act(async () => {
      radios[1].checked = true;
      radios[1].dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const note = dialog.querySelector("textarea");
    expect(note.getAttribute("placeholder")).toBeTruthy();
    await act(async () => {
      note.value = "  The venue did not move.  ";
      note.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(mocks.setReaction).toHaveBeenCalledWith("conv_brief", TODAY, "obs_venue", {
      reaction: "factual_error",
      note: "The venue did not move.",
    });
    expect(host.querySelector(".modal-panel")).toBeNull();
    expect(pressed(thumbs(1).down)).toBe("true");
    expect(thumbs(1).label.textContent).toBe("factual error");
  });

  test("the default choice is not interested, sent without a note when none was given", async () => {
    await mount();
    await click(thumbs(0).down);
    const dialog = host.querySelector(".modal-panel");
    await act(async () => {
      dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(mocks.setReaction).toHaveBeenCalledWith("conv_brief", TODAY, "obs_offer", { reaction: "not_interested" });
    expect(thumbs(0).label.textContent).toBe("not interested");
  });

  test("cancel sends nothing; a refused send keeps the dialog open with the error", async () => {
    await mount();
    await click(thumbs(0).down);
    await click([...host.querySelectorAll(".modal-actions button")].find((b) => b.textContent === "Cancel"));
    expect(host.querySelector(".modal-panel")).toBeNull();
    expect(mocks.setReaction).not.toHaveBeenCalled();

    mocks.setReaction.mockRejectedValueOnce(new Error("no reactor"));
    await click(thumbs(0).down);
    const dialog = host.querySelector(".modal-panel");
    await act(async () => {
      dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(host.querySelector(".modal-panel")).not.toBeNull();
    expect(host.querySelector(".modal-error").textContent).toContain("no reactor");
    expect(pressed(thumbs(0).down)).toBe("false");
  });

  test("an item already thumbed down reopens on its choice and can remove it", async () => {
    mocks.getBrief.mockResolvedValue(
      detail(TODAY, [{ ...ITEMS[0], reaction: { kind: "not_interested", note: "Old news", at: "2026-10-14T08:00:00.000Z" } }]),
    );
    await mount();
    await click(thumbs(0).down);
    const dialog = host.querySelector(".modal-panel");
    expect([...dialog.querySelectorAll("input[type=radio]")].map((r) => r.hasAttribute("checked"))).toEqual([true, false]);
    expect(dialog.querySelector("textarea").value).toBe("Old news");
    await click(dialog.querySelector(".brief-reaction-remove"));
    expect(mocks.setReaction).toHaveBeenCalledWith("conv_brief", TODAY, "obs_offer", { reaction: null });
    expect(host.querySelector(".modal-panel")).toBeNull();
    expect(pressed(thumbs(0).down)).toBe("false");
    expect(thumbs(0).label).toBeNull();
  });
});

describe("withItemReaction", () => {
  const loaded = {
    status: "ok",
    data: { day: TODAY, items: [{ observationId: "a", reaction: { kind: "up" } }, { observationId: "b" }] },
  };

  test("replaces one item's reaction and leaves the others alone", () => {
    const next = withItemReaction(loaded, "b", { kind: "not_interested", note: "n" });
    expect(next.data.items).toEqual([
      { observationId: "a", reaction: { kind: "up" } },
      { observationId: "b", reaction: { kind: "not_interested", note: "n" } },
    ]);
    expect(withItemReaction(loaded, "a", null).data.items[0]).toEqual({ observationId: "a" });
    // The entry is replaced, not mutated.
    expect(loaded.data.items[1]).toEqual({ observationId: "b" });
  });

  test("leaves a missing, loading or failed entry as it is", () => {
    expect(withItemReaction(undefined, "a", null)).toBeUndefined();
    const loading = { status: "loading" };
    expect(withItemReaction(loading, "a", { kind: "up" })).toBe(loading);
  });
});
