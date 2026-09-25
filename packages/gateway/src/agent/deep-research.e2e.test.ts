// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic deep-research replay scenario (#748) — the headline test.
 *
 * Reproduces a multi-sub-agent Deep Research run fully deterministically in CI:
 * synthetic sub-agent transcripts (planner + two readers) AND a synthetic final
 * report (the synthesis child), no live model and no live corpus. It drives the
 * REAL `AgentService` → `DeepResearchService` → `SubagentService` path with the
 * `deepResearch` flag set, and asserts the loop:
 *   - plans (the planner's fenced-JSON decomposition is parsed),
 *   - fans out (one reader sub-agent per planned task, in parallel),
 *   - verifies citations (against the synthetic document port),
 *   - synthesises a cited answer over the verified findings,
 *   - emits an honest `stoppedReason`,
 *   - produces a SINGLE merged citation set (deduped, no sub-agent attribution),
 *   - writes back exactly ONE omnesis-chat document — and ZERO intermediate
 *     sub-agent documents.
 *
 * It also exercises the negative controls: the avoidable-spawns metric fires on
 * a deliberately-thin reader, and a simple (non-deep-research) query never
 * spawns a sub-agent.
 *
 * All data is invented (a fictional Q4 budget review / marathon-entry topic) —
 * never sourced from any real corpus (frozen privacy constraint, #748).
 */

import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ReplayBackend,
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type TurnInput,
} from "@omnesis/agent";
import { type AgentEvent, type CapabilityRole, type WsEvent } from "@omnesis/core";

import { AgentService } from "./service.js";
import { DEEP_RESEARCH_NO_EVIDENCE_MESSAGES } from "./deep-research.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ResolvedSpecialist } from "./subagent-service.js";

const tempDirs: string[] = [];

// ── synthetic corpus (invented; never from a real corpus) ──────────────────

const DOC_BUDGET = "syn-doc-q4-budget";
const DOC_MARATHON = "syn-doc-marathon-entry";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};

/** A document port serving two invented documents with verbatim bodies. */
const fakeDocumentPort: DocumentPort = {
  async fetch(documentId) {
    if (documentId === DOC_BUDGET) {
      return {
        ref: { documentId: DOC_BUDGET, sourceType: "demo-mail", sourceId: "demo-mail:self" },
        document: {
          content:
            "Q4 budget review: the infrastructure line is approved at 42,000 and " +
            "the events line is held flat. Sign-off due by the end of the month.",
        },
      };
    }
    if (documentId === DOC_MARATHON) {
      return {
        ref: { documentId: DOC_MARATHON, sourceType: "demo-mail", sourceId: "demo-mail:self" },
        document: {
          content:
            "Riverside Marathon entry confirmed for the spring race. Bib pickup " +
            "opens the Friday before; the start wave is at 8am.",
        },
      };
    }
    return null;
  },
};

// ── scripted sub-agent backends (the deterministic "cassette") ─────────────

/**
 * One scripted child turn → a `ReplayBackend` fixture. The orchestrator drives
 * each child with a distinct task, so we route on the task text inside the
 * backend factory below.
 */
function fixtureBackend(events: AgentEvent[]): ChatBackend {
  return new ReplayBackend({
    fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
  });
}

function assistant(delta: string): (sid: string, mid: string) => AgentEvent[] {
  return (sessionId, messageId) => [
    { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } },
    { type: "agent.text.delta", payload: { sessionId, messageId, delta } },
    { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } },
  ];
}

/**
 * A child backend that emits a scripted finding PLUS a citation. The
 * `agent.citation` event is how a reader attributes a document; the
 * SubagentService collects it into the child's `citations`.
 */
function readerBackend(
  delta: string,
  cite: { documentId: string; sourceType: string; sourceId: string },
): ChatBackend {
  return new ReplayBackendRouting((sessionId, messageId) => [
    { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } },
    { type: "agent.text.delta", payload: { sessionId, messageId, delta } },
    {
      type: "agent.citation",
      payload: {
        sessionId,
        messageId,
        toolCallId: "tc-cite",
        documentId: cite.documentId,
        ref: cite,
      },
    },
    { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } },
  ]);
}

/**
 * A tiny backend whose events are computed from the live `sessionId`/`messageId`
 * of the turn it's handed (ReplayBackend's `$SESSION`/`$MSG` substitution does
 * the same, but building events directly keeps the citation `ref` shape exact).
 */
class ReplayBackendRouting implements ChatBackend {
  readonly name = "scripted";
  readonly model = "scripted";
  constructor(private readonly build: (sessionId: string, messageId: string) => AgentEvent[]) {}
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    for (const e of this.build(input.sessionId, input.messageId)) yield e;
  }
}

/**
 * The deterministic "cassette": route each child to its scripted transcript by
 * the task text the orchestrator handed it. The planner emits a fenced-JSON
 * plan; the two readers emit findings + citations; the synthesis child emits the
 * final report.
 */
function scriptedChildBackend(task: string): ChatBackend {
  if (task.includes("Decompose this research question")) {
    // Planner — returns the fenced-JSON decomposition the loop parses.
    const plan =
      "```json\n" +
      JSON.stringify([
        {
          specialist: "history-sweep",
          title: "Budget history",
          task: "Sweep everything about the Q4 budget review.",
        },
        {
          specialist: "source-digest",
          title: "Marathon digest",
          task: "Digest recent mail about the marathon entry.",
        },
      ]) +
      "\n```";
    return new ReplayBackendRouting(assistant(plan));
  }
  if (task.includes("Q4 budget review")) {
    return readerBackend("The Q4 budget review approved the infrastructure line at 42,000.", {
      documentId: DOC_BUDGET,
      sourceType: "demo-mail",
      sourceId: "demo-mail:self",
    });
  }
  if (task.includes("marathon entry")) {
    return readerBackend("Riverside Marathon entry is confirmed for the spring race.", {
      documentId: DOC_MARATHON,
      sourceType: "demo-mail",
      sourceId: "demo-mail:self",
    });
  }
  // Default: an empty finding (used by the avoidable-spawn negative control).
  return fixtureBackend([
    {
      type: "agent.message.start",
      payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "ok" },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
    },
  ]);
}

const resolveSpecialist = (name: string): ResolvedSpecialist => ({
  name,
  systemPrompt: `you are ${name}`,
  modelRole: name === "research-planner" ? "subagent-synthesis" : "subagent-fanout",
});

/**
 * A parent `agent` backend that simply answers directly (no spawning) — used
 * for the non-deep-research negative control, and as the inert parent backend
 * the deep-research loop's children fall back to (they never use it; the
 * orchestrator drives the planner/reader/synthesis backends explicitly).
 */
class DirectAnswerBackend implements ChatBackend {
  readonly name = "direct";
  readonly model = "direct";
  sawSpawnTool = false;
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    this.sawSpawnTool = input.tools.some((t) => t.name === "spawn_subagent");
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    const evidencePacket = input.userMessage.includes("PRIVATE VERIFIED EVIDENCE PACKET");
    if (evidencePacket) {
      expect(input.userMessage).toContain(DOC_BUDGET);
      expect(input.userMessage).toContain(DOC_MARATHON);
    }
    if (evidencePacket) {
      yield {
        type: "agent.tool.start",
        payload: {
          sessionId,
          messageId,
          toolCallId: "parent-annotation",
          tool: "annotate_many",
          args: { annotations: [{ documentId: DOC_BUDGET }] },
        },
      };
      yield {
        type: "agent.tool.result",
        payload: {
          sessionId,
          messageId,
          toolCallId: "parent-annotation",
          durationMs: 1,
          result: {
            kind: "annotate.batch",
            items: [
              {
                kind: "annotate.recorded",
                documentId: DOC_BUDGET,
                ref: {
                  documentId: DOC_BUDGET,
                  sourceType: "demo-mail",
                  sourceId: "demo-mail:self",
                },
              },
            ],
          },
        },
      };
    }
    if (evidencePacket) {
      yield {
        type: "agent.text.delta",
        payload: {
          sessionId,
          messageId,
          delta: "The Q4 budget review approved the infrastructure line at 42,000.",
        },
      };
    } else {
      yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "direct answer" } };
    }
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/**
 * Build a service whose child sub-agents are routed by task text. The parent
 * `agent` role uses a fresh DirectAnswerBackend each call (the loop's children
 * resolve their role to that fallback, but the orchestrator overrides the task
 * via the specialist — we route on the task the SubagentService passes as the
 * child's first user message). We capture each spawned task here.
 */
function makeService(
  opts: {
    document?: DocumentPort;
    blockReaders?: boolean;
    /** Overrides the default cassette, keyed by the task text of each child. */
    childBackend?: (task: string) => ChatBackend;
  } = {},
) {
  const captured: WsEvent[] = [];
  const spawnedTasks: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "omnesis-deep-research-"));
  tempDirs.push(dir);
  let releaseReaders = () => {};
  const readersReady = new Promise<void>((resolve) => {
    releaseReaders = resolve;
  });

  // The SubagentService passes the child's task as its first user message. We
  // can't see the task in `backendFactory(role)`, so we install a proxy backend
  // that, on its first turn, reads `input.userMessage` (the task) and delegates
  // to the scripted backend for that task.
  const routingBackend = (): ChatBackend => ({
    name: "route",
    model: "route",
    async *runTurn(input: TurnInput, signal?: AbortSignal) {
      spawnedTasks.push(input.userMessage);
      if (opts.blockReaders && !input.userMessage.includes("Decompose this research question")) {
        await readersReady;
      }
      const real = (opts.childBackend ?? scriptedChildBackend)(input.userMessage);
      yield* real.runTurn(input, signal);
    },
  });

  const parent = new DirectAnswerBackend();
  const service = new AgentService({
    backendFactory: (role: CapabilityRole) => (role === "agent" ? parent : routingBackend()),
    ports: { search: stubSearch, document: opts.document ?? fakeDocumentPort },
    systemPrompt: "test",
    broadcastEvent: (e) => captured.push(e),
    sessionIdGen: () => "S_parent",
    idleTimeoutMs: 60_000,
    store: new FsConversationStore(dir),
    subagents: {
      resolveSpecialist,
      genericSystemPrompt: () => "generic sub-agent prompt",
      depthCap: 2,
      concurrencyCap: 4,
    },
  });
  return { service, captured, spawnedTasks, parent, dir, releaseReaders };
}

async function settle(): Promise<void> {
  // setImmediate ticks drain microtasks + the orchestrator's promise chain; a
  // couple of real timer waits let the async conversation-store fs writes
  // (writeFile + rename on the libuv pool) actually land before we assert.
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function conversationFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("Deep Research loop — deterministic replay (#748)", () => {
  afterEach(() => {
    while (tempDirs.length) {
      const d = tempDirs.pop()!;
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("hands verified evidence to the parent finalizer and only its annotation reaches Timeline", async () => {
    const { service, captured, spawnedTasks, dir } = makeService();
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "Research the Q4 budget and marathon entry", {
      deepResearch: true,
    });
    expect(() =>
      service.sendMessage("device:A", sessionId, "Start another research run", {
        deepResearch: true,
      }),
    ).toThrow("session is busy");
    // The parent conversation is committed before the asynchronous planner
    // gets a chance to fan out. Reopening it therefore never lands on an
    // empty composer, even while the research run is still live.
    const reopened = await service.createSession("device:B", { resumeFromId: sessionId });
    expect(reopened.messages).toMatchObject([
      {
        role: "user",
        parts: [{ kind: "text", text: "Research the Q4 budget and marathon entry" }],
      },
      { role: "assistant" },
    ]);
    await settle();

    // PLAN → FAN-OUT: the planner ran first, then both planned readers.
    expect(spawnedTasks.some((t) => t.includes("Decompose this research question"))).toBe(true);
    expect(spawnedTasks.some((t) => t.includes("Q4 budget review"))).toBe(true);
    expect(spawnedTasks.some((t) => t.includes("marathon entry"))).toBe(true);
    expect(spawnedTasks.some((t) => t.includes("PRIVATE VERIFIED EVIDENCE PACKET"))).toBe(false);

    // The sub-agent lifecycle events reached the parent stream.
    const kinds = captured.map((e) => e.type);
    expect(kinds).toContain("agent.subagent.spawned");
    expect(kinds).toContain("agent.subagent.result");

    // The planner is internal plumbing; only reader specialists are visible.
    const spawnedSpecialists = captured
      .filter((e) => e.type === "agent.subagent.spawned")
      .map((e) => (e.payload as { specialist: string }).specialist);
    expect(spawnedSpecialists).not.toContain("research-planner");
    expect(spawnedSpecialists).toEqual(expect.arrayContaining(["history-sweep", "source-digest"]));

    // The parent finalizer's prose streams on the existing parent turn.
    const deltas = captured
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    expect(deltas).toContain("infrastructure line at 42,000");
    expect(deltas).not.toContain("PRIVATE VERIFIED EVIDENCE PACKET");

    // Reader citations are evidence only; the parent `annotate_many` result is
    // the sole Timeline citation.
    const citations = captured.filter((e) => e.type === "agent.citation");
    expect(citations).toHaveLength(1);
    expect((citations[0]!.payload as { documentId: string }).documentId).toBe(DOC_BUDGET);

    // WRITE-BACK: exactly ONE conversation document persisted (the report), and
    // ZERO intermediate sub-agent documents (children never persist).
    const files = conversationFiles(dir);
    expect(files).toEqual(["S_parent.json"]);
  });

  it("does not persist the private evidence prompt and retains the parent annotation on reload", async () => {
    const { service, dir } = makeService();
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "Research the Q4 budget and marathon entry", {
      deepResearch: true,
    });
    await settle();

    const record = await new FsConversationStore(dir).load(sessionId);
    expect(record).not.toBeNull();
    const assistant = record!.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(JSON.stringify(record!.messages)).not.toContain("PRIVATE VERIFIED EVIDENCE PACKET");
    expect(JSON.stringify(record!.messages)).not.toContain("Riverside Marathon entry");
    const resumed = await service.createSession("device:B", { resumeFromId: sessionId });
    expect(JSON.stringify(resumed.messages)).toContain("annotate_many");
    expect(JSON.stringify(resumed.messages)).toContain(DOC_BUDGET);
  });

  it("replays active researcher cards to a tab that opens mid-run", async () => {
    const { service, captured, releaseReaders } = makeService({ blockReaders: true });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "Research the Q4 budget and marathon entry", {
      deepResearch: true,
    });
    for (
      let i = 0;
      i < 30 && !captured.some((event) => event.type === "agent.subagent.spawned");
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const reopened = await service.createSession("device:B", { resumeFromId: sessionId });
    expect(reopened.busy).toBe(true);
    expect(reopened.replayEvents?.some((event) => event.type === "agent.subagent.spawned")).toBe(
      true,
    );

    releaseReaders();
    await settle();
  });

  it("retires a canceled research run before its terminal so the conversation accepts a follow-up", async () => {
    const { service, captured, releaseReaders, dir } = makeService({ blockReaders: true });
    try {
      const { sessionId } = await service.createSession("device:A");
      const first = service.sendMessage(
        "device:A",
        sessionId,
        "Research the fictional Q4 budget and marathon entry",
        { deepResearch: true },
      );
      await waitFor(
        () => captured.some((event) => event.type === "agent.subagent.spawned"),
        "a research child to spawn before cancellation",
      );
      expect(captured.some((event) => event.type === "agent.subagent.spawned")).toBe(true);

      service.cancelSession("device:A", sessionId);
      releaseReaders();
      await waitFor(
        () =>
          captured.some(
            (event) =>
              event.type === "agent.message.end" && event.payload.messageId === first.messageId,
          ),
        "the canceled research terminal",
      );

      const firstEnds = captured.filter(
        (event) =>
          event.type === "agent.message.end" && event.payload.messageId === first.messageId,
      );
      expect(firstEnds).toHaveLength(1);
      expect(firstEnds[0]).toMatchObject({ payload: { stopReason: "canceled" } });
      // A canceled run answers with nothing at all — not with a no-evidence
      // sentence. Asserting the whole parent stream is silent is what makes
      // this a real check: "contains none of the eight sentences" would also
      // hold if the turn had emitted some other text.
      expect(
        captured
          .filter((event) => event.type === "agent.text.delta")
          .map((event) => event.payload.delta)
          .join(""),
      ).toBe("");

      const reopened = await service.createSession("device:B", { resumeFromId: sessionId });
      expect(reopened.busy).toBe(false);
      const followUp = service.sendMessage("device:B", sessionId, "Give me a concise follow-up");
      await waitFor(
        () =>
          captured.some(
            (event) =>
              event.type === "agent.message.end" && event.payload.messageId === followUp.messageId,
          ),
        "the follow-up terminal",
      );
      expect(captured).toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining({
            messageId: followUp.messageId,
            stopReason: "end_turn",
          }),
        }),
      );

      await waitFor(
        async () =>
          (await new FsConversationStore(dir).load(sessionId))?.messages.filter(
            (message) => message.role === "user",
          ).length === 2,
        "the durable follow-up transcript",
      );
    } finally {
      releaseReaders();
      await service.dispose();
    }
  });

  it("keeps active research busy for eviction and releases it after settlement", async () => {
    const { service, captured, releaseReaders } = makeService({ blockReaders: true });
    try {
      const { sessionId } = await service.createSession("device:A");
      const run = service.sendMessage("device:A", sessionId, "Research the fictional Q4 budget", {
        deepResearch: true,
      });
      await waitFor(
        () => captured.some((event) => event.type === "agent.subagent.spawned"),
        "an active research child",
      );

      service.evictForCaller("device:A");
      expect(service.sessionCount()).toBe(1);
      expect(() => service.sendMessage("device:A", sessionId, "Premature follow-up")).toThrow(
        "session is busy",
      );

      service.cancelSession("device:A", sessionId);
      releaseReaders();
      await waitFor(
        () =>
          captured.some(
            (event) =>
              event.type === "agent.message.end" && event.payload.messageId === run.messageId,
          ),
        "research settlement before eviction",
      );
      service.evictForCaller("device:A");
      await waitFor(() => service.sessionCount() === 0, "the settled session to evict");
    } finally {
      releaseReaders();
      await service.dispose();
    }
  });

  it("dispose aborts and awaits active research before clearing its parent", async () => {
    const { service, captured, releaseReaders } = makeService({ blockReaders: true });
    let disposal: Promise<void> | undefined;
    try {
      const { sessionId } = await service.createSession("device:A");
      const run = service.sendMessage("device:A", sessionId, "Research the fictional Q4 budget", {
        deepResearch: true,
      });
      await waitFor(
        () => captured.some((event) => event.type === "agent.subagent.spawned"),
        "an active research child",
      );

      let disposed = false;
      disposal = service.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);

      releaseReaders();
      await disposal;
      expect(service.sessionCount()).toBe(0);
      expect(
        captured.filter(
          (event) =>
            event.type === "agent.message.end" && event.payload.messageId === run.messageId,
        ),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ stopReason: "canceled" }) }),
      ]);
    } finally {
      releaseReaders();
      await disposal;
      if (!disposal) await service.dispose();
    }
  });

  it("emits one error terminal and accepts a durable follow-up after unexpected research failure", async () => {
    const { service, captured, dir } = makeService();
    const research = (
      service as unknown as {
        deepResearchService: { run: () => Promise<never> };
      }
    ).deepResearchService;
    research.run = () => {
      throw new Error("synthetic orchestration failure");
    };
    try {
      const { sessionId } = await service.createSession("device:A");
      const failed = service.sendMessage("device:A", sessionId, "Research a fictional budget", {
        deepResearch: true,
      });
      await waitFor(
        () =>
          captured.some(
            (event) =>
              event.type === "agent.message.end" && event.payload.messageId === failed.messageId,
          ),
        "the failed research terminal",
      );
      expect(
        captured.filter(
          (event) => event.type === "agent.error" && event.payload.messageId === failed.messageId,
        ),
      ).toHaveLength(1);
      expect(
        captured.filter(
          (event) =>
            event.type === "agent.message.end" && event.payload.messageId === failed.messageId,
        ),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ stopReason: "error" }) }),
      ]);

      const reopened = await service.createSession("device:B", { resumeFromId: sessionId });
      expect(reopened.busy).toBe(false);
      const followUp = service.sendMessage("device:B", sessionId, "Give me a direct answer");
      await waitFor(
        () =>
          captured.some(
            (event) =>
              event.type === "agent.message.end" && event.payload.messageId === followUp.messageId,
          ),
        "the post-failure follow-up",
      );
      await waitFor(
        async () =>
          (await new FsConversationStore(dir).load(sessionId))?.messages.filter(
            (message) => message.role === "user",
          ).length === 2,
        "the durable post-failure follow-up",
      );
    } finally {
      await service.dispose();
    }
  });

  it("flags an avoidable spawn (a thin reader) and still merges the useful one", async () => {
    // A planner that decomposes into one useful reader + one deliberately thin
    // reader (no citation, trivial finding) — the avoidable-spawns metric should
    // flag the thin one.
    const captured: WsEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "omnesis-deep-research-thin-"));
    tempDirs.push(dir);
    const routingBackend = (): ChatBackend => ({
      name: "route",
      model: "route",
      async *runTurn(input: TurnInput, signal?: AbortSignal) {
        const task = input.userMessage;
        let real: ChatBackend;
        if (task.includes("Decompose this research question")) {
          const plan =
            "```json\n" +
            JSON.stringify([
              {
                specialist: "history-sweep",
                title: "Budget history",
                task: "Sweep everything about the Q4 budget review.",
              },
              {
                specialist: "source-digest",
                title: "Plant roster",
                task: "Check the office plant roster.",
              },
            ]) +
            "\n```";
          real = new ReplayBackendRouting(assistant(plan));
        } else if (task.includes("Q4 budget review")) {
          real = readerBackend("The Q4 budget review approved infrastructure at 42,000.", {
            documentId: DOC_BUDGET,
            sourceType: "demo-mail",
            sourceId: "demo-mail:self",
          });
        } else {
          // The thin reader: no citation, a 2-char finding.
          real = new ReplayBackendRouting(assistant("ok"));
        }
        yield* real.runTurn(input, signal);
      },
    });
    const parent = new DirectAnswerBackend();
    const service = new AgentService({
      backendFactory: (role: CapabilityRole) => (role === "agent" ? parent : routingBackend()),
      ports: { search: stubSearch, document: fakeDocumentPort },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_parent",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(dir),
      subagents: {
        resolveSpecialist,
        genericSystemPrompt: () => "generic sub-agent prompt",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:A");
    // Capture the loop's result directly via the public service path; the
    // avoidable-spawns metric is logged + carried on the run result. Drive the
    // orchestrator directly to assert on its structured result.
    const result = await service.runDeepResearchForTest(sessionId, "Research the budget");
    void captured;

    expect(result.avoidableSpawns.length).toBe(1);
    expect(result.avoidableSpawns[0]!.specialist).toBe("source-digest");
    // The useful reader's verified finding is available to the parent finalizer.
    expect(result.findings[0]?.citations.map((c) => c.documentId)).toEqual([DOC_BUDGET]);
    expect(result.stoppedReason).toBe("answer_complete");
  });

  it("does NOT spawn a sub-agent for a simple (non-deep-research) query", async () => {
    const { service, captured, spawnedTasks, parent } = makeService();
    const { sessionId } = await service.createSession("device:A");
    // No deepResearch flag → ordinary turn.
    service.sendMessage("device:A", sessionId, "what's the capital of France");
    await settle();

    // The parent answered directly; nothing was spawned.
    expect(spawnedTasks).toEqual([]);
    expect(captured.map((e) => e.type)).not.toContain("agent.subagent.spawned");
    // The parent's normal tool set still includes spawn_subagent (the model
    // *could* spawn) — it simply chose not to. That is the gating negative
    // control: explicit-only + the model declined.
    expect(parent.sawSpawnTool).toBe(true);
  });

  /**
   * Drive one Deep Research turn over the real streamed path and return what
   * the reader actually saw — the parent's own text deltas, and the assistant
   * turn the transcript kept. `runDeepResearchForTest` deliberately bypasses
   * this path, so it cannot answer either question.
   */
  async function stoppedTurnText(childBackend: (task: string) => ChatBackend): Promise<{
    streamed: string;
    persisted: unknown;
  }> {
    const { service, captured, dir } = makeService({ childBackend });
    try {
      const { sessionId } = await service.createSession("device:A");
      const { messageId } = service.sendMessage("device:A", sessionId, "Research nothing", {
        deepResearch: true,
      });
      await waitFor(
        () =>
          captured.some(
            (event) => event.type === "agent.message.end" && event.payload.messageId === messageId,
          ),
        "the stopped research terminal",
      );
      const streamed = captured
        .filter((event) => event.type === "agent.text.delta")
        .filter((event) => event.payload.sessionId === sessionId)
        .map((event) => event.payload.delta)
        .join("");
      const record = await new FsConversationStore(dir).load(sessionId);
      return { streamed, persisted: record?.messages.at(-1) };
    } finally {
      await service.dispose();
    }
  }

  it("tells the reader nothing was searched when the planner never yields a plan", async () => {
    const { streamed, persisted } = await stoppedTurnText(
      () => new ReplayBackendRouting(assistant("I cannot plan this.")),
    );

    expect(streamed).toBe(DEEP_RESEARCH_NO_EVIDENCE_MESSAGES.plan_unusable);
    expect(persisted).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: DEEP_RESEARCH_NO_EVIDENCE_MESSAGES.plan_unusable }],
    });
  });

  it("tells the reader a different thing when the readers ran and cited nothing", async () => {
    const { streamed, persisted } = await stoppedTurnText((task) =>
      task.includes("Decompose this research question")
        ? new ReplayBackendRouting(
            assistant(
              '```json\n[{"specialist":"history-sweep","title":"Sweep","task":"Sweep the fictional Q4 budget review."}]\n```',
            ),
          )
        : new ReplayBackendRouting(assistant("Nothing in the window bears on the question.")),
    );

    // The pair is the point: an empty corpus and a run that never looked must
    // not read the same to the operator.
    expect(streamed).toBe(DEEP_RESEARCH_NO_EVIDENCE_MESSAGES.no_results);
    expect(streamed).not.toBe(DEEP_RESEARCH_NO_EVIDENCE_MESSAGES.plan_unusable);
    expect(persisted).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: DEEP_RESEARCH_NO_EVIDENCE_MESSAGES.no_results }],
    });
  });

  it("reports plan_unusable honestly when the planner never yields a plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-deep-research-empty-"));
    tempDirs.push(dir);
    const routingBackend = (): ChatBackend => ({
      name: "route",
      model: "route",
      async *runTurn(input: TurnInput, signal?: AbortSignal) {
        // The planner returns prose with no parseable plan.
        const real = new ReplayBackendRouting(assistant("I cannot plan this."));
        yield* real.runTurn(input, signal);
      },
    });
    const parent = new DirectAnswerBackend();
    const service = new AgentService({
      backendFactory: (role: CapabilityRole) => (role === "agent" ? parent : routingBackend()),
      ports: { search: stubSearch, document: fakeDocumentPort },
      systemPrompt: "test",
      sessionIdGen: () => "S_parent",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(dir),
      subagents: {
        resolveSpecialist,
        genericSystemPrompt: () => "generic sub-agent prompt",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:A");
    const result = await service.runDeepResearchForTest(sessionId, "Research nothing");
    expect(result.stoppedReason).toBe("plan_unusable");
    expect(result.findings).toEqual([]);
  });
});
