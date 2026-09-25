// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { sourceTypeOf } from "@omnesis/types";

/**
 * Generation number of the persisted config shape (`omnesis.json`).
 *
 * The config is zod-validated at the boundary. New keys are optional and
 * defaults fill the gaps, so the shape grows additively. When a key is
 * *removed* (no longer in the schema), an old file that still carries it is
 * upgraded at load time by {@link validateConfig}'s lenient mode, which strips
 * keys the strict schema rejects rather than failing the whole document — that
 * stripping is the lightweight config "migration" in lieu of a numbered engine.
 *
 * Bump this constant the day a persisted key is renamed or removed: the bump
 * is the durable record that the shape changed non-additively, surfaced to
 * clients via the compatibility manifest (`stores.config`). Version 3 marks
 * the removal of the `gateway.triggers.runner` daemon configuration. Version
 * 4 removes retired root-level and device-scoped settings. Version 5 removes
 * the query-expansion and reranking search stages along with their two model
 * assignments. Version 6 moves the search tunables up a level: they live
 * directly under `search.params` / `search.boosts` / `search.defaultFilters`,
 * replacing the keyed block that used to hold them.
 * Version 7 removes the operator-maintained HTTP reasoning-model list; agent
 * backends now infer extended-output behavior from responses.
 * Version 8 removes `gateway.triggers` outright. The gateway no longer runs
 * processes on the operator's host for anything, so the toggle that permitted
 * it names a capability that no longer exists.
 */
export const CONFIG_SCHEMA_VERSION = 8 as const;

/**
 * Whether a public Gateway URL is safe to reuse in OAuth metadata and provider
 * callback URLs. Paths are intentionally allowed for backwards-compatible
 * reverse-proxy prefixes; credentials, query parameters, and fragments are not.
 */
export function isSafePublicBaseUrl(value: string): boolean {
  // URL.search/hash cannot distinguish an absent delimiter from an empty `?`
  // or `#`, but either delimiter breaks raw provider callback concatenation.
  if (value !== value.trim() || value.includes("?") || value.includes("#")) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/** Whether a URL is an exact public HTTPS origin suitable for mobile system trust. */
export function isSafeHttpsOrigin(value: string): boolean {
  if (!isSafePublicBaseUrl(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.pathname === "/" && value === parsed.origin;
  } catch {
    return false;
  }
}

/** Whether a URL can identify an externally reachable MCP protected resource. */
export function isSafeMcpResourceUrl(value: string): boolean {
  if (!isSafePublicBaseUrl(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.pathname.endsWith("/mcp") && !parsed.pathname.endsWith("//mcp");
  } catch {
    return false;
  }
}

// Human-friendly duration used for sync intervals, retention, etc.
// parseDuration() in config.ts accepts the same strings — keep the regex aligned.
// Exported so the schema-introspection walker (`config-describe.ts`) can tag
// duration-typed string fields by comparing regex sources.
export const durationRegex = /^\d+(?:\.\d+)?\s*(ms|s|m|h|d|M|y)$|^\d+$/;
const duration = z
  .string()
  .regex(
    durationRegex,
    'expected a duration like "30s", "5m", "1h", "30d", "6M", "1y", "500ms", or a plain number (ms)',
  );
const positiveDuration = duration.refine((value) => Number.parseFloat(value) > 0, {
  message: "duration must be greater than zero",
});

const dataRetention = z
  .object({
    maxAge: duration
      .describe("Oldest allowed timestamp for ingested + indexed data, e.g. 30d, 6M, 1y.")
      .optional(),
  })
  .strict();

const activityRetention = z
  .object({
    maxAge: duration
      .describe(
        "How long operational activity history and unpinned agent transcripts are kept. Omit to keep them forever.",
      )
      .optional(),
  })
  .strict();

const backupRetention = z
  .object({
    preUpdateCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of structured pre-update backups to keep. Default 2; set to 0 to disable automatic pruning and keep them all.",
      )
      .optional(),
  })
  .strict();

const searchParams = z
  .object({
    candidateLimit: z
      .number()
      .int()
      .positive()
      .describe("Max candidates pulled from each retrieval stage before fusion.")
      .optional(),
    resultLimit: z
      .number()
      .int()
      .positive()
      .describe("Max results returned to the caller.")
      .optional(),
    rrfK: z
      .number()
      .positive()
      .describe("Reciprocal-rank-fusion constant k (higher flattens rank weighting).")
      .optional(),
    bm25Weight: z
      .number()
      .nonnegative()
      .describe("Relative weight of the BM25 stage in fusion.")
      .optional(),
    vectorWeight: z
      .number()
      .nonnegative()
      .describe("Relative weight of the vector stage in fusion.")
      .optional(),
    topRankBonus: z
      .number()
      .nonnegative()
      .describe(
        "Score added to the top-ranked fused result, so near-tied heads don't reorder between queries. Default 0.05 — about three rank positions at rrfK 60. Set to 0 to disable.",
      )
      .optional(),
    nearTopRankBonus: z
      .number()
      .nonnegative()
      .describe(
        "Score added to the second- and third-ranked fused results. Default 0.02. Set to 0 to disable.",
      )
      .optional(),
  })
  .strict();

const searchBoosts = z
  .object({
    typeBoosts: z
      .record(
        z.string(),
        z.number().describe("Score multiplier for this document type (1 = no change)."),
      )
      .describe("Per-document-type score multipliers, keyed by document type.")
      .optional(),
    relevanceBoostWeight: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "How strongly a source-supplied relevance score scales a result: a score of 1 multiplies by 1 + weight, 0.5 leaves the score unchanged, 0 multiplies by 1 - weight. Results whose source supplied no relevance score are untouched. Default 0.3; 0 disables.",
      )
      .optional(),
  })
  .strict();

const searchDefaultFilters = z
  .object({
    sourceIds: z.array(z.string()).describe("Restrict results to these source IDs.").optional(),
    documentTypes: z
      .array(z.string())
      .describe("Restrict results to these document types.")
      .optional(),
    dateFrom: z
      .string()
      .describe("Only documents on/after this date (ISO or relative).")
      .optional(),
    dateTo: z.string().describe("Only documents on/before this date (ISO or relative).").optional(),
    tags: z
      .array(z.string())
      .describe("Restrict results to documents carrying these tags.")
      .optional(),
  })
  .strict();

const searchVector = z
  .object({
    /** Over-fetch multiplier for HNSW post-filter. Default 10. */
    hnswOverFetch: z
      .number()
      .int()
      .positive()
      .describe("Over-fetch multiplier for the HNSW post-filter. Default 10.")
      .optional(),
    /**
     * Apply the over-fetch multiplier to every query, not just filtered
     * ones, so the fusion doc-dedup can reach `candidateLimit` distinct
     * documents on unfiltered queries too. Default true; set false to
     * over-fetch only on filtered queries.
     */
    alwaysOverFetch: z
      .boolean()
      .describe(
        "Apply the HNSW over-fetch multiplier to every query, not just filtered ones. Default true.",
      )
      .optional(),
  })
  .strict();

const searchSnapshot = z
  .object({
    enabled: z
      .boolean()
      .describe("Maintain a periodically-refreshed search snapshot for fast reads.")
      .optional(),
    refreshIntervalMs: z
      .number()
      .int()
      .positive()
      .describe("How often the search snapshot is refreshed, in milliseconds.")
      .optional(),
  })
  .strict();

/**
 * Tunables for the read-only `index.db` connection that powers search.
 *
 *   - `mmapBytes`: enables `PRAGMA mmap_size`. Lets the OS unified page
 *     cache hold one shared copy of hot pages across the writer worker,
 *     indexer worker, and search reader. Phase-0 measurement showed
 *     this is the single highest-impact knob — p99 dropped from 10.7 s
 *     to 1.9 s on a 475k-chunk corpus under live ingest. Safe only on
 *     read-only handles (writer-side mmap risks SIGBUS).
 *     Set to 0 to disable mmap and fall back to private pcache.
 *   - `cacheSizeBytes`: positive bytes value applied as
 *     `PRAGMA cache_size = -<KiB>`. With mmap on, the pcache is mostly
 *     redundant — most page reads go straight from the OS unified
 *     cache. A small pcache keeps prepared-statement plans + txn state
 *     hot without duplicating data pages already in OS cache.
 */
const searchReadHandle = z
  .object({
    mmapBytes: z
      .number()
      .int()
      .nonnegative()
      .describe("PRAGMA mmap_size for the read-only index.db handle. 0 disables mmap.")
      .optional(),
    cacheSizeBytes: z
      .number()
      .int()
      .nonnegative()
      .describe("Page-cache budget for the read handle (PRAGMA cache_size), in bytes.")
      .optional(),
    /**
     * Pre-warm the FTS5 and vector page caches at boot so the first
     * search doesn't pay a 20-60s cold-cache penalty. Default true.
     */
    prewarm: z
      .boolean()
      .describe(
        "Pre-warm FTS5 + vector page caches at boot to avoid a cold first search. Default true.",
      )
      .optional(),
  })
  .strict();

const searchSourcePriors = z
  .object({
    weights: z
      .record(
        z.string(),
        z.number().describe("Prior weight for this source (higher ranks the source's docs up)."),
      )
      .describe("Per-source prior weights, keyed by source ID.")
      .optional(),
    bm25BypassRank: z
      .number()
      .int()
      .nonnegative()
      .describe("Rank below which BM25 results bypass source-prior reweighting.")
      .optional(),
    autoInverseFrequency: z
      .object({
        enabled: z
          .boolean()
          .describe(
            "Derive per-source priors automatically from corpus document frequency (inverse-source-frequency). On by default; inert on single-source corpora.",
          )
          .optional(),
        strength: z
          .number()
          .nonnegative()
          .describe(
            "Dimensionless multiplier on the derived inverse-source-frequency prior. Default 1.",
          )
          .optional(),
      })
      .strict()
      .describe(
        "Automatic inverse-source-frequency source priors (no source names, no hand-tuning).",
      )
      .optional(),
  })
  .strict();

/**
 * Post-fusion per-source diversity / MMR re-ranking. Re-orders the
 * post-boost candidate pool so a single source type can't monopolise
 * the top-k. Two composable, independently-optional mechanisms:
 *
 *   - `maxPerSourceInTopK` — a hard cap: no more than N results per
 *     source bucket within the window. Surplus is demoted, never dropped.
 *   - `lambda` — MMR relevance↔diversity tradeoff. 1 = pure relevance
 *     (a no-op); lower spreads sources more.
 *
 * ON by default via MMR (`lambda` 0.7). Set `enabled: false` to disable.
 * Single-source corpora degrade to a no-op (one bucket = relevance order).
 */
const searchDiversity = z
  .object({
    enabled: z
      .boolean()
      .describe("Enable post-fusion per-source diversity re-ranking. On by default (MMR).")
      .optional(),
    bucketBy: z
      .enum(["type", "sourceId"])
      .describe("Group results by source type (gmail) or full source instance id. Default 'type'.")
      .optional(),
    topK: z
      .number()
      .int()
      .positive()
      .describe("Window size the diversity pass acts over. Default: search.params.candidateLimit.")
      .optional(),
    maxPerSourceInTopK: z
      .number()
      .int()
      .positive()
      .describe("Hard cap: at most N results per source bucket within the window. Unset = no cap.")
      .optional(),
    lambda: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "MMR relevance-diversity tradeoff. 1 = pure relevance (no-op); lower = more source spread. Default 0.7 when no other mechanism is set.",
      )
      .optional(),
  })
  .strict();

/**
 * Family-aware task prefixes for the embedder. Both `nomic-embed-text`
 * and BGE are trained with task-specific prefixes that meaningfully
 * improve retrieval recall; Omnesis ships with the feature OFF by
 * default so existing installs don't change behaviour silently.
 *
 * When `enabled: true`, the indexer worker prepends the right prefix
 * for the configured embedding model family on both indexing and
 * querying paths. Family detection is by lowercase prefix of the model
 * id (`nomic*` / `bge*` / else no-op); see `embedder-prefixes.ts`.
 *
 * IMPORTANT: enabling this on an existing install requires rebuilding
 * the vector index. Stored doc embeddings were produced without
 * prefixes; query-side prefixes alone would put the query and the
 * corpus into different embedding spaces and tank recall. Wipe `index.db`
 * or run `omnesis sources resync` across all sources after flipping
 * this flag.
 */
const searchEmbedderPrefixes = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Prepend family-aware task prefixes for the embedder. Requires a vector reindex when flipped.",
      )
      .optional(),
  })
  .strict();

const searchBm25 = z
  .object({
    /**
     * Tokens appearing in more than this fraction of all chunks are
     * dropped from the BM25 MATCH query to avoid expensive posting-list
     * scans. The remaining tokens are still searched. If ALL tokens are
     * common, the filter is bypassed. Default 0.1 (10%). Set to 0 to
     * disable.
     */
    commonTokenThreshold: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Drop BM25 tokens appearing in more than this fraction of chunks. 0 disables. Default 0.1.",
      )
      .optional(),
  })
  .strict();

const search = z
  .object({
    params: searchParams.describe("Fusion + limit tunables.").optional(),
    boosts: searchBoosts.describe("Per-type and relevance score boosts.").optional(),
    defaultFilters: searchDefaultFilters
      .describe(
        "Filters combined with every search. sourceIds, documentTypes and tags are concatenated with whatever the caller asks for (both apply, never replaced); dateFrom/dateTo apply only when the caller sets none.",
      )
      .optional(),
    vector: searchVector.describe("Vector-stage tunables.").optional(),
    bm25: searchBm25.describe("BM25-stage tunables.").optional(),
    snapshot: searchSnapshot.describe("Search-snapshot maintenance.").optional(),
    readHandle: searchReadHandle.describe("Read-only index.db connection tunables.").optional(),
    sourcePriors: searchSourcePriors.describe("Per-source ranking priors.").optional(),
    diversity: searchDiversity.describe("Post-fusion per-source diversity / MMR.").optional(),
    embedderPrefixes: searchEmbedderPrefixes
      .describe("Family-aware embedder task prefixes.")
      .optional(),
  })
  .strict();

const indexer = z
  .object({
    /**
     * How often the indexer wakes up to scan for new/updated docs.
     * Default "5m" — see gateway tuning rationale.
     */
    cycleInterval: duration
      .describe("How often the indexer wakes to scan for new/updated docs. Default 5m.")
      .optional(),
    /**
     * Shortened cycle interval used when the previous cycle found
     * work to do (new or updated docs). Keeps the indexer responsive
     * during backlog drain without busy-spinning when idle. Reverts
     * to `cycleInterval` once a cycle finds nothing. Default "1s".
     */
    cycleBacklogInterval: duration
      .describe("Faster cycle interval used while draining a backlog. Default 1s.")
      .optional(),
    /**
     * Number of documents whose chunk + summary writes are wrapped in
     * a single SQLite transaction. Batching amortises per-transaction
     * overhead (~10ms commit × N docs → ~10ms total per batch).
     * Default 50. Larger values hold the write lock longer; smaller
     * values lose the batching benefit.
     */
    dbWriteBatchSize: z
      .number()
      .int()
      .positive()
      .describe("Documents whose chunk + summary writes share one SQLite transaction. Default 50.")
      .optional(),
    /**
     * How often `reconcileDeletedDocuments` runs a full `SELECT id FROM
     * documents` diff against the index to prune orphans. Heavy O(N)
     * scan; default "1h".
     */
    reconcileInterval: duration
      .describe("How often orphaned index rows are pruned via a full diff. Heavy; default 1h.")
      .optional(),
    /**
     * How often the "gateway has docs the index doesn't" pass runs.
     * Also heavy; default "1h".
     */
    reindexMissingInterval: duration
      .describe("How often the 'docs the index is missing' reindex pass runs. Heavy; default 1h.")
      .optional(),
    /**
     * Whether to run `reindexMissing` once at boot (in addition to the
     * interval). Skipped by default — the initial `indexUpdated` pass
     * covers anything ingested during downtime, and the boot-time scan
     * used to fire at the peak-contention moment.
     */
    reindexMissingAtBoot: z
      .boolean()
      .describe("Run the reindex-missing pass once at boot too. Off by default.")
      .optional(),
    /**
     * Total llama.cpp embedding slots. Slot 0 is reserved for
     * `embedQuery` (interactive search); slots 1..N-1 fan out the
     * indexer's batch embed. Default 2. Higher values speed up indexing
     * at the cost of KV-cache memory and concurrent-write pressure on
     * index.db.
     */
    embedConcurrency: z
      .number()
      .int()
      .positive()
      .describe(
        "Total llama.cpp embedding slots (slot 0 reserved for interactive search). Default 2.",
      )
      .optional(),
    /**
     * Documents fetched per `listDocuments` call inside the indexer
     * cycle. Smaller pages = smaller read bursts on omnesis.db, but
     * more round-trips. Default 200.
     */
    pageSize: z
      .number()
      .int()
      .positive()
      .describe("Documents fetched per listDocuments call inside an indexer cycle. Default 200.")
      .optional(),
    /**
     * Sleep between consecutive pages in a backlogged cycle. Turns a
     * tight read loop into a paced walk so concurrent writes have
     * breathing room. Default "500ms".
     */
    betweenPageSleep: duration
      .describe("Pause between consecutive pages in a backlogged cycle. Default 500ms.")
      .optional(),
    /**
     * Document chunker tunables. The chunker splits long content into
     * embedding-sized windows; these knobs balance recall vs. embedding
     * cost. Defaults match `DocumentChunker`'s built-in fallbacks
     * (chunkSize=2048 chars ≈ 512 tokens, overlap=512 chars ≈ 128
     * tokens) — bump `chunkSize` only if the embedding model's
     * `embedder.contextSize` was bumped to match.
     */
    chunker: z
      .object({
        /** Max chunk length in characters. Default 2048. */
        chunkSize: z
          .number()
          .int()
          .positive()
          .describe("Max chunk length in characters. Default 2048 (~512 tokens).")
          .optional(),
        /**
         * Overlap between consecutive chunks in characters. Smooths
         * boundary phrases across windows so a query whose key terms
         * straddle a split still matches. Default 512.
         */
        overlap: z
          .number()
          .int()
          .nonnegative()
          .describe("Overlap between consecutive chunks in characters. Default 512.")
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * llama.cpp embedder tunables. Bound the per-context KV cache
     * (`contextSize`), the wall-clock timeout that frees a slot when
     * a native call wedges (`timeoutMs`), and the input-truncation
     * ceiling (`maxInputChars`) that protects the context against
     * outlier inputs. Defaults match the embedder's built-in fallbacks.
     */
    embedder: z
      .object({
        /**
         * Per-slot context size in tokens. The embedding model's max
         * context is 8192; default 2048 keeps KV-cache memory low.
         * Raise to fit longer chunks; KV cache scales linearly.
         */
        contextSize: z
          .number()
          .int()
          .positive()
          .describe("Per-slot embedder context size in tokens. Default 2048 (model max 8192).")
          .optional(),
        /**
         * Hard ceiling per `getEmbeddingFor` call in milliseconds.
         * Beyond this the slot is freed and the doc is skipped. Default
         * 30000ms; tune up only if you see legitimate long inferences
         * (very large inputs at high concurrency) get cut off.
         */
        timeoutMs: z
          .number()
          .int()
          .positive()
          .describe(
            "Hard per-embedding-call timeout in ms; the slot is freed past it. Default 30000.",
          )
          .optional(),
        /**
         * Hard cap on input length in characters. Oversized inputs are
         * truncated rather than rejected. Default 6144 (≈2048 tokens
         * at 3 chars/token); raise alongside `contextSize` if you
         * embed unusually long chunks.
         */
        maxInputChars: z
          .number()
          .int()
          .positive()
          .describe(
            "Hard input-length cap in characters; oversized inputs are truncated. Default 6144.",
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Gateway-process timing knobs. Operator-tunable via `omnesis.json`
// instead of code edits; all values are durations parsed by
// `parseDuration()`. Resolution lives in
// `packages/gateway/src/runtime-settings.ts` (env > config > default).
const gatewayTimings = z
  .object({
    /**
     * Threshold above which a request is logged as slow and recorded
     * by the metrics registry. Default `500ms`. Also overridable via
     * `OMNESIS_SLOW_REQUEST_MS` (legacy env var).
     */
    slowRequest: duration
      .describe("Requests slower than this are logged + recorded as slow. Default 500ms.")
      .optional(),
    /**
     * WebSocket heartbeat interval (server → device ping cadence).
     * Default `30s`.
     */
    wsHeartbeatInterval: duration
      .describe("WebSocket heartbeat (server to device ping) cadence. Default 30s.")
      .optional(),
    /**
     * Time a freshly-connected device has to complete the WS hello
     * handshake before the gateway closes the socket. Default `5s`.
     */
    wsAuthTimeout: duration
      .describe("Time a new device has to finish the WS hello handshake. Default 5s.")
      .optional(),
    /**
     * Per-WS-command response timeout. Default `30s`.
     */
    wsCommandTimeout: duration.describe("Per-WS-command response timeout. Default 30s.").optional(),
    /**
     * Inactivity deadline for an OAuth/auth flow. Collector updates and
     * accepted answers renew it; idle expiry cancels the flow. Default `15m`.
     */
    authFlowTtl: duration
      .describe("Auth flow inactivity timeout; idle flows are cancelled. Default 15m.")
      .optional(),
    /**
     * Pairing-code TTL (admin → device handoff via `omnesis devices
     * pair`). Default `10m`. Per-call overrides on the route still
     * win when supplied.
     */
    pairingTtl: duration
      .describe("Pairing-code TTL for the admin to device handoff. Default 10m.")
      .optional(),
    /**
     * Portal session-cookie TTL — how long a logged-in browser session
     * stays valid. Default `30d`.
     */
    sessionTtl: duration
      .describe(
        "Portal session-cookie TTL (how long a logged-in browser stays valid). Default 30d.",
      )
      .optional(),
    /**
     * Minimum interval between active portal-session refresh writes. Default
     * `1h`; capped at half of `sessionTtl` at runtime so very short TTLs
     * still refresh before expiry.
     */
    sessionRefreshThrottle: duration
      .describe("Minimum interval between active portal-session refresh writes. Default 1h.")
      .optional(),
  })
  .strict();

/**
 * Apple Push Notification service config. When present, the gateway wires up
 * an ApnsClient and a watch can notify the operator's phones. When absent, a
 * watch that notifies still validates but its firings record a "no APNs
 * config" delivery failure — visible in the portal's firing ledger, so the
 * misconfiguration is loud rather than a notification that silently never
 * arrives.
 *
 * Today only direct-to-APNs mode is supported: the gateway holds a
 * .p8 key issued under the Apple team that owns the iOS app's
 * bundle id. This works for users who build their own iOS app under
 * their own team, but blocks self-hosted gateways from pushing to
 * the official App Store app.
 */
const apns = z
  .object({
    /** Absolute path to the .p8 auth key downloaded from Apple Developer → Keys. */
    keyPath: z.string().min(1),
    /** 10-char Apple key id printed alongside the .p8 download. */
    keyId: z.string().regex(/^[A-Z0-9]{10}$/, "keyId must be 10 alphanumeric chars"),
    /** Apple Developer team id. */
    teamId: z.string().regex(/^[A-Z0-9]{10}$/, "teamId must be 10 alphanumeric chars"),
    /** Default bundle id (e.g. `dev.omnesis.ios`). Used when the device's
     * registered bundleId is missing — normally the dispatcher prefers
     * the per-device value the iOS app reported at registration. */
    bundleId: z.string().min(3),
    /** APNs environment for the default `sendApns()` call. iOS Debug
     * builds register sandbox tokens; TestFlight + App Store register
     * production tokens. Counterintuitively, TestFlight = production. */
    environment: z.enum(["sandbox", "production"]),
    /** Override the APNs authority (origin only, e.g.
     * `http://127.0.0.1:5123`). When set, every push is routed here
     * instead of Apple's production/sandbox hosts, regardless of the
     * per-device environment. Infrastructure for end-to-end tests that
     * stand up a fake APNs server and for an on-host APNs proxy/relay.
     * Also settable via the `OMNESIS_APNS_BASE_URL` env var; unset in
     * normal operation. */
    baseUrl: z.string().url().optional(),
  })
  .strict();

/**
 * Firebase Cloud Messaging HTTP v1 credentials for Android push. The service
 * account JSON is read lazily by the gateway and never returned to clients.
 */
const fcm = z
  .object({
    /** Absolute path to a Google service-account JSON key with FCM send access. */
    serviceAccountPath: z.string().min(1),
    /** Optional project override. Defaults to project_id in the service-account file. */
    projectId: z.string().min(1).optional(),
    /** Android package id covered by this Firebase project, used by push-plan. */
    appId: z.string().min(1).optional(),
    /** Optional FCM API origin override used by isolated integration tests. */
    baseUrl: z.string().url().optional(),
  })
  .strict();

/** Published relay origin plus the accepted legacy global switch. */
export const DEFAULT_PUSH_RELAY_URL = "https://push.omnesis.app";

const pushRelay = z
  .object({
    /** @deprecated Relay authorization is recorded per device; retained for config compatibility. */
    enabled: z
      .boolean()
      .default(false)
      .describe("Deprecated compatibility setting; relay authorization is per device."),
    /** HTTPS origin of the hosted push relay. */
    url: z
      .string()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" &&
          parsed.username === "" &&
          parsed.password === "" &&
          parsed.pathname === "/" &&
          parsed.search === "" &&
          parsed.hash === "" &&
          !value.endsWith("/")
        );
      }, "push relay URL must be an HTTPS origin without credentials, path, query, fragment, or trailing slash")
      .default(DEFAULT_PUSH_RELAY_URL)
      .describe(`Push relay HTTPS origin. Default ${DEFAULT_PUSH_RELAY_URL}.`),
  })
  .strict();

export const DEFAULT_PUSH_WAKE_RETRY_SETTINGS = Object.freeze({
  initialBackoffMs: 5_000,
  maxBackoffMs: 5 * 60_000,
  maxAttempts: 18,
  leaseMs: 60_000,
  batchSize: 50,
  intervalMs: 5_000,
  idleIntervalMs: 30_000,
});
const MAX_PUSH_WAKE_BACKOFF_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_PUSH_WAKE_LEASE_MS = 60_000;
const MAX_PUSH_WAKE_LEASE_MS = 60 * 60 * 1_000;
const MAX_PUSH_WAKE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const pushWakeRetry = z
  .object({
    initialBackoffMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PUSH_WAKE_BACKOFF_MS)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.initialBackoffMs)
      .describe("Delay after the first transient wake failure, in milliseconds."),
    maxBackoffMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PUSH_WAKE_BACKOFF_MS)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.maxBackoffMs)
      .describe("Maximum delay between wake attempts, in milliseconds."),
    maxAttempts: z
      .number()
      .int()
      .positive()
      .max(100)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.maxAttempts)
      .describe("Maximum carrier wake attempts per queued delivery."),
    leaseMs: z
      .number()
      .int()
      .min(MIN_PUSH_WAKE_LEASE_MS)
      .max(MAX_PUSH_WAKE_LEASE_MS)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.leaseMs)
      .describe(
        "Exclusive wake-dispatch lease duration in milliseconds; at least 60 seconds so it outlives carrier request deadlines.",
      ),
    batchSize: z
      .number()
      .int()
      .positive()
      .max(1_000)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.batchSize)
      .describe("Maximum due devices handled by one retry tick."),
    intervalMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PUSH_WAKE_INTERVAL_MS)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.intervalMs)
      .describe("Retry scan cadence while work is active, in milliseconds."),
    idleIntervalMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PUSH_WAKE_INTERVAL_MS)
      .default(DEFAULT_PUSH_WAKE_RETRY_SETTINGS.idleIntervalMs)
      .describe("Retry scan cadence while no work is due, in milliseconds."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxBackoffMs < value.initialBackoffMs) {
      ctx.addIssue({
        code: "custom",
        path: ["maxBackoffMs"],
        message: "maxBackoffMs must be at least initialBackoffMs",
      });
    }
    if (value.idleIntervalMs < value.intervalMs) {
      ctx.addIssue({
        code: "custom",
        path: ["idleIntervalMs"],
        message: "idleIntervalMs must be at least intervalMs",
      });
    }
  });

/**
 * Exponential-backoff schedule for the built-in re-auth reminder push.
 *The first reminder for a connection that needs re-auth fires
 * immediately; the Nth subsequent reminder waits
 * `initialDelay * multiplier^(N-1)` since the previous one, clamped to
 * `maxDelay`. Defaults (`1d`, ×2, cap `7d`) give the ladder
 * 1d → 2d → 4d → 7d → 7d → …. All fields optional; unset falls back to
 * the policy defaults in `reauth-reminder-policy.ts`.
 */
const reminderBackoff = z
  .object({
    /** Delay before the second reminder (the first is immediate). Default `"1d"`. */
    initialDelay: positiveDuration
      .describe("Delay before the second reminder (the first is immediate). Default 1d.")
      .optional(),
    /** Growth factor applied to the delay per reminder already sent. Default 2. */
    multiplier: z
      .number()
      .positive()
      .describe("Growth factor on the reminder delay per reminder sent. Default 2.")
      .optional(),
    /** Ceiling on the inter-reminder delay (1 week). Default `"7d"`. */
    maxDelay: positiveDuration
      .describe("Ceiling on the reminder backoff interval. Default 7d (1 week).")
      .optional(),
    reservationTtl: positiveDuration
      .describe("Lease for one in-flight reminder publication attempt. Default 5m.")
      .optional(),
  })
  .strict();

const reauthReminders = reminderBackoff;

const mobilePermissionReminders = reminderBackoff.extend({
  maxStaleNotifications: z
    .number()
    .int()
    .positive()
    .describe("Maximum reminders for one overdue mobile permission-health episode. Default 4.")
    .optional(),
  scanInterval: positiveDuration
    .describe("How often the gateway retries due mobile permission-health reminders. Default 15m.")
    .optional(),
});

/**
 * Operator-tunable knobs for the periodic background tasks run by the
 * gateway scheduler (link extraction, people resolution, merge passes,
 * stats refreshes, etc.). Each sub-block maps 1:1 to one entry in
 * `createBackfillTasks`. Defaults match the standard production
 * cadence; tune individual knobs to drive a one-shot drain after a
 * code change, or to give a task more headroom on a large corpus.
 *
 * Schema shape: each sub-block carries some combination of
 *   - `interval`: active drip cadence (duration string).
 *   - `idleDelay`: idle backoff when the task has nothing to do.
 *   - `batchSize`: rows / docs processed per tick (positive integer).
 *
 * Every field is optional and falls back to its hardcoded default;
 * see `runtime-settings.ts` for the resolved values logged at boot.
 *
 * Anchors: `packages/gateway/src/scheduler/tasks/backfill.ts` (per-
 * task opts), `packages/gateway/src/runtime-settings.ts` (resolver).
 */
const backfillLinks = z
  .object({
    /** Active drip cadence for link-extraction. Default `"1s"`. */
    interval: duration.describe("Active drip cadence for link extraction. Default 1s.").optional(),
    /** Idle backoff when nothing to do. Default `"30s"`. */
    idleDelay: duration
      .describe("Idle backoff when there's nothing to extract. Default 30s.")
      .optional(),
  })
  .strict();

const backfillLinkReconcile = z
  .object({
    /**
     * How often the URL reconcile pass fires. Default `"5m"`.
     * Lowering this in isolation increases compute load (more SELECTs
     * per hour) without changing the per-tick batch size.
     */
    interval: duration.describe("How often the URL reconcile pass fires. Default 5m.").optional(),
    /**
     * Number of URL link rows scanned per tick. Default 500. Total
     * drain rate = `batchSize / interval`. The cursor advances by at
     * most this many rows per tick; a tick that scans past the tail
     * wraps the cursor to 0 and starts the next cycle.
     */
    batchSize: z
      .number()
      .int()
      .positive()
      .describe("URL link rows scanned per reconcile tick. Default 500.")
      .optional(),
  })
  .strict();

const backfillPeople = z
  .object({
    /** Active drip cadence for the people-resolution pass. Default `"200ms"`. */
    interval: duration
      .describe("Active drip cadence for the people-resolution pass. Default 200ms.")
      .optional(),
    /** Idle backoff when caught up. Default `"30s"`. */
    idleDelay: duration
      .describe("Idle backoff when people resolution is caught up. Default 30s.")
      .optional(),
    /** Docs per people-resolution tick. Default 500. */
    batchSize: z
      .number()
      .int()
      .positive()
      .describe("Docs processed per people-resolution tick. Default 500.")
      .optional(),
  })
  .strict();

const backfillPeopleCounts = z
  .object({
    /** Cadence for the people-counts refresh. Default `"10m"`. */
    interval: duration
      .describe("Cadence for the per-person document and alias count refresh. Default 10m.")
      .optional(),
  })
  .strict();

const backfillSourceStats = z
  .object({
    /** Cadence for the source-stats refresh check. Default `"30s"`. */
    interval: duration
      .describe("Cadence for the source-stats refresh check. Default 30s.")
      .optional(),
  })
  .strict();

const backfillCatalog = z
  .object({
    /** Cadence for the catalog-stats refresh. Default `"5m"`. */
    interval: duration.describe("Cadence for the catalog-stats refresh. Default 5m.").optional(),
  })
  .strict();

const backfillLinkStats = z
  .object({
    /** Active reconcile cadence for `/links/stats` materialization. Default `"1h"`. */
    interval: duration
      .describe("Active reconcile cadence for /links/stats materialization. Default 1h.")
      .optional(),
    /** Idle backoff when no work. Default `"6h"`. */
    idleDelay: duration
      .describe("Idle backoff for link-stats when there's no work. Default 6h.")
      .optional(),
  })
  .strict();

const backfillInteractionScores = z
  .object({
    /** Active refresh cadence when a dirty bump is pending. Default `"60s"`. */
    interval: duration
      .describe("Active refresh cadence when an interaction-score bump is pending. Default 60s.")
      .optional(),
    /** Idle backoff when scores are current. Default `"5m"`. */
    idleDelay: duration
      .describe("Idle backoff when interaction scores are current. Default 5m.")
      .optional(),
  })
  .strict();

const backfillMergeRulesEval = z
  .object({
    /** Active eval cadence when rules / aliases have moved. Default `"60s"`. */
    interval: duration
      .describe("Active eval cadence when merge rules/aliases have moved. Default 60s.")
      .optional(),
    /** Idle backoff when caught up. Default `"5m"`. */
    idleDelay: duration
      .describe("Idle backoff when merge-rule eval is caught up. Default 5m.")
      .optional(),
  })
  .strict();

const backfillAutoDetect = z
  .object({
    /** Cadence for the auto-detect pass. Default `"5m"`. */
    interval: duration.describe("Cadence for the merge auto-detect pass. Default 5m.").optional(),
  })
  .strict();

const backfillMergeCandidates = z
  .object({
    /** Active cadence for the fuzzy merge-candidate detector. Default `"5m"`. */
    interval: duration
      .describe("Active cadence for the fuzzy merge-candidate detector. Default 5m.")
      .optional(),
    /** Idle backoff once the graph stabilises. Default `"30m"`. */
    idleDelay: duration
      .describe("Idle backoff once the merge-candidate graph stabilises. Default 30m.")
      .optional(),
  })
  .strict();

const gatewayBackfill = z
  .object({
    links: backfillLinks.describe("Link-extraction pass.").optional(),
    linkReconcile: backfillLinkReconcile.describe("URL link reconcile pass.").optional(),
    people: backfillPeople.describe("People-resolution pass.").optional(),
    peopleCounts: backfillPeopleCounts
      .describe("People document/alias count + primary-name refresh.")
      .optional(),
    /**
     * Former name of `peopleCounts`, still accepted. The job was renamed
     * because it stopped merging anything several releases ago; an install
     * that already sets this key must keep working, so it is read as the
     * new one when the new one is absent.
     */
    mergePass: backfillPeopleCounts.describe("Deprecated alias for peopleCounts.").optional(),
    sourceStats: backfillSourceStats.describe("Source-stats refresh.").optional(),
    catalog: backfillCatalog.describe("Catalog-stats refresh.").optional(),
    linkStats: backfillLinkStats.describe("Link-stats materialization.").optional(),
    interactionScores: backfillInteractionScores.describe("Interaction-score refresh.").optional(),
    mergeRulesEval: backfillMergeRulesEval.describe("Merge-rules evaluation.").optional(),
    autoDetect: backfillAutoDetect.describe("Merge auto-detect pass.").optional(),
    mergeCandidates: backfillMergeCandidates
      .describe("Fuzzy merge-candidate detection.")
      .optional(),
  })
  .strict();

const sharedAddressDemotion = z
  .object({
    /** Distinct name-alias count at which a one-email bucket is demoted. Default 15. */
    nameThreshold: z
      .number()
      .int()
      .positive()
      .describe(
        "Distinct name-alias count at which a single-email person bucket is treated as a shared/firehose sender and demoted (the bucket is deleted and its address blocklisted). Default 15.",
      )
      .optional(),
    /** Max distinct emails for a bucket to still count as one shared address. Default 5. */
    maxEmails: z
      .number()
      .int()
      .positive()
      .describe(
        "Maximum distinct email aliases for a bucket to still qualify as a single shared address. Buckets with more emails are treated as real people and never demoted. Default 5.",
      )
      .optional(),
  })
  .strict();

/**
 * How a document earns its way out of the index when a source stops naming it.
 *
 * A source that hands the gateway a snapshot ("here is everything that
 * exists") is asserting completeness. When the snapshot omits a document the
 * gateway holds, the omission is only *evidence* of a deletion — an
 * impoverished read of the source's own store produces the same page as a
 * genuine mass deletion. These thresholds are the floor under that
 * irreversible operation, not tuning knobs: the omission is marked, and the
 * mark only becomes a deletion once several later snapshots corroborate it
 * across a real span of time.
 *
 * Both bounds must hold, and they defend against different failures.
 * `minObservations` alone would let a source syncing every 30 seconds burn
 * the window in an afternoon; `minAge` alone would age documents out of a
 * source that stopped syncing entirely, while nothing was watching.
 */
const snapshotAbsence = z
  .object({
    /**
     * How many separate snapshots must all omit a document before it is
     * deleted. Default 3.
     */
    minObservations: z
      .number()
      .int()
      .min(1)
      .describe(
        "Snapshots that must all omit a document before its absence is treated as a deletion. Default 3.",
      )
      .optional(),
    /**
     * How long a document must have been continuously absent before it is
     * deleted, however many snapshots corroborated it. Default 24h.
     */
    minAge: positiveDuration
      .describe(
        "How long a document must be continuously absent from a source's snapshots before it is deleted. Default 24h.",
      )
      .optional(),
    /**
     * Ceiling on how many absences one snapshot may record. A source that
     * omits more than this marks the first `maxMarksPerSnapshot` and leaves
     * the rest to later snapshots, so a wholesale absence never fans out into
     * an unbounded write on the single gateway writer. Default and maximum 200.
     */
    maxMarksPerSnapshot: z
      .number()
      .int()
      .positive()
      .max(200)
      .describe(
        "Ceiling on absences recorded from one snapshot; the remainder is picked up by later snapshots. Default and maximum 200.",
      )
      .optional(),
    /**
     * How long after gateway startup a due absence remains protected from
     * deletion, giving collectors time to revoke stale evidence. Default 5m.
     */
    deletionGrace: positiveDuration
      .describe(
        "Grace after gateway startup before due snapshot absences may be deleted. Default 5m.",
      )
      .optional(),
  })
  .strict();

const gatewaySubscriptions = z
  .object({
    semanticMinimumScore: z
      .number()
      .min(-1)
      .max(1)
      .describe(
        "Recall-oriented cosine floor for subscription candidates before mandatory LLM precision review. Default 0.35.",
      )
      .optional(),
    maxDeliveryAttempts: z
      .number()
      .int()
      .positive()
      .describe(
        "Maximum pre-commit delivery attempts before a watch delivery is marked failed — an agent-integration wake or a notification to your own devices. Commit ambiguity and durable cancellation reconcile independently. Default 8.",
      )
      .optional(),
    deliveryBaseBackoffMs: z
      .number()
      .int()
      .positive()
      .describe("Initial exponential retry delay for watch delivery. Default 5000.")
      .optional(),
    deliveryMaxBackoffMs: z
      .number()
      .int()
      .positive()
      .describe("Maximum retry delay for watch delivery. Default 300000.")
      .optional(),
  })
  .strict();

/**
 * The Watch V2 shadow journal's cost controls.
 *
 * The subsystem is experimental and reads nothing today, so these exist to
 * bound what it can spend rather than to tune what it produces. Every one of
 * them is a lever on main-thread time or on memory: the drain runs on the
 * gateway's main thread, so its interval, its batch size and the depth it is
 * allowed to accumulate are the three things that decide whether it is
 * invisible or noticeable on a busy install.
 */
const gatewayWatch = z
  .object({
    drainIntervalMs: z
      .number()
      .int()
      .positive()
      .describe(
        "How often the journal drain runs while events are arriving. Lower means smaller batches and more frequent main-thread work. Default 2000.",
      )
      .optional(),
    idleIntervalMs: z
      .number()
      .int()
      .positive()
      .describe("How often the journal drain runs when there is nothing to do. Default 15000.")
      .optional(),
    batchSize: z
      .number()
      .int()
      .positive()
      .describe(
        "Journal events written per drain. Bounds how long one tick can hold the main thread; the remainder is carried to the next tick. Default 500.",
      )
      .optional(),
    queueCapacity: z
      .number()
      .int()
      .min(1000)
      .describe(
        "How many captured document events may wait in memory for the drain (minimum 1000). Analytics rows use a durable outbox. Beyond it, document arrivals are dropped and counted rather than growing until the process dies. Default 50000.",
      )
      .optional(),
    evaluateIntervalMs: z
      .number()
      .int()
      .positive()
      .describe(
        "How often the watches are evaluated while the journal has events for them. Default 5000.",
      )
      .optional(),
    idleEvaluateIntervalMs: z
      .number()
      .int()
      .positive()
      .describe(
        "How often the watches are evaluated when there is nothing to read. Timers still come due on this cadence, so it also bounds how late a time-driven watch can fire. Default 30000.",
      )
      .optional(),
    eventsPerWatch: z
      .number()
      .int()
      .positive()
      .describe(
        "Journal events handed to one watch per evaluation. Bounds how long one watch can hold the main thread; the remainder is read on the next tick. Default 200.",
      )
      .optional(),
    traceRetained: z
      .number()
      .int()
      .positive()
      .describe(
        "Trace records kept per watch. The trace is how a firing is reviewed, so a shadow period on a chatty watch may want more than the default. Default 2000.",
      )
      .optional(),
    compileTimeoutMs: z
      .number()
      .int()
      .positive()
      .describe(
        "How long one model call may take while compiling a watch. A compile sends tens of thousands of tokens and waits for a document back, so the completion default sized for short work aborts it mid-answer. Default 180000.",
      )
      .optional(),
    compileReasoningTokens: z
      .number()
      .int()
      .positive()
      .describe(
        "How much a compile turn may reason before it has to answer, in tokens. Unset — the default — leaves the compile exactly as the assigned backend runs it. Set it if compiles are missing their deadline: they run out of time deciding, not working. Setting it and being bounded are different facts, because it is fail-open everywhere it cannot be honoured — a backend or model that does not take a thinking budget runs unbounded, a server that rejects the field loses the bound rather than the turn, and an output ceiling too small to hold a budget beside the answer gets no bound at all. The gateway log says which of those happened. Honoured by OpenAI-compatible servers that accept a thinking block, and by Anthropic models that still accept an explicit budget rather than only an effort level.",
      )
      .optional(),
    promptPeople: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "People named in the compiler's prompt, most-interacted-with first. The whole directory stays addressable by id; this bounds only what a compiler is shown, because an install's directory is larger than any context window. Default 200.",
      )
      .optional(),
    judge: z
      .object({
        dailyCap: z
          .number()
          .int()
          .nonnegative()
          .refine((value) => value === 0 || value >= 2, {
            message: "must be 0 (disabled) or at least 2",
          })
          .describe(
            "Judge calls per UTC day across every watch. Use 0 to disable judging or at least 2 because a body-reviewed nomination needs two calls. Nominations beyond it are parked and drained when budget returns, oldest first. Default 200.",
          )
          .optional(),
        perWatchDailyCap: z
          .number()
          .int()
          .nonnegative()
          .refine((value) => value === 0 || value >= 2, {
            message: "must be 0 (disabled) or at least 2",
          })
          .describe(
            "Judge calls per UTC day for any one watch, so a single flooding watch cannot spend the whole allowance. Use 0 to disable or at least 2 because a body-reviewed nomination needs two calls. Default 50.",
          )
          .optional(),
      })
      .strict()
      .describe("What the semantic-precision judge may spend.")
      .optional(),
    delivery: z
      .object({
        dailyCap: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Notifications per day across every watch. A firing beyond it is recorded and suppressed rather than queued — a late notification is a wrong notification. Default 20.",
          )
          .optional(),
        perWatchDailyCap: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Notifications per day for any one watch, so a single chatty watch cannot spend the whole allowance. Default 5.",
          )
          .optional(),
      })
      .strict()
      .describe("How often a watch may interrupt you.")
      .optional(),
    wake: z
      .object({
        dailyCap: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Agent wakes per day across every watch. A firing beyond it is recorded and suppressed rather than queued. Default 25.",
          )
          .optional(),
        perWatchDailyCap: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Agent wakes per day for any one watch, so a single chatty watch cannot spend the whole allowance. Default 10.",
          )
          .optional(),
      })
      .strict()
      .describe(
        "How often a watch may wake an agent. Separate from the notification allowance: a wake costs an agent turn rather than your attention, so the two are budgeted apart.",
      )
      .optional(),
  })
  .strict()
  .refine((v) => (v.batchSize ?? 500) <= (v.queueCapacity ?? 50_000), {
    message:
      "batchSize must not exceed queueCapacity — a drain that empties the queue in one pass lets the journal's checkpoint advance past events the queue dropped",
    path: ["batchSize"],
  });

// Cross-origin request policy for browser clients behind a reverse proxy.
// Defaults OFF: with no `cors` block (or an empty `allowedOrigins`) the
// gateway emits no CORS headers and stays same-origin-only. Per-request
// defaults for the preflight headers live in the CORS middleware, not here.
const gatewayCors = z
  .object({
    allowedOrigins: z
      .array(z.string())
      .describe(
        "Origins allowed to make cross-origin browser requests (exact match, e.g. https://omnesis.example.com). Empty/omitted = no CORS headers (same-origin only). ['*'] allows any origin.",
      )
      .optional(),
    allowCredentials: z
      .boolean()
      .describe(
        "Send Access-Control-Allow-Credentials: true. With credentials the concrete Origin is echoed (never literal '*', per the Fetch spec).",
      )
      .optional(),
    allowedHeaders: z
      .array(z.string())
      .describe(
        "Access-Control-Allow-Headers for preflight. Default: Authorization, Content-Type, X-Request-Id.",
      )
      .optional(),
    allowedMethods: z
      .array(z.string())
      .describe(
        "Access-Control-Allow-Methods for preflight. Default: GET, POST, PUT, PATCH, DELETE, OPTIONS.",
      )
      .optional(),
    maxAgeSeconds: z
      .number()
      .int()
      .nonnegative()
      .describe("Access-Control-Max-Age (preflight cache seconds). Default 600.")
      .optional(),
  })
  .strict()
  // A wildcard origin combined with credentials would have the gateway echo
  // any requesting Origin alongside `Access-Control-Allow-Credentials: true`,
  // which effectively disables the browser's cross-origin protection for
  // credentialed requests. The Fetch spec forbids the literal `*` with
  // credentials for exactly this reason; reject the equivalent config shape
  // up front and require exact origins when credentials are allowed.
  .refine((c) => !(c.allowCredentials === true && (c.allowedOrigins ?? []).includes("*")), {
    message:
      "cors.allowCredentials cannot be combined with a wildcard cors.allowedOrigins ('*'); list exact origins instead",
    path: ["allowCredentials"],
  });

// Per-token / per-endpoint access logging. Defaults OFF: with no `audit`
// block the gateway emits no access-log lines, preserving today's posture.
const gatewayAudit = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Emit one structured access-log line per authenticated request (token prefix, device, method, route, status, client IP). Default false.",
      )
      .optional(),
    includeUnauthenticated: z
      .boolean()
      .describe(
        "Also log requests with no valid token (public routes / failed auth). Default false.",
      )
      .optional(),
  })
  .strict();

// LAN auto-discovery. When enabled the gateway advertises itself as an
// `_omnesis._tcp` mDNS/Bonjour service and publishes its mDNS hostname, so a
// collector on the same LAN with `OMNESIS_GATEWAY_URL` unset can find it
// without configuration, and browsers can reach the portal at
// `https://<hostname>:<port>`.
const gatewayMdns = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Advertise the gateway as an _omnesis._tcp mDNS service on the LAN so collectors auto-discover it, and publish the mDNS hostname. Default true.",
      )
      .optional(),
    hostname: z
      .string()
      .min(1)
      .describe(
        "mDNS hostname the gateway is reachable at (default 'omnesis.local'). Browsers/collectors can hit https://<hostname>:<port>.",
      )
      .optional(),
    serviceName: z
      .string()
      .min(1)
      .describe("mDNS service instance name (defaults to the OS hostname).")
      .optional(),
  })
  .strict();

const gatewayTls = z
  .object({
    autoRenew: z
      .boolean()
      .describe(
        "Renew the certificate Omnesis minted (self-signed, Tailscale or mkcert) in the gateway process before it expires, and activate it without a restart. Operator-provided material is never renewed. Default true.",
      )
      .optional(),
    renewBeforeDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .describe(
        "How many days before expiry the certificate counts as expiring, which is when automatic renewal starts and the doctor warns. Default 30.",
      )
      .optional(),
  })
  .strict();

const gateway = z
  .object({
    /**
     * SQLite journal mode for omnesis.db. "TRUNCATE" (default)
     * eliminates the `-shm` file and the macOS mmap-race crash class;
     * "WAL" restores concurrent reads during commits at
     * the cost of that stability.
     */
    journalMode: z
      .enum(["WAL", "TRUNCATE"])
      .describe(
        "SQLite journal mode for omnesis.db. TRUNCATE (default) is most stable; WAL allows concurrent reads.",
      )
      .optional(),
    /**
     * Number of read-only compute workers (each with its own SQLite
     * handle). Higher values let background IO tasks run in parallel
     * instead of queuing behind each other. Default 6.
     */
    ioConcurrency: z
      .number()
      .int()
      .positive()
      .describe("Read-only compute workers, each with its own SQLite handle. Default 6.")
      .optional(),
    ioReservedUserSlots: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Read-worker slots kept free of background compute so an interactive read never waits behind an in-flight background scan. Clamped to ioConcurrency-1. Default 1; 0 disables.",
      )
      .optional(),
    readHandle: z
      .object({
        cacheSizeBytes: z
          .number()
          .int()
          .nonnegative()
          .describe("Page-cache budget (bytes) for the main compute/read handle. Default 256 MiB.")
          .optional(),
        ioCacheSizeBytes: z
          .number()
          .int()
          .nonnegative()
          .describe("Page-cache budget (bytes) for each io-worker read handle. Default 64 MiB.")
          .optional(),
      })
      .strict()
      .describe(
        "omnesis.db read-handle page-cache budgets. Larger caches keep hot pages resident so they don't re-decrypt under storage encryption. mmap is deliberately NOT exposed here — it stays off on the encrypted omnesis.db read handles (a SIGBUS guard).",
      )
      .optional(),
    /**
     * Dedicated search-worker pool (Slice 3B). Relocates the heavy
     * candidate-generation block (BM25 + usearch + fusion) off the main event
     * loop onto a worker thread with its own read-only index.db handle. On any
     * worker fault or saturation the search falls back to running the identical
     * code inline on main, so it is never failed by a worker problem.
     * `concurrency: 0` fully disables the pool (pure main-thread candidate-gen).
     */
    searchWorker: z
      .object({
        concurrency: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Search-worker threads for off-main candidate generation. Default 1; 0 disables the pool (candidate-gen runs inline on main).",
          )
          .optional(),
        maxInflightBeforeFallback: z
          .number()
          .int()
          .positive()
          .describe(
            "Concurrent candidate-gen calls above which search runs inline on main instead of queueing behind the worker FIFO. Default 2.",
          )
          .optional(),
        cacheSizeBytes: z
          .number()
          .int()
          .nonnegative()
          .describe("Page-cache budget (bytes) for each search-worker read handle. Default 64 MiB.")
          .optional(),
      })
      .strict()
      .describe("Dedicated off-main search candidate-generation worker pool (Slice 3B).")
      .optional(),
    /**
     * Number of pure-compute CPU pool workers (no database handle).
     * Used for CPU-heavy work like MinHash signing, shingle extraction,
     * weighted Jaccard verification. Default: `max(1, cores - 5)`.
     */
    cpuConcurrency: z
      .number()
      .int()
      .positive()
      .describe("Pure-compute CPU pool workers (no DB handle). Default max(1, cores - 5).")
      .optional(),
    /**
     * OS nice value for the background compute worker threads (cpu + io
     * pools). Reniced DOWN so the kernel prefers the main event loop (real-time
     * search + Briefs/Loops/Calendar reads), the writer, and the embedder under
     * core contention. Range -20..19 (higher = lower priority); Linux-only.
     * Default 10.
     */
    backgroundWorkerNice: z
      .number()
      .int()
      .min(-20)
      .max(19)
      .describe("OS nice for background compute workers (Linux only). Default 10.")
      .optional(),
    /**
     * Sub-batch size for the document-ingest event-loop yield. The ingest
     * before-state capture and document.upserted emission walk a batch in
     * sub-batches of this many docs, yielding the event loop between them so a
     * large ingest can't freeze interactive reads. A latency/throughput pacing
     * knob (not a correctness bound): smaller = more responsive under heavy
     * ingest, larger = less yield overhead. Default 250.
     */
    ingestYieldBatch: z
      .number()
      .int()
      .positive()
      .describe("Docs per event-loop yield during ingest capture/emit. Default 250.")
      .optional(),
    /**
     * DuckDB cannot add a column to an existing primary key in place. The
     * first device stream therefore rebuilds the table atomically. Refuse an
     * online rebuild above this row count unless the operator deliberately
     * raises the ceiling for a maintenance window. Default 100000.
     */
    analyticsStreamRekeyMaxRows: z
      .number()
      .int()
      .positive()
      .describe(
        "Largest analytics table allowed to gain device-stream keys in one online transaction. Applied at gateway start. Default 100000.",
      )
      .optional(),
    /**
     * Memory ceiling (MiB) for the analytics DuckDB instance, which user SQL
     * shares with ingest; DuckDB spills to the store's temp directory beyond
     * it. Default a quarter of physical memory, clamped to 512–4096.
     */
    analyticsMemoryLimitMb: z
      .number()
      .int()
      .min(256)
      .describe(
        "Memory ceiling in MiB for the analytics DuckDB instance (shared by ingest and user SQL). Applied at gateway start. Default: a quarter of physical memory, 512–4096.",
      )
      .optional(),
    /**
     * Worker threads for the analytics DuckDB instance. Default half the
     * cores, clamped to 2–8, so a heavy user query leaves cores for the
     * writer, the indexer and request handling.
     */
    analyticsThreads: z
      .number()
      .int()
      .positive()
      .describe(
        "Worker threads for the analytics DuckDB instance. Applied at gateway start. Default: half the cores, 2–8.",
      )
      .optional(),
    /**
     * Minimum free disk space (megabytes) on the gateway DB volume below
     * which the gateway pauses writes: document ingestion is rejected with
     * 507 and indexing cycles are skipped, so it never writes under low
     * disk (corruption / partial-write risk). Both resume automatically
     * once free space recovers. Default 500.
     */
    minFreeDiskMb: z
      .number()
      .int()
      .positive()
      .describe(
        "Minimum free disk (MB) on the DB volume below which ingestion (507) + indexing pause. Default 500.",
      )
      .optional(),
    /**
     * Floor under snapshot-driven deletion: how much corroboration an
     * absence needs before it removes a document. See `snapshotAbsence`.
     */
    snapshotAbsence: snapshotAbsence
      .describe("Corroboration a source snapshot's omission needs before it deletes a document.")
      .optional(),
    timings: gatewayTimings.describe("Gateway process timing budgets.").optional(),
    /**
     * Periodic background-task tunables (intervals, idle delays, batch
     * sizes) — see `gatewayBackfill` for the per-task sub-blocks. Most
     * installs leave this at the defaults; bump individual fields to
     * drive a one-shot drain after a code change or to give a task
     * more headroom on a large corpus.
     */
    backfill: gatewayBackfill
      .describe("Periodic background-task cadences + batch sizes.")
      .optional(),
    /**
     * Thresholds for the boot-time shared-address demotion sweep, which
     * deletes person buckets that key on a single firehose-sender email yet
     * have accreted an implausible number of distinct display names.
     */
    sharedAddressDemotion: sharedAddressDemotion
      .describe("Shared-address (firehose-sender) demotion thresholds.")
      .optional(),
    /**
     * Apple Push Notification service config. Required for a watch to
     * notify the operator's phones; omitted in test / dev setups that
     * don't push to iPhones.
     */
    apns: apns.optional(),
    /** Firebase Cloud Messaging HTTP v1 config for Android push delivery. */
    fcm: fcm.optional(),
    /** Hosted push-relay selection. Disabled by default. */
    pushRelay: pushRelay.describe("Hosted push relay selection and endpoint.").optional(),
    pushWakeRetry: pushWakeRetry
      .describe("Durable content-free push wake retry policy.")
      .optional(),
    /**
     * Backoff schedule for the built-in re-auth reminder push.
     * When a provider connection's credentials lapse, the first reminder
     * fires immediately, then on an exponentially growing interval
     * (`initialDelay`, ×`multiplier` per reminder, capped at `maxDelay`)
     * until the connection is healthy — one reminder per connection, not
     * per source per sync tick. Tune to remind more / less aggressively.
     */
    reauthReminders: reauthReminders.describe("Re-auth reminder push backoff schedule.").optional(),
    mobilePermissionReminders: mobilePermissionReminders
      .describe("Mobile source permission-health reminder cadence and backoff.")
      .optional(),
    /** Experimental prompt subscriptions and first-party agent delivery. */
    subscriptions: gatewaySubscriptions
      .describe("Subscription semantic-candidate and delivery tunables.")
      .optional(),
    /**
     * Cost controls for the Watch V2 shadow journal. Experimental-only: the
     * subsystem does not exist outside experimental mode, so this block has no
     * effect on a default install.
     */
    watch: gatewayWatch.describe("Watch journal cost controls.").optional(),
    /**
     * The spelling from when this engine was the second of two.
     *
     * Still read, and still honoured, because a rename that quietly dropped
     * somebody's tuning would be a setting that stopped working without ever
     * saying so. `watch` wins where both are present.
     */
    watchV2: gatewayWatch.describe("Deprecated spelling of `watch`.").optional(),
    /**
     * Cross-origin request policy for browser clients behind a reverse
     * proxy. Off by default (same-origin only); set `cors.allowedOrigins`
     * when a browser app on a different origin must call the gateway.
     */
    cors: gatewayCors
      .describe("Cross-origin request policy for browser clients behind a reverse proxy.")
      .optional(),
    /**
     * Per-token / per-endpoint access logging. Off by default; enable to
     * emit one structured access-log line per request.
     */
    audit: gatewayAudit.describe("Per-token / per-endpoint access logging.").optional(),
    /**
     * LAN auto-discovery (mDNS / Bonjour). Lets a same-LAN collector find
     * the gateway with no `OMNESIS_GATEWAY_URL`, and publishes the mDNS
     * hostname so the portal is reachable at `https://<hostname>:<port>`.
     */
    mdns: gatewayMdns.describe("LAN auto-discovery (mDNS / Bonjour).").optional(),
    /**
     * The served certificate's lifecycle: whether the gateway renews the
     * material it minted itself, and how early.
     */
    tls: gatewayTls
      .describe("Certificate expiry handling for Omnesis-minted TLS material.")
      .optional(),
    /**
     * Externally-reachable HTTPS base URL of this gateway (scheme + host +
     * optional port, no trailing slash), e.g. `https://gw.example.com:7600`.
     * MCP OAuth derives its canonical issuer and resource origin from this
     * URL. OAuth / aggregator sources build `${publicBaseUrl}/oauth/callback`
     * from the complete configured value, including any existing path prefix.
     * Remote MCP access requires this value so forwarded Host headers cannot
     * influence authorization URLs. Aggregators that require a registered
     * redirect URI use the value the operator copies into their dashboard.
     * Must be HTTPS; when unset, OAuth is limited to loopback development and
     * sources keep the local-only `localhost:3003` callback fallback.
     */
    publicBaseUrl: z
      .string()
      .refine(isSafePublicBaseUrl, {
        message:
          "publicBaseUrl must be a valid https:// URL without credentials, query parameters, or a fragment",
      })
      .url()
      .refine((u) => !u.endsWith("/"), {
        message: "publicBaseUrl must not have a trailing slash",
      })
      .describe(
        "Externally-reachable HTTPS base URL for MCP OAuth and provider callbacks. Required for remote MCP access; no trailing slash.",
      )
      .optional(),
    /**
     * Additional exact HTTPS origins whose publicly trusted certificates may
     * be verified by mobile operating systems instead of pinning one leaf.
     */
    pairingSystemTrustOrigins: z
      .array(
        z
          .string()
          .refine(isSafeHttpsOrigin, {
            message:
              "pairing system-trust origins must be exact https:// origins without credentials, paths, query parameters, fragments, or trailing slashes",
          })
          .url(),
      )
      .max(16)
      .describe("Additional exact HTTPS origins trusted through the mobile operating system.")
      .optional(),
    /**
     * Additional externally reachable URLs for the same MCP server. Each URL
     * is a distinct OAuth protected-resource identifier and must end in
     * `/mcp`. The canonical `${publicBaseUrl}/mcp` URL is always included.
     */
    mcpResourceUrls: z
      .array(
        z
          .string()
          .refine(isSafeMcpResourceUrl, {
            message:
              "MCP resource URLs must be valid https:// URLs ending in /mcp without credentials, query parameters, or a fragment",
          })
          .url(),
      )
      .max(16)
      .describe("Additional trusted external URLs for the gateway's MCP protected resource.")
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const origins = new Set<string>();
    if (value.publicBaseUrl && isSafePublicBaseUrl(value.publicBaseUrl)) {
      origins.add(new URL(`${value.publicBaseUrl}/mcp`).origin);
    }
    value.mcpResourceUrls?.forEach((resource, index) => {
      if (!isSafeMcpResourceUrl(resource)) return;
      const origin = new URL(resource).origin;
      if (origins.has(origin)) {
        context.addIssue({
          code: "custom",
          path: ["mcpResourceUrls", index],
          message: "Each MCP resource URL must have a distinct origin",
        });
      }
      origins.add(origin);
    });
  });

export type ApnsSettings = z.infer<typeof apns>;
export type PushRelaySettings = z.infer<typeof pushRelay>;
export type PushWakeRetrySettings = z.infer<typeof pushWakeRetry>;
export type ReauthRemindersSettings = z.infer<typeof reauthReminders>;
export type MobilePermissionRemindersSettings = z.infer<typeof mobilePermissionReminders>;
export type GatewayCorsSettings = z.infer<typeof gatewayCors>;
export type GatewayAuditSettings = z.infer<typeof gatewayAudit>;
export type GatewayMdnsSettings = z.infer<typeof gatewayMdns>;

// Per-source settings. Shared shape for `sources.default` and per-source keys.
// Enablement & existence live in the DB (the sources table) — not here.
const sourceSettings = z
  .object({
    params: z.record(z.string(), z.string()).optional(),
    syncInterval: duration
      .describe("How often this source syncs. Overrides sources.default.syncInterval.")
      .optional(),
    extractAttachments: z
      .boolean()
      .describe("Extract + index attachment text for this source.")
      .optional(),
    attachmentMaxSizeBytes: z
      .number()
      .int()
      .positive()
      .describe("Skip attachments larger than this many bytes.")
      .optional(),
    attachmentTypes: z
      .array(z.string())
      .describe("Attachment MIME types / extensions to extract. One per entry.")
      .optional(),
    attachmentMaxTextLength: z
      .number()
      .int()
      .positive()
      .describe("Truncate extracted attachment text to this many characters.")
      .optional(),
    /**
     * Per-source override of `dataRetention.maxAge`. Documents older than this
     * are rejected at ingest and skipped during indexing for this specific
     * source. Falls back to `sources.default.maxAge`, then to the global
     * `dataRetention.maxAge` when unset. Resolved via getSourceCutoffDate().
     */
    maxAge: duration
      .describe(
        "Per-source retention cutoff. Falls back to sources.default.maxAge, then dataRetention.maxAge.",
      )
      .optional(),
  })
  .strict();

const sources = z.record(z.string(), sourceSettings);

/**
 * Near-duplicate detection — every tunable is opt-in. Defaults baked
 * into `packages/gateway/src/near-dupes/config.ts` reflect the study's
 * recommendations; an empty `nearDuplicates: {}` (or absence) yields
 * those defaults.
 *
 * Three sub-shapes:
 *   - `algorithm`     — MinHash + LSH + shingle params.
 *   - `gate`          — production-emission thresholds + automated-sender allowlist.
 *   - `scheduler`     — background-task cadences and batch sizes.
 *
 * The `eligibleDocTypes` list is at the top level for visibility — it
 * gates which docs enter the pipeline at all.
 */
const nearDuplicatesAlgorithm = z
  .object({
    shingleSize: z
      .number()
      .int()
      .positive()
      .describe("Token count per shingle for MinHash signing.")
      .optional(),
    numHashes: z
      .number()
      .int()
      .positive()
      .describe("Number of MinHash permutations per signature.")
      .optional(),
    bands: z
      .number()
      .int()
      .positive()
      .describe("LSH bands (bands x rows must equal numHashes).")
      .optional(),
    rows: z
      .number()
      .int()
      .positive()
      .describe("LSH rows per band (bands x rows must equal numHashes).")
      .optional(),
    hashSeed: z
      .number()
      .int()
      .nonnegative()
      .describe("Seed for the MinHash hash family.")
      .optional(),
    stripQuotes: z.boolean().describe("Strip quoted/reply text before shingling.").optional(),
    maxIdfWeight: z
      .number()
      .positive()
      .describe("Cap on per-token IDF weight in weighted Jaccard.")
      .optional(),
    recordThreshold: z
      .number()
      .min(0)
      .max(1)
      .describe("Min similarity (0-1) to record a near-duplicate pair.")
      .optional(),
  })
  .strict();

const nearDuplicatesGate = z
  .object({
    emailJaccardMin: z
      .number()
      .min(0)
      .max(1)
      .describe("Min Jaccard (0-1) to emit an email near-duplicate.")
      .optional(),
    emailPairUniqueDf2Min: z
      .number()
      .int()
      .nonnegative()
      .describe("Min unique df>=2 shingles shared for an email pair.")
      .optional(),
    fileLikeJaccardMin: z
      .number()
      .min(0)
      .max(1)
      .describe("Min Jaccard (0-1) to emit a file-like near-duplicate.")
      .optional(),
    fileLikePairUniqueDf2Min: z
      .number()
      .int()
      .nonnegative()
      .describe("Min unique df>=2 shingles shared for a file-like pair.")
      .optional(),
    fileLikeContainmentMin: z
      .number()
      .min(0)
      .max(1)
      .describe("Min containment (0-1) to emit a file-like near-duplicate.")
      .optional(),
    automatedSenderPrefixes: z
      .array(z.string())
      .describe(
        "Sender address prefixes treated as automated (relaxes email gating). One per entry.",
      )
      .optional(),
  })
  .strict();

const nearDuplicatesScheduler = z
  .object({
    computePeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Active compute-pass period in milliseconds.")
      .optional(),
    computeIdlePeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Idle compute-pass period in milliseconds.")
      .optional(),
    computeBatchSize: z
      .number()
      .int()
      .positive()
      .describe("Docs signed per compute tick.")
      .optional(),
    maxCandidatesPerDoc: z
      .number()
      .int()
      .positive()
      .describe("Max candidate pairs evaluated per doc.")
      .optional(),
    dfRefreshPeriodMs: z
      .number()
      .int()
      .positive()
      .describe(
        "Minimum age the document-frequency table must reach before the arrival of a new file can trigger a rebuild. Compared against a build time recorded in whole seconds, so sub-second values all mean the same thing.",
      )
      .optional(),
    dfMaxAgeMs: z
      .number()
      .int()
      .positive()
      .describe(
        "Age past which the document-frequency table is eligible to rebuild with no new file. The rebuild then happens in the next quiet hour, so the wait is this age plus however long that is away. Compared against a build time recorded in whole seconds, so sub-second values all mean the same thing.",
      )
      .optional(),
    dfQuietHourLocal: z
      .number()
      .int()
      .min(0)
      .max(23)
      .describe("Local hour (0-23) in which the no-new-file document-frequency rebuild runs.")
      .optional(),
    dfRefreshIdlePeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Idle document-frequency refresh period in milliseconds.")
      .optional(),
    sweepPeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Active sweep-pass period in milliseconds.")
      .optional(),
    sweepIdlePeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Idle sweep-pass period in milliseconds.")
      .optional(),
    sweepChunkSize: z
      .number()
      .int()
      .positive()
      .describe("Rows processed per sweep chunk.")
      .optional(),
    algoSweepStepsPerTick: z
      .number()
      .int()
      .positive()
      .describe(
        "How many chunks of a superseded document-frequency generation one near-duplicate sweep tick reclaims. Does not bound the stale-algo pass, which runs once per tick.",
      )
      .optional(),
    algoSweepChunkSize: z
      .number()
      .int()
      .positive()
      .describe("Rows processed per algorithm-sweep chunk.")
      .optional(),
  })
  .strict();

const nearDuplicates = z
  .object({
    enabled: z.boolean().describe("Enable near-duplicate detection.").optional(),
    eligibleDocTypes: z
      .array(z.string())
      .describe("Document types eligible for near-dup detection. One per entry.")
      .optional(),
    fileLikeDocTypes: z
      .array(z.string())
      .describe(
        "Document types whose arrival triggers a document-frequency rebuild. A subset of the eligible types. One per entry.",
      )
      .optional(),
    minContentLength: z
      .number()
      .int()
      .nonnegative()
      .describe("Skip documents shorter than this many characters.")
      .optional(),
    maxContentLength: z
      .number()
      .int()
      .positive()
      .describe("Skip documents longer than this many characters.")
      .optional(),
    algorithm: nearDuplicatesAlgorithm.describe("MinHash + LSH + shingle parameters.").optional(),
    gate: nearDuplicatesGate
      .describe("Production-emission thresholds + automated-sender allowlist.")
      .optional(),
    scheduler: nearDuplicatesScheduler
      .describe("Background-task cadences + batch sizes.")
      .optional(),
  })
  .strict();

// ── agent ─────────────────────────────────────────────────────────────────
// Agent-specific tunables. The agent's backend + model are configured via
// `inference.assignments.agent` (same as embedder/transcriber).
// This block only carries settings that are agent-specific and don't
// belong in the assignment string.
const agentReplay = z
  .object({
    fixture: z.string().min(1).optional(),
    placeholders: z.string().min(1).optional(),
  })
  .strict();

const agent = z
  .object({
    maxToolIterations: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("Max tool-call iterations per agent turn before it must answer.")
      .optional(),
    conversationViewingTtl: duration
      .describe(
        "How long the gateway believes a client's 'I am showing this conversation' mark " +
          "without a refresh. Content arriving inside the window is treated as seen; a " +
          "client that stops refreshing stops suppressing the unread marker after it.",
      )
      .optional(),
    // Sub-agent tunables. The depth/concurrency caps and the tree-wide
    // token budget are config knobs rather than constants in the orchestration
    // code, so an operator can dial sub-agent fan-out up or down per machine.
    subagentDepthCap: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe("Maximum sub-agent nesting depth a spawn chain may reach.")
      .optional(),
    subagentConcurrencyCap: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Maximum in-flight sub-agents per parent.")
      .optional(),
    subagentTreeTokenBudget: z
      .number()
      .int()
      .min(1)
      .describe(
        "Tree-wide LLM-token ceiling shared across a parent and all its descendant sub-agents. Unset = unbounded (a warning is logged).",
      )
      .optional(),
    replay: agentReplay.optional(),
  })
  .strict();

// ── brain ─────────────────────────────────────────────────────────────────
// Omnesis Brain / Cognition Steward tunables (experimental — the feature is active
// only when experimental mode is on AND a background-agent model is assigned
// via `inference.assignments["background-agent"]`). Every duration knob is
// deliberately floor-less so tests can compress hour/month-scale behaviour
// (debounce, decay back-off, retention) down to milliseconds.
const brainDecay = z
  .object({
    backoffBase: duration
      .describe("First status-check delay for a stale UNDATED open loop (doubles each check).")
      .optional(),
    backoffCap: duration.describe("Ceiling on the stale-loop status-check back-off.").optional(),
    datedFloor: duration
      .describe(
        "Dense status-check floor for a DATED loop near or past its deadline; an overdue loop never backs off toward auto-deletion.",
      )
      .optional(),
    datedFraction: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Fraction of the time remaining to a future deadline to wait before the next check (tension ramp; poll denser as the deadline nears).",
      )
      .optional(),
  })
  .strict();

// Proactive-lane tunables. Every producer here ships ON, so these knobs are
// the operator's brake rather than their opt-in; the feature as a whole is
// still gated on experimental mode plus a background-agent assignment.
const brainSynthesis = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the periodic synthesis ('Noticing') pass — a low-frequency run that ranges over the whole corpus to surface a non-obligation connection, trend, or gap.",
      )
      .optional(),
    cadenceHours: z
      .number()
      .int()
      .positive()
      .describe("Minimum hours between synthesis passes.")
      .optional(),
    maxPerDay: z
      .number()
      .int()
      .positive()
      .describe("Hard cap on synthesis passes enqueued per local day.")
      .optional(),
  })
  .strict();

const brainAnnotationContradictions = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the annotation-contradiction arm of the collision sweep — live annotations sharing a subject and claim type yet disagreeing on the claim seed a synthesis judge run that re-grounds both and repairs by supersession.",
      )
      .optional(),
    maxPerSweep: z
      .number()
      .int()
      .positive()
      .describe("Max annotation-contradiction judge runs enqueued per sweep.")
      .optional(),
  })
  .strict();

const brainCollision = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the cross-loop collision sweep — seeds synthesis runs from distinct loops sharing a person, document, or deadline day.",
      )
      .optional(),
    cadenceHours: z
      .number()
      .int()
      .positive()
      .describe("Minimum hours between collision sweeps.")
      .optional(),
    maxPerSweep: z
      .number()
      .int()
      .positive()
      .describe("Max model-costing collision-judge runs enqueued per sweep.")
      .optional(),
    timeHorizonDays: z
      .number()
      .int()
      .positive()
      .describe(
        "How many days ahead a pair of overlapping temporal annotations may start and still be judged for conflict/synergy.",
      )
      .optional(),
    annotationContradictions: brainAnnotationContradictions
      .describe("Annotation-contradiction sweep tunables (an arm of the collision sweep).")
      .optional(),
  })
  .strict();

const brainReverification = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the re-verification sweep — once a day it re-grounds the stalest live annotations against their cited evidence via verification agent runs (the user's own profile facts first), re-affirming, weakening, superseding, or retracting each.",
      )
      .optional(),
    intervalDays: z
      .number()
      .int()
      .positive()
      .describe(
        "Days after which a live annotation's verification counts as stale and due a re-check.",
      )
      .optional(),
    maxPerSweep: z
      .number()
      .int()
      .positive()
      .describe(
        "Max verification runs enqueued per daily sweep. Keep small — non-daily runs execute strictly serialized in the run drainer, so a large budget monopolizes the agent lane.",
      )
      .optional(),
    batchSize: z
      .number()
      .int()
      .positive()
      .describe("Annotations re-checked per verification run (one annotation store per run).")
      .optional(),
  })
  .strict();

const brainProvenanceRecheck = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the provenance-recheck sweep — when an annotation prior is invalidated or superseded, re-examine each brief/loop that was built on it via a folded feedback run per dependent (rechecks execute strictly serialized in the run drainer). The small per-pass budget is a soft cap: dependents of priors that died at the same instant always enqueue together, so one pass may overshoot the budget by that single group. Edge recording itself is always on; this gates only the recheck runs.",
      )
      .optional(),
  })
  .strict();

const brainJudge = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the brief judge — the push bar. A separate model pass over every candidate brief that decides ship/no-ship against four gates (does it tell the user something new, land before it matters, carry a real cost of inaction, and state a conclusion no single document shows?), so only what genuinely warrants interrupting the user is created. Runs at the brief_create choke point; when a configured judge times out or is unavailable, the brief is held rather than shipped unreviewed. Requires a model assigned to the `brief-judge` role — an independent model turn, including Codex; with none assigned, briefs ship unjudged.",
      )
      .optional(),
  })
  .strict();

const brainMergeAdjudication = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Run the merge-adjudication pass — the background agent examines each pending person-merge candidate the deterministic auto-approve tier left undecided and records a verdict: merge (a reversible system rule carrying the model's reason), distinct (the proposal is denied and never re-proposed), or unsure (left for manual review, annotated). Bounded cost: one run per candidate, re-run only if the candidate is re-detected. Needs the brain gate (experimental mode + a background-agent model); self-touching candidates are never adjudicated.",
      )
      .optional(),
  })
  .strict();

const brainAnnotationBasisCeilings = z
  .object({
    quoted: z
      .number()
      .min(0)
      .max(1)
      .describe("Confidence ceiling for a 'quoted' claim — the evidence essentially states it.")
      .optional(),
    inferred: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Confidence ceiling for an 'inferred' claim — one licensed deduction from a single source.",
      )
      .optional(),
    synthesized: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Confidence ceiling for a 'synthesized' claim — assembled across sources; no single quote states it.",
      )
      .optional(),
  })
  .strict();

const brainAnnotations = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the durable doc-annotation layer — evidence-grounded priors the agent persists and later reasons over (each cites an immutable source atom).",
      )
      .optional(),
    basisCeilings: brainAnnotationBasisCeilings
      .describe(
        "Per-claim-basis confidence ceilings — the further a claim reasons from its evidence, the lower its recorded confidence may go.",
      )
      .optional(),
    confidenceFloor: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Abstention floor: a new annotation whose (post-ceiling) confidence falls below this is refused outright — too weak to persist.",
      )
      .optional(),
  })
  .strict();

/**
 * A ceiling on what background cognition may spend in a day. Tokens and runs
 * only — both are measured exactly and locally. Currency is shown on the
 * surfaces as a best-effort figure but never enforced: pricing needs a
 * per-model table that goes stale for exactly the providers whose prices move.
 */
const brainBudget = z
  .object({
    dailyTokens: z
      .number()
      .int()
      .positive()
      .describe(
        "Stop background cognition once the day's total tokens (prompt + completion, every mechanism) reach this. Omit for no token ceiling.",
      )
      .optional(),
    dailyRuns: z
      .number()
      .int()
      .positive()
      .describe(
        "Stop background cognition once this many runs have completed today. Omit for no run ceiling.",
      )
      .optional(),
  })
  .strict();

const brainBootstrap = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the retrospective lane — the background agent reviews PAST documents that still carry a future-dated semantic time (recent→oldest), seeding temporal annotations and open loops from history. It covers exactly what the real-time lane does not, goes quiet when nothing is left, and reopens when a source is added or a new day begins. Lowest queue priority, so it never delays reactive or scheduled runs. On by default; active only when Briefs is active, and paced by maxRunsPerDay.",
      )
      .optional(),
    direction: z
      .enum(["recent-first", "oldest-first"])
      .describe("Order the bootstrap walks the historical corpus (default recent-first).")
      .optional(),
    backlogTarget: z
      .number()
      .int()
      .positive()
      .describe("Max pending bootstrap runs kept queued at once (paces enqueue, caps queue size).")
      .optional(),
    maxRunsPerDay: z
      .number()
      .int()
      .positive()
      .describe(
        "Bootstrap runs the lane may enqueue per local day — its pace, and therefore its spend ceiling. A bootstrap run is a full agent run: it fetches the document, reconciles it against the temporal annotations and open loops already recorded, then writes what is genuinely new, so it costs several model round-trips rather than one completion. The default holds a day of historical catch-up to roughly the cost of a day of live cognition; raise it to converge on a long history sooner, at proportionally more spend per day.",
      )
      .optional(),
    maxRuns: z
      .number()
      .int()
      .positive()
      .describe(
        "Backstop on the lane's lifetime run count. It parks once this many runs have been enqueued and resumes if the ceiling is raised. Spend is paced by maxRunsPerDay, not by this — the default sits far above any real corpus, so reaching it means something is enqueueing runaway work.",
      )
      .optional(),
    batchSize: z
      .number()
      .int()
      .positive()
      .describe("Documents enqueued per bootstrap enqueuer tick.")
      .optional(),
    activeHours: z
      .object({
        from: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, 24-hour")
          .describe("Local wall-clock time the window opens, HH:MM."),
        to: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, 24-hour")
          .describe("Local wall-clock time the window closes, HH:MM."),
      })
      .strict()
      .describe(
        "Restrict the lane to a daily window, local time — for shaping the backfill onto off-peak capacity or away from the working day. A window whose end is not after its start wraps midnight, so 22:00-06:00 means overnight. Gates when the lane BUYS work, not when a bought run executes: a run already enqueued is worked to completion whenever the drainer reaches it, since stopping mid-run would waste the tokens already spent on it. Omit for no restriction.",
      )
      .optional(),
  })
  .strict();

const brainSweep = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const value = { ...(input as Record<string, unknown>) };
    // Decode compatibility for configurations written before the LLM-owned
    // store was renamed. Runtime/config output is canonical.
    if (value.temporalAnnotationPrimeDays === undefined && value.timeIndexPrimeDays !== undefined) {
      value.temporalAnnotationPrimeDays = value.timeIndexPrimeDays;
    }
    delete value.timeIndexPrimeDays;
    return value;
  },
  z
    .object({
      cadenceHours: z
        .number()
        .positive()
        .describe("Minimum hours between runs of this sweep theme.")
        .optional(),
      steeringPrompt: z
        .string()
        .describe(
          "What this scheduled pass should look for — overrides the built-in theme with this id, or defines a custom theme.",
        )
        .optional(),
      enabled: z
        .boolean()
        .describe("Whether this theme runs (default true; set false to silence a built-in theme).")
        .optional(),
      temporalAnnotationPrimeDays: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Prime this sweep's prompt with live temporal annotations for the next N days, so a forward-looking theme starts from existing LLM interpretations before using temporal_query for complete coverage. 0 disables the prime on a built-in theme that sets one.",
        )
        .optional(),
    })
    .strict(),
);

const brainDigest = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Compose the once-a-morning digest brief — one 'Morning brief' card assembled from the temporal horizon, due loops, and overnight activity.",
      )
      .optional(),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .describe("Local hour the digest composes at (after the overnight batches settle).")
      .optional(),
    graceMinutes: z
      .number()
      .int()
      .positive()
      .describe(
        "How long past the hour the digest waits for the overnight run queue to drain before composing anyway.",
      )
      .optional(),
    push: z
      .boolean()
      .describe(
        "Send the morning digest as a push notification to paired iOS devices (at most one per day).",
      )
      .optional(),
  })
  .strict();

const brain = z
  .object({
    workerConcurrency: z
      .number()
      .int()
      .min(1)
      .describe(
        "Agent-run-queue workers draining in parallel. Non-daily runs are serialized regardless of this knob.",
      )
      .optional(),
    conversationDebounce: duration
      .describe("Quiet period before new conversation messages enqueue one agent run.")
      .optional(),
    conversationMaxDefer: duration
      .describe(
        "Ceiling on how long a continuously-active conversation's run may be deferred by its debounce — it becomes claimable within this window regardless of continued messages. Clamped up to at least the conversation debounce.",
      )
      .optional(),
    documentUpdateDebounce: duration
      .describe(
        "Per-document quiet period for updatable documents; further edits fold into the one pending run.",
      )
      .optional(),
    documentMaxDefer: duration
      .describe(
        "Ceiling on how long a continuously-edited document's run may be deferred by its debounce — it becomes claimable within this window regardless of continued edits. Clamped up to at least the document update debounce.",
      )
      .optional(),
    derivationBarrier: duration
      .describe(
        "Ceiling on how long a document's agent run waits for the deterministic derivation pipeline (reference-graph edges, people resolution, date extraction) to finish with it. The run is claimable as soon as derivation completes, or after this window with an incomplete picture — whichever comes first.",
      )
      .optional(),
    recencyWindow: duration
      .describe(
        "Recency gate: only documents whose source timestamp falls within this window of now can wake the agent — history backfills never flood it.",
      )
      .optional(),
    decay: brainDecay
      .describe("Exponential back-off for stale-open-loop status checks.")
      .optional(),
    dailyRunHour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .describe("Hour of day (gateway machine local time) the recurring daily runs fire.")
      .optional(),
    notesMaxBytes: z
      .number()
      .int()
      .positive()
      // Bounded so the 2x overflow ceiling — the largest notes write the
      // gateway accepts, in bytes — always fits the notes tools' 65536-char
      // argument schemas: the zod ceiling can never bind before the byte cap.
      .max(32768)
      .describe(
        "Soft byte cap on the agent-notes memory injected into every run's prompt; a write may briefly overshoot up to 2x while a background compaction run restores it.",
      )
      .optional(),
    transcriptRetention: duration
      .describe("How long agent-run transcripts are kept for operator debugging before pruning.")
      .optional(),
    awarenessAxis: z
      .boolean()
      .describe(
        "Add a second, non-obligation evaluation axis (connections / trends / gaps worth surfacing even when the user participated) to the daily and synthesis run prompts.",
      )
      .optional(),
    synthesis: brainSynthesis.describe("Periodic synthesis ('Noticing') pass tunables.").optional(),
    collision: brainCollision.describe("Cross-loop collision sweep tunables.").optional(),
    annotations: brainAnnotations.describe("Durable annotation layer tunables.").optional(),
    reverification: brainReverification
      .describe("Re-verification sweep tunables (the annotation-correctness pull half).")
      .optional(),
    provenanceRecheck: brainProvenanceRecheck
      .describe(
        "Provenance-recheck sweep tunables (re-examine briefs/loops built on a since-dead annotation prior).",
      )
      .optional(),
    judge: brainJudge
      .describe("The push bar — a ship/no-ship judge pass over every candidate brief.")
      .optional(),
    mergeAdjudication: brainMergeAdjudication
      .describe("Background-agent adjudication of pending person-merge candidates.")
      .optional(),
    bootstrap: brainBootstrap
      .describe(
        "Retrospective bootstrap sweep tunables (historical temporal-annotation / loop seeding).",
      )
      .optional(),
    budget: brainBudget
      .describe("Daily spend ceilings for background cognition. Absent = no ceiling.")
      .optional(),
    digest: brainDigest.describe("The composed morning digest + its push tier.").optional(),
    sweepsEnabled: z
      .boolean()
      .describe(
        "Run the built-in scheduled 'sweep' themes (finances, waiting-on-others, relationships, health, horizon, subscriptions) — prompt-steered periodic passes.",
      )
      .optional(),
    sweeps: z
      .record(z.string(), brainSweep)
      .describe(
        "Deprecated — superseded by sweep files under <configDir>/sweeps. Entries here are converted to files once at start-up and then ignored; edit sweeps on the portal's Sweeps tab or in those files instead.",
      )
      .optional(),
  })
  .strict();

// ── inference ────────────────────────────────────────────────────────
// Unified config for the inference layer. Backends declare *where*
// inference runs; assignments map capability slots to backend + model.
// Assignment values use "backend/model" string format:
//   "local/<catalogId>", "anthropic/<modelId>", "codex/<modelId>",
//   "<httpKey>/<model>", "replay" (agent only), or null (disabled).

const httpBackendConfig = z
  .object({
    type: z.literal("http"),
    url: z.string().url(),
    apiKey: z.string().min(1).optional(),
    apiKeySecret: z
      .string()
      .regex(
        /^config-secret:[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/,
        "apiKeySecret must be a valid config-secret reference",
      )
      .optional(),
    // Path segment between the base URL and the OpenAI-compatible endpoints
    // (`/chat/completions`, `/embeddings`, `/models`). Defaults to "/v1"; set
    // it when a provider serves its compat surface under a different version
    // path (e.g. Gemini's "/v1beta/openai"). Must start with "/".
    apiPathPrefix: z.string().regex(/^\//, "apiPathPrefix must start with '/'").optional(),
    // Agent wire protocol. Unset = chat-completions with a transparent retry
    // against the Responses API on a "not a chat model" 404 (so Responses-only
    // models like o1-pro work without config). Set explicitly to pin one.
    protocol: z.enum(["chat-completions", "responses"]).optional(),
    // Optional operator-declared token ceilings keyed by exact served model id.
    // `/models` does not standardize these fields, so they are never inferred
    // from a model name.
    modelLimits: z
      .record(
        z.string().min(1),
        z
          .object({
            maxInputTokens: z.number().int().positive().optional(),
            contextWindowTokens: z.number().int().positive().optional(),
            maxOutputTokens: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .optional(),
    // Per-request agent generation timeout.
    agentTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const assignmentValue = z.union([z.string(), z.null()]);

const modelBehaviorValues = z
  .object({
    reasoningEnabled: z.boolean().optional(),
    reasoningEffort: z.string().min(1).max(32).optional(),
    reasoningBudgetTokens: z.number().int().min(-1).optional(),
  })
  .strict();

const modelSettingsEntry = z
  .object({
    assignment: z.string().min(1),
    values: modelBehaviorValues,
  })
  .strict();

const inferenceModelSettings = z
  .object({
    embedder: modelSettingsEntry.optional(),
    agent: modelSettingsEntry.optional(),
    "privacy-reviewer": modelSettingsEntry.optional(),
    transcriber: modelSettingsEntry.optional(),
    ocr: modelSettingsEntry.optional(),
    "background-agent": modelSettingsEntry.optional(),
    "watch-judge": modelSettingsEntry.optional(),
    "entailment-verifier": modelSettingsEntry.optional(),
    "brief-judge": modelSettingsEntry.optional(),
  })
  .strict();

const inferenceAssignments = z
  .object({
    embedder: assignmentValue.optional(),
    agent: assignmentValue.optional(),
    // Privacy gate reviewer. It is deliberately independent
    // from `agent`: selecting a reviewer must never change the conversational
    // model assignment, and an omitted reviewer fails closed at the gate.
    "privacy-reviewer": assignmentValue.optional(),
    transcriber: assignmentValue.optional(),
    // OCR. Besides `"<httpBackend>/<model>"` (a vLLM / llama-server
    // vision model) and `"replay"`, accepts the built-in runtimes
    // "apple-vision", "tesseract", and "gguf" — see `ocr` below for the GGUF
    // model paths.
    ocr: assignmentValue.optional(),
    // Omnesis Briefs' Cognition Steward (experimental). Keyed by the capability
    // role id — assignment keys always equal their `CapabilityRole`, which
    // is what lets the registry, the portal picker, and `/admin/models`
    // treat every role generically. Never assigned by default: unset means
    // no proactive intelligence.
    "background-agent": assignmentValue.optional(),
    // Semantic Watch precision pass (experimental). Independent from Brain's
    // background agent so Watch evaluation cannot silently inherit its model
    // or cost attribution. Must serve a single-shot completion: local GGUF,
    // Anthropic, Codex, or OpenAI-compatible Chat Completions.
    "watch-judge": assignmentValue.optional(),
    // Entailment firewall over the annotation write tools (experimental).
    // Never assigned by default: unset means the gate is absent and
    // annotation writes behave exactly as without it.
    "entailment-verifier": assignmentValue.optional(),
    // The push bar over Omnesis Briefs (experimental). A dedicated role so the
    // judge runs independently from the background agent, including when both
    // use Codex. Never assigned by default: unset means briefs ship unjudged.
    "brief-judge": assignmentValue.optional(),
  })
  .strict();

// Local file paths for the built-in `gguf` OCR runtime (llama.cpp
// `llama-mtmd-cli`). Only consulted when `assignments.ocr = "gguf"`. Kept here
// rather than in the catalog because vision GGUFs need a companion projector
// (mmproj) file the single-file catalog/manifest path doesn't model.
const ocrGgufConfig = z
  .object({
    modelPath: z.string().min(1),
    mmprojPath: z.string().min(1),
    /** Path to the `llama-mtmd-cli` binary. Falls back to one on PATH. */
    binPath: z.string().min(1).optional(),
  })
  .strict();

const ocrSettings = z
  .object({
    gguf: ocrGgufConfig.optional(),
    /**
     * How many PDF pages to OCR concurrently. Unset = chosen per backend (a
     * batching HTTP vision server fans out; native subprocess backends scale to
     * the host's CPU parallelism). Override only to tune a specific backend.
     */
    pageConcurrency: z.number().int().positive().optional(),
  })
  .strict();

// Knobs for the entailment-verifier judge (`assignments["entailment-verifier"]`).
// `promptStyle` selects the prompt convention the assigned model expects:
// "judge" is the generic single-label chat prompt any instruction-following
// model answers; "minicheck" is the MiniCheck-family `Document/Claim` Yes/No
// convention for purpose-built fact checkers like bespoke-minicheck.
const entailmentSettings = z
  .object({
    promptStyle: z.enum(["judge", "minicheck"]).default("judge"),
  })
  .strict()
  .default({ promptStyle: "judge" });

const backendKey = z
  .string()
  .min(1)
  .refine((k) => !["local", "anthropic", "codex", "replay"].includes(k) && !k.includes("/"), {
    message: "Backend name cannot be 'local', 'anthropic', 'codex', 'replay', or contain '/'",
  });

const inference = z
  .object({
    backends: z.record(backendKey, httpBackendConfig).optional(),
    assignments: inferenceAssignments.optional(),
    modelSettings: inferenceModelSettings.optional(),
    allowRemoteInference: z
      .boolean()
      .describe(
        "Permit HTTP inference backends whose resolved address is not loopback. Off by default so document chunks, queries, prompts, and OCR images stay local unless explicitly opted in.",
      )
      .optional(),
    codex: z
      .object({
        interactivePoolSize: z
          .number()
          .int()
          .min(0)
          .describe(
            "Concurrent top-level Codex agent turns. Default 3; 0 shares the serialized background runtime. Restart the gateway after changing.",
          )
          .optional(),
        inferencePoolSize: z
          .number()
          .int()
          .min(1)
          .describe(
            "Concurrent Codex inference turns and capacity per nested execution depth. Default 2. Restart the gateway after changing.",
          )
          .optional(),
      })
      .strict()
      .optional(),
    ocr: ocrSettings.optional(),
    entailment: entailmentSettings,
  })
  .strict();

// Who the operator is — the single, install-level home for the human whose
// corpus this is. The gateway reads it at boot to bootstrap (and enrich) the
// canonical "self" person, so your own sent messages attribute to you and
// `from:me` works even before a contacts source has synced. Values are kept
// lenient here (plain strings) and normalized / validated at the gateway
// boundary; the `omnesis self` CLI and the portal Config tab write them.
const self = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe("Your display name — the headline shown for the canonical 'self' person.")
      .optional(),
    emails: z
      .array(z.string())
      .describe(
        "Email addresses that are yours. Used to bootstrap and enrich the canonical self person.",
      )
      .optional(),
    phones: z
      .array(z.string())
      .describe("Phone numbers that are yours (E.164, e.g. +14155550123). Normalized before use.")
      .optional(),
  })
  .strict();

// Omnesis-derived enrichment signals (experimental prototypes). Each is active
// only when experimental mode is on; the knobs below tune the background pass.
const enrichmentDates = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Enable the date-enrichment pass — extract dates from every document, resolved against its emission date. Active only when experimental mode is on.",
      )
      .optional(),
    batchSize: z
      .number()
      .int()
      .positive()
      .describe("Documents fetched + extracted per tick of the date-enrichment drip.")
      .optional(),
    maxCharsPerDoc: z
      .number()
      .int()
      .positive()
      .describe("Cap on characters fed to the date recognizer per document (bounds per-doc cost).")
      .optional(),
    scanBudgetMs: z
      .number()
      .int()
      .positive()
      .describe(
        "Wall-clock budget for one document's date scan, checked between chunks; an exhausted budget keeps the dates already found and stamps the scan truncated.",
      )
      .optional(),
    periodMs: z
      .number()
      .int()
      .positive()
      .describe("Active-cadence period of the date-enrichment drip, in milliseconds.")
      .optional(),
    idlePeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Idle-cadence period when no documents need extraction, in milliseconds.")
      .optional(),
  })
  .strict();

const enrichment = z
  .object({
    dates: enrichmentDates.describe("Date-extraction signal tunables.").optional(),
  })
  .strict();

export type EnrichmentSettings = z.infer<typeof enrichment>;

/** Lease duration of a handoff or replicated source when the config sets none. */
export const DEFAULT_SYNC_LEASE_TTL = "2m";

/** Sources hosted by several devices. */
const multiDevice = z
  .object({
    leaseTtl: duration
      .default(DEFAULT_SYNC_LEASE_TTL)
      .describe(
        "How long a device's sync lease on a handoff or replicated source lasts without renewal. Every committed page renews it; a device that stops mid-sync (a closed laptop) frees the source for another member after this long. The previous holder is preferred for one further window when it is online.",
      ),
  })
  .strict();

export const omnesisConfigSchema = z
  .object({
    self: self
      .describe(
        "Who you are — the operator's own name / emails / phones, used to bootstrap and enrich the canonical 'self' person.",
      )
      .optional(),
    dataRetention: dataRetention
      .describe("Oldest allowed timestamp for ingested + indexed data.")
      .optional(),
    activityRetention: activityRetention
      .describe(
        "Retention for disposable operational history and unpinned agent transcripts. Omit to keep activity forever.",
      )
      .optional(),
    backupRetention: backupRetention
      .describe(
        "Retention for backups created automatically before updates. Operator-created and unclassified backups are never pruned.",
      )
      .optional(),
    releaseCheck: z
      .boolean()
      .describe(
        "Check this install's existing release source for a newer stable version. Default true; the check only reports availability and never downloads or installs an update.",
      )
      .optional(),
    search: search
      .describe("Search pipeline: fusion weights, ranking tunables, vector/BM25, snapshots.")
      .optional(),
    gateway: gateway
      .describe("Gateway process: journal mode, concurrency, timings, background tasks.")
      .optional(),
    indexer: indexer
      .describe("Indexer cadence, batching, chunking, and embedder tunables.")
      .optional(),
    inference: inference
      .describe("Model selection + inference backends (managed on the Models tab).")
      .optional(),
    nearDuplicates: nearDuplicates.describe("Near-duplicate detection (MinHash + LSH).").optional(),
    sources: sources
      .describe(
        "Per-source settings. 'default' applies to every source, a source-type key (gmail) to every account of that type, and an account key (gmail:maya@example.com) to that source alone. The more specific key wins, per field.",
      )
      .optional(),
    multiDevice: multiDevice.describe("Sources hosted by several devices.").optional(),
    agent: agent.describe("Agent tunables.").optional(),
    brain: brain.describe("Omnesis Brain / Cognition Steward tunables (experimental).").optional(),
    enrichment: enrichment
      .describe("Omnesis-derived enrichment signals (experimental).")
      .optional(),
  })
  .strict();

export type OmnesisConfig = z.infer<typeof omnesisConfigSchema>;
export type SourceSettings = z.infer<typeof sourceSettings>;
export type NearDuplicatesSettings = z.infer<typeof nearDuplicates>;
export type NearDuplicatesAlgorithmSettings = z.infer<typeof nearDuplicatesAlgorithm>;
export type NearDuplicatesGateSettings = z.infer<typeof nearDuplicatesGate>;
export type NearDuplicatesSchedulerSettings = z.infer<typeof nearDuplicatesScheduler>;
export type GatewayTimingsSettings = z.infer<typeof gatewayTimings>;
export type GatewayBackfillSettings = z.infer<typeof gatewayBackfill>;
export type AgentSettings = z.infer<typeof agent>;
export type BrainSettings = z.infer<typeof brain>;
export type InferenceSettings = z.infer<typeof inference>;
export type InferenceAssignmentSettings = z.infer<typeof inferenceAssignments>;

export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface ValidateConfigOptions {
  /**
   * Strip keys the strict schema rejects as unrecognized instead of failing
   * the whole document. Use on the **file-load path**: a config written by an
   * older build can carry a since-removed key (e.g. a retired per-source
   * toggle), and rejecting it wholesale would drop the entire config back to
   * defaults — catastrophic when that config carries the inference backends,
   * model assignments, and source overrides. Interactive mutations (PATCH/PUT)
   * leave this off so the strict schema still catches typos.
   */
  stripUnknownKeys?: boolean;
}

export type ValidateConfigResult =
  | { ok: true; config: OmnesisConfig; strippedKeys: string[] }
  | { ok: false; errors: ConfigValidationError[] };

/**
 * Validate a parsed JSON value against the config schema.
 * Returns either the parsed config or a list of errors with JSON-pointer paths
 * (RFC 6901) so callers can surface "the error is at /sources/gmail:user@.../syncInterval".
 *
 * With `stripUnknownKeys`, unrecognized keys are removed before validation and
 * reported in `strippedKeys` (RFC 6901 pointers) so the caller can warn. Real
 * validation errors (bad types, out-of-range values) are never stripped — they
 * still fail.
 */
export function validateConfig(input: unknown, opts?: ValidateConfigOptions): ValidateConfigResult {
  let candidate = input;
  let strippedKeys: string[] = [];
  if (opts?.stripUnknownKeys) {
    const { value, stripped } = stripUnrecognizedKeys(input);
    candidate = value;
    strippedKeys = stripped;
  }
  const result = omnesisConfigSchema.safeParse(candidate);
  if (result.success) return { ok: true, config: result.data, strippedKeys };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: toJsonPointer(pointerPath(issue.path)),
      message: issue.message,
    })),
  };
}

/**
 * Remove every key the strict schema rejects as unrecognized, returning the
 * cleaned value and the RFC 6901 pointers of what was stripped. Iterates
 * because removing a key can expose unrecognized keys one level deeper; bounded
 * so a pathological input can't spin. Only `unrecognized_keys` issues drive a
 * removal — when the remaining issues are genuine errors, stripping stops and
 * the strict parse in {@link validateConfig} reports them.
 */
function stripUnrecognizedKeys(input: unknown): { value: unknown; stripped: string[] } {
  if (typeof input !== "object" || input === null) return { value: input, stripped: [] };
  const working: unknown = structuredClone(input);
  const stripped: string[] = [];
  for (let pass = 0; pass < 64; pass++) {
    const result = omnesisConfigSchema.safeParse(working);
    if (result.success) break;
    const unrecognized = result.error.issues.filter((issue) => issue.code === "unrecognized_keys");
    if (unrecognized.length === 0) break;
    let removed = false;
    for (const issue of unrecognized) {
      const keys = (issue as { keys?: unknown }).keys;
      if (!Array.isArray(keys)) continue;
      const parent = navigatePath(working, issue.path);
      if (typeof parent !== "object" || parent === null) continue;
      for (const key of keys) {
        if (typeof key !== "string") continue;
        if (key in (parent as Record<string, unknown>)) {
          delete (parent as Record<string, unknown>)[key];
          stripped.push(toJsonPointer([...pointerPath(issue.path), key]));
          removed = true;
        }
      }
    }
    if (!removed) break;
  }
  return { value: working, stripped };
}

/** Walk a zod issue path to the value it points at, or undefined if absent. */
function navigatePath(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

/**
 * Convert a zod-style path array (string | number segments) into an RFC 6901
 * JSON Pointer. Escapes `~` as `~0` and `/` as `~1` per the spec. Empty path
 * yields `""` (root).
 */
export function toJsonPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "";
  return path
    .map((seg) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1"))
    .reduce((acc, seg) => `${acc}/${seg}`, "");
}

function pointerPath(path: readonly PropertyKey[]): (string | number)[] {
  return path.filter(
    (seg): seg is string | number => typeof seg === "string" || typeof seg === "number",
  );
}

/**
 * Apply an RFC 7396 JSON Merge Patch to a target object.
 * Rules:
 *   - Patch values that are `null` delete the key from target.
 *   - Plain objects merge recursively.
 *   - Arrays and primitives replace wholesale.
 * Returns a new object; the inputs are not mutated.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const base = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    // Own-property access throughout: record keys are operator-controlled,
    // and a literal `__proto__` key must stay data. A plain `base[key] = …`
    // write without that own property would invoke the prototype setter and
    // change the prototype instead of storing the key.
    const value = Object.hasOwn(patch, key) ? (patch as Record<string, unknown>)[key] : undefined;
    const current = Object.hasOwn(base, key) ? (base as Record<string, unknown>)[key] : undefined;
    if (value === null) {
      delete (base as Record<string, unknown>)[key];
    } else if (key === "__proto__") {
      Object.defineProperty(base, key, {
        value: applyMergePatch(current, value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      (base as Record<string, unknown>)[key] = applyMergePatch(current, value);
    }
  }
  return base;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    Object.getPrototypeOf(x) === Object.prototype
  );
}

/**
 * The `sources.*` keys that address `sourceId`, ordered least- to
 * most-specific: the bare descriptor id (`google-drive`), then the
 * account-qualified instance id (`google-drive:maya@example.com`).
 *
 * Every source is registered under an account-qualified id, so a lookup keyed
 * on the exact id alone never reads a block written under the descriptor id —
 * the block validates, is stored, and applies to nothing. Per-source
 * resolution walks this list instead, so one key form cannot be honoured on
 * one setting and ignored on the next. `sources.default` is the tier below
 * these and is applied by the callers that have a default tier.
 *
 * This is the same addressing rule the collector applies when deciding which
 * config keys enable a source (`configKeyAddressesSource`): a bare key covers
 * every account of its type, an account-qualified key only its own.
 */
export function sourceSettingKeys(sourceId: string): string[] {
  const type = sourceTypeOf(sourceId);
  return type === sourceId ? [sourceId] : [type, sourceId];
}

/**
 * Resolve the effective settings for a given source ID, composing
 * `sources.default` (base) with every key that addresses the source, most
 * specific last. Per-field: an instance-id block beats a descriptor-id block
 * beats the default. Returns {} when none is present.
 */
export function resolveSourceSettings(config: OmnesisConfig, sourceId: string): SourceSettings {
  let settings: SourceSettings = { ...(config.sources?.default ?? {}) };
  for (const key of sourceSettingKeys(sourceId)) {
    const block = config.sources?.[key];
    if (block) settings = { ...settings, ...block };
  }
  return settings;
}

/**
 * Keep only the fields the source-settings schema owns. Useful when wiring
 * the DB `sources.config` JSON column (which may carry legacy/runtime keys)
 * back into the unified config file — we don't want to propagate untyped
 * scratch state through `PATCH /admin/config`.
 */
export function pickSourceSettings(input: Record<string, unknown>): SourceSettings {
  const out: Record<string, unknown> = {};
  for (const key of SOURCE_SETTINGS_KEYS) {
    if (key in input) out[key] = input[key];
  }
  return out as SourceSettings;
}

export const SOURCE_SETTINGS_KEYS = [
  "params",
  "syncInterval",
  "extractAttachments",
  "attachmentMaxSizeBytes",
  "attachmentTypes",
  "attachmentMaxTextLength",
  "maxAge",
] as const;

/**
 * Walk a JSON Merge Patch and return the set of RFC 6901 paths it affects.
 * Null leaves mean "delete" — still reported. Used to build the
 * `changedPaths` list broadcast on WS `config.changed`.
 */
export function changedPathsFromPatch(patch: unknown, prefix = ""): string[] {
  if (!isPlainObject(patch)) return prefix === "" ? [] : [prefix];
  const out: string[] = [];
  for (const key of Object.keys(patch)) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const next = `${prefix}/${escaped}`;
    const value = (patch as Record<string, unknown>)[key];
    if (isPlainObject(value)) {
      out.push(...changedPathsFromPatch(value, next));
    } else {
      out.push(next);
    }
  }
  return out;
}
