// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { performance } from "node:perf_hooks";
import {
  ManagedDesktopNearbyCleanupError,
  managedDesktopNearbyInvocation,
  managedDesktopNearbySnapshotSchema,
  spawnOwnedChildProcess,
  type ManagedDesktopNearbySnapshot,
  type OwnedChildProcess,
} from "@omnesis/core";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";

/** A retry observes this exact retained owner; it never starts another native query. */
class DesktopNearbyRetainedCleanupError extends ManagedDesktopNearbyCleanupError {
  readonly #owner: DesktopNearbyHints;
  constructor(owner: DesktopNearbyHints, cause: unknown) {
    super(cause);
    this.#owner = owner;
  }
  retry(): Promise<void> {
    return this.#owner.retryCleanup();
  }
}

/** Keep startup cleanup at the controller boundary, including both-error aggregates. */
export function desktopNearbyCleanupRetry(error: unknown): (() => Promise<void>) | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const failures: ManagedDesktopNearbyCleanupError[] = [];
  let truncated = false;
  while (pending.length && seen.size < 32) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (next instanceof ManagedDesktopNearbyCleanupError) failures.push(next);
    else {
      if (next instanceof AggregateError) {
        truncated ||= next.errors.length > 32;
        pending.push(...next.errors.slice(0, 32));
      }
      if (next instanceof Error && next.cause !== undefined) pending.push(next.cause);
    }
  }
  // An incomplete error graph cannot prove there is no owned cleanup to retain.
  if (!failures.length && !pending.length && !truncated) return undefined;
  return async () => {
    try {
      if (!failures.length || pending.length || truncated) throw error;
      for (const failure of failures) {
        if (!(failure instanceof DesktopNearbyRetainedCleanupError)) throw error;
        await failure.retry();
      }
    } catch {
      // Preserve the original startup failure and cleanup failure, not just the last observer.
      throw error;
    }
  };
}

interface Operations {
  invocation: typeof managedDesktopNearbyInvocation;
  owned: typeof spawnOwnedChildProcess;
  now: () => number;
}
/** One DATA-free role adapter. Its close joins the query, not the helper-owned browser. */
export class DesktopNearbyHints {
  private readonly closed = new AbortController();
  private pending?: Promise<unknown>;
  private closing?: Promise<void>;
  private retrying?: Promise<void>;
  private cleanupFailure?: ManagedDesktopNearbyCleanupError;
  private unconfirmedOwner?: OwnedChildProcess;
  private lastSnapshot?: { value: ManagedDesktopNearbySnapshot; began: number };
  private observed?: ManagedDesktopNearbySnapshot["state"];
  private readonly ops: Operations;
  constructor(
    private readonly profile: DesktopProfile,
    operations: Partial<Operations> = {},
  ) {
    this.ops = {
      invocation: managedDesktopNearbyInvocation,
      owned: spawnOwnedChildProcess,
      now: performance.now.bind(performance),
      ...operations,
    };
  }
  get state(): ManagedDesktopNearbySnapshot["state"] | undefined {
    return this.observed;
  }
  remaining(): ManagedDesktopNearbySnapshot | undefined {
    if (this.closed.signal.aborted || !this.lastSnapshot) return undefined;
    const { value, began } = this.lastSnapshot;
    const elapsed = Math.max(0, this.ops.now() - began);
    return {
      ...value,
      candidates: value.candidates
        .map((candidate) => ({
          ...candidate,
          remainingMs: Math.floor(candidate.remainingMs - elapsed),
        }))
        .filter((candidate) => candidate.remainingMs >= 1),
    };
  }
  snapshot(signal: AbortSignal): Promise<unknown> {
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    signal.throwIfAborted();
    this.closed.signal.throwIfAborted();
    if (this.pending) return Promise.resolve([]);
    const active = AbortSignal.any([signal, this.closed.signal, AbortSignal.timeout(5000)]);
    const run = this.read(active).catch((error: unknown) => {
      this.observed = "unavailable";
      throw error;
    });
    const held = run.finally(() => {
      if (this.pending === held && !this.cleanupFailure) this.pending = undefined;
    });
    this.pending = held;
    return held;
  }
  close(): Promise<void> {
    if (this.cleanupFailure) return this.retryCleanup();
    return (this.closing ??= (async () => {
      this.closed.abort();
      await this.pending?.catch(() => undefined);
      if (this.unconfirmedOwner && this.cleanupFailure) throw this.cleanupFailure;
    })());
  }
  /** Re-observe the same physical join; no stop, signal, child or timeout is renewed. */
  retryCleanup(): Promise<void> {
    if (!this.cleanupFailure || !this.unconfirmedOwner) return this.closing ?? Promise.resolve();
    return (this.retrying ??= (async () => {
      const owner = this.unconfirmedOwner!;
      const failure = this.cleanupFailure!;
      try {
        await owner.joined;
      } catch {
        // A rejected observation is not physical closure proof.
      }
      if (!owner.joinedConfirmed) throw failure;
      this.unconfirmedOwner = undefined;
      this.cleanupFailure = undefined;
      this.closing = Promise.resolve();
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  /** Cooperative daemon teardown retains its owner/control lease until this exact query joins. */
  async joinRetained(): Promise<void> {
    const owner = this.unconfirmedOwner;
    if (!owner) return;
    try {
      await owner.joined;
    } catch {
      /* Uncertain cohort evidence is not a positive join. */
    }
    if (!owner.joinedConfirmed) await new Promise<never>(() => {});
  }

  private async read(signal: AbortSignal): Promise<unknown> {
    this.lastSnapshot = undefined;
    const invocation = this.ops.invocation(this.profile, import.meta.url);
    if (!invocation) {
      this.observed = "unavailable";
      return [];
    }
    const began = this.ops.now();
    const owner = this.ops.owned(invocation.command, invocation.args, {
      env: desktopEnvironment(this.profile),
    });
    let bytes = 0,
      overflow = false,
      code: number | null = null;
    const chunks: Buffer[] = [];
    const stop = () => {
      void owner.stop().catch(() => undefined);
    };
    const output = (chunk: Buffer | string) => {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 4096) {
        overflow = true;
        stop();
      } else chunks.push(value);
    };
    owner.child.stdout?.on("data", output);
    owner.child.stderr?.resume();
    owner.child.once("exit", (value) => {
      code = value;
    });
    owner.child.stdin?.end();
    signal.addEventListener("abort", stop, { once: true });
    const operation = async (): Promise<unknown> => {
      if (signal.aborted) stop();
      await owner.ready;
      await owner.joined;
      signal.throwIfAborted();
      if (overflow || code !== 0) {
        this.observed = "unavailable";
        return [];
      }
      let snapshot: ManagedDesktopNearbySnapshot;
      try {
        snapshot = managedDesktopNearbySnapshotSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
      } catch {
        this.observed = "unavailable";
        return [];
      }
      signal.throwIfAborted();
      this.observed = snapshot.state;
      this.lastSnapshot = { value: snapshot, began };
      return this.remaining()?.candidates.map(({ address, port }) => ({ address, port })) ?? [];
    };
    let value: unknown;
    let primary: { error: unknown } | undefined;
    try {
      value = await operation();
    } catch (error) {
      primary = { error };
    }
    signal.removeEventListener("abort", stop);
    owner.child.stdout?.off("data", output);
    let cleanup: { error: unknown } | undefined;
    if (!owner.joinedConfirmed) {
      try {
        await owner.stop();
      } catch (error) {
        this.observed = "unavailable";
        if (!owner.joinedConfirmed) cleanup = { error };
      }
    }
    if (cleanup) {
      const cause = primary
        ? new AggregateError([primary.error, cleanup.error], "Nearby query and cleanup failed", {
            cause: cleanup.error,
          })
        : cleanup.error;
      this.unconfirmedOwner = owner;
      this.cleanupFailure = new DesktopNearbyRetainedCleanupError(this, cause);
      this.closed.abort();
      throw this.cleanupFailure;
    }
    if (primary) throw primary.error;
    return value;
  }
}
