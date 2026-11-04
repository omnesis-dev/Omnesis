---
name: latency-watch
description: Check Omnesis gateway latency and stalls, investigate recurring performance defects, and prepare tested fix pull requests. Use when asked to monitor or investigate gateway performance.
---

Keep the gateway fast for the people using it. Watch its latency counters
against the service level below, and when it is broken, find the code
responsible, fix it, prove the fix is correct and faster, and open a pull
request for the operator to review.

## Invocation and scheduling

Use the user's accompanying instructions for the scope, gateway connection,
and cadence. Invoking this skill runs one check; recurring monitoring requires
the operator to request it and a scheduler supported by the host agent.

- **Claude Code:** `/latency-watch` runs one check. For requested recurring
  monitoring, use `/loop /latency-watch`. Without an interval, schedule the next
  run at the phase delay below. With a fixed interval (`/loop 1h /latency-watch`),
  run one check per fire and ignore the phase delays.
- **Codex:** invoke `$latency-watch`. Claude's `/loop` is not a Codex command.
  For requested recurring monitoring, use a scheduling capability actually
  available in the current environment. If none is available, run one check
  and report the next recommended check time; do not claim monitoring is active.

Use one scheduler for this monitor; do not create duplicate recurring jobs.
Only report a next run as scheduled after the scheduling tool confirms it.

Read these before the first investigation. They hold the rules and the patterns
that have already worked:

- `docs/stall-investigation.md`: the main-thread rule, the sanctioned fixes, and
  how to read a stall line, `/admin/stalls` and a flight-recorder profile.
- `docs/conventions.md`, section "The writer is one thread".
- `CLAUDE.md`, sections "Known performance work" and "Tests are mandatory".
- Local instructions (`CLAUDE.local.md`, if present): how this machine reaches its
  gateway, how it authenticates, and whether and how this loop may deploy.

## The service level

A request is **interactive** when a person is waiting for it, either directly
(the portal, the mobile apps, the browser extension's Find, the CLI) or through
an agent working for them (MCP Answer and Direct tools, OpenClaw or Hermes tool
calls, agent messages). Interactive requests are what this loop protects.
Background work matters only as a cause: a collector page that holds the writer
is how an interactive request ends up waiting.

| Class                  | Who                                                                                                                                                                                                                                                                        | Target                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Interactive            | Callers `ios`, `android`, `browser`, `agent`, and `no-device` / `unknown` (portal sessions, MCP and OAuth clients), on every route not listed as background                                                                                                                | Every request finishes in **2 s** of gateway time                                                                      |
| Operator tooling       | Caller `cli` on `/admin/*` and `/sql`                                                                                                                                                                                                                                      | **5 s**                                                                                                                |
| Main thread            | Every stall                                                                                                                                                                                                                                                                | No stall of **1 s** or more; at most **10 s** per hour of stalls of 1 s or more (the doctor's `process.stalls` budget) |
| Background (no target) | Caller `collector`; any caller on `/sync-state/*`, `/analytics/ingest`, `POST /documents`, `/documents/with-cursor`, `/documents/reconcile`, `*/permission-health`, `*/push-health`, `/device/ws`, `/health`; streams and long polls (`/agent/events`, server-sent events) | Judged only by what it does to the classes above                                                                       |

Gateway time excludes declared model time. A chat turn, answer generation,
transcription, OCR and embedding new content wait on a model, and that wait is
not the gateway's to fix. When a route's time is mostly model time, judge only
its own segments, or leave it out until the counters can separate the two.

**Why 2 s.** The medians of interactive routes run from about 10 to 200 ms, so
2 s is roughly ten times normal: anything above it is a defect, not noise. It is
also still below the point where a person gives up on a tap. Once the loop has
kept 2 s clean for a few weeks, propose 1 s to the operator; don't change the
target yourself.

**What starts an investigation**:

- one interactive request of 5 s or more, or one operator-tooling request of
  15 s or more;
- three or more interactive requests over 2 s within one hour, on any routes;
- one stall of 2 s or more, or the hourly stall budget exceeded.

The first 15 minutes after the gateway starts are the **boot class**. A
collector reconnecting, catch-up queues and checkpoint backlogs belong to the
restart, not to steady use. Record boot-class violations, but leave them to the
daily review.

## Where the numbers come from

None of these sources carries corpus content, and the loop must keep it that way:

- **The slow-request log.** Read it with `omnesis service logs gateway -n 20000`,
  or from the log source the local instructions name. Every request of 500 ms or
  more logs one line, in this shape:
  `slow POST /oauth/token in 3415ms (wq=3396ms wx=15ms other=4ms calls=1) [no-device]`.
  `wq` is the time spent waiting for the writer, `wx` is time spent in the
  request's own writes, and `other` is everything else: main-thread work, worker
  pools, awaited I/O. The bracket names the caller: a device id with its kind,
  `no-device`, or a user agent. This is the primary measure for the service level,
  and it survives restarts.
- **`omnesis stalls --json --window 60`**: the main-thread stall ranking, recent
  stalls with their snapshot stacks, and the flight-recorder profiles.
  Profile files live in `<configDir>/diagnostics/stalls/`.
- **`/admin/metrics?window=3600`**: percentiles per route and caller (at most 500
  samples per bucket, in memory since the last start).
- **`/admin/scheduler-metrics?window=3600`**: queue and execution time per
  scheduler op and runner. This is how you find which writer op held the queue.
- **`/admin/process-vitals?window=3600`**: heap, RSS, CPU and event-loop delay.
- **`/health` and `/status`**: the running version, and the start time for the
  boot class.

The `/admin/*` routes need the admin scope. When no CLI command covers one, read
it through the CLI's own authenticated client: a throwaway `tsx` script outside
the repository that imports `gatewayFetch` from `packages/cli/src/utils.ts`.
Never use `omnesis sql` against a live gateway: it runs on the gateway's main
thread and is itself a stall.

When you record evidence, normalize paths to route patterns
(`/agent/conversations/:id/seen`), and never keep ids, query strings, search
text, titles or anything from a log line beyond the route, durations, caller
kind and code locations.

## State, kept outside the repository

Keep the loop's memory in `${XDG_STATE_HOME:-$HOME/.local/state}/omnesis/latency-watch/`,
and create it on the first run:

- **`ledger.jsonl`**: one line per check. It holds the time, gateway version and
  start time, the phase, and the counts per class (requests over target, worst,
  stalls of 1 s or more with their total). It also holds the top culprits, each
  as a route pattern with its dominant segment (`wq`, `wx`, `other`) or a stall
  culprit.
- **`state.json`**: the phase and when it started, the candidate culprits with
  their evidence, and the loop's own pull requests (number, culprit, status,
  merge commit, verification result).

## Each run

1. Load the state and take a check: read the sources above for the time since the
   last check, classify every slow request, and append one ledger line.
2. Look after your open pull requests:
   - CI red: read the failed job's log, then fix the branch, or rerun the failed
     jobs once when the evidence shows an unrelated transient. A flake fix goes in
     a separate PR.
   - Review comments from the operator: address each one in the PR.
   - Merged: record the merge commit. Once the running gateway contains it
     (`git merge-base --is-ancestor <merge> <deployed commit>`), start that PR's
     verification clock.
3. Advance the phase:

```
          trigger                    recurs (≥2 of the 4 checks,
 WATCH ───────────▶ OBSERVE (60 min) ──── or same culprit ≥3 times, ──▶ INVESTIGATE
   ▲    every 60 min   every 15 min        or a profile was captured)        │
   │                       │                                                 │
   │                       └── did not recur: record a blip ─▶ WATCH         │
   └────────────────────────────── PR opened ────────────────────────────────┘

 Once per local day: DAILY REVIEW of the last 24 h. Any culprit that blipped
 on 3 different days, or shows up after every restart, becomes a candidate.
```

- **WATCH**: when a trigger fires, record its evidence and switch to OBSERVE.
- **OBSERVE**: watch for an hour, so that the investigation starts from a
  pattern and not a single point. More stalls get snapshots, the flight
  recorder may capture a profile, and recurring slow requests show their
  cadence. A periodic task gives itself away by recurring at the same minute
  every half hour.
- **INVESTIGATE**: the section below. Go back to WATCH once the pull request is
  open, or once you've recorded why no fix was attempted.

4. For requested recurring monitoring, schedule the next run using the host's
   supported scheduler: 60 minutes in WATCH, 15 minutes in OBSERVE, and 30
   minutes while one of your pull requests has CI running. For a single check or
   when no scheduler is available, report the recommended delay instead.
5. Print one line: the phase, the counts against the service level, and what
   changed. Say nothing else unless something needs the operator.

## Investigate

**Preconditions.** Skip the investigation, and keep the culprit as a candidate,
unless all of these hold:

- Fewer than three of your pull requests are waiting for the operator's review.
  The operator reviews each one, so don't flood the queue.
- Nobody else is already on it. Check open pull requests, remote branches and
  `git worktree list`. Also check recently merged pull requests: a fix may be
  merged but not yet deployed.
- It is not off-limits:
  - write-ahead-log, checkpoint, `synchronous` or journal-mode settings, and any
    other durability trade-off;
  - privacy and access behaviour;
  - anything that changes what a user sees beyond speed.

  Raise those with the operator in the session instead.

When delegation is available and permitted, give the investigation to one
sub-agent using the host's tools, with a self-contained brief: the evidence,
the service level, and the rules in this file. Otherwise, investigate within
the current session and persist progress in the state above.

### Find the cause

Start from the dominant segment of the slow requests, and the stalls around them:

| What you see                                | Where the time went                                 | Where to look                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wq` dominates                              | The request queued for the writer behind other work | Writer ops running at that moment: scheduler metrics, periodic tasks with a matching cadence, and logs around the timestamp. Fix the holder, not the waiter. |
| `other` dominates and a stall overlaps it   | The main thread                                     | The stall ranking, snapshot stack and profile `hottestCode`, then `docs/stall-investigation.md`                                                              |
| `other` dominates with no stall             | An awaited resource off the main thread             | Queue times of the io, search and cpu pools; search pool FIFO behind Brain fan-outs; DuckDB's serialized writes; an external call                            |
| `wx` dominates                              | The request's own write is heavy                    | Rows touched, missing index, derived work done inline                                                                                                        |
| `gc=` large in the stall line, RSS climbing | Memory                                              | Allocation in the hot path; pool sizing                                                                                                                      |

These shapes have caused nearly every slowdown fixed so far:

- **A synchronous loop over query results on the main thread.** An `async`
  function is no protection: everything between two `await`s is one segment.
- **A synchronous SQLite read on the main handle in a request or tick path,**
  for example a graph walk or a per-hit lookup in search post-processing.
- **A query with no index to serve its filter.** On an encrypted store, a scan
  costs about 0.2 ms per row. A document row's content sits before its small
  columns, so reading a hash or date walks the content's pages.
- **A writer op that iterates without committing in sub-batches and checking its
  preempt token,** so one large input holds the write lock for as long as the
  input is large.
- **Reads inside a writer transaction** that could have run on an io handle
  before it.
- **A periodic task that reprocesses unchanged data every tick,** where a hash or
  diff would make the steady state nearly free; or one whose cost grows with the
  corpus.
- **A shared one-at-a-time resource served first in, first out,** so interactive
  work waits behind a background backlog.
- **Spawning a program by forking a large process,** or optional warm-up running
  before the server listens.
- **Large `JSON.parse` / `JSON.stringify`, or worker replies too big to
  deserialize quickly.**

### Reproduce it

Reproduce on an isolated instance, never the live gateway:
`scripts/dev-instance.sh`, a synthetic universe, or a unit fixture against the
full schema. A path that costs a second on a large production corpus may cost
milliseconds on the default universe. Scale the fixture with invented data
until the slow path is measurable, and keep that fixture for the benchmark.

### Fix it

- Use the sanctioned pattern that matches the work's shape:
  - a read port on an io worker;
  - cpu ops;
  - the search pool;
  - a sliced writer op with preempt checks;
  - `processLauncher()`;
  - priority lanes;
  - deferring work until after the server listens;
  - read-ahead.

  `docs/stall-investigation.md` describes each one with the change that
  introduced it.

- Fix the root cause. Raising a timeout, lowering a task's frequency or wrapping
  a loop in `setImmediate` without bounding it is not a fix.
- Keep the change as small as the root cause allows, and delete the code it
  makes dead.

### Prove it

Every pull request carries all four kinds of evidence:

1. **A before/after benchmark.** Run the same fixture, machine and load on the
   base commit (in a worktree of `origin/main`) and on the branch. Make at least
   five runs each and report the median and the worst.
   - Measure what the service level measures: request latency (p50, p95,
     worst), main-thread blocked time (`perf_hooks.monitorEventLoopDelay`), and
     how long the writer is held.
   - Measure what the fix might cost elsewhere: worker time, memory, rows and
     write-ahead-log frames written, and throughput.
   - Keep the benchmark script in the branch when it is reusable. Otherwise
     describe it exactly enough for the operator to rerun it.
2. **Correctness preserved.** Before changing anything, capture what the old
   code returns on small, empty, large and edge-case fixtures. Then assert that
   the new code returns exactly the same: a parity test, or golden outputs.
3. **The state machine still holds.** Write down the states and transitions of
   the feature you touched. For a periodic task, for example: due, running,
   sliced batch, preempted, failed, retried, done. Name the unit or E2E test
   that covers each transition.
   - For every transition the change could affect that no test covers, add one.
     Typical gaps are two runs overlapping, preemption mid-batch, a restart or
     shutdown mid-run, the error path, empty input and very large input.
   - Ask of each behaviour: if this broke silently, which CI test would turn
     red? If the answer is none, add one.
   - Prefer an E2E test on `SyntheticE2EHarness` or `MultiCollectorHarness` when
     the behaviour crosses threads or processes. For Brain code, use a Brain
     Bench test.
4. **A pin test** that fails if the work moves back to where it was, for example
   asserting the read runs as an io op, a query plan that seeks rather than
   scans, or a writer op that yields between sub-batches. CI never asserts
   wall-clock time: timing tests flake.

Iterate with narrow vitest runs. Before handoff:

- run `npm run checks:plan -- --base origin/main` and
  `npm run checks:affected -- --base origin/main` through the installed queue, at
  default priority;
- apply the `omnesis-review` skill (`.agents/skills/omnesis-review/SKILL.md`) to the diff and fix what it finds;
- wait for GitHub CI to be green before asking for review.

### Open the pull request

- Use `gh pr create`. **Never arm auto-merge, never merge, never `--admin`,
  never force-push, never `--no-verify`.** The operator reviews and merges every
  pull request this loop opens.
- Watch its CI from the loop (step 2 of each run), and act on red at once: the
  operator should never chase a check.
- Add a changeset when users would notice the change.

**Write the description for the operator, who knows the product but not
necessarily this subsystem.** Write it the way the posts on omnesis.dev/blog are
written: read one or two in `website/blog/` first and match their voice. Explain
from the ground up, in plain language. Define each term the first time it
appears, and take the time a reader new to the topic needs. Use these sections:

1. **The short version**: three or four sentences covering what got slow, for
   whom, why, what changed, and how sure we are.
2. **The feature and how it works**: what it does for the user, the state
   machine behind it, and which code runs it.
3. **Where it runs**: the part of the gateway's thread model that matters here.
   Explain it again, even if an earlier pull request did: one main thread
   running every request, timer and task; one writer worker that every write
   queues for; the io, search and cpu worker pools; and what "blocking" means
   for each.
4. **What went wrong**, with the evidence:
   - how many slow requests or stalls, how long, on which route patterns, at what
     cadence, and the segment that dominated;
   - the stall line or profile frame that named the code.
5. **The fix**: what moved where, or what is now bounded, and why this pattern.
   Name the alternatives you rejected, and why.
6. **How we know it's still correct**: the parity results, and a table mapping
   each state-machine transition to the test that covers it, with the new tests
   marked.
7. **How we know it's faster**: the benchmark table, the method, and its caveats.
8. **Risks, and what to watch after the deploy.**

Use diagrams wherever a picture explains faster. GitHub renders ` ```mermaid `
blocks in pull request descriptions: a sequence diagram shows who waits on whom,
a flowchart shows a state machine, and a timeline shows where the time went.
Check that every arrow starts and ends where the code actually does. ASCII is
fine too.

The privacy and open-source rules from `CLAUDE.md` apply to the description as
much as to the code:

- no corpus data, ids or log text;
- no machine names, addresses or operator setup;
- example data is invented.

Describe the production evidence by its shape ("a large production corpus",
"every 30 minutes"), not by whose it is.

## After the operator merges

- **Deploy** only if the local instructions say this loop may, and how. Do it at a
  quiet hour, at most once a day, with several merged fixes batched. Otherwise,
  tell the operator once that the fix is merged and waiting for a deploy.
- **Verify** after the gateway has run the fix for at least 24 hours. Compare the
  culprit's counts and blocked time before and after, from the ledger. Comment
  the result on the pull request, with numbers only.
  - If the culprit is still there, open a new investigation that links the old
    one.
  - If a new culprit appeared right after a deploy, record it as a regression
    suspect with the range of commits the deploy brought in. The version stamp in
    the ledger is what makes that range known.

## Never

- Restart, stop or reconfigure the live gateway or collectors, unless the local
  instructions allow it for this loop. Reading its admin routes and logs is the
  extent of the loop's access.
- Read the corpus, or put any of it in a fixture, benchmark, test, comment or
  description.
- Bypass the test queue's admission, raise a job's priority, or add a CI
  assertion on elapsed time.
- Open more than one pull request for the same culprit, or start a second
  investigation while one is running.
