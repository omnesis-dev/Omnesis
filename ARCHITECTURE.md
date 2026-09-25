# Omnesis architecture

This is the orientation for a new contributor: what the pieces are, how data
moves through them, and where to read more. It should take about ten minutes.
It is deliberately high-level — the code is the only complete reference, and
`docs/conventions.md` carries the engineering patterns you are expected to imitate.

> `AGENTS.md` (symlinked as `CLAUDE.md`) is operational guidance for an AI coding
> agent working in this repo — plan-mode, subagents, test lanes, worktree rules.
> It is not an architecture document; this file is.

## The big picture

Omnesis indexes and searches your personal data — email, messages, notes,
calendar, tasks, files, health — entirely on your own machine. Nothing is stored
by any third party, and for the AI layer (embeddings, the agent, transcription,
OCR) you choose where inference runs, from fully local to any cloud provider.

The system is a **star topology**. The **gateway** is the single hub that owns
all persistent state; every other component is a client that pairs with it and
holds a scoped token. The **collector** runs the sync engine and drives the
per-source plugins. **Providers** are one package per data source. The clients —
CLI, web portal, iOS app, Android app, browser extension — are all gateway
clients speaking the same HTTP + WebSocket protocol.

```
        Sources (Gmail, WhatsApp, Notes, Drive, Health, ...)
                            |
                            |  provider plugins
                            v
                     ┌─────────────┐
                     │  Collector  │   sync engine + source manager
                     └─────────────┘   (no local HTTP surface)
                            |
                            |  HTTP ingest + WS /device/ws
                            v
       ┌──────────────────────────────────────────────┐
       │                  Gateway                      │  port 7600, HTTPS
       │  HTTP server (Hono)  ·  SQLite store          │
       │  Indexer (BM25 + vectors + graph links)       │
       │  Search pipeline  ·  Scheduler / workers      │
       │  Built-in agent  ·  Source & device registry  │
       │  /portal (web UI)                             │
       └──────────────────────────────────────────────┘
                            ^
           ┌──────────┬─────┴─────┬──────────┬───────────────┐
           │          │           │          │               │
        [ CLI ]  [ Portal ]  [ iOS app ] [ Android ]  [ Browser ext ]
```

Everything a client can do is an authenticated gateway endpoint. The collector
and gateway may run on the same machine or on separate hosts; the CLI runs
anywhere with network reach to the gateway. Each client is a paired _device_
with its own scoped token (`read`, `admin`, `write:*`, `write:<source-type>`),
so a single gateway can fan out across several machines.

## Data flow

A record travels from a source to a searchable, reasoned-over document like this:

```
  source API/file
      │  provider.sync()  (bootstrap or incremental, cursor-driven)
      ▼
  Collector  ──HTTP ingest──▶  Gateway upsert  (content-hash dedup)
                                    │
                                    ▼
                                Indexer:
                                  · chunk document text
                                  · embed chunks (local GPU/CPU or HTTP model)
                                  · FTS / BM25 index
                                  · vector ANN index
                                  · extract reference-graph links
                                    │
                                    ▼
                       Search pipeline  +  Agent  +  SQL analytics
```

The collector fetches from each source on a schedule, normalizes the results in
the provider, and pushes documents to the gateway, which upserts them (dedup by
content hash) and hands them to the embedded indexer. Search fuses keyword and
vector results; the agent and the CLI/portal read through the same query APIs.

### The stores

The gateway owns four on-disk stores under `~/.config/omnesis/`:

| File            | Engine       | Holds                                                                    |
| --------------- | ------------ | ------------------------------------------------------------------------ |
| `omnesis.db`    | SQLite       | Documents, sources, devices, tokens, people graph, reference-graph links |
| `index.db`      | SQLite       | Search index — chunk text, FTS (BM25), raw embeddings                    |
| `index.usearch` | usearch HNSW | Vector ANN index, sits beside `index.db`                                 |
| `analytics.db`  | DuckDB       | Structured/tabular source data for SQL analytics                         |

The main SQLite schema is versioned with `PRAGMA user_version`; migrations are
append-only, contiguous, and run on startup before the first sync (see the
migrations convention in `docs/conventions.md` and `CLAUDE.md`).

## The people graph

Omnesis resolves every email address, phone number, and display name it sees,
across all sources, into one canonical _person_ — an identity-resolution
equivalence class. A search for someone therefore matches every conversation you
had with them regardless of which platform it happened on, and person filters
(`from:`, `with:`) span the whole merge class rather than a single raw address.

## The reference graph

Alongside people, the indexer weaves records into a _reference graph_ that
connects threads, attachments, and cited documents. Well-referenced documents
rank higher in search, and the graph lets the agent (and the `trail` command)
hop from an email to its attached PDF to the notes that cite it — a chronological
"story" around any document.

## Where inference runs

Every AI capability is a **role** you assign a model to. The roles are
`embedder`, `agent`, `transcriber` (speech-to-text), `ocr`, and
`background-agent` (defined in `packages/core/src/models/capabilities.ts`).
For each role the operator chooses where inference runs:

- **Local, in-process** — GGUF models under `~/.config/omnesis/models/`,
  GPU-accelerated on Apple Silicon, CPU on Linux. Fully offline.
- **HTTP, OpenAI-compatible** — any server you declare: self-hosted vLLM /
  Ollama / llama-server, or a cloud provider (presets ship for OpenAI, Google
  AI, Mistral, Groq, Cerebras, Together, Fireworks, DeepSeek, NVIDIA, xAI,
  Meta, Moonshot AI, OpenRouter).
- **Anthropic** — first-class backend for the `agent` role.
- **Codex** — the `agent` role on a ChatGPT subscription via OpenAI's Codex app-server.

Assignment is operator-chosen, per role, mixed freely (a local embedder with a
cloud agent is common). Remote inference requires an explicit
`inference.allowRemoteInference: true` opt-in — nothing leaves the machine by
default. Manage it from the portal's Settings → Models tab, the CLI (`omnesis model assign`,
`omnesis backend add`), or the `inference` section of the config file.

## The `defineSource()` contract — source encapsulation

The single most important architectural rule: **all logic specific to one data
source lives inside that source's provider package** (`packages/providers/<name>/`).
A provider exposes a `defineSource()` / `defineProvider()` descriptor — the
contract between the source and the rest of the system — declaring its sync
behavior, normalization, unit noun ("an email" vs. "a file"), icon, color,
deep-link builder, and so on.

Nothing source-specific may appear in shared code (`core`, `gateway`,
`collector`, `cli`, `portal`, `ios`, `android`): no `sourceType === "gmail"`
branching, no per-source URL handling, no hardcoded unit nouns or display
strings. Consumers read what they need through the source registry. If the
contract is missing something a consumer needs, **extend the descriptor** — do
not hardcode the source name downstream. A lint guard flags the common violation
and a daily audit files an issue per regression.

See `docs/conventions.md` (`defineSource()` and "Source encapsulation") and the
"Source encapsulation" section of `CLAUDE.md`. The contract surface itself lives
in `packages/source-sdk/src/define-source.ts`.

## Repo layout

TypeScript monorepo (npm workspaces, project references). Native apps and the
browser extension are separate toolchains under their own top-level directories.

| Path                         | What it is                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/types`             | Branded IDs, the document model, device + pagination types                                        |
| `packages/config`            | The zod config schema (`omnesisConfigSchema`), `OmnesisConfig`, defaults                          |
| `packages/source-sdk`        | `defineSource` / `defineProvider` factories; `Source` / `Provider` / `GatewayClient` types        |
| `packages/core`              | Cross-cutting helpers — logger, content hashing, the WS-envelope protocol, TOFU, capability roles |
| `packages/gateway-client`    | Shared HTTP + WS client implementation (`HttpGatewayClient`, `GatewayWsClient`)                   |
| `packages/gateway`           | HTTP server, SQLite store, indexer, scheduler, search, analytics-db, agent host, portal           |
| `packages/collector`         | Sync engine, source manager, auth subprocess — no local HTTP surface                              |
| `packages/agent`             | The built-in agent — session orchestration and the model backends it drives                       |
| `packages/cli`               | The unified `omnesis` CLI; also hosts the `gateway serve` / `collector run` daemons + lifecycle   |
| `packages/cli-shared`        | Shared CLI helpers (formatting, colors, error rendering)                                          |
| `packages/providers/*`       | One package per data source (`google`, `apple`, `notion`, `whatsapp`, `strava`, …)                |
| `packages/providers-synth/*` | Synthetic twins of the providers, for demos, tests, and the eval universes                        |
| `packages/agent-integration` | Durable OpenClaw/Hermes subscription delivery, ingestion, inbox, and TLS integration clients      |
| `packages/near-dupes`        | Near-duplicate detection library used by the indexer/analytics                                    |
| `packages/eval`              | Search / retrieval evaluation metrics and harness                                                 |
| `ios/`                       | Native SwiftUI iPhone app; hosts Apple Health ingestion                                           |
| `android/`                   | Native Kotlin + Jetpack Compose app; hosts Health Connect / call-log / app-usage ingestion        |
| `extension/`                 | Manifest V3 browser-capture extension — pairs to the gateway, pushes captured web pages           |
| `website/`                   | Static site published to omnesis.dev, including the public docs under `website/docs/`             |
| `scripts/release/`           | Publish pipeline — src-pointing manifests transformed to `dist` at publish time                   |

## Where to read more

- **`docs/conventions.md`** — the engineering patterns (façade splits, subpath
  package boundaries, zod-at-the-route-boundary, branded IDs, worker dispatch,
  migrations, packaging duality). Read this before establishing or imitating a pattern.
- **`website/docs/`** — the user-facing documentation published at
  https://omnesis.dev/docs (concepts, install, setup, search, agent, sources, operating).
- **`ios/AGENTS.md`** (= `ios/CLAUDE.md`) — iOS-specific development rules; read
  before touching anything under `ios/`. `android/AGENTS.md` is its Android counterpart.
- **`AGENTS.md`** — agent-operational guidance (plan-mode, subagents, test lanes,
  worktree isolation) rather than architecture.
- **The code** — the only complete and current reference for behavior and per-source detail.
