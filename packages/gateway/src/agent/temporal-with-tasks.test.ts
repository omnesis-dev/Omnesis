// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentService } from "./service.js";
import { withTodaysTasks } from "./temporal-with-tasks.js";
import type { AgentEvent, ToolResult } from "@omnesis/core";
import type { ChatBackend, DocumentPort, SearchPort, ToolHandle, TurnInput } from "@omnesis/agent";

const ctx = { sessionId: "S", messageId: "M" };
const TODAY = "2026-03-14";
const tasksData = {
  today: TODAY,
  tasks: [
    { id: "t1", title: "Send the invitations", state: "open", yours: true, due: TODAY },
    { id: "t2", title: "Check the transfer arrived", state: "open", yours: true, carried: true },
  ],
  truncated: false,
};

function temporalTool(window: { start: string; endExclusive: string; timeZone: string }) {
  const tool: ToolHandle = {
    name: "temporal_query",
    description: "Time window",
    mutates: false,
    schema: z.object({ from: z.string().optional(), cursor: z.string().optional() }),
    invoke: async () => ({
      kind: "structured",
      resultType: "temporal.results",
      data: { window, items: [], truncated: false },
    }),
  };
  return tool;
}
function taskListTool(calls: unknown[] = []): ToolHandle {
  return {
    name: "task_list",
    description: "Tasks",
    mutates: false,
    schema: z.object({ view: z.string().optional() }),
    invoke: async (args) => {
      calls.push(args);
      return { kind: "structured", resultType: "task.list", data: tasksData };
    },
  };
}
const londonDay = {
  start: "2026-03-14T00:00:00.000Z",
  endExclusive: "2026-03-15T00:00:00.000Z",
  timeZone: "Europe/London",
};
const now = () => new Date("2026-03-14T20:15:00Z");
const temporalOf = (tools: ToolHandle[]) => tools.find((t) => t.name === "temporal_query")!;

describe("temporal_query with today's tasks", () => {
  it("adds today's tasks and the current time when the window covers today", async () => {
    const calls: unknown[] = [];
    const tools = withTodaysTasks([temporalTool(londonDay), taskListTool(calls)], now);
    const result = (await temporalOf(tools).invoke({ from: TODAY }, ctx)) as Extract<
      ToolResult,
      { kind: "structured" }
    >;
    expect(calls).toEqual([{ view: "today" }]);
    const stamp = (result.data as { now: string }).now;
    for (const part of ["14 March 2026", "20:15", "(Europe/London)"]) expect(stamp).toContain(part);
    expect(result.data).toMatchObject({
      tasks: { view: "today", today: TODAY, tasks: tasksData.tasks, truncated: false },
    });
  });

  it("leaves other windows, later pages and failed reads unchanged", async () => {
    const lastWeek = {
      start: "2026-03-01T00:00:00.000Z",
      endExclusive: "2026-03-08T00:00:00.000Z",
      timeZone: "Europe/London",
    };
    const other = withTodaysTasks([temporalTool(lastWeek), taskListTool()], now);
    const read = (await temporalOf(other).invoke({}, ctx)) as { data: object };
    expect(read.data).not.toHaveProperty("tasks");

    const today = withTodaysTasks([temporalTool(londonDay), taskListTool()], now);
    const page = (await temporalOf(today).invoke({ cursor: "next" }, ctx)) as { data: object };
    expect(page.data).not.toHaveProperty("tasks");

    const failing: ToolHandle = {
      ...temporalTool(londonDay),
      invoke: async () => ({ kind: "error", code: "temporal_query_failed", message: "x" }),
    };
    const failed = withTodaysTasks([failing, taskListTool()], now);
    expect((await temporalOf(failed).invoke({}, ctx)).kind).toBe("error");
  });

  it("is a no-op without task tools", async () => {
    const tools = withTodaysTasks([temporalTool(londonDay)], now);
    const read = (await temporalOf(tools).invoke({}, ctx)) as { data: object };
    expect(read.data).not.toHaveProperty("tasks");
  });
});

// A scripted conversation probes the journal directly and through its time
// query overlay. Both paths must obey the same knowledge read boundary.
it.each([true, false])(
  "applies the knowledge read boundary before today's task overlay (%s)",
  async (knowledgeReads) => {
    let seen: ToolResult | undefined;
    let direct: ToolResult | undefined;
    let toolNames: string[] = [];
    const taskCalls: unknown[] = [];
    const loopSentinel = {
      today: TODAY,
      tasks: [{ id: "brain-loop", title: "Maintained loop sentinel" }],
      truncated: false,
    };
    let resolveTurn!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const backend: ChatBackend = {
      name: "puppet",
      model: "puppet",
      async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        toolNames = input.tools.map((tool) => tool.name);
        const taskList = input.tools.find((tool) => tool.name === "task_list");
        if (taskList) direct = await taskList.invoke({ view: "suggested" }, input);
        const temporal = input.tools.find((t) => t.name === "temporal_query")!;
        seen = await temporal.invoke({ from: "today" }, input);
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
      },
    };
    const search: SearchPort = {
      search: async (q) => ({ query: q.query, durationMs: 1, results: [] }),
    };
    const document: DocumentPort = { fetch: async () => null };
    const service = new AgentService({
      knowledgeReads,
      backendFactory: () => backend,
      ports: {
        search,
        document,
        temporal: {
          query: async () => ({
            type: "temporal.results",
            window: londonDay,
            summary: { anchored: 0, spanning: 0 },
            items: [],
            coverage: {
              projectionSources: [],
              specialistSources: [],
              annotations: { selective: true },
            },
            truncated: false,
          }),
        },
      },
      systemPrompt: "test",
      broadcastEvent: (event) => {
        if (event.type === "agent.message.end") resolveTurn();
      },
      sessionIdGen: () => "S_today",
    });
    service.setTaskToolsProvider(() => [
      {
        ...taskListTool(taskCalls),
        invoke: async (args) => {
          taskCalls.push(args);
          return { kind: "structured", resultType: "task.list", data: loopSentinel };
        },
      },
      ...["task_create", "task_update", "task_undo"].map(
        (name): ToolHandle => ({
          name,
          description: "Task journal command",
          mutates: true,
          schema: z.object({}),
          invoke: async () => ({
            kind: "structured",
            resultType: "task.changed",
            data: loopSentinel,
          }),
        }),
      ),
    ]);
    try {
      const { sessionId } = await service.createSession("token:test", {});
      service.sendMessage("token:test", sessionId, "What's on my plate today?");
      await turnComplete;
      expect(seen).toMatchObject({ kind: "structured", data: { window: londonDay, items: [] } });
      if (knowledgeReads) {
        expect(direct).toMatchObject({ kind: "structured", data: loopSentinel });
        expect(seen).toMatchObject({
          kind: "structured",
          data: { tasks: { view: "today", ...loopSentinel } },
        });
        expect(taskCalls).toEqual([{ view: "suggested" }, { view: "today" }]);
        expect(toolNames.filter((name) => name.startsWith("task_"))).toHaveLength(4);
      } else {
        expect(direct).toBeUndefined();
        expect(taskCalls).toEqual([]);
        expect(toolNames.filter((name) => name.startsWith("task_"))).toEqual([]);
        expect(JSON.stringify(seen)).not.toContain("Maintained loop sentinel");
        if (seen?.kind === "structured") expect(seen.data).not.toHaveProperty("tasks");
      }
    } finally {
      await service.dispose();
    }
  },
);
