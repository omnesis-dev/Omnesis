# Adopting the v2 source contract, per package

Findings from reading every provider against the new contract, and the decisions
they produced. Read alongside `source-contract-v2.md`, which states the contract
itself.

This is a working document for the migration, not a permanent reference. When a
package has adopted the contract and its conformance suite passes, its row here
is history.

## Validation scope and retained limits

The registry conformance fixtures are hand-authored installed-state examples,
not a recording of every phase of every historical provider. The release-produced
database fixture independently proves schema and stored-value preservation;
its bookmark sentinels do not prove that each provider resumes its upstream
protocol. Provider migration tests and real-source lifecycle suites complement
those checks but do not constitute an exhaustive all-source failure matrix.
Retain both layers rather than replacing focused migration tests with a single
database fixture or treating a green conformance wrapper as upstream coverage.

Some safety choices deliberately retain data instead of guessing at deletion:

- Outlook Calendar withholds its whole-table analytics snapshot while any
  calendar is unreadable. Readable-calendar document claims and explicit event
  tombstones still proceed, but analytics-only absences can remain until a
  complete enumeration succeeds. Per-calendar analytics reconciliation needs
  an explicit ownership boundary, not a fabricated whole-table snapshot.
- IMAP trusts a successful nonempty mailbox listing as the server's authoritative
  inventory. Failed, bounded-out and empty listings withhold reconciliation; the
  protocol cannot distinguish a falsely successful omission from real removal.
- A phone's failed full-photo enumeration preserves ingestion progress and leaves
  reconciliation due for retry. Its native UI does not yet display a separate
  reconciliation warning. Native wire compatibility tests demonstrate supported
  field decoding and tolerance of unsupported additions, not presentation of every
  collector diagnostic or authentication form on every client.

The frozen old-gateway transport harness tests released HTTP and WebSocket
shapes, not a second full release process. Operational mixed-version probes and
upgrade backups remain necessary alongside these synthetic regression tests.

## Mechanical prerequisites

Two things every package needs before a `state:` block will compile or behave.

**Cursor types must be `type` aliases, not `interface`s.** `SourceStateSpec<S>`
constrains `S` to `Record<string, unknown>`, and TypeScript gives a type alias an
implicit index signature where an interface has none. `interface Foo {}` fails
with `TS2344`; `type Foo = {}` compiles, keeps every `satisfies Foo` working, and
makes the existing validator usable as `decode` by reference.

**Reuse the existing validator as `decode`.** Every provider already has a
predicate guarding its cursor. Passing that same function means declaring the
spec provably cannot change which stored values are accepted — the declaration
is a description of behaviour that already exists, not a new gate.

There is one trap in writing a fresh decoder instead. The page loop keeps the
cursor in memory across pages and the wrapper decodes it again on each one, so a
decoder that _rebuilds_ rather than _returns_ its input — a schema parse that
strips unknown keys, say — would drop a mid-cycle field on page two and restart
the cycle silently. Return the input by reference, or rebuild it completely and
deterministically.

## Two numbers that were one

The clearest evidence that separating `state.version` from `outputRevision` was
right is that two packages had already collided them.

**Obsidian's `CURSOR_VERSION = 2` is doing both jobs at once.** The state shape
changed (file entries gained a size, an inode and a stable id) _and_ the output
meaning changed (the external id moved from the relative path to a stable
identity). The v1 to v2 cycle emits deletions because the **output** changed, not
because the state did. Under the new contract that is `state.version: 2` for the
shape and `outputRevision: 2` for the derivation.

**GitHub and the local-agent adapters store a render or parser version inside
the cursor** and force a full re-walk when it does not match. That is an output
revision filed under state for want of anywhere else to put it.

## Judgement calls made

**Google Calendar's `occurrenceExpansion` is not a version.** It records which
query parameters minted a cursor's sync tokens, and a legacy cursor must keep
syncing with the parameters its own tokens were minted for. Modelling it as a
state version with a migration would be actively wrong: a migration must return
a current-version value, so it would flip a legacy account into expanded
semantics, re-parameterise the upstream call against tokens not minted for it,
and re-enumerate the whole calendar. It stays a semantic discriminator inside
the state. Both generations are the same shape and one decoder reads both.

**WhatsApp takes `rebootstrap`, not `stop`.** The instinct for `stop` comes from
a true fact — WhatsApp history is not re-fetchable from the server — applied at
the wrong layer. The history lives in a durable local store the state spec never
touches. Discarding the cursor floors the acknowledgement sequence to zero,
which deletes no dirty rows and re-emits at most one bounded page set, with zero
upstream traffic. `stop` would park a wake-on-event source into a permanent flap
whose only documented exit is a resync that wipes every WhatsApp document and
re-transcribes the archive. The downgrade protection people reach for `stop` to
get is already unconditional: a stored version newer than the running build is
refused whatever the policy says.

**`onUnreadable: "stop"` suits a source whose restart has side effects beyond
the re-read.** Two qualify: a message source that would re-run speech-to-text
over every voice note, and a call-log source whose state carries _pending work_
(days whose documents have not yet been rebuilt) rather than only a resume
position. Everything reading a local database that still holds its full history
takes `rebootstrap`, where a restart costs one walk and nothing else.

## Bugs found while reading

These predate the contract. Each is small and each destroys or risks data.

**Five Apple stubs discard a stored bookmark.** _Fixed._ The "database not
present on this host" stubs returned `cursor: {}` instead of the cursor they
were handed. The page loop persists whatever a page returns, so a Mac where the
database file temporarily disappears overwrote a good bookmark with an empty one
and full-bootstrapped when the file came back. One sibling source in the same
file already had the correct idiom, which is what made this a bug rather than a
decision. All five now share a named helper; a seventh source is deliberately
unlike them, refusing to be created at all because its requirement is an OS
version rather than a permission an operator can grant.

**WhatsApp acknowledgements belong to one archive.** Each local message store
persists a UUID in its SQLite metadata and emits it as `storeId` in the cursor.
A sequence acknowledges dirty rows only when that identity matches. Legacy
cursors without an identity and cursors from another archive safely replay the
outstanding backlog in bounded pages; they never clear it using a foreign
sequence. The store also refuses a sequence beyond its own saved counter.
The UUID survives restarts and upgrades of existing archives.

A database copy or restore preserves the UUID. This does not distinguish two
copies that diverge and later reuse overlapping sequence numbers. Do not run
forked copies concurrently, and restore the matching gateway state or force a
resync when restoring a local archive. Replaying an acknowledgement only
recovers pending dirty days; a full resync re-emits the retained archive.

**Two state fields are unbounded and rewritten on every page.** A message
source's per-day signature map holds one entry per conversation-day over the
whole retained corpus; a call-log source's affected-dates list grows to one
entry per distinct day in the entire history during a bootstrap. Both are
serialised into the page body and written through the single writer thread on
every committed page. Neither is caused by the contract, and the envelope adds
tens of bytes against megabytes — but a calendar source's snapshot enumeration
has the same shape, and scoped snapshot sessions are the mechanism that gets all
three out of the cursor.

## What the configuration schema's own review found

Member-local contracts can grow when every current member explicitly advertises
the same expanded parameter set. The gateway moves formerly shared values into
member overlays, preserves existing local overrides, and refreshes the affected
collectors after committing the new contract. A mixed fleet keeps the existing
contract until its members agree. Existing owners and members that explicitly
advertise a superset of its pinned fields can still receive their own effective
configuration and sync; an offline sibling does not block that additive upgrade.
This execution compatibility does not authorize member-local config edits, joins
or moves: those boundaries continue requiring exact agreement. Accepting an
additive declaration does not itself repin the contract or adopt a wire floor;
unanimous declarations can still repin it during hello. Sync begin and lease acquisition
retain their source-exclusive adoption fence. Missing field declarations and
incompatible modes or replica policies still refuse execution. Automatic
contraction is refused: promoting local values into shared configuration requires
an explicit operator decision.

The complete member parameter list includes advanced settings omitted from add
forms. Shared gateway config files cannot identify which member owns a local
path, so reconciliation warns and ignores those member-local fields. Set them
through the specific source member's configuration endpoint instead; a shared
file edit must never overwrite a remote member's local path.

Four independent readings of the schema after it was adopted. Each of these was
a defect in the new work, not the old.

**The parsed type was not actually typed.** Every key came out optional, because
the field constructors returned the interface type and widened `required: true`
to `boolean`. The one benefit the declaration exists to deliver was the one it
was not delivering, and only the CI-only test typecheck could see it. The
constructors are now generic in what they were handed, with `const` type
parameters, so a literal stays a literal.

**A validated path and a usable path were not the same string.** The check
resolved a leading tilde; one factory did not. An operator could type a path,
watch the field go green, and get an unreadable error on the first sync. The
resolution now happens once, in the host, between parsing and instantiation —
which is also why a source must not do it itself.

**One hint answered four questions.** A single `existsHint` covered every path
failure, so a source whose folder was on an unmounted drive was told its folder
was not a vault. The three existence branches now produce their own precise
message and the hint covers only the branch a source alone can explain: what
makes this folder the thing it is.

**A marker file passed for a marker directory.** `mustContain` checked existence
and nothing else, dropping a distinction the hand-written validator had made.
It now takes a kind.

**Whitespace was not blank.** A configuration file holding a space where a form
would have held nothing made the host refuse a source that every consumer of the
value would have read as unset.

**"(optional)" went missing from three labels and nothing replaced it.** The
schema's `help` was declared and then dropped at the boundary to the form. It is
now carried to both clients, and it says what leaving the field blank does,
which is the question the label never answered. The command line additionally
could not submit a blank optional path at all: an empty answer cancelled the
whole command.

## Authentication, migrated a provider at a time

Two providers moved first, chosen because between them they exercise both
halves of the vocabulary: one asks for a secret and nothing else, and one shows
a pairing code it never gets an answer to. The rest still declare the old flow
and the host runs whichever a provider declares, so no provider is broken by
the change and none is obliged to move before it is worth moving.

The secret-field provider gained something in the process. Its token used to be
collected by a client before the flow started and handed in, which meant a
re-authentication whose stored credential was the very thing that had stopped
working failed rather than asking for a new one. Asking is now the flow's own
job, so it can ask again.

Three of its failure arms became typed at the same time, and one pair is worth
naming: a token the platform rejects and a platform that cannot be reached used
to be one message string, told apart downstream by matching substrings. They
are opposites. One never clears by retrying; the other may clear on its own.

### What reading the rest of them found

Before migrating any of the remaining ten, each was read against the contract to
say what the migration would silently lose. The finding worth recording is not
any single defect but that every one was the same shape: not a gap in the
vocabulary, but a boundary that carried less than the older path did. A strict
schema stripped a field nobody had declared on it. A warning lived behind an
early return the typed path took first. A classifier was written twice and
finished once, so the same throw routed to a wizard from one entry point and to
a dead end from the other. A sentence had nowhere on the wire to sit. Adopting
the contract was therefore a downgrade, quietly, in seven different ways — and
each would have shipped described as "migrated a provider".

Two of them lost data rather than affordances. An open-banking consent states
how long it lasts once, during the exchange, and the host read that off the
result and dropped it a line later while the contract said in as many words that
such a deadline is not lost. And a one-shot history capture, whose window is
minutes wide and whose failure costs every record older than three months, had
nowhere to report that it had failed: a flow returns or it throws, and this
returns.

The reading also produced a rule for the failure vocabulary. A code earns its
place by changing what a client does or what an operator reads. Five did: a
credential presented and refused is not a person refusing; an untrusted
certificate is not a platform that might come back; data already connected under
another account is nobody refusing at all; a port taken on this machine is not
the platform being unreachable; and nobody answering in time is not the thing
shown going stale. Two more candidates were left out for failing the same test.

### What is deliberately still there

The old event shapes remain on the wire and both clients still render them.
That is not an oversight: a gateway one version ahead of its collector will
receive them, and a pairing that silently showed nothing would be a poor way to
discover a version skew. What did change is the copy — the shared component no
longer names one particular messaging application, because a fallback for any
older source cannot speak for a specific one.

## The page that could only name one table

A sync page carried one table, in six scalar fields. That is the right shape
for a source whose upstream record is a row, and the wrong one for a source
whose record fans out — an activity that is also its splits, its laps, its best
efforts and its segment efforts.

Sources in that position did not go without. They found two ways around it, and
both cost something the page was there to provide.

One was the host's analytics handle, which had a write method beside its read.
A write through it is not covered by the cursor that follows, so a crash
between the two leaves rows the cursor says were never fetched; it is not
fenced by the write epoch, so a wipe racing a sync can be undone by a write the
wipe never saw; it is not checked against the sync lease, so a member that has
lost the lease writes anyway; and it is invisible to the replica ledger, which
reasons about who wrote what from the pages it sees. One source in the tree
used it, in fourteen places, with a comment saying it was "bypassing the
per-page contract".

The other was pagination: a cursor phase per table, each page writing one table
from data the source already had in hand, fetching nothing. Six packages did
this. It is not wrong, but it turns one checkpoint into four, and a phase
boundary between rows that were read together is a place a crash can leave the
parent stored and the children not.

So the page carries a list, and the write method is gone. The six fields became
one, `analytics`, which accepts a single write or several. Two properties of
that list are load-bearing:

**Order is preserved.** A source that must fill a parent before its children
can rely on the order it gave.

**A table may be named twice.** Within one write the host upserts before it
deletes, which is correct for a page that adds rows and removes others, and
wrong for one replacing a keyed set — the delete would take out what the same
call had just written. Naming the table twice, clear first and rows second, is
how a replacement is spelled.

That second property closed a bug the old shape had made unfixable. One source
keys its kudoers `(activity_id, position)` over the current list; an activity
that lost a kudoer stranded the tail of the old list, and the code said so in a
comment — "we have no per-row analytics delete primitive" — while proposing a
new host method as the fix. The primitive already existed. What was missing was
the ability to order it against the write that followed.

Five pages in one source were returning `tableName: ""` to satisfy a required
field they had no table for, and a dozen more returned an empty row list with a
table name attached. Both now omit the field. An empty write is dropped before
it becomes a request, so a source composing a page from optional parts does not
have to filter its own list.

The reserved `multi-table-batch` host capability is now provided rather than
declared, and a source depending on it will be refused by an older host instead
of running with its child tables silently unwritten.

### What is deliberately still there

**The wire is still one table per request.** The runner walks the page's list
and sends each table the way it always sent the one, under the same write
epoch, before the same cursor commit. Batching them into a single request is an
optimisation, not a correctness fix, and doing it here would have meant a
protocol version gate on a change that needs none.

**Phase-per-table pagination mostly stays, and the survey is why.** The
expectation going in was that a phase writing one table from data already in
hand was always a workaround for the old shape, and that finding them would be
finding work. Six packages have the pattern, and reading them turned the
expectation around.

A page groups writes that must land _together_. Rows that are merely in hand at
the same moment are a different thing, and merging them makes the source worse:
one finance source writes its account list, then walks each account's history
over the network. That first page checkpoints, so a failure in the walk leaves
the accounts stored. Merge them and the accounts roll back into the retry.

So the rule is not "one upstream read, one page" but "would a checkpoint
between these be a lie". A parent and the children it fans out into — yes. An
account list and the transactions fetched after it — no. Only the first kind
was collapsed, and the contract now says so where a source author will read it
rather than only here.

## The read that was scoped in name only

Removing the write method left the read, and the read was the part whose
documentation was wrong. `SourceHost` said each source gets "analytics access
scoped to its own tables, so one source's enrichment query cannot read
another's rows even under the same login". The handle ran arbitrary SQL against
the analytics database, which holds every source's tables. Nothing in the tree
exploited it — one source uses the read at all, against a table it declares —
but a claim the code does not keep is worse than no claim, so either the
sentence had to go or the enforcement had to arrive.

The rest of that sandbox was already engine-level and stays so: the query runs
on a per-query READ_ONLY instance, which refuses writes even through CTEs or a
multi-statement script, with `enable_external_access` off, which refuses
`ATTACH`, `read_csv`, `COPY`, `INSTALL` and the rest of the file surface. What
no engine setting expresses is "these table names and no others".

**The allow-list is derived, not supplied.** The host binds the source id to
the handle, and the gateway resolves the readable tables from the catalog rows
that source's own schemas created — its own, plus any it shares with a sibling
of the same type. A source holding the handle can only hand over SQL; it has no
way to name a scope. A collector could name another source's id, but a
collector already holds a device token and could read everything through the
unscoped endpoint; the boundary being drawn here is around a source package
inside a collector, which is where third-party code actually runs.

**The check asks the engine, not a pattern.** Table names are reachable through
joins, scalar subqueries, derived tables and `WITH` clauses, and a pattern over
SQL text misreads all of them in both directions. DuckDB serializes its own
parse of the statement, so the question is answered by the grammar that will
execute it. Two cases make the difference concrete, and both are tests: a
forbidden table inside a CTE body is caught even though the outer query names
only the CTE, and a CTE _named after_ a forbidden table is allowed, because the
name resolves to the CTE and reads nothing.

A name a `WITH` clause introduces parses as a base-table reference, since at
parse time it is not yet known to be a CTE. Those are subtracted, or every CTE
a source writes would be refused.

The operator's own SQL surfaces — the portal view, the CLI, a watch predicate —
pass no source id and reach the whole database, which is what they are for.

## Compatibility notes for the release

**Identifier spelling never proves a person merge.** When a bare platform ID
and its namespaced spelling already belong to different people, the migration
preserves both spellings, provenance and manual decisions. It does not create a
new shared strong identifier that would trigger automatic merging. These
ambiguous identities require explicit review; unambiguous IDs are namespaced
normally. The migration is not a retroactive repair for merges already made.

**Upgrade the gateway first.** A modern collector requires the gateway's explicit
source-wire capability, including after reconnect. When it first claims a lease
or begins a sync, the gateway persists a source-level wire floor and fences older
attempts without changing bookmarks. Older collectors cannot read that source's
cursor, claim its lease, or write its documents, partitions, or analytics. Status
explains the upgrade needed. Untouched sources and phone-only streams keep working.

**Upgrade every collector sharing an adopted source.** This includes replicated
members that would otherwise adopt the shared cursor row and misinterpret its
envelope. Restarting or resyncing does not remove the floor; explicitly removing
the source does. Downgrading the gateway binary itself removes this protection
and is not a supported way to reuse newer cursor state with old collectors.
