// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  basedOnLabel,
  briefDayLabel,
  briefTimeLabel,
  foldedDaySummary,
  groupBriefDays,
  taskHref,
  // @ts-expect-error — portal is plain JS without sibling declarations.
} from "./brief-thread.js";

const briefTurn = (id: string, day: string, sentAt: string | null = null) => ({
  id,
  role: "assistant",
  parts: [{ kind: "text", text: `Brief for ${day}.` }],
  brief: { day, messageId: `mb_${day}`, sentAt },
});
const user = (id: string) => ({ id, role: "user", parts: [{ kind: "text", text: "A reply." }] });
const answer = (id: string) => ({ id, role: "assistant", parts: [{ kind: "text", text: "Done." }] });

describe("groupBriefDays", () => {
  test("each brief opens a day holding the replies after it", () => {
    const turns = [
      briefTurn("a-0", "2026-10-12"),
      user("u-1"),
      answer("a-2"),
      user("u-3"),
      answer("a-4"),
      briefTurn("a-5", "2026-10-13", "2026-10-13T06:02:40.055Z"),
      user("u-6"),
    ];
    const { preamble, days } = groupBriefDays(turns);
    expect(preamble).toEqual([]);
    expect(
      days.map((d: { day: string; turns: Array<{ id: string }>; replies: number; sentAt: string | null }) => [
        d.day,
        d.turns.map((t) => t.id),
        d.replies,
        d.sentAt,
      ]),
    ).toEqual([
      ["2026-10-12", ["a-0", "u-1", "a-2", "u-3", "a-4"], 2, null],
      ["2026-10-13", ["a-5", "u-6"], 1, "2026-10-13T06:02:40.055Z"],
    ]);
    expect(days[1].messageId).toBe("mb_2026-10-13");
  });

  test("turns before the first loaded brief are the preamble", () => {
    const { preamble, days } = groupBriefDays([user("u-0"), answer("a-1"), briefTurn("a-2", "2026-10-13")]);
    expect(preamble.map((t: { id: string }) => t.id)).toEqual(["u-0", "a-1"]);
    expect(days).toHaveLength(1);
    expect(days[0].replies).toBe(0);
  });

  test("an empty thread has no days", () => {
    expect(groupBriefDays([])).toEqual({ preamble: [], days: [] });
    expect(groupBriefDays(undefined)).toEqual({ preamble: [], days: [] });
  });
});

describe("labels", () => {
  test("the day separator says Today, Yesterday, or the short day", () => {
    expect(briefDayLabel("2026-10-14", "2026-10-14")).toBe("Today");
    expect(briefDayLabel("2026-10-13", "2026-10-14")).toBe("Yesterday");
    expect(briefDayLabel("2026-10-12", "2026-10-14")).toBe("Mon 12 Oct");
    // Across a month boundary.
    expect(briefDayLabel("2026-09-30", "2026-10-01")).toBe("Yesterday");
    expect(briefDayLabel("not-a-day", "2026-10-14")).toBe("not-a-day");
  });

  test("the send time is local hours and minutes, absent when unrecorded", () => {
    const sentAt = "2026-10-14T06:02:40.055Z";
    const local = new Date(sentAt);
    const expected = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    expect(briefTimeLabel(sentAt)).toBe(expected);
    expect(briefTimeLabel(null)).toBeNull();
    expect(briefTimeLabel(undefined)).toBeNull();
    expect(briefTimeLabel("garbage")).toBeNull();
  });

  test("a folded day names its things once known and its replies when there are any", () => {
    expect(foldedDaySummary({ itemCount: 5, replies: 2 })).toBe("Morning brief · 5 things · 2 replies");
    expect(foldedDaySummary({ itemCount: 1, replies: 1 })).toBe("Morning brief · 1 thing · 1 reply");
    expect(foldedDaySummary({ itemCount: null, replies: 3 })).toBe("Morning brief · 3 replies");
    expect(foldedDaySummary({ itemCount: 0, replies: 0 })).toBe("Morning brief · 0 things");
    expect(foldedDaySummary({ replies: 0 })).toBe("Morning brief");
  });

  test("the footer counts its things", () => {
    expect(basedOnLabel(1)).toBe("Based on 1 thing");
    expect(basedOnLabel(4)).toBe("Based on 4 things");
  });

  test("a task chip opens the Tasks view on that task", () => {
    expect(taskHref("loop_a b")).toBe("/portal/tasks?task=loop_a%20b");
  });
});
