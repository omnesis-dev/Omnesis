# Investigating main-thread stalls

The gateway runs every HTTP request, WebSocket frame, scheduler slot and timer on one event loop. While a piece of synchronous JavaScript runs on it, nothing else does: a 2-second loop over query results is a 2-second wait for every phone, collector and portal tab at once. This page states the rule that keeps that from happening, the fixes that have worked, and the tools the gateway gives you to find which code broke the rule. Paths below are relative to `packages/gateway/src/`.

## The rule: the main thread is the event loop

No synchronous segment of main-thread work should run longer than about 50 ms. A segment is everything between two `await`s, so an `async` function is no defence: `rows = await reader.all(); for (const row of rows) heavyWork(row)` is one long synchronous segment after the `await`. What keeps segments short is moving the work off the thread, or cutting it into bounded slices.

The writer worker follows the same discipline for the same reason, as described in [`conventions.md`](conventions.md) under "The writer is one thread": a writer op holds the write lock for a bounded number of rows and checks its preempt token between sub-batches. The main thread has no preempt token; its only protection is that nothing long runs on it.

## Sanctioned fixes

Each of these has removed a real stall. Reach for the one that matches the shape of the work.

- **Scans and query-heavy selection go to an io read worker.** The work becomes an `io.*` op whose handler runs on a read-only handle in `scheduler/io-handlers.ts`, and the main thread receives the finished result. `brain/knowledge/selection-reads.ts` (#652) moved the knowledge tick's ledger scans there; the result crosses as plain data, with sets travelling as arrays. When the caller polls on a cadence, send back only what changed: `watch/people-directory.ts` (#667) has the worker hash the Watch engine's person directory and return the rows only when the hash differs, so the steady state costs the main thread one hash comparison.
- **External programs start through `processLauncher()`** (`process-launcher/`, #669). Starting a program forks the process that asks for it, and the fork copies that process's memory mappings synchronously on its event loop, which for a gateway with a large heap is a stall of its own. The launcher is a small long-lived child that does the spawning for the gateway, so `pdftoppm`, `ffmpeg` and the rest cost a message, not a fork.
- **Writer work is sliced.** A writer op that iterates commits in sub-batches with a preempt check between them, so its callers' awaits resolve in bounded time and the main thread never handles one enormous result.
- **A shared serialized resource gets priority lanes.** When interactive and background work queue for the same one-at-a-time resource, the interactive request should not wait behind a backlog: one queue, an ordered set of lanes, interactive first. The transcription queue is the case that called for it (#674): someone dictating should not wait behind queued source audio.
- **CPU-bound pure computation goes to the cpu worker pool** (`scheduler/cpu-ops.ts`), with plain-data arguments and results. Text processing counts: the near-dup tick shingles its persisted candidates there (`cpu.nearDupPrepareCandidates`), in chunks bounded by text length so no single reply is slow to deserialize on the main thread.

What does not count as a fix: wrapping the loop in `setImmediate` batches without bounding the batch, raising a timeout, or lowering the frequency of a periodic task that still stalls each time it runs.

## Reading a stall line

A stall monitor watches the loop from a separate thread (`observability/`). It records every gap of `gateway.stalls.threshold` (default 250 ms) or more, and logs each one of `gateway.stalls.warn` (default 1 s) or more as a warning under `gateway:stalls`:

```
event loop stalled 2200ms in statusCache.refreshDb (outer: POST /admin/sources/add); gc=3 in 40ms, worst 31ms minor; heap=1.80GiB rss=3.10GiB
```

The gap is measured by the main thread itself, between two of its own heartbeats, so a watchdog that falls behind does not invent stalls. What follows `stalled 2200ms` says how the culprit was named:

- `in <activity> (outer: <activity>)` — that activity was executing when the loop stopped. This is the strongest attribution. The innermost activity is named first; `outer` is the outermost one it was nested in, and is left out when the two are the same.
- `with only <activity> in flight` — nothing marked was executing, but exactly one marked asynchronous activity had started and not yet settled, so the stall was most likely one of its continuations: code after one of its `await`s. A long-awaiting activity, such as an agent turn, can be in flight through stalls it had nothing to do with, so treat this as a lead rather than a verdict.
- `outside any marked activity (in flight: a, b)` — neither. The code that ran is unmarked, or several activities were in flight and any of them could be the one. The in-flight list gives you the candidates.

Any of the three can carry `at <function> (<file>:<line>)`, which comes from a snapshot. Once a stall has lasted twice the threshold (and at least 500 ms), the watchdog profiles the stuck thread for 200 ms. The snapshot names the innermost frame of the repository's own code on the hottest stack and keeps that stack (`code` and `stack` in `/admin/stalls`). A stall that no activity explains but a snapshot does is attributed by its code location, so it still ranks under a name of its own. This matters most for a continuation, which no activity mark covers:

```
event loop stalled 1557ms at compileSafeUrlPattern (packages/gateway/src/known-url-pattern-safety.ts:75) outside any marked activity (in flight: enrichment.extractDates, backfill.linkBatch)
```

A snapshot has three limits:

- It is taken at most once every 10 seconds and never during a flight-recorder capture, so a burst of stalls gets one snapshot, not one each.
- The inspector reaches the stuck thread by interrupt, which is serviced only while it runs JavaScript. A stall inside native code, such as a synchronous SQLite query on the main handle, a synchronous file read or compression, cannot be profiled until it returns. Such a snapshot is discarded rather than attached to the wrong code, so stalls of that kind are named by their activity, or by the flight recorder below, which is already sampling when they begin.
- The line is the one the function starts on, not the statement that was hot. Under `tsx` it refers to the transpiled code and can be far from the `.ts` line; search for the function name.

An activity is a code-chosen label set with `withActivity(name, fn)` from `observability/main-activity.ts`. It is set at the choke points rather than everywhere:

- scheduler tasks on the main runner carry their task name;
- HTTP requests carry `METHOD route-pattern`, the pattern of the route that handles them, never the URL;
- device WebSocket frames carry `ws.message`, and `ws <type>` for a type the message registry knows (`ws (unknown)` otherwise);
- the status cache and background-jobs refreshes carry their own names.

When a stall keeps coming back unattributed, wrap the suspect entry point in `withActivity`: a synchronous mark costs a map lookup and a few shared-memory stores, cheap enough for any path that is not a tight inner loop.

`gc=` reports the garbage collections that overlapped the stall (a lower bound when a long stall held more than a few hundred). A stall that is mostly one major collection is a memory problem, and the fix is allocating less, not moving code.

## `GET /admin/stalls` and `omnesis stalls`

`GET /admin/stalls` (admin scope) serves what the monitor has recorded, from memory: the last 2,000 stalls since the gateway started.

- `windowMinutes` (default 60, at most 1440) sets how far back to look, `minMs` (default 0) leaves out shorter stalls, and `limit` (default 50) sets how many individual stalls `recent` lists.
- `enabled` is false when detection is off or the watchdog has stopped, in which case nothing below is being recorded.
- `ranking` groups the stalls by `culprit`, most total blocked time first, with the count, the total, the worst, and when the culprit was last seen. The culprit is an activity name or, for a stall only a snapshot explained, a code location; a `null` one gathers every stall nothing could be named for.
- `recent` lists the newest stalls with their `attribution` (`running`, `in-flight`, `code` or `none`), the in-flight candidates, the snapshot's `code` and `stack` when one was kept, and the overlapping garbage collection.
- `profiles` holds the flight recorder's kept summaries, newest first, and `capturing` names a capture in progress.

`omnesis stalls` prints the same report (`--window <minutes>`, `--min <ms>`, `--json`). Start an investigation with the ranking: the culprit at its top is where the time went. The count and worst figures separate one rare long stall from a task that stalls a little every few seconds, which usually calls for a different fix.

`omnesis doctor` and the portal's health report carry a `process.stalls` check. It warns when stalls of a second or more add up to 10 seconds or more in the last hour, and names the top culprit. It is left out while the gateway is not recording.

## The flight recorder

When stalls recur — by default, three of at least a second within two minutes — the watchdog thread profiles the main thread for a minute (`gateway.stalls.profile.*` sets the budget, the duration, a 15-minute cooldown, and how many summaries to keep). It connects an in-process inspector session to the main thread, with no network port. The main thread pays for V8's sampling and for serialising the profile when it stops, a few milliseconds; parsing, summarising and writing happen on the watchdog thread. Because the sampler is already running when a stall begins, it sees native code too, attributed to the JavaScript frame that called it.

The summary lands in `<configDir>/diagnostics/stalls/profile-<time>.json`, and the log says where. It covers only the long busy runs in the capture: stretches of at least the stall threshold in which the loop never went idle. Ordinary short request handling is left out, so what it ranks is what held the loop. Each summary lists:

- `hottestCode` — the innermost frame of our own code on the hottest stack. When the hottest frame is a library call, native code or a V8 builtin, this is the function in the repository that called it, and usually the place to start reading.
- `bySelf` / `byTotal` — frames by the time they were executing, and frames from the repository by the time they were anywhere on the stack.
- `topStacks` — the hottest whole stacks, innermost frame first.
- `longRuns` — the ten longest runs, each with its offset in the capture, its duration, its hottest stack and its own `hottestCode`. A run of the stall threshold or more is a stall, so these correspond to entries in the summary's `stalls` list, the stalls recorded while the capture ran.

A summary holds function names, file paths and the lines the functions start on. A path is relative to the checkout, or begins at `node_modules/` (an npm install keeps the gateway's own code under `node_modules/@omnesis/`), or is reduced to a base name for anything else. A CPU profile records no argument values and no heap contents, and the summary keeps no absolute path, so it can be attached to an issue as it is.

## A worked loop

1. Run `omnesis stalls` and take the top of the ranking.
2. A named activity that is a scheduler task or a route tells you the entry point. Read it for synchronous loops over query results, synchronous SQLite calls on the main handle, `JSON.parse`/`JSON.stringify` of large payloads, and process spawns.
3. If attribution is `in-flight`, `code` or `none`, read the stall's snapshot `stack` and the newest profile summary: their `hottestCode` and `topStacks` name the function.
4. Pick the matching fix above, and add a test that pins the work to where it now runs, by thread or by worker op, rather than how long it took.
5. After deploying, check that the culprit has dropped out of the ranking.
