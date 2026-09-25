# Sweeps

A sweep is a scheduled pass the background agent makes over the corpus, looking
for one shape of thing. It is an id, a cadence, a local time of day, and a
paragraph of prose. The paragraph is the only per-sweep logic that exists
anywhere: the run prompt splices it into a fixed guardrail envelope the sweep
does not control, and nothing ever parses it.

Sweeps are experimental — the whole lane is gated by `brain.sweepsEnabled` on
top of the brain gate (experimental mode plus an assigned background-agent
model), and the portal's Sweeps tab is hidden outside experimental mode.
`brain.sweepsEnabled` defaults on, so satisfying the brain gate starts every
built-in sweep; the switch is how an operator turns the lane back off. They are deliberately absent from the public docs; this file
is the reference.

## Where a sweep comes from

Two origins share one list.

**System sweeps** ship with the gateway, declared in
`packages/gateway/src/brain/sweeps/system-sweeps.ts`. They are read-only on
every surface. When a release improves one's prose, that improvement reaches
everyone who has not forked it.

**User sweeps** are Markdown files in `<configDir>/sweeps/*.md`. The filename
stem is the sweep id. A file whose id matches a system sweep **layers** over it:
every front-matter key the file omits — and an empty body — inherits the system
value. So silencing a built-in is a two-line file, retiming one is a three-line
file, and forking one is the same file with a body. Deleting the file restores
the system sweep exactly.

A file with an id no system sweep uses defines a new sweep, and must then carry
the two things there is nothing to inherit: a cadence and a body.

Files are re-read on every scheduling pass (cached on mtime), so an edit takes
effect without a restart.

## The file

```markdown
---
name: Commitments I made
cadence: 7d
at: "06:30"
enabled: true
primeHorizonDays: 0
---

Look for promises the user made to someone else and has not yet discharged —
sending something, booking something, giving an answer, making an
introduction. Weigh how long ago the promise was made against how quickly that
person and that relationship usually move. Surface only the ones where a
reminder would genuinely help; skip anything already done and anything still
comfortably within the promised window.
```

Every front-matter key is optional.

| Key                | Meaning                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | Display name on the Sweeps tab. Defaults to the id.                                                                                                     |
| `cadence`          | Minimum gap between runs, as a duration (`7d`, `30d`). At least `24h`, counted in whole days. Required for a new id.                                    |
| `at`               | Local time of day, `HH:MM`. Absent → a slot derived from the id (see below), which is what the portal's editor sends when its time field is left blank. |
| `enabled`          | Default true. `false` silences the sweep without deleting it.                                                                                           |
| `primeHorizonDays` | Prime the prompt with live temporal annotations for the next N days. `0` removes a system sweep's prime.                                                |

The parser is strict: an unknown key is a typo the author wants reported, not
ignored. Every rejection is surfaced on the Sweeps tab and as a `doctor`
failure, and only the offending sweep is skipped — the rest keep running.

Because it is strict, a file using a front-matter key added in a later release
will not load on an older gateway. That fails as one skipped sweep with a clear
message, never as a broken gateway.

## When a sweep runs

A sweep fires on a **boundary**: its local `at` time, on the first such moment
at or after its cadence has elapsed since the boundary it last fired for. The
marker records the boundary, not the wall-clock moment the tick happened to
enqueue it. Three properties follow, and all three are the point:

- **No drift.** A weekly sweep anchored at 06:30 fires at 06:30 forever,
  however late the tick that noticed.
- **Downtime fires once.** A gateway down for a month comes back to a single
  boundary at or before now, so it enqueues one run — never one per missed
  period.
- **Sweeps spread.** Non-daily runs drain strictly serialized, so sweeps
  sharing a clock queue behind each other for hours. An author who names no
  time gets a slot derived deterministically from the id.

Cadences are counted in whole local days, so one that is not a multiple of a
day rounds to the nearest: `36h` comes round every other day. A day is the
floor — a sweep has one boundary per day by construction, and a check that
wants to fire more often is a watch.

### The digest window

The morning digest composes behind a readiness barrier that waits for the whole
run queue to fall quiet. A sweep running between the daily boundary
(`brain.dailyRunHour`) and the digest's grace deadline (`brain.digest.hour` +
`graceMinutes`) therefore holds the digest open until that deadline and thins
the morning brief.

Derived anchors avoid that window by construction, and an explicitly chosen
`at` inside it is reported as a `doctor` warning and on the Sweeps tab — both
only when the digest is actually on. It is on by default
(`brain.digest.enabled`), so assume the window is protected and pick an anchor
outside it; an operator who has turned the digest off has nothing to protect
and the whole day back. System sweeps may declare themselves digest
prerequisites when their output is part of that morning read. The shipped
`may-day` and `missed-calls` sweeps do so and anchor at and just after the
default daily boundary on purpose.

## Writing a good sweep

**The test that decides whether a sweep should exist at all: no arriving datum
would ever trigger the insight.** If an event could wake the real-time lane and
produce the same result, the sweep is redundant by construction. `waiting-on-others`
passes cleanly — silence is the signal, and silence never arrives as an event.
A trend passes: it has no arrival moment. "Tell me when a big charge lands"
fails; that is a watch.

An arriving record that is deliberately deferred from the real-time lane is
not enough on its own to justify a sweep. The scheduled pass must add something
the record's arrival cannot, such as establishing that no later resolution
appeared across other channels. The shipped missed-calls pass follows that
rule: rolling call summaries are reviewed in daily batches, and the useful
signal is whether the attempt still needs attention after later contact has
been reconciled.

Beyond that:

- **Describe a shape of signal, never a query.** The agent decides how to look.
- **Name no source, no tool, no person.** A sweep that needs to know how
  Omnesis is built, or whose data this is, stops being portable — and
  portability is the entire reason a sweep is prose rather than code. Naming
  the substrate it maintains (briefs, loops, deadlines, annotations) is fine;
  that vocabulary is shared.
- **Say when to stay quiet.** An empty pass is a success. Prose that cannot
  produce an empty pass is a noise generator on a timer.
- **Prefer precision to recall.** A couple of high-value briefs beat many
  mediocre ones, and the brief judge will hold the weak ones anyway.

## The push bar

Briefs a sweep writes face the brief judge — the ship/no-ship pass that decides
whether a card earns an interrupt. Which of its gates apply depends on the
sweep's editorial lane, and **only a system sweep can declare one**: the
day-ahead pass is chartered to restate today with the context around it, which
the reactive awareness gate would otherwise read as an echo of what the user
already knows.

Every operator-authored sweep faces all four gates. So does a fork of a system
sweep that carried a lane: the grant was made for the prose the gateway ships,
and a file that replaces that prose has not been through the same judgment.
Retiming, renaming or switching a system sweep off keeps its lane — none of
those change what its cards say.

## Steering is data, not instruction

A sweep file is text an operator may have written, edited, or copied from
somewhere else, and it is handed to an agent with full read access to a
personal corpus. So the run prompt fences the steering, states that the fenced
block is the subject of the pass and nothing more, and re-asserts the guardrails
after it.

Each run mints its own fence token, so a file cannot close a fence whose token
it cannot know — the published one would otherwise be a thing to write around.
The token is also stripped from the prose before it is wrapped, iterated to a
fixed point because a single pass is not one: removing a token can splice its
neighbours into a new one.

Treat an imported sweep the way you would treat any script from a stranger:
read the prose before enabling it.

## What a sweep has produced

Every settled sweep run folds into `cognition_sweep_tally` — runs, tokens,
briefs created, briefs the judge held, loops opened and touched, annotations
recorded. The Sweeps tab reports from it.

It is a durable tally rather than a query for two reasons that both bite
silently: run rows are pruned, so joins through `created_by_run` would quietly
report less the longer a sweep had been running; and `cognition_spend` buckets
by mechanism, where every sweep shares the one id `thematic-sweep`.

Tally rows survive deleting a sweep. The question the operator asks of this
table is "was this sweep ever worth it", and zeroing the history on an edit
would destroy the only evidence.

## Operator surfaces

- **Portal** — Settings → Sweeps (experimental only). One table row per sweep,
  system and user together, carrying the schedule and the production counters;
  the prose opens in a modal, read-only for a sweep still tracking the shipped
  wording. Fork, edit, enable/disable and revert live in the row's ⋯ menu. The
  editor states the cadence in days and treats a blank time as "derive one".
- **HTTP** — `GET /admin/brain/sweeps` (the whole resolved set; there is no
  per-sweep read), `PUT /admin/brain/sweeps/:id` (a partial edit, merged over
  the file), `DELETE /admin/brain/sweeps/:id`, and
  `POST /admin/brain/sweeps/:id/{fork,enabled}`. Admin scope, and the same
  live feature gate as the rest of `/admin/brain/*`. Every mutation answers
  with the whole set.
- **`omnesis doctor`** — reports unloadable files, digest-window conflicts, and
  the lane being switched off while sweeps are configured.
- **Files** — `<configDir>/sweeps/`. Included in `omnesis backup`.

## The deprecated config record

`brain.sweeps` was the pre-file authoring surface. Entries are converted to
files once at start-up, behind an engine-state marker so that deleting a
converted file is not undone on the next boot, and the key is then ignored. The
config editor marks the subtree as owned by the Sweeps tab.
