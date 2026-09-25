// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  createBuiltinSpecialistRegistry,
  ReplayBackend,
  type ChatBackend,
  type ToolHandle,
  type TurnInput,
} from "@omnesis/agent";
import {
  type AgentEvent,
  type CapabilityRole,
  type RateLimitPatience,
  type WsEvent,
} from "@omnesis/core";

import {
  DepthExceededError,
  SubagentService,
  TreeBudgetExceededError,
  type ResolvedSpecialist,
  type SubagentHost,
} from "./subagent-service.js";
import { deepResearchSpendMechanism } from "./spend-recorder.js";
import type { AgentSpendSample } from "./spend-recorder.js";

/** A child backend that emits one text line, one citation, usage, and ends. */
function childBackend(text: string, usage = { inputTokens: 10, outputTokens: 5 }): ChatBackend {
  const events: AgentEvent[] = [
    {
      type: "agent.message.start",
      payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: "$SESSION", messageId: "$MSG", delta: text },
    },
    {
      type: "agent.citation",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        toolCallId: "tc1",
        documentId: "doc-1",
        ref: { documentId: "doc-1", sourceType: "demo", sourceId: "demo-1" },
      },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn", usage },
    },
  ];
  return new ReplayBackend({
    fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
  });
}

/** A backend whose provider reports cumulative usage before its terminal event. */
function liveUsageChildBackend(usage = { inputTokens: 100, outputTokens: 20 }): ChatBackend {
  const events: AgentEvent[] = [
    {
      type: "agent.usage.update",
      payload: { sessionId: "$SESSION", messageId: "$MSG", usage },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn", usage },
    },
  ];
  return new ReplayBackend({
    fixtures: [{ entries: events.map((event) => ({ afterMs: 0, event })) }],
  });
}

/** A provider can send partial cumulative snapshots; the final snapshot may omit earlier fields. */
function partialLiveUsageChildBackend(): ChatBackend {
  const events: AgentEvent[] = [
    {
      type: "agent.usage.update",
      payload: { sessionId: "$SESSION", messageId: "$MSG", usage: { inputTokens: 100 } },
    },
    {
      type: "agent.usage.update",
      payload: { sessionId: "$SESSION", messageId: "$MSG", usage: { outputTokens: 10 } },
    },
    {
      type: "agent.message.end",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        stopReason: "end_turn",
        usage: { outputTokens: 20 },
      },
    },
    {
      type: "agent.message.end",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        stopReason: "end_turn",
        usage: { outputTokens: 20 },
      },
    },
  ];
  return new ReplayBackend({
    fixtures: [{ entries: events.map((event) => ({ afterMs: 0, event })) }],
  });
}

function failedChildBackend(code: "context_window_exceeded" | "output_truncated"): ChatBackend {
  const stopReason = code === "output_truncated" ? "max_tokens" : "error";
  const events: AgentEvent[] = [
    {
      type: "agent.text.delta",
      payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "partial model text" },
    },
    {
      type: "agent.message.end",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        stopReason,
        ...(code === "context_window_exceeded"
          ? {
              failure: {
                code,
                message: "prompt is too long",
                retryable: false,
                backend: "replay",
                model: "replay",
              },
            }
          : {}),
      },
    },
  ];
  return new ReplayBackend({
    fixtures: [{ entries: events.map((event) => ({ afterMs: 0, event })) }],
  });
}

function truncatedEvidenceBackend(): ChatBackend {
  const events: AgentEvent[] = [
    {
      type: "agent.text.delta",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        delta: "An unsupported draft that must not outrank deliberate evidence.",
      },
    },
    {
      type: "agent.citation",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        toolCallId: "tc1",
        documentId: "fictional-doc",
        ref: {
          documentId: "fictional-doc",
          sourceType: "fictional-notes",
          sourceId: "fictional-notes:self",
          title: "Project status",
        },
        note: "The milestone was approved.",
      },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "max_tokens" },
    },
  ];
  return new ReplayBackend({
    fixtures: [{ entries: events.map((event) => ({ afterMs: 0, event })) }],
  });
}

/** First turn is a retryable empty provider response; the second succeeds. */
function retryableEmptyThenSuccessBackend(): { backend: ChatBackend; attempts: () => number } {
  let count = 0;
  const backend: ChatBackend = {
    name: "retryable-empty",
    model: "retryable-empty",
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      count += 1;
      if (count === 1) {
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "error",
            failure: {
              code: "http_empty_response",
              message: "Model returned an empty response.",
              retryable: true,
              backend: "retryable-empty",
              model: "retryable-empty",
            },
          },
        };
        return;
      }
      yield {
        type: "agent.text.delta",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          delta: "Recovered finding",
        },
      };
      yield {
        type: "agent.message.end",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      };
    },
  };
  return { backend, attempts: () => count };
}

/**
 * A controllable backend that records when its turn STARTS and only completes
 * once {@link release} is called — lets a test observe concurrent in-flight
 * count and assert the concurrency cap bounds it.
 */
class GatedBackend implements ChatBackend {
  readonly name = "gated";
  readonly model = "gated";
  private resolve: (() => void) | undefined;

  constructor(
    private readonly onStart: () => void,
    private readonly onEnd: () => void,
    private readonly text: string,
  ) {}

  /** Resolve the in-flight turn (only one at a time per backend instance). */
  release(): void {
    this.resolve?.();
    this.resolve = undefined;
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    this.onStart();
    try {
      await new Promise<void>((r) => {
        this.resolve = r;
      });
      yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: this.text } };
      yield {
        type: "agent.message.end",
        payload: {
          sessionId,
          messageId,
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    } finally {
      this.onEnd();
    }
  }
}

interface HarnessOptions {
  depthCap?: number;
  concurrencyCap?: number;
  treeTokenBudget?: number;
  /** Backends keyed by role; absent role ⇒ resolveBackend returns null (inherit). */
  roleBackends?: Partial<Record<CapabilityRole, () => ChatBackend>>;
  parentTools?: ToolHandle[];
  parentDepth?: number;
  /** Wire the cognition-spend seam; recorded samples land in `spendSamples`. */
  captureSpend?: boolean;
  genericSystemPrompt?: (context: { timeZone?: string }) => string | Promise<string>;
  resolveSpecialist?: (name: string) => ResolvedSpecialist;
  /** The patience the host reports for every registered child. */
  rateLimitPatience?: RateLimitPatience;
}

function makeHarness(opts: HarnessOptions = {}) {
  const emitted: WsEvent[] = [];
  const built: { allowlist: ReadonlyArray<string> | undefined }[] = [];
  const registered: { parent: string; child: string }[] = [];
  const spendSamples: AgentSpendSample[] = [];
  let inheritUsed = false;

  const parentBackend = childBackend("PARENT");
  const host: SubagentHost = {
    emitEvent: (e) => emitted.push(e),
    resolveBackend: (role) => opts.roleBackends?.[role]?.() ?? null,
    parentBackend: () => {
      inheritUsed = true;
      return parentBackend;
    },
    buildGenericSubagentTools: () => {
      built.push({ allowlist: undefined });
      return opts.parentTools ?? [];
    },
    buildSpecialistSubagentTools: (allowlist) => {
      built.push({ allowlist });
      return opts.parentTools ?? [];
    },
    buildGenericSystemPrompt:
      opts.genericSystemPrompt ??
      (({ timeZone }) => `generic worker prompt${timeZone ? ` in ${timeZone}` : ""}`),
    registerChild: (parent, child) => registered.push({ parent, child }),
    depthOf: () => opts.parentDepth ?? 0,
    rateLimitPatienceOf: () => opts.rateLimitPatience,
  };

  const resolveSpecialist =
    opts.resolveSpecialist ??
    ((name: string): ResolvedSpecialist => ({
      name,
      systemPrompt: "you are a sub-agent",
      modelRole: "subagent-fanout",
    }));

  const service = new SubagentService({
    host,
    resolveSpecialist,
    depthCap: opts.depthCap ?? 2,
    concurrencyCap: opts.concurrencyCap ?? 4,
    treeTokenBudget: opts.treeTokenBudget,
    ...(opts.captureSpend ? { recordSpend: (sample) => spendSamples.push(sample) } : {}),
  });

  return { service, emitted, built, registered, spendSamples, didInherit: () => inheritUsed };
}

/** Spawn + immediately join one child; returns the single collected result. */
async function spawnAndJoin(
  service: SubagentService,
  input: { parentSessionId: string; specialist?: string; task: string; title?: string },
) {
  const handle = await service.spawn(input);
  const joined = await service.join({
    parentSessionId: input.parentSessionId,
    subagentIds: [handle.subagentId],
  });
  return { handle, joined, result: joined.results[0]! };
}

describe("SubagentService", () => {
  it("launches a child, returns a running handle, and emits the three events on join", async () => {
    const { service, emitted, registered } = makeHarness({
      roleBackends: { "subagent-fanout": () => childBackend("FINDING") },
    });

    const { handle, joined, result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      specialist: "history-sweep",
      task: "sweep the last month",
    });

    // The launch handle carries identity + a transient status, no finding yet.
    expect(handle.subagentId).toBe("S_parent.sub.1");
    expect(handle.specialist).toBe("history-sweep");

    expect(result.status).toBe("complete");
    expect(result.summary).toBe("FINDING");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.documentId).toBe("doc-1");

    // Per-tree aggregate is present on the join.
    expect(joined.treeUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });

    // The child was registered for recursive eviction under its parent.
    expect(registered).toEqual([{ parent: "S_parent", child: "S_parent.sub.1" }]);

    const kinds = emitted.map((e) => e.type);
    expect(kinds[0]).toBe("agent.subagent.spawned");
    expect(kinds).toContain("agent.subagent.event");
    expect(kinds[kinds.length - 1]).toBe("agent.subagent.result");

    const resultEvent = emitted.find((e) => e.type === "agent.subagent.result");
    expect(resultEvent?.payload).toMatchObject({
      subagentId: "S_parent.sub.1",
      specialist: "history-sweep",
      status: "complete",
      summary: "FINDING",
    });
    expect((resultEvent?.payload as { usage?: { inputTokens?: number } }).usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    // The result event carries the per-tree aggregate too.
    expect(
      (resultEvent?.payload as { treeUsage?: { inputTokens?: number } }).treeUsage,
    ).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("does not let one parent join another parent's child", async () => {
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => childBackend("PRIVATE") },
    });
    const child = await service.spawn({
      parentSessionId: "S_owner",
      specialist: "history-sweep",
      title: "owned",
      task: "owned",
    });

    const foreignJoin = await service.join({
      parentSessionId: "S_other",
      subagentIds: [child.subagentId],
    });
    expect(foreignJoin.results[0]).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("was launched by this parent"),
    });

    const ownerJoin = await service.join({
      parentSessionId: "S_owner",
      subagentIds: [child.subagentId],
    });
    expect(ownerJoin.results[0]).toMatchObject({ status: "complete", summary: "PRIVATE" });
  });

  it("inherits the parent's backend when the sub-agent role is unassigned (no hard refusal)", async () => {
    const { service, didInherit } = makeHarness();
    const { result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      specialist: "history-sweep",
      task: "no role assigned",
    });
    expect(didInherit()).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("PARENT");
  });

  it("resolves the assigned role's backend when one is configured", async () => {
    const { service, didInherit } = makeHarness({
      roleBackends: { "subagent-fanout": () => childBackend("ROLE-MODEL") },
    });
    const { result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      specialist: "history-sweep",
      task: "role assigned",
    });
    expect(didInherit()).toBe(false);
    expect(result.summary).toBe("ROLE-MODEL");
  });

  it("fails the child instead of inheriting when an explicitly assigned role is unsupported", async () => {
    const { service, didInherit } = makeHarness({
      roleBackends: {
        "subagent-fanout": () => {
          throw new Error("Codex backend is only supported for the main agent in V1");
        },
      },
    });
    const { result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      specialist: "history-sweep",
      task: "explicit unsupported role",
    });

    expect(didInherit()).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Codex backend is only supported");
  });

  it.each(["context_window_exceeded", "output_truncated"] as const)(
    "does not report a %s child as complete",
    async (code) => {
      const { service, emitted } = makeHarness({
        roleBackends: { "subagent-fanout": () => failedChildBackend(code) },
      });

      const { result } = await spawnAndJoin(service, {
        parentSessionId: "S_parent",
        specialist: "history-sweep",
        task: "inspect fictional records",
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: { code, retryable: false },
      });
      if (code === "output_truncated") {
        expect(result.summary).toContain("Partial finding");
        expect(result.summary).toContain("partial model text");
      } else {
        expect(result.summary).toContain(code);
        expect(result.summary).not.toContain("partial model text");
      }
      expect(result.summary).not.toContain("returned no text");
      expect(
        emitted.find((event) => event.type === "agent.subagent.result")?.payload,
      ).toMatchObject({ status: "failed", failure: { code } });
    },
  );

  it("returns bounded annotated evidence when truncation leaves no final text", async () => {
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => truncatedEvidenceBackend() },
    });
    const { result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      specialist: "history-sweep",
      task: "inspect fictional records",
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "output_truncated" },
      citations: [{ documentId: "fictional-doc" }],
    });
    expect(result.summary).toContain("Partial evidence collected");
    expect(result.summary).toContain("Project status: The milestone was approved.");
    expect(result.summary).not.toContain("unsupported draft");
    expect(result.summary.length).toBeLessThanOrEqual(2_000);
  });

  it("retries one retryable empty child response before marking the researcher failed", async () => {
    const retry = retryableEmptyThenSuccessBackend();
    const { service } = makeHarness({ roleBackends: { "subagent-fanout": () => retry.backend } });

    const { result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      specialist: "history-sweep",
      task: "inspect fictional records",
    });

    expect(retry.attempts()).toBe(2);
    expect(result).toMatchObject({ status: "complete", summary: "Recovered finding" });
  });

  it("throws DepthExceededError when spawning would exceed the depth cap (depth-3 refused)", async () => {
    // Parent already at depth 2 with a cap of 2 ⇒ a child would be depth 3.
    const { service } = makeHarness({ depthCap: 2, parentDepth: 2 });
    await expect(
      service.spawn({ parentSessionId: "S_parent", specialist: "x", task: "too deep" }),
    ).rejects.toBeInstanceOf(DepthExceededError);
  });

  it("allows a depth-2 spawn (parent at depth 1, cap 2)", async () => {
    const { service } = makeHarness({
      depthCap: 2,
      parentDepth: 1,
      roleBackends: { "subagent-fanout": () => childBackend("DEPTH2") },
    });
    const { result } = await spawnAndJoin(service, {
      parentSessionId: "S_parent.sub.x",
      specialist: "x",
      task: "depth-2 ok",
    });
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("DEPTH2");
  });

  it("uses the host's fixed generic tool policy when no private profile is supplied", async () => {
    const { service, built } = makeHarness();
    await spawnAndJoin(service, {
      parentSessionId: "S_parent",
      task: "t",
    });
    expect(built).toHaveLength(1);
    expect(built[0]?.allowlist).toBeUndefined();
  });

  it("applies real private Deep Research prompts and host-owned tool profiles", async () => {
    const registry = createBuiltinSpecialistRegistry();
    const prompts: string[] = [];
    const { service, built } = makeHarness({
      resolveSpecialist: (name) => registry.resolve(name),
      roleBackends: {
        agent: () => ({
          name: "recording",
          model: "recording",
          async *runTurn(input): AsyncIterable<AgentEvent> {
            prompts.push(input.systemPrompt);
            yield {
              type: "agent.message.end",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                stopReason: "end_turn",
              },
            };
          },
        }),
      },
    });

    await spawnAndJoin(service, {
      parentSessionId: "S",
      specialist: "research-planner",
      task: "plan",
    });
    await spawnAndJoin(service, {
      parentSessionId: "S",
      specialist: "history-sweep",
      task: "read",
    });

    expect(prompts[0]).toContain("research-planner specialist");
    expect(prompts[1]).toContain("history-sweep specialist");
    expect(built[0]?.allowlist).toEqual([]);
    expect(built[1]?.allowlist).toEqual([
      "search_many",
      "fetch_many",
      "trace_connections",
      "annotate_many",
    ]);
  });

  it("settles a prompt-build failure and releases its concurrency slot", async () => {
    let attempts = 0;
    const { service } = makeHarness({
      concurrencyCap: 1,
      genericSystemPrompt: () => {
        attempts++;
        if (attempts === 1) throw new Error("catalog unavailable");
        return "recovered generic prompt";
      },
    });

    const first = await service.spawn({ parentSessionId: "S", title: "first", task: "first" });
    const firstJoin = await service.join({
      parentSessionId: "S",
      subagentIds: [first.subagentId],
    });
    expect(firstJoin.results[0]).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("catalog unavailable"),
    });

    const second = await service.spawn({ parentSessionId: "S", title: "second", task: "second" });
    const secondJoin = await service.join({
      parentSessionId: "S",
      subagentIds: [second.subagentId],
    });
    expect(secondJoin.results[0]).toMatchObject({ status: "complete", summary: "PARENT" });
  });

  it("runs spawns concurrently in parallel (multiple in-flight at once)", async () => {
    let active = 0;
    let maxActive = 0;
    const backends: GatedBackend[] = [];
    const { service } = makeHarness({
      concurrencyCap: 4,
      roleBackends: {
        "subagent-fanout": () => {
          const b = new GatedBackend(
            () => {
              active++;
              maxActive = Math.max(maxActive, active);
            },
            () => {
              active--;
            },
            "x",
          );
          backends.push(b);
          return b;
        },
      },
    });

    const handles = await Promise.all([
      service.spawn({ parentSessionId: "S", specialist: "a", task: "1" }),
      service.spawn({ parentSessionId: "S", specialist: "a", task: "2" }),
      service.spawn({ parentSessionId: "S", specialist: "a", task: "3" }),
    ]);
    // Let all three start.
    await tick(5);
    expect(maxActive).toBe(3); // genuinely concurrent
    backends.forEach((b) => b.release());

    const joined = await service.join({
      parentSessionId: "S",
      subagentIds: handles.map((h) => h.subagentId),
    });
    expect(joined.results).toHaveLength(3);
    expect(joined.results.every((r) => r.status === "complete")).toBe(true);
  });

  it("bounds in-flight sub-agents by the concurrency cap (cap=2, 4 spawns)", async () => {
    let active = 0;
    let maxActive = 0;
    const order: GatedBackend[] = [];
    const { service } = makeHarness({
      concurrencyCap: 2,
      roleBackends: {
        "subagent-fanout": () => {
          const b = new GatedBackend(
            () => {
              active++;
              maxActive = Math.max(maxActive, active);
            },
            () => {
              active--;
            },
            "x",
          );
          order.push(b);
          return b;
        },
      },
    });

    const handles = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        service.spawn({ parentSessionId: "S", specialist: "a", task: `${n}` }),
      ),
    );
    await tick(5);
    // Only two may be in-flight at once.
    expect(maxActive).toBe(2);
    expect(active).toBe(2);

    // Release the first two; the queued two then start.
    order[0]!.release();
    order[1]!.release();
    await tick(5);
    expect(maxActive).toBe(2); // never exceeded
    order[2]!.release();
    order[3]!.release();

    const joined = await service.join({
      parentSessionId: "S",
      subagentIds: handles.map((h) => h.subagentId),
    });
    expect(joined.results).toHaveLength(4);
    expect(joined.results.every((r) => r.status === "complete")).toBe(true);
  });

  it("cancels a queued child without starting it and reuses the slot", async () => {
    const backends: GatedBackend[] = [];
    const { service } = makeHarness({
      concurrencyCap: 1,
      roleBackends: {
        "subagent-fanout": () => {
          const backend = new GatedBackend(
            () => {},
            () => {},
            "done",
          );
          backends.push(backend);
          return backend;
        },
      },
    });
    const first = await service.spawn({ parentSessionId: "S", specialist: "a", task: "first" });
    await tick(3);

    const controller = new AbortController();
    const queued = await service.spawn({
      parentSessionId: "S",
      specialist: "a",
      task: "queued",
      signal: controller.signal,
    });
    controller.abort();
    const cancelled = await service.join({
      parentSessionId: "S",
      subagentIds: [queued.subagentId],
    });
    expect(cancelled.results[0]).toMatchObject({ status: "failed" });
    expect(backends).toHaveLength(1);

    backends[0]!.release();
    await service.join({ parentSessionId: "S", subagentIds: [first.subagentId] });
    const third = await service.spawn({ parentSessionId: "S", specialist: "a", task: "third" });
    await tick(3);
    expect(backends).toHaveLength(2);
    backends[1]!.release();
    await service.join({ parentSessionId: "S", subagentIds: [third.subagentId] });
  });

  it("cancels during generic prompt construction and releases the slot", async () => {
    let promptAttempt = 0;
    const never = new Promise<string>(() => {});
    const { service } = makeHarness({
      concurrencyCap: 1,
      genericSystemPrompt: () => (++promptAttempt === 1 ? never : "ready"),
    });
    const controller = new AbortController();
    const first = await service.spawn({
      parentSessionId: "S",
      task: "first",
      signal: controller.signal,
    });
    await tick(3);
    controller.abort();
    const cancelled = await service.join({
      parentSessionId: "S",
      subagentIds: [first.subagentId],
    });
    expect(cancelled.results[0]).toMatchObject({ status: "failed" });

    const second = await service.spawn({ parentSessionId: "S", task: "second" });
    const completed = await service.join({
      parentSessionId: "S",
      subagentIds: [second.subagentId],
    });
    expect(completed.results[0]).toMatchObject({ status: "complete", summary: "PARENT" });
  });

  it("join awaits a mixed set (some finished, some in-flight)", async () => {
    const gated = new GatedBackend(
      () => {},
      () => {},
      "SLOW",
    );
    let useGated = false;
    const { service } = makeHarness({
      roleBackends: {
        "subagent-fanout": () => (useGated ? gated : childBackend("FAST")),
      },
    });

    // First child finishes immediately.
    const fast = await service.spawn({ parentSessionId: "S", specialist: "a", task: "fast" });
    await tick(3);
    // Second child is gated (in-flight).
    useGated = true;
    const slow = await service.spawn({ parentSessionId: "S", specialist: "a", task: "slow" });
    await tick(3);

    // Kick off the join, then release the slow child.
    const joinPromise = service.join({
      parentSessionId: "S",
      subagentIds: [fast.subagentId, slow.subagentId],
    });
    gated.release();
    const joined = await joinPromise;

    expect(joined.results).toHaveLength(2);
    expect(joined.results.find((r) => r.subagentId === fast.subagentId)?.summary).toBe("FAST");
    expect(joined.results.find((r) => r.subagentId === slow.subagentId)?.summary).toBe("SLOW");
  });

  it("aggregates the per-tree token total as the sum of child usages", async () => {
    const { service } = makeHarness({
      roleBackends: {
        "subagent-fanout": () => childBackend("c", { inputTokens: 100, outputTokens: 20 }),
      },
    });
    const a = await service.spawn({ parentSessionId: "S", specialist: "a", task: "1" });
    const b = await service.spawn({ parentSessionId: "S", specialist: "a", task: "2" });
    const joined = await service.join({
      parentSessionId: "S",
      subagentIds: [a.subagentId, b.subagentId],
    });
    // Two children, each 120 billable tokens ⇒ 240 tree total.
    expect(joined.treeUsage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
  });

  it("accounts a live cumulative usage update only once when the child ends", async () => {
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => liveUsageChildBackend() },
    });
    const child = await service.spawn({ parentSessionId: "S", specialist: "a", task: "1" });
    const joined = await service.join({ parentSessionId: "S", subagentIds: [child.subagentId] });
    expect(joined.treeUsage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });

  it("merges partial cumulative usage and ignores a duplicate child terminal event", async () => {
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => partialLiveUsageChildBackend() },
    });
    const child = await service.spawn({ parentSessionId: "S", specialist: "a", task: "1" });
    const joined = await service.join({ parentSessionId: "S", subagentIds: [child.subagentId] });
    expect(joined.treeUsage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });

  it("NEGATIVE CONTROL: trips the tree-token budget with an honest named reason, no silent stop", async () => {
    // Budget of 150; each child spends 120. The first child fits (tree=120);
    // the second pushes the tree over (240 ≥ 150) and must be stopped.
    const { service, emitted } = makeHarness({
      treeTokenBudget: 150,
      roleBackends: {
        "subagent-fanout": () => childBackend("c", { inputTokens: 100, outputTokens: 20 }),
      },
    });

    const first = await service.spawn({ parentSessionId: "S", specialist: "a", task: "1" });
    await tick(5);
    // Now the budget has tripped after the first child's 120 < 150 — actually it
    // hasn't yet (120 < 150). Spawn a second; it pushes the tree to 240 ≥ 150.
    const second = await service.spawn({ parentSessionId: "S", specialist: "a", task: "2" });
    await tick(5);

    // A third spawn must be REFUSED outright once the budget tripped.
    await expect(
      service.spawn({ parentSessionId: "S", specialist: "a", task: "3" }),
    ).rejects.toBeInstanceOf(TreeBudgetExceededError);

    const joined = await service.join({
      parentSessionId: "S",
      subagentIds: [first.subagentId, second.subagentId],
    });
    // The named reason is present — not a silent stop.
    expect(joined.stoppedReason).toContain("budget");
    expect(joined.stoppedReason).toContain("150");
    // The result event for at least one child carries budget_exhausted.
    const statuses = emitted
      .filter((e) => e.type === "agent.subagent.result")
      .map((e) => (e.payload as { status: string }).status);
    expect(statuses).toContain("budget_exhausted");
  });

  it("forgets completed tree and budget state when a parent is evicted", async () => {
    const { service } = makeHarness({
      treeTokenBudget: 100,
      roleBackends: {
        "subagent-fanout": () => childBackend("c", { inputTokens: 100, outputTokens: 20 }),
      },
    });
    await spawnAndJoin(service, { parentSessionId: "S", specialist: "a", task: "first" });
    await expect(
      service.spawn({ parentSessionId: "S", specialist: "a", task: "blocked" }),
    ).rejects.toBeInstanceOf(TreeBudgetExceededError);

    service.forgetTree("S");
    const replacement = await service.spawn({
      parentSessionId: "S",
      specialist: "a",
      task: "fresh conversation",
    });
    const joined = await service.join({
      parentSessionId: "S",
      subagentIds: [replacement.subagentId],
    });
    expect(joined.results[0]).toMatchObject({
      subagentId: replacement.subagentId,
      status: "budget_exhausted",
    });
  });

  it("retires a running tree before reusing the same session id", async () => {
    let active = 0;
    let maxActive = 0;
    const backends: GatedBackend[] = [];
    const { service, emitted } = makeHarness({
      concurrencyCap: 1,
      roleBackends: {
        "subagent-fanout": () => {
          const backend = new GatedBackend(
            () => {
              active++;
              maxActive = Math.max(maxActive, active);
            },
            () => active--,
            "done",
          );
          backends.push(backend);
          return backend;
        },
      },
    });
    const old = await service.spawn({ parentSessionId: "S", specialist: "a", task: "old" });
    await tick(3);
    expect(active).toBe(1);

    emitted.length = 0;
    service.forgetTree("S");
    const replacement = await service.spawn({
      parentSessionId: "S",
      specialist: "a",
      task: "replacement",
    });
    await tick(3);
    expect(backends).toHaveLength(1);

    backends[0]!.release();
    await tick(5);
    expect(backends).toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(
      emitted.some(
        (event) => "subagentId" in event.payload && event.payload.subagentId === old.subagentId,
      ),
    ).toBe(false);

    backends[1]!.release();
    const joined = await service.join({
      parentSessionId: "S",
      subagentIds: [replacement.subagentId],
    });
    expect(joined.results[0]).toMatchObject({ status: "complete", summary: "done" });
  });

  describe("cognition-spend recording", () => {
    it("records one sample per completed child under the default subagent label", async () => {
      const { service, spendSamples } = makeHarness({
        captureSpend: true,
        roleBackends: {
          "subagent-fanout": () =>
            childBackend("FINDING", { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 }),
        },
      });

      await spawnAndJoin(service, { parentSessionId: "S", specialist: "a", task: "go" });

      expect(spendSamples).toEqual([
        {
          mechanism: "subagent",
          modelId: "replay",
          usage: {
            inputTokens: 100,
            outputTokens: 25,
            cacheReadTokens: 40,
            cacheCreationTokens: 0,
          },
          completed: true,
        },
      ]);
    });

    it("labels a child with the spawn's spendMechanism (deep-research stages)", async () => {
      const { service, spendSamples } = makeHarness({
        captureSpend: true,
        roleBackends: { "subagent-fanout": () => childBackend("PLAN") },
      });

      const handle = await service.spawn({
        parentSessionId: "S",
        specialist: "research-planner",
        task: "decompose",
        spendMechanism: deepResearchSpendMechanism("research-planner"),
      });
      await service.join({ parentSessionId: "S", subagentIds: [handle.subagentId] });

      // The value the pipeline actually passes reaches the spend seam intact,
      // so each stage resolves separately rather than into one bucket.
      expect(spendSamples).toHaveLength(1);
      expect(spendSamples[0]!.mechanism).toBe("deep-research:research-planner");
    });

    it("folds a failed child's intermediate reported tokens as not-completed", async () => {
      class FailAfterUsageBackend implements ChatBackend {
        readonly name = "failing";
        readonly model = "half-broken-model";

        async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
          const { sessionId, messageId } = input;
          yield {
            type: "agent.message.start",
            payload: { sessionId, messageId, role: "assistant" },
          };
          yield {
            type: "agent.message.end",
            payload: {
              sessionId,
              messageId,
              stopReason: "tool_use",
              usage: { inputTokens: 9, outputTokens: 4 },
            },
          };
          throw new Error("backend fell over mid-run");
        }
      }
      const { service, spendSamples } = makeHarness({
        captureSpend: true,
        roleBackends: { "subagent-fanout": () => new FailAfterUsageBackend() },
      });

      const { result } = await spawnAndJoin(service, {
        parentSessionId: "S",
        specialist: "a",
        task: "go",
      });

      expect(result.status).toBe("failed");
      expect(spendSamples).toEqual([
        {
          mechanism: "subagent",
          modelId: "half-broken-model",
          usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
          completed: false,
        },
      ]);
    });

    it("records nothing for a child whose backend reported no usage", async () => {
      const { service, spendSamples } = makeHarness({
        captureSpend: true,
        roleBackends: {
          "subagent-fanout": () => {
            const events: AgentEvent[] = [
              {
                type: "agent.message.start",
                payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
              },
              {
                type: "agent.message.end",
                payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
              },
            ];
            return new ReplayBackend({
              fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
            });
          },
        },
      });

      await spawnAndJoin(service, { parentSessionId: "S", specialist: "a", task: "go" });

      expect(spendSamples).toEqual([]);
    });
  });
});

describe("SubagentService — rate-limit patience", () => {
  function patienceRecordingBackend(seen: Array<TurnInput["rateLimitPatience"]>): ChatBackend {
    return {
      name: "recording",
      model: "recording",
      async *runTurn(input): AsyncIterable<AgentEvent> {
        seen.push(input.rateLimitPatience);
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
  }

  it("runs a child with the patience its tree runs with", async () => {
    const seen: Array<TurnInput["rateLimitPatience"]> = [];
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => patienceRecordingBackend(seen) },
      rateLimitPatience: { maxAttempts: 5, maxTotalDelayMs: 180_000 },
    });

    await service.spawn({ parentSessionId: "S", specialist: "a", title: "t", task: "sweep" });
    await service.join({ parentSessionId: "S", subagentIds: ["S.sub.1"] });

    expect(seen).toEqual([{ maxAttempts: 5, maxTotalDelayMs: 180_000 }]);
  });

  it("leaves a child of an interactive tree on the backend default", async () => {
    const seen: Array<TurnInput["rateLimitPatience"]> = [];
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => patienceRecordingBackend(seen) },
    });

    await service.spawn({ parentSessionId: "S", specialist: "a", title: "t", task: "sweep" });
    await service.join({ parentSessionId: "S", subagentIds: ["S.sub.1"] });

    expect(seen).toEqual([undefined]);
  });
});

describe("SubagentService — the caller's time zone", () => {
  /** A backend that records the TurnInput its child was driven with. */
  function zoneRecordingBackend(): { backend: ChatBackend; seen: () => string | undefined } {
    let seen: string | undefined;
    return {
      seen: () => seen,
      backend: {
        name: "recording",
        model: "recording",
        async *runTurn(input): AsyncIterable<AgentEvent> {
          seen = input.timeZone;
          yield {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "end_turn",
            },
          };
        },
      },
    };
  }

  // A delegated sweep over "this week" has to read the same calendar the user
  // is looking at, so the spawning turn's zone travels with the spawn.
  it("hands a child the zone carried on the spawn", async () => {
    const { backend, seen } = zoneRecordingBackend();
    const { service } = makeHarness({ roleBackends: { "subagent-fanout": () => backend } });

    await service.spawn({
      parentSessionId: "S",
      specialist: "a",
      title: "t",
      task: "what's on",
      timeZone: "Asia/Tokyo",
    });
    await service.join({ parentSessionId: "S", subagentIds: ["S.sub.1"] });

    expect(seen()).toBe("Asia/Tokyo");
  });

  // The zone rides the spawn rather than being looked up by parent id, so it
  // survives a level of nesting — a grandchild's parent is itself a sub-agent
  // and has no entry among the user's live sessions to look up.
  it("carries the zone to a grandchild, whose parent is not a live user session", async () => {
    const { backend, seen } = zoneRecordingBackend();
    const { service } = makeHarness({
      parentDepth: 1,
      roleBackends: { "subagent-fanout": () => backend },
    });

    await service.spawn({
      parentSessionId: "S.sub.1",
      specialist: "a",
      title: "t",
      task: "sweep",
      timeZone: "Asia/Tokyo",
    });
    await service.join({ parentSessionId: "S.sub.1", subagentIds: ["S.sub.1.sub.1"] });

    expect(seen()).toBe("Asia/Tokyo");
  });

  // The child's specialist prompt is a static string that knows nothing about
  // who is asking; without the grounding block it would convert times wrongly
  // and hand the error back to the parent to relay.
  it("grounds the child's prompt in the same zone as its tools", async () => {
    const prompts: string[] = [];
    const { service } = makeHarness({
      roleBackends: {
        "subagent-fanout": () => ({
          name: "recording",
          model: "recording",
          async *runTurn(input): AsyncIterable<AgentEvent> {
            prompts.push(input.systemPrompt);
            yield {
              type: "agent.message.end",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                stopReason: "end_turn",
              },
            };
          },
        }),
      },
    });

    await service.spawn({
      parentSessionId: "S",
      specialist: "a",
      title: "t",
      task: "sweep",
      timeZone: "Asia/Tokyo",
    });
    await service.join({ parentSessionId: "S", subagentIds: ["S.sub.1"] });

    expect(prompts[0]).toContain("Asia/Tokyo");
  });

  it("leaves a child unzoned when the spawning turn carried none", async () => {
    const { backend, seen } = zoneRecordingBackend();
    const { service } = makeHarness({
      roleBackends: { "subagent-fanout": () => backend },
    });

    await spawnAndJoin(service, { parentSessionId: "S", specialist: "a", task: "what's on" });

    expect(seen()).toBeUndefined();
  });
});

/** Flush microtasks/timers a few times so background runs progress. */
async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}
