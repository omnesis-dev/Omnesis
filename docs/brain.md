# The Omnesis Brain — operating guide

The Brain maintains evidence-backed understanding: project and topic wikis,
tracked outcomes (loops), document and person annotations, a time index, and
observations for the morning brief. A compact **root wiki** provides current orientation to agent runs.
These records are synthesis, not independent evidence.

The answering agent can open indexed knowledge pages through its ordinary document
fetch tools, including `wiki:<pageId>` links. Reads include bounded claim evidence
pointers and separate navigation links, with document IDs that can be fetched for
verification. Unavailable or obsolete projections fall back to search. Restricted
source grants do not receive this context overlay.

A document annotation should add context established across sources or substantially
compress a long substantive document. Restating a short source, its title, or its
boilerplate does not earn another record. Useful compression can preserve material
outcomes while omitting routine detail; neither a second source nor every detail is
required. Material assessment periods, measurement bases and conditions remain
part of the relevant assertion. Source record and synthesis-maintenance timestamps
do not establish when a fact applied or make a historical estimate current. Person annotations describe useful person-specific context, such as roles,
relationships, preferences or standing responsibilities; a one-off event or message
summary merely involving someone belongs with its source or topic instead. One
explicit source can establish a useful person fact. Time-index entries serve separate
retrieval needs. Each active person profile defaults to 20 facts and 4000 characters,
configured by `brain.annotations.personProfile.maxFacts` and `maxCharacters`. Read
all `annotation_search` person pages before adding or changing facts. The agent
compares the whole profile, retaining useful facts and consolidating redundant
observations; it does not keep only the first page or append one note per source.
Meaningful person replacements and revisions pass a value check against the proposed
final profile and the predecessors they replace. Useful supported scope should survive;
explicitly removing trivial, duplicate or outdated detail is allowed. A rejected proposal
leaves the predecessor intact. Identical already-verified replacements return the existing
fact without adding history or spending another judgement. Profile read receipts bind
source versions as well as the live facts.
Explicit confidence-only revisions still re-verify standing evidence and refresh
verification timestamps; replaying unchanged prose does not request re-verification.

`annotate_person.supersedes` accepts one predecessor or an array for atomic
many-to-one replacement with evidence retained. Legacy oversized profiles can
shrink without first fitting the new budget. Synthesized person facts require all
supporting evidence; loss of one support invalidates the claim. The record check
evaluates document added value and person-profile placement using bounded source context; its ledger retains redacted context metadata rather
than additional copies of supporting source text. The check runs after drafting,
so its token benefit is downstream; the preflight discovery gate avoids whole runs.

The autonomous Brain is experimental and unstable. Enable
`OMNESIS_EXPERIMENTAL=1` and assign a reachable `background-agent` model to
start it. Either alone leaves autonomous work inactive. Settings labels this experimental role
**Brain agent**; its internal key remains `background-agent`. Chat and Tell Omnesis
notes instead share the ordinary `agent` assignment. Each note gets a separate
bounded session and needs no open chat. Assignments are never copied or used as
fallbacks for each other. Evidence invalidation
and privacy cleanup continue when autonomous synthesis is stopped.

## Owner note corrections

Tell Omnesis uses `agent`, independently of the Brain gate. An admin-authorized
text edit to an originally owner-captured note queues a durable revision. Identical
text queues nothing. A ten-second settling period coalesces unclaimed rapid edits;
a newer edit waits for the earlier claimed revision to settle. Each edit has its
own `note:<id>:revision:<n>` run identity. The system prompt carries previous and
current text, the exact changed span and the prior finished receipt as data, so
unchanged instructions are not new permission to repeat work. The current text
remains the owner's instruction. Changed relative dates use the trusted edit instant and
local day in the original capture's validated IANA time zone, including daylight
saving transitions; unchanged intent retains the original capture context.

The public edited entry is pending with no receipt until that revision finishes;
previous receipts remain internal context. Mutation admission checks the current
text, revision and claim at the writer boundary. An admitted older mutation may
still finish; superseded or retired handles cannot admit new work. If a prior
consequential action is uncertain or still in flight, the correction can read but
cannot perform consequential writes. Its receipt asks for review and a fresh,
separate request. Evidence/citation bookkeeping remains available. This is not an
exactly-once guarantee.

A changed-text edit by a non-admin writer atomically revokes pending work and
permanently clears the note's owner eligibility. A later admin edit cannot promote
that externally changed text; a fresh owner note is required. A same-text external
edit does not downgrade eligibility. Trusted edits while processing is disabled
preserve the last finished baseline, but are saved without later replay. Explicitly
editing an older owner note after enabling processing can act on the changed
intent. Deleting the note cascades its revision history.

Note turns share chat's memory-subject guidance and receive the current self-person
identity. Personal facts belong on that self profile; document context belongs on
the document. Without a self identity, the agent reports the fact as saved in the
note rather than claiming profile memory. Existing annotations are not backfilled.

## Note clarification conversations

A clear owner request blocked by ambiguity or missing information can deliberately
hand off to normal Agent chat with the Note-only `continue_in_chat` tool. It takes
a plain question and context, without choice-button arguments. Note turns omit
chat-only presentation tools and prompting; the subsequent reply uses the ordinary
chat prompt and tools. The original note remains saved. The note turn creates a durable conversation with a `note` origin carrying the note ID, revision
and run ID; the original request and assistant question remain visible. Only after
the conversation is saved does the completed note receipt expose `conversationId`.
The receipt links to the existing conversation route; clients never create a second
thread. A proactive conversation notification brings the owner back. Their reply
uses normal Agent tools with the preserved context. Ordinary actionable notes stay
asynchronous; they do not ask conversational follow-ups by default.

## Changes and maintenance

Source writes record a durable change and invalidate affected evidence without
calling a model. Invalidated claims remain visibly stale until maintenance.

A source deletion never deletes Brain artifacts; everything built on it goes
stale and is reviewed. A deletion is a change like an edit, whatever caused it:
a sync tombstone, a snapshot-absence sweep, a source removal, a retention pass
or an explicit delete. In the same transaction the document is tombstoned
(`knowledge_source_revisions.deleted=1`), so it can never be read or newly
cited again, and its own evidence passages, outcome assessments, unpublished
candidates and organization cohorts are removed. Knowledge derived from it is
never deleted or scrubbed: the bounded cascade walks only the direct,
non-navigational dependents of the source, as for an edit, marks the claims that
relied on it stale and the pages stale, and queues them for maintenance. Pages
that read a stale claim are stale in turn; pages that only link to it for
navigation are untouched, and retained history keeps its text. Maintenance then
reconciles each stale page with the model: it rewrites a claim against current
evidence, marks it unsupported, removes it with `node.claimRemovals`, or retires
the whole page with `knowledge_retire`.

The canonical owners built on the deleted document survive it the same way.
Each loses only its pointer to the document, which can never be read again, and
is marked stale in its own store:

- A loop, and so a task in the owner's journal, keeps its state, title and
  schedule. A ledger entry names the deleted document; the loop's
  `last_update` does not move.
- An observation keeps its summary, claims and state; its citation of the
  document goes.
- A document or person annotation keeps its claim. The evidence atoms citing
  the document break, a surviving atom is promoted into the mirror, and the
  annotation turns `unverified`, including one left with no live evidence or
  whose subject was the deleted document. Nothing is invalidated.
- A temporal annotation keeps its sentence, interval and link to the document;
  its atoms citing the document break. It is reviewed through the loops it is
  linked to; one linked to no loop stays, ungrounded, until a deliberate update
  or delete.

Each surviving loop, observation and annotation, and each loop a temporal
annotation is linked to, is queued as a `review` owner change. The queue is
durable: it waits however long the Brain is off. Owner sync then projects the
owner without the deleted source (an owner whose every source is gone becomes
unsupported text), marks its node stale and queues it for maintenance like a
stale page. A later update to the owner never downgrades the pending review.
Only a reviewed decision may then change or remove the artifact: a canonical
update, `open_loop_delete`, `observation_withdraw`, an annotation revise,
supersede or retract, or a `temporal_annotation_update` or delete. An
annotation turned `unverified` is also re-judged by the re-verification sweep.
An annotation whose evidence document is gone is never served as a prior, but
`annotation_search` lists it marked `underReview` (for a person, apart from the
readable profile), even when its subject document was deleted, so the review
can revise or retract it.

`knowledge_retire` is the Brain's only way to take a wiki page out of service,
and it is a deliberate, reviewed act: it requires this run's
`knowledge_fetch({id, editing:true})` read at `expectedRevision` and a specific
reason, and is granted exactly where `knowledge_save` is. The page is withdrawn,
not deleted: the reason is stored on the retired revision, the whole history is
kept, the page leaves search, the page directory and maintenance, it can no
longer be cited or edited, and every page that read it is invalidated for
review. The root is never retired. Each retirement logs one content-free line,
`Wiki retired via knowledge_retire on <id>: rN→rM`.

Only the deletion of a canonical owner record (a loop, observation or
annotation) erases a knowledge node: that owner's own node, its history and
the owner records attached to it, such as the observations of a deleted loop.
That deletion is always the owner's own reviewed decision or the user's, never
a consequence of a source deletion. Its dependents, including wiki pages, are
invalidated, never deleted.

Maintenance assignments distinguish affected-claim repair from whole-page
curation (`review=true`), root orientation and evidence organization. Wiki curation carries an explicit
`wiki_curation` frontier goal and a node-specific editorial task, including when
review is adopted by an organization batch. Read the whole page for context;
a compact frontier still bounds which claims may be settled. A page
review considers useful subject context and consequential later developments;
root work selects relevant context and navigation from the current library.
These are model goals, not additional completion guarantees. A run may note an
observation for the morning brief when it finds something the owner would act
on; noting one follows the maintenance assignment and never replaces it.
A wiki may synthesize grounded context from canonical owners and evidence;
it does not become another operational owner of their state.

The `decision` role scores urgency, discovery relevance, dependency impact and
proactive review. Its ordered-level answers are normalized to 0–1. Missing or
invalid judgements take the conservative path; they do not establish that
content is irrelevant or verified. Maintenance tiers are configurable under
`brain.knowledge`:

| Setting                | Default | Purpose                                        |
| ---------------------- | ------- | ---------------------------------------------- |
| `immediateThreshold`   | 0.8     | Immediate repair threshold                     |
| `soonThreshold`        | 0.4     | Hourly repair threshold                        |
| `soonDelay`            | `1h`    | Delay for soon work                            |
| `routineDelay`         | `6h`    | Delay for routine work                         |
| `rootMaxChars`         | 8000    | Hard limit for the root wiki                   |
| `maxSeeds`             | 64      | Admission bound per maintenance pass           |
| `maxFrontierNodes`     | 32      | Maximum offered frontier size                  |
| `maxFrontierChars`     | 65536   | Maximum JSON characters per frontier response  |
| `maxVisitedPerSeed`    | 256     | Bounded affected-region traversal              |
| `retryBackoff`         | `1h`    | First delay after a failed batch attempt       |
| `retryBackoffCap`      | `1d`    | Longest delay between those retries            |
| `maxFailedAttempts`    | 5       | Failed attempts before work is parked          |
| `contextHandoffRatio`  | 0.65    | Share of a reported context window a run fills |
| `contextHandoffTokens` | 120000  | Handoff input size when no window is reported  |
| `maxStalledHandoffs`   | 2       | Context handoffs in a row without progress     |

Evidence changes whose potentially affected regions overlap share a batch;
disjoint regions can remain separate. The root is a separately coordinated
aggregate so a shared overview does not join every project into one batch. A run that discovers an
existing canonical target reserves its affected region before verification or mutation.
If another run owns that region, it releases its own reservations and returns current
inputs to the planner, which can coalesce the newly discovered overlap. That handoff
ends the current model turn; it does not repeatedly retry an already contested write.
Routing hints carry source revisions and do not become factual support links.

A synthesis run asks `knowledge_next_frontier` for work. The engine checks input
versions, runs relevance gates, and offers the next breadth-first frontier.
The agent writes through validated tools; the engine records changed,
unchanged, skipped or deferred outcomes. Only material changes expand repair
into dependents. Concurrent edits invalidate an obsolete proposal rather than
letting it overwrite a newer revision. Interrupted work remains durable.
The first frontier is gated before starting the agent: a fully skipped batch
does not consume a synthesis turn. Discovery checks judge bounded source content once;
work with existing repair or discovery obligations bypasses this skip decision.
Sources too large to judge in full also retain the interpretation path. Skipped
history remains eligible for bounded reconsideration during organization.

A batch completes only when its whole frontier settles. When its run exhausts
its attempts first, or the batch is interrupted, the batch is abandoned but what
it finished stays finished. A work item whose own frontier settled, with no
frontier item of its own and no candidate decision still open, completes;
dependents its settlement expanded to, including pages a source selected as
discovery targets, become ordinary `change` work of their own. A selected page
keeps its exemption from the impact gate until it next changes. (Past 64 such dependents, every seed is retried
whole instead.) Everything else is queued again at its current input revision.

A run that dies on every attempt — the process ends mid-run each time, so no
attempt settles it — stays `pending` at the drainer's attempts cap, where it can
never be claimed again. Once its last claim is an hour old and it is not
executing in this process, the maintenance tick settles it as failed and
abandons its batch as for any failed run, so its region is free again.

Only a failed run charges a failure, and only to work it was offered or settled
without finishing; work the batch never reached is requeued as it was. Charged
work waits `retryBackoff`, doubling per further failure up to `retryBackoffCap`,
and is then planned in a batch of its own: it never joins or is adopted into
another batch, so an input one run cannot finish no longer holds its neighbours
open. While that retry is queued, or the work is parked, other batches do not
append the same page as a dependent. When a run retries a batch, inputs not yet
offered are offered before ones an earlier attempt was offered and left. At `maxFailedAttempts` the work is parked instead of requeued. Parked work
is not admitted again for the same obligation and input revision — not by the
planner, discovery intake, joint organization or review scheduling — until its
source document or page reaches a new revision, which is ordinary fresh work.
The root aggregate is never parked; it keeps retrying at the capped delay.
`GET /admin/brain/knowledge/status` reports parked work grouped by subject kind,
reason and tier; `GET /admin/brain/knowledge/pending-work?readiness=parked` with
that reason and tier lists it. Bootstrap admission and inventory coverage count
parked revisions separately.

New evidence needs discovery even when no dependency points to it yet. The
agent searches established context, adds evidence to existing synthesis, or
proposes a scoped page candidate. A source does not require its own page.
Agent transcripts are excluded from automatic source discovery. When explicitly
cited as evidence, their edits and deletion invalidate existing dependents for
repair, like any other source.
Newly arriving historical evidence is considered without treating its events
as new commitments or allowing an old proposal to overwrite an accepted plan.

## Pages state a subject, not a log

A wiki page states the current understanding of one subject: what it is, how it
stands now, its recurring patterns and its material exceptions. Individual
events stay in their sources and the time index, and a page's earlier states
stay in its revisions, so a page is never a chronological log of either.

Automated status streams (build and deployment results, monitoring and uptime
alerts, shipping updates, account, billing and transaction alerts) record
events about a subject. Most of their notifications change nothing durable and
leave every page unchanged. One that does change the understanding of its
subject updates the page's current-state passage in place, with the change kept
as a dated sentence in the section about that aspect. The same holds for a
source discovery that names an existing page as its target and for a joint
organization pass, whose cohort is a window of evidence interpreted around the
same time, not a subject: no section is named for a date, a batch or a cohort.

Most of such a stream never reaches a page. The discovery worth gate (the
`decision` role's `discovery` question) scores a machine-generated status
notification that only reports another routine outcome of its kind (another
failed or passing run, another delivery scan, another ordinary charge) at its
lowest level, even when it names the owner's project, account, order or card.
Such a source is gated before any agent turn: its coverage is `gated`, no run
interprets it, and no page is offered for maintenance because of it. Its
judgement is still recorded in the decision ledger. A notification that changes
the state of something the owner tracks or depends on (a first or new kind of
failure, a changed cause, a recovery after a sustained problem, a lost or held
parcel, an unusual or disputed transaction, an access or security change) is
interpreted as before. A run that does interpret a source names an existing
page as a discovery target only when the source changes what the page should
state, because a target makes the whole page due for maintenance.

Organization cohorts regroup evidence that was interpreted earlier, often
under an older version of that rubric. Before a chronological or subject cohort
starts, each member without a `discovery` verdict under the current rubric (for
its current content) is judged once through the same gate, and the verdict is
recorded in the decision ledger like any other; a recorded current verdict is
reused. A member judged low is withdrawn from organization: its organization
coverage turns `gated`, so no cohort selects it again at that revision, while
its interpretation and anything built on it stay as they are. The pass logs one
content-free line, `Organization cohort screened: <kind>, N of M source(s)
withdrawn as low worth`, and starts the cohort with the remaining members, or
none when fewer than two remain. Without a decision model, or once the budget is
spent, members are kept. A publication retry is not screened. The organization
guidance settles members that only repeat what a page already records without
naming that page as a target, since saving it unchanged still spends a revision.

Two save-time checks hold this deterministically, before any paid check, on
both `knowledge_save` and `knowledge_edit`:

- A save that adds a date-named section to an existing page is refused when the
  page would then have at least four date-named sections making up most of its
  sections. A save that keeps or lowers that number (an in-place update, a
  consolidation) always passes, as does a new page.
- A new or changed title of four or more words that repeats the title of a
  document the page cites (by word-set similarity of at least 0.8) is refused.
  A page is named for its subject (a person, place, organization, system,
  account, project, arrangement or event), not for a message's subject line, an
  issue or ticket title or a notification headline. Shorter titles are names in
  their own right and are never compared, and an unchanged title is never
  re-checked.

No existing page is rewritten or retired from code. A page that already reads
as a log (at least four date-named sections, most of its sections), or that a
refused save would have turned into one, gets one immediate whole-page review,
the first time a maintenance pass or a save touches it. The request is recorded
on the page (`metadata.reviewRequests.log_curation`), so no later pass
queues it again, and logs one content-free line, `Wiki <id> queued for review:
…`. That review can consolidate the dated sections into the subject's current
state, or retire the page with `knowledge_retire`. Its curation task for such a
page steers a record of routine notifications with no durable state beyond them
to retirement with a reason. Otherwise it asks for a short account of the
subject's current state built over several saves, since one save may remove at
most half of a page's claims: a review save that leaves the page a log with
fewer date-named sections queues the next review, so consolidation continues
until the page no longer reads as a log, and ends because that number falls
each time.

## Excluded sources

`brain.excludedSources` names sources the Brain never processes. An entry is a
bare source type (`codex`), covering every source of that type, or an exact
source id (`github:someone`), covering one source; matching follows
`sourceIdAddresses`, so a type never matches another type that merely shares its
prefix. Entries are validated for syntax only, so a type can be excluded before
any source of it is installed. Every consumer reads the list live
(`brain/source-exclusion.ts`), so a change applies on the next tick or tool call.

- **Admission.** The engine reads an excluded document as absent: intake
  acknowledges its journal entries without enqueuing work, recent-inventory and
  historical admission skip its source, organization cohorts never select it,
  the daily batch enqueuer skips it, and the waker ignores it. Each maintenance
  tick withdraws pending source work for excluded documents, whatever admitted
  it, after every admission step and before planning, without settling
  coverage, so historical review can admit them once the exclusion is removed.
  Organization revisits skip evidence from excluded sources, and the planner's
  urgency judgement never reads one. A frontier item already batched settles as unchanged without a model
  turn. A queued datum, bootstrap or daily run for an excluded subject completes
  in preflight without a model call.
- **Reading.** A background run's read ports are wrapped
  (`brain/steward/source-fence.ts`): search drops excluded hits, their
  breadcrumbs and any graph-context provenance that touches one, a fetch or URL lookup of an excluded document reads as
  not found, connection traces, time-index results and entity context omit
  excluded documents and sources, and `run_sql` is scoped to the tables of the
  remaining sources, as for a source-restricted grant. The temporal reads that
  build run prompts (datum projections, nearby timeline, digest horizon) are
  fenced the same way; the datum neighbourhood, the morning brief's citations and
  maintenance seeds exclude them.
- **Citation.** Every tool call of a background run is refused with
  `excluded_source` when its arguments name an excluded document, as an id, a
  list entry, an object key or a `source:<id>` reference in text; arguments too
  large or deep to check are refused too. No new loop, annotation, temporal
  annotation or page claim can rest on one. A `knowledge_save` or
  `knowledge_edit` may carry a claim that already cites an excluded document
  through unchanged — the same text, references and claim state as the
  revision it names; the resulting page is compared claim by claim, so a new or
  changed claim citing one is refused even when the call never names the
  document, before the verifier could read it. The save never shows the
  verifier a claim whose supporting references include an excluded document:
  it keeps its verification only while its stored one still holds, and is
  otherwise saved unverified, unexamined (`knowledge/service.ts`).
- **Maintenance.** A run cannot re-check a claim that cites an excluded
  document, and that is not evidence against the claim. While none of the
  claim's own references changed, maintenance does not offer it for review: the
  engine settles its outcome as `skipped` (not examined, never verified) before
  offering the page (`knowledge/unreadable-support.ts`), and the run keeps it
  unchanged when it saves the page. A claim whose own reference changed or was
  deleted is still offered, because a real change is the Brain's to judge.
  The wiki value and factual-repair judgement a page save asks for is not shown
  an excluded reference's text, only counted among omitted references. An
  outcome judgement (a loop's creation, update or synthesis save) is judged on
  its readable linked documents only; with none left it has no source context
  and is recorded unavailable without a model call, as for missing evidence. The
  morning recheck does not show the salience gate an excluded citation, and an
  observation citing one ships with its claims unchecked rather than going to
  the verifier.

The interactive agent and its own memory tools are unaffected. Existing
knowledge derived from an excluded source is kept and stays visible to Brain
runs as knowledge (annotation evidence quotes, loop document ids, page claims);
its doc and person annotations are skipped by the re-verification sweep. Source edits and deletions still invalidate
dependent knowledge as usual. Journal entries acknowledged while a source was
excluded are not replayed; historical review within `brain.bootstrap.horizon`
admits those documents once the exclusion is removed. Bootstrap status reports
the active list as `excludedSources`, the discovery timeline counts unreviewed
excluded documents as `excluded`, and inventory status reports an `excluded`
window, none of which reads as pending.

## Claims and context

Wikis, root text, loop descriptions and annotations use Markdown with
addressable claim spans:

```html
<claim id="setup" refs="source:document-id#evidence:passage-id">Setup is at 08:00.</claim>
```

Wiki/root writes refuse malformed heading starts such as `<## Heading` with
actionable feedback before paid verification. Use ordinary `## Heading` inside
claim tags; literal examples remain valid in code, block quotes, or escaped text.
Existing stored text is not silently rewritten.

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
and revision history remain inspectable. Full wiki and loop reads include bounded
claim-to-reference groups when a readable current projection exists, with source
titles, source dates, observed dependency versions and current versions. Claim
state includes modality, attribution, epistemic status, validity dates and support
logic. Verification distinguishes literal claim support from page-context support;
a stale page conservatively marks its claim support stale. References in one
group follow its all/any support logic; they do not assign individual phrases to
individual sources. This context helps select evidence without reconstructing an
entire page, and does not independently verify its claims. Exact-ID loop reads
retain done/dismissed status and history while list/search return active loops;
erased or physically deleted owners remain unavailable. The mutation boundary parses markup,
checks references and versions, and invokes the entailment verifier on changed
claims. For wiki and root claims, verification also checks attribution implied by
page title, section headings and enclosing claims. Moving unchanged words to a
different scope requires fresh verification and changes the claim's meaning
version; old literal-only proofs do not verify this placement. Exact-claim
references preserve that scope when used as support; a nested claim cannot supply
verified downstream evidence while an enclosing claim lacks current contextual
proof. Enclosing support and semantic state are dependencies too: changes to an
ancestor's evidence, attribution or modality invalidate affected descendants and
their consumers. Independent assertions should be sibling claims when neither
supplies the other's context. Context is not an independent source of additional facts. Generic organizational
headings do not make explicitly historical statements current. Oversized placement
context is refused rather than silently truncated. An unavailable verifier leaves a claim unverified.
Contextual judge calls require separate content-in-context and placement assessments.
Positive proof requires source-exact witnesses; a valid unsupported assessment refuses
support without requiring a quote proving absence. Missing or malformed assessments
cannot establish verified support. MiniCheck cannot check this contextual protocol
and reports unavailable before inference; ordinary literal MiniCheck checks are unchanged.
Contextual calls request up to 2048 output tokens and record usage even for invalid replies.
The verifier only asks whether a claim's own citations entail it, so a page can
repeat a figure its source got wrong even when an annotation on another document
records the correction. Before a wiki's changed or reviewed claims are saved, each
claim is searched against the knowledge mirrors; current annotations and pages that
share at least three distinctive terms with it, rest on a document the draft does
not cite, and that the run has neither read nor written are returned in a one-time
refusal per page per run, so the run states the corrected fact or keeps a claim
nothing bears on. The check is advisory and saves without it when search fails;
it sees a record once the record's mirror has been indexed.
The library read is paged, so a run can miss the current page that already
covers a new page's subject. Before a new wiki is published, its title, scope and
leading claims are searched the same way; any of the three closest current pages
that `creationAssessment.relatedPageIds` does not name is returned in a refusal.
The run reads them and either enriches one and settles the candidate as `merged`,
or names them with a reason the new scope is distinct and saves again. Naming a
page still requires reading it, and the check is skipped when search fails.
After an annotation is created or revised, current pages that share its matter and
do not cite it have their next review brought forward through the ordinary review
gate, and the write's result names them; in a source discovery the run can target
a page the annotation corrects for repair in the same batch.
Knowledge source revisions cover body changes and source title/date changes, including
changes that later return to an earlier value. Body content hashes still identify exact
quotes and deduplicated content; they are separate from dependency revisions. Source
references expose both values. Existing tracked sources receive one invalidation when
upgrading from body-only revisions; normal maintenance repairs their dependent claims.
Verification records a model judgment, not a guarantee of factual correctness.
Document and person annotation hints include the owner's recorded verification
state; a missing recorded state is exposed conservatively as unverified.
Well-formed markup
is not proof of factual completeness; untagged prose does not inherit verified
status from neighboring claims. Synthesis mutation tools require every nonblank
text span, including headings, to be inside a claim tag. This structural
coverage check is separate from entailment; migrated legacy owner text remains
explicitly unverified until repaired.

A wiki supplies context; a loop tracks an outcome. Organizational links can
express project membership, page hierarchy and separately trackable subloops.
They do not imply evidential support. Operational blocking and completion stay
in the loop's canonical fields. Closing or retiring a loop preserves its useful
history; deleting its evidence invalidates it for review like any other change.

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
change propagation can remain focused on affected claims. Numeric review signals compare the current wiki with its last persisted whole-review snapshot. Doubling its claim count or plain-text length makes it eligible for a review-timing judgment after the existing `routineDelay`, even if individual claim verification is recent. The gate can still defer or leave it dormant up to the existing maximum-interval backstop; its recorded decision suppresses repeated unchanged-growth judgments on subsequent ticks. This signal nominates consolidation, not a guarantee that a rewrite is needed. A review that completes with a claim still unverified leaves the node due, but each further such review since its last fully verified review doubles the wait before the next one, from `soonDelay` up to `maxReviewInterval`, so a claim the verifier cannot confirm does not buy a model turn every hour. Accurate older text
does not by itself establish that a page includes the relevant developments.
Reviews reconcile earlier requests with available later replies and both open
and completed outcomes. Durable decisions retain their attribution and material
qualifications; several messages about one matter need not become separate
sections. Time-sensitive passages identify the event and date anchoring a
relative window, or explicitly retain an unknown anchor. The date on a document
does not establish the date of an event it discusses.
Routine notifications remain available through the time index; a wiki selects
durable context and material exceptions rather than copying an activity log.
A change to part of an existing wiki or root page goes through `knowledge_edit`
rather than a full `knowledge_save`: the model sends an ordered list of
`replace_section`, `insert_section`, `delete_section` or `replace_text` edits,
and the gateway splices them into the tagged Markdown of the run's own
`knowledge_fetch({id, editing:true})` read at `node.expectedRevision`
(`wiki-edit.ts`). A section runs from its heading to the next heading of the
same or a higher level and carries the claim tags that open just before its
heading; a section edge that falls inside any other claim, a missing or
ambiguous heading, and replacement text that does not occur exactly once are
refused as tool errors before anything is saved. The spliced page is then one
full replacement, so every check below — claim preservation, dependency
versions, navigation, value, outcome and frontier — applies unchanged, and the
result names only the new revision and the sections changed. Each wiki or root
write logs one content-free line, `Wiki write via knowledge_edit[<ops>] on <id>:
rN→rM, <before>→<after> chars` or `Wiki write via knowledge_save on <id>: …`,
and each edit refused by the edit or save checks logs `Wiki edit refused on <id> (<code>): <ops>`, so the
share of targeted edits can be read from the gateway log.
Model-authored wiki and root replacements preserve existing claim identities
unless `node.claimRemovals` explicitly names each omitted claim and its reason.
`reviewedClaimIds` records review, not deletion permission. The writer rechecks
removal intent and records it in the revision diff. Empty wiki replacements are
refused. One save, `knowledge_edit` included, cannot gut a page: it is refused,
saving nothing, when it removes more than half of the page's claims and at least
three, when it retitles the page while removing most of its claims (two or
more), or when one removal reason covers more than two claims. Removing one or
two claims, or two of a three-claim page under its title, stays an ordinary
edit. The refusal comes before any paid check and names the paths that remain:
keep claims that cannot be re-checked and leave their review pending, retire a
page that no longer stands with `knowledge_retire`, or remove claims a few at a
time, each for its own reason. Being unable to re-check a claim in a run is
never a reason to remove it. `curationDeferral` defers only the editorial
obligation of a whole-page review (`review=true`); claim repair cannot be
deferred, and its refusal says so.
Each offered page lists `pendingClaimIds`; a save settles the claims it
changes or names in `reviewedClaimIds`, and the rest stay pending and are
offered again in the same batch. A pending claim the save carried through with
unchanged dependency versions keeps its verification state, so editing one claim
never makes the page or its untouched claims stale. A pending claim whose
recorded versions the save moved (because the run read a newer version of a
reference it shares) is marked stale until it is reviewed: a new version map is
not a review. These checks prevent accidental omission, not semantic loss within a
retained claim; content quality still requires review. Root replacements also acknowledge
removed readable wiki navigation with `node.navigationRemovals` entries naming
the target and a bounded local reason. This applies even when claim IDs survive.
Retained links need no entry; unavailable targets are exempt. The same privacy
and revision checks run before verification and again in the writer transaction.
The run transcript records intent, not a semantic relevance verdict. No page or
link quota is imposed, and existing missing links are not restored automatically. New links to synthesis pages in wiki or root Markdown must exist, be readable
and match their declared kind. Unchanged legacy dangling targets do not block unrelated repairs. These
checks cover Markdown links, not raw HTML links, and grant no evidence support
or mutation authority. Ordinary repairs use the revision actually read for that
page, so unrelated wiki edits do not invalidate the repair. Same-page changes
and cited evidence changes still conflict; new-page publication and candidate
decisions retain library-wide reconciliation checks.
The read-only `knowledge_history` tool exposes bounded revision metadata and
explicitly chunked snapshots through the same privacy fence as current pages.
History is untrusted previous belief, not current support or mutation authority.
Recovery follows meaningful revision changes and reads relevant snapshots, then
checks current evidence and later outcomes before restoring warranted claims.
Revalidating the surviving claims alone does not resolve an earlier loss.
Historical records can remain alongside dated later outcomes; a finding mentioned
only in a run summary is not retained page context. Snapshots supply neither
current dependency versions nor read receipts. Exact evidence references supply
only their quoted spans; attribution, dates and headings need supporting context
in those spans or another cited source reference.

The root wiki is the compact overview and entry point to relevant detail pages.
It links to existing wikis instead of reproducing their full contents.
Every write must fit `rootMaxChars`. It is injected as untrusted reference
context; reading it does not create an automatic dependency on every claim.
Injection preserves a bounded, deduplicated `relatedPages` navigation list from
its readable wiki support references, because claim tags are stripped from the
text. Navigation uses only remaining context space; a full root is retained even
when there is no room for this extra list. Related pages are navigation, not
proof, and must be opened before use.
When a root summary derives from a wiki, exact `wiki:<id>#claim:<id>` support
references connect it to the claims it summarizes. Navigation alone does not
invalidate that summary when the destination changes.
Once readable synthesis exists, the initial empty root receives bounded
scheduling preference over ordinary synthesis, below reactive work. Initial
orientation bypasses the impact gate; subsequent updates use normal maintenance.
Every offered root uses the `root_orientation` goal, even when `review=false`: it
reassesses useful current context across a bounded selection of pages and outcomes,
rather than merely revalidating the claims already present. An unchanged summary
remains valid when that investigation finds no warranted change.
Publishing a new wiki schedules populated-root orientation at the configured
`soon` delay; ordinary page edits use the routine delay. Multiple publications
coalesce without moving an already scheduled refresh later.

## Bootstrap and upgrade

Source maintenance frontiers expose `completionRequirements.requiredPhases` for
the current source generation and discovery policy, including compact offers.
These are review obligations, not automatic attestations: review each missing
phase before completing the source. Interpretation and organization are required;
conversion is optional. Existing current coverage can satisfy a phase, while
expired coverage must be reconsidered. An offered source with no missing phases accepts
`phases: []`, without rewriting coverage; full-source read, current-version and
dependent-repair obligations still apply. Final writer validation remains authoritative.

Schema migration preserves existing loop states, annotations and available
provenance. Legacy attachments become explicitly unverified context, not
verified claims. Existing notes remain available while the root acquires
grounded understanding. Conversion and page organization have separate
coverage, keyed by source revision and policy version.
Source discovery can settle only after both interpretation and organization are
considered for the current revision and policy; conversion remains optional.
A truncated source preview is not a full read. The maintenance tool boundary
requires a full-content read for that exact generation before accepting
considered coverage. An organization cohort is an admission window, not a
proposed topic: the agent investigates coherent subsets and related existing
context before deciding whether a useful page is warranted.

Historical organization is opt-in: use **Cognition → Bootstrap → Start reading
history**. Assigning a model does not grant an unlimited historical reread.
Existing `brain.bootstrap` enablement, ordering, active hours, backlog and
admission caps apply. The default order is recent-first; older evidence remains
eligible even without a future date.
Historical notices establish what happened then; missing follow-up evidence does
not establish a current obligation or prove that an outcome is still unresolved.
Displayed factual premises need grounding even when they accompany advice.
Historical review reaches back `brain.bootstrap.horizon` (default `90d`),
measured from now against each document's own `source_created_at`, never its
ingestion time — on an upgraded install every document was ingested recently.
Older documents are not admitted by the historical pass or by an initial
import's recent inventory; ordinary arrivals and edits stay reactive whatever
their date, and agents still reach old documents through search. The floor is
recomputed every pass, so a raised horizon takes effect without a restart. Each
pass also withdraws pending (not yet batched) `discovery`/`upgrade` work whose
document is now beyond the floor, without refunding admission caps; batched
work finishes. Bootstrap status reports the floor as `horizon.notBefore`; the
coverage timeline counts unreviewed documents before it as `outOfScope` and
inventory status as a `beyond-horizon` window, so neither reads as a backlog
that never drains.
Admission fills the available batch allowance in rounds across sources, preserving
the configured chronological order within each source. A prolific source can use
capacity left by exhausted sources. Admitted history is due immediately at routine
priority on both fresh and upgraded databases; the routine edit-coalescing delay
does not postpone an explicitly authorized first pass. A bounded historical slot
keeps continuous live arrivals from starving authorized backfill. A source whose
historical or recent-inventory scan finds nothing left to admit rests for thirty
minutes before that lane scans it again, so an idle engine does not reread every
covered document on each tick; a later page of the source's initial inventory, or
a changed horizon, recent window or exclusion list, ends the rest at once.

Initial collector enumerations carry a durable inventory identity through the
generic cursor-page protocol. Partial pages and collector restarts keep that
identity; the final cursor commit marks that inventory complete. New document
revisions in an inventory enter fair recent-first admission. The configurable
`brain.knowledge.recentWindowDays` window (default 30) is measured against that
inventory's first receipt at the gateway, retained across retries and independent
of the collector's clock. Recent inventory is eligible immediately at routine priority,
without the routine delay; readiness does not make historical catch-up urgent.
Existing queued work keeps its assigned tier. Recent inventory shares the live cognition budget; older and
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
Use the run-bound `knowledge_maintenance_inputs` tool to page omitted versions
once per fingerprint, including uncited context. Repeated paging is unnecessary
while assembling a save against that same fingerprint.
Newly discovered source inputs remain available across continuation turns even
before a page cites them. They are context to inspect, not automatic support;
the agent must fetch their content and establish claim dependencies explicitly.

The model-facing `knowledge_save` can omit `node.inputVersions`. A complete actual
editing read retains an immutable run-local snapshot of stored dependency
versions for unchanged claim trees and semantic state. Successful
`knowledge_reference` reads supply versions for new or edited claim uses. A complete
`knowledge_fetch` also records the returned node and claim meaning versions for
synthesis support, in either reading mode. It does not grant reads of the original
sources cited by that page; inventory lists, history and truncated reads do not
grant these receipts. Explicit version overrides are never silently refreshed. A
shared ref used by an edited claim cannot inherit solely from an unchanged
neighbor. Explicit overrides still take precedence, including stale values that
must fail. The engine never fills missing evidence versions by silently reading
the latest database state. Bounded receipts expire with the run; eviction or a
new revision requires another actual read. Other scoped synthesis tools retain
their explicit version contract. This removes version transcription, not source
inspection, verification, privacy checks or explicit claim-review coverage.

A complete editing read can also supply an omitted canonical `ownerId` when the
proposed node's ID, kind and expected revision exactly match that read. Explicit
null or different owner values remain errors; no database refresh repairs them.

A maintenance save may omit `inputFingerprint` only after this run received that
node’s frontier offer and then a complete `knowledge_fetch(editing:true)` at the
proposed revision. The bounded read receipt retains the offered authority; it never
refreshes it from database state. Explicit wrong or blank values still fail. A
changed offer, privacy generation or owner revision requires fresh frontier and
editing reads; preflight and atomic writer checks remain in force.

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

Legacy loops, observations and annotations convert into knowledge nodes through
a bounded sweep. A conversion keeps the sources that are still readable
evidence, ignores generated mirror documents it cites, and drops deleted or
removed ones; an owner whose every source is gone converts as unsupported text.
An owner the sweep cannot convert (it is hidden, or it cites too many sources)
is set aside with its reason and an input fingerprint. The sweep skips it until that fingerprint changes or a backed-off
retry comes due: minutes for a write race, hours to a week for an input refusal.
`conversionProgress` in bootstrap status and `conversion` in
`/admin/brain/knowledge/status` count converted owners and set-aside owners by
reason, and each sweep pass that converts or sets aside an owner logs one line.

The run queue uses four maintenance workers by default (`brain.workerConcurrency`,
maximum 32; a larger configured value runs as 32). Only maintenance tied to a live batch with reserved regions can
execute in parallel; root aggregation and legacy runs, including daily reviews
and the morning brief run, execute exclusively. Freed slots refill while siblings run. Each
drain renews admission rounds of four times the worker count, yielding to the
event loop between rounds and rechecking the feature gate, daily budget and
provider breaker before each claim. Scheduler yield, abort or the invocation
time budget stops new admissions; a slow sibling alone does not prevent refill.
Active runs finish or abort before the scheduler invocation returns;
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

The same continuation bounds a maintenance run's context. Every model request
reports its input size, and a run whose latest request reaches its budget ends once
that response's tool calls finish. The in-process backends (Anthropic,
OpenAI-compatible HTTP and Responses) then send no further request. Codex and
Claude Code run their own tool loop and may already have sent one, or report the
size after the tools ran and stop a response later; the remaining share of the
window absorbs that. The budget is `contextHandoffRatio` of the input limit the backend
reports (Codex reports the model's window; Anthropic, Responses and configured HTTP
limits come from the model registry), or `contextHandoffTokens` when none is
reported, as with Claude Code. A provider refusing a
request as too long for the window ends the run the same way instead of failing
it. Either handoff continues after settled progress, and up to
`maxStalledHandoffs` consecutive times without it, because a fresh context can
succeed where a full one could not; past that the ordinary failure policy applies.
The run record keeps the handoff reason (`tool_iteration_cap`, `context_budget` or
`context_window_exceeded`) and its context occupancy: the largest and the latest
request input and the reported window. `/admin/brain/runs` serves both;
`omnesis brain run` prints the peak and latest input, the window and the reason; and the gateway logs one line per context handoff.

Document reads are bounded the same way. A Brain run's `fetch_many` returns at most
`brain.documentReadChars` characters (default 16384) of each body unless the call
names a range; a longer body comes back with `contentRange.truncated` and
`contentRange.nextOffset`, and the run reads on by fetching again from that offset.
Paged reads of one revision combine into a complete read for discovery coverage.
Interactive reads are unchanged.
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
read. Only the latest query supplies the active scope, and it must be complete; separate queries
are not combined. Read then mutate within that scope, or use one complete
document-filtered window for a batch. Annotation `until` is inclusive, whereas
query `to` is exclusive: the query must extend beyond the final included instant
or day. Creation and updates require a complete annotation-inclusive query whose resolved
time window contains the whole proposed interval and whose subject/kind filters
match the resulting record. Narrow a truncated query; a later cursor page alone
does not provide reconciliation authority. Moving an annotation requires a query
covering the existing target and its destination. The writer rechecks the actual
stored links inside its transaction; dropped or unresolved links cannot confer
authority. Complete queries explicitly scoped to 1–16 source documents, without a source-ID filter, retain
monotone receipts for those documents, so unrelated document work can commit
without invalidating the read. Changes to linked annotations, their subjects or
evidence invalidate the relevant receipts, including deletion and recreation.
Source identity, source revision and readability remain fenced. Other queries
retain the global collection receipt; oversized legacy annotation fanout and
document erasure conservatively invalidate all document receipts. These structural checks do not
prove semantic duplication, and `force` never bypasses them.

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

Archived loops and retired or superseded annotations preserve their historical prose rather
than undergoing routine rewriting. Evidence changes still invalidate their
support and propagate support loss to dependent durable synthesis, deletion
included. Canonical historical owner work settles
before a model turn, with lifecycle and revision checked again in the writer transaction;
dependent synthesis still receives support-loss maintenance. A loop is historical only after
its active record has been removed and an archived record exists; a retained active
loop remains editable even when its state is done or dismissed.

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
when it creates no loop. Enrich an existing reusable topic or project
before creating a separate page. New wiki publication requires actual current
claim-support paths to at least two source documents with distinct content
hashes; declared candidate evidence, context references and identical copies
do not satisfy that floor. Single-document compression belongs in a useful
document annotation or an unpublished candidate. The source floor applies to
publication, not existing-page repairs or the compact root, and does not prove
coherent synthesis by itself. Cohort membership creates no dependency edges.

Chronological cohorts group whatever was considered together, so a matter
whose evidence arrives over months may never meet in one. A **subject cohort**
groups instead the interpreted evidence of an important tracked outcome no wiki
covers yet: an outcome with importance of at least 0.6, open or completed and
updated within 120 days, none of whose documents or loop record a wiki claim
cites. Such outcomes join one subject when they share a document or a person
on at most six outcomes (the owner, and people on many outcomes, would merge
unrelated matters); subjects rank by the summed importance of their outcomes.
The frontier's organization metadata then names the leading outcome as
`subject.loopRef`, and the agent decides whether the enduring matter behind it
deserves a page, belongs in an existing one, or yields no page. Subject cohorts
are paced at most one per `soonDelay` (minimum one minute), are retried per
subject after `maxReviewInterval`, and use only evidence already considered,
so they never admit additional history. Every uncovered subject is judged on
each pass, so subjects waiting their retry or lacking two considered documents
never hide a lower-ranked one. A subject sheds its least recently attached
documents until the joint maintenance region fits `maxVisitedPerSeed`. Any
selection that still cannot start (a subject with fewer than two documents
that fit, a publication retry or chronological cohort whose region does not
fit, or a conflict with work already admitted) is passed over for
`routineDelay` (`soonDelay` after a conflict), and the next candidate is tried
on the same tick, so a failing retry never holds the subject pass. A
publication retry is never reopened while one of its members has work parked
at its revision.

The gateway log names each cohort start (`Organization cohort started:` with
its kind, anchor loop id and source count), each selected cohort that did not
start and why (`Organization cohort not started:`, with the kind `subject`,
`retry` or `chronological` and, for a conflict, the refusing check), and, when the subject pass
offers nothing, its counts (`Subject organization cohorts: none started;`):
important outcomes, those without a page, subjects, and how many wait their
retry, were passed over, or lack considered documents. A repeated report is
logged once per `routineDelay`. `GET /admin/brain/knowledge/status` returns
`organization`: cohort counts by kind (`subject` or `chronological`), status
and outcome.

Page proposals require initial `knowledge_list({kind:"wiki"})` and
`knowledge_candidates({})` reads without status or cursor filters. On a collection
conflict, refresh both and reconsider the scope before retrying. A refused proposal
is neither publication nor a no-page decision; existing candidates can be deferred,
and an offered organization cohort has explicit deferred/no-page outcomes.

A proposal candidate is not a stored page. New wiki saves use the separate
`candidateId` and `node.expectedRevision: 0`; an existing page update uses the node
revision returned by its editing read, never the candidate's revision.

Page candidate `evidenceVersions` maps bare document IDs to exact observed source
revisions; `source:` reference keys belong to claim `inputVersions` instead.
Malformed candidate keys are refused without changing any evidence version.

Creation requires actual library and candidate reads in every maintenance mode,
a distinct-scope assessment, and current full reads of considered related pages.
A narrow inventory generation fences concurrent wiki additions, deletions,
title changes and candidate scope/identity/status changes. Unrelated ordinary
claim edits do not invalidate creation; selected counterpart revisions still do.
Bounded retrieval and explicit judgment are not proof that differently worded
duplicates are absent or that every scope change can be inferred from prose.

After the source and page frontier is settled, the agent records a version-fenced
organization outcome: actual wiki targets, a no-page decision, or a
missing-context deferral. The durable ledger stores bounded reason codes; richer
reasoning stays in the normal agent transcript. Unchanged completed inputs wait for
`maxReviewInterval`; deferred work waits for `routineDelay`, both with a
one-minute floor. Fresh evidence can form a new cohort with previously reviewed
context. Failed or stale cohorts do not advance the joint review ledger, and
private evidence is excluded and its retained cohort review metadata is purged.
These passes revisit admitted evidence; they do not grant historical consent.

During backfill, readable evidence can arrive before it becomes searchable.
Search reports whether a published index scan has reached the observed corpus
timestamp; even a completed scan is not proof that every document is searchable.
Discovery that searched an incomplete view retains its positive source facts and
records a pending reconciliation boundary. Once index publication reaches that
boundary, the bounded organization lane admits one catch-up review per source
revision without consuming historical admission again. It does not repeatedly
retry while indexing is still behind. Joint organization decisions retain their
own search boundary, including searches made after source interpretation. When
publication reaches it, the same current cohort becomes eligible once without
waiting for its ordinary repeat interval, whether it created a page or decided
against one. Admission consumes that durable retry for the same membership, source versions
and policy, even if its searches still report incomplete coverage. Changed inputs
get a fresh allowance; ordinary scheduled reviews remain available. Source revision, removal and
privacy fences remain in force; absence from search never establishes absence of evidence.

Canonical loop and annotation writes made during maintenance automatically
enroll affected owners for grounded synthesis review, even if the agent omits
explicit discovery targets. Persisted evidence determines their association;
unrelated owners receive a separate review.

Maintenance root saves require an actual bounded `knowledge_list({kind:"wiki"})` read in the run. The root selects relevant current orientation; it need not link every page or rewrite an already useful account.

Publishing a wiki also queues a durable whole-page review. That review assesses
placement in the existing library, useful context, chronology and navigation;
a standalone page is a valid outcome. Hierarchical links point from a child to
its parent. A request with one settlement normally remains one loop. Separately
closable material sub-outcomes can use child-to-parent `part_of` links when a
meaningful parent outcome also remains; its remaining scope and completion
criterion must stay explicit. Routine checklist steps do not each require a loop.
A project wiki supplies context when there is no separate parent obligation.
Organizational links neither supply factual evidence nor automatically close
outcomes; operational blocking remains separate. Adding or removing a `part_of` or `belongs_to_project` link to a wiki
or root queues review of the affected wiki/root endpoints; retrying an unchanged
link does not. This refreshes both the parent summary and child navigation. Parent
review reads current organizational context before integrating relevant detail
pages. A parent summary cites exact child claims when it derives from those
claims, so later evidence changes use the ordinary dependency maintenance path.
Organizational links alone are not factual support and do not propagate all
changes through the hierarchy.

Completing a whole-page wiki review requires a structured placement assessment
alongside the terminal save. `integrated` validates actual persisted links and
current reads of their counterparts, including incoming `belongs_to_project`
links from active or completed tracked loops. This records project navigation,
not factual support; retired or withdrawn records cannot establish placement.
`standalone` records an explicit scope
judgment after reading the library, without asserting a global absence proof.
`deferred` preserves accepted prose and schedules a bounded review successor.
The accepted revision records the assessment status separately from claim
verification, without retaining counterpart identities or free-form reasoning
in history metadata. Ordinary claim repairs, partial reviews and other node kinds
do not require this assessment. A recorded decision makes omissions inspectable;
it does not prove that the model chose a useful organization.

Page curation distinguishes evidence arrival order from event order. Older
observations discovered later should enrich dated history rather than silently
replace still-supported newer state. This is an authoring responsibility;
structural claim validation alone cannot prove that a page is a useful or
chronologically coherent synthesis.

## Changing the user's own tasks

A loop the user owns — one they wrote, one from a note, or an accepted
suggestion — is their task. Accepting a suggestion is where the user decides
whether something is worth tracking; after that, keeping the task current is
the Brain's job, so most changes apply on their own and only those that take
that decision back or override the user's own words are proposals they
confirm or keep. `open_loop_update` carries `reason` and, for a fact,
`evidence`: the fact behind the change, whether a source states it
(`explicit`) or the run concluded it (`inferred`), and verbatim quotes from
the documents that establish it.

The policy is deterministic (`brain/tasks/auto-apply.ts`). Striking a task
is always a proposal. Context applies freely: a new title or description
where the user did not write that field, an addition to a description they
did write, and clearing a deadline Omnesis set. Facts need proof: a
completion, or a deadline the user did not set, needs explicit evidence, and
the policy builds a claim from it — the stated fact plus the task it
completes, or the fact behind the deadline — which the entailment verifier
must find the quotes establish. Any other verdict, a quote that is not in its
document, no verifier assigned, or a verifier outage leaves a fact a
proposal, and the tool result says why. What the user wrote stays theirs:
the title, description and deadline they gave a task they created, any field
they edited, the state of a task they reopened, and any change Omnesis
applied that they undid; a change to one of those (other than an addition to
their description) is a proposal.

An applied change is an `auto_applied` task event carrying its reason,
evidence documents and the values it replaced, so `/tasks/undo` reverts it.
It is judged against the task's newest event; a user change that lands while
the verifier answers turns it back into a proposal. The next morning brief
names the changes applied since the last one in a single line.
`brain.tasks.autoApply: false` makes every change a proposal.

When a decision model is assigned, two typed checks (`brain/tasks/task-checks.ts`)
weigh what a run already chose to write. A new title that would apply on its
own must first be scored as naming the same task; a lower score or a model
outage leaves it a proposal. A note a run appends to one of the user's own
tasks is scored against the task and its eight latest notes, and a note that
only repeats them is not recorded, so the task's history stays readable; an
outage keeps the note. Every verdict, an outage included, is a `task-check`
row in the decision ledger on the run that asked, anchored to a document when
one grounds the check; the exact question and answer are kept in the decision
payload store under the task's knowledge node. Notes on loops the user has not
accepted are never checked.

A proposal is judged when it is made, but the task and the policy move on
while it waits. When the Brain starts, it settles waiting proposals: one that
no longer changes anything is withdrawn, an edit the policy now applies on its
own is applied as an undoable `auto_applied` event, and the rest keep waiting.
A completion or deadline stays a proposal, since its evidence quotes are not
kept. An applied change also replaces any proposal still waiting on that task.

## What the user cares about

The Brain learns what the user cares about only from what they did on
purpose. Three things count: accepting, creating or ignoring a task; a thumbs
up or down on an item of the morning brief; and what they say about their
interests in the Morning brief conversation. Each becomes one signed example
in the interest ledger (`interest_signals`): the text they reacted to, their
own words when they gave any, and, once the embedder has seen it, a vector of
that text. Nothing is inferred from silence: a suggestion nobody touched and a
brief nobody read leave no mark. Taking a reaction back (undoing an accept,
clearing a thumbs) supersedes the example it produced rather than deleting it.

Accepting a suggestion or creating a task is a positive example; ignoring a
suggestion is a negative one, with the reason as its note. Striking,
completing, editing or moving a task says nothing about interest and records
nothing. A thumbs up on a brief item is positive; a thumbs down asks which of
two things is wrong. "Not interested" is negative, with whatever the user
typed or dictated as its note. "Factual error" is not about interest: it marks
the observation disputed, records no example, and saves the correction as a
Tell Omnesis note the note agent acts on. In the Morning brief conversation
the agent has `interest_record`, which turns "I don't care about X" or "more
of this" into a statement example; the tool exists in no other conversation.

A gate does not score the ledger; it reads it. Before it asks its question, a
gate looks up the few examples most like the item it judges (by vector when
both have one from the live embedder and the item's own vector arrives within
ten seconds, by word overlap otherwise) and puts them
in its state as `owner_interest`: positive examples, negative examples and
statements, each with its similarity and age. An empty ledger, or nothing
above the similarity floor, leaves the request exactly as it was. Three gates
read it: observation salience at noting time and at the morning recheck,
the task checks, and the urgency question that schedules new evidence.

A fourth gate is new: `task-propose` judges every suggestion the Brain drafts
as withhold, suggest or adopt. It is asked only when the ledger holds
something like the suggestion, and its verdict is bounded by what it was
shown: adopt needs a positive example or a `more` statement and no negative;
withhold needs a negative example or a `less` statement; anything else is a
suggestion as today. `brain.tasks.proposeGate` sets what the verdict does.
`shadow`, the default, records it and offers the suggestion as before.
`enforce` withholds (the loop is created ignored: tracked, out of the Tasks
views, offered again by undoing the `withheld` event in its history) or adopts
(created accepted, with an `auto_accepted` event the user can undo; undoing
one is the strongest negative example the ledger records). `off` asks nothing.
A model outage fails open to a suggestion. `brain.interest.enabled: false`
stops recording and stops showing examples; the gates then decide as if the
ledger were empty.

A gate looks up the few examples most like the item (by vector when both have
one from the live embedder, by shared content words otherwise, never on one
word alone); `brain.interest.lookup` sets how many it is shown of each kind
(`perPolarity`, 4) and the similarity floors (`cosineFloor` 0.55,
`overlapFloor` 0.2). Each example says which measure found it. Cosine scores
depend on the embedder: with Qwen3-Embedding-0.6B, related short texts score
roughly 0.4 to 0.75 and unrelated ones mostly below 0.4, so a floor near 0.45
finds more of what the owner meant at the cost of an occasional stray example,
which the decision model sees with its similarity and can discount. The owner's
latest word on a thing is the one that counts: accepting a suggestion they had
ignored supersedes the ignore, a changed thumbs supersedes the earlier one,
and a statement about the same subject supersedes the previous statement. A
erased observation or loop (deleted outright, never by a source deletion)
takes its examples with it; a deleted task's
examples are kept as history but no longer count.

The ledger exists only in experimental mode, where the gates that read it
run; a stable gateway records nothing.

Debug → Cognition → Interest shows the ledger: every example with its
polarity, source, text and note, whether its vector is ready, and whether it
was superseded; the suggestions the gate withheld, each with an **Offer
again** that undoes the withholding; the `task-propose` verdicts; and a
lookup box that shows what a gate would be shown for any text. A
factual-error thumbs records no example and so appears there only as the
observation's `disputed` action.

## Auditing the decision model

Every call to the decision model writes one ledger row, whatever it returns:
the worth gate, the record check, the task checks, the suggestion gate
(`task-propose`), observation salience and,
outside any Brain run, the date-mention gate (`mention-worth`) and search
routing (`find-route`) in `cognition_decisions`; discovery, impact, review and
urgency in `knowledge_decisions`. A row names its run, its document and the
record it judged where they exist and leaves them null otherwise. Debug →
Cognition shows each one through the portal's single decision card
(`components/decision-card.js`, marked with the scale icon): on its run, in
the retained decision history (filterable by purpose), on its maintenance
batch, page or pending work, and on its observation. The card loads the exact
request and answer on demand from the payload store, or the row's retained
copy where no exact capture exists.

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

Verifier prompts place fixed instructions first and reusable evidence before candidate claims; this ordering does not guarantee a cache hit. Cache reuse depends on the backend, model and prompt prefix. Compare the measured
fresh-input and cached-input counts when estimating cost against your provider's
pricing. The gateway does not assume a fixed cache share or output ratio. Verifier accounting retains provider-reported cache reads and writes as subsets of total input. Missing cache fields remain unknown at the inference boundary. The durable aggregate sums reported cache only: a zero there does not establish that all input was fresh, and historical missing cache breakdowns cannot be reconstructed.

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
freely alongside it would not be a budget. The day's morning brief is exempt:
it is one run a day, so the drain still claims it once the ceiling is reached,
and its spend counts toward the day like any other run's. **Both default to no
ceiling.**

**`brain.bootstrap.maxRunsPerDay`** — the daily historical admission cap.
In the maintenance engine this counts source-revision work seeds, which may
share a synthesis run. It is separate from the global agent-run budget.

**`brain.bootstrap.maxRuns`** — a lifetime backstop, counted across the whole
install and never reset, including across source removals. It is a spend
backstop rather than a per-corpus one: if removing a source refunded its runs,
delete-and-re-add would be a way around it.

If you need to turn the spend down, in order:

1. `brain.bootstrap.horizon` — how much history is owed at all.
2. `brain.bootstrap.maxRunsPerDay` — the biggest lever on pace.
3. `brain.bootstrap.activeHours` — shape it onto off-peak hours rather than
   reducing it.
4. `brain.knowledge.maxReviewsPerTick` and `brain.reverification.maxPerSweep` —
   bound proactive synthesis checks and legacy annotation rechecks.
5. Individual producers to `enabled: false`.
6. `brain.budget.dailyTokens` as a hard stop under all of it but the morning
   brief.

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

A failure is judged by what it blames. A malformed or over-long payload, or one
a content filter stopped, is the request's fault, and its run retires after its
retry budget. Anything else — no credit, a rejected key, a rate limit, an
unreachable backend, a signed-out, missing or outdated Claude Code, an unknown
model, invalid reasoning controls, a server whose context length cut the prompt
— is the environment's fault, and the run **keeps its place**: its attempt is
refunded and it waits, because the same payload will succeed once the
environment is repaired.

Backends say which is which on their terminal failure: `retryable: false` is
reserved for failures the same payload can never get past (it no longer fits,
it ran out of output, a filter refused it). A fault only an operator can clear
is still `retryable`, since the run succeeds unchanged after the repair; an
interactive turn fails at once either way, with the message naming the fix.

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
  observations, and the run queue.
- **Portal → Debug → Background jobs** — every periodic task, when it last ran.
- **`omnesis brain runs`** — the queue, newest first. `omnesis brain run <id>`
  and `omnesis brain transcript <id>` open one up.
- **`omnesis brain spend`** — tokens by day, mechanism and model.
- **`omnesis brain decisions`** — source-associated maintenance and other agent
  decisions, with their actual batch transcripts.

The Debug workspace groups the brain under Cognition: Library, Agent runs,
Maintenance and Discovery. Existing deep links stay valid. Library includes
wikis, loops, observations and annotations, with status filters and canonical details.
Person and document notes identify their subject and link to its current profile
or source document, including historical notes.
Maintenance filters batches by recorded reason, tier and status, with cursor paging
and reason/tier pills. A batch can contain several reasons. Discovery owns bootstrap
coverage and history controls. Agent runs combines current execution, scheduled
work and completed transcripts, with a Running filter and live count.

Run details expose recorded Jev judgements, including synthesis discovery and
impact gates: model, rubric, normalized score, threshold, input tokens and latency.
A score recommendation is distinct from the engine's final action: protected work
can still proceed. Older verdicts are associated only when retained source
versions and execution intervals establish a unique match; incomplete or bounded
audit results are labelled, and missing metadata never proves a gate was bypassed.
Decision inspection belongs with the work it explains: pending maintenance,
batch inputs and agent runs expose contextual checks in collapsed Decision details sections.
Advanced history keeps retained judgements accessible when their original work
or transcript no longer exists. Exact bounded requests and captured model results
are loaded on demand for urgency, discovery, impact, review and record checks;
legacy worth checks retain their existing request and response. For urgency,
the captured policy explains the proposed tier and the applied schedule records
any earlier coalesced work retained by the engine. Historical inputs are never
reconstructed: retained redacted or score-only records are labelled as such.
Sensitive snapshots follow decision activity retention and privacy erasure for
all contributing sources, while verdict metadata can remain. Missing, oversized
or erased snapshots and unavailable models are labelled explicitly.

Discovery admits complete source bodies to the decision gate when the serialized
UTF-8 decision input (source metadata/body plus the full question/rubric) fits
128 KiB. This application budget excludes provider-specific transport wrappers
and is not a claim about any provider's context capacity. The engine never
truncates a source to obtain a negative admission decision. Empty sources,
over-budget inputs and missing decision models instead produce a durable engine
bypass record with its reason and byte budget, no model score and zero paid
input tokens. Provider errors remain unavailable judgments and admit inspection.
Existing explicit reviews and source obligations still require inspection even
when a relevance gate would skip them.

The experimental Knowledge library reads the same canonical data used by
agent tools. The desktop list and reader scroll independently; the list loads
more entries near its end. Live browsing preserves loaded entries while the
brain writes; Refresh brings newly added or moved entries back into view.
Browse or filter the library, then open a page’s Overview,
Connections, History, or Advanced view. Overview switches between rendered
Markdown and raw claim markup. Hovering or focusing the indicator at the end of a claim previews its
verification and incoming and outgoing references; the reference links navigate
to the relevant page or passage. Connections shows flat incoming and outgoing
reference lists, combining evidence and organizational links with bounded
pagination. History offers a collapsed diff against each revision's predecessor;
expand a revision to inspect additions and removals. Advanced contains storage
metadata and exact claim mappings. Empty, pending, and unavailable states
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
decision and entailment services make the engine replayable.
These tests establish execution correctness, not model judgement quality.

### Outcome admission and source framing

Background outcome creation and substantive revisions are checked against original
source context, including the prior outcome, proposed state, actor roles and deadline.
The judge distinguishes current obligations from historical instructions and checks
that completion concerns the same event. Pure scheduling or dismissal does not spend
a judgment; reviving a resolved outcome or changing its assertions does. Canonical
synthesis saves that change loop prose use the same check. Original sources are required
for autonomous outcome assertions. Source and owner snapshots are checked atomically
at write time, including legacy ingestion runs.
Already-stale reconciliation reads are rejected before model checks; the writer
still checks them atomically to catch changes during inference.

Annotation and observation entailment checks include bounded source framing around the
selected quote. Headings, nearby qualifications and final corrections remain visible;
truncated context is explicitly incomplete, never proof that contrary evidence is absent.
Exact contextual decision inputs live only in the privacy-bound audit payload; the
legacy ledger retains a redacted summary. These checks are probabilistic: model outages
remain observable fail-open events, and content quality still needs evaluation.

Document-note and person-profile admission require a value score of at least 1.5 on
the 0–3 rubric; time-index entries and tracked outcomes retain the 0.81 threshold.
Substantive outcome revisions additionally require a transition-integrity score of
1.5: being relevant does not justify losing a supported action, qualification or
completed step. Both questions share one decision call and must independently
pass; the audit records both scores, thresholds and the limiting dimension.
An integrity refusal leaves the old outcome intact and requests evidence-based
reconciliation. Harmless compression and supported corrections remain allowed.
Bounded context prioritizes proposed evidence and prior claim sources over residual
linked documents; omitted sources remain bound to the privacy and write fences.
Synthesis saves check the current node revision, offered frontier and cited source
versions before invoking paid judges; the writer repeats the checks atomically
after judgment so a concurrent change still refuses the stale write.
Person facts must assert useful context about the person, not just describe a source
that mentions them. Historical scope and source attribution are allowed; weak profile
value does not justify occupying a slot or replacing a stronger existing fact.
A merely plausible or weakly useful restatement should not create another record;
the original source remains retrievable. Outages still fail open and are auditable.

An explicitly scheduled person-note review reassesses retention against the current
compact profile through the record check. Before its terminal save, the agent must
read all profile pages with `annotation_search`. Enforced refusal keeps the review
pending and requires canonical correction, consolidation or retraction; it never
automatically deletes a fact. The full profile and its evidence revisions are
checked again atomically at the writer. Ordinary proof refreshes retain their
no-op behavior and do not repeat editorial admission. Shadow, off and unavailable
checks preserve the record check’s existing behavior.

Outcome reviews also recheck unchanged canonical text under the active record-check
policy. Accepted assessments bind the effective outcome, source revisions and actor
roles to the rubric version, enforcement mode and exposed decision-model identity.
Ordinary proof maintenance reuses that exact assessment; an explicit scheduled
review gets one new assessment for its batch. The existing bounded review lane
also nominates outcomes accepted under an older policy. Refusals and unavailable
checks retain pending work with backoff, rather than recording a successful review.
Only an enforced pass becomes a reusable assessment, committed with the guarded
outcome write; privacy deletion removes the assessment and its source links.

### Reading tracked outcomes

The answering agent treats active loops as candidates for investigation, not proof
that work remains outstanding. It shortlists relevant topics from summaries and
wiki context, reconciles answers or progress recorded across related items, and
opens the exact supporting source when records disagree. A broader project may
remain open after a narrower request is answered; note-recording times do not
replace source event dates. Unknown current status remains distinct from a
supported follow-up obligation.

Maintenance can batch up to 16 exact references with `knowledge_reference({refs: [...]})`.
The bounded result returns complete views, individual errors, and `deferredRefs` for a
follow-up batch. Oversized references require a single-reference read. Only complete
successful reads supply dependency receipts; batching never refreshes stale versions or
turns an unread source into evidence.

Source-reference reads retain original text and expose record title and dates separately.
Verification receives bounded source framing; record timestamps do not automatically establish
an event date. Selected-quote references may use surroundings to interpret the quote, but
independent surrounding facts require a whole-source reference. Autonomous document and
person annotation writes use an annotation-only atomic assessment: one verifier response
identifies exact spans and checks each assertion with the complete inherited context.
Annotation placement context is bounded to 16,384 characters; oversized notes must be
compacted before a claim-level Knowledge save. Enclosing prose constrains interpretation
but cannot supply additional factual witnesses for a selected claim.
A valid candidate-bound negative refuses the note even if positive coverage is incomplete;
a positive proof requires complete textual and semantic coverage plus authorized witnesses.
This preserves one synthesized note rather than creating a record per clause. Textual coverage
is mechanically checked; semantic decomposition and entailment remain fallible model judgments.
The annotation protocol makes one inference call, with bounded output and no malformed-response
repair call. Verifier acquisition now has its own 45-second bound in Knowledge writes,
followed by the existing separate 45-second bound for each claim check. Canonical
annotation gates share their existing deadline across acquisition and checking;
Answer uses its caller cancellation signal without adding a deadline. Cancellation
removes expired work before inference admission and reaches remote transports.
The service retains each active operation through capability-operation settlement, including
native operations that cannot interrupt generation; runtime pools separately own
transport lease cleanup. Configuration swaps cannot dispose an active capability.
Completed reported usage is counted before post-call cancellation checks; spend
not returned by a canceled transport remains unknown. Content-free service timing
logs separate queue wait, loading and capability verification, with caller versus
operation cancellation boundaries. Contended, canceled and failed operations log
at INFO; routine uncontended successes use DEBUG. These timings do not isolate
model generation from transport or pool waiting inside a capability.

The existing 45-second limit remains: an unavailable configured verifier still
saves an explicitly unverified annotation, never a verified stamp. More detailed assessments
can cost more output tokens and can time out. Wiki proof policies are unchanged.
Old annotation proof-policy markers lose support authority and enter existing bounded policy
review; historical canonical verification flags are not promoted to the new policy automatically.

### Citation read receipts

The main agent and Answer citation tools require a current authorized document
snapshot returned by an explicit fetch in the same turn. A fetched wiki is
directly citable; its source references do not count as reads of those originals.
Any supplied quote must match the observed body. Whitespace-only differences are
accepted only when they identify one unambiguous observed passage; the citation
stores that original literal passage. Different words and omitted words are refused.
A bounded body read can support a citation only from an observed span. Receipts contain snapshot hashes and character ranges, not source
text, and are bounded in memory. Annotation rechecks privacy and snapshot
identity. This establishes exposure at citation time, not entailment, latest
real-world status, or a guarantee about text already streamed to the user.

Registering an exact source quote also records that selected evidence reference's
version for subsequent saves in the same maintenance run. Its version is captured
inside the registration transaction. It grants no whole-source read receipt, and
explicit dependency versions are never silently replaced.
A save whose cited references lack a current version is refused once, at
preflight, verification or commit, with one `revision_conflict` that separates
missing reads from stale explicit overrides, names up to 32 of them with a count
of the rest, and spells out the `knowledge_reference` batch calls that read them,
so a large page is not resubmitted once per unread reference.

New wiki publications and changed wiki prose also use the configured record check
before factual verification. The decision assesses the actual draft's synthesis
value, not its candidate pitch: a document inventory or copied boilerplate does
not qualify merely because it cites several sources. Concise integrated accounts
can qualify. Root orientation and unchanged-prose proof refreshes skip this
check. It uses the existing default threshold and off/shadow/enforce semantics;
unavailable or oversized context fails open and is auditable, not a quality
approval. Exact run-local assessments may be reused only for the same draft,
reference versions and policy. Final publication still checks current evidence
and library receipts atomically.

When an outcome proposes a non-null deadline, that same record-check request
includes an independent deadline-support dimension. Passing overall usefulness
cannot compensate for an unsupported action due date. The sources must establish
the date's role for the exact action and responsible actor, preserving approximate
windows and conditions. Related events, forecasts and monitoring times are not
interchangeable with an action deadline. A refusal identifies this facet and lets
the agent keep the useful outcome while clearing the unsupported deadline or
retrieving its support; review scheduling remains separate. Scores and the
limiting dimension are visible in the decision audit. Missing or malformed
answers retain existing unavailable behavior.

Person writes and explicit editorial retention reviews independently assess
`profile_distillation` in the same record-check request. The actual proposed
final profile must express distinct useful person-level meaning, rather than
copying a supporting-document inventory or repeating another retained fact.
Routine account rights and interface options do not alone establish useful person
context; consequential responsibilities, qualifications, permissions and constraints
remain eligible.
Necessary historical bounds and uncertainty remain; shorter prose must not
invent continuous history or erase distinct useful context. Corroboration stays
in evidence. The existing complete-profile receipt and atomic multi-fact
supersession protect reconciliation. Missing/truncated profile context or an
unavailable verdict is auditable under existing fail-open semantics; unchanged
ordinary proof refreshes still avoid a new value assessment.

During a wiki review, a refused synthesis-value proposal need not cause repeated cosmetic rewrites.
After reviewing every offered claim against current evidence, the steward may retain the exact
existing title and visible Markdown with `knowledge_save.curationDeferral` (reason code
`insufficient_useful_context`). This defers editorial improvement to the existing routine review
schedule without recording completed curation. It does not admit a new page, change prose, bypass
factual verification, or settle unreviewed claims. New evidence can still trigger normal maintenance. Supporting references may be replaced with a bounded set of current evidence references without changing claim IDs,
nesting, visible spans, qualifiers or support semantics. Such proof repair requires
current positive verification of every retained claim; verifier outages leave the
original page and pending work intact. Dependency changes still propagate normally.

The initial correction lane accepts assertion-only pages with supporting references;
pages containing disputed or unsupported claims, or non-supporting relations, remain
on the ordinary maintenance path. An existing offered wiki review can explicitly request `curationDeferral.factualRepair`
with up to eight existing claim IDs when a necessary factual correction or qualification
changes prose. Title, headings, claim identities and unrelated meaning remain fixed;
new pages, claim deletion and unrelated editorial additions are excluded. One versioned
repair-integrity decision replaces that proposal's synthesis-value assessment. Only an
enforced pass and current positive contextual proof for all retained assertions permit
the atomic write; off, shadow and unavailable verdicts do not authorize this exception.
The writer binds the approval to the exact proposal, model policy, run and dependency
versions. Editorial improvement remains deferred, not certified complete. Complete
before/after markup is limited to 24,000 characters per page for this bounded path.

Autonomous person-note retraction and supersession by an existing fact assess
`withdrawal_preservation` against the complete current profile and bounded
original sources. Retention and withdrawal share the same person-profile utility
standard: factual accuracy alone does not make generic boilerplate, routine transactions
or incidental episode associations worth preserving in the profile. Consequential
roles, relationships, constraints and historical meaning still require preservation.
A retention refusal alone never authorizes withdrawal. Outcome assessment receipts
use their own semantic policy version, so person-only utility changes do not
requeue otherwise current outcomes. Poor wording or a rejected rewrite is not evidence that its
useful meaning can be discarded. Useful context must survive in a retained fact
or an atomic revision/replacement; irrelevant, unsupported and redundant facts
can be removed. The writer rechecks the profile and source fingerprint after the
assessment. In `enforce`, a missing, incomplete or unavailable withdrawal
assessment leaves the old fact pending. This destructive-operation exception does
not change admission's fail-open behavior; `off` and `shadow` remain observational.

Root orientation saves must provide clickable navigation to each wiki they actually select as
supporting evidence. Claim references retain factual dependencies; Markdown links provide access
to the detail page. Context-only references and unrelated library pages do not require links.
This structural check does not establish the truth or relevance of a summary.
When a root has no wiki navigation, its frontier may include `recoverableNavigation`:
current readable page identities recovered from at most five meaningful history snapshots
within a 100-revision scan and 64 KiB text budget. Titles and revisions are current;
historical prose and proof are never offered. Candidate and compact-frontier limits can
make this investigation list incomplete. These hints grant no evidence or editing receipts,
do not restore links automatically, and do not alter root scheduling. The agent investigates
relevant current pages, selects useful navigation, or explains why none fits the orientation.

### Grounding interactive answers

No second pass checks or rewrites what the agent says to someone talking to it:
conversations in the portal and apps, Deep Research replies, and Answer candidates
(the `/answer` API, MCP Answer and watch-firing answers) are all exactly what the
agent wrote. Answer candidates still pass the privacy reviewer, which decides what
may leave the machine, not whether the answer is true. Grounding comes from the
agent's instructions alone: they treat the root, wiki pages, annotations and loop
summaries as summaries to navigate from, so the agent reads the relevant page and
follows the claims its answer uses to their source documents
(`knowledgeContext.provenance`) before answering.

### Loop navigation and tracking snapshots

`list_loops` defaults to `mode: "navigation"`: summaries help choose records to open,
but supply no factual evidence or collection-completeness authority. Relevant `fetch_loop`
and source/wiki reads ground the answer.
An unrelated newly tracked record does not invalidate an answer about the records actually
opened; the original navigation rows still retain privacy/erasure checks.

For counts, empty inventories and recorded rankings, explicitly request `mode: "snapshot"`.
The engine captures observation time, accessible open/snoozed scope, stable importance/ID
ordering, requested limit, rows and truncation atomically. Answers carry visible historical
framing. Counts are exact only for an untruncated stored snapshot, never for real-world
obligations: source discovery and maintenance may still be incomplete. Original-member
access is checked when a snapshot receipt is validated; new collection members are not
silently substituted. Receipts are turn-bound and bounded.

### Complete source reads

Discovery accepts a complete source read assembled from exact `fetch_many` pages in the same run. Coverage is the union of validated character ranges at one source revision and privacy generation; gaps, repeated overlaps, malformed ranges and changed sources cannot establish a complete read. Receipts retain only bounded ranges, not copied source text. A successor run re-reads unresolved inputs.

Loop observation freshness diagnostics retain the public changed-evidence fallback while
reporting a closed internal refusal category (receipt binding, owner availability/privacy,
source generation, association, proof, or bounded validation failure). Diagnostic
comparison hashes are turn-local; loop record identifiers and hashes are not logged.
These diagnostics do not relax the original observation or source-authority fences.

Source frontiers present at most eight sources at a time, within the configured
frontier limit. This bounds the read-and-settlement work offered to one turn
without changing batch membership or independent-region parallelism. Run-local
`sourceRead` feedback distinguishes complete, partial, required and unavailable
reads; partial reads expose the first unread UTF-16 offset. Only actual complete
reads at the current source and privacy generation authorize discovery coverage.
Deferred reference results never count as reads.

Background sessions stop inference when the first tool-call-budget refusal arrives,
and maintenance sessions also when their context budget is reached.
Completed writes and observed usage remain recorded; the existing durable-progress continuation
policy decides whether a new bounded segment may resume unfinished maintenance. A cap
never increases the tool budget or replays the completed segment's writes automatically.
Cumulative live usage is used when cap cancellation suppresses a provider terminal;
unreported provider spend cannot be reconstructed. Interactive sessions keep their
separate completion behavior.

### Complete page reads during maintenance

Citation receipts record exact byte versions of source documents, partial
page reads and citations. A complete current wiki or root read also binds its
canonical meaning, qualified claim proofs and dependency state. That authority can
survive a projection refresh that changes only revision banners or maintenance
counters. Changes to factual text, support, proof policy, source freshness or
readability still refuse release. This does not make unverified page prose evidence.
Support references are semantically unordered; reordering the same reference set
does not advance a claim's meaning revision.

### Empty morning briefs

The morning run's preflight rechecks the open observations, then reads the same
temporal horizon, ranked observations and loops coming due that composition uses. An
entirely empty packet settles without a model turn or a message: missing bootstrap
evidence is not an all-clear finding. An unavailable horizon defers without
inference. A day already sent settles at once, and a run that has inputs but ends
without calling `morning_brief_send` fails and retries.

### Resuming joint organization

A joint organization run can resume after all source repairs have settled: its
explicit organization outcome is still actionable work. Empty frontiers that are
waiting for inputs remain unpaid; restarting does not discard the pending outcome.

### Source progress and existing outcomes

Source interpretation also reconciles progress into existing outcomes when no new
request or page is warranted. It reads plausible matching loops and relevant later
evidence before resurfacing an older request. Partial progress preserves the
outcome's independently outstanding scope; it does not imply full completion.

### Candidate curation obligations

Proposed wiki candidates retain a durable curation obligation. An unresolved candidate
becomes eligible after the configured soon delay; this does not authorize publication
or bypass source readiness, privacy, budget, or value checks. Admission binds the
obligation to the actual source work and survives a restart or deferred batch retry.
After those sources settle, the frontier offers remaining candidate decisions. The
agent must publish/merge, explicitly defer/dismiss, or retain the proposal with a
future reconsideration time. A failed draft or cohort no-page decision does not by
itself resolve a candidate's scope. Explicit reconsideration times take precedence;
ordinary deferred review keeps the long review cadence. Existing proposed candidates
receive conservative review debt without claiming they were never assessed.

Pending candidate generations also coordinate their admitted source work. Shared
candidate obligations join maintenance groups without adding factual graph edges.
The writer reserves this affinity atomically; older separately admitted batches
use one deterministic owner, so waiting siblings do not buy a model turn. Seed
limits still split large groups into bounded chunks. A source-settled chunk can
finish while siblings remain; the last eligible chunk retains the explicit
candidate decision. Retry bindings preserve progress, and candidate disposition
never completes independent source obligations. This prevents new overlapping
admissions; it does not undo work already paid before an affinity was discovered.

Knowledge claim verification unavailability retains the claim unverified. Operational logs
expose only a closed failure category
(timeout, cancellation, explicit HTTP rate limit, protocol failure or unknown), with a closed
protocol subcategory where available. Provider error text and response bodies are excluded.
Adapters that flatten provider errors remain unknown; these diagnostics do not establish why a
historical attempt failed or change verification, retry limits or backoff.

### Conversation evidence authority

The gateway keeps its own conversation history searchable, but a prior assistant
answer is not an independent source of world facts. A source-owned projection
binds actual user/assistant utterance ranges to the persisted transcript body;
rendered speaker labels, generated seed prompts and tool results cannot establish
those roles. Wiki claim verification consumes complete,
attributed speech statements rather than the raw dialogue as factual evidence.
User reports remain user testimony; questions are not affirmative facts. Assistant
utterances support historical statements about what the assistant said, not
independent confirmation of the embedded claim. Citation links remain navigation:
current original evidence must be read separately.

The current bounded projection offers at most 16 fully observed utterances of at
most 1,600 UTF-16 code units each, provided the complete escaped attributed
statement also fits the 2,048-character witness limit. Longer utterances and
partially read utterances are withheld rather than clipped. They remain readable
and searchable, but cannot provide a factual witness through this path. Missing,
stale or legacy role projections provide no authority until normal conversation
reprojection. Role/policy changes advance semantic source revisions, including
same-body changes; evidence privacy and source-currentness checks still apply.

New document-annotation and evidence-backed temporal-entry proposals run their existing value admission after cheap evidence and privacy checks and before entailment verification. An enforced low-value refusal therefore avoids the verifier call. Caller cancellation stops subsequent checks and writes; it is not permission to save an unverified annotation. Temporal evidence is checked again after value admission and verification; a changed or hidden source requires a fresh read. Superseding and revision policies are unchanged.

A readable wiki or root can be stale as a whole while retaining individually
current claims. Its qualified support contains only asserted claims whose
current contextual proof, supporting dependencies and enclosing claims pass the
same bounded reference checks. The page remains labelled stale; omitted prose
and navigation are not evidence. Support coverage reports budget truncation,
and never promises an exhaustive inventory. Main-agent use still requires the
actual full page read and an unchanged authorized snapshot; root injection uses
the same qualified support checks within its character budget. An erased or
retired page is unavailable as a whole. Direct reads can materialize a freshness-only
mirror lag without writing: the stored body, title, hash, metadata and creation
time must exactly match the canonical builder at its recorded validity and the
same physical revision. The emitted effective projection supplies the exact bytes
used by pagination, citation checks and answer snapshots. Older revisions,
corrupt mirrors and unavailable ancestors still refuse the entire read. Search
and index exposure remain strict; this fallback does not refresh search results.

Codex pool diagnostics separate admission wait from leased runtime duration.
Contended requests emit content-free `Codex pool timing` lines at info level;
uncontended requests use debug. The component names the pool lane and an
engine-generated opaque request ID joins lease and completion records. Granted
leases include the pool member index to correlate its runtime logger; this is
not a caller/session identity.
`waitMs` measures monotonic time until a member is leased; `leaseMs` measures
time from that lease until iterator settlement, including authentication preparation, transport
and consumer backpressure, so they are not model-compute measurements. A waiter
cancelled or disposed before admission reports `granted=false`. These diagnostics
do not change priority or capacity, and an inference lane alone does not identify
whether a judgement serves foreground or background work.

Loop claim proofs include the bounded final outcome text, title and selected span
as interpretation constraints. Surrounding claims do not become evidence for the
selected assertion. A split claim therefore retains its temporal and conditional
context; source support and privacy/version checks still apply independently.
Literal-only loop proofs are not qualified support. Existing bounded policy
reviews gradually revalidate retained owners, including completed outcomes,
without reopening them. Context over 16,384 characters is refused, not truncated.
This does not add verification to every operational loop update or guarantee that
an existing description is true; the operational value gate and terminal claim
proof remain separate checks.

Exact loop reads expose current context-verified assertions as qualified support,
including their modality, attribution and time bounds. Enclosing outcome prose
is returned separately as interpretation constraints, never additional proof.
Unverified siblings, tracked open state and priority do not establish present-world
obligations or completion.

Completed maintenance batches can settle their remaining run receipts alongside active
region-fenced work without starting a model or adopting new source changes. This terminal
housekeeping does not remove the exclusive admission barrier for live root or aggregate work.

Whole synthesis references explicitly report orientation-only use; a successful read
or version receipt does not qualify their prose as factual support. Accepted synthesis
saves return up to 64 stored claim verification states for that revision, with an explicit
truncation flag. A concurrent revision or privacy change makes the summary unavailable.
These states are diagnostic, not fresh support receipts: accepted storage and completed
review work can still leave claims unverified. No automatic retry or stricter completion
gate is implied; reuse exact qualified claim references or original evidence.

Root prompt support is checked against the exact qualified assertions originally exposed, including their selected proof and source identities. Navigation, unrelated sibling prose, physical revision banners and later context-budget fitting do not themselves invalidate those assertions. Changed selected context, proof or source authority, including deletion of a selected claim's source, still withholds the captured support; re-verifying unchanged words against changed evidence does not substitute a new proof into an existing answer. These private checks add no evidence to the prompt.

The verifier service admits at most two independent remote checks (Codex, HTTP or Anthropic), while native model contexts remain serial. This internal safety ceiling does not enlarge a backend's shared inference pool. Configuration swaps and disposal wait for every admitted operation's underlying cleanup, including canceled calls; caller deadlines and unavailable-write behavior remain unchanged.
