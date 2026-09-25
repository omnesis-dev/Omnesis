// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `SubagentService` — orchestrates nested {@link AgentSession}s.
 *
 * It sits **beside** {@link AgentService}, not inside `AgentSession`: the
 * session stays a single-turn primitive ignorant of nesting, and all the
 * depth / concurrency / budget / lifetime logic lives here. It reuses the
 * parent `AgentService`'s SSE fan-out (via the {@link SubagentHost} seam) so a
 * child's events reach exactly the devices watching the parent conversation,
 * and registers each child for **recursive eviction** so children die with
 * their parent.
 *
 * Fan-out is **asynchronous and parallel**: `spawn()` launches a child and
 * returns a handle IMMEDIATELY (running the child in the background, bounded by
 * the per-parent concurrency cap — excess launches queue), so the parent can
 * launch several children that run concurrently and then await them with
 * `join()`. Generic workers cannot delegate; the depth cap remains an
 * internal guard for owned workflows that may nest private specialists.
 *
 * Token accounting aggregates `AgentMessageEndEvent.usage` up the whole tree
 * (NOT `touchTokenUsage` — that's the device-auth beacon). The tree-wide token
 * budget is enforced here: when the running tree total would exceed the budget,
 * further spawns are refused and in-flight children are cancelled with an
 * honest, named `budget_exhausted` reason (fail-loud — never a silent stop).
 *
 * Core constraints honoured here:
 *   - interactive spawns use one fixed generic profile; owned workflows may
 *     select a registered specialist whose model role resolves through the
 *     role-aware factory;
 *   - generic workers receive a fixed retrieval/evidence tool set and private
 *     specialists receive only their host-owned read profile;
 *   - depth / concurrency caps + the tree-token budget come from `agent.*`
 *     config, not constants.
 */

import {
  AgentSession,
  classifyAgentTurn,
  type ChatBackend,
  type SubagentJoinInput,
  type SubagentJoinResult,
  type SubagentPortInput,
  type SubagentPortResult,
  type SubagentSpawnHandle,
  type ToolHandle,
} from "@omnesis/agent";
import {
  createLogger,
  makeEvent,
  type AgentEvent,
  type AgentTerminalFailure,
  type AgentUsage,
  type CapabilityRole,
  type DocRef,
  type RateLimitPatience,
  type WsEvent,
} from "@omnesis/core";
import { SUBAGENT_SPEND_MECHANISM, type AgentSpendRecorder } from "./spend-recorder.js";
import { renderCallerZoneBlock } from "./system-prompt.js";

const log = createLogger("gateway").child("subagent");

function waitForAbort<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("sub-agent cancelled before it started"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("sub-agent cancelled before it started"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Minimal resolved specialist this first cut needs. The full specialist
 * registry (system prompts, input/output schemas, default budgets) is a later
 * sub-issue; here a specialist contributes a system prompt and a model role.
 */
export interface ResolvedSpecialist {
  name: string;
  systemPrompt: string;
  /** Model role the child runs on (`agent` for the built-in research specialists). */
  modelRole: CapabilityRole;
  /**
   * Host-owned read-tool allowlist for a private specialist. Omit to give the
   * specialist every read-only tool; an empty list grants no tools.
   */
  defaultTools?: ReadonlyArray<string>;
}

/**
 * The seam {@link AgentService} implements so the sub-agent orchestration can
 * reuse its SSE fan-out, backend resolution, tool building, and child-session
 * tracking without reaching into its privates.
 */
export interface SubagentHost {
  /** Fan a fully-formed WS event out to every parent-watching SSE listener. */
  emitEvent(event: WsEvent): void;
  /**
   * Resolve a sub-agent's model role to a backend, returning `null` when the
   * role is unassigned so the caller inherits the parent's backend.
   */
  resolveBackend(role: CapabilityRole): ChatBackend | null;
  /** The parent agent's backend — the inherit target for an unassigned role. */
  parentBackend(): ChatBackend;
  /** Build the fixed tool set for an ordinary generic read-only worker. */
  buildGenericSubagentTools(): ToolHandle[];
  /** Build a private specialist's host-owned read-tool profile. */
  buildSpecialistSubagentTools(allowlist?: ReadonlyArray<string>): ToolHandle[];
  /** Build a generic worker prompt from the same live context as its parent. */
  buildGenericSystemPrompt(context: { timeZone?: string }): string | Promise<string>;
  /** Register a live child session so it is evicted with its parent. */
  registerChild(parentSessionId: string, childSessionId: string, cancel: () => void): void;
  /** Current nesting depth of a session (the parent is depth 0). */
  depthOf(sessionId: string): number;
  /**
   * The rate-limit patience a registered session runs with, inherited from the
   * tree it belongs to; `undefined` keeps the backend's interactive default.
   */
  rateLimitPatienceOf(sessionId: string): RateLimitPatience | undefined;
}

export interface SubagentServiceDeps {
  host: SubagentHost;
  /** Resolves a specialist name to its prompt + model role. */
  resolveSpecialist: (name: string) => ResolvedSpecialist;
  /** Max nesting depth a spawn chain may reach (config `agent.subagentDepthCap`). */
  depthCap: number;
  /** Max in-flight sub-agents per parent (config `agent.subagentConcurrencyCap`). */
  concurrencyCap: number;
  /**
   * Tree-wide LLM-token ceiling shared across a parent and all its descendant
   * sub-agents (config `agent.subagentTreeTokenBudget`). `undefined` ⇒ unbounded
   * (a warning is logged once per tree).
   */
  treeTokenBudget?: number;
  /**
   * Cognition-spend seam: called once per settled child with the tokens THAT
   * child consumed (never the tree aggregate — recording per child keeps the
   * per-model attribution exact and can't double-count). Unset ⇒ no
   * accounting.
   */
  recordSpend?: AgentSpendRecorder;
}

/** Live bookkeeping for one running child. */
interface ChildRecord {
  subagentId: string;
  parentSessionId: string;
  specialist: string;
  title: string;
  rootSessionId: string;
  /** Resolves once the child's run settles (success, failure, or budget stop). */
  done: Promise<SubagentPortResult>;
  status: SubagentSpawnHandle["status"] | SubagentPortResult["status"];
  abort: AbortController;
  cancel: () => void;
  /** Internal pipeline stage (planner/synthesis) — suppress client events. */
  internal: boolean;
}

/**
 * Per-tree aggregate state. A tree is identified by its root parent session
 * (the top-level conversation). Every descendant sub-agent's usage rolls up
 * here so the tree-wide budget sees the WHOLE tree, not one branch.
 */
interface TreeState {
  usage: AgentUsage;
  /** True once the budget tripped — latches so the reason stays honest. */
  budgetExhausted: boolean;
  /** Logged the "unbounded budget" warning once. */
  warnedUnbounded: boolean;
}

interface CollectedEvidence {
  ref: DocRef;
  note?: string;
  quote?: string;
}

const PARTIAL_EVIDENCE_ITEMS = 8;
const PARTIAL_EVIDENCE_CHARS = 2_000;

export class SubagentService {
  private readonly host: SubagentHost;
  private readonly resolveSpecialist: (name: string) => ResolvedSpecialist;
  private readonly depthCap: number;
  private readonly concurrencyCap: number;
  private readonly treeTokenBudget: number | undefined;
  private readonly recordSpend: AgentSpendRecorder | undefined;
  private childCounter = 0;

  /** All live/finished children, keyed by subagentId. */
  private readonly children = new Map<string, ChildRecord>();
  /** Maps any child session id to its tree root (the top-level parent). */
  private readonly rootOf = new Map<string, string>();
  /** Per-tree token + budget state, keyed by the root session id. */
  private readonly trees = new Map<string, TreeState>();
  /** In-flight child count per parent session id (for the concurrency cap). */
  private readonly inFlight = new Map<string, number>();
  /** FIFO queue of slot-waiters per parent session id (concurrency gate). */
  private readonly waiters = new Map<string, Array<{ claim: () => void; cancel: () => void }>>();

  constructor(deps: SubagentServiceDeps) {
    this.host = deps.host;
    this.resolveSpecialist = deps.resolveSpecialist;
    this.depthCap = deps.depthCap;
    this.concurrencyCap = deps.concurrencyCap;
    this.treeTokenBudget = deps.treeTokenBudget;
    this.recordSpend = deps.recordSpend;
  }

  /**
   * Launch a sub-agent. Returns a handle IMMEDIATELY — the child runs in the
   * background (or waits in the concurrency queue). Throws
   * {@link DepthExceededError} (the caller maps it) when a spawn would exceed
   * the depth cap, and {@link TreeBudgetExceededError} when the tree-wide token
   * budget is already exhausted.
   */
  async spawn(input: SubagentPortInput): Promise<SubagentSpawnHandle> {
    const parentDepth = this.host.depthOf(input.parentSessionId);
    if (parentDepth + 1 > this.depthCap) {
      throw new DepthExceededError(this.depthCap);
    }

    const rootSessionId = this.rootOf.get(input.parentSessionId) ?? input.parentSessionId;
    const tree = this.treeFor(rootSessionId);
    // Refuse a fresh launch once the budget has tripped — fail-loud, named.
    if (tree.budgetExhausted) {
      throw new TreeBudgetExceededError(this.treeTokenBudget ?? 0);
    }

    const specialistName = input.specialist;
    const isGeneric = specialistName === undefined;
    const specialist: ResolvedSpecialist = isGeneric
      ? { name: "generic", systemPrompt: "", modelRole: "agent" }
      : this.resolveSpecialist(specialistName);
    const subagentId = `${input.parentSessionId}.sub.${(++this.childCounter).toString(36)}`;
    this.rootOf.set(subagentId, rootSessionId);

    const record: ChildRecord = {
      subagentId,
      parentSessionId: input.parentSessionId,
      specialist: specialist.name,
      title: input.title,
      rootSessionId,
      status: "queued",
      abort: new AbortController(),
      cancel: () => {},
      // Replaced synchronously below; the placeholder keeps the type total.
      done: Promise.resolve({
        subagentId,
        specialist: specialist.name,
        status: "failed",
        summary: "",
        citations: [],
      }),
      // Only owned-workflow plumbing (for example the Deep Research planner)
      // is hidden. Generic workers keep the ordinary lifecycle stream so the
      // parent conversation and answer trace remain observable; clients use
      // the stable `generic` profile name to avoid opening Deep Research UI.
      internal: input.internal === true,
    };
    record.cancel = () => record.abort.abort();
    this.children.set(subagentId, record);
    // Register before queueing or prompt construction so parent eviction can
    // cancel a child in every lifecycle stage.
    this.host.registerChild(input.parentSessionId, subagentId, record.cancel);
    // Kick off the run (gated on a concurrency slot) without blocking the caller.
    record.done = this.runChild(record, input, specialist);

    // Tell the parent stream a child was spawned (queued/running both legible).
    // Internal pipeline stages (planner/synthesis) stay off the client stream.
    if (!record.internal) {
      this.emitParent("agent.subagent.spawned", {
        sessionId: input.parentSessionId,
        subagentId,
        specialist: specialist.name,
        title: input.title,
        task: input.task,
        ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
      });
    }

    return {
      subagentId,
      specialist: specialist.name,
      status: record.status as "queued" | "running",
    };
  }

  /**
   * Await a set of launched children and collect their findings. A mixed set is
   * fine — finished children resolve immediately, in-flight ones are awaited.
   * Returns the per-tree token aggregate and, when the budget tripped during the
   * fan-out, an honest named `stoppedReason`.
   */
  async join(input: SubagentJoinInput): Promise<SubagentJoinResult> {
    const rootSessionId = this.rootOf.get(input.parentSessionId) ?? input.parentSessionId;
    const results: SubagentPortResult[] = [];
    for (const id of input.subagentIds) {
      const record = this.children.get(id);
      if (!record || record.parentSessionId !== input.parentSessionId) {
        // The parent asked for an id we never launched — surface it as a failed
        // entry rather than throwing, so the join still collects the rest.
        results.push({
          subagentId: id,
          specialist: "unknown",
          status: "failed",
          summary: `(no sub-agent ${id} was launched by this parent)`,
          citations: [],
        });
        continue;
      }
      results.push(await record.done);
    }

    const tree = this.treeFor(rootSessionId);
    const treeUsage = hasUsage(tree.usage) ? { ...tree.usage } : undefined;
    return {
      results,
      ...(treeUsage ? { treeUsage } : {}),
      ...(tree.budgetExhausted
        ? { stoppedReason: `tree token budget (${this.treeTokenBudget}) exhausted` }
        : {}),
    };
  }

  /** Cancel and retire all runtime and budget state owned by one root session. */
  forgetTree(rootSessionId: string): void {
    for (const [id, record] of this.children) {
      if (record.rootSessionId !== rootSessionId) continue;
      // A cancelled backend may take time to unwind. Retire visibility before
      // aborting so no late child/result event escapes after parent eviction.
      record.internal = true;
      record.cancel();
      this.children.delete(id);
      this.rootOf.delete(id);
    }
    this.rootOf.delete(rootSessionId);
    this.trees.delete(rootSessionId);
    // Do not clear an active gate counter here: a resumed conversation may use
    // the same id before the cancelled run settles. The old run must release
    // its own slot before the replacement is allowed to claim it (no ABA).
    const queued = this.waiters.get(rootSessionId);
    if (queued) {
      for (const waiter of [...queued]) waiter.cancel();
      this.waiters.delete(rootSessionId);
    }
  }

  /**
   * Run one child to completion behind the per-parent concurrency gate, wrapping
   * its event stream into the parent's `agent.subagent.*` events and rolling its
   * usage up the tree. Enforces the tree-wide token budget mid-run.
   */
  private async runChild(
    record: ChildRecord,
    input: SubagentPortInput,
    specialist: ResolvedSpecialist,
  ): Promise<SubagentPortResult> {
    const isGeneric = input.specialist === undefined;
    const tree = this.treeFor(record.rootSessionId);
    const signal = input.signal
      ? AbortSignal.any([input.signal, record.abort.signal])
      : record.abort.signal;
    if (!(await this.acquireSlot(input.parentSessionId, signal))) {
      const status = tree.budgetExhausted ? "budget_exhausted" : "failed";
      return this.finishChild(
        record,
        input.parentSessionId,
        status,
        "",
        [],
        new Map(),
        {},
        tree,
        undefined,
        status === "failed" ? "sub-agent cancelled before it started" : undefined,
      );
    }
    // Re-check the budget after the queue wait — it may have tripped while we
    // waited for a slot. Stop before spending a single token (fail-loud).
    if (tree.budgetExhausted) {
      this.releaseSlot(input.parentSessionId);
      return this.finishChild(
        record,
        input.parentSessionId,
        "budget_exhausted",
        "",
        [],
        new Map(),
        {},
        tree,
      );
    }

    record.status = "running";

    let backend: ChatBackend;
    let child: AgentSession;
    try {
      backend = this.host.resolveBackend(specialist.modelRole) ?? this.host.parentBackend();
      const tools = isGeneric
        ? this.host.buildGenericSubagentTools()
        : this.host.buildSpecialistSubagentTools(specialist.defaultTools);
      const systemPrompt = isGeneric
        ? await waitForAbort(
            this.host.buildGenericSystemPrompt({ timeZone: input.timeZone }),
            signal,
          )
        : specialist.systemPrompt + "\n\n" + renderCallerZoneBlock(input.timeZone);
      if (signal.aborted) throw new Error("sub-agent cancelled before it started");
      const rateLimitPatience = this.host.rateLimitPatienceOf(record.subagentId);
      child = new AgentSession({
        sessionId: record.subagentId,
        backend,
        tools,
        systemPrompt,
        timeZone: input.timeZone,
        ...(rateLimitPatience ? { rateLimitPatience } : {}),
      });
    } catch (err) {
      this.releaseSlot(input.parentSessionId);
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`sub-agent ${record.subagentId} could not initialize: ${message}`);
      return this.finishChild(
        record,
        input.parentSessionId,
        "failed",
        "",
        [],
        new Map(),
        {},
        tree,
        undefined,
        message,
      );
    }
    record.cancel = () => {
      record.abort.abort();
      child.cancel();
    };

    const citations = new Map<string, DocRef>();
    const evidence = new Map<string, CollectedEvidence>();
    const usage: AgentUsage = {};
    let lastText = "";
    let pendingText = "";
    let budgetTripped = false;
    const liveUsageByMessage = new Map<string, AgentUsage>();
    const settledUsageByMessage = new Map<string, AgentUsage>();

    const accrueUsage = (messageId: string, reported: AgentUsage, terminal = false): void => {
      const previous = liveUsageByMessage.get(messageId);
      if (terminal && settledUsageByMessage.has(messageId)) return;
      const snapshot = mergeUsage(previous, reported);
      const delta = usageIncrease(previous, snapshot);
      if (!terminal) liveUsageByMessage.set(messageId, snapshot);
      else {
        liveUsageByMessage.delete(messageId);
        settledUsageByMessage.set(messageId, snapshot);
      }
      if (!hasUsage(delta)) return;
      addUsage(usage, delta);
      addUsage(tree.usage, delta);
      if (this.exceedsBudget(tree)) {
        tree.budgetExhausted = true;
        budgetTripped = true;
        child.cancel();
        this.stopTree(record.rootSessionId);
      }
    };

    const unsubscribe = child.subscribe((event: AgentEvent) => {
      collectFromEvent(event, citations, evidence, (delta) => {
        pendingText += delta;
      });
      if (event.type === "agent.message.end") {
        lastText = pendingText.trim() || lastText;
        const u = event.payload.usage;
        if (u) accrueUsage(event.payload.messageId, u, true);
      }
      if (event.type === "agent.usage.update") {
        accrueUsage(event.payload.messageId, event.payload.usage);
      }
      if (!record.internal) {
        this.emitParent("agent.subagent.event", {
          sessionId: input.parentSessionId,
          subagentId: record.subagentId,
          specialist: specialist.name,
          event: { type: event.type, payload: event.payload },
        });
      }
    });

    let status: SubagentPortResult["status"] = "complete";
    let failure: AgentTerminalFailure | undefined;
    let failureMessage: string | undefined;
    try {
      const { completion } = child.send(input.task, { signal });
      let turn = classifyAgentTurn(await completion);
      // A provider can occasionally finish an otherwise healthy request with
      // no visible response. Retrying this explicitly retryable terminal once
      // keeps one transient empty completion from discarding an entire branch
      // of a Deep Research fan-out.
      if (
        turn.status === "failed" &&
        turn.failure?.code === "http_empty_response" &&
        turn.failure.retryable &&
        !budgetTripped &&
        !tree.budgetExhausted &&
        !signal.aborted
      ) {
        log.warn(`sub-agent ${record.subagentId} returned an empty response; retrying once`);
        const retry = child.send(input.task, { signal });
        turn = classifyAgentTurn(await retry.completion);
      }
      if (turn.status === "failed") {
        status = "failed";
        failure = turn.failure;
      }
    } catch (err) {
      status = "failed";
      failureMessage = err instanceof Error ? err.message : String(err);
      log.warn(`sub-agent ${record.subagentId} failed: ${failureMessage}`);
    } finally {
      unsubscribe();
      this.releaseSlot(input.parentSessionId);
    }

    if ((budgetTripped || tree.budgetExhausted) && failure === undefined) {
      status = "budget_exhausted";
    }

    // Fold this child's own tokens into cognition spend exactly once,
    // whatever the outcome — a failed or budget-stopped child still spent
    // what it spent (folded without counting a completed run). Deliberately
    // the child's usage, never `tree.usage`: the tree total spans models and
    // would double-count siblings.
    if (this.recordSpend && hasUsage(usage)) {
      try {
        this.recordSpend({
          mechanism: input.spendMechanism ?? SUBAGENT_SPEND_MECHANISM,
          modelId: backend.model,
          usage,
          completed: status === "complete",
        });
      } catch (err) {
        log.warn(
          `spend recording failed for sub-agent ${record.subagentId}: ${(err as Error).message ?? err}`,
        );
      }
    }

    const citationList = [...citations.values()];
    return this.finishChild(
      record,
      input.parentSessionId,
      status,
      lastText,
      citationList,
      evidence,
      usage,
      tree,
      failure,
      failureMessage,
    );
  }

  /** Emit the terminal `agent.subagent.result` + return the distilled finding. */
  private finishChild(
    record: ChildRecord,
    parentSessionId: string,
    status: SubagentPortResult["status"],
    lastText: string,
    citationList: DocRef[],
    evidence: ReadonlyMap<string, CollectedEvidence>,
    usage: AgentUsage,
    tree: TreeState,
    failure?: AgentTerminalFailure,
    failureMessage?: string,
  ): SubagentPortResult {
    record.status = status;
    const partialSummary =
      failure?.code === "output_truncated" ? buildPartialSummary(lastText, evidence) : undefined;
    const summary =
      status === "budget_exhausted"
        ? `(${record.specialist} stopped — tree token budget (${this.treeTokenBudget}) exhausted)`
        : status === "failed"
          ? (partialSummary ??
            (failure
              ? `(${record.specialist} failed: ${failure.code}: ${failure.message})`
              : failureMessage || `(${record.specialist} failed before returning a finding)`))
          : lastText ||
            `(${record.specialist} returned no text; cited ${citationList.length} document(s))`;

    const treeUsage = hasUsage(tree.usage) ? { ...tree.usage } : undefined;
    if (!record.internal) {
      this.emitParent("agent.subagent.result", {
        sessionId: parentSessionId,
        subagentId: record.subagentId,
        specialist: record.specialist,
        status,
        summary,
        citations: citationList,
        ...(hasUsage(usage) ? { usage: { ...usage } } : {}),
        ...(failure ? { failure } : {}),
        ...(treeUsage ? { treeUsage } : {}),
      });
    }

    return {
      subagentId: record.subagentId,
      specialist: record.specialist,
      status,
      summary,
      citations: citationList,
      ...(hasUsage(usage) ? { usage: { ...usage } } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  // ─── concurrency gate ────────────────────────────────────────────────────

  /** Wait for a concurrency slot under the parent, then claim it. */
  private acquireSlot(parentSessionId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const current = this.inFlight.get(parentSessionId) ?? 0;
    if (current < this.concurrencyCap) {
      this.inFlight.set(parentSessionId, current + 1);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const queue = this.waiters.get(parentSessionId) ?? [];
      const remove = (): void => {
        const active = this.waiters.get(parentSessionId);
        const index = active?.indexOf(waiter) ?? -1;
        if (index >= 0) active!.splice(index, 1);
        if (active?.length === 0) this.waiters.delete(parentSessionId);
      };
      const onAbort = (): void => {
        remove();
        resolve(false);
      };
      const waiter = {
        claim: () => {
          signal.removeEventListener("abort", onAbort);
          this.inFlight.set(parentSessionId, (this.inFlight.get(parentSessionId) ?? 0) + 1);
          resolve(true);
        },
        cancel: onAbort,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
      this.waiters.set(parentSessionId, queue);
      if (signal.aborted) onAbort();
    });
  }

  /** Release a slot and wake the next queued waiter, if any. */
  private releaseSlot(parentSessionId: string): void {
    const current = this.inFlight.get(parentSessionId) ?? 1;
    if (current <= 1) this.inFlight.delete(parentSessionId);
    else this.inFlight.set(parentSessionId, current - 1);
    const queue = this.waiters.get(parentSessionId);
    const next = queue?.shift();
    if (queue?.length === 0) this.waiters.delete(parentSessionId);
    if (next) next.claim();
  }

  // ─── tree budget ─────────────────────────────────────────────────────────

  private treeFor(rootSessionId: string): TreeState {
    let tree = this.trees.get(rootSessionId);
    if (!tree) {
      tree = { usage: {}, budgetExhausted: false, warnedUnbounded: false };
      this.trees.set(rootSessionId, tree);
    }
    if (this.treeTokenBudget === undefined && !tree.warnedUnbounded) {
      tree.warnedUnbounded = true;
      log.warn(
        `sub-agent tree ${rootSessionId} has no token budget (agent.subagentTreeTokenBudget unset) — fan-out is unbounded`,
      );
    }
    return tree;
  }

  /** True when the tree's running total has reached/exceeded the budget. */
  private exceedsBudget(tree: TreeState): boolean {
    if (this.treeTokenBudget === undefined) return false;
    return totalTokens(tree.usage) >= this.treeTokenBudget;
  }

  /** Cancel every live child sharing a tree root once the budget trips. */
  private stopTree(rootSessionId: string): void {
    for (const record of this.children.values()) {
      if (record.rootSessionId !== rootSessionId) continue;
      if (record.status === "running" || record.status === "queued") {
        try {
          record.cancel();
        } catch {
          // A misbehaving child must not block the rest of the stop.
        }
      }
    }
    // `record.cancel()` aborts queued waiters as well as running sessions, so
    // none can remain parked behind a tree that has already exhausted budget.
  }

  private emitParent<T extends AgentEvent["type"]>(
    type: T,
    payload: Extract<AgentEvent, { type: T }>["payload"],
  ): void {
    this.host.emitEvent(makeEvent(type, payload as never));
  }
}

/** Thrown when a spawn would exceed the configured depth cap. */
export class DepthExceededError extends Error {
  constructor(public readonly cap: number) {
    super(`sub-agent depth cap (${cap}) reached — this sub-agent cannot spawn further sub-agents`);
    this.name = "DepthExceededError";
  }
}

/** Thrown when a spawn is refused because the tree-wide token budget is spent. */
export class TreeBudgetExceededError extends Error {
  constructor(public readonly budget: number) {
    super(
      `sub-agent tree token budget (${budget}) exhausted — no further sub-agents can be spawned`,
    );
    this.name = "TreeBudgetExceededError";
  }
}

/**
 * Accumulate a child event into the running citation set and assistant text.
 * Usage is handled by the caller (it must also roll up the tree).
 */
function collectFromEvent(
  event: AgentEvent,
  citations: Map<string, DocRef>,
  evidence: Map<string, CollectedEvidence>,
  onText: (delta: string) => void,
): void {
  switch (event.type) {
    case "agent.text.delta":
      onText(event.payload.delta);
      break;
    case "agent.citation": {
      const ref = event.payload.ref;
      const key = refKey(ref);
      citations.set(key, ref);
      evidence.set(key, {
        ref,
        ...(event.payload.note ? { note: event.payload.note } : {}),
        ...(event.payload.quote ? { quote: event.payload.quote } : {}),
      });
      break;
    }
    case "agent.citations.update": {
      for (const ref of event.payload.added) citations.set(refKey(ref), ref);
      break;
    }
    default:
      break;
  }
}

function buildPartialSummary(
  lastText: string,
  evidence: ReadonlyMap<string, CollectedEvidence>,
): string | undefined {
  const lines = [...evidence.values()]
    .slice(0, PARTIAL_EVIDENCE_ITEMS)
    .map(({ ref, note, quote }) => {
      const point = note?.trim() || quote?.trim();
      if (!point) return null;
      return `- ${singleLine(ref.title ?? ref.documentId)}: ${singleLine(point)}`;
    })
    .filter((line): line is string => line !== null);
  if (lines.length > 0) {
    return clipPartial(
      "Partial evidence collected before the worker reached its output limit:\n" + lines.join("\n"),
    );
  }
  const text = lastText.trim();
  return text.length > 0
    ? clipPartial(`Partial finding before the worker reached its output limit:\n${text}`)
    : undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipPartial(value: string): string {
  return value.length <= PARTIAL_EVIDENCE_CHARS
    ? value
    : `${value.slice(0, PARTIAL_EVIDENCE_CHARS - 1).trimEnd()}…`;
}

/** Add one usage delta into a running accumulator in place. */
function addUsage(acc: AgentUsage, u: AgentUsage): void {
  acc.inputTokens = (acc.inputTokens ?? 0) + (u.inputTokens ?? 0);
  acc.outputTokens = (acc.outputTokens ?? 0) + (u.outputTokens ?? 0);
  acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
  acc.cacheCreationTokens = (acc.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}

/** Positive delta between a provider's cumulative live report and its prior snapshot. */
function usageIncrease(previous: AgentUsage | undefined, current: AgentUsage): AgentUsage {
  const increase = (field: keyof AgentUsage): number =>
    Math.max(0, (current[field] ?? 0) - (previous?.[field] ?? 0));
  return {
    inputTokens: increase("inputTokens"),
    outputTokens: increase("outputTokens"),
    cacheReadTokens: increase("cacheReadTokens"),
    cacheCreationTokens: increase("cacheCreationTokens"),
  };
}

/** Merge a partial provider report into its prior cumulative snapshot. */
function mergeUsage(previous: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  return {
    ...(previous?.inputTokens !== undefined ? { inputTokens: previous.inputTokens } : {}),
    ...(previous?.outputTokens !== undefined ? { outputTokens: previous.outputTokens } : {}),
    ...(previous?.cacheReadTokens !== undefined
      ? { cacheReadTokens: previous.cacheReadTokens }
      : {}),
    ...(previous?.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: previous.cacheCreationTokens }
      : {}),
    ...(next.inputTokens !== undefined ? { inputTokens: next.inputTokens } : {}),
    ...(next.outputTokens !== undefined ? { outputTokens: next.outputTokens } : {}),
    ...(next.cacheReadTokens !== undefined ? { cacheReadTokens: next.cacheReadTokens } : {}),
    ...(next.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: next.cacheCreationTokens }
      : {}),
  };
}

/** Billable token total used to measure against the tree budget. */
function totalTokens(u: AgentUsage): number {
  return (
    (u.inputTokens ?? 0) +
    (u.outputTokens ?? 0) +
    (u.cacheReadTokens ?? 0) +
    (u.cacheCreationTokens ?? 0)
  );
}

function hasUsage(u: AgentUsage): boolean {
  return totalTokens(u) > 0;
}

function refKey(ref: DocRef): string {
  return `${ref.sourceType}:${ref.sourceId}:${ref.documentId}`;
}
