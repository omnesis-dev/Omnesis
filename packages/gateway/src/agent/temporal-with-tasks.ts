// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";

interface TemporalWindow {
  start: string;
  endExclusive: string;
  timeZone: string;
}
interface TaskListData {
  today: string;
  tasks: unknown[];
  truncated: boolean;
}

function dayIn(instant: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    return null;
  }
}

function covers(window: TemporalWindow, day: string): boolean {
  const first = dayIn(new Date(window.start), window.timeZone);
  const last = dayIn(new Date(Date.parse(window.endExclusive) - 1), window.timeZone);
  return first !== null && last !== null && first <= day && day <= last;
}

function localNow(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    return `${parts} (${timeZone})`;
  } catch {
    return now.toISOString();
  }
}

/**
 * A conversation's `temporal_query`, made to answer "what's on today" in full.
 * When the window it read covers the user's Tasks day, the first page also
 * carries those tasks (planned for today, carried over or due) and the current
 * time in the window's zone, so a today answer never misses the user's own
 * tasks or presents a finished morning as still ahead. Later pages, other
 * windows and failed reads are returned unchanged.
 */
export function withTodaysTasks(
  tools: readonly ToolHandle[],
  now: () => Date = () => new Date(),
): ToolHandle[] {
  const taskList = tools.find((tool) => tool.name === "task_list");
  if (!taskList) return [...tools];
  return tools.map((tool): ToolHandle => {
    if (tool.name !== "temporal_query") return tool;
    return {
      ...tool,
      async invoke(args, context): Promise<ToolResult> {
        const result = await tool.invoke(args, context);
        if (result.kind !== "structured" || result.resultType !== "temporal.results") return result;
        if (args && typeof args === "object" && "cursor" in args && args.cursor) return result;
        const data = result.data as { window?: TemporalWindow };
        if (!data.window) return result;
        const list = await taskList.invoke({ view: "today" }, context).catch(() => null);
        if (list?.kind !== "structured") return result;
        const tasks = list.data as TaskListData;
        if (!covers(data.window, tasks.today)) return result;
        return {
          ...result,
          data: {
            ...data,
            now: localNow(now(), data.window.timeZone),
            tasks: { view: "today", ...tasks },
          },
        };
      },
    };
  });
}
