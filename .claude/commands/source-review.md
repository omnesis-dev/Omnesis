Review a new or changed Omnesis **data source** — a provider package under
`packages/providers/<name>/` and everything it must touch outside that
package — against the full source contract. The goal is that nothing a
source needs is forgotten and nothing is built in a way the gateway,
collector, portal, mobile apps, Watch, or the people graph cannot use.

The source contract is spread over many files; this command is the one place
that lists all of it. Most of the ways a source can be wrong are **silent**:
the package builds, its tests pass, and the source syncs — but it shows a
placeholder icon, cannot be named by a watch, never contributes people, drops
inbound links, or duplicates itself on a second device. Treat "it works on
my machine" as no evidence for any check below.

Do § 0 yourself, then spawn sub-agents in parallel, one per group, each with
the scope from § 0 (file list, descriptor inventory, baseline output) and
its sections:

- **A — viability, terms, encapsulation, descriptor, auth** (§ 1–4). The
  terms-of-service check needs network access; if the sub-agent has none,
  it records the URLs it would read and the questions to answer.
- **B — sync runtime, deletions, documents and rows** (§ 5–7)
- **C — people and URLs** (§ 8–9)
- **D — presentation and Watch** (§ 10–11)
- **E — multi-instance, multi-device, phone push** (§ 12–14)
- **F — touchpoints outside the package, tests** (§ 15–16)

Only apply checks that are relevant to the source under review (a push-only
phone source has no sync loop; a source with no human counterpart emits no
people). Every finding names the file and line, the contract it violates,
and the user-visible consequence.

---

## 0. Scope and baseline

Identify the source under review. `$ARGUMENTS` may name the provider package
(`github`, `packages/providers/github`) or a source id; when empty, derive the
scope from `git diff main...HEAD --stat` and the unstaged diff — everything
under `packages/providers/<name>/`, its synth twin under
`packages/providers-synth/<name>/`, and every file outside them the branch
touched.

Read the source first, then the contract only where the source touches it:

1. `packages/providers/<name>/src/index.ts` (the descriptor) and its
   normalizer, end to end.
2. For each descriptor field the source sets — and each one it does not —
   the doc comment in `packages/source-sdk/src/define-source.ts`
   (`SourceDefinition`, `ProviderDefinition`, `SourceInstance`,
   `CreateOptions`) and `packages/source-sdk/src/source-descriptor.ts`.
   Those comments are the contract; quote them in findings.
3. `packages/source-sdk/src/source.ts` (`SyncResult`, `SourceIcon`,
   `SourceFreshness`) and, for analytics or Watch declarations,
   `packages/source-sdk/src/structured-source.ts`.
4. `packages/types/src/document.ts` (`DocumentInput`, `DocumentMetadata`,
   `PersonMention`, `PERSON_ROLES`).
5. `website/docs/building-sources.html` — the condensed public contract.
   It does not list every field; where the source **contradicts** it, one of
   the two is wrong and the review says which.
6. `source-contract.ts`, `source-state.ts`, `state-runtime.ts`,
   `config-schema.ts`, `auth-session.ts`, `source-host.ts`, and `table-write.ts`
   under `packages/source-sdk/src/` for the declared v2 features. Verify host
   wiring too: a type existing in the SDK does not prove the host implements it.

Build a **descriptor inventory** in one pass and hand it to every
sub-agent — which of these the source declares, with the value:

```bash
rg -n "contract|apiVersion|outputRevision|requires|config:|authenticate|credentialState|probeLocalStores|acceptsAuthCode|experimental|unitName|primaryCount|icon|attribution|urlPatterns|ownedWebDomains|urlCanonicalizer|conversational|selfIdentity|singleInstance|multiDevice|execution|pushBased|params|historyImport|analyticsSchemas|documentTemporalProjections|documentEventProfile|defaultSyncInterval|supportedPlatforms|credentials|freshness|watchPaths|onResync|suspend|resume|dispose|isAuthenticated|cleanupCredentials|discover" \
  packages/providers/<name>/src/index.ts
rg -n "console\.|opts\?\.signal|signal[,)]|DEFAULT_CONFIG_DIR|process\.env" packages/providers/<name>/src -g '*.ts' -g '!*.test.ts'
```

Run the mechanical signals and carry their output into the report:

```bash
npm run typecheck:fast -- packages/providers/<name>
npm run test:unit:vitest -- packages/providers/<name>
npm run test:unit:vitest -- packages/source-sdk/src/snapshot-contract.test.ts \
  packages/collector/src/document-event-profiles.test.ts \
  packages/collector/src/record-citation-contract.test.ts
npm run validate-universes
npx eslint packages/providers/<name>
node scripts/pii-scan.mjs --all
npx knip
npm run checks:plan -- --base origin/main
npm run checks:affected -- --base origin/main
```

What these do and do not prove: the snapshot-contract test reddens on an
unregistered snapshot emitter; the document-event-profiles test validates
every **published** profile and their mutual distinguishability but does not
require that this source publishes one; the record-citation test covers
sources with analytics schemas. ESLint's source-encapsulation guard only
matches a `sourceType === "<literal>"` comparison in the shared packages, at
warn level — the greps in § 2 are the real encapsulation check. The full
`npm run lint` is slow and its result is dominated by unrelated files; do not
run it here.

---

## 1. Viability and platform terms

- **Auth once, then unattended.** After a single authentication the collector
  must be able to sync forever with no user action in the ingestion path.
  Reject any design where the only way data arrives is a user-triggered
  export, upload, or paste (CSV files, "download your data" archives, a
  browser tab that must stay open, an app that must be in the foreground, a
  session that expires without a refresh path). The one sanctioned
  user-touched path is `historyImport` — a one-time, idempotent bulk import
  that sits **beside** a working background sync, never instead of it. A
  source that fails this rule is a "Won't implement" row on the source
  roadmap, not a code review.
- **Terms of service.** Read the platform's developer / API terms and its
  acceptable-use policy (web fetch; cite the URL and the date read).
  Record in the review: (a) whether a user-run local application may retrieve
  and store the user's own data with the credential type the source uses,
  (b) any restriction on caching, retention, or derived data, (c) required
  attribution or branding (declare it via `attribution` on the descriptor and
  a `TRADEMARKS.md` row), (d) rate limits, quota, and any cap on users per
  registered app — the source's `defaultSyncInterval`, paging, and
  `retryAfterMs` handling must respect them and the docs must state the cap,
  (e) whether the source relies on an unofficial protocol, reverse
  engineering, or scraping. Unofficial access is not an automatic reject,
  but it is a decision the maintainers make explicitly: surface it as a
  blocking finding with the relevant clause quoted, so the PR description
  records the decision.
- **Consent scope.** OAuth scopes and API permissions are the minimum the
  source needs. A scope requested "for later" is a finding.

## 2. Encapsulation — nothing source-specific outside the package

The `defineSource()` descriptor is the contract. If a consumer needs
something source-specific, the descriptor grows a field and consumers read it
through the registry. Verify:

- Grep the source id, provider id, and display name across `packages/core`,
  `packages/gateway` (including `packages/gateway/portal/`),
  `packages/collector`, `packages/cli`, `packages/cli-shared`,
  `packages/types`, `ios/`, `android/`, and `extension/`. Triage: ignore
  comments, doc strings, preview or sample fixtures, and tests that
  enumerate every source; the legitimate code hits are generic registries
  (`DEVICE_HOSTED_SOURCE_TYPES` for phone sources, `snapshot-emitters.json`,
  universes, docs). Anything else that branches, lists, or formats on the
  name is a finding — a hard-coded provider list in a CLI command counts.
- No source-specific unit noun, icon, color, label, URL construction,
  URL parsing, schema, or normalization in shared code. Each of these has a
  descriptor field (`unitName`, `icon`, `name`, `urlPatterns`,
  `urlCanonicalizer`, `ownedWebDomains`, `selfIdentity`, `analyticsSchemas`,
  `documentEventProfile`, …). Use the field; do not add a case downstream.
- No new gateway route, worker, or migration that exists only for this
  source. If the source needs a capability the gateway lacks, the review
  asks for a generic capability on the descriptor, not a special path.
- The reverse direction too: the package imports only `@omnesis/core`,
  `@omnesis/source-sdk`, `@omnesis/types`, `@omnesis/config` — never
  `@omnesis/gateway` or `@omnesis/collector`, and never a relative path into
  another package.

## 3. Descriptor and identity

- Exactly one default export: `defineSource()`, `defineProvider()`, or
  `defineStructuredSource()`. A platform hosting several data kinds behind
  one authentication is one `defineProvider()` with several sources, not
  several packages. A single source can declare `authenticate(session)`;
  shared credential state and a shared account context belong on
  `defineProvider()` even when it currently hosts only one source (see § 4).
- `id` is a stable kebab-case base id with no account suffix; the composed
  runtime id is `<id>:<accountId>` and the descriptor id is what
  `urlPatterns`, `unitName`, universes and docs are keyed by. A descriptor
  id that differs from the `sourceId` prefix (`whatsapp-messages` vs
  `whatsapp:<phone>`) silently loses its unit noun in the portal — flag it.
- `name`, `description`, `unitName` (plural noun: "emails", "workouts")
  are set on every source entry. `primaryCount` is set when the source emits
  both documents and analytics rows, or the headline count shows the wrong
  plane.
- `experimental: true` until the source has run against real data for long
  enough to trust; the collector then hides it from the add-source picker
  unless `OMNESIS_EXPERIMENTAL=1`. An experimental source is documented only
  on `website/docs/experimental.html`.
- `supportedPlatforms` is set for a source that reads an OS-specific local
  store; omitted for a cross-platform one.
- `singleInstance: true` only when a host genuinely admits one instance
  (one local database). Its scope is per host, not global.
- `discover()` may return IDs or `AccountDescriptor`s. IDs are stable keys;
  labels, subjects, tenants and aliases describe them, never rename or merge
  them. Test legacy ID-only discovery and descriptor refresh on an existing
  source. An assigned account absent from authoritative discovery is refused
  without preventing an available sibling from loading.
- `defaultSyncInterval` for any platform with a quota or rate limit.
- `conversational: true` only for message streams that render audio inline;
  it decides how audio is routed, so a wrong value misroutes voice notes.
- Logger component is `source:<id>` or `provider:<id>`, one-line template
  literals. No `console.*` (the § 0 grep lists them; ESLint does not).
- Tunables (page sizes, backoffs, thresholds) live in `omnesisConfigSchema`
  or the descriptor, not as literals scattered through the package.
- A source that asks the operator for a setting declares `config:` with
  `config.object({...})`, not a hand-written `params:` array. The two are
  mutually exclusive and `defineSource` refuses both. The declaration is
  what produces the form clients render, the validator the host runs, and
  the type `create()` receives — a hand-written array produces only the
  first, so the other two get written again by hand and drift.
- Every setting the factory reads is declared. A value read through a cast
  over `sourceConfig.params` is a setting no form can produce and no
  validator checks; it exists only in a hand-edited file.
- A setting the operator cannot answer while adding the source is
  `advanced: true` — declared, parsed and typed, but off the add form.
- A path setting says what has to be true of it as data: `mustExist`,
  `mustContain` with `mustContainKind`, and `containsHint` for the one
  branch only the source can explain. It does not expand the path itself —
  the host resolves a declared path before `create()` sees it, so a source
  that calls its own expansion is a source whose factory can disagree with
  its own validator.
- `check` is for what data cannot express, and its presence should be
  arguable. A blank value that means "detect it" also needs
  `checkWhenEmpty`.
- Every optional setting carries `help` saying what leaving it blank does.
  The label says what the field is called; only `help` answers the question
  the operator actually has.
- Schema defaults, patterns, select options and list element types are valid
  at definition time. Required whitespace fails; numeric coercion does not turn
  whitespace, booleans, arrays or objects into a number. Test host checks on
  each list element, including the derived form validator. Text lists split on
  commas/newlines except paths (newlines); use `separator: "newline"` for globs
  or other values whose commas are literal. Round-trip installed config strings.

### 3.1 Evolution and host compatibility

- Declare `contract.apiVersion` separately from state version and output
  revision. Current-generation packages use 2; omitted means 1. Test refusal
  by a host that cannot load the generation, not just definition-time validation.
- `requires` names the capabilities correctness depends on. Scoped claims need
  `snapshot-sessions`; versioned migrations, legacy classification, `maxBytes`,
  and `onUnreadable: "stop"` need `state-envelope`, even for state version 1.
  Verify each required behavior against `HOST_CAPABILITIES` and a real host
  code-path test. Never advertise reserved `connection-identity` without opaque
  connection allocation and alias resolution actually working.
- A missing capability refuses creation, reaches setup-failure reporting, and
  leaves supported siblings operational. Provider and entry requirements merge;
  a provider-level state decoder must never migrate a child's bookmark.
- `outputRevision` describes output meaning, not cursor shape. It does not
  schedule reprocessing; prove the explicit re-emission/backfill mechanism if
  output changes must affect already indexed records.
- `contract.state.decode` accepts every settled, pending, empty-store and legacy
  state the source can produce. Supply a complete major migration chain and
  classify bare installed cursors with `legacyVersion` where needed. Minor
  additions tolerate missing fields. Test real installed cursor fixtures through
  `resolveSourceState` and `withVersionedState`, not just the decoder.
- `onUnreadable` reflects replayability: `rebootstrap` only where upstream can
  replenish the history; `stop` otherwise. A downgrade or failed migration must
  not overwrite the prior cursor. Check operator remediation and repeated ticks.
- `maxBytes` measures the encoded envelope. Test realistic large state, and a
  failing ceiling through the wrapper and runner with the prior cursor intact.
  Class instances retain getters, private-field receivers and lifecycle hooks.

## 4. Auth and credentials

- `authType` matches the real flow (`oauth | qr | api-key | link-widget |
local`). `link-widget` also needs `widgetOrigins` and `widgetRenderer`, or
  the portal's Content-Security-Policy blocks the vendor SDK and the widget
  never opens.
- `acceptsAuthCode: true` exactly when `authFlow` awaits
  `callbacks.receiveCode()` (grep the provider for it); without the flag the
  CLI and portal never offer the paste-code fallback and a headless flow
  hangs until timeout. An OAuth redirect is built from
  `callbacks.publicBaseUrl` with `callbacks.flowId` as `state`, so a
  collector behind NAT still completes.
- No fixed local callback port. A second concurrent add of the same provider
  must not fail with an address-in-use error.
- Credentials are written only through the shared secret-file helpers in
  `@omnesis/core` (`writeProviderAccountCredentials`, `writeSecretJsonFile`),
  under the per-account tree, and only **after** the credential has been
  verified against the platform. Nothing is persisted for a failed add.
- Refreshed tokens are persisted, not held in a closure; a restart must not
  re-prompt.
- A new source declares `authenticate(session)`, not `authFlow`. The old
  callback shape still runs, so an existing provider is not broken, but it
  cannot ask twice, cannot carry its own instructions, and cannot say whether
  a challenge expects an answer.
- Every challenge carries the words that go with it — a `title`, and
  `instructions` wherever the operator has to do something outside Omnesis.
  A client composing that sentence would need a branch per source, which is
  the thing source encapsulation forbids. Grep the portal and CLI for the
  platform's name; finding it is the bug.
- `show` for a challenge nobody answers through the host (a pairing code, a
  redirect this machine catches on loopback); `ask` for one that comes back
  (a gateway-caught redirect, a pasted code, fields, a widget result).
- `canShow(kind)` gates the selected interaction. Undeclared client capabilities
  mean legacy redirect/QR display, not support for every challenge. Unsupported
  `ask` fails immediately; shown challenges, nonpending questions and redirects
  or widgets cannot be answered through the generic answer endpoint. Round-trip
  every produced challenge, including an `elsewhere` redirect, through the
  subprocess parser and gateway route.
- Field requirements come from their declarations. Validate supplied values as
  well as later answers; repeated invalid answers report `credential-rejected`.
  Re-authentication must resolve `session.accountId`, never silently persist a
  different account. Cancel, timeout and retry information survives the wire.
- Values the operator supplies are asked for, not pre-collected. A
  re-authentication whose stored credential is the thing that stopped working
  must be able to ask for a new one.
- Failures are `AuthFailure` with a code. In particular a refusal and an
  unreachable platform are separate arms: one never clears by retrying, the
  other may clear on its own.
- `credentialState()` answers from the stored credential, never from a live
  request; a network blip must not park the source in `needs-auth` and fire
  the reminder ladder. Report `unknown` when the credential cannot be read —
  a locked keyring is not a missing credential — and `connected` with an
  `expiresAt` when the platform names a deadline, rather than flipping to
  broken on the day it passes. `isAuthenticated()` is the deprecated form.
- `discover()` and `cleanupCredentials()` use `ctx.configDir`, and
  `authenticate()` uses `session.host.configDir`;
  `create()` uses `host.configDir` (or `host.stateDir` for per-account
  state). Never re-derive the default
  config directory — an isolated test instance would otherwise read or wipe
  the operator's live credentials.
- No token, key, or secret in logs, error messages, or document metadata.
- A throw from `create()`, `discover()`, or `createContext()` is the message
  the operator reads as the reason the source was not added: it names the
  condition and the fix.

## 5. Sync runtime

- **Cursor.** Opaque, JSON-serialisable, with explicit state evolution (§ 3.1).
  Shared handoff cursors must be portable across hosts; member-local file maps
  may name that member's own paths. Never mutate a decoded prior cursor before
  the page commits. A failure must leave the installed checkpoint usable.
- **Scoped host.** Prefer `CreateOptions.host`, not the collector's gateway
  client or global configuration. Analytics reads stay within declared tables;
  writes stay on pages. `stateDir` is account-scoped and shared by sibling sources:
  use distinct filenames and do not mistake a host-created directory for a
  credential. Test removal of the last account with empty state directories.
- **Local probes.** `probeReadAccess` and `probeLocalStores` are fresh read-only
  observations honoring cancellation, not a sync, repair, migration or cached
  success. Store reports distinguish encrypted/plaintext/absent/locked/
  unverifiable without paths, filenames, raw errors or indexed content.
- **Paging.** `syncPage` / `emptySync`; `hasMore` terminates. Nothing caps
  page count except the wall-clock timeout, so an always-true `hasMore` burns
  an hour per run.
- **Abort.** `opts.signal` reaches every upstream call, in `sync()` and in
  `syncStructured()` alike. The § 0 grep shows whether the source reads it
  at all.
- **Data cutoff.** `applyDataCutoff` with `CreateOptions.dataCutoff`.
- **Lifecycle.** `dispose()` closes handles. A source holding a live
  connection implements `suspend()` / `resume()`; without them a disabled
  push source keeps reconnecting and a re-enable stacks a second socket.
- **Resync.** `onResync()` re-marks the source's whole local store for
  emission, so a resync rebuilds the corpus in full rather than from recent
  changes, and fences a late page from a run that timed out.
- **Change-triggered sync.** `watchPaths` names the database and its `-wal`
  sibling; `watchDirectoryPaths` for directories that may be absent at boot.
- **Freshness.** `freshness` is declared only when `sync()` is how data
  arrives; on a push or analytics-only source it produces a false stall
  warning.
- **Errors.** Failures at the sync boundary are typed `SyncError`s with
  `retryable`, `retryAfterMs` for rate limits, and a `SyncRemediation` for
  anything the operator must fix by hand (a permission grant, a re-login).
  Untyped throws fall through substring matching into `unknown` with no
  remedy.
- **Failure scope.** One bad item is skipped and logged; only a transient
  failure re-throws the page. A page must never advance the cursor past
  input it did not durably emit, and never fail the whole page for one item.
- **Rate limits.** The platform's limits are honoured (`retryAfterMs`,
  `defaultSyncInterval`, the shared rate limiter), and the client sends an
  identifying User-Agent where the platform asks for one.
- **Writer cost.** A source that emits a burst (a full bootstrap, a resync)
  is processed by a single writer thread on the gateway. Page sizes and the
  amount of metadata, links, and people per document decide how long that
  writer is held; name the consumers whose cost model changes if this source
  emits far more of anything per item than its peers.

## 6. Deletions and snapshots

This section owns the deletion contract; § 13 and § 15 refer back to it.

- A source that **knows** an item was deleted names it once, not on every
  sync. On the analytics side that lives on the table write, so a source
  deleting from several tables says so per table, and each deletion is a
  `deletedKeys` record over the columns the TABLE declares as its
  `deleteKey` (defaulting to its primary key). Check the declaration, not the
  page: a key coarser than the primary key means "every row of this group goes
  together", which is right for a table re-read per parent and wrong for one
  whose rows are deleted individually.
- A source with no deletion signal sends a **snapshot** (`presentExternalIds`
  for documents, `presentKeys` per table write) only on the final page
  (`hasMore: false`), assembled with
  `SnapshotEnumeration` so a partition it could not read is withheld rather
  than reported absent. The gateway treats an omission as a claim to be
  corroborated over time, but a snapshot built from a partial read still
  starts a deletion clock on items that exist.
- A source with several backing stores may narrow the assertion instead of
  withholding it: `presentClaims` (from `SnapshotEnumeration.claims()`) names
  each store read in full and what it holds, and every document carries the
  `partitionKey` of the store it came from. Check both halves — a claim names
  a partition, and a document belongs to one only because the source stamped
  it, so a claim on a partition whose documents carry no key asks for
  deletions that silently never happen. `presentExternalIds` and
  `presentClaims` on one page is refused, not resolved: a complete read
  vouches for the whole source, and claims are the degraded cycle's form.
- Partition keys are deterministic and bounded to 256 characters. Prove the
  upgrade re-stamps unchanged documents, and state how legacy unpartitioned
  documents or vanished partitions eventually reconcile. An unreadable file
  keeps last-known IDs while readable siblings may delete; an unknown file or
  root stays gapped no matter how many cycles it fails. Test removal/repointing
  of configured scope separately from an unavailable mount and cross-root moves.
- Every file emitting a snapshot has a row in
  `packages/source-sdk/src/snapshot-emitters.json` whose sentence honestly
  says how completeness is guaranteed; the snapshot-contract test reddens
  otherwise. Read the sentence and check it against the code — the test
  cannot.
- On a replicated source, deletions are reconciled by the lease holder; the
  source still emits tombstones and snapshots regardless of the lease.

## 7. Documents and analytics rows

- `externalId` is stable across syncs and across restarts; aggregates use a
  composite key. `contentHash` via the shared helper. `sourceCreatedAt` /
  `sourceUpdatedAt` are UTC ISO 8601, and `sourceUpdatedAt` moves when the
  item is edited upstream — a source that copies the creation time into it
  never re-emits an edit. Wall-clock times from the platform are converted
  with the shared time-zone helpers, never assumed local.
- Content is markdown (HTML through `htmlToMarkdown`), bounded in size, with
  the searchable text first. No secrets or credentials in content or
  metadata.
- Relations use `EdgeDeclaration` (thread, parent, attachment, cited
  document), not ad-hoc metadata keys.
- Attachments go through `resolveAttachmentConfig(sourceConfig, {
includeAudioTypes })` and the injected `extractAttachment`; no bespoke
  allow-list.
- **Analytics reads.** The `analytics.query` handle reaches only the tables
  this source declares — its own, plus any shared with a sibling of the same
  type — and only as a single SELECT. A source that reads a table it does not
  declare is refused by the gateway, so a source relying on another's rows is
  a design problem to raise, not a query to fix.
- **Table writes.** A page names every table it fills, in the order the host
  should write them (`analytics`, one `TableWrite` or a list). A source whose
  upstream record fans out writes its children on the same page as their
  parent, so one cursor covers all of them — it does not paginate a phase per
  table, and there is no way to write outside the page at all. A table named
  twice is two writes in order, which is how a keyed set is replaced: the
  clear, then the rows. A page with nothing to write omits the field rather
  than naming a table with no rows.
- **One page, or two.** Rows go on one page when a checkpoint between them
  would be a lie — a parent and the children it fans out into. Rows that are
  merely in hand at the same moment belong on separate pages: each checkpoints,
  so a later failure leaves the earlier write standing. A source that writes
  its account list before walking each account over the network is doing this
  correctly, not working around the contract.
- **Analytics schemas** (structured and hybrid sources): non-empty
  `primaryKey`; no `_stream_id` column (the gateway appends it);
  `semanticTimeColumn` is a `DATE` or `TIMESTAMPTZ` column or explicitly
  `null`, never omitted and never a zone-less `TIMESTAMP`; a `record` spec
  with `titleColumns` / `keyColumns` so rows can be cited; `volatile: true`
  on fetch stamps and digests so a watch does not fire on every page;
  categorical columns carry `description` and `allowedValues` /
  `canonicalValues`; `boundDocument` keys equal the primary key as a set;
  `sharedDiscriminatorColumn` when sibling sources share a table, or one
  source's removal drops the sibling's rows. Fixed schemas evolve
  additively; `dynamicColumns: true` only when upstream users can reshape
  the table.

## 8. People

- Every document with a human counterpart carries `metadata.people` as
  `PersonMention[]`. Without it the source is invisible to person search,
  person pages, catch-up, and Watch person predicates. Sources with no human
  counterpart legitimately emit none, but a self-authored corpus still emits
  `{ role: "author", isSelf: true }`.
- Roles come only from `PERSON_ROLES` (author, sender, recipient,
  participant, attendee, mentioned, contact, owner). Map platform roles onto
  them; an invented role is stored but scores nothing, so the person never
  gains an interaction score. `mentioned` and `contact` are neutral: a
  source that emits only those, or only recipients without self as sender,
  contributes nothing to the people ranking.
- Identifiers are normalised **by the source**: emails lower-cased, phones
  E.164 via `normalizePhone` with the region hint from
  `ingestionContext.phoneRegion`, platform handles in `lids` namespaced by
  source (`github:<login>`). The gateway does not normalise phones or LIDs;
  an un-namespaced handle can fuse two platforms' users.
- Self, one of two designs: a source whose account id **is** a platform
  identity (a login, an athlete id, a phone number) emits the account's own
  identifier as a normal mention and declares `selfIdentity` on the
  descriptor so the gateway resolves it to the self person; a source whose
  documents are inherently the user's own (notes, tasks) emits
  `isSelf: true`. An `isSelf` mention attaches **no** aliases, so it cannot
  be used to add identifiers to self, and a platform-id source that relies
  on it instead of `selfIdentity` leaves its own id as a duplicate person.
  The `accountPattern` handles an account id carrying more than identity.
- Bots, system senders, no-reply and shared addresses are excluded before
  they become people (`isNonIdentifyingEmail`, `isAutomatedSenderAddress`, a
  platform-specific bot check).
- Free-text or name-only mentions (a phone number quoted in a body, a
  reaction by display name) set `allowPersonCreation: false`.
- Names pass through `cleanPersonName`; never an email or phone in `name`;
  no generic labels ("Support Team") as a person.
- The roles the normalizer emits are the roles the source's
  `documentEventProfile` declares (§ 11 owns that check).
- Synthetic fixtures reference the universe cast (`cast.json`: `self`,
  `emails`, `phones`, `lids`, `extra.<sourceKey>Id`) via the shared cast
  helpers, so the new source joins the same identities as its peers instead
  of forming an identity island.

## 9. URLs

- `metadata.sourceUrl` opens **that item** in the platform's web or desktop
  surface, not a landing page. When no reliable per-item URL exists, omit it:
  a plausible-but-wrong URL sends the user to the wrong item and the UI
  cannot tell.
- `metadata.appUrl` only when a native scheme genuinely opens that item on a
  phone. iOS and Android try it first and fall back to `sourceUrl` when no
  installed app handles it, so a scheme that exists on only one platform is
  fine; a scheme that opens the app but not the item is not, because the
  launch succeeds and the fallback never runs. There is no separate
  desktop-app URL field: a native scheme may be the `sourceUrl` only when it
  opens the same item in the platform's desktop app; a scheme that works only
  on a phone belongs in `appUrl`.
- `urlPatterns`: the external id is **capture group 1**, equal to
  `externalId` case-insensitively; the resolver reads group 1 whatever
  `idGroup` says, so a pattern must work with `idGroup` unset. Patterns
  compile under RE2, ≤ 300 chars, ≤ 50 per source. Without patterns,
  inbound links to this source's items are dropped permanently and the
  reference graph never learns the edge. A test in the package extracts
  `externalId` from an emitted `sourceUrl` through the declared patterns.
- `ownedWebDomains`: bare lowercase hosts the source fully covers, so the
  browser extension stops capturing that site. Nothing broader.
- `urlCanonicalizer` when the item URL has several equivalent flavours; the
  canonical form is for dedup and lookup only, and its hosts must not
  collide with another source's rules (the gateway refuses the whole
  declaration bundle). Check the generic normaliser does not strip the part
  of the URL that carries identity (`?ref=`, a slash-less fragment).
- `urlHub` / `urlTargetRole` stay unset unless the source is a bag of links
  (bookmarks, history, captured pages).

## 10. Icons and presentation

- `icon` is declared with `sfSymbol`, `color`, `bgColor`, and a renderable
  image (`url` or `imageDataUri`) — the web portal and Android cannot draw
  SF Symbols. Missing → a generic document glyph in the portal, the timeline
  on both phones, and blank space in the CLI. The gateway rasterises to a
  64 px PNG data URI and drops anything over its size cap silently, so the
  asset must be a real SVG or PNG under the cap.
- Per-instance `icon` / `label` on the instance when the look depends on the
  account (institution, browser). A source whose accounts differ that way must
  also declare its **family** (`meta.family`) — the type's own name and glyph.
  A family is never assembled from an account row, so a source that declares
  none is shown by its raw type id wherever a client groups the corpus by
  type.
- The mark's owner and strategy (hot-linked vs bundled) has a row in
  `TRADEMARKS.md`; a bundled glyph from an icon set has its attribution in
  `THIRD_PARTY_NOTICES.md`; `attribution.itemFooter` carries any byline the
  platform's terms require.
- iOS presently maps unit nouns and human names through switches in
  `ios/Sources/Omnesis/UI/SourcesView.swift`; a source absent from them
  shows "docs" and its raw type id. Flag it, and prefer the generic fix over
  extending the switch.
- The rendered check (portal sources page and timeline) is a § 17 item.

## 11. Watch and the ontology

- Every document-emitting source declares `documentEventProfile`
  (`documentTypes`, `personRoles`, `metadataFields` with descriptions).
  Without it the source syncs and searches normally but the gateway lists it
  as unwatchable and every watch naming it is refused — nothing fails at
  build or sync time, and no repo-wide test requires the declaration.
- The declared types, roles, and fields are what the normalizer writes,
  proven by a parity test over the real sync path. A declared value nobody
  emits compiles a watch that can never fire; an undeclared field is absent
  from the watch journal.
- `identifiesPeople: true` on any field whose values can name a human.
- Two sources must be distinguishable by profile alone (the catalog hides
  source names).
- `documentTemporalProjections` use only the closed field set
  (`$semanticTime`, `scheduledAt`, `dueAt`, `endsAt`, `timeZone`, `status`);
  `temporalProjection` on analytics tables anchors on `$semanticTime` and
  references declared columns of the right type.
- `semanticallyIndexed` reflects reality; a semantic-match watch on an
  unindexed source is refused.

## 12. Multiple instances of the same source

The user may connect several accounts of one source (two mailboxes, two
phone numbers). Verify nothing structurally prevents it:

- Every namespace derives from `accountId` / `sourceId` / `providerId`
  passed to `create()` — no module-level singletons, caches, fixed file
  names, fixed ports, or fixed external-id namespaces.
- Local stores live under `configDir/<fileKey>/<accountId>/`; credentials
  under the per-account tree; `cleanupCredentials(accountId)` removes only
  that account.
- `discover()` returns per-account ids; `authFlow()` returns the account it
  actually authenticated.
- Two instances can sync concurrently: no shared lock file, no shared
  temporary path, no process-wide rate limiter that starves one account.
- Pausing or removing one account leaves its sibling untouched
  (`packages/collector/src/e2e/multi-account.e2e.test.ts` is the reference).

## 13. Multi-device mode

`multiDevice` declares how several collectors may serve one account:
`exclusive` (default), `handoff`, `replicated`, `partitioned`. The mode is
pinned when the source row is created and cannot be changed later except
from `exclusive`, so it must be right at first ship.

- The chosen mode matches where the data lives. Cloud-authoritative with an
  account-side cursor → `handoff` (no built-in source ships it yet; it
  requires lease-aware syncing and portable cursors). The same data visible
  on every device via platform sync → `replicated`, which obliges external
  ids to be **identical for the same item on every device** — verify, do not
  assume; host-local uuids make it `exclusive`. Each device observes a
  genuinely distinct stream → `partitioned`. Picking `replicated` for
  per-device streams makes two hosts overwrite each other's rows and delete
  each other's documents on every snapshot.
- `partitioned`: no device or stream key inside external ids (the gateway
  owns the stream); host-local parameters carry `scope: "member"`.
- `replicated`: `replicaVersionPolicy: "source-updated-at"` only if
  `sourceUpdatedAt` is monotone canonical UTC; deletions follow § 6.
- The e2e suites for the mode under `packages/collector/src/e2e/`
  (`partitioned-universe`, `replicated-universe`, `handoff-universe`,
  `source-membership`, `replica-*-dispute`) cover the source's shape, or a
  provider-specific acceptance test is added.

## 14. Phone-pushed sources

A source whose data is pushed by the iOS or Android app rather than synced
by a collector has extra obligations on both sides of the wire:

- The descriptor sets `execution: "external"` (the collector schedules no
  sync; the portal hides it from Add source and inerts the sync-interval
  knobs). `pushBased: true` is the deprecated spelling. `gatewayHosted` is
  different: it marks a source whose data arrives at the gateway itself, as
  the browser extension's pages and the Hermes and OpenClaw transcripts do.
- The type is in `DEVICE_HOSTED_SOURCE_TYPES` (`packages/types/src/device.ts`)
  so the `write:<type>` scope exists; otherwise its batches get 403 and the
  phone's whole push queue stalls behind them.
- Both apps declare the hosted-source contract (iOS `Source.swift`, Android
  `DeviceCapabilities.kt`) with the same `multiDevice` mode as the
  descriptor, and `packages/collector/src/e2e/mobile-source-modes.e2e.test.ts`
  asserts it.
- Push sources register under `<type>:local`: two phones share one row
  unless the mode is `partitioned` or `replicated`. Decide deliberately.
- Permission health uses `mobile-permission-health.ts` states with `impact`
  and `remediation` once unhealthy; the app's activation flow requests the
  permission and reports it.
- Snapshots emitted from Swift or Kotlin are not covered by the
  snapshot-contract test; review their completeness by hand against § 6.
- Battery and background execution: the push runs from a background task
  with bounded work per wake; a resync from a phone is refused for push-only
  types (it would wipe data the phone cannot replay), so the app must be
  able to re-send its full history on its own.

## 15. Touchpoints outside the package

Most of these are silent when forgotten. Check each:

| Touchpoint                                                                                                                                                | Why                                                                                         | If forgotten                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/collector/package.json` dependency on `@omnesis/provider-<name>`                                                                                | the only registration step; the collector imports every `@omnesis/provider-*` it depends on | source never appears (silent)                                             |
| `package-lock.json` entries for the package                                                                                                               | `npm ci` in CI                                                                              | install fails (loud)                                                      |
| root `tsconfig.json` `references`                                                                                                                         | `tsc --build` coverage                                                                      | package never type-checked (silent)                                       |
| package `tsconfig.json`; a `tsconfig.tests.json` only if the main one excludes `*.test.ts`                                                                | every suite must be in some typecheck program                                               | `scripts/typecheck-lanes.test.mjs` reddens when a suite is in none (loud) |
| `package.json`: `@omnesis/provider-<name>`, `license: AGPL-3.0-or-later`, src-pointing `main`, declared runtime deps                                      | release transform, phantom-deps test                                                        | publish breaks (loud)                                                     |
| SPDX header on every file (`scripts/add-license-header.mjs`)                                                                                              | license hygiene                                                                             | pre-commit hook (loud)                                                    |
| `knip.json` collector `ignoreDependencies`                                                                                                                | dep-only registration reads as unused                                                       | knip reddens (loud)                                                       |
| synth twin `packages/providers-synth/<name>/` (also in root tsconfig, knip, collector deps)                                                               | demo gateway, every synthetic e2e sweep                                                     | source missing from demos and e2e (silent)                                |
| `evals/universes/default/` fixtures + `universe.json` seed; `e2e-minimal` fixtures and its build script                                                   | universes                                                                                   | seeded-without-fixture is loud; missing entirely is silent                |
| golden corpus snapshot regenerated; `synth-pipeline.e2e.test.ts` non-one-to-one list if a fixture entry yields ≠ 1 document                               | e2e                                                                                         | snapshot diff / count assertion (loud)                                    |
| `snapshot-emitters.json` row (§ 6)                                                                                                                        | snapshot discipline                                                                         | snapshot-contract test (loud)                                             |
| `DEVICE_HOSTED_SOURCE_TYPES` (phone sources) / `packages/gateway/src/internal-source-descriptors.ts` (gateway-hosted)                                     | § 14                                                                                        | 403s / never advertised                                                   |
| `privacy/pii-allowlist.json` path-scoped entries for invented fixture identities                                                                          | PII scan                                                                                    | commit hook (loud)                                                        |
| `website/docs/sources.html` row (or `experimental.html` while experimental); `setup.html` / `apps.html` if setup steps exist; any per-app user cap stated | public docs                                                                                 | nothing checks it (silent)                                                |
| `TRADEMARKS.md`, `THIRD_PARTY_NOTICES.md` (§ 10)                                                                                                          | marks                                                                                       | undocumented mark use                                                     |
| source roadmap master issue: row moves to Implemented                                                                                                     | process                                                                                     | roadmap drifts                                                            |
| `CHANGELOG.md`                                                                                                                                            | release notes                                                                               | none                                                                      |

## 16. Tests

From the § 0 test run, confirm the package's test files cover, next to the
code as `*.test.ts`:

- **Bootstrap** — first sync over a populated fixture yields the expected
  documents (and rows).
- **Incremental** — a second sync with the first cursor yields nothing; one
  added item yields only that item.
- **Normalization** — pure raw-row → `DocumentInput` tests over
  representative fixtures, including people, URLs, timestamps, and the
  edge declarations.
- **Error handling** — auth failure, permission failure, rate limit, a
  malformed item, and a platform outage each surface as the right typed
  error without poisoning the cursor.
- **Unchanged upstream is a no-op** — `expectUnchangedUpstreamIsNoOp` /
  `runSyncCycleContract` from `@omnesis/source-sdk/testing` for any source
  with more than one phase.
- **Contract parity** — the `documentEventProfile` parity test (§ 11), the
  `urlPatterns` ↔ `externalId` test (§ 9), and a complete-`SourceIcon`
  assertion (§ 10).
- **Multi-instance** — two `create()` calls with different account ids do
  not share state.
- **Installed-state and steady-state** — migrate bare and enveloped cursors at
  each pending phase, sync several unchanged or impaired cycles, and assert
  preserved IDs, no duplicate rows and no false deletion evidence. Exercise
  real create/update/delete/move paths and a permanently unreadable sibling.
- **Cross-boundary failures** — auth through subprocess/client parsing; hybrid
  documents plus multiple table writes with failures between planes; unchanged
  checkpoint until every required write succeeds, including replay.
- **Multi-device** — the mode's obligations (§ 13) where non-exclusive.
- Push sources test their push path; the app-side logic runs in the fast
  native lanes.
- A spawned-gateway e2e on `SyntheticE2EHarness` when the source's synth
  twin exists (the per-source suites under `packages/collector/src/e2e/`
  are the pattern).
- Fixtures are invented from scratch: reserved domains, fictional phone
  ranges, invented names, nothing paraphrased from anyone's real data.
- Tests use unique temp paths and ports ≥ 17601.

## 17. Manual validation to hand back to the author

Some checks cannot be automated. The report ends with a list the author
confirms before merge, each with the exact steps:

1. Add the source through the portal and through `omnesis sources add` on a
   fresh install; the auth flow completes both with the browser redirect
   and, where `acceptsAuthCode` is set, with a pasted code.
2. Add a **second** account of the same source while the first is syncing.
3. Open three documents from the portal's "Open in source" and confirm each
   lands on the right item on desktop.
4. On iOS and on Android, tap "Open in source" on the same documents, once
   with the platform's app installed and once without; confirm the item
   opens or the web fallback does, never a silent no-op.
5. The icon, name, and unit noun render in the portal sources page, the
   portal timeline, and the mobile timeline. When a synthetic universe
   seeds the source, `scripts/shot-portal.sh sources` against an isolated
   synthetic gateway captures the portal half; read the PNG.
6. Search by a person the source emitted (`from:` / a person page) returns
   its documents; the person is the same record as in a sibling source.
7. Create a watch that names the source and one of its declared roles or
   fields; it compiles and fires on a new item.
8. Disable, re-enable, pause, remove, and re-add the source; then resync it
   from the portal; the corpus matches the platform afterwards and nothing
   reconnects twice.
9. Stop the collector for longer than the platform's token lifetime and
   restart it; the source resumes without re-authenticating.
10. For a non-exclusive multi-device mode, host the source from two
    collectors (or two phones) and confirm the union is right and detaching
    one loses nothing.

---

## Execution rules

- Sub-agents review; they do not edit. Collect their findings, de-duplicate,
  and rank: **blocking** (viability, terms, encapsulation, data loss,
  credential handling, wrong multi-device mode, missing registration),
  **must fix before merge** (silent gaps: profile, icon, people, URLs,
  snapshot discipline, tests), **should fix** (hygiene, tunables, docs
  wording), **manual validation** (§ 17).
- For each finding give the file and line, the contract clause it violates
  (quote the doc comment or the page section), and what a user would see.
- Fix mechanical findings directly on the branch — missing registrations,
  headers, lockfile, knip, a missing profile whose values are evident from
  the normalizer — and say what you changed. Leave design decisions
  (mode choice, terms-of-service risk, unofficial protocol use) as findings
  for the author and maintainers.
- Re-run the baseline signals from § 0 after fixes and the authoritative affected
  gate for the current tree. Run additional provider E2E coverage where the
  changed behavior needs it; a narrowed diagnostic is not the broader gate.
  Respect repository admission for all heavy checks; a queued job is not failed.
- Finish with the ranked report, the list of files you changed, and the
  manual validation list. Do not declare the source ready: that is the
  author's and maintainers' call once § 17 is done.

$ARGUMENTS
