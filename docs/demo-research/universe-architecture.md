# Synthetic universe architecture research

Initial read-only code audit, updated with implemented decisions. Static checks and implementation notes do not establish runtime demo claims. No private corpus is accessed. All new fixture facts must be independently invented.

## Time handling

`packages/providers-synth/_common/src/universe.ts` loads per-source JSON unchanged in `loadSourceFixtureJson()`. Providers cache fixtures for a process lifetime. No general time rebasing exists in demo startup or the synthetic harness.

Chosen policy: each universe owns a deterministic authoring generator. `evals/universes/sacha-bellamy/_build/build.mjs --as-of YYYY-MM-DD --out DIRECTORY` materializes an explicit London reference week into an isolated universe directory. A whole-week anchor preserves weekdays and keeps the same events in “next week” throughout the recording week. Both gateway and collector read the resulting immutable fixtures. Rebuild a fresh isolated instance to change the anchor rather than silently rebasing persisted cursors and analytics rows.

The generator renders relative prose, typed timestamps, health series, financial snapshots and binary assets coherently. Fixed residence history, birth dates, identity, monetary values and contractual relationships remain designated historical facts. Runtime `loadSourceFixtureJson()` stays unchanged; default universes retain their original behavior. Generic optional per-source fixture clocks cover snapshot defaults without rebasing arbitrary data.

Generator tests cover Tuesday/Sunday, year rollover, leap day, London DST, matching prose and timestamps, and fixed historical evidence. `docs/universes.md` documents the resulting controls. The original proposal for a generic loader transformation was not implemented because source-native generator authoring keeps temporal meaning explicit.

Current fixture clock controls preserve defaults when omitted:

| Path under `packages/providers-synth/`                           | Materialization controls                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apple-health/src/fixtures.ts`                                   | Optional `startDay` and dated mood entries replace the legacy September 2025 anchors; omitted fields preserve legacy fixtures. |
| `plaid/src/index.ts`                                             | Optional fixture `snapshotDay` and `institutionName` override legacy snapshot/institution defaults.                            |
| `coinbase/src/index.ts`                                          | Optional per-source `clock.json` overrides the snapshot day through `sourceFixtureClock`.                                      |
| `enable-banking/src/fixtures.ts`, `lunchflow/src/fixtures.ts`    | Optional per-source `clock.json` supplies snapshot day and synced-at instant.                                                  |
| `granola/src/fixtures.ts`                                        | Optional per-source `clock.json` supplies the synced-at instant.                                                               |
| `browser-history/src/fixtures.ts`, `screen-time/src/fixtures.ts` | Authored `days[]` determine weekday scaling and deterministic random seeds; the generator supplies their dates explicitly.     |

## Source breadth and schema families

The initial non-Android twins covered Apple calendar/calls/contacts/Health/iMessage/notes/reminders/voicemail; Core Location visits; Gmail/Google Calendar/contacts/Drive; WhatsApp; Things; browser history/Chrome bookmarks/Screen Time; Strava activities/zones; Plaid/Enable Banking/Lunchflow/Coinbase; GitHub threads/discussions/commits; Notion pages/databases; Obsidian; Granola; Outlook email/calendar; OneDrive; Maildir.

Ten additional twins now cover local files, IMAP, web browser capture, Codex, Claude Code, Pi, OpenClaw, Hermes, iOS Photos and motion activity segments. The current reference declares 43 configured sources. File, IMAP and native coding-session twins reuse production readers; web and off-host conversation twins reuse production builders; Photos and motion mirror native output contracts rather than exercising sensors or PhotoKit. `source-review-synth-breadth.md` records the boundaries and focused verification. The collector registry switches exclusively between real and synthetic package sets; source-specific behavior stays inside provider packages.

Fixture schemas are heterogeneous:

- Most document sources use arrays of records with stable identity, content, person references and timestamps.
- Browser history and Screen Time use catalogs plus `days[]`, expanded deterministically.
- Apple Health uses category metric arrays of daily `values[]`, sleep-stage tuples, mindful sessions and workouts; expands into nine analytics tables.
- Plaid and Coinbase use canned raw API envelopes through real clients, parsers, normalizers and sync state machines.
- Enable Banking and Lunchflow use raw account/balance/transaction groups through production normalizers.
- Notion databases declare schema properties and rows; GitHub carries repository envelopes.
- Granola fixtures contain production `GranolaNoteDetail` objects.
- Maildir fixtures materialize RFC822 messages on disk and call the real Maildir source.

The manifest roster and cast are the common contracts. The cast needs every provider account alias under `extra`, plus email/phone identities. Fixtures refer to symbolic cast people and should never copy names or stories from any private source.

## Correctness decisions and remaining boundaries

Plaid fixture metadata now supplies institution name and snapshot day, supporting the explicitly requested Bank of America scenario without real account data. The fictional past US employment period and retained account are authored consistently with the London persona.

`scripts/synth-gateway.sh` still ignores manifest device ownership and adds every source under its collector. The new isolated launcher instead uses the roster-aware `synthetic-demo-host.ts`; it pairs actors and advertises descriptor capabilities before registering their sources. The E2E harness also pairs the declared roster and syncs phone sources under phone devices. Runtime validation must verify actual ownership and bootstrap success rather than infer them from the manifest.

WhatsApp and iMessage fixtures now accept participant references and resolve each group speaker through the fictional cast, with deduplicated mentions. Fixtures using the old shape retain their original chat-title rendering.

## Real media processing

Gmail and ordinary WhatsApp attachment fixtures supply `extractedText`; Drive supplies `content`; iMessage attachment documents currently supply filename/type/size. These support retrieval but do not prove OCR or transcription.

Production `packages/collector/src/attachments/extract.ts` provides `createAttachmentExtractor({ ocr, transcribe })`. `extract-pdf.ts` reads native text per page, sends sparse pages to gateway OCR and stamps provenance. The universe now supplies actual binary assets for this pipeline; successful extraction and live citations remain runtime evidence requirements.

The synthetic Maildir delegates to the real parser/source and now materializes actual PDF/image/audio MIME attachments. The production PDF parser copies its input before PDF.js can transfer the buffer, preserving the original bytes for OCR; an image-only PDF regression verifies the OCR seam without model inference.

WhatsApp has an existing wraps-real path: `sources/whatsapp-messages/fake-corpus.json` opts into `packages/providers-synth/whatsapp/src/wraps-real.ts`, which feeds `FakeWhatsAppServer` and returns the real durable source. However it does not thread `options.transcribeAudio`, and uses the production media downloader. That alternate path would need a safe fixture-backed media downloader and transcriber wiring before it could prove voice-note processing. The current binary-media demonstration uses Maildir instead.

Harness replay OCR/STT decode UTF-8 payloads, suitable for deterministic no-inference tests. They do not establish genuine media processing. Runtime validation uses independently configured OCR/transcription over invented assets. The reference has `agentDemos: null`; the isolated launcher retains the configured live agent and separate extraction assignments. Historical coding/conversation captures are indexed evidence, not replay inference configuration.

## Scale and performance

Initial sizing recommendation: 25,000–50,000 searchable documents; 200,000–600,000 analytics rows; hundreds of fictional contacts; ten-year chronology; 80–120 active chats; many thousands of unrelated chat-day documents. Most background documents should be short, varied and temporally coherent. Volume is a design recommendation, not measured evidence.

`_common/src/sync.ts` retains a default of five entries per page and now accepts `OMNESIS_SYNTH_BATCH_SIZE` integers from 1 through 500; an explicit caller option takes precedence. It rebuilds the full partition map on each page: 20,000 entries at five per page means roughly 80 million partition iterations. Healthy unpartitioned sync does not map every entry on every page; mapping covers each batch and the final snapshot. Impaired partitioned sync can additionally repeat identity mapping. Larger batches reduce page overhead; precomputing immutable identities/partitions remains a possible optimization, not an implemented claim.

Health currently sends an entire category per page. At large scale, add paging within category phases. Browser/Screen Time expansion holds rows in memory; a coherent six-to-eighteen-month window is preferable to ten years of minute-level fabricated sessions. Embeddings are likely the slowest readiness stage and need measured queue drainage.

Verification must inspect ingested document/index/analytics counts, extraction failures, pending embeddings, cast resolution, real attachment/dedup/calendar-UID links, visit and analytics temporal projections, and live scenario answers. A graph demo must use actual supported edge types; arbitrary invoice-to-bank semantic edges cannot be assumed. A green fixture validator proves structure, not scenario quality or processing provenance.
