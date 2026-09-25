# Omnesis engineering conventions

This is the reference for the cross-cutting architectural patterns the codebase has settled on. Read it first when you are about to establish, or imitate, a repo-wide pattern.

When you establish a new cross-cutting pattern that future code should imitate, **add a row here in the same PR**. When you change a canonical-example file path (rename, split, move), update the row.

The doc has three layers:

1. **Patterns** — the _what_ and _why_ of each convention.
2. **Canonical examples** — for each pattern, the file future code should imitate.
3. **Enforcement** — what the toolchain catches automatically vs what review is relied on to catch.

---

## Layer 1 — Architectural patterns

### Nx selects logical work; host dispatchers admit physical work

Nx is the repository authority for workspace dependencies, affected projects,
task ordering and deterministic local cache hits. `scripts/nx/checks.mjs` adds
the behavioral edges a TypeScript import graph cannot see, including HTTP,
subprocess, fixture, E2E and native-client contracts. Its plan includes the
merge-base diff and all staged, unstaged, untracked, deleted and renamed paths.

Task commands keep the existing queue boundary. A cache miss enters the
matching shared-host or native lane, while a cache hit does not reserve a host. Queued
commands carry a tree fingerprint and reject evidence if their checkout changed
after planning. Stateful E2E and native work is not cached. Full main CI always
bypasses test-result caches and checks out one pinned requested revision across
every lane.

- Canonical plan and runner: `scripts/nx/checks.mjs`
- Behavioral boundaries: `scripts/nx/bundles.mjs`
- Workspace target inference: `scripts/nx/project-plugin.mjs`
- Dirty-tree identity: `scripts/nx/tree-state.mjs`

### `defineSource()` over `class … implements Source`

Source providers expose a `defineSource<Cursor>({...})` factory call rather than implementing a `Source` interface — there is no such interface; structural typing on the descriptor object is the contract. Compact providers (Things, Browser History) live in a single `index.ts`; larger providers (Apple, Google) compose sub-modules behind the descriptor.

- Helper: `packages/source-sdk/src/define-source.ts`

### Fresh local-source access evidence

Local source instances implement `probeReadAccess({ signal })` for collector health
checks. Providers own input selection and bounded discovery; shared collector code
dispatches the hook without source-name branches. Probes run in the daemon process,
fresh-open inputs read-only, and close handles without reading indexed content, copying
stores, syncing, or changing cursors. Providers may read bounded discovery metadata to
select current inputs, but never include that metadata in reports or logs. Cached input
rosters must not silently omit newly eligible inputs. Cached sync status and handles are not
current permission evidence. Missing inputs, discovery limits and deadlines remain
unverified. The collector bounds concurrency and retains timed-out in-flight ownership
until the probe settles, so repeated health requests cannot multiply stuck operations.
The SDK file helper uses asynchronous open/stat and main-thread close to avoid releasing
process-owned POSIX locks during an eager SQLite statement. It is not suitable unguarded
for readers holding transactions or iterators across awaits, or accessing the same inode
on other threads; those providers must coordinate probe and reader ownership.

- Contract: `packages/source-sdk/src/define-source.ts` (`SourceInstance.probeReadAccess`)
- Dispatch: `packages/collector/src/doctor-read-access.ts`

### Recovery belongs to the private SQLite copy

Local SQLite consumers that cannot read a locked store use
`openReadonlySqliteSnapshot` from core with their own driver's factory. The helper
copies present sidecars, refuses observed concurrent changes after bounded retries,
rejects external super-journal references, recovers only the owner-private copy,
then reopens it read-only. Its cleanup owns both handle and scratch directory.
Filesystem metadata checks detect ordinary races but are not an atomic-snapshot
guarantee; failed capture or recovery is unreadable input, never evidence of absence.
A capture the source kept changing out from under raises
`SqliteSnapshotChangedError`, which a consumer reports as a `transient` failure:
nothing is wrong with the store, no operator action would help, and the next
cycle is likely to win. Do not open the original writable or use immutable mode
to bypass journal recovery.

### One declaration for a source's settings

A source that needs something from the operator declares it once, as data,
with `config: config.object({...})`. Three things are derived from that one
statement: the form every client renders, the validator the host runs, and the
parsed type `create()` receives. Writing any of them out by hand means keeping
them in step by hand, and nothing checks that you have.

The division of labour is what makes the declaration work across a wire. A
constraint is data — a pattern, a range, a path that must exist and contain
something — so it survives serialisation and can be explained to an operator
before anything runs. A check that genuinely needs the host's filesystem is a
`check` hook that never leaves the host. And a path is resolved once, by the
host, before the value reaches the factory: a source that expands its own
paths is one forgotten call away from failing to open a path its own validator
just approved.

Scope is the part a general-purpose form library could not carry. A
source-scoped setting is shared by every device hosting the source; a
member-scoped one describes one host's local environment, and stays there.

- Helper: `packages/source-sdk/src/config-schema.ts`; the host's filesystem is
  `packages/source-sdk/src/path-probe-node.ts`

### Façade pattern for monolith splits

When a module crosses ~600 LOC or accumulates 5+ unrelated responsibilities, split it into focused collaborator classes / modules and keep the original file as a **thin façade** with unchanged public signatures. This preserves caller import edges (zero churn outside the module) while making each collaborator independently readable, testable, and reviewable.

The façade file's header doc must:

- Name each collaborator and what concern it owns.
- Restate that the public surface is unchanged.
- Point at the underlying modules for new contributions.

Files that follow this shape: `packages/gateway/src/analytics-db.ts`, `packages/gateway/src/scheduler/scheduler.ts`, the `admin` HTTP routes under `packages/gateway/src/http/routes/admin/`, `packages/providers/apple/src/provider.ts`, and `packages/collector/src/sync-engine.ts`.

### Subpath exports / multi-package boundary

`@omnesis/core` is bisected two ways. First, `exports` subpaths (`/protocol`, `/config`, `/sources`, …) let a consumer import a narrow slice. Second, `@omnesis/types`, `@omnesis/config`, and `@omnesis/source-sdk` are physically separate workspace packages, so providers don't pull the gateway-only surface, and the HTTP/WS client lives in `@omnesis/gateway-client`. Re-export shims in `@omnesis/core` still preserve the old import paths for back-compat.

**New code should import from the narrowest package**, not `@omnesis/core`: branded IDs / document model / device + pagination from `@omnesis/types`; the zod config schema + `OmnesisConfig` + `*Settings` from `@omnesis/config`; `defineSource` / `Source` / `Provider` / `GatewayClient` + the source-descriptor surface from `@omnesis/source-sdk`; `HttpGatewayClient` / `GatewayWsClient` from `@omnesis/gateway-client`. Reserve `@omnesis/core` for genuinely cross-cutting helpers (`createLogger`, `computeContentHash`, the WS-envelope protocol, TOFU). When you add a type or helper, place it in the _smallest_ package that satisfies its consumers — don't default to `@omnesis/core`.

Re-export shims must use **explicit named re-exports** (`export { X } from …`), never `export *` — vite/vitest can't follow `export *` across workspace-package boundaries, so a `export *` shim type-checks but resolves to `undefined` at vitest runtime.

### HTTPS trust during pairing

Pairing V4 carries an explicit TLS policy. A public HTTPS origin can use `system`, which requires HTTPS and normal platform WebPKI and hostname verification. A private gateway with its auto-generated self-signed certificate uses `pinned-leaf`; its SHA-256 fingerprint travels in the pairing QR and the native clients validate it on every connection. V1-V3 remain decodable for compatibility, with V3 interpreted as pinned-leaf trust. The collector and CLI consume a private gateway's certificate via `NODE_EXTRA_CA_CERTS`.

The issuer may emit system trust only for an exact configured HTTPS origin; never infer it from a caller-supplied URL. Current QR issuers request the gateway's `auto` policy: the installer's `OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN`, an exact `gateway.publicBaseUrl` origin, or a `gateway.pairingSystemTrustOrigins` entry emits system trust, while every other address retains the pinned-leaf compatibility path. The installer sets its origin only after `tailscale cert` succeeds and removes it when it hands TLS to mkcert or an operator-managed certificate. Omitted policy remains V2/V3 for older issuers. Native transport construction, the persisted trust mode, the iOS ATS policy, pinned-session plumbing, and the cert SAN list generated in `packages/gateway/src/tls.ts` must stay in sync.

### Secret-store abstraction and wrapped secret files

Code that persists Omnesis root keys must go through `packages/core/src/secret-store.ts`, not direct `security`, `secret-tool`, Keychain, or libsecret calls. The abstraction deliberately stores named opaque strings only, never enumerates secrets, and reports whether the selected backend is OS-backed. `auto` resolves to macOS Keychain on Darwin and Linux Secret Service on Linux; the owner-only file backend exists only for explicit fallback/testing and must not be presented as equivalent security.

Code that persists local credential/token/auth-state files under the config tree should use `packages/core/src/secret-file.ts`. The helper keeps plaintext read compatibility, but writes a root-key-wrapped AES-GCM envelope when the install root key exists. Config-owned secrets that must be referenced from `omnesis.json` use `packages/core/src/config-secrets.ts` so the config carries a stable `config-secret:` reference instead of the value. `keyring init`, `keyring migrate`, and encrypted secret-file writes set a non-secret config marker; after that, writes fail closed if the root key is unavailable rather than creating or downgrading to plaintext. The associated data is the config-relative path by default; pass an explicit scope only for a logical secret that is not path-addressed. Do not add provider-local crypto wrappers or direct OS keyring reads.

Live random-access stores should use `packages/core/src/storage-keys.ts` for per-store data-encryption keys wrapped by the install root key. Gateway SQLite and index SQLite use `packages/gateway/src/sqlite-encryption.ts`; DuckDB attaches through the analytics connection pool; provider-owned stores such as WhatsApp read the named storage key and fail closed once live-storage encryption is required. Large generated artifacts, such as backups and exports, should use `packages/core/src/encrypted-artifact.ts`. It streams a root-key-wrapped binary AES-GCM envelope and leaves files plaintext when no install root key exists, preserving upgrade compatibility. Use it for generated output only; do not wrap live random-access SQLite, DuckDB, or vector index files with this format.

- A wrapped secret file is **read and rewritten**, never renamed or byte-copied to a new path. The file's config-relative path is its AEAD scope (associated data + key-derivation info), so a relocated envelope fails authentication and reads as though the secret had vanished.
- Canonical: `packages/core/src/secret-store.ts`
- Wrapped files: `packages/core/src/secret-file.ts`, `packages/core/src/config-secrets.ts`, `packages/core/src/storage-keys.ts`, `packages/core/src/encrypted-artifact.ts`
- Operator surface: `packages/cli/src/commands/keyring.ts`, `omnesis doctor` (CLI) and the portal's Debug → Doctor tab
- Host security posture collection: `packages/core/src/doctor/security.ts`, shared by both surfaces; unit paths it reads back come from `packages/core/src/service-paths.ts`

### Private temporary native-reader inputs

Native readers that need plaintext files use `createPrivateScratch()` from
`@omnesis/core`. Keep files owner-only and clean up only after all readers and
workers stop; a worker's parent owns scratch when cancellation terminates the
worker. Recovery removes only scratch owned by processes known to have exited,
never by age. This is bounded plaintext exposure, not secure erasure. Database
copies retain their required SQLite sidecars; source originals remain read-only.

- Shared helper: `packages/core/src/private-scratch.ts`
- SQLite snapshots: `packages/core/src/sqlite-snapshot.ts`
- Worker lifetime: `packages/providers/whatsapp/src/import/importer.ts`
- Storage inventory and limitations: `docs/collector-storage.md`

### Transient-buffer pattern for unbounded provider state

When a provider library forces state into your process (chat-history libraries, browser-history snapshots), reframe that state as a **drain-and-GC buffer** between the upstream library and the gateway, not a permanent in-memory store. Drain events to gateway documents, then GC the buffer after a TTL. Persistence lives in the gateway DB, not in the provider's volatile process.

- Canonical: `packages/providers/whatsapp/src/message-store.ts`

### Local coding-agent transcripts use source-native adapters

Each coding-agent provider owns its native file paths and JSONL parser. The shared
`createLocalAgentSessionSource()` module owns streamed file reads, incremental paging,
conservative snapshot reconciliation, and per-session local-day documents. Provider adapters emit
only human prompts and completed assistant replies. They exclude tool traces, hidden reasoning,
system context, and automatic subagent sessions.

- Shared module: `packages/source-sdk/src/local-agent-sessions.ts`
- Canonical adapter: `packages/providers/pi/src/index.ts`

### Per-row write epochs fence overlapping syncs

Each collector sync claims a write epoch on its cursor row before it reads the source cursor — the
shared row for a single-host source, the device's own row for a member of a replicated or
partitioned source. It sends that same epoch with every document and analytics page in the run. A
newer attempt on the same row advances that row's epoch. A source wipe advances every row; a stream
wipe, a member's cursor reset, or a member's detach advances that member's row only (a re-home
advances every former member's row and leaves the gaining device's alone) — the row is
kept, never deleted, so a re-join claims past the epoch a sync in flight still holds. The gateway
rejects stale pages before they can change documents, analytics, or the cursor. Snapshot victim
deletion and cursor advance share one writer transaction. Every multi-store source wipe acquires a
source-exclusive umbrella before its first mutation and holds it through document, index, and
analytics cleanup. A stream wipe does the same on its exact member row; a provider wipe uses the
global umbrella. This also blocks a cursor row or source first seen after the wipe starts, which a
snapshot of the rows present beforehand could not do. Multi-source HTTP document ingest acquires its
exact rows together through `SourceWriteEpochFence.runAll`.
Lease grants and releases use that same source-exclusive barrier (device-wide
release uses the global barrier). HTTP admission may acquire a vacant handoff
lease, but documents and analytics re-evaluate deletion authority after entering
their write fence, and hold the fence until the store commit finishes. A queued
page cannot spend its former holder's authority, and a successor cannot acquire
authority halfway through its predecessor's commit. Renewal does not change the
holder and stays inside the admitted page; expiry alone never transfers a lease.
When a replicated source's lease holder applies an explicit tombstone for an item nobody has
deleted before, every sibling cursor is reset and advanced. Document tombstones do that in their
SQLite page transaction. Analytics tombstones hold every cursor-row fence and reset the sibling
cursors inside the DuckDB transaction before it removes the exact victims; a failed reset rolls
the DuckDB transaction back. The siblings' next syncs bootstrap from their local replicas,
repairing a deletion made from an incomplete view, while pages already in flight are rejected on
their old epochs.

That reset happens once per item while its history is kept. Both planes record each
member's verdict on an item another member deleted in `replica_deletion_claims` — `deleted` or
`restored`, one row per (item, member). A sibling whose bootstrap brings the item back makes it
**disputed**: it stays, later tombstones for it (from the holder or any member) are recorded and
stripped so the page still advances, and nobody is reset. The item is deleted once every member
that restored it has itself reported the deletion — by a tombstone, or by its own corroborated
snapshot omissions; a deleter that contributes the item again withdraws its verdict; a
member sent back to bootstrap withdraws its restores and re-vouches for what it still holds; a
member that detaches takes its verdicts with it. Deletions the gateway infers from snapshots
follow the same rule: `document_absences.observed_by` remembers whose snapshot marked each
absence, the sweep records its deletion of a replicated item as that member's verdict and leaves
a disputed item alone, and a restorer's own snapshots omitting an item it keeps alive count on
its `restored` row under the absence policy's two currencies (spaced observations, elapsed age)
before they become its verdict — one snapshot alone never deletes anything. For that to work the
collector sends every member's snapshot, lease or no lease; the gateway reconciles only the
holder's and reads the others for the items they keep alive. Analytics rows go through the same
ledger under the namespace `analytics:<table>`, keyed by the value a tombstone names
(`AnalyticsReplicaClaimRepository`): because the rows live in DuckDB, the verdicts run as small
writer operations that the DuckDB page and the absence sweep call from inside their own
transactions, so a verdict is durable before the rows it concerns change and a failure rolls the
page back; `_analytics_absences.observed_by` attributes row absences the way
`document_absences.observed_by` does, and a fresh row deletion a non-holder names is answered with
`deletionDeferred` so the collector replays the tick rather than advancing past it. The rule is
"restore wins until every restorer agrees" because the gateway cannot tell a stale sibling from a deleter
with an incomplete view, and the common case — a replica that has not yet received the deletion —
converges by itself. Uncontested histories are retired after seven days, once no member is mid-
bootstrap, so the ledger does not grow with every deletion ever made; a restore that arrives
after that costs one more delete-and-reset cycle before it is recognised as a dispute. Disputes
are counted on `GET /admin/sources` (`disputedDeletions`), on the holding member's sync status
(`restoredClaims`), and in `omnesis doctor`. The operator's own `DELETE /documents/:id` ends a
dispute.

- Ledger: `packages/gateway/src/data/repositories/ReplicaDeletionClaimRepository.ts`
- Verdicts applied: `packages/gateway/src/data/repositories/DocumentRepository.ts` (`upsertWithCursor`)
- End to end: `packages/collector/src/e2e/replica-deletion-dispute.e2e.test.ts` (tombstones) and
  `packages/collector/src/e2e/replica-snapshot-dispute.e2e.test.ts` (snapshots only)

The database table and wire field keep the legacy `wipeEpoch` name for compatibility. New code
must treat it as write authority for one attempt on one row, not only as a wipe counter.

- Claim: `packages/gateway/src/http/routes/documents.ts`, `packages/collector/src/source-sync-runner.ts`
- Document fence: `packages/gateway/src/data/repositories/DocumentRepository.ts`
- Analytics fence: `packages/gateway/src/http/services/AnalyticsService.ts`
- Source-wide purge: `packages/gateway/src/http/services/SourceDataRemovalService.ts`

### Routes only call services; workers don't reach into wrappers

HTTP route handlers are 3–5 line adapters: parse body, call the matching method on a domain service, map the result. They do not import repositories, the writer queue, or the scheduler directly. Compute workers consume a typed port (`IComputeScheduler`, defined in `packages/gateway/src/http/services/ports.ts`) — they don't dereference the surrounding scheduler instance.

### Single canonical `ListedDocument` projection

The shape that comes out of `/documents` and the shape the indexer consumes are the **same type** — `ListedDocument`, exported from `@omnesis/source-sdk` and produced by a single `toListedDocument(row)` mapper. No per-package DTO re-derivations.

- Canonical mapper: `packages/gateway/src/data/document-mappers.ts`
- DTO doc: `packages/gateway/src/http/dto/document-dto.ts`

### Typed worker dispatch + typed WS message registry

The writer/compute worker protocol uses a typed dispatch table derived from `WRITE_OP_DEFS` / `COMPUTE_OP_DEFS` rather than `{op: string; args: unknown[]}`. A handler that isn't registered is a compile error, not a runtime "op not found". Same shape for the WebSocket message contract: `WsMessageRegistry` is a type-level map keyed by message type with payload + response + event schemas, all zod-validated. `PROTOCOL_VERSION` in the hello frame is bumped whenever the registry changes shape.

- WS registry: `packages/core/src/ws-messages.ts`
- Worker dispatch: `packages/gateway/src/workers/protocol.ts` + `packages/gateway/src/scheduler/write-ops.ts`

### A separately deployed protocol is a negotiated range, not a pin

Where the two halves of a wire contract ship on their own schedules — the gateway on one machine, an agent-integration plugin somebody installed once on a harness host — the contract is a **range**. Each side exports two constants, the oldest version it still speaks and the current one, advertises both in its handshake, and builds every payload at the highest version both understand. An older peer keeps working without the fields it has never heard of; a newer one gets them without waiting for its counterpart to be reinstalled.

A schema pinned to a single literal is what this exists to avoid: it makes every contract change an outage for whichever half deploys second. So a versioned payload is a discriminated union over the versions in the range — one strict object per version, each naming its own `protocolVersion` literal — rather than one object whose new fields are optional. Two rules follow. A control frame that follows a payload states the version that payload was built at, so a commit never arrives claiming a dialect its own prepare did not use. And where the same range is declared twice — once in the gateway, once in a standalone plugin package that deliberately imports nothing of Omnesis — the two declarations are held equal by a test rather than by an import.

Upgrade order is not symmetric: the side that _parses_ a handshake must be upgraded first, because an older parser rejects a newer advertisement outright and the peer reconnects against that refusal in a loop.

- Range + negotiation: `packages/gateway/src/subscriptions/delivery.ts` (`negotiatedDeliveryProtocol`)
- Wire schemas: `packages/core/src/ws-messages.ts`; the standalone plugin's copy in `packages/agent-integration/src/protocol.ts`
- Guard over the restated copies: `packages/agent-integration/src/wake-contract-parity.test.ts`

Collectors verify the gateway's `capabilities.sourceContract` range before startup,
source/auth command dispatch, and every HTTP request attempt, including retries.
The verdict is not cached across requests because a gateway can be replaced while
its collectors remain running. Device update and doctor commands stay reachable
for repair. This adds one health request per API attempt; it is a preflight check,
not an atomic binding between the health response and the following request.

- Source wire range: `packages/core/src/source-contract-wire.ts`
- Transport guard: `packages/gateway-client/src/source-contract.ts`

### Agent terminal results own success and retryability

An agent turn's authoritative outcome is the final `agent.message.end` payload,
not an earlier `agent.error` event and not the presence of assistant text.
`message.end.failure` carries the stable code, safe message, backend/model
identity, and retryability; its sibling context assessment records both token
measurement provenance and context-limit provenance. Every backend reports a
trustworthy assessment or explicitly reports `unknown`.

Interactive conversations persist context exhaustion outside `ChatMessage`
history and become read-only. Background workflows classify the terminal result
and settle non-retryable failures; they must never infer success from a resolved
stream, placeholder text, or a partial response. Context/error notices are not
inserted into model-visible history.

- Wire contract: `packages/core/src/agent-protocol.ts`
- Session normalization: `packages/agent/src/session.ts`
- Machine classifier: `packages/agent/src/turn-outcome.ts`

### A credential gate answers from the credential, a sync failure from the failure

`credentialState()` says what state an account's credential is in. The
collector reads it before every sync tick, and a state that blocks parks every
source under the account in `needs-auth` and pushes a re-auth reminder to the
operator's devices — so it must answer from the stored credential, never from
whether a request just succeeded. A live probe cannot tell "the service is
unreachable" from "the user revoked us", which makes every network blip and
every upstream outage a re-auth prompt that re-authorizing would not fix. A
provider whose SDK refreshes silently may let it, but only if it can name the
failures that mean "the user must come back"; every other failure leaves the
credential connected.

A state rather than a boolean because the interesting cases are the ones a
boolean cannot carry. A credential that cannot be read — a locked keyring, an
unmounted volume — is `unknown`, which is a failure to answer the question
rather than an answer, and does not park anything. A grant that is alive but
too narrow is `scope-insufficient`: nothing has failed, so the source keeps
reaching what it can reach. And a grant with a deadline stays `connected` and
names the deadline, so a host can warn before it lapses instead of discovering
it afterwards. Each state is named for the remedy, because that is the only
thing anyone downstream does with the answer.

Credentials that have genuinely stopped working are a sync concern. Providers
map their SDK's errors to a typed `SyncError` at the sync boundary, so the
collector classifies on evidence instead of pattern-matching prose — an
untyped auth failure whose message names neither the status nor the condition
lands in `unknown` and reaches the operator as a generic error with no
remedy attached.

A failure that will not clear until the operator acts on the collector's host
— an access grant the OS keys on the executable and never prompts for — is
raised with a structured `SyncRemediation` beside its message (`summary`,
`steps`, `executable`, `restartRequired`). The collector ships it on
`sync.status`, the gateway persists it beside `last_error` and serves it on the
display status, and the portal, `omnesis status` and the doctor render it as
the row's affordance in place of the raw message; the prose form is derived
from it (`formatSyncRemediation`) so a log line and the card never disagree.
Shared code names no source and no OS grant: the provider that recognised the
condition authors the remedy (`fullDiskAccessRemediation` in `@omnesis/core`
is the one macOS builder every local-database provider and the installer share).

- Offline gate: `packages/providers/granola/src/index.ts`, `packages/providers/strava/src/index.ts`, `packages/providers/notion/src/index.ts`
- Named-failure gate: `packages/providers/outlook/src/provider.ts` (`needsUserInteraction`)
- Error mappers: `packages/providers/google/src/api-error.ts`, `packages/providers/notion/src/api-error.ts`, `packages/providers/apple/src/db-helpers/internal.ts` (a local store rather than an API: a refused read becomes `permission`, a locked one `transient`)
- Structured remedy: `packages/types/src/sync-error.ts` (`SyncRemediation`, `formatSyncRemediation`), `packages/core/src/sync-remediation.ts` (`fullDiskAccessRemediation`, `syncRemediationSchema`)
- Consumer: `packages/collector/src/sync-dispatcher.ts`, `packages/collector/src/error-classifier.ts`

### A connect flow shows things and asks things

`authenticate(session)` is how a source connects an account. The session offers
two primitives: `show` puts something in front of the operator and returns,
`ask` puts something in front of them and waits for the typed answer that
challenge produces. Everything else is a challenge kind — a redirect, a code, a
pairing code, a set of fields, a third party's widget, or a notice that says
what is happening while nothing is being asked.

Two rules follow from source encapsulation. A challenge carries its own title
and instructions, because a client composing that sentence would need a branch
per source; if a platform's name appears in the portal or the CLI, that is the
bug. And a value the operator supplies is asked for rather than pre-collected,
so a re-authentication whose stored credential is the very thing that stopped
working can ask for a new one instead of failing.

A field challenge is declared with the same schema a source uses for its
settings. That schema is a parser and cannot cross a wire, so the wire form
carries the derived form instead, and the answer is checked against the schema
on the host — the boundary that decides, because a client is not the only thing
that can post one.

The call stays resident for the whole exchange. A pairing that holds a socket,
and a redirect this machine catches on loopback, have nowhere else to live.

- Contract: `packages/source-sdk/src/auth-session.ts`
- Session implementation: `packages/collector/src/auth-subprocess.ts`
- Generic rendering: `packages/gateway/portal/js/components/auth-flow.js` (`ChallengeStep`), `packages/cli/src/auth-flow.ts` (`renderChallenge`)
- Examples: `packages/providers/github/src/provider.ts` (fields), `packages/providers/whatsapp/src/index.ts` (a code nobody answers)

### The writer is one thread: keep work off it, and keep it interruptible

SQLite admits one writer, so the gateway funnels every write through a single
worker. That worker is therefore the gateway's one point of contention: while
it is busy, every other write on the machine waits — a phone note, a collector
sync, the creation of an answer task. Two rules follow, and both have been
learned the expensive way.

**Resolve on a reader; hand the writer finished rows.** A lookup inside a
writer transaction charges the whole gateway for it. Link resolution did this
for non-url link types on the reasoning that the lookup was cheap and in the
same transaction — true until a source arrived emitting hundreds of
`references` links per document, at which point one document became one
transaction holding the write lock for seconds, and minutes under load. Do the
reads on the io read handle, pass the results through, and guard the gap:
carry the source row's `content_hash` for optimistic concurrency, and make any
foreign key you write `EXISTS`-guarded, because a target found on a reader can
be deleted before the writer applies it. An unresolved row is recoverable; a
dangling one is not.

**Bound the work, not just the batch.** A writer op that iterates must commit
in sub-batches and check its preempt token between them, so its unit of
lock-holding is a fixed number of rows rather than however many one input
happens to carry. Stamp any "this is done" marker only after the last
sub-batch, so an interrupted item is redone whole rather than mistaken for a
finished one.

The same discipline applies to reads that run on a shared io worker: a query
whose filter is an expression no index can serve (`COALESCE(merged_into, id)
IN (…)`, `LENGTH(content)`) does work proportional to the table, not to the
batch, however small the batch is. Resolve the batch to concrete ids first and
read through an index. Where the plan is load-bearing, pin it (`CROSS JOIN`,
`INDEXED BY`) and assert it in a test: both shapes return the same rows, and
only the plan says what it cost.

**A new source is a new load.** A source that emits an unusual number of links,
people or documents per item changes the arithmetic every consumer of that data
assumed. Before enabling one, look at what it costs the writer.

### A DuckDB store is opened once per process, and once per machine

DuckDB guards its database file with a POSIX record lock, and POSIX record
locks belong to the process, not to the handle that took them: closing _any_
other handle to the same file, anywhere in the process, releases every lock
the process holds on that file. The analytics writer therefore loses its
exclusive lock the first time anything else in the gateway opens the same file
— a per-query sandbox instance, a probe, a backup taken through a second
handle, or a user query calling `read_blob` on the store's own path — and
keeps writing without noticing. From then on a second process can open the store read-write,
and two writers checkpointing over each other's blocks lose rows first and
leave a file that no longer opens with its own key eventually.

Two rules follow. **One instance per store.** Everything that touches
`analytics.db` in the gateway goes through `AnalyticsConnectionPool`'s single
instance — user SQL is one prepared SELECT whose syntax tree DuckDB's own
parser has vetted for file functions, on a dedicated connection inside a
read-only transaction, with external access disabled instance-wide and an
allow-list naming only the store's own files and its spill directory (where
backups and exports are staged before they move). Never open the file again
in-process, not for a probe and not for a backup; the pool has a method for
each. **One gateway per config dir.** The
gateway takes `gateway.lock` in its config dir before it opens any store and
refuses to boot while another live gateway holds it, so a duplicate process
never reaches the stores.

A DuckDB error that names the key ("Computed AES tag differs", "could not be
opened with the configured encryption key") is what a damaged block looks like
too. Surface DuckDB's own words and keep the file: the analytics store holds
rows nothing else can rebuild.

### A snapshot is a claim, and only a complete read may make it

`SyncResult.presentExternalIds` — and its structured twin `presentIds` — is a
source asserting _this is everything I hold_. The gateway acts on the assertion
by deleting every document it stores for that source that the assertion does not
name. So a snapshot assembled from a read that skipped an address book, a
repository, an account or a page is not a smaller snapshot; it is an instruction
to delete whatever the skipped part of the read would have contained.

The two outcomes are not symmetric, and that asymmetry is the whole rule.
Withholding costs one cycle of deletion detection: nothing is removed, the next
tick tries again, and a deletion that happened meanwhile is found then. Emitting
a wrong one costs the corpus, and nothing upstream puts it back.

Build the snapshot through `SnapshotEnumeration`. It is declared with the
partitions the source **discovered**, ids enter only through `cover()` — a claim
that one named partition was read in full — and `result()` returns `undefined`
unless every discovered partition was covered. That last rule is what makes
_forgetting_ safe: a partition dropped by a bare `continue`, a swallowed
exception or a branch nobody thought about is never covered, so it holds the
snapshot back rather than silently shrinking it. Two further defaults come with
it. Discovering no partitions at all withholds — an address book that has moved
and an address book that is empty are not the same fact — while an _empty_
partition that opened and holds nothing is covered with no ids, which publishes
`[]` and reconciles the source to zero.

That last point is the line the class is drawn along, and it is worth stating
because the tempting mistake is on the other side of it. A source withholds when
it **knows it did not look everywhere**; it does not withhold because the answer
looks too small. It cannot judge that — it has no idea how many documents the
gateway holds — and a magnitude veto here does not delay a suspicious deletion,
it cancels one: a withheld snapshot tells the gateway nothing, so nothing is
marked and no deadline runs. An operator who empties a source would find Omnesis
still holding it, which is a privacy failure worse than the bug such a check
guards against. Magnitude belongs to the gateway, which marks absent documents
with a deadline and corroborates across reads before deleting.

Withholding is all-or-nothing, though, and for a source with several backing
stores that is a steep price: one address book that will not open suspends
deletion detection for the two that did, for as long as it stays broken — which,
for a revoked permission, is until someone notices. Such a source can narrow the
assertion instead. `claims()` returns one entry per partition that _was_ read in
full, and `SyncResult.presentClaims` carries them; the gateway judges only the
documents belonging to a claimed partition and leaves the rest untouched.

The two halves of that have to agree. A claim names a partition; a document
belongs to one because the source stamped `DocumentInput.partitionKey` with the
same name. A claim on a partition whose documents carry no key names nothing, so
the deletions the source is asking for silently never happen — which is why the
snapshot-contract test requires a package emitting `presentClaims` to stamp
`partitionKey` somewhere. Setting `presentExternalIds` and `presentClaims` on one
page is refused rather than resolved: a complete read vouches for the whole
source, including documents stored before the source had partitions at all, and
claims are the degraded cycle's form.

Where a source cannot use the class — an accumulator carried across sync calls,
say — the same discipline applies by hand: every skip poisons a flag, and the
flag suppresses the emission.

- Seam: `packages/source-sdk/src/snapshot.ts`
- Canonical adopter: `packages/providers/apple/src/contacts.ts`
- Hand-rolled equivalents: `packages/providers/notion/src/databases.ts` (`snapshotDirty`), `packages/providers/github/src/commits.ts` (`snapshotIncomplete` + a plausibility floor)
- Guard: `packages/source-sdk/src/snapshot-contract.test.ts` + `snapshot-emitters.json`
- End-to-end: `packages/collector/src/e2e/snapshot-absence.e2e.test.ts`

### An analytics table declares how its rows are addressed

A delete, a snapshot, the arrival that clears a pending absence and a replica's
verdict on a deletion all name a row, and three of them record what they named
in a ledger keyed by one text column. So the name has to be a string, the same
string wherever it is derived, and — for the tables that have always had a
one-column key — the string those ledgers already hold.

`AnalyticsTableSchema.deleteKey` declares the columns that name a row,
defaulting to the primary key. It lives on the table rather than on the page
because it is the key space every ledger built on that table records under: a
page free to pick its own column can address one table two ways, and the
ledgers then hold keys from both with nothing to tell them apart. A key coarser
than the primary key is legitimate and means a group — a source that re-reads
an activity names the activity, not each of its comments — and saying so at the
declaration is what makes the blast radius visible where the table is defined.

Pages name rows as records over that key (`TableWrite.deletedKeys`,
`presentKeys`); the single-column spellings normalise into them at one seam,
and both on one write is refused rather than merged. `encodeRowKey` is the
canonical text form: one column encodes to the bare value, so no stored key
changes meaning, and a wider key to a JSON array in the declared order, which
distinguishes tuples a joined string cannot. `rowKeyExpr` is the SQL half, and
the pair is checked against each other over real rows — a difference between
them is a delete that removes nothing and an absence nothing ever clears.
At the gateway, `encodeTypedRowKeys` casts wire values through the declared
SQL column types before encoding them. The same path names arrivals, snapshots,
tombstones and replica verdicts, preserving timestamp precision and numeric
representations without duplicating DuckDB's coercion rules in JavaScript.
Structured or missing tuple-key values are rejected at the boundary.

A producer that predates the declaration keeps working: a page naming a column
for a table that declares no key adopts it as that table's key and records the
adoption, after which a page naming a different column is refused. Keys left
under a key space the table no longer uses are dropped when a snapshot next
reconciles it.

- Contract: `packages/source-sdk/src/table-write.ts`, `row-key.ts`
- SQL half: `packages/gateway/src/analytics/row-key-sql.ts`
- Applied: `packages/gateway/src/analytics/table-manager.ts`
- End-to-end: `packages/collector/src/e2e/analytics-row-key.e2e.test.ts`

### Nonfatal sync diagnostics preserve assessment scope

Nonfatal sync diagnostics distinguish no assessment from recovery: omitted `issues` preserves
the member's durable warnings; completed `issues: []` confirms a whole-report recovery. The
optional `issueAssessments` list limits replacement to exact `(code, scope, subject)` keys.
Runtime snapshot guards use that partial form so a valid snapshot for one analytics table cannot
clear a provider's incomplete enumeration or an unassessed sibling table. Malformed partial
assessment metadata must never fall back to whole-report replacement. These diagnostics carry
no cursor or write authority.

### Structured pages remain durable until both data planes finish

A structured source's output is prepared in `pending_source_pages` before its
first analytics write. A restarted collector replays that exact output, including
resolved table schemas, rather than refetching a possibly different upstream page.
Each ordered analytics write has a receipt in the same DuckDB transaction as its
mutation. Replaying a committed coarse-key deletion therefore cannot clear rows
another member contributed meanwhile. A deferred replica deletion earns no receipt.

The SQLite document/cursor commit marks the pending page committed atomically;
it does not discard it. Post-cursor snapshots still have to finish and acknowledge
the page. Their stable observation identities also deduplicate SQLite restorer
omission evidence. Explicit reset, wipe, detach and source removal cancel affected
journals; claiming a new attempt does not. Journals are excluded from seeded-state
exports because they carry unfinished write authority. Receipts are retired when
a new active page reaches the same cursor scope, never by expiring a paused page.
These are replay guarantees, not a transaction spanning SQLite and DuckDB.

- Journal: `packages/gateway/src/data/repositories/PendingSourcePageRepository.ts`
- Atomic receipt: `packages/gateway/src/analytics/page-receipt-store.ts`
- Recovery: `packages/collector/src/e2e/source-pending-page.e2e.test.ts`

### An irreversible operation gets a floor, and the floor is a config knob

Deleting the operator's data is the one thing the gateway cannot take back, and
several code paths reach it by _inference_ rather than instruction: a source
snapshot that stops naming a document, a re-walk that came back smaller than the
drive was known to be, a write attempted on a volume that may be full. Each
inference is drawn from a signal that a failure imitates exactly — an
impoverished read, a throttled page, a scope narrowed by a re-consent all look
like the real thing.

The rule is not "be careful". It is: **name the floor, and make it a knob.**
Write the threshold as a named constant or a `gateway.*` config entry whose
JSDoc states the asymmetry in words — what it costs to be wrong in each
direction — so a later reader can see that the number is a safety bound and not
a tuning preference. Where the floor is a delay rather than a refusal, prefer
requiring _two independent currencies_ to spend it: a count of corroborating
observations and a span of elapsed time. Either alone has a failure mode the
other covers, and stating both makes the mechanism honest about what it is
actually waiting for.

Never make the floor permanent. A legitimate deletion has to land eventually, so
the floor delays or demands corroboration; it does not refuse forever.

- `packages/gateway/src/data/repositories/AbsenceRepository.ts` — a snapshot's
  omission carries a deadline in observations and time before it deletes.
- `packages/gateway/src/data/repositories/ReplicaDeletionClaimRepository.ts` — a
  deletion one replica reports and another still holds waits for the holder's
  agreement, and is never re-applied in a loop.
- `packages/providers/outlook/src/onedrive.ts` (`MIN_REWALK_COVERAGE`) — a
  re-walk that found less than half of a known drive does not reconcile.
- `packages/config/src/config-schema.ts` (`minFreeDiskMb`) — ingestion pauses
  rather than writing under low disk.

### `omnesisConfigSchema` over ad-hoc constants

Operational tunables (slow-op budgets, chunker dimensions, embedder timeouts, HTTP timings, indexer pacing) live in one zod-validated schema in `@omnesis/config`. Hardcoded literals scattered through source files are a regression — when you introduce a new tunable, add the schema entry first and read through the live config rather than reading the literal.

- Canonical: `packages/config/src/config-schema.ts` (`omnesisConfigSchema`)

### Fixed analytics schemas evolve additively; dynamic columns opt in

A fixed source schema may gain columns across releases, but a separately deployed older client can
keep sending its older schema. Omission from that stale schema is not a deletion: fixed schemas only
add columns. A source whose upstream user can add, rename, or remove columns declares
`dynamicColumns: true`; only those schemas archive omitted columns. Notion database properties are
the canonical dynamic case, and their stable source-column IDs preserve this intent for older
collectors that predate the flag. A source-scoped token cannot opt a schema into destructive dynamic
evolution, and an existing table accepts schema mutation only from its owning source type. This
asymmetry preserves new release-managed columns under mixed client versions while retaining
user-driven column deletion for genuinely dynamic tables.

- Contract: `packages/source-sdk/src/structured-source.ts` (`AnalyticsTableSchema.dynamicColumns`)
- Evolution: `packages/gateway/src/analytics/table-manager.ts`
- Canonical dynamic source: `packages/providers/notion/src/schema-mapper.ts`

### Source-owned temporal projections beside LLM-owned annotations

Time-addressable facts have two deliberately separate owners. A source may
declare a deterministic `temporalProjection` on its analytics or document
schema when the source already exposes a low-volume, structurally defined
interval (for example, a calendar occurrence or location visit). The gateway
materializes those `tp_` rows in the same transaction as the source data and
replaces them only when that source emits the owning record again. Existing
records are not inferred or backfilled merely because a projection declaration
is added.

The cognition agent owns `temporal_annotations`: selective interpretations that
add meaning beyond a source fact. Agent mutation tools accept annotation ids
only; projections are immutable through the agent surface. Reads go through the
single `temporal_query` contract, which returns both origins with provenance,
coverage, and query-bound cursor pagination. `semanticTimeColumn` remains the
analytics table's primary event-time hint for SQL, discovery, and citation; it
does not opt a table into projection materialization.

- Source contract: `packages/source-sdk/src/structured-source.ts`
- Unified read model: `packages/core/src/temporal.ts`
- Materialization: `packages/gateway/src/analytics/temporal-projection-store.ts`,
  `packages/gateway/src/enrichment/temporal-projections/document-storage.ts`
- Federation: `packages/gateway/src/enrichment/temporal/temporal-query-service.ts`

### Zod at the route boundary

Mobile source permission health follows the same boundary rule: each phone submits one complete
capability snapshot for each source membership, validated strictly before the service layer. The
gateway persists every member's snapshot atomically with its receipt/expiry metadata; sync volume is
never used as a permission signal. Source-owned labels, impact text, remediation, and repair actions
cross the shared contract, so shared gateway and client code must not branch on a source name.
Known permission losses are member-local, while an overdue-report reminder is source-wide and opens
only when every reporting member is stale. Reminder publication reserves episode authority, retains
content and commits that authority in one writer transaction, then emits a content-free wake.
Lifecycle changes that invalidate a source or membership (disable, removal, re-home, detach,
revocation, or device deletion) clear the affected episode and queued copies in the same writer
transaction.

Every HTTP route validates its body via a per-route zod schema in `packages/gateway/src/http/schemas/`, applied by a `validate(schema)` middleware. Handlers read `c.req.valid("json")`. The schema's inferred type is the cross-package contract — collector and CLI import the inferred type, not a hand-maintained DTO.

### Validating branded ID constructors

`SourceId(s)`, `ProviderId(s)`, `DeviceId(s)`, `Scope(s)`, `AccountId(s)`, `SourceType(s)`, `ProviderType(s)` validate input and throw `BrandedIdError` on bad data. `as SourceId` casts are forbidden; for untrusted input the `tryX` parallels return `null` instead of throwing. DB-row reads use the validating constructor at the boundary.

- Canonical: `packages/types/src/ids.ts`

### `PRAGMA user_version` migrations

The SQLite schema is versioned via `PRAGMA user_version`; `data/migrations.ts` exports `LATEST_SCHEMA_VERSION` and a sequenced migration list. Migrations are idempotent and run on startup before the first sync. **Migrations are append-only, contiguous, and kept permanently** — with live users on differing schema versions, an install several versions behind must upgrade cleanly by replaying the full sequence, so a migration's slot is never removed. When a step's data transform later becomes obsolete (superseded by an admin recompute endpoint, or a source stops emitting the data it fixed), it is reduced to a **tombstone** — a no-op `up` whose description records why — rather than deleted, so the `user_version` chain stays gap-free. A contiguity test (`schema.migration.test.ts`) fails the build if the list ever develops a hole or its head drifts from `LATEST_SCHEMA_VERSION`.

A standing migration-idempotency fixture guards the replay path: a checked-in **deterministic seed** (`packages/gateway/src/data/migration-idempotency-seed.ts`) materialises representative historical rows; the test (`migration-idempotency.test.ts`) boots it through the real `createDatabase` open path twice and asserts preservation and a no-op second boot. This is a partial-schema sentinel, not a complete released database. Keep its schema version tied to the shape it actually builds and at least three versions behind head; do not relabel old DDL merely to advance the number. When a migration changes a seeded table, extend the preservation assertions. Release-produced fixtures separately prove that a complete installed schema upgrades correctly.

- Canonical: `packages/gateway/src/data/migrations.ts`

### A migration is proved against an install that already holds data

Every migration has its own test, and each builds the tables it transforms.
The integration obligation is the tail running in order, through the production
open path, over an installed schema. A minimal unit fixture can miss a unique
index or an interaction with data transformed by the preceding migration.

`migration-tail.test.ts` covers a populated tail by opening at head, undoing what the
tail added, winding `PRAGMA user_version` back, planting the rows an older install
would hold, and opening again through `createDatabase`. Everything the tail does
not touch is then shaped exactly as the product creates it, so a planted row is
a row the real code would have written, and what runs is the real runner over
the real migrations.

`release-upgrade.test.ts` complements that constructed fixture with a database
produced by a pinned release checkout. Its generator, manifest and compressed
database are checked in. The manifest records the producing revision, checksum
and expected rows; preservation includes source identities, opaque bookmarks,
documents, access grants and manual person decisions. Its cursor sentinels prove
storage preservation, not provider resumption; provider state tests must prove
that separately. Never substitute a production corpus for this fictional fixture.

The wire has the same obligation and a different fixture. An operator upgrades
the gateway first, so every field a release adds has an older spelling still
arriving from a collector or a phone that has not caught up.
`old-collector-wire.e2e.test.ts` sends those older shapes as hand-built request
bodies — deliberately not through a collector, which would send today's shape
and so could never exercise the one under test.

- Schema tail: `packages/gateway/src/data/migration-tail.test.ts`
- Released install: `packages/gateway/src/data/release-upgrade.test.ts`
- Wire: `packages/collector/src/e2e/old-collector-wire.e2e.test.ts`
- Idempotency: `packages/gateway/src/data/migration-idempotency.test.ts`

### File-backed SQLite logic-test fixtures

When a gateway query or writer test needs a raw SQLite file, create a unique
temporary database per test and select `journal_mode = WAL` and
`synchronous = FULL` before `runSchemaSetup` / `runMigrations`. Apply both PRAGMAs
to every additional writable fixture database. This uses the gateway's journal
layout while retaining fully synchronized commits and avoids recreating a
rollback journal for every migration. Keep the full schema and migration path,
independent database handles, and every data assertion. Close all handles before
removing the owned temporary directory, including its WAL and shared-memory files.

Migration, crash-recovery and journal-specific tests retain the connection settings
their assertions require. When measuring effective PRAGMAs, inspect them after a
real write: SQLite can apply its WAL synchronization default lazily.

- Canonical: `packages/gateway/src/near-dupes/meta.test.ts`

### A source id names either a type or one account of it

`sourceIdAddresses(name, sourceId)` is the rule: a bare type (`gmail`) covers
every account of that type, and a qualified id (`gmail:me@example.org`) covers
exactly itself and nothing else. `sourceTypeOf` / `sourceAccountOf` split an id;
neither half is recovered by hand, because splitting on the last colon rather
than the first quietly renames an account whose own id contains one.

SQL cannot call the rule, so `packages/gateway/src/data/source-addressing.ts`
transcribes it once — `sourcePrefixPredicate` for the clause, and
`sourceMatchesAnyPrefix` for the in-memory twin, kept in one file because the
pairing is only checkable by reading them together. The clause escapes its own
`LIKE` pattern (a type containing `_` or `%` otherwise matches ids it does not
name) and is self-bracketing, so a caller can splice it straight after `AND`.

Transcribed per caller instead, the copies drift, and because each is reached by
a different caller no single test shows that they disagree — while a query that
widens where the predicate does not deletes rows nobody named.

- Rule: `packages/types/src/ids.ts` (`sourceIdAddresses`, `sourceTypeOf`, `sourceAccountOf`)
- SQL half: `packages/gateway/src/data/source-addressing.ts`

### An identifier records every source that vouches for it

`person_aliases` is `INSERT OR IGNORE` on `(alias_type, alias, person_id)`, so
its `source_id` column records the **first** source to see an identifier and
cannot record a second. It therefore cannot answer the question a source removal
asks — _does anything still vouch for this?_ — and answering it from that column
destroys identifiers other live sources assert. When one is a person's last
alias, the person goes with it and `document_people` cascades, so documents from
the sources that remain lose their attribution.

`person_alias_assertions` is the ledger that can answer it: one row per
(alias, source). Every writer of an alias goes through `aliasWriter` in
`PersonAliasRepository`, which inserts and vouches as one act — an alias written
without an assertion is invisible to the bookkeeping in the worst direction,
since the first writer is exactly the one nothing else will vouch for. Removal
withdraws this source's assertions and drops only the rows nothing else vouches
for; a contact card that stops carrying an identifier withdraws its own claim the
same way.

- Ledger: `packages/gateway/src/data/repositories/PersonAliasRepository.ts`
- Migration: `packages/gateway/src/data/migration-173-alias-assertions.ts`

### A family's identity is declared, never assembled from an account

A source type's display identity — the name and glyph a client shows when it
groups the corpus by type rather than by account — is declared by the source
itself, through `SourceSyncMeta.family`, and stored in its own `source_family_meta`
row. It is never derived from an account's `sync_state` row: two accounts of one
type legitimately differ, so a family assembled from either is named after
whichever member a scan reaches first. For a source that labels each connection
by institution, that publishes one institution's name and logo as the whole
type's identity.

A phone-hosted source has one account per type, so its account's identity and
its family's are the same pair — which is a reason to declare both, not a reason
to infer one from the other.

- Store: `packages/gateway/src/data/repositories/SourceFamilyMetaRepository.ts`
- Migration: `packages/gateway/src/data/migration-175-source-family-meta.ts`

### Source encapsulation

All logic specific to a particular data source lives inside that source's provider package (`packages/providers/<name>/`). Source-specific knowledge — branching on `sourceType === "gmail"`, unit nouns ("an email" vs. "a file"), URL/deep-link handling, icons, colors, display text, per-source schemas — must not appear in `core/`, `gateway/`, `collector/`, `cli/`, `portal/`, or `ios/` outside the provider. The `defineSource()` descriptor is the contract: if a consumer needs a piece of source-specific data, the source provides it via the descriptor (icon, color, unit noun, deep-link builder, …) and the consumer reads through the registry. Hardcoding source names downstream is a regression — extend the descriptor instead.

Generic abstractions remain fine (routing on `:sourceType`, the source registry iterating over all sources, tests that enumerate sources). Hosted widget clients follow the same rule: a `link-widget` provider declares its CSP origins through `widgetOrigins` and its provider-owned browser module through `widgetRenderer`; the gateway exposes those declarations generically, and shared portal code imports by opaque widget kind instead of naming a vendor SDK.

A write-time ESLint guard (`no-restricted-syntax`, **warn**, in `eslint.config.js`, scoped to the shared packages) flags the moment a `sourceType === "<name>"` branch lands in shared code — catching the most common violation at lint time. It is `warn` (a reviewed exception is occasionally legitimate, and the lint lane stays green on warns), but every new hit shows up in PR annotations to justify or refactor. The pattern for a real need is the `selfIdentity` hook on the source descriptor: the source declares how its account id maps to its self LID alias, each collector pushes the hooks of the sources it hosts on boot and on every source add, the gateway merges them by source type, and `detectSelfFromSourceIds` resolves them generically — instead of the gateway naming specific source types.

- Contract surface: `packages/source-sdk/src/define-source.ts`
- A daily audit routine flags the previous day's merges and opens one tracking issue per violation.

### Compose agent instructions from canonical modules

Retrieval policy shared by more than one reasoning surface lives in
`packages/agent/src/instructions/`, not in a final system prompt, MCP adapter,
or plugin skill. Runtime surfaces compose those modules with their own trust and
capability boundaries. Dynamic source and analytics context is rendered at the
gateway boundary; it is never baked into a static plugin.

When a host requires a static skill file, generate it from the canonical module
and keep a byte-for-byte drift test beside the skill. The generated file is a
distribution snapshot, not a second source of truth. Never share a
surface-specific assurance across trust boundaries—for example, the built-in
local-sandbox claim must not appear in Direct instructions sent to a remote
model.

- Canonical module: `packages/agent/src/instructions/read-only-retrieval.ts`
- Runtime composition: `packages/gateway/src/agent/system-prompt.ts`,
  `packages/gateway/src/mcp/direct-server.ts`
- Static generator: `scripts/generate-omnesis-direct-skill.ts`

### One OAuth-protected MCP resource

The gateway-hosted `/mcp` Streamable HTTP resource is the only standard MCP
surface. Its server definitions live under `packages/gateway/src/mcp/`, and
their tool callbacks re-enter the existing transport-neutral Answer release
and Direct admission/execution boundaries. This keeps release provenance,
limits, cancellation, sanitisation, and audit consistent across transports.

Every external MCP request authenticates as a principal credential. A
principal is one user-facing connection and holds exactly one live Access
Grant, whose capabilities determine whether the connection exposes Answer,
Direct, Notes, or a combination; the URL never selects authority. Every live grant
has an `access_grants.level_id` and holds exactly its access level's
capabilities: a level edit rewrites every member grant in the same writer
transaction, through the grant-edit path (revision bump and `grant-updated`
audit), so member tokens are fenced together. Approval never joins principals
or levels by OAuth client id or name. Only an explicit replace-connection selection issues a
credential on an existing grant, and activating that credential revokes the
grant's other credentials. Operational device tokens do
not grant MCP reads. A paired OpenClaw or Hermes device may receive an
identifier-only completion wake, but retrieving the result still requires the
integration's OAuth principal credential and current Access Grant.

Do not add a stdio bridge, static bearer-token profile, separate capability
endpoint, or client-side copy of the tool inventory. Supported clients connect
directly over HTTP and implement OAuth. Host-specific packages may provide
skills or declare the remote URL, but authorization always happens at the
Gateway and capability always comes from the grant.

The access ledger has one security guarantee: no successful corpus result is
released until its principal, grant revision, credential, capability, tool,
source mode, and outcome are durably written. Refused, failed, timed-out, and
cancelled calls release no corpus data; their audit rows are diagnostic and
best effort if the shared writer is unavailable. Do not describe the ledger as
an exhaustive request log unless a durable failure spool is added.

- Canonical servers: `packages/gateway/src/mcp/`
- HTTP transport and grant enforcement: `packages/gateway/src/http/routes/mcp-streamable.ts`
- OAuth and access model: `packages/gateway/src/access/`

### `// PARITY:<key>` for cross-surface mirrored constants

A handful of constants must hold **identical across the three agent-transcript clients** — the web portal, iOS, and Android — or the UI visibly desyncs (the ephemeral rolling-slot cards' reveal / hold / fade / min-visible timings). Each client carries its own copy in its native unit. The parity guard makes a missed mirror reddable mechanically instead of relying on "mirror this number on iOS/Android" comments.

The convention: at each client's **single canonical declaration** of a shared numeric value, place a trailing `// PARITY:<key>` comment on the same line as the literal, e.g. `const EPHEMERAL_REVEAL_MS = 350; // PARITY:ephemeral-reveal-ms`. Use it for mirrored UI timing/caps and numeric protocol versions. The keys + canonical values + the surfaces that must carry each live in `scripts/parity-constants.json` (the single source of truth, with per-surface units). `scripts/check-parity.mjs` extracts the **actual literal adjacent to each marker** (not just the table), normalises by unit, and fails loud on a value divergence, a missing marker in a surface that should carry the key, a marker naming an unknown key, or a duplicate marker — so the guard can't silently pass on a typo'd or dropped marker.

To change a shared constant: edit the literal in **all three** source files **and** the canonical value in `scripts/parity-constants.json` in the same commit, or the guard reddens.

- Guard + table: `scripts/check-parity.mjs`, `scripts/parity-constants.json`; standing test `scripts/check-parity.test.mjs`

### Navigation marks; the surface that owns the subject explains

A navigation menu — the iOS and Android drawers, the portal's sidebar — lists destinations and flags the ones needing attention with one shared affordance: an amber warning triangle, always carrying a caller-supplied accessibility label. It never renders a sentence of diagnostics. Chrome has no room to say what a message is about, and no control to act on it, so a backend error parked there reads as a fault with no owner.

What is wrong and the control that repairs it belong together, on the surface that owns the subject. A capability whose model cannot run is stated on Settings → Models beside its picker, and on the portal's Cognition tab; the flagged menu entry routes there instead of quoting the backend in the menu. A page-level fetch failure is a different case and keeps its own treatment — `GatewayErrorView` on both clients, which classifies the error into a titled, actionable state rather than printing the raw one.

Two consequences worth stating, because they are where this gets violated:

- **A prose `reason` on the wire is addressed to a surface that can act on it.** Clients that only navigate read the booleans instead. A gate must therefore publish enough booleans to tell "this install asked for the feature and it is broken" apart from "this install merely previews it" — otherwise the client either guesses or shows a permanent false alarm on every demo gateway. `BriefsFeatureStatus.enabled` exists for exactly that.
- **Derive the menu's state into a typed value next to the DTO, not into a branch in the view.** It keeps the blocked states distinguishable under test in the sim-less lane, where a view is not reachable.

- Examples: `ios/Sources/Omnesis/Transport/BriefsClient.swift` (`BriefsMenuEntry`), `ios/Sources/Omnesis/UI/MainMenuDrawer.swift`, `android/app/src/main/kotlin/dev/omnesis/android/ui/home/MainMenuDrawer.kt`, `packages/gateway/src/brain/feature-gate.ts`

### Portal tables share one vocabulary

Every tabular listing in the portal is built from the same primitives rather than a class family of its own: `.portal-table` inside `.portal-table-wrap`, with `.portal-table-name` for the row's subject — styled identically whether it opens a route or a dialog, so the two never read as different kinds of thing — `.portal-table-sub` for the identifiers and pills belonging to that name, `.portal-table-num` for right-aligned tabular figures, `.portal-table-actions-col` for the collapsing trailing column, and `.portal-pill` with `-muted` / `-accent` / `-warning` for a one-word label on a row.

Minting a per-view `.<feature>-num` is the regression this exists to prevent: three tables drifting apart is how a numeric column ends up right-aligned on one page and left-aligned on another. A view keeps a class of its own only for genuinely local geometry — a column width, a `white-space` rule, a cap on the table's width — and scopes it through `.portal-table` (`.portal-table.access-policy-table td`) so a declaration later added to a shared rule cannot win over it on source order.

Nothing in the test suite loads the stylesheet, so a rename is only half-checked by tests: they catch a view that stopped naming a shared class, never a stylesheet that stopped defining one. The other half is the screenshot loop.

- Examples: `packages/gateway/portal/js/views/sweeps.js` (the reference table), `packages/gateway/portal/js/views/policies/policy-library.js`, `packages/gateway/portal/js/views/policies/policy.js`

### Nested Codex inference owns independent capacity

Codex capability roles share a managed runtime service. Single-shot completions use
`CodexCompleter`; OCR sends inline images through the same tool-free adapter. An
inference turn consumes only the final answer, never progress commentary. Every
loader respects `allowRemoteInference`, and cached provider signatures include it.

Agent tools can request another model turn before their own turn completes. The
runtime supervisor binds the parent lease at each tool invocation, routes nested
turns to a separate bounded pool per depth, and admits active descendants while a
runtime generation drains. A nested call must never queue behind its caller's
occupied runtime. Disposal and auth reconciliation cover every generation pool.

- Completion adapter: `packages/gateway/src/inference/codex-completer.ts`
- Runtime admission: `packages/gateway/src/models/codex-generation-supervisor.ts`
- Capacity and model discovery: `packages/gateway/src/models/codex-runtime-service.ts`

### `assertNever` for discriminated-union exhaustiveness

Every internal-discriminator switch ends with `default: assertNever(x);` so adding a new variant breaks the build at every switch that hasn't been updated. External-data switches (parsing user/network input) use typed defaults instead — `assertNever` only applies when the type system guarantees a closed union.

- Helper: `packages/core/src/utils.ts`

### Packaging & runtime duality

The same code runs two ways: as TypeScript source under tsx (dev, source installs) and as compiled `dist/*.js` (published npm packages). Repo manifests stay **src-pointing** (`main`/`types`/`exports`/`bin` → `src/*.ts`, workspace siblings pinned `"*"`); `scripts/release/transform-manifest.mjs` rewrites them to `dist` + the lockstep version at publish-stage time, never in the repo. Two rules keep code working in both modes:

- Any spawn of a sibling worker thread or subprocess goes through `resolveWorkerEntry` / `resolveSubprocessEntry` from `@omnesis/core` — they pick the `.ts`-under-tsx entry in dev and the emitted `.js` sibling when compiled. A hardcoded `new URL("./worker.ts", import.meta.url)` is a regression.
- Module-relative asset paths (the gateway's `portal/`, package.json reads) must resolve from both `src/` and `dist/` — both sit one level below the package root, so `..`-anchored paths are safe.

- Helpers: `packages/core/src/worker-entry.ts`
- Pipeline: `scripts/release/` + `docs/releasing.md`

### A suite's dependency object is checked against its type

A route or service takes a `…Deps` object. Its suite builds one by hand, and
that hand-built object is the single most common place for a silent break: the
type gains a required member, the suite does not, and the suite keeps passing —
until the path that reads the member runs, as a 500, or never, if no case drives
it. It is always the dependency object; fixtures do not have this problem,
because a fixture that is wrong is usually wrong in a way some assertion sees.

Two halves make it visible, and **neither works alone**:

1. **A suite is typechecked.** A package's own tsconfig excludes `*.test.ts` —
   it would otherwise emit the suites into `dist`, which is what gets published
   — so an annotation in a test file is read by nothing, `satisfies` included.
   Each covered package carries a `tsconfig.tests.json` beside its own, and
   `npm run typecheck:tests` runs **every** one it finds (one CI step), so
   adding the file is the whole of joining. The `include` is every suite and
   the `exclude` is the ones that do not pass yet, so a **new** suite is
   covered from the day it is written. Take a file off that list when you clean
   it; do not add one without saying why.

   Covered today: `gateway`, `watch`, `collector`, `cli`, `agent`,
   `agent-integration`. Where a package's
   suites reach into another package's sources, that package's ambient `.d.ts`
   globs go in `include` too — the suites are compiled from source rather than
   read from a build, so a missing shim fails the lane on somebody else's
   untyped dependency rather than on a suite.

2. **The object is annotated.** Write `} satisfies WatchV2RoutesDeps` on the
   object rather than typing the variable, so the literal keeps its own types
   and the error lands on the object rather than at the call site. Reach for it
   especially where a cast would otherwise defeat the check — a test that
   cannot build a whole server config casts the outer options object, and a
   cast turns off checking for everything inside it.

Prefer one built object per suite, reused with overrides (`{ ...deps, enabled:
() => false }`), over a second hand-written one: a partial copy is a fixture
nothing compares against the type.

Where a dependency genuinely is not exercised, supply a member that throws
rather than omitting it. Omitting is indistinguishable from forgetting; a throw
names the suite that must grow a case the day something reaches it.

- Config: `packages/gateway/tsconfig.tests.json`
- Example: `packages/gateway/src/http/routes/watch.test.ts`

---

### Spawned E2E gateways declare their feature mode

The synthetic provider fixtures and the gateway feature surface are separate
concerns. `synth-env.ts` selects synthetic providers in the Vitest process, but
it must not decide what the spawned gateway exposes. Every
`SyntheticE2EHarness` construction names one `gatewayMode`: `stable`
(`OMNESIS_SYNTHETIC=0`, `OMNESIS_EXPERIMENTAL=0`), `experimental` (`0`, `1`),
`synthetic` (`1`, `0`), or `synthetic-experimental` (`1`, `1`). The harness
writes both flags after all inherited environment values. A truth-table test
pins the exact tuple; the booted gateway's `/health` response separately checks
whether gated surfaces are visible, which is the only mode signal it exposes.

Choose the narrowest surface the suite proves. A stable suite that passes only
because synthetic mode makes experimental routes visible is a false positive.
When one suite proves a mode transition, use `restartGateway({ gatewayMode })`
so the transition is explicit and restored in `finally`.

- Contract and enforcement: `packages/collector/src/e2e/synth-harness.ts`
- Truth-table tests: `packages/collector/src/e2e/synth-harness.test.ts`

---

### Developer checks share admission and process supervision

Route full test lanes, typechecking and other heavy developer checks through
`scripts/run-check.mjs`. It delegates host admission to an optional local adapter;
focused units keep a bounded worker budget. Keep host priorities and capacity
policy outside the public repository. Child commands use
`scripts/lib/check-process.mjs` so cancellation waits for descendants before
releasing capacity. Append progress reporting without replacing a caller's
reporter policy. See `docs/agent-gotchas.md` for the adapter and command contracts.

## Layer 2 — Canonical examples

When you set out to write code that matches one of the patterns above, open the file in the right column and imitate its shape. These are head pointers — re-check before relying on them, since the codebase moves.

| Pattern                            | Canonical example                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Developer check admission          | `scripts/run-check.mjs` + `scripts/lib/check-process.mjs`                                                             |
| File-backed SQLite logic fixtures  | `packages/gateway/src/near-dupes/meta.test.ts`                                                                        |
| `defineSource()` over class        | `packages/providers/things/src/index.ts`                                                                              |
| Façade (data layer)                | `packages/gateway/src/analytics-db.ts`                                                                                |
| Façade (scheduler)                 | `packages/gateway/src/scheduler/scheduler.ts`                                                                         |
| Façade (HTTP routes)               | `packages/gateway/src/http/routes/admin/devices.ts`                                                                   |
| Façade (provider)                  | `packages/providers/apple/src/provider.ts`                                                                            |
| Façade (sync engine)               | `packages/collector/src/sync-engine.ts`                                                                               |
| Subpath exports                    | `packages/core/package.json` (the `exports` block)                                                                    |
| HTTPS + TOFU pinning               | `packages/gateway/src/tls.ts`                                                                                         |
| Secret-store abstraction           | `packages/core/src/secret-store.ts`, `packages/core/src/secret-file.ts`                                               |
| Host update serialization          | `packages/core/src/update-lock.ts` + `packages/cli/src/update/source-launcher.ts`                                     |
| Transient-buffer                   | `packages/providers/whatsapp/src/message-store.ts`                                                                    |
| Local coding-agent transcripts     | `packages/source-sdk/src/local-agent-sessions.ts` + `packages/providers/pi/src/index.ts`                              |
| Per-source write epochs            | `packages/collector/src/source-sync-runner.ts` + `packages/gateway/src/data/repositories/DocumentRepository.ts`       |
| Routes only call services          | `packages/gateway/src/http/routes/admin/devices.ts` + `packages/gateway/src/http/services/`                           |
| Canonical `ListedDocument`         | `packages/gateway/src/data/document-mappers.ts`                                                                       |
| Typed worker dispatch              | `packages/gateway/src/workers/protocol.ts` + `packages/gateway/src/scheduler/write-ops.ts`                            |
| Typed WS registry                  | `packages/core/src/ws-messages.ts`                                                                                    |
| Negotiated protocol range          | `packages/gateway/src/subscriptions/delivery.ts` (`negotiatedDeliveryProtocol`)                                       |
| Snapshot only from a complete read | `packages/source-sdk/src/snapshot.ts` + `packages/providers/apple/src/contacts.ts`                                    |
| Absence marked, not deleted        | `packages/gateway/src/data/repositories/AbsenceRepository.ts`                                                         |
| `omnesisConfigSchema`              | `packages/config/src/config-schema.ts`                                                                                |
| Analytics schema evolution         | `packages/gateway/src/analytics/table-manager.ts` + `packages/providers/notion/src/schema-mapper.ts`                  |
| Temporal projections + annotations | `packages/source-sdk/src/structured-source.ts` + `packages/gateway/src/enrichment/temporal/temporal-query-service.ts` |
| Zod at boundary                    | `packages/gateway/src/http/schemas/admin.ts`                                                                          |
| Validating branded IDs             | `packages/types/src/ids.ts`                                                                                           |
| `PRAGMA user_version` migrations   | `packages/gateway/src/data/migrations.ts`                                                                             |
| `assertNever`                      | `packages/core/src/utils.ts` (helper); `packages/gateway/src/workers/writer-worker.ts` (call site)                    |
| Packaging & runtime duality        | `packages/core/src/worker-entry.ts` (helpers); `scripts/release/transform-manifest.mjs` (publish)                     |
| Explicit E2E gateway mode          | `packages/collector/src/e2e/synth-harness.ts`                                                                         |

---

## Layer 3 — Enforcement

A pattern only survives if review or the toolchain catches its violations. Several of the conventions above are machine-checked (types, ESLint, knip, the parity and privacy guards, CI); the rest are review-enforced. The table below splits them.

### Automated

| Mechanism                          | What it catches                                                                                            | Where                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| TypeScript `strict: true`          | implicit `any`, null/undef misuse, missing return types, exhaustive union checks paired with `assertNever` | `tsconfig.base.json` (extended by every package) |
| `tsc --build` (project references) | type errors across the whole monorepo in one pass                                                          | `npm run typecheck`                              |
| vitest                             | unit + integration coverage                                                                                | `vitest.config.ts`                               |

Also enforced:

- **ESLint** — `eslint.config.js` (flat config; `npm run lint`). Includes a `no-restricted-imports` rule forbidding cross-package _relative_ paths and a `no-restricted-syntax` source-encapsulation guard (warn) flagging `sourceType === "<name>"` branching in the shared packages. Runs in CI and the pre-commit hook.
- **`knip`** — `knip.json` + `.github/workflows/knip.yml` surface unused exports / dead files.
- **Cross-surface parity guard** — `scripts/check-parity.mjs` (`npm run parity:check`) extracts the actual literal at each `// PARITY:<key>` marker across listed surfaces and fails if a mirrored timing/cap or numeric protocol version diverges or a marker went missing. Wired both as a CI step in `ci.yml` and as a standing vitest check (`scripts/check-parity.test.mjs`). See the `// PARITY:<key>` pattern in Layer 1.
- **Snapshot-contract guard** — `packages/source-sdk/src/snapshot-contract.test.ts` walks every file under `packages/providers/` and `packages/source-sdk/` for an actual `presentExternalIds` / `presentIds` emission and fails unless the file is registered in `snapshot-emitters.json` with a sentence saying how completeness is guaranteed. It cannot judge whether the discipline is correct — no static check can — but it guarantees no snapshot emission exists that nobody has thought about, and hands the reviewer the claim to check. The semantic half is `SnapshotEnumeration` and the spawned-gateway sweep in `packages/collector/src/e2e/snapshot-absence.e2e.test.ts`.
- **Privacy guard** — `scripts/pii-scan.mjs` scans staged diffs, commit messages, and the full tracked tree (`npm run privacy:scan`) for real-looking emails, phone numbers, private/tailnet IPs, common secret shapes, and full-name candidates in high-risk fixture/test paths. Existing reviewed fixture values live in `privacy/pii-allowlist.json`; identity entries are path-scoped so a value reviewed in one fixture cannot bless the same value elsewhere. New values must be invented and added deliberately in the same PR. CI runs the full-tree scan as the first gate of every run.
- **CI** — `.github/workflows/full-validation.yml` runs the whole suite on GitHub-hosted runners for every push to `main`, every pull request into it, and manual dispatch; a newer push to a pull request cancels its older run, while a run on `main` always finishes (later pushes collapse into one waiting run), so the README badge only ever reports a complete verdict. It calls the reusable lane workflows (`ci.yml` for Node, plus the native, install, Docker, harness and security lanes) at one exact revision, gates every Node job behind the privacy scan, and ends in one `verdict` job. Pull-request runs use the plain `pull_request` trigger — read-only token, no secrets.
- **Pre-commit / commit-msg / pre-push hooks** — Lefthook (`lefthook.yml`) runs a license-header check, eslint, prettier, and the PII scan pre-commit; strips AI co-author trailers and scans the message on commit-msg; and runs the bounded format and privacy checks on pre-push. Whole-program typecheck, lint, tests, and dead-code analysis stay in the explicit final-validation and CI lanes so a push does not repeat queue-backed work after the required validation has passed.

Known state, not a guard:

- **No coverage thresholds** — `test:coverage` runs vitest with coverage, but the config sets no `coverage.thresholds`, so coverage is reported, not enforced.

If you wire any of these up, update this section in the same PR.

### Convention-only (review-enforced)

Every rule below is documented but not machine-checked. Reviewers are expected to catch violations:

| Convention                                                                                                                                                                                       | Documented at                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| No `console.log/warn/error` outside the logger module                                                                                                                                            | `CLAUDE.md` → "Code style"                                                      |
| No cross-package relative imports (use `@omnesis/core` etc.)                                                                                                                                     | `CLAUDE.md` → "Code style"                                                      |
| No `any` except in test mocks                                                                                                                                                                    | `CLAUDE.md` → "Code style"                                                      |
| Logger style: one-line template literals, no `{ key: val }` data blobs                                                                                                                           | `CLAUDE.md` → "Code style"                                                      |
| `assertNever` at every internal-union switch                                                                                                                                                     | this doc + `packages/core/src/utils.ts` JSDoc                                   |
| Routes only call services (no DB / writer-queue / scheduler in routes)                                                                                                                           | this doc                                                                        |
| Portal tables use the shared `.portal-table-*` / `.portal-pill` primitives                                                                                                                       | this doc                                                                        |
| Tests are mandatory for every fix/feature                                                                                                                                                        | `CLAUDE.md` → "Tests are mandatory"                                             |
| Doc updates land in the same PR as the code change — public docs are hand-written static pages under `website/docs/` (published at https://omnesis.dev/docs); there is no generated-docs CI gate | `CLAUDE.md` → "Documentation maintenance"                                       |
| Migrations are append-only, contiguous, and kept permanently (obsolete steps are tombstoned, never removed)                                                                                      | `CLAUDE.md` → "Database migrations" + `packages/gateway/src/data/migrations.ts` |
| When you establish a new architectural pattern, add it to this doc                                                                                                                               | this doc                                                                        |
| A suite's hand-built dependency object carries `satisfies <Deps>`, and the suite is in the test typecheck lane                                                                                   | this doc Layer 1 + `packages/gateway/tsconfig.tests.json`                       |
| Every `SyntheticE2EHarness` construction names the narrowest `gatewayMode` its suite requires                                                                                                    | this doc Layer 1 + `packages/collector/src/e2e/synth-harness.ts`                |
| Source encapsulation — no bespoke source logic outside `packages/providers/<name>/`                                                                                                              | `CLAUDE.md` → "Source encapsulation" + this doc Layer 1                         |
| A new or changed source passes `/source-review` — the complete source contract as a checklist, including the obligations no test enforces (icon, event profile, people, URLs, multi-device mode) | `.claude/commands/source-review.md` + `website/docs/building-sources.html`      |
| `credentialState()` answers from the stored credential, never from a live request                                                                                                                | this doc Layer 1 + `packages/source-sdk/src/define-source.ts` JSDoc             |
| Navigation menus mark, never explain — diagnostics live on the surface that owns the subject                                                                                                     | this doc Layer 1                                                                |
| A separately deployed wire contract advertises a version range; no schema pins a single literal                                                                                                  | this doc Layer 1                                                                |
