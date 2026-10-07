# The Omnesis Brain — operating guide

The Brain maintains evidence-backed understanding: project and topic wikis,
tracked outcomes (loops), document and person annotations, a time index, and
briefs. A compact **root wiki** provides current orientation to agent runs.
These records are synthesis, not independent evidence.

The autonomous Brain is experimental and unstable. Enable
`OMNESIS_EXPERIMENTAL=1` and assign a reachable `background-agent` model to
start it. Either alone leaves autonomous work inactive. Evidence invalidation
and privacy cleanup continue when autonomous synthesis is stopped.

## Changes and maintenance

Source writes record a durable change and invalidate affected evidence without
calling a model. Invalidated claims remain visibly stale until maintenance;
privacy-deleted evidence is denied immediately while bounded cleanup removes
derived content and index projections.

The `decision` role scores urgency, discovery relevance, dependency impact and
proactive review. Its ordered-level answers are normalized to 0–1. Missing or
invalid judgements take the conservative path; they do not establish that
content is irrelevant or verified. Maintenance tiers are configurable under
`brain.knowledge`:

| Setting              | Default | Purpose                                       |
| -------------------- | ------- | --------------------------------------------- |
| `immediateThreshold` | 0.8     | Immediate repair threshold                    |
| `soonThreshold`      | 0.4     | Hourly repair threshold                       |
| `soonDelay`          | `1h`    | Delay for soon work                           |
| `routineDelay`       | `6h`    | Delay for routine work                        |
| `rootMaxChars`       | 8000    | Hard limit for the root wiki                  |
| `maxSeeds`           | 64      | Admission bound per maintenance pass          |
| `maxFrontierNodes`   | 32      | Maximum offered frontier size                 |
| `maxFrontierChars`   | 65536   | Maximum JSON characters per frontier response |
| `maxVisitedPerSeed`  | 256     | Bounded affected-region traversal             |

Evidence changes whose potentially affected regions overlap share a batch;
disjoint regions can remain separate. The root is a separately coordinated
aggregate so a shared overview does not join every project into one batch.

A synthesis run asks `knowledge_next_frontier` for work. The engine checks input
versions, runs relevance gates, and offers the next breadth-first frontier.
The agent writes through validated tools; the engine records changed,
unchanged, skipped or deferred outcomes. Only material changes expand repair
into dependents. Concurrent edits invalidate an obsolete proposal rather than
letting it overwrite a newer revision. Interrupted work remains durable.
The first frontier is gated before starting the agent: a fully skipped batch
does not consume a synthesis turn.

New evidence needs discovery even when no dependency points to it yet. The
agent searches established context, adds evidence to existing synthesis, or
proposes a scoped page candidate. A source does not require its own page.
Agent transcripts are excluded from automatic source discovery. When explicitly
cited as evidence, their edits repair existing dependents and their deletion
purges derived content, including historical provenance.
Newly arriving historical evidence is considered without treating its events
as new commitments or allowing an old proposal to overwrite an accepted plan.

## Claims and context

Wikis, root text, loop descriptions, annotations and briefs use Markdown with
addressable claim spans:

```html
<claim id="setup" refs="source:document-id#evidence:passage-id">Setup is at 08:00.</claim>
```

Tags can nest. Each claim has its own ID; references can name multiple source
passages, other claims, or canonical loop fields. Support, contradiction,
context, applicability and verification state live in structured storage.
Nesting alone does not supply evidence for the enclosing assertion. Structured
claim state also records attribution, modality (observation, reported statement,
proposal, commitment, inference, recommendation or question), and epistemic
status (asserted, disputed or unsupported). These are distinct from verifier
results: an agent cannot declare its own claim verified, and disputed or
unsupported claims cannot serve as verified support. An explicitly unsupported
question or context span may use `refs=""`; the attribute remains required,
and a claim without supporting references cannot be verified.

Normal reads and search omit tags. Editing reads retain them, while provenance
and revision history remain inspectable. The mutation boundary parses markup,
checks references and versions, and invokes the entailment verifier on changed
claims. An unavailable verifier leaves a claim unverified. Well-formed markup
is not proof of factual completeness; untagged prose does not inherit verified
status from neighboring claims. Synthesis mutation tools require every nonblank
text span, including headings, to be inside a claim tag. This structural
coverage check is separate from entailment; migrated legacy owner text remains
explicitly unverified until repaired.

A wiki supplies context; a loop tracks an outcome. Organizational links can
express project membership, page hierarchy and separately trackable subloops.
They do not imply evidential support. Operational blocking and completion stay
in the loop's canonical fields. Closing or retiring a loop preserves its useful
history; deleting private evidence has separate removal semantics.

A loop keeps the same completion criterion as its evidence develops. Titles and
descriptions may clarify that outcome; a shared person, topic or project does
not make a different action the same outcome. Correct unsupported or
misunderstood framing transparently in the ledger, or dismiss/remove the loop
under the retirement rules with an explicit reason; never substitute another
task's completion for fulfilment of the original outcome.
Track a distinct supported action separately and preserve relevant context links.

Wikis are navigable reference pages: a descriptive title, a concise introduction,
and sections for distinct supported topics. Their structure grows with the
evidence; there is no page or section quota. Markdown links to existing wikis
(`wiki:<id>`) and tracked outcomes (`loop:<id>`) provide navigation. These links
do not establish evidential support. Keep a section heading inside the first
relevant claim block, with newlines around its Markdown content, and retain
separate claim spans for subsequent assertions.
A scheduled wiki review considers the page's scope, related outcomes and a
bounded selection of current evidence beyond its existing citations. Ordinary
change propagation can remain focused on affected claims. Accurate older text
does not by itself establish that a page includes the relevant developments.

The root wiki is the compact overview and entry point to relevant detail pages.
It links to existing wikis instead of reproducing their full contents.
Every write must fit `rootMaxChars`. It is injected as untrusted reference
context; reading it does not create an automatic dependency on every claim.
Once readable synthesis exists, the initial empty root receives bounded
scheduling preference over ordinary synthesis, below reactive work. Initial
orientation bypasses the impact gate; subsequent updates use normal maintenance.
Publishing a new wiki schedules populated-root orientation at the configured
`soon` delay; ordinary page edits use the routine delay. Multiple publications
coalesce without moving an already scheduled refresh later.

## Bootstrap and upgrade

Schema migration preserves existing loop states, annotations and available
provenance. Legacy attachments become explicitly unverified context, not
verified claims. Existing notes remain available while the root acquires
grounded understanding. Conversion and page organization have separate
coverage, keyed by source revision and policy version.

Historical organization is opt-in: use **Cognition → Bootstrap → Start reading
history**. Assigning a model does not grant an unlimited historical reread.
Existing `brain.bootstrap` enablement, ordering, active hours, backlog and
admission caps apply. The default order is recent-first; older evidence remains
eligible even without a future date.
Historical notices establish what happened then; missing follow-up evidence does
not establish a current obligation or prove that an outcome is still unresolved.
Displayed factual premises need grounding even when they accompany advice.
Admission fills the available batch allowance in rounds across sources, preserving
the configured chronological order within each source. A prolific source can use
capacity left by exhausted sources. Admitted history is due immediately at routine
priority on both fresh and upgraded databases; the routine edit-coalescing delay
does not postpone an explicitly authorized first pass. A bounded historical slot
keeps continuous live arrivals from starving authorized backfill.

Initial collector enumerations carry a durable inventory identity through the
generic cursor-page protocol. Partial pages and collector restarts keep that
identity; the final cursor commit marks that inventory complete. New document
revisions in an inventory enter fair recent-first admission. The configurable
`brain.knowledge.recentWindowDays` window (default 30) is measured against that
inventory's first receipt at the gateway, retained across retries and independent
of the collector's clock. Recent inventory shares the live cognition budget; older and
undated inventory requires historical-review consent and uses its admission caps.
The Brain can start on partial imports without waiting for every collector.

Ordinary arrivals, edits, and late evidence stay reactive regardless of their
event dates. Clients that do not send inventory provenance retain this reactive
behavior; dates alone never establish that an arrival was historical inventory.
Bootstrap status reports each observed inventory's import state and separate
recent, history, and undated revision counts, considered/gated/pending outcomes,
and observed source-date bounds. These are scoped coverage milestones, not a
claim that unseen provider history has been understood.

Frontier responses also have a JSON character budget. The engine leaves excess
items for later calls. An oversized page is represented by `fetchRequired`, not
truncated claim markup: fetch it explicitly with `knowledge_fetch(editing=true)`
and resolve its current references before saving. Omitted input versions are
marked explicitly; the internal frontier still retains the complete fingerprint.
Use the run-bound `knowledge_maintenance_inputs` tool to page omitted versions.
Newly discovered source inputs remain available across continuation turns even
before a page cites them. They are context to inspect, not automatic support;
the agent must fetch their content and establish claim dependencies explicitly.

Each offered node also identifies pending claim IDs. A synthesis save names
`reviewedClaimIds` for retained assertions it actually reviewed. Changed or removed
assertions are accounted for by the accepted mutation; untouched claims outside
that explicit review remain pending. The engine records outcomes against the
batch, node, input fingerprint and claim revision. Partial saves therefore cannot
silently settle the rest of a page. Large pending rosters are exposed in bounded
subsets through successive frontier calls.

Bootstrap reports distinct coverage and conversion milestones. A populated
root or an empty eligible queue does not mean the entire corpus is understood.
Late sources, revised inputs and policy changes can reopen coverage. Pausing
historical admission preserves completed work; resuming can revisit genuinely
changed inputs.

The run queue uses four maintenance workers by default (`brain.workerConcurrency`,
maximum 32). Only maintenance tied to a live batch with reserved regions can
execute in parallel; root aggregation and legacy runs, including daily reviews
and digests, execute exclusively. Freed slots refill while siblings run. Each
drain admits at most four times the worker count, rechecking the feature gate,
daily budget and provider breaker before each claim. Active runs finish or abort before the scheduler invocation returns;
each queue row is admitted at most once in that invocation. Budget
checks stop new admissions; already admitted work can finish and accrue spend.
User feedback and new-data runs keep the highest queue priority. Within maintenance,
the bound batch's immediate and soon tiers precede routine historical work. Root
maintenance and joint organization reviews share a preferred slot, at most once
per four distinct synthesis admissions. That slot precedes immediate and soon
maintenance, so continuously arriving first-pass work cannot starve organization
or root orientation; user feedback and new-data runs still precede it. Root work uses this bounded preference even
when its batch is immediate, so repeated root reviews cannot bypass the shared allowance. Retry deadlines and exclusive-run ordering still apply.
Ready urgent evidence blocked by an existing reserved batch raises that batch's
priority without clearing its retry deadline; adopted work can also raise priority.
Organization reviews retain their bounded preference while the same batch finishes
the resulting repairs.
A maintenance turn that reaches its tool-call limit after settling frontier inputs
continues in a new run on the same durable batch. Completed inputs and reservations
remain intact, each segment keeps its transcript and spend, and the successor must
pass the usual admission budget. A cap reached without settled-input progress
retains the ordinary failure policy.
Codex background turns have independent runtime capacity, defaulting to four
slots (`inference.codex.backgroundPoolSize`), so interactive requests and nested
verification calls do not compete for those slots.

Parallel runs retain server-held receipts for the canonical records and wiki
collections they actually read. Writer transactions reject stale receipts,
including a concurrent create after a negative search. The agent must repeat
the relevant reads and reconcile before retrying. These checks establish version
freshness; the model still reconciles meaning and decides whether scopes overlap.
Root updates stay exclusive; parallel maintenance cannot rewrite the shared notes
blob.
Temporal annotation updates and deletions also require that exact annotation to
have appeared in a current `temporal_query` result, or in the run's own successful
write result. Querying another interval does not refresh an older annotation
read. Collection receipts protect creates against intervening annotation writes;
they do not prove that the query covered the proposed interval or that its
meaning duplicates an existing event. Choosing the relevant interval and
reconciling the returned evidence remain the agent's responsibility.

## Proactive review

Changed evidence is the main repair trigger. Bounded proactive passes also
check deadlines, review checkpoints, volatility, importance, uncertainty and
time since verification. Loop signals use the current canonical deadline and
importance. The decision model chooses immediate review, bounded deferral or
dormancy; dormancy still has a maximum-interval and checkpoint backstop. The
engine stores the decision, reason and next review time separately from
verification. Unavailable decisions fail open to review. A deferral is not
verification. Completed and
historical records remain context without being repeatedly reopened merely
because their outcome is old.

Dismissed, retired and expired briefs preserve their historical prose rather
than undergoing routine rewriting. Evidence changes still invalidate their
support and propagate support loss to dependent durable synthesis; privacy
deletion still removes affected material. Snoozed briefs can become active
again when their canonical state returns to unread.

Organization also revisits deferred page candidates and previously gated or
failed discovery decisions after a bounded interval. It uses evidence already
admitted to the Brain, so this backstop does not silently expand historical
consent. Candidate context helps the agent choose between a new page, an
existing page, deferral and dismissal. It does not count as verified evidence.
Durable admission and retry deadlines prevent a quiet candidate from creating
a new agent turn on every scheduler tick.

A separate joint organization pass groups up to eight already-considered source
revisions into one maintenance cohort, with at most one active cohort. At least
two revisions that have never entered a cohort can advance their first joint
review without waiting for the routine cadence, sharing the Brain's budget.
Repeat reviews and a lone new revision paired with prior context use
`routineDelay` with a one-minute minimum. Only already-considered evidence is
eligible; this does not admit additional history. Owners and existing wikis are
retrieved as context. A settled decision or arrangement can justify a wiki even
when it creates no loop or brief. Cohort membership creates no dependency edges.

After the source and page frontier is settled, the agent records a version-fenced
organization outcome: actual wiki targets, a no-page decision, or a
missing-context deferral. The durable ledger stores bounded reason codes; richer
reasoning stays in the normal agent transcript. Unchanged completed inputs wait for
`maxReviewInterval`; deferred work waits for `routineDelay`, both with a
one-minute floor. Fresh evidence can form a new cohort with previously reviewed
context. Failed or stale cohorts do not advance the joint review ledger, and
private evidence is excluded and its retained cohort review metadata is purged.
These passes revisit admitted evidence; they do not grant historical consent.

Canonical loop, brief and annotation writes made during maintenance automatically
enroll affected owners for grounded synthesis review, even if the agent omits
explicit discovery targets. Persisted evidence determines their association;
unrelated owners receive a separate review.

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
- **Written** — output.

Cache reuse depends on the backend, model and prompt prefix. Compare the measured
fresh-input and cached-input counts when estimating cost against your provider's
pricing. The gateway does not assume a fixed cache share or output ratio.

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

**`brain.bootstrap.maxRunsPerDay`** — the daily historical admission cap.
In the maintenance engine this counts source-revision work seeds, which may
share a synthesis run. It is separate from the global agent-run budget.

**`brain.bootstrap.maxRuns`** — a lifetime backstop, counted across the whole
install and never reset, including across source removals. It is a spend
backstop rather than a per-corpus one: if removing a source refunded its runs,
delete-and-re-add would be a way around it.

If you need to turn the spend down, in order:

1. `brain.bootstrap.maxRunsPerDay` — the biggest lever by far.
2. `brain.bootstrap.activeHours` — shape it onto off-peak hours rather than
   reducing it.
3. `brain.knowledge.maxReviewsPerTick` and `brain.reverification.maxPerSweep` —
   bound proactive synthesis checks and legacy annotation rechecks.
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
no completed coverage: markers are scoped to input revision, work purpose and
policy. Resuming revisits changed inputs and explicitly deferred work.

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
- **`omnesis brain decisions`** — source-associated maintenance and other agent
  decisions, with their actual batch transcripts.

The Debug workspace separates Knowledge (Library, Briefs, Timeline),
Brain activity (Activity, Agent runs, Maintenance, Discovery, Calibration,
Legacy memory), System diagnostics, and Data tools. Existing deep links stay
valid. Maintenance owns the repair queue and batch frontier; Discovery owns
bootstrap coverage and history controls. Loops live in the Knowledge library,
with canonical state and expandable outcome details beside their synthesis.
Briefs retain their delivery inspector and link to synthesis when available.
Legacy memory keeps agent notes and the retired-loop recurrence ledger distinct
from the root overview.

The experimental Knowledge library reads the same canonical data used by
agent tools. Browse or filter the library, then open a page’s Overview,
Connections, History, or Advanced view. Inline claim spans open Connections
focused on that claim’s verification and relationships; clear the claim selection
to inspect the whole page. Page links and claim-specific references navigate to
their targets. Connections is the single relationship view, separating incoming
and outgoing evidence dependencies from organization links with bounded pagination. Source links explain the grounding; raw claim markup
and storage metadata remain in Advanced. Empty, pending, and unavailable states
are explicit rather than presented as verified understanding. Admin diagnostics include `/admin/brain/knowledge`, `/status`,
`/batches`, `/decisions`, `/:id`, `/:id/connections` and `/:id/history` under that prefix.
They show synthesis, claim provenance, maintenance progress and metadata-only
decision verdicts. Search projections are never the authority for these reads.

## Deterministic replay

The Brain Bench boots a real isolated gateway and substitutes model roles at
the production inference seams. The progressive scenario under
`evals/universes/sacha-bellamy/next-gen-brain/` supplies source arrivals, edits,
late history, contradictory evidence and privacy deletion. Its clock is
virtual; a scripted agent calls the real maintenance tools and scripted
decision, entailment and brief-judge services make the engine replayable.
These tests establish execution correctness, not model judgement quality.
