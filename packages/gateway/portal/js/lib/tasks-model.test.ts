// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  TASK_VIEW_KEYS,
  addDays,
  countLabel,
  deadlineLabel,
  editBody,
  groupTasks,
  historyEventLabel,
  historyNote,
  isOverdue,
  localDay,
  nextMonday,
  nextMonth,
  proposalText,
  quickMoves,
  relativeDayLabel,
  resolveTaskView,
  resolvedLabel,
  taskDocumentsShown,
  scheduleEditorState,
  scheduleFromEditor,
  scheduleLabel,
  taskBullet,
  taskMetaItems,
  tomorrow,
  viewCount,
  visibleTaskViews,
  // @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
} from "./tasks-model.js";

const task = (fields: Record<string, unknown> = {}) => ({
  id: "loop_a",
  title: "Return the library books",
  description: "",
  state: "open",
  origin: "user",
  accepted: false,
  scheduledFor: null,
  deadline: null,
  dueDay: null,
  carried: false,
  completionNote: null,
  proposedChange: null,
  actors: [],
  blockedBy: [],
  ...fields,
});

describe("local-day arithmetic", () => {
  it("formats the viewer's local day", () => {
    expect(localDay(new Date(2026, 9, 5, 23, 30))).toBe("2026-10-05");
  });

  it("moves to tomorrow across month and year ends", () => {
    expect(tomorrow("2026-10-12")).toBe("2026-10-13");
    expect(tomorrow("2026-10-31")).toBe("2026-11-01");
    expect(tomorrow("2026-12-31")).toBe("2027-01-01");
    expect(tomorrow("2028-02-28")).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("next week is the next Monday, a full week on from a Monday", () => {
    // 2026-10-12 is a Monday.
    expect(nextMonday("2026-10-12")).toBe("2026-10-19");
    expect(nextMonday("2026-10-13")).toBe("2026-10-19");
    expect(nextMonday("2026-10-17")).toBe("2026-10-19");
    expect(nextMonday("2026-10-18")).toBe("2026-10-19");
    expect(nextMonday("2026-12-30")).toBe("2027-01-04");
  });

  it("next month is the following YYYY-MM, rolling the year", () => {
    expect(nextMonth("2026-10-12")).toBe("2026-11");
    expect(nextMonth("2026-01-31")).toBe("2026-02");
    expect(nextMonth("2026-12-01")).toBe("2027-01");
  });

  it("offers the three quick moves with their schedules", () => {
    expect(quickMoves("2026-10-14")).toEqual([
      { key: "tomorrow", label: "Tomorrow", to: "2026-10-15" },
      { key: "next-week", label: "Next week", to: "2026-10-19" },
      { key: "next-month", label: "Next month", to: "2026-11" },
    ]);
  });
});

describe("row labels", () => {
  const today = "2026-10-12";

  it("names days relative to today", () => {
    expect(relativeDayLabel("2026-10-12", today)).toBe("Today");
    expect(relativeDayLabel("2026-10-13", today)).toBe("Tomorrow");
    expect(relativeDayLabel("2026-10-11", today)).toBe("Yesterday");
    expect(relativeDayLabel("2026-10-16", today)).toBe("Fri 16 Oct");
  });

  it("labels schedules: days, months (with the year only when it differs) and someday", () => {
    expect(scheduleLabel(null, today)).toBeNull();
    expect(scheduleLabel("someday", today)).toBe("Someday");
    expect(scheduleLabel("2026-10-19", today)).toBe("Mon 19 Oct");
    expect(scheduleLabel("2026-11", today)).toBe("November");
    expect(scheduleLabel("2027-01", today)).toBe("January 2027");
  });

  it("labels deadlines by type, as the mobile apps word them", () => {
    const due = (dueDay: string, type: string, fields: Record<string, unknown> = {}) =>
      deadlineLabel(task({ dueDay, deadline: { type, date: dueDay }, ...fields }), today);
    expect(deadlineLabel(task(), today)).toBeNull();
    expect(due("2026-10-16", "by")).toBe("Due Fri 16 Oct");
    expect(due("2026-10-12", "by")).toBe("Due today");
    expect(due("2026-10-11", "by")).toBe("Due yesterday");
    expect(due("2026-10-13", "on_day")).toBe("Tomorrow");
    expect(due("2026-10-24", "on_day")).toBe(["On", "Sat 24 Oct"].join(" "));
    expect(due("2026-10-20", "approximate")).toBe("Around Tue 20 Oct");
    expect(due("2026-10-13", "approximate")).toBe("Around tomorrow");
    expect(due("2026-10-10", "by")).toBe("Due Sat 10 Oct");
  });

  it("calls an open task past its due day overdue, never a resolved one", () => {
    expect(isOverdue(task({ dueDay: "2026-10-10" }), today)).toBe(true);
    expect(isOverdue(task({ dueDay: "2026-10-12" }), today)).toBe(false);
    expect(isOverdue(task({ state: "done", dueDay: "2026-10-10" }), today)).toBe(false);
    expect(isOverdue(task(), today)).toBe(false);
  });

  it("picks the bullet-journal signifier", () => {
    expect(taskBullet(task())).toBe("open");
    expect(taskBullet(task({ carried: true }))).toBe("carried");
    expect(taskBullet(task({ state: "done", carried: true }))).toBe("done");
    expect(taskBullet(task({ state: "dismissed" }))).toBe("struck");
  });

  it("phrases each proposal kind", () => {
    expect(proposalText(null)).toBeNull();
    expect(proposalText({ kind: "complete", reason: "The receipt arrived on Friday.", fields: null })).toBe(
      "Omnesis thinks this is done: The receipt arrived on Friday.",
    );
    expect(proposalText({ kind: "strike", reason: "", fields: null })).toBe(
      "Omnesis thinks this no longer applies",
    );
    expect(
      proposalText({ kind: "edit", reason: "The venue moved it.", fields: { scheduledFor: "2026-10-20" } }),
    ).toBe("Omnesis suggests a change: plan for 2026-10-20 — The venue moved it.");
  });

  it("labels history entries with where the change was made", () => {
    expect(historyEventLabel({ kind: "migrated", surface: "tasks", to: "2026-10-19" })).toBe(
      "Moved to 2026-10-19 in Tasks",
    );
    expect(historyEventLabel({ kind: "completed", surface: "conversation" })).toBe("Done in a conversation");
    expect(historyEventLabel({ kind: "created", surface: "note" })).toBe("Added from a note");
    expect(historyEventLabel({ kind: "note", surface: "brain" })).toBe("Note by Omnesis");
  });
});

describe("the meta line", () => {
  const today = "2026-10-12";
  const meta = (fields: Record<string, unknown>, view = "anytime") =>
    taskMetaItems(task(fields), view, today).map((item: { icon: string | null; text: string; tone: string }) => [
      item.icon,
      item.text,
      item.tone,
    ]);

  it("shows the plan beside the deadline, each with its icon", () => {
    expect(
      meta({ scheduledFor: "2026-10-19", dueDay: "2026-10-24", deadline: { type: "by", date: "2026-10-24" } }, "month"),
    ).toEqual([
      ["calendar", "Mon 19 Oct", "neutral"],
      ["flag", "Due Sat 24 Oct", "neutral"],
    ]);
    expect(meta({ scheduledFor: "2026-11" }, "future")).toEqual([["calendar", "November", "neutral"]]);
    expect(meta({ scheduledFor: "someday" }, "future")).toEqual([["calendar", "Someday", "neutral"]]);
  });

  it("does not repeat Today on Today's page", () => {
    expect(meta({ scheduledFor: "2026-10-12" }, "today")).toEqual([]);
    expect(meta({ scheduledFor: "2026-10-12" }, "waiting")).toEqual([["calendar", "Today", "neutral"]]);
    expect(meta({ scheduledFor: "2026-10" }, "today")).toEqual([["calendar", "October", "neutral"]]);
  });

  it("names the day a carried task was planned for, in amber", () => {
    expect(meta({ carried: true, scheduledFor: "2026-10-11" }, "today")).toEqual([
      ["carried", "Carried from yesterday", "warning"],
    ]);
    expect(meta({ carried: true, scheduledFor: "2026-10-08" }, "today")).toEqual([
      ["carried", "Carried from Thu 8 Oct", "warning"],
    ]);
    expect(meta({ carried: true }, "today")).toEqual([["carried", "Carried", "warning"]]);
  });

  it("marks an overdue deadline as danger and drops the deadline once resolved", () => {
    expect(meta({ dueDay: "2026-10-10", deadline: { type: "by", date: "2026-10-10" } })).toEqual([
      ["flag", "Due Sat 10 Oct", "danger"],
    ]);
    expect(meta({ state: "done", dueDay: "2026-10-10", deadline: { type: "by", date: "2026-10-10" } })).toEqual([]);
  });

  it("keeps a task resolved today to its title on Today's page", () => {
    expect(meta({ state: "done", scheduledFor: "2026-10-09" }, "today")).toEqual([]);
  });

  it("lists the other people, the first blocker, and a note's origin", () => {
    expect(
      meta({
        origin: "note",
        actors: [
          { id: "p1", name: "Maya Reeves", isSelf: false },
          { id: "p2", name: "Jamie", isSelf: false },
          { id: "p0", name: "Me", isSelf: true },
        ],
        blockedBy: [
          { id: "loop_b", title: "Quote from Stellar Sound" },
          { id: "loop_c", title: "Signed form" },
        ],
      }),
    ).toEqual([
      ["person", "Maya Reeves, Jamie", "neutral"],
      ["waiting", "Waiting on Quote from Stellar Sound", "neutral"],
      ["note", "From a note", "neutral"],
    ]);
  });

  it("says when a task closed on the Done view only", () => {
    const resolvedAt = new Date(2026, 9, 12, 9).toISOString();
    const localToday = localDay(new Date(2026, 9, 12, 12));
    const items = (view: string) =>
      taskMetaItems(task({ state: "done", resolvedAt }), view, localToday).map((item: { text: string }) => item.text);
    expect(items("done")).toEqual(["Done today"]);
    expect(items("waiting")).toEqual([]);
  });
});

describe("counts", () => {
  const counts = { today: 4, month: 10, future: 0, anytime: 2, waiting: 1, suggested: 3, proposals: 1, carried: 1 };

  it("counts each view's open tasks, and nothing on History", () => {
    expect(viewCount(counts, "today")).toBe(4);
    expect(viewCount(counts, "month")).toBe(10);
    expect(viewCount(counts, "future")).toBe(0);
    expect(viewCount(counts, "suggested")).toBe(3);
    expect(viewCount(counts, "done")).toBe(0);
    expect(viewCount(null, "today")).toBe(0);
    expect(viewCount({ today: "4" }, "today")).toBe(0);
  });

  it("adds the count to a label only when there is one", () => {
    expect(countLabel("Tasks", 4)).toBe("Tasks (4)");
    expect(countLabel("Today", 0)).toBe("Today");
    expect(countLabel("Month", 10)).toBe("Month (10)");
  });
});

describe("history and resolution", () => {
  it("drops a note that only restates the event", () => {
    expect(historyNote({ kind: "completed", note: "Done" })).toBeNull();
    expect(historyNote({ kind: "created", note: "Created." })).toBeNull();
    expect(historyNote({ kind: "completed", note: "Paid at the front desk" })).toBe("Paid at the front desk");
    expect(historyNote({ kind: "edited", note: "" })).toBeNull();
  });

  it("labels when a resolved task closed", () => {
    const today = localDay(new Date(2026, 9, 12, 12));
    expect(resolvedLabel(task({ state: "done", resolvedAt: new Date(2026, 9, 12, 9).toISOString() }), today)).toBe(
      "Done today",
    );
    expect(resolvedLabel(task({ state: "dismissed", resolvedAt: new Date(2026, 9, 9, 9).toISOString() }), today)).toBe(
      "Struck Fri 9 Oct",
    );
    expect(resolvedLabel(task(), today)).toBeNull();
  });
});

describe("grouping", () => {
  const today = "2026-10-12";

  it("splits Today into carried, today and resolved — keeping the today group even when empty", () => {
    const groups = groupTasks(
      "today",
      [
        task({ id: "c", carried: true, scheduledFor: "2026-10-09" }),
        task({ id: "d", state: "done" }),
      ],
      today,
    );
    expect(groups.map((g: { key: string; tasks: { id: string }[] }) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ["carried", ["c"]],
      ["today", []],
      ["resolved", ["d"]],
    ]);
  });

  it("groups Month by planned day and Future by month", () => {
    const month = groupTasks(
      "month",
      [
        task({ id: "a", scheduledFor: "2026-10-20" }),
        task({ id: "b", scheduledFor: "2026-10-20" }),
        task({ id: "c", scheduledFor: "2026-10" }),
      ],
      today,
    );
    expect(month.map((g: { label: string }) => g.label)).toEqual(["Tue 20 Oct", "This month"]);
    const future = groupTasks(
      "future",
      [
        task({ id: "a", scheduledFor: "2026-11" }),
        task({ id: "b", scheduledFor: "2027-02-03" }),
        task({ id: "c", scheduledFor: "someday" }),
      ],
      today,
    );
    expect(future.map((g: { label: string }) => g.label)).toEqual(["November", "February 2027", "Someday"]);
  });

  it("keeps the other views as one flat list", () => {
    expect(groupTasks("waiting", [task()], today)).toEqual([{ key: "waiting", label: null, tasks: [task()] }]);
  });

  it("knows every view key", () => {
    expect(TASK_VIEW_KEYS).toEqual(["today", "month", "future", "anytime", "waiting", "suggested", "done"]);
  });

  it("offers Suggested only in experimental mode", () => {
    const keys = (experimental: boolean) => visibleTaskViews(experimental).map((v: { key: string }) => v.key);
    expect(keys(false)).toEqual(["today", "month", "future", "anytime", "waiting", "done"]);
    expect(keys(true)).toEqual(TASK_VIEW_KEYS);
  });

  it("opens Today for a view that is hidden or unknown", () => {
    expect(resolveTaskView("suggested", false)).toBe("today");
    expect(resolveTaskView("suggested", true)).toBe("suggested");
    expect(resolveTaskView("waiting", false)).toBe("waiting");
    expect(resolveTaskView("later", true)).toBe("today");
  });
});

describe("the editor", () => {
  it("round-trips schedules through its mode and value fields", () => {
    expect(scheduleEditorState(null)).toEqual({ mode: "none", value: "" });
    expect(scheduleEditorState("someday")).toEqual({ mode: "someday", value: "" });
    expect(scheduleEditorState("2026-10-19")).toEqual({ mode: "day", value: "2026-10-19" });
    expect(scheduleEditorState("2026-11")).toEqual({ mode: "month", value: "2026-11" });
    expect(scheduleFromEditor("day", "")).toBeUndefined();
    expect(scheduleFromEditor("month", "2026-11")).toBe("2026-11");
    expect(scheduleFromEditor("none", "")).toBeNull();
  });

  const form = (fields: Record<string, string> = {}) => ({
    title: "Return the library books",
    description: "",
    scheduleMode: "none",
    scheduleValue: "",
    deadline: "",
    ...fields,
  });

  it("sends only what changed", () => {
    expect(editBody(task(), form())).toBeNull();
    expect(editBody(task(), form({ title: "  Return the books  " }))).toEqual({
      action: "edit",
      title: "Return the books",
    });
    expect(editBody(task(), form({ scheduleMode: "month", scheduleValue: "2026-11", deadline: "2026-10-30" }))).toEqual({
      action: "edit",
      scheduledFor: "2026-11",
      deadline: { type: "by", date: "2026-10-30" },
    });
    expect(
      editBody(task({ deadline: { type: "on_day", date: "2026-10-30" } }), form({ deadline: "2026-10-30" })),
    ).toBeNull();
    expect(editBody(task({ deadline: { type: "by", date: "2026-10-30" } }), form())).toEqual({
      action: "edit",
      deadline: null,
    });
  });

  it("refuses an empty title or an incomplete schedule", () => {
    expect(editBody(task(), form({ title: " " }))).toEqual({ error: "A task needs a title." });
    expect(editBody(task(), form({ scheduleMode: "day" }))).toHaveProperty("error");
  });
});

describe("taskDocumentsShown", () => {
  const docs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `doc_${i}`, title: `Doc ${i}`, sourceId: "mail" }));

  it("lists a short list whole", () => {
    expect(taskDocumentsShown(docs(3), false)).toEqual({ shown: docs(3), hidden: 0 });
    expect(taskDocumentsShown(docs(4), false)).toEqual({ shown: docs(4), hidden: 0 });
    expect(taskDocumentsShown(undefined, false)).toEqual({ shown: [], hidden: 0 });
  });

  it("holds back the rest of a long list until asked", () => {
    expect(taskDocumentsShown(docs(6), false)).toEqual({ shown: docs(3), hidden: 3 });
    expect(taskDocumentsShown(docs(6), true)).toEqual({ shown: docs(6), hidden: 0 });
  });
});
