// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The compiles this gateway is running: what is going, and whether to start more.
 *
 * Two jobs, and they are separate on purpose.
 *
 * **Tracking**, for every compile. A compile runs for minutes and a stop takes
 * seconds, so a restart lands inside one often; knowing what is running is what
 * lets a stop wait for it and an operator pick a better moment. Every compile
 * counts, including the ones nothing can share — a count that saw only the
 * shareable ones would report zero while the operator's own compile ran, which
 * is the number they are told to read before restarting.
 *
 * **Sharing**, only for a compile that named itself. A subscription's
 * idempotency key deduplicates against the record a compile leaves behind, which
 * settles a retry arriving after the first finished and does nothing for one
 * arriving during it — and with compiles at minutes and clients that retry on a
 * timeout, during it is the ordinary case. A request that named itself therefore
 * gets one run however many times it arrives.
 *
 * Sharing needs the content to match as well as the key. A key naming one
 * request and a different request wearing the same key are two requests, and
 * this will not answer the second with the first's result. What happens to it
 * afterwards is the store's business, not this map's: a key is unique per
 * watch, so the second converges on whatever the key already names rather than
 * installing a second watch beside it. The distinction this draws is only that
 * a caller never receives an answer computed for somebody else's request
 * without its own request having been run. Both still count as compiles in
 * flight, because both are work the gateway has to finish or abandon.
 */

import { createHash } from "node:crypto";

/** A run in progress, and what it was for. */
interface Entry {
  /** Null for a run nothing may share. */
  readonly fingerprint: string | null;
  readonly result: Promise<unknown>;
}

/**
 * A key nothing can collide with, for a run that is tracked but never shared.
 *
 * Its own counter rather than a random value so a test can predict it and so two
 * unshareable runs in the same millisecond cannot land on one key. The slots it
 * names are prefixed with a NUL, written as an escape so the file stays text:
 * caller keys are namespaced strings chosen by a client, so none of them can
 * begin with one, and a shareable run therefore cannot land on an unshareable
 * slot and be handed its result.
 */
let unshareable = 0;

export class InFlightRequests {
  private readonly entries = new Map<string, Entry>();
  private accepting = true;
  /** Resolved and replaced each time the map empties, so a drain can await it. */
  private idle: { promise: Promise<void>; resolve: () => void } | null = null;

  /** How many compiles are running. The drain and the operator's report read this. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Whether new work should still be started.
   *
   * False once the gateway is stopping. A compile accepted at that moment cannot
   * finish, and reaches its caller as a dropped connection — which an agent
   * reads as a broken feature and answers by asking again in different words,
   * a different idempotency key by design, so the guard that would have caught
   * the duplicate never fires.
   */
  get open(): boolean {
    return this.accepting;
  }

  /** Refuse new runs. Irreversible: nothing un-stops a stopping gateway. */
  close(): void {
    this.accepting = false;
  }

  /**
   * Run `work`, or attach to the identical run already going.
   *
   * `key` is the caller's own name for the request, already namespaced to
   * whoever chose it — an unscoped key would let one caller attach to another's
   * run. `null` means the request has no identity to share by and runs alone,
   * tracked like every other.
   *
   * Refuses once closed, rather than starting work a stopping gateway cannot
   * finish. Callers with a surface of their own check {@link open} first so they
   * can answer in their own words; this is the backstop for the ones that
   * forget, and for the moment between the check and the call.
   */
  async run<T>(key: string | null, content: unknown, work: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      throw new GatewayRestartingError();
    }
    const fingerprint = key === null ? null : fingerprintOf(content);
    if (key !== null) {
      const existing = this.entries.get(key);
      if (existing && existing.fingerprint === fingerprint) {
        return existing.result as Promise<T>;
      }
    }
    // A run nothing may share still occupies a slot of its own: it is a compile
    // in flight, and the stop has to know about it.
    const slot =
      key !== null && !this.entries.has(key) ? key : `\u0000unshared:${(unshareable += 1)}`;
    // `Promise.resolve().then` rather than calling `work()` directly: a `work`
    // that throws synchronously would otherwise settle before the entry is
    // recorded, leaving one behind that nothing can ever remove — and a drain
    // waiting on a map that never empties is a stop that never completes.
    const result = Promise.resolve()
      .then(work)
      .finally(() => {
        this.entries.delete(slot);
        if (this.entries.size === 0) {
          this.idle?.resolve();
          this.idle = null;
        }
      });
    this.entries.set(slot, { fingerprint: slot === key ? fingerprint : null, result });
    return result;
  }

  /**
   * Resolve once nothing is running.
   *
   * Awaits a promise the runs themselves settle rather than polling the map: a
   * loop that re-checked after each settle would spin on the microtask queue and
   * starve everything scheduled behind it — including the timer a bounded stop
   * relies on to give up.
   */
  async whenIdle(): Promise<void> {
    if (this.entries.size === 0) return;
    if (!this.idle) {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      this.idle = { promise, resolve };
    }
    await this.idle.promise;
  }
}

/**
 * What a route needs to know about the compiles, without being able to start one.
 *
 * Named rather than restated structurally at each dep type, so the two surfaces
 * that gate on it cannot drift into meaning different things.
 */
export type CompilesInFlight = Pick<InFlightRequests, "open" | "size">;

/** Thrown when a stopping gateway is asked to start something it cannot finish. */
export class GatewayRestartingError extends Error {
  constructor() {
    super("this gateway is restarting and did not start compiling");
    this.name = "GatewayRestartingError";
  }
}

/**
 * A stable digest of what a request asks for.
 *
 * Keys are sorted, so two callers that assemble the same request in a different
 * field order still recognise each other. Without it the coalescing would hold
 * only for callers that happen to build their object the same way, and would
 * fail silently and invisibly for anyone who did not.
 */
function fingerprintOf(content: unknown): string {
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
