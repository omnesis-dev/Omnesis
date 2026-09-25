<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# The Brain Bench

The end-to-end correctness net for the Cognition Steward (the "brain").

A bench test boots a **real gateway** with the whole cognition engine live — waker,
queue, rhythm enqueuers, drainer, run driver, tool layer, write gates, cascades — drives
deterministic stimuli, and asserts on what the brain left behind through the same admin
surface the portal and CLI read. The only substitution is the model, wired at the
production seam (the `background-agent` inference assignment).

## What the bench is for, and what it is not for

It answers **"given a decision the steward made, did the machine do the right thing?"**
It never asks "was that a good decision". Quality belongs to the scorecard / eval lane
(`briefs-scorecard.ts`, `evals/briefs/`), which is deliberately separate — so improving a
prompt can never redden correctness CI.

Concretely: assert that a `brief_create` call produced a brief row with its claims,
citations and related loops wired up. Do not assert that the steward _should_ have
created a brief for that document.

## Anatomy of a test

```ts
import "./synth-env.js";
import { BrainBench, call, ref, compressCognitionCadences, email } from "./brain-bench/index.js";

compressCognitionCadences(); // module scope — the spawned gateway inherits these

const DOC = email({ externalId: "x-1", title: "Deposit request", content: "…" });

let bench: BrainBench;
beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    behaviors: {
      behaviors: [
        {
          flavour: "data.created",
          docTitle: DOC.title,
          plan: (ctx) => ({
            calls: [
              call("open_loop_search", { query: "deposit" }),
              call("open_loop_create", {
                title: "Send the deposit",
                confidence: 0.9,
                importance: 0.8,
                docs: [ctx.subject],
              }),
              call("open_loop_ledger_append", {
                id: ref("open_loop_create", "loop.id"),
                note: "Tracked.",
              }),
            ],
          }),
        },
      ],
    },
  });
}, 300_000);
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

test("…", async () => {
  const [docId] = await bench.pushAndSettle([DOC]);
  const loops = await bench.obs.loops();
  expect(loops.items).toHaveLength(1);
});
```

### The behavior table

A `PuppetBehavior` matches a run and supplies a plan. Every field present must match;
the first matching behavior wins, so put specific entries before general ones.

| field            | matches                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `kind`           | the run kind (`data`, `sweep`, `verification`, …)                  |
| `flavour`        | the flavour within a kind (see the table below)                    |
| `subject`        | the run's subject, exactly (doc id, source id, sweep id, brief id) |
| `docTitle`       | the **title of the fetched document** (data / bootstrap runs only) |
| `attempt`        | only this attempt number — for scripting a retry differently       |
| `promptContains` | a substring of the run prompt — the escape hatch for anything else |

`plan` is a `PuppetPlan` or a function of the `RunContext`. Use the function form when the
plan needs the run's subject (`ctx.subject` is the triggering document id on data runs).

**An empty plan is a legitimate behavior** — most runs should do nothing.

### `call` and `ref`

`call(tool, args)` is one scripted tool invocation; the gateway executes it for real.
`ref(tool, path, nth?)` reads a value out of an **earlier call's real result** — necessary
because ids are minted by the gateway, not by the plan. The path is rooted at a structured
result's `data`:

```ts
ref("open_loop_create", "loop.id"); // the id the create just minted
ref("brief_create", "brief.id");
ref("open_loop_search", "loops.0.id"); // a loop an EARLIER RUN created
ref("annotate_durable", "id");
```

Plans execute strictly in order, and progress is counted per tool name, so a plan may
repeat a tool freely. A call that the gateway **rejects** still counts as executed — a
gated write cannot spin forever.

The four loop/brief write tools require `annotationDependencies`; the puppet supplies `[]`
automatically unless the plan sets it.

## Run flavours

`RunFlavour` values the puppet recognizes, from the run prompt:

| kind                 | flavours                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `data`               | `data.created`, `data.updated`, `data.deleted`                                                               |
| `daily`              | `daily.digest`, `daily.source`, `daily.mayday`                                                               |
| `time_based`         | `time_based.scheduled`, `time_based.decay`, `time_based.decay.gone`                                          |
| `feedback`           | `feedback.dismissal`, `feedback.provenance`                                                                  |
| `synthesis`          | `synthesis.noticing`, `synthesis.collision.loops`, `synthesis.collision.temporal`, `synthesis.contradiction` |
| `sweep`              | `sweep` (subject = the sweep id)                                                                             |
| `bootstrap`          | `bootstrap`, `bootstrap.deleted`                                                                             |
| `verification`       | `verification` (subject = `doc` \| `person`), `verification.empty`                                           |
| `merge_adjudication` | `merge_adjudication`, `merge_adjudication.settled`                                                           |
| `notes_compaction`   | `notes_compaction`                                                                                           |

The envelope (`Loop agent run <id> (kind: <kind>, attempt <n>).`) is written and parsed by
one shared implementation in `@omnesis/core` (`cognition-envelope.ts`), so a run's identity
survives any prompt rewording.

**The flavour does not.** It is matched from literal markers in the prompt BODY
(`readRunContext` in `puppet-plan.ts`), so rewording a steward prompt silently drops that
lane's runs into the `unknown` arm — the puppet finishes with a no-op note and the suite
sees no rows, which reads as a brain bug. Change a prompt marker and update
`readRunContext` in the same commit. `malformed` and `unknown` are flavours too; a test
that sees no rows should check `bench.puppetCalls` for the flavour it actually got.

## Tool cheat-sheet

Every **steward-owned** tool's schema is **strict** — an unknown key is an `invalid_args`
error and the run continues without the write. The shared read tools (`fetch_many`,
`search_many`, `lookup_people`) are not: zod silently STRIPS an unknown key there, so a
typo'd arg surfaces as a wrong-looking result rather than an error.

```
open_loop_search(query, limit?)               -> {loops: [{id, title, state, attachedBriefs, …}], retired}
open_loop_fetch(id)                           -> the loop (data IS the loop)
open_loop_create(title, description?, confidence, importance, deadline?, actors?, involved?, docs?, blockedBy?)
                                              -> {loop: {id, …}}
open_loop_update(id, state?, confidence?, importance?, title?, description?, deadline?,
                 actors?, involved?, docs?, blockedBy?, decayCheckPassed?)
                                              -> {loop}         # list fields REPLACE
open_loop_ledger_append(id, note)             -> {loopId, runId, note}
open_loop_delete(id)                          -> {loopId, deletedBriefIds}

brief_list()                                  -> {briefs: [...]}     # active states only
brief_fetch(id)                               -> brief + assertedClaims
brief_create(kind, title, description?, body?, citations?, confidence, urgency,
             relevantUntil?, relatedLoopIds?, nextShow?, eventAt?, supersedes?,
             assertedClaims?, force?)         -> {brief: {id, …}}
brief_update(id, …, assertedClaims?)          -> {brief}             # claims REPLACE
brief_delete(id)                              -> {briefId}

annotate_durable(docId, claimType, claimText, evidenceDocId, evidenceQuote,
                 confidence, claimBasis, supersedes?, additionalEvidence?)   -> {id, …}
annotation_revise(id, claimType?|claimText?|confidence?|claimBasis?)         -> {id, …}
annotation_retract(id)                                                      -> {id}
annotation_supersede(id, supersededBy)                                      -> {id, supersededBy}
annotation_search(docId | personId, limit?)   -> {annotations: [...]}   # READ; makes ids eligible
                                                                        # for annotationDependencies
annotate_person(personId, …)                  -> {id, personId (canonical), …}
person_annotation_revise / _retract / _supersede — same shapes

temporal_annotation_add(when, until?, sentence, kind?, documentIds?, loopIds?,
                        personIds?, projectionIds?, evidence?, force?)      -> {id, when, precision, …}
temporal_annotation_update(annotationId, …)   -> {annotationId}
temporal_annotation_delete(annotationId)      -> {annotationId}

notes_append(text) / notes_rewrite(text) / notes_edit(oldText, newText)
schedule_agent_run(when, prompt, loopId?, onConflict?)
                                              -> {runId, scheduledFor, merged?}
                                                 # scheduledFor = the hour the run REALLY fires
merge_adjudicate(verdict, reason)             -> {candidateId, verdict, outcome, detail}
                                                 # only on merge_adjudication runs

fetch_many(documents: [{documentId}])         -> {kind:"document.batch", items:[{document:{title,…}}]}
search_many(queries: [{query, limit?}])       -> {items:[{results:[{documentId, …}]}]}
lookup_people(query, limit?)                  -> {results:[{canonicalId, displayName, …}]}
temporal_query(from?, to?, kinds?, …)         -> {items:[{id, origin, start, …}]}
```

`evidenceQuote` must be **12–500 characters and appear verbatim in the cited document** —
the quote-in-doc gate rejects anything else, so write fixture content with a quotable
sentence in it.

`kind` for temporal annotations is one of `visit | appointment | event | deadline |
reminder | expiry | episode`.

Contracts that surprised the first authors, so worth stating outright:

- **`annotation_retract` is a HARD delete**, not an invalidate-in-place. There is no
  `invalidated_at` to assert — the row is gone. Soft invalidation with an
  `invalidated_at` is the _supersession_ and _evidence-break_ path.
- **Confidence is clamped by basis** (`quoted` 0.9 / `inferred` 0.7 / `synthesized` 0.55),
  with a 0.25 floor below which the write is refused outright. The clamp is reported back
  to the model as `confidenceCappedTo`.
- **A structured refusal is an `ok` result, not an error** —
  `brief.held_for_verification`, `brief.held_by_judge`, `*.conflict_candidates`,
  `temporal_annotation.overlap_candidates`. It leaves no row, so the only way to observe it
  is the run's tool results (see Observation below).
- **`annotationDependencies` may only name priors surfaced earlier in the SAME run**
  (by `annotation_search`, a prompt-inlined prior, or a write this run made). Anything
  else is `invalid_args`.
- **A second `schedule_agent_run` for a loop that already has a check pending on the
  same UTC day is an `error` `schedule_conflict`**, not a silent dedup — the message
  carries the pending check's id, real fire time and instruction. A plan resolves it by
  calling again with `onConflict: "merge"` (the instruction joins that check, which
  keeps its own hour — `scheduledFor` reports THAT hour, with `merged: true`) or
  `onConflict: "add"` (a second run); a plan that never retries leaves the pending
  check untouched. A merge past the stored instruction's cap is refused the same way,
  with `add` as the only retry.

### Gated writes

| gate                | applies to                             | rejection                                                                 |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| quote-in-document   | every annotation / brief claim         | `error` `evidence_not_found`                                              |
| entailment          | annotations, brief claims, temporal    | Brief outage: structured `brief.held_for_verification`; memory fails open |
| brief judge         | `brief_create` only                    | structured `brief.held_by_judge` (never an error) — fails closed          |
| one-belief conflict | annotate/revise on the same claim type | structured `annotation.conflict_candidates`                               |
| loop conflict       | `brief_create` with a related loop     | structured `brief.loop_conflict_candidates` (pass `force: true`)          |
| authority           | any tool the run's workflow lacks      | the tool is **absent from the toolset** — the call never lands            |

Both gates are unassigned by default. Pass `entailment:` / `judge:` to
`BrainBench.start` to drive their reject arms. A configured outage is tolerated
for durable annotations and temporal memory, but a user-facing Brief is held.

## Observation

`bench.obs` wraps the production read surface — use it rather than raw SQL wherever a
route exists, so each bench run doubles as a contract test:

```
status() statusOf(path) pulse() runs() run(id) settledRuns(kind) scheduled() runKinds()
transcripts() transcript(f) promptFor(runId) decisions()
executedTools(runId)          <- every tool call a run made, WITH the gateway's answer
runForDoc(docId) diffFor(runId)
loops() loop(id) ledger(id) loopsMatching(marker) retiredLoops() productLoops() productLoop(id)
briefs() brief(id) briefsMatching() feed() unreadCount() readBrief(id) dismissBrief(id, body)
docAnnotations(docId) personAnnotations(personId) dependents(store, id)
timeIndex() temporalWindow({from,to}) timeIndexWindow({from,to})
spend() mechanismSpend() coverage() calibration() notes() sweeps()
```

**`obs.executedTools(runId)` is how you observe anything that leaves no row.** A structured
refusal and an authority denial are both invisible in the stores by definition — the first
was never written, the second never had a tool to call. Both appear here: the refusal as a
`structured` result (`brief.held_by_judge`, `*.conflict_candidates`), the denial as an
`unknown_tool` error. `bench.puppetCalls` records only what the puppet EMITTED, so it can
never show you either.

**Shapes differ between surfaces on purpose — and sometimes between the LIST and DETAIL
route of the same surface.** The admin loop _list_ echoes `docs`/`actors`/`involved` as raw
id `string[]`, while the loop _detail_ route and `/loops` both enrich them into refs. The
admin brief _list_ returns `citations: string[]`; the _detail_ route resolves them to
`{id, title, sourceType}`; the product feed uses `{docId, title}`.
`/admin/brain/time-index` serves the storage row (`precision`, unix-ms) while
`/briefs/time-index/window` serves the display serializer (`granularity`, ISO). Check the
route before trusting a type.

Ordering and limits that shape how a test must read:

- `obs.ledger()` pages **newest-first**; the ledger inlined by `obs.loop()` is **oldest-first**.
- Both temporal window routes cap a query at a **400-day span**; wider is a 400.
- `dismissBrief` takes `{ reason }` from `not_relevant | wrong | already_handled |
acknowledged | snoozed` — _not_ a `state`. `already_handled` is loop-kind only and
  `acknowledged` info-kind only; the wrong pairing is a 400.
- `pulse.counts.queuedRuns` counts only runs whose `next_attempt_at <= now`, so a run
  sitting inside its debounce window is **not** in it — `upcomingRuns` carries that.
- `GET /admin/brain/clock` reports `now` as an **ISO string**, not a number.

For state with no route — consumption edges, engine-state markers, evidence sidecars —
use `bench.sql` (a read-only handle).

Whole-state comparison is `snapshotBrainState(bench.sql, epoch)`, which renames minted ids
to per-kind ordinals in an order the test controls, so a golden is comparable across runs.

## Driving the engine

```ts
await bench.push(doc); // create, or update on a repeated externalId
await bench.update(doc, "new content"); // an update transition (diff-carrying run)
await bench.deleteDoc(docId); // the real delete route, cascades and all
await bench.pushAndSettle([a, b]); // push + drain, returns gateway doc ids
await bench.drainUntilQuiet(); // progress-based; fails loudly on a stall
await bench.restartGateway(); // restores the virtual clock — use INSTEAD of harness.restartGateway
await bench.patchConfig({ brain: {} }); // several knobs are read per tick
await bench.clock.advanceDays(1); // requires clock: "virtual"
bench.clock.localDay(ms); // the day key the rhythm markers use
```

`drainUntilQuiet` takes `{ timeoutMs, stallMs, includeUpcoming }`. `includeUpcoming`
defaults to **true**: it also waits out runs that are pending but not yet due, which is what
stops a bench racing past a debounced run of its own. Pass `false` when the test
deliberately parks work in the future (a scheduled follow-up, a decay check) and wants to
assert it is still parked.

Arranging state no enqueuer can produce — a crashed run, a settled merge candidate, an
attempts-exhausted row — goes through the write path:

```ts
bench.withWriteHandle((db) => {}); // a bounded, deliberate injection
bench.seedRun({ id, kind, payload, dedupeKey, status, attempts, nextAttemptAt });
bench.seedRuns([...]); // ONE transaction — required when claim order or concurrency is the subject
bench.runRow(id); // the raw row: unix-ms, not the rendered ISO
bench.runPayload(id); // what the enqueuer actually wrote
bench.pendingDedupeKeys(); // the enqueue-side probe
bench.markers.get(key); // also clear(key) and waitFor(key, predicate)
```

**`bench.markers` is how you observe a rhythm pass.** Every periodic lane's due-gate is a
`cognition_engine_state` row, written LAST in the pass — so a marker moving proves the
pass's enqueues already landed. `drainUntilQuiet` returns as soon as the QUEUE is quiet,
which can be before an enqueuer has ticked at all, so "advance the clock, sleep, assert
nothing new" proves nothing. Gate on the marker instead.

`drainUntilQuiet` polls `/admin/brain/pulse` and extends its deadline whenever a run
settles, so a stalled engine fails with the queue's contents rather than passing as quiet.
Never replace it with a fixed sleep.

## Gotchas

- **`compressCognitionCadences()` must run at module scope**, before the gateway boots —
  the spawned process inherits the env.
- **Bench tests ARE typechecked** — by `packages/collector/tsconfig.tests.json`, which the
  `npm run typecheck:tests` CI lane runs over what the package tsconfig excludes. `npm run
typecheck` alone will not see them, so run `typecheck:tests` before pushing.
- **The ambient universe must not wake the engine.** `loops-test-life` fixtures are dated
  outside the recency window on purpose; assert `data` runs are zero after boot before
  attributing any run to your own stimulus.
- **An unmatched run is silent by design** — the puppet finishes with a note. If a test
  sees no rows, check `bench.puppetCalls` for the flavour it actually got.
- **The virtual clock only exists when `clock: "virtual"`**; `POST /admin/brain/clock`
  400s otherwise. It is **frozen between `set()` calls** — wall time never moves inside a
  phase, so two writes in one phase carry identical timestamps and nothing may assert that
  one is later than another. A clock-driven bench usually also wants
  `brain.derivationBarrier: "0s"`: the barrier defers a data run to `now + 30m`, and under
  a frozen clock a deferred run can never age into being due.
- **`drainUntilQuiet()` is not enough to see a rhythm pass fire.** It returns as soon as the
  queue reads quiet, which can be before a periodic enqueuer has ticked. Gate a clock
  advance on something the pass itself writes — the rhythm markers in
  `cognition_engine_state` are written LAST, so a marker moving proves the enqueues landed.
- **Every new bench file needs path-scoped entries in `privacy/pii-allowlist.json`** for
  its invented names (including the SPDX header name). Edit that JSON **textually** — a
  parse/re-dump round-trip un-escapes em-dashes and churns ~40 unrelated lines. The scanner
  matches two-word windows, so `Cedar Grove Supplies` also trips as `Grove Supplies`.
- One bench boots one gateway subprocess. Group tests that can share a boot into one
  `describe`, and prefer several tests per bench over several benches per file.
