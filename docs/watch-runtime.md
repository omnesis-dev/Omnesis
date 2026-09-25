# Running the watch runtime

The watch runtime is a DSL, an evaluation engine with durable per-instance
state, and a journal the gateway materializes from its own event bus. It is
experimental.

A firing is a row in `watch_firings` and a trace explaining it. For a watch that
says nothing about delivery — the default, and most of them — that is all it
ever is: no notification, no agent wake, no product surface moves. That default
is what let the runtime meet real event churn, real people-resolution noise and
real sync behaviour before it was allowed to act on any of it.

A watch that carries a `delivery` block also notifies. It is opted into per
watch, because a watch worth a row is not automatically worth interrupting
someone for, and the two decisions are not made at the same time or by the same
reasoning. See [Delivering a firing](#delivering-a-firing).

Nothing here is in the public docs: the whole subsystem sits behind
`OMNESIS_EXPERIMENTAL`, and documenting a feature that graduates is part of
graduating it.

## What is running

Two scheduler tasks, both on the main runner, both writing `watch.db`:

- **`watchV2.materialize.tick`** turns document bus events and transactional
  analytics outbox pages into a durable, ordered, enriched journal. The
  document handler is an O(1) queue append. Analytics pages are written in the
  same DuckDB transaction as their rows, so pressure or a restart delays them
  instead of losing them. All enrichment and deduplication happens in the drain.
- **`watchV2.evaluate.tick`** runs each active watch over its own cursor into
  that journal.

They hold separate connections, and they take turns through a shared lease
rather than meeting in SQLite's busy handler: `better-sqlite3` is synchronous,
so the loser of a write race would block the event loop rather than yield.

`watch.db` is runtime-owned and encrypted with the install's `watch2-db`
storage key — the key keeps the old spelling on purpose, because a key name is
sealed into its envelope and renaming it has a plausible path to a freshly
minted key that cannot open your data. See the comment on `STORAGE_KEY_NAMES`.

An install from before the rename has the journal under `watch2.db`. The first
boot on this version folds its write-ahead log and moves it, once; every boot
after that is a few `stat` calls. If both names somehow exist and the old one
holds data, the gateway refuses to choose and says so, leaving both untouched.

The journal is part of `omnesis backup`. That matters more than it sounds: the
event stream can be replayed from the corpus, but a watch's definition — what
you asked to be told about — is held nowhere else.

## Turning it on

Live enablement is the operator's step. Start the gateway with:

```
OMNESIS_EXPERIMENTAL=1
```

With it unset the whole surface does not exist: no file is created, no bus
subscription is made, no task is scheduled, and `/admin/watch/*` returns 404
before authentication rather than 401 — so an install with the feature off is
indistinguishable from one that never had it.

## Adding a watch

A watch is data: a DSL file you wrote or a compiler produced. The gateway
validates it against the live ontology before storing it and refuses it with the
validator's own diagnostics if it does not hold.

```console
$ omnesis watch add ./my-watch.json
Added unanswered-important-email
  watching from seq 41022 — everything before it is history · id 6f2c…
```

Every watch carries the **ontology fingerprint** it was validated against. Ask
the install for the current one and paste it in:

```console
$ omnesis watch --json list        # journalHead, and every watch
$ curl -s -H "Authorization: Bearer $OMNESIS_TOKEN" \
    $URL/admin/watch/ontology | jq -r .fingerprint
```

When the install's ontology moves, a watch is re-validated against the ontology
as it now is — and it is **re-stamped and keeps running only if every ontology
entry it reads is byte-identical to the ones it last validated against**. The
re-stamp is logged. Anything else is paused with its diagnostics.

That bar is deliberately higher than "it still validates". A field whose type
widened, an enum that gained a member, a table that gained a column a `SELECT *`
now projects: each of those re-validates cleanly and each can move what an
existing watch selects. Re-stamping on validity alone would quietly hand the
operator a different watch than the one they approved, so a watch whose own
surface moved is held even when nothing about it has broken.

What that leaves running is the case the bar was drawn for, and it is the common
one: the fingerprint is a single hash over the whole install, so a source that
learns to describe more of itself — a new analytics table, a new declared field
— moves it for **every** watch at once, including all the ones that refer to
nothing that changed. Before the re-validation was automatic, that stopped every
watch on the install and told each of them the shape had moved under it;
re-stamping healed all of them without a word of any definition changing.

A watch that has not yet completed a validation on this build has no record of
what it reads, and unproven is treated as changed: it pauses on the next move,
says so in its note, and resumes with one `omnesis watch restamp`. After that it
self-heals.

What "what it reads" covers is exactly what the fingerprint covers, projected
onto this watch: a source's declared profile and whether it is semantically
indexed, an analytics table's schema, the people it names. Not a source's
provider, which is read from the corpus and appears on that source's first
sync.

**Drift arrives with the data, not with the deploy.** The ontology is built from
what the install has actually seen, so a release that adds a table changes
nothing until the first row of it lands — which can be hours or days later. A
fingerprint check run as part of a deploy will pass, and the pause, if there is
one, comes afterwards with no deploy near it.

`omnesis watch restamp` remains the operator-driven form of the same thing, and
is what to reach for after a move that pauses watches: it re-validates every
watch, re-stamps and resumes the ones that still hold, and leaves the rest
paused and unchanged with their diagnostics — so a watch is never stamped as
"checked against this world" unless it was.

A watch added today starts at the **journal head**. "Tell me when someone emails
about X" is a claim about what happens next, and a watch that woke on four years
of history would be answering a question nobody asked. `--from-seq N` overrides
it, which is what a test wants and an operator almost never does.

The committed examples in `packages/gateway/src/watch/examples/` are held to
validating by a test, so they can be copied without checking whether they still
work. They deliberately span the shapes: one that costs nothing to run, one that
reaches a judge, one waiting on a deadline, one on a recurring boundary.

## Reading what happened

```console
$ omnesis watch list               # every watch, its status, its firing count
$ omnesis watch firings <id>       # what it said
$ omnesis watch trace <id>         # why it said it — or why it did not
$ omnesis watch report             # the whole period in one read
$ omnesis watch restamp            # after a legitimate ontology move
```

`trace` is most of the value during a shadow period. "This watch fired" says
nothing about whether it fired _for the right reason_, and the trace pins the
reasoning: which node armed, on what key, what cancelled it, which deadline it
died on, what the judge was asked and what it answered.

Read the transitions with their `detail`, not on their own. `ignored` and
`held` are each used by several node types — `ignored` also covers an arm
discarded because an instance was already live, and `held` covers a wait still
counting down, an incomplete join, a persistence gate that has not filled. What
identifies a _judge_ outcome is the node and the detail:

- `ignored` on a nominating source, with a reason naming the arms that
  declined — no model was asked.
- `held` … `judge declined` — a model was asked and said no.
- `held` … `judge budget spent; parked` — a model was **not** asked, and the
  nomination is waiting for budget to come back.

That last distinction is load-bearing: a shadow period that recorded budget
exhaustion as a precision judgement would corrupt the exact measurement it
exists to take.

### Why a watch means what it means

`trace` answers what a watch _did_. What it _is_ was decided once, by a
compile — and a compile reads the corpus while it works, so which source it
bound to and which threshold it chose came out of something it looked at.

Every compile is one run in the cognition ledger, kind **Watch compile**, at
`/portal/debug/cognition/runs`. Its transcript is the agent stream verbatim:
the tools it called with their arguments, what came back, the model's replies,
and each repair turn where the validator handed its diagnostics back. Refusals
and deadlines are recorded the same way — a compile that declined is the one
most worth reading, and the transcript holds the words it declined in.

An installed watch links straight to it (portal watch detail → **Compiled by**
→ View transcript), as does the subscription record of a watch that wakes an
agent. A watch added from a hand-written DSL document has no link: nothing was
compiled, so there is no reasoning to show.

The transcript carries corpus content the compiler read. It is an on-host debug
artifact behind the admin surface, never indexed and never read back by a later
run — the same class as every other recorded run — so nothing about writing one
crosses the privacy membrane.

### Looking at one, on a page

`trace` and `firings` answer in text what a watch did. The debug page answers it
as a picture, and it answers a third question neither of them can: what the
runtime is holding _right now_.

Portal → Debug → **Watch**. Experimental, like the rest of the subsystem, and
read-only throughout: nothing on this page probes, fires, pauses or edits. Those
stay in the CLI, where an action is a thing you typed rather than a thing you
clicked while reading.

The list it opens on says which watches are awake: a filled mark and a key count
for one that is holding something, a hollow one for a watch resting until
something arrives, the soonest deadline where one is armed, and how far behind
the journal a watch that has not caught up is. Holding nothing is the ordinary
state of a watch waiting, so nothing there is a health signal and nothing is
reordered by it.

The count is of the keys still _holding_ something, which is why it can be lower
than the number of cells the state tab lists a click later. A cell outlives what
it was holding — a cooldown stamp after its interval elapses, a persistence
window after it drains, a SQL node's level at rest — and counting those would
make the mark claim a watch is tracking things it is waiting on nothing for.
Each node type decides which of its own cells count; where any are left out, the
mark's tooltip says how many and why.

It then shows one watch at a time, through three lenses on one canvas.

**The shape it has.** The graph is drawn top to bottom — sources across the top,
the sink at the bottom — because the detail pane opens on the right, and a
left-to-right graph would put the sink underneath it. Each box carries the
node's type, its id, a one-line summary of what that type is configured to do,
and badges for the properties that change behaviour: `on_collision`,
`max_live_instances`, `fire_on`, `cooldown`, `min_events`. Edges carry the key
expression that flows across them, and an arm and a cancel are drawn
differently on purpose — reading a cancel as an arm is how a watch that can
never fire looks correct. Clicking a node opens everything the DSL configures on
it, structured, with the raw JSON behind a toggle; clicking the header opens the
watch itself, including a link to the compile that produced it. A node type this
build has never heard of still appears, wearing its raw type and no invented
summary.

**What it is holding.** There is no such thing as "an instance of this watch".
Each stateful node keeps its own population of keyed cells, and two nodes in one
watch may key differently — so the page never pretends otherwise. With no key
selected, every node wears the number of live cells it holds. Pick a key and the
canvas narrows to that key's slice: each node's count becomes what it holds for
that key alone, a node holding nothing for it goes bare and dims, and broadcast
nodes stay lit because they reach every key. Opening a node then lists that
key's cells rather than all of them. Cells are shown as the thing they mean
rather than as the fields they
are stored in — a wait as a bar between when it armed and when it fires, a
sequence as the step it is on, a join as the arms that have arrived against the
ones outstanding. Every armed timer also appears in one flat list, soonest
first.

The header states the moment: `state as of <time> · journal seq <n>`. That
number is the **consumer cursor** — how far this watch has been evaluated —
which is at or behind the journal head, and legitimately so while a watch is
catching up. The snapshot is taken between events, never during one. It
refreshes when you ask it to, and never on its own.

**Why it did, or did not.** Pick an event and the path it took lights up: each
node it touched wears the verdict it reached at that moment — fired, held with
the judge's own sentence, refused at a ceiling, dropped out of order, expired,
or parked with the class of failure that parked it. The evidence and the
delivery outcome sit beside it.

Considerations — the times a watch looked and did not fire — are listed the same
way and selected the same way. That is the point of the lens: a watch that fires
is usually easy to explain, and a watch that stays quiet is the one you need a
picture of. Events are ordered by when the runtime last worked on them, which is
not the same as by sequence number: a deadline and a hand-forced firing both
take sequences counting down from -1, and a nomination the judge's budget parked
is settled later under its original one.

Every firing row on an installed watch links straight here, with that event
already selected. One honest limit: the trace is bounded and rolls off while
firings are kept forever, so a firing old enough to have lost its trace says so
rather than drawing a path with nothing on it.

## Trying one before you store it

A watch starts at the journal head, so its first evidence arrives with its
first match — and a condition that admits nothing produces exactly the silence
of a quiet week, for as long as you are willing to wait for it.

```console
$ omnesis watch try ./my-watch.json
$ omnesis watch try ./my-watch.json --events 2000
```

It replays the candidate over the tail of the journal with the **real engine**
— the same one the runtime uses, so it cannot disagree with what the install
would do — and reports, per node, **matched of evaluated**, plus the runtime's
own reason for a bounded sample of its decisions. Nothing is stored: no cursor
moves, no instance survives, no firing is recorded, and the candidate need not
exist as a watch.

Two things it deliberately cannot tell you. Its judge never says yes, so a node
with one reports what **would have reached** a model rather than what the model
would have answered, and nothing downstream of it fires — the report says which
nodes that applies to. And a lexical arm matches the journal event's title,
because the journal carries no bodies: a zero there means the term is absent
from titles, which is a much narrower claim than absent from the corpus. The
per-node diagnostics say so.

It refuses rather than guessing in three cases: a candidate with a semantic
recall arm on an install with no embedder (recall would score everything at
zero and call every threshold far too high — a candidate that never scores is
tried as usual), an empty journal (nothing has happened yet is not a verdict on
the condition), and a candidate that does not validate against the live
ontology.

### The compiler runs one for you

Every compile replays its own candidate before answering. Once a candidate
validates, the compiler replays it over the last ninety days of the journal and
reads five things off the result: how often each judging node would have reached
a model, how often the watch would have fired, how much of the window the replay
actually consumed, whether a node threw, and whether the watch finished inside
the window — by firing the once it was allowed to, or by reaching its horizon. A
season rather than an afternoon, because most conditions worth watching are
monthly or rarer and a window too short to contain one occurrence turns every
number into a zero that means nothing.

The fifth changes how the counts are read. A watch that stopped because it fired
has a span that is an artefact of the firing being divided by it — one firing on
day two of a season reads as one every two days — so its firing rate is not
checked at all; a horizon passing owes the firings nothing, and that rate is
checked as any running watch's is. What either kind of finished watch cost is
said as a total rather than a rate, because that is what it is: it spent what it
spent and will not spend again. Below a floor on that total the cost is not
raised at all, a whole life too cheap to be worth the revision turn it would
buy.

Silence is read against the window that was available: a watch that never fired
is told its filter may not match only where the replay covered at least half of
what it asked for. That is a weaker question than the one worth asking — whether
the window could have held the condition at all — and it is asked because
nothing available answers that one. In particular the cadence a request names
cannot: it bounds how often a watch should be allowed to speak, not how often its
condition occurs, and read as the second it inverts, so the looser the phrasing
the shorter the window it would accept.

A watch whose life ended inside the replay is the case that gate would read
wrongly, and it gets a concern of its own instead. One whose horizon is reached
early in the replay and which fired nothing is dead on arrival: the live replay ends at
the present, so a horizon inside it is a horizon already past, and the installed
watch retires on the first event it sees. `expires_at` is written by the compiler
and the validator demands one for a dated request without ever reading the date,
so nothing else catches it. It is raised whether or not a model decides the
firing — a judge under a dead horizon is never asked — and only while the horizon
really did cost the replay its window, since one reached a day before the end
took nothing away.

If what comes back is alarming — a watch that would never have fired, one whose
judging costs more per day than the ceiling, or one that speaks more often than
its request's own cadence implies — the compiler
spends one revision turn on it and stops. The reach report and the concern both
land in the compile transcript, so what the model was told is visible next to
what it did about it.

This costs latency, and where a revision happens it costs two replays rather
than one: the candidate's, and the revision's. It buys a watch measured against
the substrate it will actually live on rather than against a universe nobody
runs. If a replay refuses or throws, the compile carries on without it — the
backtest is advice, and advice must not cost a working compilation.

The compile-only path stays writeless throughout. The replay takes a DSL rather
than an installed watch, so a compile that never installs still never writes.

To find out what it costs on your own install, compile the same requests twice —
`withoutBacktest: true` alongside `compileOnly: true` on `POST /admin/watch/compile`
withholds the replay and the revision it can trigger, which is the whole of the
loop. It is refused without `compileOnly`: a watch about to be armed is the one
case where the replay is worth its minutes whatever the caller thinks. The
answer's `backtest` comes back `null` on that arm, the same as it does when
there was no history to replay against — the run row says which, so the two are
not read as one.

The agent holds the same thing as `watch_probe`, keyed to a watch it has just
installed — which is how it can check its own work before telling you a watch
is set up. It is the one tool the operator's own conversation holds and no
other caller does: the samples are the runtime's own words about documents in
this corpus, which is fine for the person whose corpus it is and a disclosure
for anyone else.

## Firing one by hand

A watch's condition is the half you can read. Where its firings go — the caps,
the transport, the anchor, the agent that opens a conversation about it — only
runs when the world produces the condition, which for a watch worth having is
rare and unschedulable. So a delivery path that is broken stays broken silently
until the day it was needed.

```console
$ omnesis watch fire <name>
$ omnesis watch fire <name> --doc <documentId> --doc <documentId>
$ omnesis watch fire <name> --payload '{"note":"checking the path"}'
```

Nothing is evaluated: no event is read, no node arms, no judge is asked, and no
judge budget is spent. What runs is the delivery loop, exactly as it runs for a
firing the runtime reached on its own.

It is never counted as something the watch caught. The trace record is its own
transition (`forced`), the ledger row carries a `forced` flag, `watch firings`
prints **(by hand)** beside it, and the portal shows a **By hand** badge. The
sequence number comes from the timer counter — negative, and unable to collide
with a journal event, which matters more than it sounds: the firings table is
`INSERT OR IGNORE` on `(watch, seq, node, key)`, so a forced firing reusing an
organic identity would be silently dropped, and the deliveries table upserts on
the same tuple, so it would overwrite what the real firing recorded.

The daily caps still apply, because they are what the delivery loop does. A
forced firing over the cap reports `suppressed` and says so rather than leaving
a silent nothing — a cap is the ordinary reason a firing goes nowhere, and an
operator proving a path needs to tell that from a path that is broken.

`--doc` and `--payload` are the inputs with reach. A woken agent may ask what
caused the firing, and the turn that answers starts from what the firing
recorded — the documents where the watch's anchor was approved to carry them,
and otherwise the payload, kept as what the plan observed. It is not confined to
that: it researches the corpus with the ordinary read-only tools, and the
privacy reviewer decides what of its reply may leave. The evidence is there to
fix _which_ occurrence is under discussion. A watch approved for a condition
rather than for documents drops `--doc` on the way into its anchor, so on one of
those `--payload` is the half that reaches the agent.

When nothing arrives, it says why — `nothing accepted it: no push transport is
configured`. That reason is the answer you ran this to get, so it comes back
with the result rather than being left on a row you have to know to go and
read; `omnesis watch firings` shows the same line against each firing.

Two refusals, both before anything is recorded. A watch that **delivers
nowhere** is refused, because a firing forced into one would be a row, a trace
and a reported success with nothing having gone anywhere — exactly the failure
this is meant to detect. And a watch that is **paused or retired** is refused,
because the runtime is not running it: pause means held, and a retired watch
has had its anchor swept, so a wake would report an attempt with nothing
delivered and read as a broken transport rather than as a watch that is over.

It does not count as a catch. `watch list`'s firing count is what the watch has
_found_, so forced firings are excluded from it; the detail view lists them,
marked, which is what reconciles the two.

## The canary

`examples/canary.json` is a deterministic stimulus with no false-positive risk:
its lexical arm matches a token (`OMNESIS-PING-7391`) that exists nowhere in any
corpus, so the watch is perfectly silent until you send it to yourself.

A proposition must be provable from `{docId, title}` — a `title`, not a
"subject". The gateway also gives its judge document kind, time, bounded
participant roles, and a revision-fenced body excerpt when the current body is
still the exact revision that produced the journal event. The judge first makes
its positive-support decision without that excerpt. Only after portable
evidence matches does a separate, veto-only review see the body; that review can
preserve or reject the match but cannot create one or add output fields. A model
asked to confirm something the title cannot establish therefore declines before
the body is shown. That is a silent failure: the trace records it as `judge
declined`, which reads as a precision judgement rather than a badly-worded
question. A body-reviewed nomination can consume two judge calls, and it parks
if the second call would exceed the budget. Durable judge diagnostics omit the
body excerpt and body-backed rationale, so a later corpus deletion does not
leave copied body text in the watch ledger.

It carries a judge, so it needs a single-shot completion model assigned to the
independent `watch-judge` role: Codex, local GGUF, Anthropic, or an OpenAI-compatible
HTTP backend using Chat Completions. Replay and Responses-only HTTP
backends cannot serve that leaf call. Without a usable model the judge fails closed and the canary is
silent — which looks exactly like the failure it exists to detect. Check that
first. A missing or unreachable model does not consume budget without a provider call: the
nomination carries a durable retry time, and a failed shared provider cools down
for a minute before any Watch asks it again.

The ritual:

1. Add the canary with the install's current fingerprint.
2. Email yourself, with the token **in the subject line** — the journal event
   carries the title, not the body, so a token only in the body will not match.
3. `omnesis watch firings <id>` — there should be exactly one firing.
4. Compare `firedAt` against when you sent it. That difference is the honest
   end-to-end latency: sync interval, materializer drain, evaluation tick and
   judge round trip, all of it.

Send it a second time to confirm the second message also produces exactly one
firing, and that the first is not repeated.

## What the shadow period has to establish

Each of these is a property of the runtime rather than of any one watch, and
each has a test standing behind it. The shadow period is where they meet an
install that was not built to make them easy.

| Claim                                                                            | How you check it                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A high-churn source does not wake a watch that is not about it                   | `watch trace` on any watch during a Strava or health sync: no records |
| One episode produces one firing, however many times its documents are re-indexed | `watch firings` — distinct `doc_id`s, no repeats                      |
| Removing and re-adding a source is silent                                        | Remove a source, re-add it, let it backfill: firing counts unchanged  |
| A restart loses nothing and repeats nothing                                      | `watch firings` before and after `omnesis service restart`            |
| The judge stays inside its budget                                                | `watch report` — `judge.calls` against the caps below                 |
| Evaluation stays cheap                                                           | `watch report` — the `evaluation` p50/p95/max block                   |
| Nothing is silently parked forever                                               | `watch report` — `pendingNominations` should return to zero each day  |
| No watch is stopped and unnoticed                                                | `watch report` — the `failed` count, which should be zero             |
| The DSL can still address the whole install                                      | `watch report` — the `ontology` fraction, which should be 1           |

## When a watch stops

Three ways, and they must not be confused:

- **retired, "its horizon passed"** — the question stopped being worth asking.
  Read on the clock rather than on the journal: a watch whose horizon goes by
  during a quiet spell retires on the next evaluation pass, without waiting for
  an unrelated document to arrive and carry it past. A deadline that came due
  _before_ the horizon is still owed and still fires; one that comes due after
  it never does, however far a later event drags the sweep.
- **retired, "fired once and was done"** — a `once_ever` watch that got its
  answer.
- **paused** — the ontology it validated against moved, its definition no longer
  validates, one of its nodes threw, or the record that wakes an agent for it
  could not be created. The note says which; resuming re-runs the arming for
  the last of those, and holds the watch again if it still cannot be minted.

A paused watch is recoverable. The runtime pauses on its own, so there has to be
a way back that is not "delete it and add it again" — which would start it at
the head and lose everything it had said:

```console
$ omnesis watch pause <name>
$ omnesis watch resume <name>
```

`resume` puts both halves back: the definition's status and the runtime's own
active flag. Setting only one would show a watch visibly running and silently
doing nothing.

It re-validates against the install first, and **refuses** with the validator's
own diagnostics when the watch would not survive its next evaluation. A resume
that reported success and left the watch to be paused again seconds later would
leave you holding two facts that contradict each other. A drifted fingerprint is
the common case and wants `watch restamp`, not this.

### A watch stopped on one thing it cannot get through

A node failure rolls its work back, cursor included, so the next pass meets the
same thing and stops on it again. That is deliberate — work whose effects were
lost must not be skipped in silence — but a watch that meets one poison item
stays stopped until someone says otherwise.

`watch report` names what stopped each one: the failure class, the node, and
the sequence.

| class      | who to ask                                                         |
| ---------- | ------------------------------------------------------------------ |
| `query`    | the watch's own SQL — a query that would not bind or would not run |
| `provider` | the judge or recall backend                                        |
| `budget`   | one event needed more rounds of off-host answers than are allowed  |
| `internal` | the runtime could not attribute it; treat as a defect              |

The message itself is in `watch trace <name>`, not in the status note — a note
is read on a listing and kept for as long as the watch exists, and an error from
a query engine or a model can quote a value out of the corpus. For the same
reason, be careful where you paste a trace.

To move past it:

```console
$ omnesis watch resume <name> --skip
```

That advances past the one journal event, or drops the one parked nomination,
that the watch could not get through, and writes a `skipped` record into the
trace. Skipping is the runtime declining to decide about something, so it has to
be visible: a reader has to be able to tell an event that was considered and
decided nothing from one that was never looked at. Everything else — the cursor
beyond that point, the live instances, every firing — is untouched.

It refuses when there is nothing a skip can act on, rather than reporting a skip
that moved nothing.

Removing a watch erases its state with it — cursor, looks, live instances,
parked nominations, firings. That is what `rm` has to mean, or the next watch
would inherit them.

## Delivering a firing

Off by default, per watch, and reversible without losing the watch's history:

```console
$ omnesis watch deliver <name>              # notify me when this fires
$ omnesis watch deliver <name> --to none    # stop; it goes back to a row and a trace
```

The kind is `omnesis-notify`, which is the default for `--to`. On an install
with an agent it is that agent opening a conversation about the firing and
telling you what happened, with a notification pointing at that message; with
no agent, or when the turn fails, the same firing still goes out as a plain
banner composed from the request. The old spelling `ios-push` is still
accepted — on the flag, on `PUT …/delivery`, and in a watch already stored with
it — and normalised on the way in; it goes at the major bump. Nothing was named
for a platform because nothing about this is one: the same delivery reaches
whichever devices are paired.

The notification goes down the same tail every other Omnesis push uses — the
same device list, the same APNs client, the same record of what was sent. What
is new is only which engine asks it to send.

### Waking an agent instead

A firing can wake an agent rather than a person:

```console
$ omnesis watch deliver <name> --to agent-wake \
    --integration openclaw \
    --instruction "Draft a reply to the sender and leave it in my drafts." \
    --binding mailbox=drafts
```

Two halves, from two places. The watch decides **when**, deterministically and
in the DSL. The instruction decides **what**, in your own words, and it is the
whole of what the agent is told to do.

Bindings are the third, optional part, and they exist because an instruction is
prose. "Post it in the usual channel" names something you know and the woken
agent does not, and an agent that has to guess a referent either guesses right
or does the work and drops it on the floor. A binding is an opaque `key=value`
pair carried to the agent with the instruction: Omnesis never interprets one,
so a key means whatever your instruction says it means. They are part of what
you approved, so changing them retires the anchor the same way changing the
instruction does.

An integration can bind its own. `POST /subscriptions` takes `reaction.bindings`
beside `reaction.instruction`, and both harness plugins expose it on their
subscription-management tool — so an agent that writes an instruction naming a
conversation can say which one in the same request. It has to be able to: an
agent is the only party that knows where the workflow it just described should
act, and setting them from the operator side re-mints the anchor as
operator-authored, which would take the watch out of the agent's own listing.
Creation only, on the same grounds as the instruction: a referent decides where
a workflow acts, so it cannot be edited behind an approval already given.
Revoke and create instead.

A value is text without control characters. A binding is rendered into the
woken run's prompt beside the instruction and framed as a referent to act on,
so a newline in one could forge a line the run has just been told to trust.

The wake travels the apparatus that already exists for an agent's own watches —
an approval, a grant, an answer authority scoped to one firing, a privacy
reviewer, an egress ledger — by keeping one **delivery anchor** among the
subscriptions per watch. Nothing about the route differs from an integration's
own subscription, which is the point: a firing that travelled a private one
would be a firing nobody reviewed.

What crosses to the agent is opaque identifiers, your instruction and bindings,
and two authorities — never the firing's payload. The two are deliberately
different lengths. The one for asking what caused the firing is short-lived and
scoped to that firing alone, because it releases corpus content. The one for
reporting what the run did lasts 24 hours: nothing leaves the machine through a
report, and the run it describes can outlive every short-lived credential it was
handed.

Bindings and that second authority are carried only to a plugin that speaks
version 4 of the wake protocol. Each side advertises the range it understands
and the wake is built at the highest version both do, so a plugin advertising
only version 3 goes on receiving exactly the version 3 wake — no bindings, no
outcome authority, and no error to say so. An operator who adds a `--binding`
against such a plugin gets a silently binding-less wake. Upgrade the gateway
before the plugins: an older gateway rejects a newer plugin's hello outright,
and the plugin reconnects against that refusal in a loop.

The agent then asks what caused the firing. That question is answered inside the
gateway by a read-only turn that starts from what the firing recorded — the
matched documents for a watch that reads documents, and otherwise the claim you
wrote, the instant it came true, and whatever the plan observed satisfying it —
and then researches the corpus like any other question. Its reply passes through
the reviewer and the ledger on its way out, which is what makes the research
safe: the evidence says _which_ occurrence is under discussion, and the reviewer
decides what may be said about it.

### What the run did

The second authority is how a woken run says what it did, at
`POST /subscriptions/firings/<id>/outcome`. It is not a delivery receipt: a
workflow may send a message, write an email, change a record, or correctly
decide there was nothing to do, and the report says which of those happened in
the run's own words. `deferred` means the run ended waiting on something that
will re-enter later — an answer held for your approval — and the run that
resumes reports again over the top.

There is a ceiling on that. The authority is minted once, with the wake, and
expires 24 hours later; a report filed after it does is refused, and the firing
stays outcome-less for good. So a run deferred on an approval you do not get to
within the day reads afterwards exactly like a run that never came back.

Without it the gateway's knowledge would end at "the harness took delivery",
and a run that did nothing would be indistinguishable from one that did
everything. `omnesis watch firings --all` is where that shows:

```console
$ omnesis watch firings --all --since 24h
```

A firing with no outcome after its run should have finished is the shape worth
looking at.

The anchor is bookkeeping, so it is kept off every listing of what an agent has
asked for: what you authored is the watch, and the watch is where it is shown.
Changing the integration or the instruction retires the anchor and mints a new
one, because the instruction is what was approved and the ledger has to keep
saying which words each wake was sent under. A record that has expired is
replaced the same way, so re-installing an unchanged watch is how you get its
wake back; one you paused is not, because the pause is a decision and a fresh
record beside it would quietly undo it.

A watch naming an integration no device holds does not fail. It goes on firing
and recording, and says in the log that nobody was woken — which is worth
reading, because silence there is otherwise indistinguishable from an agent that
read every wake and did nothing.

The same silence has a second cause, and the reconcile at start repairs it: a
watch that declares a wake and holds no record to carry it, or holds two when
only one is reachable. Both are invisible from every other surface — the watch
evaluates, judges and records exactly as a healthy one does — so neither would
be found by looking.

Missing, it mints one, preserving the device and the author of the record that
went missing rather than re-deriving them from the definition: the definition
names a harness, and resolving one picks whichever device holding that name
paired most recently, which is not reliably the agent that asked. A record the
operator **denied** or **revoked** is a decision rather than a fault, and is
left alone; an expired one is nobody's decision and is replaced. Doubled, it
retires every record past the first by the order every reader here uses, so the
one that stays is the one they were all already reaching. Each repair is logged
with what it did.

Wakes have their own allowance, budgeted apart from notifications: a wake costs
an agent turn rather than your attention. `gateway.watch.wake.dailyCap`
defaults to 25 and `wake.perWatchDailyCap` to 10, and over either the firing is
suppressed exactly as a notification would be.

A watch that asks for delivery on a gateway with no APNs configured is not an
error. It goes on firing and recording, says so in the log, and starts notifying
the moment push is configured.

### Caps, because a push interrupts a person

| knob                                      | default | what it bounds                                       |
| ----------------------------------------- | ------- | ---------------------------------------------------- |
| `gateway.watch.delivery.perWatchDailyCap` | 5       | notifications one watch may send in a day            |
| `gateway.watch.delivery.dailyCap`         | 20      | notifications every watch together may send in a day |

Over either cap the firing is **suppressed**: the row and the trace record are
written exactly as they would be, and only the notification is withheld. There
is no queue — a notification that arrives an hour after the thing it is about is
a wrong notification, and a queue would turn a cap into a delay.

Suppression is visible, deliberately. `watch report` shows the day's tally
against the cap and each watch's own, and the trace carries a `suppressed`
record saying which cap was spent. A cap that dropped notifications in silence
would be indistinguishable from a watch that had stopped firing — which is the
one thing a person relying on it cannot be left to guess about.

The allowance is durable and keyed on the day, so a restart does not hand a
watch a fresh one.

## What a compile may spend on thinking

Off unless `gateway.watch.compileReasoningTokens` is set; there is no default.
Set, it bounds how much of a compile's turn may go to reasoning rather than to
the answer, and the reason to set it is that on a reasoning model the two come
out of one pool. Measured against a reasoning model behind an OpenAI-compatible
server: given eight thousand output tokens and no bound, one turn reported eight
thousand reasoning tokens, eight thousand completion tokens, and returned no
answer at all. It spent the pool deciding.

The number configured is not the number sent. What is sent is the output budget
less a reserve for the answer — four thousand tokens, or half the budget where
half is smaller — and never more than the configured bound. On a large ceiling
the reserve is a small share of it and the bound does the work; on a small one
the reserve is half, and where what is left falls under the floor a provider
enforces, nothing is sent at all and the turn runs unbounded. A bound arrived at
by accident would be tighter than anyone chose on exactly the path a bound
exists to improve.

Which backend compiles decides how the bound is delivered. The Anthropic backend
knows which of its models accept a thinking budget and sends one only to those.
An OpenAI-compatible server cannot be asked in advance, so the backend offers the
field, and withdraws it and re-issues the turn if the server rejects it. Both are
fail-open: a bound that cannot be delivered costs the turn nothing, and the
difference shows in the log rather than in the answer. That matters more than it
sounds — the same knob measured as an improvement on a backend that never read
it, which is a result about the measurement and not about the bound.

## Restarting while a compile is running

Creating a watch runs a full agentic compile, which takes minutes on this
install; a deploy takes seconds. A restart lands inside one often enough that it
is the ordinary case rather than an exceptional one, and until this was handled
the compile died with the process and its caller saw a dropped connection. An
agent reads that as a broken feature and answers by asking again in different
words — a different idempotency key by design, so the guard that exists to catch
a duplicate never fires. That is how one intent became five watches.

A stopping gateway now refuses **new** compiles with a 503 saying it is
restarting and did not start, and **drains** the ones already running before it
closes anything else. Both entry points — the operator's `POST
/admin/watch/compile` and an integration's `POST /subscriptions` — refuse at the
same moment, because they read the same object the compiles run on.

**Before restarting, check whether anything is compiling.** `omnesis watch
report --json` carries it:

```json
"compiles": { "running": 1, "accepting": true }
```

`running` counts every compile in flight — an operator preview, an integration's
create, the agent's own watch tool. `accepting: false` on a gateway nobody is
stopping means a stop began and wedged: nothing new will compile until it is
restarted. The stop says the same thing in the log
(`draining N in-flight compile(s)`), but only once it is too late to choose a
better moment.

The drain has a budget of its own, deliberately much smaller than the stop's:
a compile runs for minutes, so waiting for one to finish would spend the whole
shutdown allowance and reach the hard timeout with the databases still open —
trading a clean stop for a compile that gets killed anyway. What the wait buys
is the compile that was nearly done. Anything longer is cut off, and its caller
sees the connection close; only requests arriving after the stop began get the
sentence.

### Why the create is still synchronous

The obvious alternative is to accept the request, answer 202, and notify when
the watch exists. It is not obviously better, and the numbers say why. A compile
here runs at a median of 81 seconds; the integration adapters now allow five
minutes, which clears that with room. Against that, 202 costs a second endpoint
to poll, a state for a watch that has been asked for and does not exist yet, and
a second delivery path for the answer — and every one of those is a place a
caller can be left holding a reference to nothing.

The synchronous shape's failure mode was never the waiting. It was a client that
gave up after twenty seconds while the gateway worked on, and a restart that
killed the work silently. Both are fixed here. If the compile's median moves
toward the adapters' budget, or a harness appears that cannot hold a request
open for minutes, the trade changes and the 202 shape is the answer — but
paying for it now would be paying for a problem the measurements do not show.

## Knobs

All under `gateway.watch` in `config.json`, all optional.

| Knob                        | Default | What it is                                                         |
| --------------------------- | ------- | ------------------------------------------------------------------ |
| `compileReasoningTokens`    | unset   | Ceiling on a compile turn's reasoning; unset leaves it unbounded   |
| `compileTimeoutMs`          | 180000  | How long one compile may take before it is given up on             |
| `drainIntervalMs`           | 2000    | How often the journal drain runs while events arrive               |
| `idleIntervalMs`            | 15000   | And when nothing is arriving                                       |
| `batchSize`                 | 500     | Journal events written per drain                                   |
| `queueCapacity`             | 50000   | Captured document events that may wait in memory                   |
| `evaluateIntervalMs`        | 5000    | How often the watches are evaluated                                |
| `idleEvaluateIntervalMs`    | 30000   | And when there is nothing to read — also how late a timer can fire |
| `eventsPerWatch`            | 200     | Journal events handed to one watch per evaluation                  |
| `traceRetained`             | 2000    | Trace records kept per watch — how much of a week stays reviewable |
| `judge.dailyCap`            | 200     | Judge calls per UTC day across every watch; 0 or at least 2        |
| `judge.perWatchDailyCap`    | 50      | And for any one watch; 0 or at least 2                             |
| `delivery.dailyCap`         | 20      | Notifications per day across every watch                           |
| `delivery.perWatchDailyCap` | 5       | And for any one watch                                              |
| `wake.dailyCap`             | 25      | Agent wakes per day across every watch                             |
| `wake.perWatchDailyCap`     | 10      | And for any one watch                                              |

The judge runs **live** during shadow mode: a one-shot structured completion on
the independent `watch-judge` role through the inference registry, with its usage
recorded like every other internal model call. It is not routed through the
cognition queue — a judgement is one proposition and one document, and giving it
a queue would couple two subsystems' latency and failure modes for nothing.

Natural-language Watch compilation is different: it remains an agent session
on the `background-agent` role because the compiler needs read-only tools and a
longer reasoning turn. Hand-written definitions need neither model unless they
contain a semantic judge.

Upgrading does not silently copy `background-agent` into `watch-judge`. Assign
the new role explicitly; until then, semantic nominations stay parked without
spending judge budget or calling a provider. This deliberate cutover gives
Watch a separate assignment, accounting, and budget from Brain. If both roles
are deliberately pointed at the same backend, they still share that provider's
capacity, rate limits, and outages.

It fails closed. A reply that does not parse, a model that errors, or a spent
budget produces no decision and leaves the nomination parked. A judge that
fired on ambiguity would turn every outage into a false positive. Budgeted
nominations retry at the next UTC day; provider failures retry after cooldown,
in FIFO order. Only a call actually sent to the provider consumes the allowance.

The day's spend is kept on disk beside the traces, so both caps bound the
install's day rather than the process's. A gateway restarted at noon continues
the morning's spend instead of being handed a fresh allowance — which matters
most for exactly the watch the caps exist to bound, because its parked
nominations are durable and draining them is the first thing the next pass
does.

Analytics rows do not cross the synchronous event bus. Each committed ingest
page is retained in DuckDB's internal Watch outbox, including the schema and
backfill state it had at ingest time. The materializer advances its page/row
cursor atomically with journal events and dedup hashes in `watch.db`; after a
48-hour grace period measured from Watch consumption, fully consumed chunks are
pruned while the newest watermark is retained. A mismatched restore is clamped
to the retained watermark and may safely repeat retained rows, but analytics
history older than that grace copy cannot be reconstructed from `watch.db`.
`watch report` exposes the producer head, committed cursor, pending rows and
chunks, oldest pending age, and retained bytes so a stuck hand-off is visible.

## Costing a watch before you run it

A semantic watch's cost is the number of documents its recall arm nominates, not
the number it fires on. The number to read is `judge.calls` per watch in
`watch report` — the trace's `held` records are not a proxy for it, because
most of them come from nodes that never reach a model.

Compare a watch's `judge.calls` against its firings. One that is judging far
more than it fires on wants a tighter filter or a higher threshold: both are
free, and the judge is not. `watch trace` tells you _which_ documents were
nominated, which is how you decide which way to move the threshold.

## When a watch has gone quiet

Silence has two explanations and only one of them is a problem. `watch report`
now separates them without being asked:

```console
$ omnesis watch report
watches: 26 evaluating, 1 stopped (1 drifted)
last evaluated 4s ago · journal head seq 17342 12m ago
1 watch(es) stopped because the ontology moved under them — they are silent until re-stamped
```

The first line counts what is running against what is not, and every stopped
watch lands in exactly one bucket:

| bucket    | what it means                                                          |
| --------- | ---------------------------------------------------------------------- |
| `drifted` | the ontology moved and the watch no longer validates — nobody chose it |
| `failed`  | a node threw; the failure record names which and why                   |
| `held`    | somebody paused it                                                     |
| `retired` | it finished its job — not a fault, and never alarms                    |

`drifted` is separate from `held` deliberately. A held watch is a decision
someone remembers making; a drifted one stopped because a source shipped a new
schema, and it goes on being silent in a way that reads exactly like a week with
nothing in it.

A watch reaches `drifted` for one of two reasons, and each says so in its own
note. **"no longer validates: …"** names the codes that moved and means the
watch needs rewriting. **"the ontology it reads has changed: …"** means the
watch validates fine and was held because something it reads is not what it was
approved against — the operator's call to make, and `omnesis watch restamp` is
how they make it. That is exactly the "yes, I have looked, this surface is fine"
the runtime will not say on its own, so re-stamping records the surface as well
as the fingerprint: the approval sticks, and the next unrelated move does not
ask again.

The second line is liveness, and it answers the other question: an install that
has not evaluated in hours with a journal ahead of it is not quiet, it is
stopped. The staleness bound is derived from `idleEvaluateIntervalMs`, so an
install that evaluates rarely on purpose does not alarm on its own settings.

The same sentence is logged, once per change — including the change back to
healthy, which is the recovery nobody would otherwise see.

## Costing a watch before it has ever fired

A watch starts at the journal head, so the first evidence that its threshold is
right arrives with its first match. If the threshold is slightly too high, that
evidence never arrives: the watch is silent, and a correct watch over a quiet
month looks the same. `watch probe` asks the question against the past, where
there is an answer today:

```console
$ omnesis watch probe property-listing-recall --days 180
property-listing-recall
  mail (threshold 0.300)  would have nominated 14 of 812
    scores: best 0.612 · p95 0.402 · median 0.104 · the next document down sits at 0.298
    over 180 day(s)
```

A watch that would have nominated **nothing** says by how much it missed, which
is the number to act on:

```console
  mail (threshold 0.450)  would have nominated nothing · best 0.371 is 0.079 under the threshold
```

Two things it is not. It is not a search: the result is counts and scores, never
the documents, because "is this threshold right" does not need them. And
nomination is not firing — a judge still decides — so a healthy nomination count
is the arm working, not the watch being correct.

The probe applies the filter's **source and document type** only, not its people
or metadata predicates. Those narrow, so ignoring them can only over-count; the
number is reported as `considered` rather than `matched` for that reason.
