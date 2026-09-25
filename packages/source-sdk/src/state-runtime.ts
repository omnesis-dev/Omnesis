// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Applying a source's state declaration at runtime.
 *
 * `source-state.ts` decides *what* a stored value means. This decides *where*
 * that decision happens: in a decorator around the live instance, between the
 * host's page loop and the source's own `sync`.
 *
 * The decorator is the reason the whole mechanism is additive. The page loop
 * keeps reading a stored value and writing back whatever the source returned,
 * exactly as before; the gateway keeps storing an opaque blob; a source that
 * declares no state spec is not wrapped at all and behaves identically. What
 * changes for a source that *does* declare one is that it never sees an
 * envelope, never sees state from a version it does not understand, and never
 * has an unreadable bookmark quietly presented as a first run.
 */

import { SyncError } from "@omnesis/types";
import {
  encodeSourceState,
  resolveSourceState,
  type SourceState,
  type SourceStateSpec,
  type StateOutcome,
} from "./source-state.js";
import type { SourceInstance, SyncOptions, SyncStart } from "./define-source.js";
import type { SyncCursor, SyncResult } from "./source.js";
import type { StructuredSyncResult } from "./structured-source.js";

/** Somewhere to report what a resolution decided, without depending on a logger. */
export interface StateResolutionSink {
  (outcome: StateOutcome, context: { sourceId: string }): void;
}

export interface VersionedStateOptions {
  /** The configured source this instance belongs to, stamped into the envelope. */
  sourceId: string;
  /**
   * Called once per page with the resolution outcome. The host logs it: a
   * source that silently rebootstraps looks exactly like a source with a lot
   * of new data, and the difference matters to whoever is paying for the
   * upstream requests.
   */
  onResolve?: StateResolutionSink;
  /**
   * Called when a resolution refuses to run. The host parks the source; the
   * page loop must not proceed, because continuing would mean syncing from a
   * bookmark nobody could read.
   */
  onRefuse?: (reason: string, context: { sourceId: string }) => void;

  /**
   * Called when a source returns a cursor its own decoder rejects.
   *
   * The value is still stored, unwrapped, because refusing to record a page's
   * progress would be worse than recording it unstamped. But it is always a
   * defect in the source: the next run classifies that value as legacy and
   * runs the migration chain over it, so a source that stamps a generation
   * flag only on its settled pages has every mid-cycle page quietly demoted to
   * the oldest generation. Reporting it turns a slow, invisible wrong answer
   * into a line naming the source.
   */
  onUnencodable?: (context: { sourceId: string }) => void;
}

/**
 * Thrown when a source's stored state is refused: written by a newer build, or
 * unreadable under an `onUnreadable: "stop"` policy.
 *
 * A typed error rather than a silent fresh start, because the two outcomes are
 * not interchangeable. Starting over would re-read an entire upstream and, for
 * a source whose history upstream has already discarded, would not restore what
 * was lost. Parking the source keeps the stored value intact for a build that
 * can read it.
 */
export class RefusedSourceStateError extends SyncError {
  readonly sourceId: string;
  constructor(sourceId: string, reason: string) {
    super("unknown", `Refusing to sync '${sourceId}': ${reason}`, {
      remediation: {
        summary: `${sourceId} has saved sync state this build cannot read`,
        steps: [
          "Check whether this host was downgraded from a newer Omnesis build; if so, upgrade it again and the source resumes where it left off.",
          "Keep the saved state and take a backup before attempting recovery. Do not discard it or resync until you have verified that the source can recover its history; upstream data or pending work may no longer be available.",
        ],
        restartRequired: false,
      },
    });
    this.name = "RefusedSourceStateError";
    this.sourceId = sourceId;
  }
}

/**
 * Wrap a live instance so its persisted state passes through the declared
 * version, decoder and migration chain in both directions.
 *
 * Returns the instance unchanged when there is no spec, so a caller can apply
 * this unconditionally.
 */
export function withVersionedState<S extends SourceState = SourceState>(
  instance: SourceInstance,
  spec: SourceStateSpec<S> | undefined,
  options: VersionedStateOptions,
): SourceInstance {
  if (!spec) return instance;
  const { sourceId, onResolve, onRefuse, onUnencodable } = options;

  /** How the last resolution classified this run's starting point. */
  let lastStart: SyncStart = "first-run";

  const toState = (stored: SyncCursor | null): S | null => {
    const outcome = resolveSourceState(spec, stored, { sourceId });
    onResolve?.(outcome, { sourceId });
    if (outcome.kind === "refused") {
      onRefuse?.(outcome.reason, { sourceId });
      throw new RefusedSourceStateError(sourceId, outcome.reason);
    }
    lastStart =
      outcome.kind === "resume"
        ? "resume"
        : outcome.kind === "migrated"
          ? "migrated"
          : outcome.kind === "fresh"
            ? "first-run"
            : "rebootstrap";
    return outcome.kind === "resume" || outcome.kind === "migrated" ? outcome.state : null;
  };

  /**
   * Fill in the run's starting point, which only this wrapper knows.
   *
   * The host builds the run before the cursor has been decoded, and a source
   * used to infer its starting point from a null cursor — which reads a first
   * run, a resync and state that could not be read as the same thing. They
   * cost very different amounts, and the last is a signal that something went
   * wrong rather than a clean slate.
   */
  const withStart = (opts: SyncOptions | undefined): SyncOptions | undefined =>
    opts?.run ? { ...opts, run: { ...opts.run, start: lastStart } } : opts;

  const toStored = (state: SyncCursor): SyncCursor => {
    // A source can return a value its own decoder would reject — a partial
    // page's bookkeeping, a hand-built object. Encoding it anyway would store
    // a version stamp the value does not deserve, and the next run would
    // resume from it. Storing it unwrapped instead leaves it classified as
    // legacy, which is recoverable.
    const decoded = spec.decode(state);
    if (!decoded) {
      onUnencodable?.({ sourceId });
      return state;
    }
    return encodeSourceState(spec, decoded, { sourceId }) as unknown as SyncCursor;
  };

  // Forward lifecycle hooks and getters with their original receiver, including
  // class private fields. Keep decorated methods on a separate object so the
  // provider instance itself remains unchanged.
  const overrides: SourceInstance = { sync: instance.sync.bind(instance) };
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  const wrapped = new Proxy(overrides, {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      const value: unknown = Reflect.get(instance, key, instance);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached?.original === value) return cached.bound;
      const bound = value.bind(instance);
      methods.set(key, { original: value, bound });
      return bound;
    },
    has(target, key) {
      return key in target || key in instance;
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(instance), ...Reflect.ownKeys(target)])];
    },
    getOwnPropertyDescriptor(target, key) {
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own) return own;
      const inherited = Reflect.getOwnPropertyDescriptor(instance, key);
      return inherited ? { ...inherited, configurable: true } : undefined;
    },
  });

  wrapped.sync = async (cursor: SyncCursor | null, opts?: SyncOptions): Promise<SyncResult> => {
    const state = toState(cursor) as SyncCursor | null;
    const result = await instance.sync(state, withStart(opts));
    return { ...result, cursor: toStored(result.cursor) };
  };

  if (typeof instance.syncStructured === "function") {
    const structured = instance.syncStructured.bind(instance);
    wrapped.syncStructured = async (
      cursor: SyncCursor | null,
      opts?: SyncOptions,
    ): Promise<StructuredSyncResult> => {
      const state = toState(cursor) as SyncCursor | null;
      const result = await structured(state, withStart(opts));
      return { ...result, cursor: toStored(result.cursor) };
    };
  }

  return wrapped;
}
