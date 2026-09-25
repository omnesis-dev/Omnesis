# Changelog

## Unreleased

### Source contract and upgrade safety

Sources can declare versioned cursor migrations, required host capabilities,
typed configuration and authentication sessions. Unsupported requirements refuse
the affected source before creation rather than silently omitting its behavior;
supported siblings remain eligible to sync. Existing unversioned declarations
remain supported. Changing an output revision alone does not run a backfill.

Upgrade the gateway before collectors. Collectors refuse a gateway that does
not advertise the required source-wire contract. Once a source adopts that
contract, older collectors cannot read its cursor or write to it: upgrade every
collector sharing that source, including replicated members. Other sources and
phone-only streams remain eligible to sync. Gateway binary downgrade is not a
rollback strategy: restore a coherent pre-upgrade backup instead. An older
gateway may reset newer cursors and cannot enforce the adopted wire floor.

Adding member-local configuration fields does not interrupt an existing member
that still understands every pinned field, even while a sibling is offline.
The gateway keeps the existing configuration scope until all members advertise
the expanded set; member-local configuration and membership edits remain strictly checked.
Missing fields or incompatible storage modes still refuse the affected member.

Incomplete source scans now expose persistent, member-scoped warnings in the
portal, CLI and doctor. A successful assessment clears its corresponding warning;
unassessed or legacy status events do not silently clear it. Interrupted mixed
document-and-analytics pages replay from a durable journal, with analytics write
receipts preventing repeated deletion of rows restored by another collector.

Local-file scope removal resumes reconciliation after a complete configured-root
scan, while unavailable mounts retain their previous state. Deep root paths use
bounded partition keys and unchanged legacy entries are re-emitted to acquire
their partition. Unreadable notes and transcripts retain known IDs while readable
siblings continue reconciling; an unavailable transcript archive cannot turn a
move into deletion evidence. Apple sources without a local store save valid
empty-state seeds instead of repeatedly classifying their cursor as unreadable.

Chrome bookmarks publish complete presence even on unchanged-file cycles, so
lost cursors no longer strand deleted bookmarks. Granola performs daily complete
rewalks that reconcile documents and meeting rows together, retaining listed
notes whose detail reads fail. Notion database rewalks restamp legacy summaries
and reconcile removed databases and their rows while unreadable siblings remain
protected. Incomplete enumeration is reported without authorizing deletion.

Configuration validates path-list elements and rejects whitespace-only required
values. Newline-only list parsing preserves comma-containing exclusion globs.
Existing advanced member settings remain member-scoped, including browser
profile paths and Screen Time database paths; invalid local overrides report
validation failures instead of silently selecting another store.
Authentication rejects unsupported questions and answers to nonpending or shown
challenges, and preserves typed redirect variants across the subprocess boundary.

## 2026-08-20

### Fixed: Android no longer stalls on a Deep Research turn

A Deep Research run relays every reader's own events on the parent stream, wrapped
as `agent.subagent.event`. That is by far the highest-volume turn the product
produces: a measured two-reader run carried 6,899 events, 5,807 of them wrapped
child events, and a four-reader run carries several times that.

Android folded each wrapped `text.delta` / `thinking.delta` into the sub-agent
card's nested transcript, appending with `text + delta` — a copy of the whole
accumulated string per token — and did it on the same main-thread scope that
paints the transcript. Nothing renders that transcript: the card and the research
working-set surface show a researcher's identity, step count, token total, reached
documents and terminal summary, never its prose. So the phone spent the run
copying an invisible string at a cost that grew with its square, the main thread
never yielded a frame, and the conversation sat on the pre-first-token indicator
until the app was killed and the transcript refetched.

Child prose and reasoning are no longer kept, and the per-request scratch state is
replaced at each child request boundary rather than accumulated across a reader's
many sequential requests. iOS and the portal already did both — iOS's own comment
records having made and fixed this same mistake ("Keeping it made long research
runs repeatedly copy an invisible transcript") — so this closes a parity gap
rather than inventing a rule.

The event volume itself is unchanged: the gateway relays what it relayed before, and
every client discards the prose on arrival rather than being spared it.

### Fixed: a Deep Research run no longer dies on the planner's packaging, and says why when it stops

Deep Research is gated on one model turn: a planner sub-agent decomposes the
question into a fenced JSON array, and the loop fans readers out over it. The
parser accepted exactly one wrapping — a top-level array in the first fenced
block. A planner that sent the same plan as one fenced block per task, wrapped
in an object under `tasks`, or as a lone task object produced zero tasks, and
zero tasks ended the run before a single reader had searched anything. There was
no retry, so one formatting slip in one turn cost the whole question.

The parser now reads every fenced block, and reads a plan out of an array, an
object wrapping one, or a lone task object. Where blocks disagree, later wins:
a planner that echoes the brief's schema template before answering, or drafts a
plan and then corrects it, puts the answer last — and since the fan-out cap is a
head clamp, taking the union would have spent reader slots on the superseded
version and truncated the real one away. The exception is the one-task-per-block
style, where the blocks are parts of one plan rather than competing versions.

It still refuses to repair invalid JSON: patching syntax with a regex rewrites
string contents, and a plan the model did not author is worse than no plan. That
case is what the retry is for — a planner that finishes cleanly and hands back
something unreadable gets one more attempt under a brief that spells the
container out. A planner that _failed_ is not retried; it has an honest terminal
already, and re-running it would spend a second time on the same limit. Both
attempts are judged and their spend summed, so a retried run accounts for what
it actually cost.

A plan naming a reader that does not exist used to abandon every remaining task
alongside it. Now the bad entry is skipped and its siblings still run, because
one invented name is one bad entry, not a refusal to launch anything.

The other half is that a stopped run used to say the same sentence whatever
happened: "I couldn't verify enough evidence to answer that research question."
That reads as "your data does not hold the answer", which was true for exactly
one of the terminal states. The reason is now carried into both the log and the
sentence the reader gets, so a run that never planned, hit a cap, exhausted its
budget, or failed a stage says so instead of implying an empty corpus. Two
terminal reasons were split out to make that possible: `plan_unusable`, when
planning yielded nothing executable, and `evidence_unavailable`, when readers
cited documents the store could not hand back for verification. Both are kept
distinct from `no_results` for the same reason — in neither case did anything
establish that the corpus is empty, and in the second the evidence may well be
there and unreadable, which is a fault in the install rather than an answer.

## 2026-08-18

### Fixed: a compile's reasoning bound now binds on the backend most installs run

`/gateway/watch/compileReasoningTokens` (watches are experimental, so this knob
needs `OMNESIS_EXPERIMENTAL=1` to reach anything) was implemented against
Anthropic only. An install whose agent role points at an OpenAI-compatible
server could set the knob, read it back, and change nothing: the value reached
the turn and the backend dropped it.

The bound is now honoured wherever a server takes a thinking block, sized by one
shared rule rather than two: clear the provider's floor, and leave the answer its
room inside the output budget the two of them share. That second half is not
theoretical — probed against a reasoning model, an unbounded turn spent all
8,000 of its output tokens reasoning and returned no answer at all, which is
what a bound set at the whole budget would faithfully reproduce.

It stays fail-open everywhere it cannot be honoured, because a bound is worth
less than a turn: a backend or model that does not take one runs unbounded, a
server that rejects the field is re-asked without it, and a ceiling too small to
hold a budget beside the answer gets no bound. The answer's share is half the
output budget rather than a fixed slice, so a modest ceiling still gets a real
bound instead of none. Since "the operator set it" and "the turn was bounded" are
therefore different facts, the log says which.

On Anthropic the bound is now offered only to models that still accept an
explicit budget. The rest answer it with an HTTP 400 naming `thinking.type.enabled`
and pointing at `output_config.effort` instead — so asking for less thinking was
failing the whole turn, which is strictly worse than the unbounded compile it was
meant to improve. Expressing the bound as an effort level is what those models
want and is tracked in #1973. Where a budget IS sent, the turn now also asks for
interleaved thinking by name: adaptive thinking enables it implicitly and a fixed
budget does not, so bounding a compile was silently also stopping it thinking
between the things it reads.

## 2026-08-17

### Changed: Android — the main menu sits under the app, and the app slides aside to show it

The Android port of the iOS reveal, so the two apps move the same way. The
menu sits underneath and the app moves right to uncover it — corners rounding
as it lifts, a dimmed strip still standing on the trailing edge, which you can
tap to come back.

- `MenuRevealContainer` owns the choreography; `MenuReveal` holds the geometry
  and gesture decisions free of Compose, so they run in the emulator-less JVM
  lane against the same cases as the iOS suite.
- Starting a conversation and opening Settings moved onto a bar across the foot
  of the menu, which the list scrolls under. The bar's height is measured, so it
  cannot drift from its own padding or the user's font scale.
- The menu lays out only as wide as the app travels, capped so a tablet gets a
  menu rather than half a screen.
- The gesture yields on purpose: the pointer handler runs on
  `PointerEventPass.Main`, which reaches a parent only after its children, and
  refuses any drag a child has already consumed — a rail that scrolls sideways,
  a row moving its swipe actions.

### Added: Android — Omnesis Briefs

The proactive awareness feed, which Android did not have in any form. A triage
list: tap a row to read it, swipe it to clear it, long-press to talk back to it.
Clearing removes the row at once and puts it back where it was if the gateway
refuses. The menu entry appears only when the paired gateway reports the feature
active, and carries an unread badge refreshed when the menu is revealed.

The row's leading edge is deliberately left alone — a rightward swipe is how the
menu is revealed — which is the same trade the iOS feed makes.

### Changed: iOS — the main menu sits under the app, and the app slides aside to show it

The menu no longer slides in over the app. It sits underneath, and the section
you are on moves to the right to uncover it — corners rounding as it lifts, a
strip of it still standing on the trailing edge, dimmed, which you can tap to
come back. The reveal is dragged rather than summoned: it follows the finger
both ways, and a release settles at the speed the finger left.

- New `MenuRevealContainer` (`ios/Sources/Omnesis/UI/MenuRevealContainer.swift`)
  owns the whole choreography — layering, travel, scrim, corner radius and the
  drag. `MainMenuDrawer` keeps no offset or gesture of its own. Shared geometry,
  thresholds and timing live on `MenuReveal`, so a toolbar tap, a menu row and a
  released drag all settle identically.
- The reveal starts from anywhere in the leading 80% of the screen. The leading
  edge keeps a narrow strip carrying its own copy of the gesture, layered above
  the app: a touch starting at the very edge is claimed upstream by the
  navigation controller's screen-edge recogniser and never reaches the
  full-width gesture underneath.
- The menu lays out only as wide as the app moves, so its rows and buttons stay
  clear of the standing strip instead of running underneath it. That width is
  capped, so on iPad the menu stays a menu rather than growing to half the
  screen, and the app simply keeps more of it.
- Starting a conversation and opening Settings moved out of the scrolling list
  onto a bar across the foot of the menu, which the list scrolls under. The
  "Ask" row and the header gear are gone; the wordmark stays.
- Briefs rows lost their leading swipe: Ask and Dictate are now a long-press
  context menu, also published as accessibility actions. A rightward swipe on a
  row is how the menu is revealed, and a row claiming the same direction made
  that gesture unreliable in that one section. Clearing a brief is still a
  trailing swipe, unchanged.
- Horizontally-scrolling views (wide tables, card rails) and the Timeline panel
  — which closes on a rightward drag of its own — opt out of the reveal gesture
  with `menuRevealExcluded()`, so a drag that starts inside one moves that
  content and nothing else. The opt-out is gated on whether the region is
  actually taking touches: a panel parked off-screen keeps its layout frame,
  and excluding that would leave almost nowhere in a conversation to open the
  menu from.
- The attention banner now travels with the app rather than spanning the menu,
  since it reports on the app it sits over.
- `MenuReveal` carries the geometry and gesture decisions free of SwiftUI, so
  they are covered by the sim-less logic lane rather than only by rendered
  snapshots. `MenuRevealGestureUITests` drives the gestures themselves on the
  simulator against a fixture-seeded list — the only lane that can see a
  gesture conflict at all, since a still render shows every control present and
  correctly placed whether or not it responds.

### Fixed: a brief's trailing swipe actions did not respond to taps

Swiping a brief left revealed **Done** / **Got it** and **More…**, and tapping
either did nothing. The reveal's scrim carries a "Close menu" accessibility
label and button trait; those survive `allowsHitTesting(false)`, so at rest it
spread a full-screen accessibility element across the app. Anything beneath it
— a list row's swipe actions among them — reported as covered and refused
taps, and VoiceOver announced a close control that was not on screen. The scrim
now leaves the accessibility tree by the same rule that makes it inert.

### Fixed: the Briefs "More…" action opened nothing

Choosing **More…** from a brief's trailing swipe set the target and presented
no sheet. The feed carried two `.sheet` modifiers on the same view — one for
reading a brief, one for the dismiss options — and SwiftUI honours only one of
those, so the second silently never presented. Both destinations now share a
single presentation over a sum type, which cannot develop the same fault.

## 2026-08-08

### Changed: HTTP agents learn extended-output behavior from responses

HTTP agent backends no longer require operators to maintain a list of reasoning
model ids. Omnesis observes protocol reasoning fields and token details at
runtime, and it also treats an empty output-limit exhaustion as a provider-neutral
signal. A request that reaches its output limit without returning visible text or
a tool call is retried once with a bounded allowance of up to 32,768 tokens. This
shared backend behavior covers interactive conversations, sub-agents, Deep
Research, and background cognition runs.

`CONFIG_SCHEMA_VERSION` is 7. Existing config files that still contain the
retired `reasoningModels` key load safely: the key is reported and stripped while
the rest of the backend config is preserved.

## 2026-08-03

### Changed: One search pipeline, tuned directly under `search`

Every query — from the portal, the CLI, the agent, or `POST /search` — runs the same retrieval pipeline. Its tunables now sit directly on the `search` config object: `search.params` (fusion constants and limits), `search.boosts` (per-type and relevance multipliers), and `search.defaultFilters` (filters applied to every query). `CONFIG_SCHEMA_VERSION` is 6 — an existing config still loads, with the superseded search keys reported as stripped and the rest preserved.

- **Breaking (API):** `POST /search` no longer accepts or returns a per-request pipeline-selection field, and the agent's search tool drops the matching argument and stops reporting it on tool results. The corresponding CLI search flag is removed.
- `search.params.topRankBonus` / `nearTopRankBonus` and `search.boosts.relevanceBoostWeight` are now declared in the config schema, so they validate, survive a config load, and render on the portal Config page. The pipeline already read all three; a config that set them had them silently dropped.
- Fusion always runs reciprocal-rank fusion, including when no embedder is attached and only BM25 produced candidates. The rest of the pipeline is calibrated to the RRF score family — source priors are additive at that scale, and the rank bonuses are absolute additions on it — so passing raw BM25 scores through instead left both mechanisms present in the code and inert in effect. `stages.fusion.method` still reports `bm25-only` when the vector lane did not contribute.

## 2026-05-31

### Added: iPad-landscape support — agent side-panel split + landscape demo videos

On iPad in landscape, the agent screen now lays out as a true split instead of the iPhone overlay: the Timeline (citations) docks as a fixed ~⅓-width column and the conversation shrinks beside it, so the agent's output and its provenance are legible at once. On iPad in landscape only, the Timeline also opens itself the moment the agent produces its first citation, and freshly-streamed citation rows slide in from the trailing edge. iPhone and iPad-portrait are unchanged — they keep the full-width drawer that slides over the conversation.

- New `AgentLayout` gate (`ios/Sources/Omnesis/UI/Agent/AgentLayout.swift`) resolves `overlay` vs `sidePanel` from the container geometry (iPad + landscape + wide enough). One flag — `AgentLayout.iPadSplitEnabled` — reverts the whole feature to the iPhone overlay everywhere.
- `CitationsDrawer` gained a `docked` presentation (no scrim / sticky tabs / drag-to-close) that `AgentView` hosts in the split; the overlay presentation is byte-for-byte the previous iPhone behaviour.
- `TrailTimelineView` animates newly-arrived citation rows in from the trailing edge (stable per-event identity, so only genuinely-new rows animate). Applies to both presentations; most visible in the iPad split where the panel is open mid-stream.
- The landing page (`website/index.html`) now ships two demo carousels — portrait iPhone and landscape iPad — and picks one by viewport: phones and narrow/portrait viewports get the iPhone videos, wide landscape viewports (most desktops) get the iPad videos with neighbouring iPads peeking past each screen edge. Gated by `IPAD_DEMOS_ENABLED` in the page script. Each demo sits in a subtle device bezel over a soft spotlight so the dark app screens read against the dark page.
- `scripts/record-demos.sh --ipad` records the demo scenarios on an iPad Pro 13" (M5) in landscape (→ `demos/ipad/`), and `scripts/demos-to-video.sh --variant ipad` rotates + encodes them for the carousel (→ `website/demos/ipad/`). The demo build skips the push-permission prompt under automation so it never lands over a recording.
- Demo recordings can magnify the whole interface for legibility in the video via a single `DEMO_UI_SCALE` launch-environment knob (set to `1.3` for the iPad recordings); the shipping app is always 1×.

## 2026-05-15

### Fixed: "Open in source" on Gmail messages landed on the inbox home

The Gmail `urlCanonicalizer` rewrote every message URL to a synthetic dedup key (`https://mail.google.com/mail/#message/<id>`), and the collector mutated `metadata.sourceUrl` to that form before sending. Gmail's web UI doesn't recognize `#message/<id>` — clicking "Open in source" in the portal, or following an agent-returned URL, dropped users on the Gmail home instead of the email.

The fix splits "dedup key" from "display URL":

- The collector no longer overwrites `metadata.sourceUrl` (`canonicalizeDocs` removed from `packages/collector/src/source-sync-runner.ts`). Sources are responsible for emitting the user-facing openable URL.
- The gateway's `DocumentRepository` continues to canonicalize on write into the `documents.source_url` **column**, which is what `/documents/by-url` queries against. Eval suites keep working: any pasted URL flavor still resolves to the same docId via the canonicalizer registry.
- Gmail now emits `https://mail.google.com/mail/u/0/#all/<id>`. `#all/` opens the message regardless of folder/label; `/u/0/` is the account-index slot Gmail's own URLs use (`/u/<email>/` is NOT recognized by Gmail — returns "Temporary Error 404" — so we use the account index).
- The Gmail canonicalizer regex was widened from `(?:/u/\d+)?` to `(?:/u/[^/]+)?` so eval URLs pasted with any account-slot variant (digit or text) still collapse to the same dedup key.
- A one-shot migration rewrote 9556 existing Gmail rows' `metadata.sourceUrl` and 51212 chunk rows' `chunks.source_url` to the openable form. The migration code has been deleted (sole user, ran successfully); `LATEST_SCHEMA_VERSION` baselines fresh installs at 8.
- `packages/near-dupes/src/report/comparison.ts` had a `gmailUrl()` helper that converted stored URLs back into the openable form for report links — no longer needed; deleted.

## 2026-05-13

### Added: `omnesis lookup <url>` — find documents by canonicalized source URL

A thin CLI wrapper on the existing `POST /documents/by-url` + `/documents/bulk` endpoints. Paste a URL from a browser address bar, a note, or a chat message; the gateway canonicalizes it via each source's registered `urlCanonicalizer` (plus generic tracking-param / anchor stripping) and returns the matching documents as a short table (id prefix, date, source, title). `--json` returns `{ url, documents: [...] }`. Multi-match is the expected shape — a Gmail message and its parsed attachment children share the parent message URL.

### Fixed: Gmail URL canonicalizer dropped uppercase-named labels and categories

The Gmail `urlCanonicalizer` rule in `packages/providers/google/src/index.ts` used `[a-z0-9_-]+` for path segments between `#` and the trailing message id. User-defined Gmail labels are routinely mixed-case ("Promotions", "Work", "Project X"), so URLs like `https://mail.google.com/mail/u/0/#label/Promotions/<id>` silently bypassed the canonicalizer — the same message id reached via `#inbox/<id>` matched, but `#label/Promotions/<id>` missed. Broadened to `[^/]+`; the trailing 6+ hex chunk still anchors the id. Covers mixed-case labels, percent-encoded label names with spaces, and `#category/<Name>/<id>` system categories. Regression test in `packages/providers/google/src/index.test.ts` covers every Gmail flavor + the existing Drive variants.

## 2026-05-12

### Improved: Search retrieval quality and ranking

A bundle of search-pipeline fixes that lift recall on natural-language queries, collapse byte-identical duplicates, and add per-source-type ranking control.

- **BM25 defaults to OR with a stemming + diacritic-folding tokenizer.** `toFts5Query` joins terms with `OR` and drops per-term quoting; `chunks_fts` is created with `tokenize='porter unicode61 remove_diacritics 2'` so `invoice` matches `invoices` and `cérémonie` matches `ceremonie`. Existing installs are migrated on startup — the indexer detects the legacy bare-`unicode61` tokenizer, drops `chunks_fts`, recreates it with the new tokenizer string, and rebuilds the FTS index from `chunks`. Idempotent.
- **Content-hash dedupe pass at the end of the pipeline.** A final stage groups final candidates by `indexed_documents.content_hash` and keeps the highest-scoring representative per group, so a Drive re-upload of the same PDF and a Gmail attachment of the same PDF collapse to one row. Documents the indexer hasn't classified yet pass through unconditionally.
- **Per-source-type score prior with BM25 bypass.** New `search.sourcePriors.{weights, bm25BypassRank}` config — additive adjustments per source-id prefix, applied in the boost stage and skipped when a candidate has a strong BM25 hit (rank ≤ `bm25BypassRank`, default 3). Lets operators nudge bulky low-signal sources (e.g. `browser-history`) down without burying explicit keyword matches.
- **Family-aware embedder task prefixes (off by default).** New `search.embedderPrefixes.enabled` flag. When on, nomic-embed-text gets `search_query: ` / `search_document: ` and BGE gets `Represent this sentence for searching relevant passages: ` on queries only, matching each model card. Enabling on an existing install requires rebuilding the vector index. Also fixes a latent double-prefix bug on the query path.
- **Gmail URL canonicalizer now runs on the unstructured sync branch too.** The Gmail / Outlook / Calendar sync path (`instance.sync()`) was bypassing `canonicalizeDocs`, so message URLs that flowed through it weren't being collapsed onto `/mail/#message/<id>`. Both branches now canonicalize before write. _(Superseded 2026-05-15: collector no longer rewrites `metadata.sourceUrl`; the canonicalizer only feeds the gateway-side `documents.source_url` dedup column. See the 2026-05-15 entry.)_
- **Eval suites auto-expand expected docs by `content_hash` siblings.** `omnesis eval` resolves each expected docId, then posts to the new `POST /documents/content-hash-siblings` endpoint to union in byte-identical siblings — so a suite written against the Drive copy of a PDF still counts a hit on the Gmail-attachment copy. On by default; opt out with `--no-content-hash-expansion`. `eval doctor` reports `expanded_expected_docs` in JSON mode and an `Expanded: N docs after content-hash sibling expansion (+M added)` line in human mode.

### Added: Search eval toolkit (`omnesis eval`)

A CLI toolkit for measuring search quality and performance against a live gateway.

- New `@omnesis/eval` package with a YAML suite format that identifies expected documents by **deep source URL** (Gmail message URL, Notion page URL, custom URI schemes), so suites survive re-indexing.
- New CLI subcommands: `omnesis eval doctor <suite>` validates a suite against the live index, `omnesis eval run <suite>` runs the bench with configurable stage backends (`--stages bm25,vector,hybrid`), timed repeats (`--repeats N`), and pre-bench warmup (`--warmup-queries N`) for amortizing cold model loads, `omnesis eval show <run.json>` pretty-prints one query at a time (top-10 retrieved with score breakdowns, per-stage timings + candidate counts, hit/miss verdict), `omnesis eval compare <a> <b>` diffs two run outputs.
- New `POST /documents/by-url` endpoint resolves a batch of source URLs to documentIds. Response is keyed by the original URL the caller sent, so callers don't need to know the gateway's canonicalization rules.
- New `verbose: true` flag on `POST /search` populates a typed `debug` block on the response (model readiness state). The portal's existing verbose toggle now drives this consistently.
- Metrics: `hit@1`, `hit@5`, `hit@10`, `recall@10`, `MRR`, with `p50`/`p95`/`p99` latency aggregates and per-stage timing percentiles. Results are sliced by query `type` and `difficulty` labels.
- Run output captures every retrieved doc's `scoreBreakdown` (bm25 rank, vector rank, RRF, bonuses, boosts), per-stage timings + candidate counts, and the model-readiness state — enough to debug a missed query without re-running the bench.
- Progress JSONL stream + single-line status file written alongside the run JSON, so orchestrators can drive monitors and ETAs.

Suites live under `~/.config/omnesis/evals/suites/` and runs under `~/.config/omnesis/evals/runs/`; both are private to the operator and not committed.

### Added: Per-source URL-canonicalizer contract

Source packages declare how their URLs canonicalize; `@omnesis/core` stays source-agnostic.

- New `UrlCanonicalizerSpec` in `@omnesis/core/src/url-utils.ts` — declarative data (`{ hosts: string[], rules: { match, replacement }[] }`), no JS in core. `normalizeUrl(url, canonicalizers?)` dispatches to the rules of the matching host.
- New optional `urlCanonicalizer?: UrlCanonicalizerSpec` field on `SourceDefinition` and `ProviderSourceEntry` in `@omnesis/source-sdk`. Each source owns the URL-shape knowledge for its provider hosts.
- Google provider declares canonicalizers for `mail.google.com` (collapse all label/account flavors of a Gmail message onto `/mail/#message/<id>`) and `drive.google.com` + `docs.google.com` (collapse every Drive/Docs/Sheets/Slides URL flavor onto `/file/d/<id>`).
- Collector pushes the union of source-declared specs to the gateway via `POST /admin/url-canonicalizers` after `applySourcesSnapshot` returns. The gateway holds the registry in memory; re-pushed every collector boot, no persistence.
- Collector pre-canonicalizes outgoing `metadata.sourceUrl` at the ingest boundary in `source-sync-runner.ts` so `documents.source_url` lands canonical at write time. The gateway writer-worker stays source-agnostic.
- New `POST /admin/url-canonicalizers/recompute-source-urls` re-derives `source_url` on every existing row using the freshly-registered specs; the collector calls it right after the push. Goes through a new writer op `db.recanonicalizeSourceUrls` (the HTTP `db` handle is read-only).
- Two transient migrations (re-normalize `documents.source_url`) were deleted after they ran; `LATEST_SCHEMA_VERSION` baselines fresh installs at 4.

## 2026-03-10

### Improved: Source lifecycle robustness and debugging

**Bug fixes:**

- Fixed `add` command hanging — tagged providers with IDs so `doSetupSources` skips irrelevant provider setups (e.g. WhatsApp WebSocket)
- Fixed race condition where `saveConfig` triggered hot-reload concurrently with the API operation — now updates `registeredSourceKeys` before saving
- Fixed `enable` after `disable` not working — `registerProvider` now resets "disabled" state on re-registration
- Fixed `status --watch` showing stale data — replaced drop-on-busy guard with `pendingRefetch` coalescing pattern
- Fixed `add` command blocking HTTP response — sync loops now run in background

**Source removal cleanup:**

- Extracted source management into `SourceManager` class (from `main.ts`)

**New CLI commands:**

- `omnesis debug <plugin-id>` — shows sync cursor, status, gateway stats, and plugin-specific config.

**Status display:**

- `status --watch` reconnects automatically when collector disconnects (3s retry, yellow "disconnected" banner)

### Improved: Source lifecycle management

**CLI improvements:**

- `add` shows interactive account picker when multiple accounts discovered (e.g. Chrome profiles), with already-configured accounts filtered out
- `disable`, `enable`, `remove` support pattern matching: exact ID, base ID prefix (`gmail:`), or provider prefix (`google:`)
- `disable`, `enable`, `remove` show interactive multi-select picker when no argument given
- All commands list matched sources before asking for confirmation
- Apple source discovery returns actual iCloud email instead of "local"

**Collector hot-reload:**

- Detects newly added sources and starts sync without restart
- Detects disabled sources → marks as "disabled" (visible in status, stops syncing)
- Detects removed sources → fully unregisters (disappears from status)
- `registerProvider` merges plugins instead of overwriting (fixes adding second source from same provider)

**Status display:**

- Disabled sources show with `○` icon and "disabled" state in CLI status
- Disabled sources remain visible until explicitly removed via `remove`

**Bug fixes:**

- Fixed Set iteration bug in disable detection (mutating Set during `for...of` skipped elements)
- Fixed config key / plugin ID mismatch for Apple sources (`local` vs actual email)
- Fixed TypeScript errors (drive.test.ts mock types, CLI module detection, apple provider log type, whatsapp qrcode-terminal types)

**Other:**

- Test environment script uses stable path (`/tmp/omnesis-test`) so all terminals share same env
- `SyncEngine.getPluginsById()` and `SyncEngine.disablePlugin()` methods

### Added: Isolated test environments

- **`OMNESIS_CONFIG_DIR` env var** — overrides the default config/credentials directory (`~/.config/omnesis`). All providers, gateway DB (when `OMNESIS_CONFIG_DIR` is set), and config resolve through this, enabling fully isolated parallel test environments.
- **E2E testing guide** (`docs/e2e_testing.md`) — instructions for spinning up isolated environments, per-source testing notes (API costs, pairing risks), and full lifecycle test scripts.

### Added: Source management system

- **SourceDescriptor** — declarative interface in `@omnesis/core` that each provider exports, describing its sources, auth type, params, and flows. CLI and menubar can drive add/auth/remove flows without knowing plugin internals.
- **Source registry** — aggregates all descriptors from provider packages into a single registry (in collector and CLI).
- **Generic CLI `add` command** — interactive source picker using `@clack/prompts`. Supports provider selection, param input (e.g. vault path), and auth flows (OAuth, QR). No more hardcoded provider switch statements.
  - `omnesis add` — interactive: shows all available sources
  - `omnesis add gmail` — direct: adds Gmail
  - `omnesis add google` — provider shortcut: picks from Google sources
  - `omnesis add obsidian-notes /path/to/vault` — with inline params
- **New CLI commands**:
  - `omnesis sources` — list all available and configured sources
  - `omnesis enable <source-id>` — re-enable a disabled source
  - `omnesis disable <source-id>` — disable a source (keeps data)
  - `omnesis remove <source-id> [--delete-data]` — remove a source with optional data purge
- **Config shape extended** — `sources` and `providers` sections in config for explicit source registration (`SourceConfig`, `ProviderConfig` types)
- **`saveConfig()`** — new function in `@omnesis/core` to write config back to disk
- **Gateway bulk delete** — `deleteAllByPlugin()` and `deleteAllByProvider()` functions in gateway DB layer, with REST endpoints and `GatewayClient` interface methods
- **SyncEngine `unregisterPlugin()`** — stops sync timer, file watchers, and removes plugin from status at runtime
- **Collector `/sources/descriptors` endpoint** — serves serialized descriptors for menubar/UI consumption
- **Collector `/sources/remove` endpoint** — stops plugin sync and optionally deletes data via gateway
- **Credential cleanup** — `remove` command calls descriptor's `cleanupCredentials()` to delete auth state (Google tokens, WhatsApp sessions)

### Added: Obsidian vault ingestion

- **New provider package** (`@omnesis/provider-obsidian`) — reads `.md` files from Obsidian vaults
  - Frontmatter parsing (YAML), inline `#tag` extraction, `[[wikilink]]` extraction
  - Mtime-based incremental sync with content hash deduplication
  - Pagination (200 files/page) for large vaults
  - Configurable exclude patterns (e.g. `templates/**`)
  - `obsidian://open` deep links for each note
- **CLI `add obsidian` command** — validates vault path and adds to config
  - `bun run add obsidian /path/to/vault`
- **Config-driven vault registration** — vaults declared in `~/.config/omnesis/config.json` under `obsidian.vaults`
- **Hot-reload support** — new vaults added to config while collector is running are picked up automatically
- **Recursive file watching** — creating or modifying `.md` files in a vault triggers immediate sync (debounced)

### Changed

- **SyncEngine file watcher** — now supports directory-based `watchPaths` with `recursive: true` (previously only supported specific file paths). Obsidian uses this for vault-wide change detection.
- Added `ObsidianConfig` type to `@omnesis/core`
- Added `bun run add` shortcut script
