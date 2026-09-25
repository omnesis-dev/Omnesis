# Source contract v2

The authoring contract a source package is written against, and how it evolves.

This document is the design record for the second generation of that contract.
It states what changed, why, and which choices were deliberately _not_ taken.
Read it before changing anything under `packages/source-sdk/src/`.

## The three version numbers

They are routinely confused. They move for different reasons and have different
consequences, so they are three separate declarations on
`SourceContractDeclaration` (`packages/source-sdk/src/source-contract.ts`).

| Number           | Declares                                                                  | Moves when                                                  | Consequence                                                    |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `apiVersion`     | Which generation of the authoring contract the package is written against | The authoring surface changes incompatibly                  | A host too old to run the package refuses to load it           |
| `state.version`  | The shape of the bookmark the source persists                             | That shape changes                                          | The host runs the declared migration chain                     |
| `outputRevision` | The meaning of what the source emits                                      | A normalizer produces different output from unchanged input | Makes a targeted backfill possible; nothing runs automatically |

`outputRevision` is the one with no predecessor anywhere in the tree, and it is
the one that silently rots a corpus. A normalizer change leaves every previously
ingested document exactly as it was, so the store ends up holding two
generations of meaning under one schema with nothing recording which is which.
Declaring the revision does not reprocess anything by itself. It records the
fact, so a backfill can be aimed and a document's provenance can say which
revision produced it.

## Versioned state

`packages/source-sdk/src/source-state.ts`.

Before this, a source's persisted bookmark was `Record<string, unknown>` and the
shared validator returned `null` for anything it did not recognise. `null` is
also what a source that has never run receives. So four unrelated situations
collapsed into one signal:

- a source that has genuinely never run,
- a value written by an older release,
- a value corrupted on disk,
- a value written by a _newer_ release this code cannot read.

They call for four different responses, and collapsing them made the most
expensive response the default: a full re-read of an upstream that may bill per
request, may no longer hold the history, and may take days.

A `SourceStateSpec` declares the version, a decoder, a migration chain and a
policy for unreadable state. `resolveSourceState` answers with a
`StateOutcome` that names which of five situations it is in: `fresh`, `resume`,
`migrated`, `rebootstrap`, `refused`.

Three properties are load-bearing:

**Migrations are chained and self-checking.** `migrate[n]` reads a version-`n`
value and returns a version-`n+1` value, so adding a version means writing one
new function rather than one per older version. After the chain runs, the result
must pass the current `decode`. A migration that quietly produces the wrong
shape is caught at the host rather than by whatever reads the state three cycles
later.

**A newer stored version is refused, never overwritten.** This holds regardless
of the `onUnreadable` policy. Starting over on a downgrade would overwrite state
the newer build understands, so a downgrade-then-upgrade would silently cost
whatever that state was worth.

**A minor version costs nothing.** Following Home Assistant's config entries, a
major bump needs a migration and a minor bump does not. Adding an optional field
moves the minor, the decoder tolerates its absence, and values stay readable in
both directions within a major. Most releases only ever touch the minor, which
is what keeps the common case free.

### A ceiling on persisted state

State is written on every committed page and read back on every one, so a field
that grows with the corpus rather than describing a position is paid for
repeatedly, on the single writer thread. Three sources already carry one: a
per-conversation-day signature map, an accumulating list of affected days, and a
snapshot enumeration that holds one id per item for a whole cycle.

`state.maxBytes` turns "the source got slower and slower" into a failure with a
name, at the point the growth happens. It is measured on the envelope, because
that is what reaches storage — a source measuring its own inner state would
exclude the wrapper and understate the cost. Exceeding it throws rather than
truncating: state is a resume position, and half of one resumes from the wrong
place.

### Where the envelope lives

The gateway stores sync state as an opaque JSON blob and continues to. The
envelope wraps that blob rather than changing where it lives. State migration
remains the collector's responsibility. Separately, a persisted per-source wire
floor refuses older collectors once a modern collector adopts the source. Upgrade
the gateway first, then every collector sharing an adopted source; untouched
sources and phone-only streams continue independently.

A stored value with no `e: 1` marker is a legacy raw cursor. It is classified as
version 1 unless the source declares `legacyVersion`, which is how a source that
rolled its own versioning inside the cursor keeps its history readable.

## What an output revision must not do

Reading the tree turned up the same pattern in two places, and it is worth
stating as a rule.

A source that changes what it emits needs previously emitted output
reprocessed. Both packages that had already met this problem solved it the same
way: store a render or parser version _inside the cursor_, compare it on the
next run, and discard the cursor when it differs. That works, and it is wrong
in three ways.

**It makes the most expensive response automatic.** Discarding the cursor
re-reads the entire upstream. For a source that pays one request per item
against an hourly budget, changing a heading costs hours of quota — a decision
nobody took, triggered by a constant nobody thought of as expensive.

**It both over- and under-reprocesses.** Over, because an upsert of an unchanged
document is a no-op: every item the change did not actually affect costs a fetch
and buys nothing. Under, because a reset only re-renders what the next walk
reaches. A document for an item since deleted upstream, or for a scope the
operator has since removed, keeps its old rendering forever, and nothing records
that the corpus now holds two generations of meaning.

**Its blast radius is unbounded.** A cursor carries more than a position. It
carries deletion-safety counters that require two consecutive absences before a
scope may be swept, the timestamp of the last snapshot, and per-scope
availability probes. Discarding all of that because a markdown layout changed is
not a trade-off anyone chose, and a wholesale reset cannot express "clear this,
keep that."

So: **`outputRevision` never touches the state.** A meaning change bumps the
revision, which records the fact. A migration — if the change genuinely needs
one — clears exactly the watermarks it invalidates and preserves everything
else. The two are declared separately because they answer different questions,
and the remedy differs by source: where the raw input is still on disk, a
revision change is answered by a local re-parse; where it is not, an automatic
re-read is an operator's budget decision rather than a startup side effect.

## Host capabilities

A source declares `requires: [...]` for behaviour it _cannot work correctly
without_, so an older host refuses the package instead of running it with the
behaviour silently missing.

The distinction matters most for deletion. A host that ignored a scoped snapshot
session would not merely lose a feature; it would lose the source's only means
of detecting deletions, and nothing downstream could tell the difference from a
source with nothing to delete. Refusing to load is the only way that becomes
visible.

Capabilities are additive and never removed. Retiring one is what `apiVersion`
is for.

## Identity: the ID stays, the parsing goes

A configured source is keyed by `<sourceType>:<accountKey>`. That composite
string is also the on-disk credential directory name, is parsed in roughly forty
places to recover the type or the account, is what authorization derives
`write:<sourceType>` from, is hashed into every saved watch's reference digest,
and is what a user hand-writes as a key in their config file.

The temptation is to replace it with an opaque connection ID. That is not what
this contract does, and the reason is worth recording.

**The composite ID is not the problem.** The problem is that the _account half_
does three unrelated jobs at once: durable identity, filesystem path segment,
and display label. Renaming the ID fixes none of those; it only moves the same
three jobs onto a new string while invalidating every stored reference.

So the account key stays exactly where it is, and identity becomes **data
instead of a parsed string**:

- `discover()` and the auth flow return an `AccountDescriptor` carrying a stable
  upstream `subject`, an optional `tenant`, a human `label`, and any `aliases`.
- Those fields are stored on the source row and refreshed from collector
  discovery through boot, reconnect, and sync metadata. An older collector
  sending no descriptor preserves the stored value.
- Self-identity reads the declared subject, retaining the legacy account-ID
  heuristic when there is no descriptor. Display labels remain independent of
  the stable account key; family metadata is declared separately.
- A changed discovery label updates the existing row. There is no user-facing
  rename or alias-recording route: aliases and tenants are stored declarations,
  not instructions to merge or relocate accounts.

This separates declared account identity from display names while leaving
credential directories, scope derivation,
watch digests, config keys and both mobile clients untouched.

The rule that replaces the rename: **parsing a source ID outside the identity
resolver is a bug.** A consumer that wants the source type asks for the source
type. That is the change that removes the latent failures; the string itself was
never the hazard.

## Connecting an account

Two questions used to share one answer. Whether a credential still worked was a
boolean, and what an operator had to do to fix it was a bag of optional
callbacks. Both are now typed, and the two halves meet: a flow reports the
state it just established, so the host does not go and ask a question the flow
has already answered.

### A credential has a state

A boolean has room for two of the situations that arise, and everything it
could not say grew a channel of its own: a consent deadline rode along on every
sync result, a withdrawn grant was recognised by matching substrings against an
error message, a platform unlinking a device arrived through a separate error
callback, and "the keyring is locked so I cannot tell" was indistinguishable
from "there is no credential".

Each state is named for what the operator would have to do, because that is the
only thing anyone downstream does with the answer. Two of them are the reason
the change is worth making. A credential that cannot be read does not stop
anything — it is a failure to answer the question rather than an answer, and
treating it as absence turns a locked keyring into an outage. And a grant that
is alive but too narrow is neither connected nor broken: the source keeps
reaching whatever it can reach, because stopping would cost the data the grant
covers in order to signal the data it does not.

The prohibition is unchanged: answer from what is stored, never from a request.
A provider that answered by calling its upstream would turn every outage into a
false revocation.

The connection state is an admission hint, not a separate health dashboard.
`unknown` is logged and permits a sync attempt; an actual storage or permission
failure is then reported by the normal sync path. A source factory that cannot
open its credential before constructing the instance reports a setup failure
instead. The contract does not make every provider lazily construct its client.
Expiry notifications still use the persisted consent deadline reported by sync
or authentication; an optional `credentialState().expiresAt` alone does not
schedule a notification. A separate connection-state badge and a generic expiry
notification scheduler are deferred rather than implied by the state vocabulary.

### A flow shows things and asks things

`show` puts something in front of the operator and returns. `ask` puts
something in front of them and waits for the typed answer that challenge
produces. Everything else is a challenge kind — a redirect, a code, a pairing
code, a set of fields, a third party's own widget, or a notice that says what
is happening while nothing is being asked.

Three properties follow, and each replaces a specific failure.

**A flow can ask twice.** The old shape was one call handed a fixed set of
callbacks, so a provider that needs a country before it can name a bank had to
smuggle both questions in as _source settings_ — collected on a form about
configuration and stored as though they configured something.

**A challenge carries its own words.** A pairing code is just a string, so the
sentence telling the operator what to do with it had been written into the
shared client, naming one particular application. Under source encapsulation
that branch could never have been correct; the second source needing a pairing
code would have found the wrong sentence already on screen.

**A challenge says whether it expects an answer.** `show` and `ask` produce the
same event carrying the same fields, so a client cannot tell them apart from
the challenge alone — and it has to, because offering a way to answer where
nothing is listening is worse than offering none: the operator types into a
flow that then hangs until it expires. The event carries the distinction.

Where a redirect lands is a separate question from who answers it. `via` says
which machine's browser has to be the one that completes the sign-in, which is
what a client warns about; whether an answer may come back through the session
is `show` versus `ask`. Keeping those in one field ruled out the shape every
OAuth provider here actually has: a listener on the collector's machine, raced
against an address pasted from a browser somewhere else.

**A flow can ask what the client can draw.** Every kind but one renders
generically. A hosted widget names a renderer the client must already have been
built with, and the client most likely to be on the other end of a first
connection is a terminal, which cannot draw one at all. The older shape caught
this by the absence of a callback; a session always offers `ask`, so the guard
had to become a question — `canShow(kind)` — and a provider that needs a kind it
cannot have refuses at once instead of waiting out a timeout. A client that
declares nothing is read as drawing only a redirect and a QR code, the two
kinds with a legacy transport.

**A flow can succeed and still have something to say.** It returns or it throws,
which leaves nowhere for a step that could only be taken once and was not, on an
account that is otherwise connected — an open-banking history capture whose
window is minutes wide, say, whose failure costs every record older than three
months. A result carries notices, and a client shows them beside the success,
because an operator told only "connected" has no reason to look again.

**A failure says what class of thing went wrong, and what to do about it.** The
code is what a client switches on; the remedy is the sentence only the source
can write. For a platform with no account chooser, "sign out in your browser
first" is not advice — it is the entire recovery, and no enumeration can carry
it. The codes are chosen so that each one changes what a client does or what an
operator reads: a credential the operator supplied and that is not usable is
not a person refusing, an untrusted certificate is not a platform that might
come back, and a port taken on this machine is not the platform being
unreachable. Which side did the refusing is deliberately not a distinction the
codes make — a key the platform revoked and a key whose permissions the source
will not hold are one code, because a client does the same thing with both: it
asks again. Two of those distinctions
exist because the codes they replace were classified as not worth retrying when
the retry was the whole remedy.

The call stays resident for the whole exchange. That is not an oversight: a
pairing that holds a socket, and a redirect caught on this machine, have
nowhere else to live. What a step machine would have bought — resumability
across a restart — is not something either could have used.

### Two types for one challenge

A field challenge is declared with the same schema a source uses for its
settings, which is a parser and cannot be serialised. What a client needs from
it is the form to render, which is data. So the authoring type carries the
schema and the wire type carries the derived form, and the answer is checked
against the schema on the host — the boundary that decides, because a client is
not the only thing that can post one.

## What this contract deliberately does not do

- **Write-back.** Updating upstream data needs authorization, confirmation,
  idempotency and conflict semantics. It is a separate capability and must not
  arrive inside ingestion.
- **A plugin sandbox.** Scoping the host object is an authority boundary, not a
  security boundary: in-process code can still reach the filesystem and the
  network. The trust model is published rather than implied. Real isolation
  needs a process boundary and is a separate project.
- **Exactly-once delivery.** The host cannot force an external API and two local
  databases into one transaction. What is promised instead is precise:
  replay-safe effects, and a checkpoint that only advances once every required
  output is durable.
- **Cross-store atomicity.** Documents live in SQLite and rows in DuckDB. A
  batch is a durable checkpoint boundary, not a distributed transaction. If
  readers ever need to see every output of a batch at once, that is a separate
  feature with staging and a publication barrier.

## Compatibility posture

Every provider package lives in this repository and the project is not yet
public, so a change to the _author-facing_ surface needs no adapter and no
deprecation window: all providers migrate in the same change.

The other two boundaries still bind:

- **Saved installations.** Cursors, config, credentials, IDs and local stores
  must survive an update. Migrations are explicit and restart-safe. A resync is
  not a migration.
- **Devices.** Collectors, phones and the browser extension update on their own
  schedule. Old wire formats stay accepted, and new behaviour is gated on
  advertised capabilities until every supported client has caught up. The device
  socket's `PROTOCOL_VERSION` requires an exact match and closes the connection
  on a mismatch, so it is not bumped for anything in this contract.
