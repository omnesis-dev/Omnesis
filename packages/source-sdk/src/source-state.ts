// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Versioned, source-owned sync state.
 *
 * A source resumes from a bookmark it wrote on its previous run — an upstream
 * change token, a high-water timestamp, a map of file fingerprints, a phase
 * machine's position. The shape is the source's own business, but *the fact
 * that it has a shape, and that the shape changes over releases*, is the
 * host's business, because the host is what hands the value back.
 *
 * ## Why this exists
 *
 * Without a declared version there is exactly one failure signal available:
 * the stored value did not look right, so the source is handed nothing. That
 * single signal has to stand in for four unrelated situations — a source that
 * has genuinely never run, a value written by an older release, a value
 * corrupted on disk, and a value written by a *newer* release the running code
 * cannot read. They call for four different responses, and collapsing them
 * into "start from scratch" makes the most expensive response the default: a
 * full re-read of an upstream that may bill per request, may no longer hold
 * the history, and may take days.
 *
 * A {@link SourceStateSpec} lets a source say which version it writes, how to
 * read each older one, and what should happen when neither is possible. The
 * host then answers with a {@link StateOutcome} that names which situation it
 * is in.
 *
 * ## Two version numbers, following Home Assistant's config entries
 *
 * `version` is the major: a bump means the shape changed in a way older code
 * cannot read, so it needs a migration. `minorVersion` is the compatible half:
 * adding an optional field bumps the minor, needs no migration function, and
 * is readable in both directions within the same major. Most releases only
 * ever touch the minor, and this is what keeps the common case free.
 *
 * ## Migrations are chained, and self-checking
 *
 * `migrate[n]` takes a version-`n` value and returns a version-`n+1` value.
 * Adding a version means writing exactly one new function rather than one per
 * older version. After the chain runs, the result must pass `decode` — so a
 * migration that quietly produces the wrong shape is caught by the host rather
 * than by whatever reads the state three cycles later.
 *
 * ## The envelope is not the gateway's business
 *
 * The gateway stores sync state as an opaque JSON blob and has always done so.
 * This module wraps that blob rather than changing where it lives, so a
 * state migration remains a collector concern. The gateway separately pins a
 * source's wire contract when a modern collector starts it, refusing older
 * collectors for that source before they can misinterpret an envelope. Other
 * sources and phone-only streams can continue without a fleet-wide upgrade.
 */

/** The JSON object a source persists between runs. */
export type SourceState = Record<string, unknown>;

/**
 * The envelope the host wraps a source's state in before persisting it.
 *
 * Field names are deliberately short: this is written on every committed page
 * of every source, and the envelope should not cost more than the state it
 * carries. `e` is the envelope format's own version — if the envelope ever
 * needs to change, that is the number that moves, independently of any
 * source's `v`.
 */
export interface StateEnvelope {
  /** Envelope format version. Present on every wrapped value; absent means legacy. */
  e: 1;
  /** The source's declared major state version. */
  v: number;
  /** The source's declared minor state version, when it declares one. */
  m?: number;
  /**
   * The source id this envelope was written for.
   *
   * Purely a guard: a value that arrives under the wrong key is a bug
   * somewhere in the storage path, and finding it here is much cheaper than
   * finding it after a source has resumed from another source's bookmark.
   */
  s?: string;
  /** The source's own state. */
  state: SourceState;
}

/** True when a stored value is a state envelope rather than a legacy raw cursor. */
export function isStateEnvelope(value: unknown): value is StateEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { e?: unknown }).e === 1 &&
    typeof (value as { v?: unknown }).v === "number" &&
    typeof (value as { state?: unknown }).state === "object" &&
    (value as { state?: unknown }).state !== null
  );
}

/**
 * One step of a migration chain: read a version-`n` value, return a
 * version-`n+1` value.
 *
 * Typed loosely on purpose. Intermediate versions no longer exist as types in
 * the tree — keeping a type per historical shape is a cost that grows forever
 * and buys nothing, because the only consumer of an intermediate value is the
 * next function in the chain. The result of the *last* step is checked by
 * `decode`, which is where the real guarantee comes from.
 *
 * Return `null` to refuse: the value is a version-`n` value this migration
 * cannot make sense of, and the host should fall back to the spec's
 * `onUnreadable` policy rather than write something it guessed at.
 */
export type StateMigration = (prior: unknown) => unknown | null;

/**
 * A source's declaration of the state it persists.
 *
 * @typeParam S - the current version's state shape.
 */
export interface SourceStateSpec<S extends SourceState = SourceState> {
  /**
   * Current major version. Starts at 1. Bump when the shape changes in a way
   * the previous release's `decode` would reject, and add the matching
   * `migrate` entry in the same change.
   */
  version: number;

  /**
   * Current minor version within {@link version}. Bump for a
   * backwards-compatible addition — a new optional field, a widened union.
   * `decode` must tolerate the field being absent, because a value written by
   * an earlier minor will not have it. Defaults to 0.
   */
  minorVersion?: number;

  /**
   * Validate a value that claims to be this version's state.
   *
   * Return `null` for anything that is not the current shape. This runs on the
   * stored value when its version matches, and again on the output of a
   * migration chain, so it is the single place the shape is enforced.
   */
  decode(value: unknown): S | null;

  /**
   * Migration steps keyed by the version they read. `migrate[2]` takes a
   * version-2 value and returns a version-3 value.
   *
   * The chain from version 1 up to {@link version} must be complete;
   * `validateStateSpec` rejects a definition with a hole, because a hole means
   * some installed release's state has no path forward and would silently
   * become a full re-bootstrap.
   */
  migrate?: Record<number, StateMigration>;

  /**
   * Which version a *legacy* stored value — one written before envelopes
   * existed — should be treated as.
   *
   * Sources that rolled their own versioning inside the cursor read it here
   * (Obsidian's `cursor.version === 2`, the local-agent adapters' parser
   * versions). Everything else can leave this out: an unwrapped value with no
   * self-declared version is version 1 by definition, since that is the shape
   * that predates this mechanism.
   *
   * Return `null` for a legacy value this source does not recognise at all.
   */
  legacyVersion?: (value: unknown) => number | null;

  /**
   * The largest this source's persisted state may become, in bytes of JSON.
   *
   * State is written on every committed page and read back on every one, so a
   * field that grows with the corpus — a per-file map, an accumulating id
   * enumeration — is paid for repeatedly and on the single writer thread.
   * A ceiling turns "the source got slower and slower" into a failure with a
   * name, at the point the growth happens rather than months later.
   *
   * Measured on the envelope, which is what actually reaches storage. A source
   * that measured its own inner state would exclude the wrapper and understate
   * what it costs. Omitted means no ceiling.
   */
  maxBytes?: number;

  /**
   * What the host should do when the stored state cannot be decoded and cannot
   * be migrated.
   *
   * `"rebootstrap"` (the default) discards it and starts the source over from
   * upstream — correct for a source whose upstream still holds everything it
   * ever held. `"stop"` parks the source with an error instead — correct for a
   * source whose history upstream has already discarded, where a silent
   * restart would not repopulate the corpus and would hide the loss.
   */
  onUnreadable?: "rebootstrap" | "stop";
}

/**
 * What the host hands a run in place of a bare value-or-null.
 *
 * Each arm is a situation the source may legitimately want to behave
 * differently in; a source that does not care can treat everything carrying a
 * `state` as a resume and everything else as a fresh start.
 */
export type StateOutcome<S extends SourceState = SourceState> =
  /** No state stored: the source has never run, or was reset on purpose. */
  | { kind: "fresh" }
  /** Stored state read at the current version. */
  | { kind: "resume"; state: S; version: number; minorVersion: number }
  /** Stored state was older and has been migrated forward; `state` is current. */
  | { kind: "migrated"; state: S; from: number; to: number }
  /**
   * Stored state could not be read and the spec says to start over. The source
   * should behave exactly as it would for `fresh`; `reason` is for the log.
   */
  | { kind: "rebootstrap"; reason: string }
  /**
   * Stored state could not be read and the spec says to stop, or it was
   * written by a newer release than this code understands. Either way the
   * stored value is left untouched — a downgrade must not destroy the state
   * the newer build will want back.
   */
  | { kind: "refused"; reason: string; storedVersion: number | null };

/** The state carried by an outcome, or `undefined` when there is none to resume from. */
export function stateOf<S extends SourceState>(outcome: StateOutcome<S>): S | undefined {
  return outcome.kind === "resume" || outcome.kind === "migrated" ? outcome.state : undefined;
}

/** True when the source should behave as if it had never run. */
export function isFreshStart<S extends SourceState>(outcome: StateOutcome<S>): boolean {
  return outcome.kind === "fresh" || outcome.kind === "rebootstrap";
}

/**
 * Resolve a stored value against a source's state declaration.
 *
 * Pure: no I/O, no clock, no logging. Everything the host needs to decide what
 * to do next is in the returned outcome, which is what makes the whole
 * mechanism testable without a gateway.
 */
export function resolveSourceState<S extends SourceState>(
  spec: SourceStateSpec<S>,
  stored: unknown,
  opts?: { sourceId?: string },
): StateOutcome<S> {
  const onUnreadable = spec.onUnreadable ?? "rebootstrap";
  const refuseOrReset = (reason: string, storedVersion: number | null): StateOutcome<S> =>
    onUnreadable === "stop"
      ? { kind: "refused", reason, storedVersion }
      : { kind: "rebootstrap", reason };

  if (stored === null || stored === undefined) return { kind: "fresh" };
  if (typeof stored !== "object") {
    return refuseOrReset(`stored state is ${typeof stored}, expected an object`, null);
  }
  // An empty object is what `emptySync()` writes for a source with nothing to
  // remember, and what the gateway holds before a source's first committed
  // page. Treating it as unreadable would make every such source log a
  // rebootstrap on every single run.
  if (!isStateEnvelope(stored) && Object.keys(stored as object).length === 0) {
    return { kind: "fresh" };
  }

  let storedVersion: number;
  let storedMinor = 0;
  let payload: unknown;

  if (isStateEnvelope(stored)) {
    if (opts?.sourceId && stored.s && stored.s !== opts.sourceId) {
      // Never migrate or resume from an envelope written for a different
      // source: whatever is wrong upstream of here, continuing would attribute
      // one source's position to another.
      return {
        kind: "refused",
        reason: `state envelope belongs to '${stored.s}', not '${opts.sourceId}'`,
        storedVersion: stored.v,
      };
    }
    storedVersion = stored.v;
    storedMinor = stored.m ?? 0;
    payload = stored.state;
  } else {
    const legacy = spec.legacyVersion ? spec.legacyVersion(stored) : 1;
    if (legacy === null) {
      return refuseOrReset("legacy stored state was not recognised by the source", null);
    }
    storedVersion = legacy;
    payload = stored;
  }

  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    return refuseOrReset(`stored state version ${String(storedVersion)} is not a version`, null);
  }

  if (storedVersion > spec.version) {
    // A newer build wrote this. Refuse regardless of `onUnreadable`: a
    // rebootstrap here would overwrite state the newer build understands, so a
    // downgrade would silently cost whatever that state was worth.
    return {
      kind: "refused",
      reason: `stored state version ${storedVersion} is newer than this build understands (${spec.version})`,
      storedVersion,
    };
  }

  if (storedVersion === spec.version) {
    const decoded = spec.decode(payload);
    if (decoded) {
      return {
        kind: "resume",
        state: decoded,
        version: storedVersion,
        minorVersion: storedMinor,
      };
    }
    return refuseOrReset(
      `stored state claims version ${storedVersion} but failed this version's decoder`,
      storedVersion,
    );
  }

  // Older: run the chain forward one version at a time.
  let value: unknown = payload;
  for (let from = storedVersion; from < spec.version; from++) {
    const step = spec.migrate?.[from];
    if (!step) {
      return refuseOrReset(`no migration from state version ${from} to ${from + 1}`, storedVersion);
    }
    let next: unknown;
    try {
      next = step(value);
    } catch (err) {
      return refuseOrReset(
        `migration from state version ${from} threw: ${err instanceof Error ? err.message : String(err)}`,
        storedVersion,
      );
    }
    if (next === null || next === undefined) {
      return refuseOrReset(`migration from state version ${from} refused the value`, storedVersion);
    }
    value = next;
  }

  const decoded = spec.decode(value);
  if (!decoded) {
    // The chain ran to completion and produced something the current decoder
    // rejects. That is a bug in a migration, not bad data, so say so plainly.
    return refuseOrReset(
      `migration chain from state version ${storedVersion} produced a value the version ${spec.version} decoder rejected`,
      storedVersion,
    );
  }
  return { kind: "migrated", state: decoded, from: storedVersion, to: spec.version };
}

/**
 * Raised when a source's state exceeds its own declared ceiling.
 *
 * Thrown rather than truncated: state is a resume position, and half of one
 * resumes from the wrong place. Failing the page leaves the previous state
 * intact and names the source.
 */
export class SourceStateTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;
  constructor(sourceId: string | undefined, bytes: number, maxBytes: number) {
    super(
      `${sourceId ?? "source"} state is ${bytes} bytes, over its declared ceiling of ${maxBytes}. ` +
        `State is written on every page, so something in it is growing with the corpus rather than ` +
        `describing a position.`,
    );
    this.name = "SourceStateTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/** Wrap a source's state in the envelope the host persists. */
export function encodeSourceState<S extends SourceState>(
  spec: SourceStateSpec<S>,
  state: S,
  opts?: { sourceId?: string },
): StateEnvelope {
  const envelope: StateEnvelope = { e: 1, v: spec.version, state };
  if (spec.minorVersion) envelope.m = spec.minorVersion;
  if (opts?.sourceId) envelope.s = opts.sourceId;
  if (spec.maxBytes !== undefined) {
    // Measured on the envelope, because that is what is written. A source
    // measuring its own inner state would exclude the wrapper.
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (bytes > spec.maxBytes) {
      throw new SourceStateTooLargeError(opts?.sourceId, bytes, spec.maxBytes);
    }
  }
  return envelope;
}

/**
 * Check a state declaration at definition time.
 *
 * Called from `defineSource` / `defineProvider`, so a hole in a migration
 * chain fails at package load rather than on the one installation old enough
 * to fall into it. Throws with a message naming the source.
 */
export function validateStateSpec(
  spec: SourceStateSpec<never> | SourceStateSpec,
  where: string,
): void {
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new Error(`${where}: state.version must be an integer >= 1, got ${String(spec.version)}`);
  }
  if (
    spec.minorVersion !== undefined &&
    (!Number.isInteger(spec.minorVersion) || spec.minorVersion < 0)
  ) {
    throw new Error(
      `${where}: state.minorVersion must be an integer >= 0, got ${String(spec.minorVersion)}`,
    );
  }
  if (typeof spec.decode !== "function") {
    throw new Error(`${where}: state.decode must be a function`);
  }
  const missing: number[] = [];
  for (let from = 1; from < spec.version; from++) {
    if (typeof spec.migrate?.[from] !== "function") missing.push(from);
  }
  if (missing.length > 0) {
    throw new Error(
      `${where}: state.version is ${spec.version} but there is no migration from version ${missing.join(", ")}. ` +
        `Every version an installed release could have written needs a way forward — add state.migrate[${missing[0]}], ` +
        `or drop state.version back if those versions never shipped.`,
    );
  }
  const stray = Object.keys(spec.migrate ?? {})
    .map(Number)
    .filter((n) => !Number.isInteger(n) || n < 1 || n >= spec.version);
  if (stray.length > 0) {
    throw new Error(
      `${where}: state.migrate has entries for version ${stray.join(", ")}, which is not below state.version ${spec.version}. ` +
        `A migration reads version n and returns version n+1, so keys run from 1 to ${spec.version - 1}.`,
    );
  }
}
