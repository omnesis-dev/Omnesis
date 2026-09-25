// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The report a person reads when their watches have gone quiet.
 *
 * There is one failure worth designing against here and it has already
 * happened: every watch on an install sat paused because the ontology moved
 * under them, and the report said `0 failed` throughout — because that count
 * only ever saw watches a *node* had thrown in. The layer was completely inert
 * and nothing on the page said so.
 *
 * So the tests are about what cannot be said, not about arithmetic: a stopped
 * watch always lands somewhere, the drifted case is named separately from every
 * other pause because nobody chose it, and "quiet because nothing happened" is
 * distinguishable from "quiet because nothing is running".
 *
 * Fixture data is invented — no corpus content.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every non-test TypeScript source under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

import {
  ANCHOR_UNMINTED_NOTE,
  driftNote,
  ANCHOR_DEVICE_GONE_NOTE,
  HELD_BY_OPERATOR,
  holdUnarmed,
  isUnarmedNote,
  nodeFailedNote,
  layerAlarm,
  layerHealth,
  stalenessBoundMs,
  stoppedCause,
  surfaceNote,
  surfaceReasonOf,
  SURFACE_MOVED,
  SURFACE_UNRECORDED,
  THREW_NOTE,
} from "./health.js";
import type { WatchStatus } from "./definitions.js";

const IDLE_MS = 30_000;
const NOW = Date.parse("2026-03-04T09:00:00.000Z");

function watch(
  status: WatchStatus,
  note: string | null = null,
  hasNodeFailure = false,
): { status: WatchStatus; note: string | null; hasNodeFailure: boolean } {
  return { status, note, hasNodeFailure };
}

const DRIFTED = watch("paused", "no longer validates: ONTOLOGY_FINGERPRINT_MISMATCH");
const HELD = watch("paused", null);
const FAILED = watch("paused", "evaluating it threw — see the gateway log", true);

function health(
  watches: ReturnType<typeof watch>[],
  overrides: Partial<Parameters<typeof layerHealth>[0]> = {},
) {
  return layerHealth({
    watches,
    lastEvaluatedAtMs: NOW - 1_000,
    journalHead: 100,
    journalHeadAtMs: NOW - 1_000,
    evaluatedThroughSeq: 100,
    startedAtMs: NOW - 86_400_000,
    idleEvaluateIntervalMs: IDLE_MS,
    now: NOW,
    ...overrides,
  });
}

describe("what stopped a watch", () => {
  it("puts every stopped watch somewhere", () => {
    // The property the count depends on. A cause that returned null for a
    // watch that is not running would subtract it from `stopped.total` and
    // from `active` at once — it would vanish from the report entirely.
    for (const w of [DRIFTED, HELD, FAILED, watch("retired", "its horizon passed")]) {
      expect(stoppedCause(w, w.hasNodeFailure), `${w.status}/${String(w.note)}`).not.toBeNull();
    }
    expect(stoppedCause(watch("active"), false)).toBeNull();
  });

  it("separates an ontology move from every other pause", () => {
    // The distinction the whole feature exists for. A watch someone held is a
    // decision they remember making; a watch the ontology stopped is one
    // nobody chose, and it is silent in a way that reads like a quiet week.
    expect(stoppedCause(DRIFTED, false)).toBe("drifted");
    expect(stoppedCause(HELD, false)).toBe("held");
  });

  it("prefers the node failure when a watch carries both", () => {
    // The failure record names the node and the class; a note cannot.
    expect(stoppedCause(watch("paused", "no longer validates: X", true), true)).toBe("failed");
  });
});

describe("an inert layer cannot read as healthy", () => {
  it("counts every stopped watch alongside the ones that run", () => {
    const h = health([watch("active"), DRIFTED, DRIFTED, HELD, FAILED]);

    expect(h.active).toBe(1);
    expect(h.stopped.total).toBe(4);
    expect(h.stopped).toMatchObject({ drifted: 2, held: 1, failed: 1, retired: 0 });
  });

  it("raises the alarm when the whole layer has stopped", () => {
    // The incident, exactly: 22 watches, every one of them paused by a
    // fingerprint move, and a report that said nothing was wrong.
    const h = health(Array.from({ length: 22 }, () => DRIFTED));

    expect(h.active).toBe(0);
    expect(h.alarm).toContain("no watch is evaluating");
    expect(h.alarm).toContain("22 drifted");
  });

  it("says an ontology move even while other watches still run", () => {
    // The half-stopped install, which is the more likely one: a watch over the
    // table whose schema moved stops, everything else carries on, and the
    // person relying on that one watch hears nothing.
    const h = health([watch("active"), watch("active"), DRIFTED]);

    expect(h.active).toBe(2);
    expect(h.alarm).toContain("the ontology moved under them");
  });

  it("says nothing when every watch is running", () => {
    expect(health([watch("active"), watch("active")]).alarm).toBeNull();
  });

  it("does not alarm on a retired watch", () => {
    // Retirement is a watch finishing its job, not a fault. Counting it as one
    // would make every install that has ever used a one-shot watch look sick.
    const h = health([watch("active"), watch("retired", "fired once and was done")]);

    expect(h.stopped.retired).toBe(1);
    expect(h.alarm).toBeNull();
  });
});

describe("faults nobody chose, and decisions somebody did", () => {
  it("counts a watch that threw as a fault, not as one somebody held", () => {
    // It stopped because evaluating it raised, which is a fault even though no
    // failure record names a node — the throw happened outside any one node.
    // Filing it under `held` would report a fault as an operator's decision,
    // and `held` alarms only when nothing at all is running.
    expect(stoppedCause(watch("paused", THREW_NOTE), false)).toBe("failed");
  });

  it("classifies the note the runtime actually writes", () => {
    // Writer and reader share the builder rather than a copied string. A
    // reworded note used to reclassify every drifted watch as held, silently,
    // with every test still green.
    expect(stoppedCause(watch("paused", driftNote("ONTOLOGY_FINGERPRINT_MISMATCH")), false)).toBe(
      "drifted",
    );
  });

  it("counts a watch held for review as drifted, not as somebody's decision", () => {
    // It says a different sentence because the operator does a different thing
    // about it, but the same thing stopped it: the ontology moved. Filed as
    // `held` it would sit among the watches somebody chose to pause — and
    // `held` only alarms when nothing at all is running, so a half-drifted
    // install would go silent.
    expect(stoppedCause(watch("paused", surfaceNote(SURFACE_MOVED)), false)).toBe("drifted");
    expect(stoppedCause(watch("paused", surfaceNote(SURFACE_UNRECORDED)), false)).toBe("drifted");
  });

  it("reads back why a watch is held for review, and only from that note", () => {
    expect(surfaceReasonOf(surfaceNote(SURFACE_MOVED))).toBe(SURFACE_MOVED);
    // Not from the other drift note, which asks for something else entirely.
    expect(surfaceReasonOf(driftNote("ONTOLOGY_FINGERPRINT_MISMATCH"))).toBeNull();
    expect(surfaceReasonOf(null)).toBeNull();
  });

  it("does not call an install with only retired watches broken", () => {
    // A one-shot watch that fired and finished is the system working. Alarming
    // here would make every install that has ever used one permanently red.
    const h = health([watch("retired", "fired once and was done")]);

    expect(h.active).toBe(0);
    expect(h.alarm).toBeNull();
  });
});

describe("quiet because nothing happened, or because nothing is running", () => {
  it("does not call an install with no watches stalled", () => {
    // Nothing is supposed to be reading the journal, so a journal ahead of the
    // cursor is the system working. This fired on every healthy install that
    // had not written a watch yet.
    const h = health([], {
      lastEvaluatedAtMs: null,
      journalHead: 500,
      evaluatedThroughSeq: 0,
    });

    expect(h.liveness.stalled).toBe(false);
    expect(h.alarm).toBeNull();
  });

  it("is not stalled when it has read everything there is", () => {
    // The ordinary idle install. Alarming here would fire on every quiet
    // night and train the reader to ignore the line.
    const h = health([watch("active")], {
      lastEvaluatedAtMs: NOW - 86_400_000,
      journalHead: 100,
      evaluatedThroughSeq: 100,
    });

    expect(h.liveness.stalled).toBe(false);
    expect(h.alarm).toBeNull();
  });

  it("does not call a gateway that has only just started stalled", () => {
    // It has not stopped evaluating; it has not begun. Every restart reported
    // a stalled engine until the first event happened to arrive, which put a
    // red line on a healthy install after every deploy.
    const h = health([watch("active")], {
      lastEvaluatedAtMs: null,
      startedAtMs: NOW - 2_000,
      journalHead: 17_383,
      evaluatedThroughSeq: 17_000,
    });

    expect(h.liveness.stalled).toBe(false);
    expect(h.alarm).toBeNull();
  });

  it("is stalled when it has been up long enough and still read nothing", () => {
    const h = health([watch("active")], {
      lastEvaluatedAtMs: null,
      startedAtMs: NOW - stalenessBoundMs(IDLE_MS) - 1,
      journalHead: 140,
      evaluatedThroughSeq: 100,
    });

    expect(h.liveness.stalled).toBe(true);
    expect(h.alarm).toContain("since this gateway started");
  });

  it("is stalled when the journal is ahead and nothing has evaluated", () => {
    const h = health([watch("active")], {
      lastEvaluatedAtMs: NOW - stalenessBoundMs(IDLE_MS) - 1,
      journalHead: 140,
      evaluatedThroughSeq: 100,
    });

    expect(h.liveness.stalled).toBe(true);
    expect(h.alarm).toContain("has not evaluated");
  });

  it("gives a slow tick room before calling it stopped", () => {
    // One missed cadence is a busy writer, not a dead engine.
    const h = health([watch("active")], {
      lastEvaluatedAtMs: NOW - IDLE_MS * 2,
      journalHead: 140,
      evaluatedThroughSeq: 100,
    });

    expect(h.liveness.stalled).toBe(false);
  });

  it("reports the journal head's age, so an idle ingest is visible too", () => {
    const h = health([watch("active")], { journalHeadAtMs: NOW - 3_600_000 });

    expect(h.liveness.journalHeadAgeMs).toBe(3_600_000);
    expect(h.liveness.journalHeadAt).toBe(new Date(NOW - 3_600_000).toISOString());
  });

  it("says it has never evaluated rather than pretending it just did", () => {
    const h = health([watch("active")], { lastEvaluatedAtMs: null });

    expect(h.liveness.lastEvaluatedAt).toBeNull();
    expect(h.liveness.lastEvaluatedAgeMs).toBeNull();
  });
});

describe("which fault is said first", () => {
  it("leads with nothing running over anything else", () => {
    // An operator reading one line should be told the worst thing. A layer
    // with nothing evaluating is worse news than one watch that stopped.
    const alarm = layerAlarm({
      active: 0,
      stopped: { total: 3, drifted: 2, failed: 1, unarmed: 0, held: 0, retired: 0 },
      liveness: {
        lastEvaluatedAt: null,
        lastEvaluatedAgeMs: null,
        journalHead: 10,
        journalHeadAt: null,
        journalHeadAgeMs: null,
        staleAfterMs: 300_000,
        stalled: true,
      },
    });

    expect(alarm).toContain("no watch is evaluating");
  });
});

/**
 * Every note a paused watch can carry, and what each one means.
 *
 * The classification reads the note, and it reads it by *exclusion*: a note it
 * does not recognise falls through to `held`, which says the operator stopped
 * the watch on purpose. So a writer that adds a pause and forgets to teach this
 * about its note does not fail — it files a fault as somebody's decision, on
 * every surface, with an unmarked row and a sentence that is simply untrue. The
 * ontology-drift note has a comment warning about exactly that, and the wake
 * record's note fell into it anyway.
 *
 * This table is the guard. Adding a pause means adding a row here, and a row
 * with no cause of its own is a visible decision rather than a silent one.
 */
describe("every note a pause is written with", () => {
  const NOTES: readonly { note: string | null; cause: string; what: string }[] = [
    { note: THREW_NOTE, cause: "failed", what: "evaluating the watch threw" },
    { note: driftNote("unknown_source"), cause: "drifted", what: "the ontology moved" },
    { note: ANCHOR_UNMINTED_NOTE, cause: "unarmed", what: "its wake record could not be minted" },
    {
      note: ANCHOR_DEVICE_GONE_NOTE,
      cause: "unarmed",
      what: "the device it wakes was unpaired",
    },
    // The one writer whose note is composed rather than named. Its row is here
    // so the note alone decides: the failure record is a second reading of the
    // same fact from another store, and a reader without that store must not
    // put the watch among the ones an operator chose to stop.
    {
      note: nodeFailedNote("mail", "query"),
      cause: "failed",
      what: "one of its nodes threw",
    },
    { note: nodeFailedNote("mail", null), cause: "failed", what: "a node threw with no class" },
    { note: HELD_BY_OPERATOR, cause: "held", what: "the operator stopped it" },
    // A watch paused before any of these notes existed. Read as the operator's
    // rather than accused of a fault it may not have: an unrecognised note is
    // only ever a *missing* row above, and this row is what makes that a
    // decision somebody took rather than a gap nobody saw.
    { note: null, cause: "held", what: "an older build paused it with no note" },
  ];

  for (const { note, cause, what } of NOTES) {
    it(`reads a watch paused because ${what} as ${cause}`, () => {
      expect(stoppedCause({ status: "paused", note }, false)).toBe(cause);
    });
  }

  it("agrees with the resume path about which notes mean unarmed", () => {
    // Two readers, one question. The classification decides how a stopped watch
    // is reported; `isUnarmedNote` decides whether resuming it retries the
    // arming. A note recognised by only one of them is either a watch resumed
    // into silence — active, no record, waking nobody — or a fault filed among
    // the watches an operator chose to stop.
    for (const { note, cause } of NOTES) {
      expect(isUnarmedNote(note), `${String(note)}`).toBe(cause === "unarmed");
    }
  });

  describe("stopping a watch that could not be armed", () => {
    function store(initial: { status: WatchStatus; note: string | null } | null) {
      let held = initial;
      return {
        get: () => held,
        setStatus: (_id: string, status: WatchStatus, note: string | null) => {
          held = { status, note };
        },
        current: () => held,
      };
    }

    it("stops a running watch and says why", () => {
      const s = store({ status: "active", note: null });

      expect(holdUnarmed(s, "w-1", ANCHOR_DEVICE_GONE_NOTE)).toEqual({
        status: "paused",
        note: ANCHOR_DEVICE_GONE_NOTE,
      });
      expect(s.current()).toEqual({ status: "paused", note: ANCHOR_DEVICE_GONE_NOTE });
    });

    it("leaves a watch that has already finished alone", () => {
      // The boot reconciliation walks every watch declaring a wake, whatever
      // its status. A retired one has done its job; stopping it again replaces
      // "fired once and was done" with a fault, moves it out of `retired`, and
      // makes it resumable onto the cursor it finished at.
      const s = store({ status: "retired", note: "fired once and was done" });

      holdUnarmed(s, "w-1", ANCHOR_DEVICE_GONE_NOTE);

      expect(s.current()).toEqual({ status: "retired", note: "fired once and was done" });
    });

    it("leaves a watch the operator stopped alone", () => {
      // Same walk, and the worse half: a decision rewritten as a fault.
      const s = store({ status: "paused", note: HELD_BY_OPERATOR });

      holdUnarmed(s, "w-1", ANCHOR_DEVICE_GONE_NOTE);

      expect(s.current()).toEqual({ status: "paused", note: HELD_BY_OPERATOR });
    });

    it("keeps the note that names the cause over the one that does not", () => {
      // Arming writes the specific note and answers null; the install and
      // resume paths see only the null and would write the general one over
      // it. The operator would be told to resume a watch that resuming cannot
      // fix, and told it again on every attempt. What stops the second write is
      // that the first one already stopped the watch.
      const s = store({ status: "active", note: null });

      holdUnarmed(s, "w-1", ANCHOR_DEVICE_GONE_NOTE);
      holdUnarmed(s, "w-1", ANCHOR_UNMINTED_NOTE);

      expect(s.current()?.note).toBe(ANCHOR_DEVICE_GONE_NOTE);
    });

    it("says nothing about a watch that is no longer there", () => {
      expect(holdUnarmed(store(null), "w-1", ANCHOR_UNMINTED_NOTE)).toBeNull();
    });

    it("is the only thing in the gateway that writes an unarmed note", () => {
      // The premise the single rule above rests on. `holdUnarmed` writes the
      // note and the `paused` status in one statement and refuses a watch that
      // is not running, so the state that would clobber a specific note — an
      // *active* watch already carrying an unarmed one — is unreachable only
      // while nothing else can put a watch into it.
      //
      // A second writer would fail nothing above: it would simply create that
      // state, and the next hold would write the general note over the
      // specific one. So the exhaustiveness is pinned rather than argued.
      //
      // Both statements that write `watch_defs.note` are named here —
      // `setStatus` and the `put` upsert — and neither may carry an unarmed
      // note anywhere outside this module, which is where `holdUnarmed` passes
      // one through as a parameter.
      const root = join(dirname(fileURLToPath(import.meta.url)), "..");
      const offenders: string[] = [];
      for (const file of sourceFiles(root)) {
        if (file.endsWith(join("watch", "health.ts"))) continue;
        const text = readFileSync(file, "utf8");
        for (const call of text.matchAll(/\.(setStatus|put)\s*\(/g)) {
          // The arguments, bounded rather than brace-matched: every call site
          // in this tree fits well inside this, and a guard that parsed
          // TypeScript to be exact would be a second thing to keep correct.
          const args = text.slice(call.index, call.index + 400);
          if (!/ANCHOR_UNMINTED_NOTE|ANCHOR_DEVICE_GONE_NOTE/.test(args)) continue;
          const line = text.slice(0, call.index).split("\n").length;
          offenders.push(`${file.slice(root.length + 1)}:${line}`);
        }
      }
      expect(offenders, "an unarmed note is written outside holdUnarmed").toEqual([]);
    });
  });

  it("names a fault whatever the note says, once a node failure is on record", () => {
    // The most specific fact wins: the failure record names the node and the
    // class, which no note can.
    expect(stoppedCause({ status: "paused", note: HELD_BY_OPERATOR }, true)).toBe("failed");
  });
});
