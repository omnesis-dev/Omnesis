# Omnesis

Index and search your entire digital life. Fully local, fully private.

CLAUDE.md is the **agent contract** for working in this repo. It is kept intentionally short. The public docs (under `website/docs/`) are deliberately concise and user-facing; for architectural or behavioral detail, **read the code** — it is the only complete reference.

## Where to read what

All paths below are local files. Use `Read` (or `Grep` to find the right page), not URLs.

| Topic                                                                                                                                                  | Where                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Engineering conventions (façade splits, defineSource, zod-at-boundary, …) — read first when establishing or imitating a pattern                        | `docs/conventions.md`               |
| iOS-specific agent rules (XcodeGen, device deploy, SwiftUI preview + snapshot self-critique loop, TestFlight) — read before editing anything in `ios/` | `ios/AGENTS.md` (= `ios/CLAUDE.md`) |
| Public docs — what users see; update alongside behavior changes (see § Documentation maintenance)                                                      | `website/docs/`                     |
| Architecture, per-source detail, HTTP API, config knobs                                                                                                | the code (repo map below)           |

The repo at a glance:

```
packages/core/         shared types, branded IDs, define-source helpers, people-utils, attachments, the shared doctor health check (`@omnesis/core/doctor`)
packages/config/       config schema (omnesisConfigSchema, zod validators, defaults)
packages/gateway-client/ shared HTTP + WS GatewayClient implementation (HttpGatewayClient, GatewayWsClient) — extracted from collector
packages/gateway/      HTTP server, SQLite store, indexer, scheduler, search, analytics-db
packages/collector/    sync engine, source manager, auth subprocess
packages/cli/          unified `omnesis` CLI — read commands hit /search, /documents, /analytics, /status, /whoami; admin commands hit /admin/*; also hosts the daemons (`gateway serve` / `collector run`) and the `service`/`update` lifecycle commands
packages/providers/*   one package per provider (google, apple, notion, whatsapp, …)
packages/watch/     the Watch V2 DSL, validator, runtime and compiler — standalone by contract, imports nothing from the gateway; the gateway hosts it through `packages/gateway/src/watch/`
packages/agent-integration/ shared off-host integration runtime for OpenClaw and Hermes — transcript ingestion, subscription delivery, and scoped management tools
extension/             Chrome MV3 browser-capture extension — pairs as a `browser` device with a `write:web` token and pushes visited pages to the gateway-hosted `web` source; store listing and privacy declarations under `extension/store/`, packaging in `extension/scripts/` (see docs/releasing.md)
scripts/release/       publish pipeline — stage packages, transform src-pointing manifests to dist at publish time (see docs/releasing.md)
ios/                   native iPhone app — pairs with the gateway, hosts Apple Health
website/               static site Cloudflare publishes to omnesis.dev — landing page, public docs (website/docs/), privacy policy, installer mirror
docs/                  internal design docs, process docs (e.g. issue-labels.md)
```

## Documentation maintenance — your obligation

The public docs are fourteen hand-written static HTML pages under `website/docs/`, published with the landing site at https://omnesis.dev/docs (the `site` workflow deploys `website/` to Cloudflare on every push to `main` that touches it — no build step, no generated reference). `website/docs/docs.css` + `docs.js` carry the shared chrome (design tokens extracted from `website/index.html`); every page embeds the same nav / sidebar / footer, so structural changes must be applied to all pages.

When you change user-visible behavior — defaults, CLI commands, source semantics, setup flows, new or removed features — check the affected page and update it **in the same commit**:

| Page                                 | Covers                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `website/docs/index.html`            | what Omnesis is; core concepts (gateway, collector, devices & tokens and scopes, sources, index, people & links, analytics); data layout; help & support |
| `website/docs/install.html`          | installer, Docker, from-source, first run, uninstall                                                                                                     |
| `website/docs/setup.html`            | portal, certificates & remote access, collector / iOS / Android / browser-extension setup, devices, tokens, repair                                       |
| `website/docs/search.html`           | search pipeline and syntax, CLI query commands, delete, SQL analytics                                                                                    |
| `website/docs/agent.html`            | built-in agent, memory, conversations, model assignment, standing instructions                                                                           |
| `website/docs/connect.html`          | external agents: access levels, privacy policy, audit, answer API, bring-your-own-agent (MCP), OpenClaw and Hermes                                       |
| `website/docs/apps.html`             | getting the apps, mobile-app usage, phone-only sources                                                                                                   |
| `website/docs/notifications.html`    | what sends a notification, private delivery, direct APNs/FCM setup, push status and repair                                                               |
| `website/docs/operating.html`        | services, monitoring (status/doctor/logs), config, models, troubleshooting, CLI at a glance                                                              |
| `website/docs/security.html`         | encryption at rest & keyring, security posture, hardened gateway, TLS lifecycle                                                                          |
| `website/docs/updating.html`         | backup, restore & export, update (single host, fleet, Docker), source-install migration, version compatibility                                           |
| `website/docs/sources.html`          | available source list (experimental sources labelled) + the data each contributes; managing sources; sources on several devices                          |
| `website/docs/building-sources.html` | the source developer contract                                                                                                                            |
| `website/docs/experimental.html`     | experimental-mode gate; Brain and Watch operator guidance                                                                                                |

Authoring rules for these pages:

- **Keep experimental features contained.** Stable pages must not present gated behavior as generally available. Experimental operator guidance belongs only on the dedicated `/docs/experimental` page, must lead with the `OMNESIS_EXPERIMENTAL=1` gate, and must label the behavior unstable. The one exception is experimental sources: they are listed in the `/docs/sources` catalogue, each clearly labelled experimental together with the gate that offers it. When a feature graduates, move its documentation into the relevant stable page as part of graduation.
- **No images.** Terminal interactions use the `.term` component; diagrams are ASCII in a `.term` `<pre>` or plain HTML/CSS.
- Internal links are extensionless (`/docs/install`); Cloudflare serves `install.html` there.
- Voice: technical, precise, calm; no marketing adjectives, dated or release-status markers, or issue numbers. The required unstable warning on the Experimental page is the exception. Example data is always fictional (see § Privacy).
- `website/mobile-privacy-policy.html` is the iOS/Android privacy policy. Keep the legacy `/privacy-policy` redirect until every mobile-store listing uses `/mobile-privacy-policy`.

## Source encapsulation

All logic specific to a particular data source lives inside that source's provider package (`packages/providers/<name>/`). No bespoke source-specific code in `core/`, `gateway/`, `collector/`, `cli/`, `portal/`, or `ios/` outside the provider. This includes:

- Branching on a specific source name (e.g. `if (sourceType === "gmail")` in shared code).
- Source-specific unit nouns ("an email" vs. "a file" vs. "a message") hardcoded in shared UI/CLI.
- Source-specific URL handling — deep-link construction, canonicalization, parsing.
- Source-specific display — icons, colors, text strings — in portal or iOS.
- Source-specific schemas, validation, or normalization in shared code.

The `defineSource()` descriptor is the contract. If a consumer needs a piece of source-specific data, the source exposes it via the descriptor (unit noun, icon, color, deep-link builder, …) and consumers read through the registry. If something is missing from the contract, extend the contract — don't hardcode the source name downstream.

Generic abstractions are fine: routing on `:sourceType` as a path parameter, the source registry iterating over all sources, tests that legitimately enumerate sources.

A daily Claude Code routine audits the previous day's commits and opens one GitHub issue per violation, assigned to the user.

## Experimental features

Ship not-yet-battle-tested work in the tree but gate it so it can't surprise an operator. `OMNESIS_EXPERIMENTAL` is a single on/off switch — unset/`0` = off (default), `1` = everything experimental on (there is no per-feature granularity). A source marks itself `experimental: true` in its `defineSource`/`defineProvider` descriptor (the collector then hides it from the "Add source" picker); any other code path gates on `experimentalEnabled()` from `@omnesis/core`. The gateway advertises the mode to clients as `experimental` on `GET /status`, and the portal / iOS / Android / CLI all read it to hide experimental surfaces (currently: experimental sources, Watches, the Briefs screen, and the portal's Sweeps tab) — nothing experimental is discoverable on any client unless the gateway was started with `OMNESIS_EXPERIMENTAL=1`. The gateway Privacy APIs, portal Privacy control surface, standard MCP Answer/Direct endpoints, the standalone read-only `/answer` adapter (`omnesis answer`), mobile voice ask (including slow-answer push), quick capture, and grounded interactive memory on people/self/documents are generally available. Memory reads and evidence invalidation stay active without the Brain; autonomous annotation generation remains experimental. Use `experimentalVisible()` (= `experimentalEnabled()` OR synthetic mode) where a code path should also light up under `OMNESIS_SYNTHETIC=1` for tests/demos. Public discovery is confined to `website/docs/experimental.html`; detailed operator references stay in `docs/` — [`docs/brain.md`](docs/brain.md) is the Brain's (the gate, the two lanes, and how to bound the spend), [`docs/watch-runtime.md`](docs/watch-runtime.md) is the Watch V2 shadow runtime's, and [`docs/sweeps.md`](docs/sweeps.md) is the scheduled sweeps'.

## Developer annotations — a feedback channel from the operator to you

A second, independent gate — `OMNESIS_DEV_MODE` (parsed like `OMNESIS_EXPERIMENTAL`; `devModeEnabled()` from `@omnesis/core`; advertised as `developer` on `GET /status`) — reveals a hidden **developer-annotations** channel. When it is on, the operator can attach a short free-text data-quality note to whatever entity they're looking at (a document, brief, loop, temporal annotation, agent run, …) straight from the portal (a floating ⚑ button) or the mobile apps (shake-to-annotate). These notes are for **you, the engineer — not the Omnesis agent**: the operator uses them to flag inconsistencies without maintaining an offline list of entity IDs.

**Read the open worklist at the start of a session with `omnesis dev-annotations`** (`--json` for machine parsing; `resolve <id>` / `rm <id>` to close one once you've acted on it). Each note carries the target `{type, id}`, a deep link, and a snapshot of what the operator was looking at. The notes live in the `dev_annotations` table; the `/dev/annotations` routes 404 when dev mode is off. Developer annotations remain absent from the public docs.

## Privacy — never use the user's corpus as inspiration

Omnesis indexes the user's personal data: emails, messages, contacts, health metrics, calendar, files. While working in this repo you may see real names, phone numbers, email addresses, addresses, dates, vendors, and private context belonging to the user, their family, friends, and contacts.

**NEVER use any of that as inspiration for example data, mock fixtures, preview content, test inputs, code comments, commit messages, PR descriptions, or anywhere else in the codebase.** That includes paraphrasing — a "Cadeau Massage Élise" voucher fixture inspired by a real WhatsApp thread with the user's sister is just as bad as copying the thread verbatim. The user's family, friends, vendors, and contacts have appeared in real fixtures; that is the kind of leak this rule exists to prevent.

When you need example data, **invent it from scratch**:

- Names: use clearly fictional names not appearing in the user's corpus (e.g. `Maya Reeves`, `Jamie Lopez`, `David Lin`, `Sarah Mendez`). Don't reuse a name you saw in a search result, email, or person merge.
- Emails: use `example.com` / `example.org` / `example.io` (RFC 2606 reserved domains).
- Phone numbers: use `+1 (555) 010-0xxx` (NANP fictional range) or `+44 7700 900xxx` (Ofcom-reserved UK fiction).
- Addresses: use placeholders like `42 Example Street`.
- Vendors / businesses / venues: invent (e.g. `Stellar Sound`, `Studio Northstar`, `Riverside Estate`). Don't reuse a real vendor name you encountered in the user's invoices, contracts, or threads.
- Stories / scenarios: invent generic ones (heart-rate trend, Q4 budget review, marathon entry form). Don't structure a fixture around a personal incident you observed in the data.

If you're uncertain whether something is from the corpus, assume it is and invent fresh. Extending mock files like `ios/Sources/Omnesis/UI/PreviewMocks.swift` is fine; sourcing the content from the user's actual data is not.

This rule applies to every part of the repo: iOS previews, snapshot tests, gateway tests, provider tests, evals fixtures, docs examples, generated content, comments, anything.

## Agent rules

1. **Plan mode default.** Enter plan mode for any non-trivial task (3+ steps or architectural decisions). If something goes sideways, stop and re-plan rather than push through.
2. **Use subagents liberally.** Offload research, exploration, and parallel analysis to keep the main context window clean. One task per subagent for focused execution.
3. **Verify before done.** Never mark a task complete without proving it works. Run tests, check logs, demonstrate correctness. Ask "would a staff engineer approve this?"
4. **Demand elegance for non-trivial changes.** Pause and ask "is there a more elegant way?" Skip for simple, obvious fixes — don't over-engineer.
5. **Autonomous bug fixing.** Given a bug report, fix it. Point at logs, errors, failing tests, then resolve them.
6. **Simplicity first.** Every change as simple as possible. Impact minimal code.
7. **Root causes.** No temporary fixes. Senior-developer standards.
8. **Learn from corrections.** When the user corrects an approach, save the pattern to your memory system (`~/.claude/projects/.../memory/`) so the next session has it. Iterate until the same mistake stops happening.

## Tests are mandatory

- **CI runs the full suite on every pull request into `main` and every push to
  `main`**, on GitHub-hosted runners (`.github/workflows/full-validation.yml`);
  a newer push to a pull request cancels its older run. Before handoff, run the affected gate
  for the actual branch and working tree: `npm run checks:plan -- --base origin/main`,
  then `npm run checks:affected -- --base origin/main`. Nx selects package work
  through the dependency graph and adds declared behavioral E2E/native bundles.
  A red main revision is fixed forward.
- Establish a focused baseline before editing, then rerun the affected tests while iterating. Re-run `checks:affected` after relevant edits because queued evidence is bound to the planned tree and rejects changed inputs. Use `npm run checks:bundle -- <name>` to add a diagnosed bundle; a narrower manual bundle does not replace the affected gate. `npm run checks:full` remains available for CI, migration validation and manual diagnosis. `npm run test:unit` excludes the spawned-gateway suite; use `npm run test:e2e -- <path/to/file.e2e.test.ts>` for a focused gateway check.
- **No chat or agent-model inference in tests, ever.** Substitute the model at a production seam: replay backends, puppet/cassette models, or scripted verdict servers. Local embeddings are the deliberate exception when a suite is specifically proving semantic retrieval quality; `search-quality.e2e.test.ts` and `embedder-swap.e2e.test.ts` keep their real local embedding dependency, which `scripts/test-embedder.sh` provides.
- Every new feature or bug fix must include tests. Every new source needs sync (bootstrap + incremental), normalization, and error-handling tests — and a `/source-review` pass (`.claude/commands/source-review.md`, the complete source contract as a checklist) before its PR opens.
- Tests use `vitest`. Place test files next to source files as `*.test.ts`. Spawned-gateway E2E tests are named `*.e2e.test.ts` and live under `packages/collector/src/e2e/`. Two shared harnesses: `SyntheticE2EHarness` boots a real gateway against a chosen universe (default: `default`) and drives real sources; every construction must name its `gatewayMode` (`stable`, `experimental`, `synthetic`, or `synthetic-experimental`) so the spawned product surface never inherits the test runner's synthetic flag. `MultiCollectorHarness` (`multi-collector-harness.ts`) boots a gateway plus any number of in-test pseudo-collectors that pair, hold a WS connection and answer source-lifecycle commands — deliberately no `SyncEngine`, so it covers registration and dispatch; its one document seam is `pushDocuments(collector, docs)`. `SyntheticE2EHarness` pairs the universe's declared device roster and syncs every source as the device the manifest attributes it to (see `docs/universes.md`).
- Existing E2E suites worth knowing about before touching their territory: `replay-scenarios.e2e.test.ts` (drives every replay-agent scenario via HTTP/SSE), `golden-corpus.e2e.test.ts` (snapshot-based ranking/people/search regression net over the LIKE-based `/documents/search`), `search-quality.e2e.test.ts` (the SEMANTIC net golden-corpus omits — wires the real local embedder at `:8001` via `extraInference`, asserts recall@k + ordering on the real `POST /search` hybrid pipeline over an invented judged-query set where a lexical baseline loses; required dependency, so an unreachable `:8001` FAILS in CI and only skips on a local dev box; `scripts/test-embedder.sh start` serves the pinned model on the CPU there, as CI does; `OMNESIS_TEST_EMBEDDER_URL`/`OMNESIS_TEST_EMBEDDER_MODEL` override the defaults), `cli.e2e.test.ts` (drives the `cli` binary, including `sources resync` with and without a device), `link-extraction.e2e.test.ts` (asserts linkBackfill + linkStatsRefresh populate `document_links` + `link_stats`), `people-graph.e2e.test.ts` (asserts interactionScoresRefresh fires, mergeRulesEval propagates user-issued merges, autoDetect endpoint stays healthy), `trail-graph.e2e.test.ts` (boots default universe, asserts attachment/dedup/thread links + trail traversal across WhatsApp and Gmail), `multi-collector.e2e.test.ts` + `multi-account.e2e.test.ts` + `source-ownership.e2e.test.ts` (all on `MultiCollectorHarness`: per-device dispatch; one account's removal/pause never disturbs a sibling account of the same source type; cross-collector add refusal + explicit PATCH-deviceId move), `device-roster.e2e.test.ts` (the universe's device roster is what the gateway sees: every seed source is owned by, and syncs as, the device the manifest attributes it to), `source-membership.e2e.test.ts` (two collectors on a `replicated` source: a second add joins instead of 409, member-scoped snapshots and fan-out, Sync now on every member, per-member cursor rows that adopt the shared one, detach and owner hand-over, and a per-device resync that resets one member's cursor only), `needs-auth-reminder.e2e.test.ts` (on `SyntheticE2EHarness` with fake APNs: a collector reporting `needs-auth` earns one reminder per provider connection per device, backed off on the persisted ladder and reset only by that device's own recovery — a sibling member's successful sync leaves a lapsed member's reminder in place), `partitioned-universe.e2e.test.ts` (on `SyntheticE2EHarness` with the `partitioned` universe: two Android phones push identically named day rollups and identically keyed Health Connect rows into partitioned sources; each phone's documents and analytics rows live in its own stream, the union is the corpus, a phone's snapshot, tombstones and exists-checks stay in its stream, a per-device resync wipes one phone's stream and cursor, and a detached phone's stream goes with it), `sync-lease.e2e.test.ts` (on `MultiCollectorHarness`: two collectors race for a handoff source's sync lease — the holder's pages renew it, a non-holder's page is refused, a lapsed lease prefers its online incumbent and passes to a sibling once it is offline, release hands over at once, Sync now reaches the holder; a replicated member without the lease commits its page but defers the snapshot reconcile), `replicated-universe.e2e.test.ts` (on `SyntheticE2EHarness` with the `replicated` universe: two collectors share Things and two phones share Apple Health as members; the corpus equals one host's, snapshot reconcile under two contributors deletes nothing, per-host cursors stay monotone, and a host detaching or being revoked loses no data), `handoff-universe.e2e.test.ts` (on `SyntheticE2EHarness` with the `handoff` universe: two collectors host one Gmail account as a handoff source and every tick runs the collector's own lease branch — the owner's tick takes the lease and leaves one shared `sync_state` row, a member's tick while it is held is skipped with no status event and no write, a lapsed or auth-released lease passes to the sibling's next tick which continues from the shared cursor, and a detached-then-rejoined member is skipped again), `replica-deletion-dispute.e2e.test.ts` (on `MultiCollectorHarness`: two collectors host one replicated source whose replicas disagree about an item — the holder's first tombstone deletes it and resets its sibling once, the sibling's bootstrap makes it disputed, later tombstones are stripped without deleting or resetting, the dispute survives a gateway restart and a per-member resync and is visible on the source and the holding member, the restorer's own tombstone settles it without the lease, and a detached member closes it), `replica-snapshot-dispute.e2e.test.ts` (same harness, no tombstones at all: the holder's corroborated snapshot omissions delete once through the absence sweep and reset the sibling once, the sibling's restore is a dispute the sweep leaves alone, one omission by the restorer never settles it while spaced omissions past the age floor do — naming the item resets the clock — a lease hand-over, a gateway restart, a per-member resync and a detach each leave the ledger consistent, and a third member's verdict cannot settle another member's dispute), `replica-analytics-dispute.e2e.test.ts` (same harness, the analytics plane: every page sent the way a collector tick sends it — rows and tombstones on a fresh epoch, the cursor, then the snapshot; the holder's row tombstone deletes and resets once and its repeats are disputed, a non-holder's fresh tombstone is deferred with its rows kept, the restorer's tombstone settles without a reset, the holder's corroborated omissions delete through the sweep as its verdict and reset every member once while a restorer settles by spaced omissions only, a gateway restart keeps the count, and a detached restorer closes its dispute; after a lease hand-over the new holder is a restorer whose corroborated omissions settle its own dispute; and an absence a detached member's snapshots earned still deletes when swept but carries nobody's verdict), `permission-remediation.e2e.test.ts` (on `MultiCollectorHarness`: a sync failure's structured remedy is served beside its message, a generic failure never gets one, only the member that hit it carries it, it survives a gateway restart, and the member's own recovery clears it), `self-identity-registry.e2e.test.ts` (on `MultiCollectorHarness` with a `config.self`: a collector's self-identity hook push puts the source's LID alias on the self person through the real writer thread, a sibling collector declaring fewer hooks never erases its peer's, and a source added on that sibling still pairs through the merged registry), `pairing-lifecycle.e2e.test.ts` (on `MultiCollectorHarness`: a revoked collector that still hosts sources reads as `needs-pairing` on the gateway and in the CLI while a revoked one with nothing to bring back does not, `omnesis devices repair` mints a code bound to that row, redeeming it restores the same device id with its ownership, membership, cursors and documents intact, and the gateway-host collector's own re-registration reclaims its revoked row; an iPhone code is offered the trusted Tailscale name first and refused a Tailscale IP that an Android code is given, and a code that is not pending gets no addresses), `gateway-lifecycle.e2e.test.ts` (on `MultiCollectorHarness`: a second gateway pointed at a live gateway's config dir is refused by `gateway.lock` before it opens any store and names the owner while the owner keeps ingesting; a replacement started while the owner drains waits for the lock and takes the directory over; a gateway booted after its predecessor was SIGKILLed reclaims the stale lock), `browser-capture.e2e.test.ts` (on `SyntheticE2EHarness`: the extension's push module under Node against a real gateway — a `browser` code minted without naming scopes receives the gateway's default grant, pinned to `defaultScopesForDeviceKind("browser")`; the `write:web` token is refused for any other write; documents and `page_visits` rows land and upsert; the gateway-owned capture policy read with the browser token folds in the collector's owned domains, an exclusion with purge, a pause and their removal are what the gateway serves back, a page deleted for good is named in the policy and refused on re-push as `suppressed` while a copy-only delete lets it return), `browser-extension.e2e.test.ts` (the built extension in a real headless Chromium on `SyntheticE2EHarness`, built with the test manifest — pinned id, host access pre-granted: pairing through the options page stores a `write:web` credential, a routed fixture page dwells into a document and a `page_visits` row, the popup reports it, a CDP-stopped service worker revives and the next page still lands, an exclusion made on the options page lands on the gateway with a purge and a page on the excluded domain queues nothing after a full dwell, excluding the open page from the popup confirms in place, lands on the gateway and stops that page capturing without a reload, the popup's pause is the gateway's pause, a page deleted for good is not captured again, a revoked device makes the popup say re-pair, and unpair leaves no credential, queue item or staged capture; the Playwright Chromium is a required dependency, so the suite fails in CI when it is missing and skips with a notice on a dev box without it), `ios/Tests/.../GatewayLiveE2ETests.swift` (Swift transport against a live gateway, invoked via `scripts/run-ios-e2e.sh`).
- **The Brain Bench** (`packages/collector/src/e2e/brain-bench/`, suites `brain-*.e2e.test.ts`) is the end-to-end correctness net for the Cognition Steward — read its [`README.md`](packages/collector/src/e2e/brain-bench/README.md) before touching the brain or writing a bench test. A bench boots a real gateway with the whole engine live (waker → queue → rhythm → drainer → run driver → tool layer → gates → cascades) and substitutes only the model, at the production `background-agent` seam. Two lanes: a **puppet** model that decides each turn from a behavior table and emits real tool calls, and **cassettes** — recorded reasonings replayed with live tool calls, so their writes land for real (`scripts/record-brain-scenario.mjs` builds one from a run transcript). Scripted verdict servers make the two fail-open gates (`entailment-verifier`, `brief-judge`) reachable in their reject arms, and `OMNESIS_BRIEFS_VIRTUAL_CLOCK` drives day boundaries deliberately instead of by sleeping. **The bench asserts correctness, never quality** — that a decision was carried out properly, never that it was a good decision; quality stays in the scorecard/eval lane so improving a prompt can't redden correctness CI. A brain change that touches a tool, gate, cascade, queue mechanic or rhythm task should add or update a bench test in the same PR.
- `npm run test:e2e` uses a memory-aware launcher: at most two E2E files run in parallel, and only on hosts with at least 32 GiB process-visible total / 16 GiB currently available memory; constrained hosts stay sequential. Suites sharing the real embedder, the timing-sensitive load soak, the restart-sensitive encrypted-sidecar suite, and the headless-Chromium extension suite run in a separate serial phase; aggregate machine reporters also use one serial Vitest process so they produce a single valid output file. `OMNESIS_E2E_WORKERS=1|2` is the explicit benchmark/debug override. The launcher also holds a lane lock for the whole run — a ticket directory under the system temp directory, so lanes of users or containers with separate temp directories do not see each other — and a second `test:e2e` on the same machine queues behind the first (naming it) instead of failing both; `OMNESIS_E2E_LOCK_WAIT=0` fails fast instead of waiting, and `OMNESIS_E2E_LOCK_TIMEOUT_MS` caps the wait (two hours by default). Spawned test gateways use small worker pools while preserving every worker path, so bounded file concurrency does not multiply production-sized pools.
- `npm run validate-universes` (= `npx tsx scripts/validate-universes.mjs`) checks every in-tree universe for structural integrity. Also runs in CI before the test suites.
- Gateway DB tests use unique temp paths (`/tmp/omnesis-test-{uuid}.db`).
- Integration tests use ports 17601+ to avoid conflicts with running services.

## Fast inner loops

Pick the **narrowest** signal that covers your change first, then widen to
`npm run checks:affected -- --base origin/main` before handoff. Measured on
the dev box (warm = the project already built/transformed once this session):

- **One test file** — `npm run test:unit:vitest -- <path/to/file.test.ts>` ≈ **0.5s** wall. This is the
  tightest loop; use it while iterating on a single unit.
- **One package** — `npm run test:unit:vitest -- packages/<pkg>` ≈ **1.3s** wall for a ~40-file package.
  Use it once a file passes, to catch cross-file fallout within the package.
- **A portal-only change** — `npx vitest run packages/gateway/portal` (~2s) is the whole
  gate, together with `npm run typecheck`, lint, the PII scan and the mandatory screenshot.
  Skip `test:e2e`: `portal.e2e.test.ts` checks that the portal's files are served and that
  routes fall back to `index.html`, and no E2E suite renders a portal view, so the lane
  costs tens of minutes (plus whatever it queues behind) and covers none of the change.
  The portal lane does read the stylesheet — `js/stylesheet.test.ts` parses `css/style.css`
  and fails on an unbalanced brace, which otherwise silently drops every rule after it — so
  a CSS-only change is not untested, but a screenshot is still the only check on what it
  looks like. Shared gateway changes select their declared backend and client
  bundles through the affected plan.
- **Developer-script smoke tests** — `npm run test:unit:smoke` runs the gateway-spawning
  script checks separately from the bulk unit workers. `npm run test:unit` includes this lane
  automatically; the split keeps the isolated gateway boot out of the bulk unit workers.
- **Type errors, one package** — `npx tsc --build packages/<pkg>` builds only that package
  plus its dependency chain (warm ≈ 0.2s; cold ≈ 0.8s for a small leaf package, ~3s for
  `core` + its deps). The monorepo uses project references, so `tsc --build` is **incremental**
  — it consults each package's `.tsbuildinfo` and rebuilds only what changed.
- **`npm run typecheck:fast`** — `tsc --build` over the app packages (`gateway`, `collector`,
  `cli`) and their shared-library deps, **skipping the ~30 standalone provider packages**.
  Cold ≈ **10s** vs the full `npm run typecheck` (all 45 project references) cold ≈ **16s**;
  warm both finish in well under a second. Pass a package path to narrow further:
  `npm run typecheck:fast -- packages/<pkg>`.
- **`npm run typecheck:watch`** — `tsc --build --watch`; leave it running in a pane for a
  live red/green type signal as you edit, instead of re-invoking the full typecheck each time.

The affected plan is the authoritative branch gate. It includes production and
test typechecks, lint, unit work and declared integration/native bundles for the
current inputs. Full validation remains an explicit diagnostic command and the
uncached main-CI contract.

On a host with managed checks configured, use `npm run checks:status` to inspect
running and queued jobs and `npm run checks:cancel -- <id>` to cancel your job.
Cancel and wait for termination before removing its worktree. See
`docs/agent-gotchas.md` for scoped test filters, logs, lint prerequisites, and
migration conflicts.

The native (iOS/Android) surfaces have the same shift-left split — a **fast pure-logic lane**
(no simulator/emulator build) before the slow visual build. Both bridge to a configured macOS
host over `ssh` (`export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>` — unset is a clear
error; never guessed) and keep the macOS scratch checkout **warm** (a persistent dir + reused
build cache) so repeat runs are fast:

- **iOS logic** — `scripts/ios-logic.sh` runs the SwiftPM `swift test` lane (agent
  timeline/turn builders, health normalizer/cursor, schemas, offline buffer, markdown,
  timing) natively for macOS — **no simulator, no Xcode project, no device build**. Reach for
  it before `scripts/ios-snapshot.sh` (the slow simulator-render visual lane). See
  `ios/AGENTS.md → Fast inner loops (native lanes)`.
- **Android logic** — `scripts/android-logic.sh` runs `./gradlew <module>:testDebugUnitTest`
  for the pure-JVM logic modules (transport decoders, pairing, reducers/models) — **no
  emulator, no Roborazzi render**. Reach for it before `scripts/android-render.sh` (the slow
  Roborazzi visual lane). See `android/AGENTS.md → Fast inner loops (native lanes)`.

## Code style

- TypeScript strict mode. No `any` except in test mocks.
- Imports use `.js` extension (ESM).
- Use `@omnesis/core` for shared types — never import across packages by relative path.
- Use the structured logger (`createLogger` from `@omnesis/core`). Never `console.log/warn/error` in source code (only the logger itself calls console).
- Logger components follow a hierarchy: `gateway`, `gateway:http`, `collector:sync`, `provider:google`, `source:gmail`, etc. Create child loggers with `log.child("sub")`.
- Logging style: **concise one-liners using template literals**, not structured-data objects. Good: `log.info(\`Sync complete for ${id}: ${count} docs in ${ms}ms\`)`. Bad: `log.info("Sync complete", { id, count, ms })`.

## The writer is one thread

Every write goes through one worker, so anything slow on it stops every other
write on the gateway. Resolve on a reader and hand the writer finished rows;
bound iterating writer ops in sub-batches with a preempt check between them;
and treat a query whose filter no index can serve as work proportional to the
table rather than to the batch. `docs/conventions.md` § "The writer is one
thread" carries the rules and why each exists.

## Database migrations

Any change that modifies the gateway SQLite schema or makes existing data stale needs a migration. Idempotent (safe to run multiple times), runs on startup before the first sync. **Migrations are append-only, contiguous, and kept permanently** — Omnesis now has multiple live users on differing schema versions, so an install several versions behind must upgrade cleanly by replaying the full sequence. Never delete a migration's slot: when a step's transform becomes obsolete, reduce it to a no-op **tombstone** (a no-op `up` with a description saying why) so the `user_version` chain stays gap-free. A contiguity test in `schema.migration.test.ts` reddens the build if the list develops a hole or its head drifts from `LATEST_SCHEMA_VERSION`. A migration normally runs inside the runner's transaction; the `ownTransaction` flag exists only for SQLite's 12-step rebuild of a table that other tables reference (it needs `PRAGMA foreign_keys` OFF and `legacy_alter_table` ON, both inert or harmful inside a transaction) — such a migration owns its BEGIN/COMMIT, runs a table-scoped `PRAGMA foreign_key_check` before committing, and the runner stamps `user_version` afterwards; migration 131 is the reference.

How versioning, migrations, and cross-version compatibility are encoded — the lockstep product version, the machine-readable compatibility manifest (`packages/core/src/compat.ts`, exposed at `GET /admin/compat` and a subset on `GET /health`), the per-store policy classification, the WS/pairing protocol gates, and the `omnesis update` preflight — is encoded in `packages/core/src/compat.ts` (the compatibility manifest and per-store policies, with doc comments) and `packages/cli/src/update/` (the `omnesis update` preflight). Read those when touching versioning; keep `website/docs/updating.html` accurate on the operator-visible behavior (the update's own pre-upgrade backup, forward-only migrations, the restart order and the rollback).

## Releases & packaging

Read `docs/releasing.md` before touching anything publish-related. The essentials:

- `npm run release -- <plan|version|pr|tag|status>` is the single entry point; it owns everything from the changeset to the annotated tag (including the iOS and Android version fields) and never pushes. Pushing the tag triggers `.github/workflows/release.yml`, whose publishing steps stay dry-run until the repository variable `OMNESIS_RELEASE_PUBLISH` is `1`.
- All `@omnesis/*` packages version in **lockstep** (one product version, served on `GET /health`, printed by `omnesis --version`, tagged `vX.Y.Z`).
- Repo manifests stay **src-pointing** (`main`/`exports`/`bin` → `src/*.ts`); `scripts/release/` transforms them to `dist/*.js` at publish-stage time, never in the repo.
- Code that spawns a sibling worker thread or subprocess must use `resolveWorkerEntry` / `resolveSubprocessEntry` from `@omnesis/core` so it works both under tsx (dev) and compiled (published).

## Restarting running services

- **Gateway and collector** — remind the user to restart if changes affect runtime behavior.
- **Portal static files** (`packages/gateway/portal/`) — served from disk on every request, no caching. Edits show on the next browser refresh; no restart needed.

## Shell commands

- Use `rm -f` (not bare `rm`). The sandbox runs `rm` interactively, which appears to succeed but silently skips deletion. Verify with `ls`.
- Node 24 is required. Ensure `node` and `npm` resolve to that toolchain before running repository scripts.
- Environment footguns (sandbox-blocked foreground `sleep`, `pkill -f` self-match, zsh `noclobber` `>!`, Playwright `networkidle` on SSE/WS pages, the worktree symlink-farm) are consolidated in [`docs/agent-gotchas.md`](docs/agent-gotchas.md). To kill throwaway processes by pattern without killing yourself or no-op'ing on a wrong pattern, source `scripts/lib/safe_kill` (drops `$$`/`$PPID`, fail-loud on a zero/self-only match) instead of bare `pkill -f`.

## Source roadmap process

A master GitHub issue tracks **which data sources exist, are planned, or are off-limits**. It carries the status table (Implemented / In progress / Planned / Won't implement) and is the chronological ledger via comments.

Process notes:

- **Viability rule.** A source is viable only if Omnesis can authenticate once and then sync from it automatically in the background. Sources whose only ingestion path is a manual user-triggered file export (Google Takeout, Facebook DYI, Instagram personal export, Google Photos Picker) are **Won't implement**.
- **One master, many sub-issues.** New per-source proposals go in their own issue, then become a sub-issue of the master roadmap issue via the GitHub native parent/child relationship. Don't open a new umbrella issue.
- **Won't-implement sources don't get deep-dive issues** — just a row in the roadmap's "Won't implement" table with a one-liner reason.
- **Bug reports & enhancements for shipped sources are NOT sub-issues of the roadmap** — they're standalone issues. The bottom of the roadmap's body lists them by source family for visibility.
- **Update the roadmap when status changes.** Ship a source → move row from Planned to Implemented. Drop a Planned source → move to Won't implement with a reason.

The user-facing explanation of viability and source contributions lives in `website/docs/building-sources.html` and the source list in `website/docs/sources.html`. Update those when the contract changes; the roadmap carries only the status / ledger. The reviewer's checklist for a new source is the `/source-review` command (`.claude/commands/source-review.md`) — when the source contract gains or loses an obligation, update that file in the same PR.

## Synthetic-corpus universes

Synthetic-data fixtures (cast, per-source fixtures, replay-agent scenarios, seed source list) live in self-contained universes under `evals/universes/<name>/`. The demo gateway (`scripts/start-demo-gateway.sh --universe <name>`) and the synthetic E2E harness (`new SyntheticE2EHarness({ gatewayMode: "stable", universe })`) both honor this. Default universe is `default`. See `docs/universes.md` for the manifest schema, authoring workflow, gateway-mode contract, and validator.

## iOS development workflow

iOS-specific rules — XcodeGen, device deploy, the mandatory SwiftUI preview + snapshot self-critique loop, TestFlight — live in `ios/CLAUDE.md` (symlinked as `ios/AGENTS.md`). Read it before touching anything under `ios/`.

On a host without Xcode (e.g. the Linux dev box), `scripts/ios-snapshot.sh` bridges the snapshot self-critique loop to a configured macOS build host: set `OMNESIS_EPIC_MACOS_HOST` (unset → a clear error, never a guessed alias), and it rsyncs your **uncommitted** `ios/` tree to a dedicated scratch checkout on the host (hard-fails if that path is the primary checkout or a `_work` runner clone), runs the snapshot suite over `ssh` with code-signing disabled, and rsyncs the PNGs back to `/tmp/omnesis-snapshots/` for you to `Read`. See `ios/AGENTS.md` → "Bridging the snapshot loop from a non-macOS box".

## Portal development workflow

**Mandatory: screenshot + Read + self-critique for any `portal/` change.** The web portal (`packages/gateway/portal/`) gets the same treatment the iOS guide mandates for SwiftUI — handing the human un-self-checked portal UI is a failure mode. After any change that affects what the portal renders, capture the affected route, `Read` the PNG, and critique your own render (did it render the intended content, not a blank/error/empty-state page?) **before** asking the human to look.

Use `scripts/shot-portal.sh <route> [--wait <selector>] [--click <selector>]`: it boots (or reuses) an isolated **synthetic-data** gateway from the current worktree on a high port, navigates the headless portal to `/portal/<route>`, waits on a **selector** (never `networkidle` — the portal holds SSE/WS; see `docs/agent-gotchas.md`), optionally clicks one, and writes a PNG to `/tmp/omnesis-portal-shot-<route>.png` for you to `Read`. **Never shoot the live gateway** — the script only ever drives its own isolated instance (never port 7600 / `~/.config/omnesis`). It is an **on-demand** capability — there is no golden-screenshot corpus to maintain; you capture, look, and critique each time. Routes are the portal's nav routes (`""` and `agent` are both the Ask landing, plus `search`, `people`, `sources`, `capture`, `privacy`, `watches`, `debug`, and `settings` — the last two being tabbed pages, whose tabs are addressed as `debug/data`, `debug/sql`, `debug/graph`, `debug/metrics`, `debug/background-jobs`, `debug/cognition`, `debug/doctor`, and `settings/config`, `settings/omnesis-md`, `settings/models`, `settings/access`, `settings/access/connect` (the connect-an-agent dialog), `settings/policies`, `settings/devices`). Pass `--keep` to leave the gateway up across several shots.

## Known performance work

The gateway's slow-request tail comes from writer-worker queue contention. Before starting any HTTP-latency / writer-worker / backfill-worker performance work, know its levers: the four incremental compute/upsert splits (`refreshPeopleCounts`, `touchTokenUsage` coalescing, `reconcileUnresolvedLinks`, `runMergePass` candidate-selection) and the structural priority-queue alternative. Bench each change before and after.

## Labelling GitHub issues

The repo's issue-label set is defined in [`docs/issue-labels.md`](docs/issue-labels.md) — read it before filing or triaging an issue. It is deliberately minimal: there is **no `type:` / `area:` / `topic:` taxonomy** (those axes were removed) and **no priority axis**. The only labels are the GitHub-native states (`good-first-issue`, `help-wanted`, `question`, `duplicate`, `wontfix`, `invalid`). Don't reintroduce the old axes or mint new label families ad hoc; keep `docs/issue-labels.md` and the GitHub label set in sync when the set changes.

## Anchor GitHub issues in the code

When you open a GitHub issue for a new feature, a bug to fix, a planned refactor, or any other tracked work that has an identifiable home in the code, also drop a short comment at the relevant call site(s) referencing the issue (e.g. `// See #312 — planned: …` or `// Known bug: #287`). This is the durable link between the tracker and the code: future agents reading that file will discover the issue without having to search GitHub, and can pull it up for the full context, history, and discussion.

Keep the comment minimal — one line, the issue number, and a few words of "what this issue is about". The issue itself carries the detail; the comment is just a pointer. Remove the comment when the issue is closed and the work is done (no stale `// TODO #123` markers left behind once #123 ships).

## Other instructions

- Always ensure tests pass after implementing a change.
- Always ask whether test coverage is good and whether new tests are needed.
- When fixing a bug, ask whether the fix could introduce staleness or race conditions.
- Always check `README.md` is up to date.
- Always check this file (`CLAUDE.md`) is up to date — it carries agent-specific rules; keep it slim and accurate.
