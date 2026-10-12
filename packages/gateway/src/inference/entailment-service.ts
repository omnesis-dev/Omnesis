// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the entailment-verifier capability lifecycle for the gateway: resolve
 * the assignment fresh on every use, cache the loaded capability under a
 * stable signature of the resolution, and reload (disposing the old instance)
 * when the signature changes — so assigning or swapping the verifier model
 * from the portal takes effect on the next annotation write without a
 * gateway restart. An unset assignment resolves to null, which callers treat
 * as "gate absent".
 *
 * Lifecycle changes drain all active operations before replacing the capability.
 * Known stateless remote adapters admit at most two verifies; native contexts
 * remain serial. Caller cancellation never releases an operation lease before
 * the underlying work (including transport iterator cleanup) settles.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  assertNever,
  createLogger,
  type EntailCapability,
  type ResolvedAssignment,
} from "@omnesis/core";
import { loadEntailmentFromResolved, type LoadEntailmentDeps } from "./entailment-loader.js";

const log = createLogger("inference:entailment-service");
type CallStage = "queued" | "load" | "verify" | "dispose";
interface Admission {
  operation: "get" | "verify" | "dispose";
  signal?: AbortSignal;
  prepare(): Promise<void>;
  start(): Promise<unknown>;
  fail(error: unknown): void;
}
// A safety ceiling, not a replacement for the backend's shared inference pool.
const REMOTE_VERIFY_CONCURRENCY = 2;

/**
 * Stable signature for a resolved assignment, to detect config changes. The
 * http arm folds in everything a backend edit can change under the same
 * backendKey — url, path prefix, the egress flag, and an API-key fingerprint
 * — so editing a backend (or flipping `allowRemoteInference`) forces a
 * reload instead of silently reusing a completer built against the old
 * transport snapshot.
 */
function signatureOf(resolved: ResolvedAssignment, apiKey: string | undefined): string {
  switch (resolved.kind) {
    case "local":
      return `local:${resolved.catalogId}:${resolved.modelPath}:${resolved.available}`;
    case "replay":
      return `replay:${resolved.fixture ?? ""}`;
    case "http": {
      const keyPrint = createHash("sha256")
        .update(apiKey ?? "")
        .digest("hex")
        .slice(0, 8);
      return `http:${resolved.backendKey}:${resolved.url}:${resolved.apiPathPrefix ?? ""}:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}:${keyPrint}`;
    }
    case "anthropic":
      return `anthropic:${resolved.catalogId}:${resolved.available}:${resolved.allowRemoteInference}`;
    case "codex":
      return `codex:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}`;
    case "claude-code":
      return `claude-code:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}`;
    case "typesafe":
      return `typesafe:${resolved.model}:${resolved.available}`;
    case "disabled":
      return "disabled";
    case "unresolved":
      return "unresolved";
    default:
      return assertNever(resolved);
  }
}

export class EntailmentVerifierService {
  private readonly resolveAssignment: () => ResolvedAssignment;
  private readonly deps: LoadEntailmentDeps;
  private current: {
    signature: string;
    capability: EntailCapability | null;
    concurrency: number;
  } | null = null;
  private readonly admissions: Admission[] = [];
  private readonly active = new Set<Promise<unknown>>();
  private pumping = false;
  private pending = 0;

  /**
   * The stable facade handed to callers. Its verify() re-resolves the
   * assignment through the fence on every call, so callers can hold it
   * across config swaps without ever touching a disposed instance.
   */
  private readonly facade: EntailCapability = {
    verify: (input) =>
      this.enqueue(
        "verify",
        async (stage) => {
          const capability = this.current?.capability;
          input.signal?.throwIfAborted();
          if (!capability) throw new Error("entailment verifier unavailable");
          stage("verify");
          return capability.verify(input);
        },
        input.signal,
      ),
    dispose: () => {
      // Lifecycle is owned by the service (see dispose() below).
    },
  };

  constructor(opts: { resolveAssignment: () => ResolvedAssignment; deps: LoadEntailmentDeps }) {
    this.resolveAssignment = opts.resolveAssignment;
    this.deps = opts.deps;
  }

  /**
   * The live verifier for the current assignment, or null when the role is
   * unset/unloadable. Re-resolves per call; loads at most once per signature.
   */
  async get(signal?: AbortSignal): Promise<EntailCapability | null> {
    const capability = await this.enqueue(
      "get",
      async () => this.current?.capability ?? null,
      signal,
    );
    return capability ? this.facade : null;
  }

  async dispose(): Promise<void> {
    await this.enqueue("dispose", async (stage) => {
      stage("dispose");
      const capability = this.current?.capability ?? null;
      this.current = null;
      if (capability) await Promise.resolve(capability.dispose()).catch(() => {});
    });
  }

  /** Called only by the admission pump; it is the generation-swap barrier. */
  private async ensureLoaded(signal?: AbortSignal): Promise<EntailCapability | null> {
    const resolution = () => {
      const resolved = this.resolveAssignment();
      const apiKey =
        resolved.kind === "http" ? this.deps.getBackendApiKey?.(resolved.backendKey) : undefined;
      return { resolved, signature: signatureOf(resolved, apiKey) };
    };
    while (true) {
      signal?.throwIfAborted();
      const requested = resolution();
      if (this.current?.signature === requested.signature) return this.current.capability;
      await Promise.allSettled([...this.active]);
      signal?.throwIfAborted();
      // Assignment/egress may change again while the old generation drains.
      const { resolved, signature } = resolution();
      const previous = this.current?.capability ?? null;
      this.current = null;
      if (previous) await Promise.resolve(previous.dispose()).catch(() => {});
      signal?.throwIfAborted();
      const capability = await loadEntailmentFromResolved(resolved, this.deps);
      this.current = {
        signature,
        capability,
        concurrency: ["codex", "http", "anthropic"].includes(resolved.kind)
          ? REMOTE_VERIFY_CONCURRENCY
          : 1,
      };
      // Loading may also await native resources; do not admit a stale assignment.
    }
  }

  /** Waiters never hold a lease; only this pump may load or dispose a generation. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.admissions.length) {
        const job = this.admissions[0]!;
        const limit = this.current?.concurrency ?? 1;
        if (
          !job.signal?.aborted &&
          this.active.size &&
          (job.operation === "dispose" ||
            (job.operation === "verify" && this.active.size >= limit) ||
            (job.operation === "get" && limit === 1))
        )
          return;
        this.admissions.shift();
        try {
          job.signal?.throwIfAborted();
          await job.prepare();
        } catch (error) {
          job.fail(error);
          continue;
        }
        const running = job.start();
        if (job.operation === "verify") {
          this.active.add(running);
          void running
            .finally(() => {
              this.active.delete(running);
              void this.pump();
            })
            .catch(() => {});
        } else {
          await running.catch(() => {});
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private enqueue<T>(
    operation: "get" | "verify" | "dispose",
    fn: (stage: (next: Exclude<CallStage, "queued">) => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = randomUUID();
    const contended = this.pending > 0;
    let stage: CallStage = "queued";
    let changedAt = performance.now();
    const elapsed = { queued: 0, load: 0, verify: 0, dispose: 0 };
    const account = () => {
      const now = performance.now();
      elapsed[stage] += now - changedAt;
      changedAt = now;
    };
    const report = (
      status: "settled" | "failed" | "cancelled",
      boundary: "caller" | "operation",
    ) => {
      account();
      try {
        const emit = contended || status !== "settled" ? log.info : log.debug;
        emit(
          `Verifier operation id=${id} operation=${operation} contended=${contended} boundary=${boundary} status=${status} stage=${stage} queueWaitMs=${Math.round(elapsed.queued)} loadMs=${Math.round(elapsed.load)} verifyMs=${Math.round(elapsed.verify)} disposeMs=${Math.round(elapsed.dispose)}`,
        );
      } catch {
        /* Diagnostics cannot change admission or availability. */
      }
    };
    const enter = (next: Exclude<CallStage, "queued">) => {
      account();
      stage = next;
    };
    if (signal?.aborted) {
      report("cancelled", "caller");
      return Promise.reject(signal.reason);
    }
    this.pending++;
    const execute = async () => {
      try {
        signal?.throwIfAborted();
        const result = await fn(enter);
        signal?.throwIfAborted();
        report("settled", "operation");
        return result;
      } catch (error) {
        report(signal?.aborted ? "cancelled" : "failed", "operation");
        throw error;
      } finally {
        this.pending--;
      }
    };
    let resolveRun!: (value: T) => void;
    let rejectRun!: (error: unknown) => void;
    const run = new Promise<T>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const job: Admission = {
      operation,
      signal,
      prepare: async () => {
        if (operation !== "dispose") {
          enter("load");
          await this.ensureLoaded(signal);
        }
      },
      start: () => {
        const running = execute();
        void running.then(resolveRun, rejectRun);
        return running;
      },
      fail: (error) => {
        this.pending--;
        report(signal?.aborted ? "cancelled" : "failed", "operation");
        rejectRun(error);
      },
    };
    this.admissions.push(job);
    void this.pump();
    if (!signal) return run;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        report("cancelled", "caller");
        reject(signal.reason);
        const index = this.admissions.indexOf(job);
        if (index !== -1) {
          this.admissions.splice(index, 1);
          job.fail(signal.reason);
          void this.pump();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
