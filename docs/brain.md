# The Omnesis Brain — operating guide

The Brain is the background agent that reads your corpus on its own and writes
what it learns into three kinds of durable artifact: **temporal annotations**
(dated facts — "the lease renews on 14 March"), **open loops** (obligations
that are still outstanding), and **briefs** (cards that interrupt you). It is
the only part of Omnesis that spends money without you asking it to, which is
why it has an operating guide and the rest of the system does not.

It is experimental. Nothing here is on unless you deliberately turned it on.

A date that merely times an obligation stays in the loop’s deadline. A separate
event or interval belongs in a temporal annotation even when it shares that
date. Before adding a deadline annotation, the tool checks explicitly linked
loops for the same interval and returns candidates for reconciliation without
writing a row. A distinct dated fact can still be added after reviewing those
candidates; this check does not classify meaning from dates alone.

## Turning it on takes two acts

The Brain is active only when **both** are true:

1. the gateway was started with `OMNESIS_EXPERIMENTAL=1`, and
2. a model is assigned to the `background-agent` role.

Either alone does nothing. `GET /status` reports the gate as `brain`
(`visible` / `enabled` / `modelAssigned` / `active`), and the portal's Cognition
page says which of the two is missing.

The second act is the one that starts spending. Assigning a model turns on
**nine producers at once** — the live waker, the retrospective bootstrap lane,
synthesis, collision detection, re-verification, provenance rechecks, the
judge, the digest, and sweeps. That is deliberate: an engine that reacts to new
documents but never notices anything across them is not the feature. But it
means the moment after you assign a model is the moment to read the rest of
this page.

## The two lanes

Work is divided by the **datum's own timestamp**, not by when it was ingested:

- inside `brain.recencyWindow` (7 days by default) → the **live waker**
- outside it → the **retrospective bootstrap lane**

The partition is exact and shared, so no document belongs to both and none
falls between them. A document ingested today but dated two years ago is the
bootstrap lane's.

### The bootstrap lane is the one that spends unboundedly

The live waker's work is bounded by how much new material arrives. The
bootstrap lane's is bounded by how much history you have, which on a mature
corpus means it runs for days or weeks.

Each bootstrap run is a full agent run — it fetches the document, reconciles it
against what the Brain already recorded, then writes only what is new — so it
costs several model round-trips, not one completion. Measure your own: the
portal's **Cognition → Bootstrap** panel reports what the lane actually
completed in the last 24 hours, and the spend summary on the **Cognition →
Overview** tab reports the tokens those runs consumed.

The panel reports the lane as one of seven states:

| State       | Meaning                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `unstarted` | Never started. Assigning the `background-agent` model does not start it; **Start reading history** on the Bootstrap tab does. |
| `off`       | `brain.bootstrap.enabled` is false.                                                                                           |
| `holding`   | Within ten minutes of a gateway start. The lane stays out of post-restart backfill contention.                                |
| `waiting`   | Outside `brain.bootstrap.activeHours`. Quiet on your instruction.                                                             |
| `running`   | Working through history at its configured pace.                                                                               |
| `drained`   | Nothing left to review. Reopens on a new local day or when a source is added.                                                 |
| `parked`    | Stopped at `brain.bootstrap.maxRuns`. Raise the ceiling to resume.                                                            |

`parked` is the one to act on, and the panel renders it in the fault tone for
that reason. A parked lane is silent otherwise.

## Bounding the spend

Everything is measured in **tokens and runs**. The Brain reports no figure in
currency anywhere, and this is deliberate rather than an omission: no inference
API it talks to exposes a price, so any number in money would be an estimate
the gateway could not verify — a poor thing to stand between you and a large
spend. Convert against your provider's own pricing page.

### Not all tokens cost the same

The panel splits the day three ways, and the split matters more than the total:

- **Read for the first time** — fresh input. The expensive part.
- **Re-read from cache** — a prompt prefix the provider already held, billed at
  a fraction of fresh input. This is a _subset_ of what was read, not extra.
- **Written** — output. On the retrospective lane this is usually around 1% of
  the total.

A corpus-wide backfill re-reads a large cached prefix on every run, so the
cached share is typically high, and it is **the biggest cost lever you have**.
Two days with identical token totals can cost very differently depending on it,
and a change that breaks the cacheable prefix shows up as the share collapsing
while the total barely moves. If your spend jumps without your token count
changing, look here first.

The budget ceilings below deliberately count every token the same. A limit has
to be predictable, and one that moved with how well a prompt cached that day
would not be.

Two independent ceilings, both read live so raising one resumes work without a
restart:

**`brain.budget.dailyTokens` / `brain.budget.dailyRuns`** — a ceiling on ALL
background cognition per local day. Enforced at the claim boundary, so reaching
it parks the queue rather than failing runs: a parked run is resumable
tomorrow, a failed one burns its retry budget. It counts interactive spend too,
because a budget background work could exhaust while a chat session spent
freely alongside it would not be a budget. **Both default to no ceiling.**

**`brain.bootstrap.maxRunsPerDay`** — the retrospective lane's pace, and the
knob to reach for first. Note that the drainer works one bootstrap run at a
time, so above its real throughput this number stops meaning anything; the
panel says so when your configured cap exceeds what the lane demonstrably
reaches.

**`brain.bootstrap.maxRuns`** — a lifetime backstop, counted across the whole
install and never reset, including across source removals. It is a spend
backstop rather than a per-corpus one: if removing a source refunded its runs,
delete-and-re-add would be a way around it.

If you need to turn the spend down, in order:

1. `brain.bootstrap.maxRunsPerDay` — the biggest lever by far.
2. `brain.bootstrap.activeHours` — shape it onto off-peak hours rather than
   reducing it.
3. `brain.reverification.maxPerSweep` — the second-largest producer.
4. Individual producers to `enabled: false`.
5. `brain.budget.dailyTokens` as a hard stop under all of it.

### Shaping it onto hours that suit you

`brain.bootstrap.activeHours` is an optional local wall-clock window:

```json
{ "brain": { "bootstrap": { "activeHours": { "from": "01:00", "to": "07:00" } } } }
```

A window whose end is not after its start wraps midnight, so `22:00`–`06:00`
means overnight. It gates when the lane **buys** work, not when a bought run
executes — a run already enqueued is worked to completion whenever the drainer
reaches it, because stopping mid-run would waste the tokens already spent on
it.

### Stopping it

The Bootstrap panel has a pause control. It writes
`brain.bootstrap.enabled`, the same key the config editor does. Pausing costs
nothing already done: the processed marker is written once per document and
never cleared, so resuming re-reads nothing.

## When a provider fails

A failure is judged by what it blames. A malformed or over-long payload is the
request's fault, and its run retires after its retry budget. Anything else —
no credit, a rejected key, a rate limit, an unreachable backend — is the
environment's fault, and the run **keeps its place**: its attempt is refunded
and it waits, because the same payload will succeed once the environment is
repaired.

After three consecutive backend failures the drainer stops claiming altogether
and backs off from one minute to fifteen. The Bootstrap panel shows a **Model
backend — Failing** banner naming the provider's own error. Nothing is lost
while it lasts.

## Upgrading

`brain.*` was `briefs.*` in earlier versions. A stale `briefs` block is
stripped on load **and** the cached raw text is rewritten, so the portal's
Config tab stops showing it and the next portal write persists the loss. Move
your settings before upgrading if you had any.

A dropped key means the settings under it revert to defaults — and a default is
not necessarily the quiet outcome you might assume, since most producers ship
on.

## Watching it

- **Portal → Cognition** — lane states, budget, spend by mechanism, open loops,
  briefs, and the run queue.
- **Portal → Debug → Background jobs** — every periodic task, when it last ran.
- **`omnesis brain runs`** — the queue, newest first. `omnesis brain run <id>`
  and `omnesis brain transcript <id>` open one up.
- **`omnesis brain spend`** — tokens by day, mechanism and model.
- **`omnesis brain decisions`** — what the agent decided about a given datum,
  and why.
