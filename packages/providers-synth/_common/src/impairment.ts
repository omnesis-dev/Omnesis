// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source-agnostic way to make a synthetic source read badly on demand.
 *
 * Two things can happen to a source between one sync and the next, and from the
 * gateway's side they look identical: the records really went away, or the
 * source failed to read the part of itself that holds them. The first is a
 * deletion the gateway should apply. The second is a hole the gateway must not
 * act on. What separates them is entirely in the source's hands — whether it
 * emits `presentExternalIds`, its claim to have enumerated everything.
 *
 * Nothing in the synthetic corpus could produce the second shape, so no test
 * could tell the two apart end to end. This knob produces both:
 *
 * - `degraded` — the source cannot see the last N of its records this cycle.
 *   It emits the records it can see and **withholds** the snapshot, because it
 *   has not enumerated everything. The gateway must leave the corpus alone.
 * - `deleted` — the last N records are genuinely gone. The source emits a
 *   complete snapshot naming only the survivors, and the gateway must delete
 *   the rest.
 * - `partitioned` — one of the source's two partitions could not be read, and
 *   N records are additionally gone from the one that could. The source claims
 *   only the readable partition, so the gateway must delete those N and leave
 *   every record in the unreadable partition alone. Both halves of the
 *   per-partition contract in one cycle, which is the only way to tell "it
 *   swept the right partition" from "it swept nothing".
 *
 * Driven by `OMNESIS_SYNTH_READ_IMPAIRMENT`, a comma-separated list of
 * `<sourceIdSubstring>:<mode>:<n>` rules. `*` as the substring matches every
 * source, which is what a source-agnostic sweep over a whole universe wants:
 *
 *   OMNESIS_SYNTH_READ_IMPAIRMENT="things:local:degraded:2"
 *   OMNESIS_SYNTH_READ_IMPAIRMENT="*:degraded:1"
 *   OMNESIS_SYNTH_READ_IMPAIRMENT="apple-notes:deleted:1,things:degraded:3"
 *
 * The mode and the count are the last two fields, so a match containing colons
 * of its own — a source id such as `things:local` — needs no escaping.
 *
 * The variable is read on every call rather than cached, so a test can turn a
 * source's read bad between two syncs of one running collector.
 */

export type SynthImpairmentMode = "degraded" | "deleted" | "partitioned";

export interface SynthImpairment {
  mode: SynthImpairmentMode;
  /** How many entries at the tail of the fixture list are withheld from the read. */
  hide: number;
}

const ENV_VAR = "OMNESIS_SYNTH_READ_IMPAIRMENT";

/**
 * The impairment in force for `sourceId`, or `null` when the source is healthy.
 * A source whose id is not known to the caller matches only a `*` rule.
 */
export function readImpairment(sourceId: string | undefined): SynthImpairment | null {
  const spec = process.env[ENV_VAR];
  if (!spec) return null;

  for (const rule of spec.split(",")) {
    // Parsed from the right: a source id contains colons of its own
    // (`things:local`), so only the trailing mode and count are fixed fields
    // and everything before them is the match.
    const parts = rule.trim().split(":");
    if (parts.length < 2) continue;
    let hide = 1;
    if (/^\d+$/.test(parts[parts.length - 1])) hide = Number.parseInt(parts.pop()!, 10);
    const mode = parts.pop();
    const match = parts.join(":");
    if (mode !== "degraded" && mode !== "deleted" && mode !== "partitioned") continue;
    if (match.length === 0) continue;
    const matches = match === "*" || (sourceId !== undefined && sourceId.includes(match));
    if (!matches) continue;
    return { mode, hide };
  }
  return null;
}

/**
 * Which of a source's two partitions an entry sits in.
 *
 * Stamped on every synthetic document, always — not only under the
 * `partitioned` mode. A claim can only reach documents whose stored partition
 * matches it, so if the key appeared the moment a cycle went partitioned, the
 * documents ingested by every healthy cycle before it would sit in the unnamed
 * partition and no claim would ever name them: the test would pass by sweeping
 * nothing.
 */
export function synthPartitionOf(index: number): string {
  return index % 2 === 0 ? "even" : "odd";
}

/**
 * The partition the `partitioned` mode makes unreadable.
 *
 * Exported because a twin whose partitions are its own stores — one Notion
 * database, one repository — decides readability itself rather than through
 * {@link impairEntries}, and the two have to agree on which half is broken.
 */
export const SYNTH_UNREADABLE_PARTITION = "odd";

/**
 * Apply an impairment to an ordered fixture list.
 *
 * Returns the entries the source can see this cycle and whether it is entitled
 * to claim a complete snapshot over them. Both modes hide the same records; only
 * the claim differs, which is the whole point — a test that changes only the
 * claim isolates the contract from every other variable.
 */
export function impairEntries<T>(
  entries: T[],
  sourceId: string | undefined,
  idOf?: (entry: T) => string,
): { visible: T[]; snapshotAllowed: boolean; partitioned?: boolean } {
  const impairment = readImpairment(sourceId);
  if (impairment?.mode === "partitioned") {
    // The unreadable partition contributes nothing to the read, and the last
    // `hide` entries of the readable one are genuinely gone.
    const readable = entries.filter((_, i) => synthPartitionOf(i) !== SYNTH_UNREADABLE_PARTITION);
    const keptCount = Math.max(0, readable.length - impairment.hide);
    const visible = readable.slice(0, keptCount);
    if (idOf) recordHidden(sourceId, readable.slice(keptCount).map(idOf));
    // NOT a whole-source snapshot: `visible` is one partition's worth, so a
    // caller that published it as `presentExternalIds` would be telling the
    // gateway that the other partition's records no longer exist. A caller
    // that understands claims asks for them by name; every other caller sees
    // a degraded read and withholds, which is the safe answer for a twin that
    // has not been taught the mode.
    return { visible, snapshotAllowed: false, partitioned: true };
  }
  const keep = impairment ? Math.max(0, entries.length - impairment.hide) : entries.length;
  const visible = impairment ? entries.slice(0, keep) : entries;

  // Record what this read could not see, so a test can assert on identities
  // rather than counts. Recorded on every call, healthy ones included, so a
  // source that has been repaired reports an empty set instead of the stale one
  // from the cycle before.
  if (idOf) recordHidden(sourceId, entries.slice(keep).map(idOf));

  if (!impairment || impairment.hide === 0) return { visible: entries, snapshotAllowed: true };
  return { visible, snapshotAllowed: impairment.mode === "deleted" };
}

/**
 * The ids the most recent impaired read of `sourceId` did not return.
 *
 * A test asserting only on counts cannot tell "the right two documents
 * survived" from "two documents survived", and the difference is the entire
 * property under test. This lets a test name the survivors:
 *
 * ```ts
 * const vanished = impairedIds(sourceId);
 * expect(storedIds()).toEqual(before.filter((id) => !vanished.includes(id)));
 * ```
 *
 * Preferred over computing the hidden set from the fixture by re-implementing
 * "the last N entries": that is a promise about ordering which rots silently the
 * first time somebody reorders a fixture file, and a test built on it goes on
 * passing while asserting the wrong thing.
 *
 * Only meaningful after the source has actually synced — it reports what a read
 * did, not what a rule would do. Empty for a source that has not run, or whose
 * twin does not pass an id extractor.
 */
export function impairedIds(sourceId: string | undefined): string[] {
  return [...(hiddenBySource.get(sourceId ?? "") ?? [])];
}

/** Hidden ids from the most recent read, keyed by source id. */
const hiddenBySource = new Map<string, string[]>();

function recordHidden(sourceId: string | undefined, ids: string[]): void {
  hiddenBySource.set(sourceId ?? "", ids);
}

/**
 * The same impairment, for a twin that assembles its own snapshot rather than
 * going through `syncFromFixture`.
 *
 * Returns the entries the source can see plus the snapshot it is entitled to
 * publish over them — `undefined` when the read was degraded. Twins that hand-
 * roll `presentExternalIds` must route through here, or a universe-wide sweep
 * silently skips them and the sweep's coverage claim becomes false.
 */
export function impairedSnapshot<T>(
  entries: T[],
  sourceId: string | undefined,
  externalIdOf: (entry: T) => string,
): { visible: T[]; presentExternalIds: string[] | undefined } {
  const { visible, snapshotAllowed } = impairEntries(entries, sourceId, externalIdOf);
  return {
    visible,
    presentExternalIds: snapshotAllowed ? visible.map(externalIdOf) : undefined,
  };
}
