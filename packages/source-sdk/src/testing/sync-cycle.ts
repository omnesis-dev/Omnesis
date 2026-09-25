// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A provider-contract check: **a full sync cycle against unchanged upstream is
 * a no-op.**
 *
 * A multi-phase source is a small state machine — sweep a listing, enrich what
 * the listing could not carry, stamp what has been enriched so the next sweep
 * skips it. Each phase is easy to test alone, and each one passing says nothing
 * about the loop they form. The failure this exists to catch lives only in the
 * seam: two phases that persist the same field from different inputs, or that
 * write a value one way and read it back another, disagree forever. Every
 * cycle then re-does work upstream never asked for, at a cost that scales with
 * the corpus and never stops — a third-party API call and a fresh set of change
 * events per item per cycle, for as long as the source is connected. Nothing
 * downstream can tell that traffic from the real thing, because as far as the
 * store is concerned the row genuinely did change.
 *
 * The helper owns the row store, because the phases under test talk to each
 * other through it: enrichment finds its work by asking which rows the sweep
 * left unstamped. A caller drives its real phase functions in `step` and reads
 * that store through `rows`, so what is exercised is the actual state machine
 * rather than a description of one.
 *
 * ## Two properties, failing differently
 *
 * - **Convergence** — the phases reach a state where the machine stops
 *   producing work. One that never does is spending a third-party call per item
 *   per cycle indefinitely.
 * - **Stability** — a further full cycle leaves the stored rows exactly as they
 *   were.
 *
 * ## Why stability compares the store, not the emissions
 *
 * A source re-submitting a row it already wrote, unchanged, is ordinary: the
 * ingest signal fires per record per page and the journal deduplicates it, so
 * failing that would fail most correct sources. A source whose second cycle
 * leaves any row *different* — a column moved, a row appeared, a column
 * vanished — has phases that disagree, and that is the defect, however it
 * arrived. Comparing the store catches all three; counting emissions catches
 * the first only by also condemning the innocent case.
 *
 * ## Reaching the phase that misbehaves
 *
 * The settle cycle never stops at a quiet stretch. Ending it there passes a
 * source whose offending phase sits further round the ring than that stretch is
 * long: the machine goes quiet before reaching it, on both cycles, and the
 * report comes back clean. So the settle cycle keeps going until it has watched
 * the cursor return to a state it has already been in — a whole ring — and for
 * a machine whose cursor only ever advances, and so has no ring to close,
 * {@link SyncCycleContract.settleSteps} is the whole of the guarantee.
 */

/** A row a phase wrote, as the provider hands it to the gateway. */
export interface EmittedRow {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

/** What one call into a source's sync produced. */
export interface SyncStepResult {
  readonly records: readonly EmittedRow[];
  /** The cursor to hand the next call. */
  readonly cursor: unknown;
  /** Whether the source wants to be called again before the cycle is done. */
  readonly hasMore: boolean;
}

export interface SyncCycleContract {
  /** The cursor a freshly-added source starts from. */
  readonly initialCursor: unknown;
  /**
   * Run one call into the source's sync and return what it emitted.
   *
   * `rows` is the store as the previous steps left it — the stand-in for the
   * analytics tables a phase queries to find its own pending work.
   */
  step(
    cursor: unknown,
    rows: (table: string) => readonly Record<string, unknown>[],
  ): Promise<SyncStepResult> | SyncStepResult;
  /** The columns identifying a row in a table. */
  primaryKey(table: string): readonly string[];
  /**
   * Columns excluded from the comparison: fetch stamps, internal digests,
   * anything the source rewrites as bookkeeping. Mirrors the `volatile`
   * declaration an analytics schema already carries, and is best derived from
   * it rather than restated, so the two cannot drift.
   */
  volatileColumns?(table: string): readonly string[];
  /**
   * How many calls the settle cycle makes, and how long a writeless run counts
   * as quiescence.
   *
   * The settle cycle runs at least this many calls and then continues until the
   * cursor comes round to a state it has already been in, so a ring-shaped
   * machine is covered whatever this is set to. A cursor that only ever
   * advances never closes a ring, and for that shape this is the only bound
   * there is: **set it to at least the number of phases the source walks.**
   */
  readonly settleSteps?: number;
  /**
   * Calls allowed before the first cycle is called non-convergent.
   *
   * Bounds a genuine loop. It also bounds a first-ever bootstrap, so a source
   * paging through a large fixture needs it raised — the two are different
   * quantities and this knob is only the larger of them.
   */
  readonly maxSteps?: number;
}

export interface RewrittenColumn {
  readonly table: string;
  readonly key: string;
  readonly column: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface SyncCycleReport {
  /** Calls the first cycle took to go quiet. */
  readonly stepsToConverge: number;
  readonly converged: boolean;
  /**
   * Rows the settle cycle emitted. Not a failure on its own — re-submitting an
   * unchanged row is ordinary — but a useful measure of how much work a settled
   * cycle still does.
   */
  readonly rowsAfterConvergence: number;
  /** Stored values the settle cycle moved. Empty when stable. */
  readonly rewritten: readonly RewrittenColumn[];
}

const DEFAULT_MAX_STEPS = 500;
const DEFAULT_SETTLE_STEPS = 16;
/** Stands in for a row or column absent on one side of a comparison. */
const ABSENT = Symbol("absent");

/**
 * A row's identity, as a string adjacent values cannot forge.
 *
 * The delimiter and the null stand-in are written as `\u` escapes rather than
 * as literal control bytes, which would be invisible here and in every diff
 * that ever showed this line. No primary-key value contains either, so
 * `{a:"x", b:"yz"}` and `{a:"xy", b:"z"}` stay distinct instead of both
 * reading as `xyz`.
 */
function keyOf(row: Record<string, unknown>, columns: readonly string[]): string {
  return columns.map((column) => String(row[column] ?? "\u0000")).join("\u0001");
}

/**
 * A stable identity for a value, used both for cursor states and for comparing
 * stored columns.
 *
 * Not `JSON.stringify`: it is insertion-order dependent, so the same logical
 * cursor built with its fields in a different order would look like a different
 * state; it renders a `Set` or `Map` as `{}`, so a cursor carrying pending ids
 * would look like the *same* state on every call and the ring would appear to
 * close immediately; and it throws outright on a cycle or a BigInt. Each of
 * those fails toward "converged", the direction that hides a defect.
 */
function identity(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) {
    return `Set(${[...value]
      .map((v) => identity(v, seen))
      .sort()
      .join(",")})`;
  }
  if (value instanceof Map) {
    return `Map(${[...value]
      .map(([k, v]) => `${String(k)}:${identity(v, seen)}`)
      .sort()
      .join(",")})`;
  }
  if (Array.isArray(value)) return `[${value.map((v) => identity(v, seen)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${identity(v, seen)}`)
    .join(",")}}`;
}

/**
 * Whether two stored values are the same reading.
 *
 * Structural rather than by reference for objects and arrays: each cycle builds
 * its rows fresh, so a column holding JSON is a different instance every time
 * and reference equality would report it as rewritten on every run. `Object.is`
 * decides primitives, which is what makes a NaN column equal to itself; `-0`
 * and `0` are deliberately the same, as they are to every store this models.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Object.is(a, b) || (a === 0 && b === 0);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return Object.is(a, b);
  }
  return identity(a) === identity(b);
}

type Store = Map<string, Map<string, Record<string, unknown>>>;

/**
 * Drive a source to quiescence, then run one more full cycle and report what
 * moved in the store.
 *
 * Returns rather than throws, so a caller can assert on the specifics; see
 * {@link expectUnchangedUpstreamIsNoOp} for the assertion most callers want.
 */
export async function runSyncCycleContract(contract: SyncCycleContract): Promise<SyncCycleReport> {
  const maxSteps = contract.maxSteps ?? DEFAULT_MAX_STEPS;
  const settleSteps = contract.settleSteps ?? DEFAULT_SETTLE_STEPS;
  const store: Store = new Map();

  const rowsIn = (table: string): readonly Record<string, unknown>[] => [
    ...(store.get(table)?.values() ?? []),
  ];
  const write = (emitted: readonly EmittedRow[]): void => {
    for (const { table, row } of emitted) {
      const rows = store.get(table) ?? new Map<string, Record<string, unknown>>();
      const key = keyOf(row, contract.primaryKey(table));
      // Merged onto what is already stored, because that is what the analytics
      // writer does: its upsert sets only the columns the page carried and
      // leaves the rest standing. Modelling it as a replace would report every
      // column a narrow enrichment page omitted as having been cleared — the
      // normal shape of a multi-phase source, and so a failure aimed at exactly
      // the sources this exists to serve.
      rows.set(key, { ...rows.get(key), ...row });
      store.set(table, rows);
    }
  };

  /** The store reduced to the values worth comparing. */
  const snapshot = (): Store => {
    const out: Store = new Map();
    for (const [table, rows] of store) {
      const volatileColumns = new Set(contract.volatileColumns?.(table) ?? []);
      out.set(
        table,
        new Map(
          [...rows].map(([key, row]) => [
            key,
            Object.fromEntries(
              Object.entries(row).filter(([column]) => !volatileColumns.has(column)),
            ),
          ]),
        ),
      );
    }
    return out;
  };

  // Cycle one: drive until the machine stops producing work, noting how long
  // the phase ring is if the cursor ever returns to a state it has been in.
  let cursor = contract.initialCursor;
  let converged = false;
  let stepsToConverge = 0;
  let ringLength = 0;
  let writeless = 0;
  const visitedAt = new Map<string, number>();
  for (let step = 0; step < maxSteps; step += 1) {
    const key = identity(cursor);
    const previously = visitedAt.get(key);
    if (previously !== undefined) {
      const lap = step - previously;
      ringLength = Math.max(ringLength, lap);
      // The ring came round with nothing written anywhere on it.
      if (writeless >= lap) {
        stepsToConverge = step;
        converged = true;
        break;
      }
    }
    visitedAt.set(key, step);
    const result = await contract.step(cursor, rowsIn);
    cursor = result.cursor;
    stepsToConverge = step + 1;
    if (result.records.length > 0) {
      write(result.records);
      writeless = 0;
      continue;
    }
    // `hasMore` is the source asking to be called again; it has not settled,
    // whatever it did or did not emit.
    if (result.hasMore) {
      writeless = 0;
      continue;
    }
    writeless += 1;
    if (writeless >= settleSteps) {
      converged = true;
      break;
    }
  }

  const before = snapshot();

  // Cycle two: never stops early, and keeps going until it has watched the
  // cursor come all the way round, so a phase sitting further along the ring
  // than the quiet stretch still gets its turn. A machine whose cursor only
  // ever advances has no ring to close, and for it the configured length is
  // the whole of the guarantee.
  const atLeast = Math.max(settleSteps, ringLength);
  const visitedInSettle = new Map<string, number>();
  let emitted = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const key = identity(cursor);
    const ringClosed = visitedInSettle.has(key);
    if (step >= atLeast && ringClosed) break;
    visitedInSettle.set(key, step);
    const result = await contract.step(cursor, rowsIn);
    cursor = result.cursor;
    emitted += result.records.length;
    write(result.records);
    if (step + 1 >= atLeast && visitedInSettle.has(identity(cursor))) break;
  }

  const after = snapshot();
  const rewritten: RewrittenColumn[] = [];
  for (const table of new Set([...before.keys(), ...after.keys()])) {
    const wasRows = before.get(table) ?? new Map<string, Record<string, unknown>>();
    const nowRows = after.get(table) ?? new Map<string, Record<string, unknown>>();
    for (const key of new Set([...wasRows.keys(), ...nowRows.keys()])) {
      const was = wasRows.get(key);
      const now = nowRows.get(key);
      for (const column of new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})])) {
        const wasValue: unknown = was === undefined ? ABSENT : (was[column] ?? ABSENT);
        const nowValue: unknown = now === undefined ? ABSENT : (now[column] ?? ABSENT);
        if (wasValue === ABSENT && nowValue === ABSENT) continue;
        if (wasValue !== ABSENT && nowValue !== ABSENT && sameValue(wasValue, nowValue)) continue;
        rewritten.push({
          table,
          key,
          column,
          before: wasValue === ABSENT ? undefined : wasValue,
          after: nowValue === ABSENT ? undefined : nowValue,
        });
      }
    }
  }

  return { stepsToConverge, converged, rowsAfterConvergence: emitted, rewritten };
}

/**
 * Assert the contract, with a failure message naming what moved.
 *
 * Throws rather than depending on a test framework, so any runner can use it.
 */
export async function expectUnchangedUpstreamIsNoOp(
  contract: SyncCycleContract,
): Promise<SyncCycleReport> {
  const report = await runSyncCycleContract(contract);
  if (!report.converged) {
    throw new Error(
      `Sync never settled: still working after ${report.stepsToConverge} calls. Either a phase ` +
        `produces work on every pass — so each cycle repeats it indefinitely — or the source keeps ` +
        `asking to be called again. Raise maxSteps if this is a large first bootstrap, not a loop.`,
    );
  }
  if (report.rewritten.length > 0) {
    const show = (value: unknown): string =>
      value === undefined ? "(absent)" : JSON.stringify(value);
    const shown = report.rewritten
      .slice(0, 5)
      .map((r) => `  ${r.table}[${r.key}].${r.column}: ${show(r.before)} -> ${show(r.after)}`)
      .join("\n");
    const more = report.rewritten.length > 5 ? `\n  …and ${report.rewritten.length - 5} more` : "";
    throw new Error(
      `A cycle against unchanged upstream changed ${report.rewritten.length} stored value(s). ` +
        `Two phases disagree about these, so each cycle undoes the other's work:\n${shown}${more}`,
    );
  }
  return report;
}
