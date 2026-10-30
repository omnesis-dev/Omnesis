// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CAPABILITY_ROLES, createLogger } from "@omnesis/core";
import { classifyAgentTurn, type ChatBackend } from "@omnesis/agent";
import { describeModelFailure, descriptionForCategory } from "./model-health-errors.js";
import type {
  CapabilityRole,
  ModelHealth,
  ModelHealthWarning,
  ResolvedAssignment,
} from "@omnesis/core";

/** Three failed logical requests exclude transient one-off errors and transport retries. */
const REPEATED_FAILURES = 3;
const log = createLogger("gateway:inference:health");
const persistedWarning = z.object({
  role: z.enum(CAPABILITY_ROLES),
  assignment: z.string(),
  consecutiveFailures: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  firstFailedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastFailedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  category: z.enum([
    "quota",
    "authentication",
    "unavailable",
    "configuration",
    "timeout",
    "unknown",
  ]),
});
const persistedState = z
  .array(z.object({ fingerprint: z.string(), warning: persistedWarning }))
  .max(CAPABILITY_ROLES.length);
type Selection = { identity: string; fingerprint: string; assignment: string };
type Failure = { sequence: number; at: number; category: ModelHealthWarning["category"] };
type State = Selection & { latestSuccess: number; failures: Failure[] };

function warningFor(role: CapabilityRole, state: State): ModelHealthWarning | undefined {
  const newest = state.failures.at(-1);
  if (!newest) return undefined;
  return {
    role,
    assignment: state.assignment,
    consecutiveFailures: state.failures.length,
    firstFailedAt: Math.min(...state.failures.map((failure) => failure.at)),
    lastFailedAt: Math.max(...state.failures.map((failure) => failure.at)),
    category: newest.category,
    message: descriptionForCategory(newest.category),
  };
}

/**
 * Runtime evidence, bounded to one entry per capability. Connection/assignment
 * changes invalidate old evidence, including results still in flight. No prompt,
 * response body, credential, or arbitrary exception text is retained.
 */
export class InferenceHealth {
  private readonly states = new Map<CapabilityRole, State>();
  private sequence = 0;

  private restored = false;

  constructor(
    private readonly selection: (role: CapabilityRole) => Selection,
    private readonly statePath?: string,
  ) {}

  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    if (!this.statePath) return;
    try {
      const saved = persistedState.parse(JSON.parse(readFileSync(this.statePath, "utf8")));
      for (const { fingerprint, warning } of saved) {
        const selected = this.selection(warning.role);
        if (selected.fingerprint !== fingerprint) continue;
        this.states.set(warning.role, {
          ...selected,
          latestSuccess: 0,
          // Restored evidence predates every request in this process.
          failures: Array.from(
            { length: Math.min(REPEATED_FAILURES, warning.consecutiveFailures) },
            (_, index) => ({
              sequence: index - REPEATED_FAILURES,
              at: index === 0 ? warning.firstFailedAt : warning.lastFailedAt,
              category: warning.category,
            }),
          ),
        });
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        log.warn("Could not restore model health state");
      }
    }
  }

  private pendingState: string | undefined;
  private saving: Promise<void> | undefined;

  private persist(): void {
    if (!this.statePath) return;
    const entries = [...this.states.entries()].flatMap(([role, state]) => {
      const warning = warningFor(role, state);
      return warning
        ? [{ fingerprint: state.fingerprint, warning: { ...warning, message: undefined } }]
        : [];
    });
    this.pendingState = JSON.stringify(entries);
    this.saving ??= this.savePending();
  }

  private async savePending(): Promise<void> {
    try {
      await mkdir(dirname(this.statePath!), { recursive: true });
      while (this.pendingState !== undefined) {
        const content = this.pendingState;
        this.pendingState = undefined;
        const temporary = `${this.statePath!}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.statePath!);
      }
    } catch {
      log.warn("Could not persist model health state");
    } finally {
      this.saving = undefined;
    }
  }

  /** Wait for pending content-free health state to reach disk. */
  async flush(): Promise<void> {
    await this.saving;
  }

  snapshot(): ModelHealth {
    this.restore();
    let changed = false;
    const warnings: ModelHealthWarning[] = [];
    for (const [role, state] of this.states) {
      if (this.selection(role).identity !== state.identity) {
        this.states.delete(role);
        changed = true;
      } else if (state.failures.length >= REPEATED_FAILURES) {
        warnings.push(warningFor(role, state)!);
      }
    }
    if (changed) this.persist();
    return { warnings };
  }

  /** Capture the model configuration when the provider is constructed. */
  observe<T extends object>(
    resolved: ResolvedAssignment,
    provider: T,
    methods: readonly string[],
    beginCall = this.callFactory(resolved.role),
  ): T {
    return new Proxy(provider, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (typeof key !== "string" || !methods.includes(key)) return value.bind(target);
        return async (...args: unknown[]) => {
          const call = beginCall();
          const signal = callSignal(args);
          try {
            const result: unknown = await Reflect.apply(value, target, args);
            if (!signal?.aborted) call.success();
            return result;
          } catch (error) {
            if (!signal?.aborted && !isCancellation(error)) call.failure(error);
            throw error;
          }
        };
      },
    });
  }

  observeBackend(resolved: ResolvedAssignment, backend: ChatBackend): ChatBackend {
    const selected = this.selection(resolved.role);
    const health = this;
    const runTurn: ChatBackend["runTurn"] = async function* (input, signal) {
      const call = health.begin(resolved.role, selected);
      let failed: unknown;
      let settled = false;
      let canceled = false;
      try {
        for await (const event of backend.runTurn(input, signal)) {
          if (event.type === "agent.error") failed = event.payload;
          if (event.type === "agent.message.end") {
            const outcome = classifyAgentTurn(event.payload);
            if (outcome.status === "failed")
              failed = event.payload.failure ?? failed ?? outcome.failure;
            canceled = event.payload.stopReason === "canceled";
            if (event.payload.stopReason !== "tool_use") {
              // Consumers stop at an authoritative terminal without requesting
              // another iterator step, so settle before handing it to them.
              settled = true;
              if (!signal?.aborted && !canceled) {
                if (failed) call.failure(failed);
                else call.success();
              }
            }
          }
          yield event;
        }
        if (signal?.aborted || canceled || settled) return;
        call.failure(failed ?? new Error("Model stream ended without a terminal result"));
      } catch (error) {
        if (!signal?.aborted && !isCancellation(error)) call.failure(error);
        throw error;
      }
    };
    return new Proxy(backend, {
      get: (target, key) => {
        if (key === "runTurn") return runTurn;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Observe an inference operation managed outside a capability object. */
  beginCall(role: CapabilityRole) {
    return this.begin(role, this.selection(role));
  }

  /** Bind an external worker's lifetime to the configuration it was created for. */
  callFactory(role: CapabilityRole): () => ReturnType<InferenceHealth["beginCall"]> {
    const selected = this.selection(role);
    return () => this.begin(role, selected);
  }

  private begin(role: CapabilityRole, selected: Selection) {
    this.restore();
    const sequence = ++this.sequence;
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      if (this.selection(role).identity !== selected.identity) return;
      let state = this.states.get(role);
      if (!state || state.identity !== selected.identity) {
        state = { ...selected, latestSuccess: 0, failures: [] };
        this.states.set(role, state);
      }
      if (error === undefined) {
        if (sequence <= state.latestSuccess) return;
        // Every success excludes earlier-started failures, including when a
        // newer failure settled first. Newer failures remain evidence.
        state.latestSuccess = sequence;
        const previousCount = state.failures.length;
        state.failures = state.failures.filter((failure) => failure.sequence > sequence);
        if (state.failures.length !== previousCount) this.persist();
        return;
      }
      if (sequence <= state.latestSuccess) return;
      state.failures.push({
        sequence,
        at: Date.now(),
        category: describeModelFailure(error).category,
      });
      state.failures.sort((left, right) => left.sequence - right.sequence);
      // Only the threshold's newest witnesses are needed. A later success can
      // prune their prefix without retaining an unbounded outcome journal.
      if (state.failures.length > REPEATED_FAILURES) state.failures.shift();
      this.persist();
    };
    return { success: () => finish(), failure: (error: unknown) => finish(error ?? new Error()) };
  }
}

function callSignal(args: unknown[]): AbortSignal | undefined {
  for (const arg of args) {
    if (arg instanceof AbortSignal) return arg;
    if (arg && typeof arg === "object" && "signal" in arg && arg.signal instanceof AbortSignal) {
      return arg.signal;
    }
  }
  return undefined;
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
