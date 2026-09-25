// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Simplified API for defining Omnesis providers and sources.
 *
 * Use `defineSource()` for single-source packages, `defineProvider()` for
 * multi-source packages, or `defineStructuredSource()` for analytics sources.
 *
 * @example Single source (Things, Chrome, Obsidian)
 * ```typescript
 * export default defineSource<MyCursor>({
 *   id: "things",
 *   name: "Things 3",
 *   description: "Tasks from Things 3 app",
 *   authType: "local",
 *   unitName: "tasks",
 *   discover: () => existsSync(DB_PATH) ? ["local"] : [],
 *   create: async ({ accountId, sourceId, providerId }) => ({
 *     sync: async (cursor) => syncPage(documents, { lastModified }),
 *   }),
 * });
 * ```
 */

import { tryAccountId } from "@omnesis/types";
import {
  validateAnalyticsSchemaColumnTypes,
  validateAnalyticsDeleteKeys,
  validateAnalyticsOwnership,
  validateAnalyticsSchemasHavePrimaryKey,
  validateAnalyticsSchemasReserveStreamColumn,
  validateBoundDocuments,
  validateDocumentEventProfile,
  validateDocumentTemporalProjectionContracts,
  validateRecordCitationContract,
  validateTemporalProjectionContracts,
} from "./structured-source.js";
import { emptySync } from "./source.js";
import { validateContractDeclaration, type SourceContractDeclaration } from "./source-contract.js";
import { isDerivedFromSchema, toSourceParams } from "./config-schema.js";
import { nodePathProbe } from "./path-probe-node.js";
import { executionModeOf, type ExecutionMode } from "./execution-mode.js";
import type { ConnectionState } from "./connection-state.js";
import type { AccountDescriptor } from "./account-descriptor.js";
import type { AuthResult, AuthSession } from "./auth-session.js";
import type {
  SourceId,
  ProviderId,
  DocumentIngestionContext,
  SyncRemediation,
} from "@omnesis/types";
import type {
  SyncCursor,
  SyncResult,
  SourceIcon,
  SourceAttribution,
  SourceFreshness,
  HistoryImportSpec,
  ImportCallbacks,
  ImportSummary,
} from "./source.js";
import type {
  StructuredSyncResult,
  AnalyticsTableSchema,
  DocumentEventProfile,
  DocumentTemporalProjectionSpec,
} from "./structured-source.js";
import type {
  AuthType,
  AuthFlowCallbacks,
  SourceLifecycleContext,
  SourceParam,
  SourcePlatform,
  SelfIdentitySpec,
  SourceMultiDeviceContract,
  WidgetOrigins,
  WidgetRendererSpec,
} from "./source-descriptor.js";
import type { SourceState } from "./source-state.js";
import type { ProviderHost, SourceHost } from "./source-host.js";
import type { ConfigField, ConfigSchema, InferConfig } from "./config-schema.js";
import type {
  ProviderCredentialsSpec,
  SourceConfig,
  AttachmentExtractFn,
  AudioTranscribeFn,
  UrlCanonicalizerSpec,
} from "@omnesis/core";

// ---------------------------------------------------------------------------
// Runtime instance — what create() returns
// ---------------------------------------------------------------------------

/**
 * Per-call options the engine passes into a page fetch.
 *
 * Optional on both sides: a source that ignores them still satisfies the
 * contract, and a signature that omits the parameter entirely still compiles.
 * That is deliberate — the guarantee it protects (nothing is written for a
 * stopped source) lives in the engine, not in each of the providers.
 */
/**
 * Why this run started.
 *
 * A source that adapts to it — refusing an expensive walk on a push it can
 * answer cheaply, or doing the extra work a person waiting for "Sync now"
 * expects — could not, because every trigger arrived looking identical.
 */
export type SyncReason =
  /** The source's own interval elapsed. */
  | "scheduled"
  /** The collector started and is catching up. */
  | "boot"
  /** A person asked for it and is waiting. */
  | "manual"
  /** A person asked for it *and* the cursor was reset first. */
  | "resync"
  /** The upstream said something changed. */
  | "push"
  /** A watched file changed. */
  | "file-change";

/**
 * Where this run is starting from, as the host resolved it.
 *
 * A source used to infer this from a null cursor, which conflates three
 * different situations: a source that has never run, one whose operator asked
 * for a resync, and one whose stored state could not be read. They cost
 * different things and a source may want to behave differently — the last one
 * in particular is a signal that something went wrong, not a fresh start.
 */
export type SyncStart = "first-run" | "resume" | "migrated" | "rebootstrap";

/** Why the run was cut short, when it was. */
export type SyncAbortReason =
  /** The source was removed. Nothing it holds will be read again. */
  | "removed"
  /** The operator paused it. */
  | "disabled"
  /** It is being restarted; a fresh run follows. */
  | "restarting"
  /** The wall clock ran out. Checkpointing what is in hand is worthwhile. */
  | "timeout"
  /** Another host took the sync lease for this source. */
  | "lease-lost";

/**
 * What the host knows about the run in progress.
 *
 * Every field here was already computed before the sync was called and then
 * dropped on the floor. The run has an id — it is the write-epoch fence and
 * the snapshot observation id — but a source could not put it in its own log
 * lines, so nothing a source said could be tied to the run an operator was
 * looking at. It has a deadline, which two sources reconstruct by racing their
 * own timers because they cannot see it. And it has a reason, which seven
 * trigger sites knew and none passed on.
 */
export interface SyncRun {
  /** Identifies this attempt. The same id the host fences writes with. */
  readonly id: string;
  readonly reason: SyncReason;
  readonly start: SyncStart;
  /** 0 for the first page of this run, incrementing per page. */
  readonly page: number;
  /** Epoch ms after which the host stops waiting, when it is bounded. */
  readonly deadline?: number;
  /**
   * Whether this host holds the sync lease, for a source several hosts share.
   * Absent when the source is not shared.
   */
  readonly role?: "holder" | "member";
}

export interface SyncOptions {
  /**
   * Aborts when the source stops mid-sync or its wall-clock timeout expires.
   *
   * `signal.reason` is a {@link SyncAbortReason} when the host knows which it
   * was, so a source can tell "checkpoint what you have, you ran out of time"
   * from "stop, you are being deleted" — which used to be the same event.
   */
  signal?: AbortSignal;
  /**
   * What the host knows about this run. Optional so a source may ignore it,
   * and so adding it breaks nothing.
   */
  run?: SyncRun;
}

/** A fresh access observation, never inferred from an earlier sync. */
export interface SourceReadAccessResult {
  status: "readable" | "denied" | "unavailable" | "unsupported";
  /** Operator-safe guidance only: no local paths, filenames, or raw errors. */
  remediation?: SyncRemediation;
}

/**
 * What a source found when it looked at one of the local stores it keeps on
 * the collector host — an archive, a cache — for the host's health check.
 *
 * - `encrypted`: the file opened with this host's key for it.
 * - `plaintext`: the file carries an unencrypted database header.
 * - `absent`: nothing written yet.
 * - `locked`: the file is not plaintext and the key it needs is unavailable.
 * - `unverifiable`: the file is not plaintext and did not open with the key.
 *
 * `detail` is operator-safe: no local paths, filenames, or raw errors.
 */
export interface LocalStoreProbeResult {
  /** The registered live-storage key name the store opens with. */
  keyName: string;
  /** What the store is, for the report ("WhatsApp message archive"). */
  label: string;
  state: "encrypted" | "plaintext" | "absent" | "locked" | "unverifiable";
  detail?: string;
}

/**
 * A live source instance returned by `create()`.
 * The sync engine calls `sync()` in a loop. Everything else is optional.
 *
 * Generic on `TCursor` for type-safe cursor handling — providers declare their
 * cursor shape and get compile-time checks on both input and output.
 */
/**
 * Stops a registration made by the host — see `SourceInstance.onPushEvent`.
 *
 * Calling it more than once is harmless; a host that tears a source down twice
 * should not have to remember which time was the first.
 */
export type Unsubscribe = () => void;

export interface SourceInstance<TCursor extends SyncCursor = SyncCursor> {
  /** Offline credential assessment for a standalone source with its own connection. */
  credentialState?(): Promise<ConnectionState>;
  /**
   * Fresh, read-only access check run inside the collector daemon. Open the
   * source's inputs independently of cached sync handles, then close them.
   * Never sync, read indexed content, refresh credentials, or mutate source state.
   * Bounded discovery metadata may be read to select current inputs; keep it local.
   * Honour cancellation between operations and close late-opened handles.
   * Missing inputs and incomplete discovery are unavailable, not readable.
   */
  probeReadAccess?(options: { signal: AbortSignal }): Promise<SourceReadAccessResult>;
  /**
   * Fresh inspection of the encrypted local stores this source keeps on the
   * collector host, run inside the collector daemon for the host's health
   * check. Open read-only with the host's key, never migrate, repair or
   * write; a store that is not there yet is `absent`, not an error.
   */
  probeLocalStores?(options: { signal: AbortSignal }): Promise<LocalStoreProbeResult[]>;
  /**
   * Fetch a page of documents. Called repeatedly until hasMore is false.
   *
   * `opts.signal` aborts when the source stops mid-sync — removed, disabled or
   * unregistered — or when its wall-clock timeout expires. Honouring it is
   * optional: the engine already discards a page
   * that arrives after the abort, so ignoring the signal costs one wasted fetch
   * and nothing more. A source whose page is an expensive upstream call should
   * pass it to that call so the request is dropped rather than completed and
   * thrown away.
   */
  sync(cursor: TCursor | null, opts?: SyncOptions): Promise<SyncResult<TCursor>>;

  /** For structured sources: fetch a page of analytics records. */
  syncStructured?(
    cursor: TCursor | null,
    opts?: SyncOptions,
  ): Promise<StructuredSyncResult<TCursor>>;

  /** For structured sources: DuckDB table schemas this instance manages. */
  analyticsSchemas?: AnalyticsTableSchema[];

  /**
   * Per-instance icon override. When set, the collector pushes this to
   * the gateway under the full sourceId instead of the definition-level
   * icon — used by sources whose icon depends on the account (e.g.
   * browser-history: chrome vs safari vs arc). Leave undefined to use
   * the definition-level icon.
   */
  icon?: SourceIcon;

  /**
   * Per-instance display-name override, mirroring `icon`. When set, the
   * collector registers and pushes this label to the gateway under the
   * full sourceId instead of the definition-level `name` — used by
   * sources whose display name depends on the account (e.g. an
   * aggregator source labelling each connection by institution). Leave
   * undefined to use the definition-level name.
   */
  label?: string;

  /** Clean up resources (close DB connections, etc.) */
  dispose?(): Promise<void>;

  /**
   * Pause a live connection when the source is disabled, WITHOUT the full
   * `dispose()` teardown — the instance is kept so `resume()` can revive it.
   * Push sources (e.g. WhatsApp) stop their socket + reconnect loop here so a
   * disabled source doesn't keep reconnecting (and a later re-enable doesn't
   * stack a competing connection). Omit for pull sources (no live connection).
   */
  suspend?(): Promise<void>;

  /** Re-establish the connection paused by `suspend()` when re-enabled. */
  resume?(): Promise<void>;

  /** File paths to watch for change-triggered sync (e.g. SQLite DB + WAL). */
  watchPaths?: string[];

  /** Subset of `watchPaths` known to be directories even while absent. */
  watchDirectoryPaths?: string[];

  /**
   * For directory watch paths, filename suffixes that should trigger sync.
   * Exact file watch paths ignore this filter.
   */
  watchFileExtensions?: string[];

  /**
   * How long the watched files must stay unchanged before a change triggers a
   * sync. Defaults to the collector's short debounce, which suits a file that
   * changes when something happens. A file that is rewritten continuously
   * while it is in use — a coding agent appending to its transcript after
   * every step — would otherwise be re-read on every write, and a long one
   * costs seconds of CPU each time. The source's scheduled sync still runs, so
   * this trades change-latency during a burst for not re-reading mid-burst.
   */
  watchQuietMs?: number;

  /**
   * Declares what a suspicious quiet stretch looks like for this instance, so
   * a silently stalled local feed surfaces instead of masquerading as a
   * healthy-but-quiet source. See `SourceFreshness`.
   *
   * Per-instance rather than per-definition because it depends on how the
   * instance was configured — a vault synced by iCloud has no process worth
   * probing, the same source pointed at an app-synced vault does.
   */
  freshness?: SourceFreshness;

  /**
   * Register a callback for push-based data (e.g. incoming WebSocket
   * messages), and return the handle that unregisters it.
   *
   * Returning the handle is how a source stops firing into a host that has
   * stopped listening. Without one the only way to be correct is to *replace*
   * the previous callback on every registration, which every source in the
   * tree happens to do — and which is correct by coincidence rather than by
   * contract, silently wrong for a source that appends, and unable to express
   * "this source is gone now" at all.
   *
   * A source that returns nothing still works: the host wires it once and
   * never unwires it, which is what it did before there was anything to
   * return.
   */
  onPushEvent?(callback: () => void): Unsubscribe | void;

  /**
   * Report permanent connection failures (e.g. an unlinked device), and
   * return the handle that stops the reports. See {@link onPushEvent} for why
   * the handle exists.
   */
  onSourceError?(callback: (error: string) => void): Unsubscribe | void;

  /**
   * Reset internal state before a sync that starts the source over — the
   * gateway's resync, which wipes what the source ingested and then tells the
   * collector to start it again. Called once the collector no longer tracks
   * a run of the source, and the fresh sync follows this call. A run that
   * was in progress is aborted first and this waits for it to unwind — except
   * a run the collector gave up on at its wall-clock timeout, whose page loop
   * may still be draining when this is called: a source whose reset cannot
   * tolerate a late page from such a run must fence it itself. A source that
   * keeps a local store re-marks everything in it for emission here, so the
   * corpus is rebuilt in full rather than from recent changes.
   */
  onResync?(): void;

  /**
   * Run a one-time bulk import of historical data from a user-supplied local
   * artifact. Present only on sources that also declare `historyImport`
   * on their definition. `values` are keyed by the declared `ImportField.key`s;
   * the source decrypts/parses the artifact and merges it into its own store,
   * reporting progress via `callbacks.onProgress` and returning a tally.
   * Idempotent — re-running merges by stable id without double-counting.
   */
  importHistory?(
    values: Record<string, string>,
    callbacks?: ImportCallbacks,
  ): Promise<ImportSummary>;
}

// ---------------------------------------------------------------------------
// Options passed to create()
// ---------------------------------------------------------------------------

/**
 * A source that declares no configuration schema.
 *
 * `Record<never, never>` rather than `Record<string, ConfigField>` so that
 * "declares nothing" is a type the compiler can tell apart from "declares
 * something", which is what {@link CreateOptionsFor} needs.
 */
export type NoConfigFields = Record<never, never>;

/**
 * The options a factory receives, with `config` required exactly when the
 * source declared a schema to produce it.
 *
 * A schema-declaring source is always handed a parsed configuration — the host
 * parses before it instantiates, and supplies an empty object when nothing is
 * stored. Making it optional in the type would let a caller omit it and get a
 * factory that silently falls back to a machine default, which for a source
 * whose setting names a directory means reading the operator's real one.
 */
export type CreateOptionsFor<TFields extends Record<string, ConfigField>> = [
  keyof TFields,
] extends [never]
  ? CreateOptions
  : CreateOptions<InferConfig<TFields>> & { config: InferConfig<TFields> };

/** Options passed to the `create()` factory function. */
export interface CreateOptions<TConfig = Record<string, unknown>> {
  /** Account identifier (e.g. "local", "user@gmail.com", "+44789...") */
  accountId: string;

  /**
   * Pre-composed source ID including account suffix.
   * e.g. `SourceId("things:local")`, `SourceId("gmail:user@gmail.com")`
   * Pass this to your normalizer — no need to compose it yourself.
   */
  sourceId: SourceId;

  /**
   * Pre-composed provider ID including account suffix.
   * e.g. `ProviderId("things:local")`, `ProviderId("google:user@gmail.com")`
   * Pass this to your normalizer — no need to compose it yourself.
   */
  providerId: ProviderId;

  /**
   * This source's configuration, parsed and typed against its declared schema.
   *
   * Present only for a source that declares one, and typed as that schema
   * infers rather than as a bag: a factory reads `config.vaultPath` as a
   * `string` with no cast. That is the whole point of declaring a schema, so
   * it is threaded as a generic rather than erased here.
   */
  config?: TConfig;

  /**
   * The services this source is lent: a named logger, a clock, its own state
   * directory, attachment extraction, and analytics access when it declares
   * tables. See {@link SourceHost}.
   *
   * Optional only until every provider reads it; the fields it replaces are
   * deprecated alongside it and go once they do.
   */
  host?: SourceHost;

  /**
   * @deprecated Read `host.ingestion`.
   */
  ingestionContext?: DocumentIngestionContext;

  /** ISO 8601 date — skip documents older than this */
  dataCutoff?: string;

  /** Per-source config from collector.json (syncInterval, extractAttachments, etc.) */
  sourceConfig?: SourceConfig;

  /** @deprecated Read `host.extractAttachment`. */
  extractAttachment?: AttachmentExtractFn;

  /**
   * Injected speech-to-text function for sources that carry audio (e.g.
   * WhatsApp voice notes). Forwards bytes to the gateway's transcriber. Wired
   * only when the `stt` experimental feature is enabled AND this source is
   * `conversational` (audio rendered inline). Document sources (email) get
   * `undefined` here — their audio flows through the attachment pipeline as a
   * child doc instead. Undefined means the source skips inline transcription.
   */
  transcribeAudio?: AudioTranscribeFn;

  /**
   * Whether audio MIME types should join this source's attachment allow-list
   * so audio attachments are downloaded and transcribed into a child doc.
   * Computed by the instantiator as `!conversational && stt-enabled`: only a
   * document source (email) with the `stt` feature on gets `true`. A
   * conversation source always gets `false` here — it handles audio inline
   * via `transcribeAudio` instead. Sources that support attachments forward
   * this to `resolveAttachmentConfig({ includeAudioTypes })`.
   *
   * @deprecated Read `host.includeAudioTypes`.
   */
  includeAudioTypes?: boolean;

  /**
   * Absolute path to the collector's own config directory (the same
   * `OMNESIS_CONFIG_DIR` the collector resolved at boot). Sources that keep
   * a durable on-disk store rooted under the config dir (WhatsApp's
   * per-account `store.db` / Baileys auth state) read their writable home
   * from here instead of re-deriving `DEFAULT_CONFIG_DIR`, so they honour a
   * test/isolated config dir. Populated by `source-instantiator.ts` from the
   * collector's internal config; providers that don't keep a local store
   * ignore it.
   *
   * @deprecated Read `host.configDir` for the root, or `host.stateDir` for a
   * directory this instance owns. Note they are not the same: a provider whose
   * on-disk key differs from its declared id must keep using the root.
   */
  configDir?: string;
}

/**
 * What a provider's `createContext` receives.
 *
 * Deliberately not `CreateOptions`. A provider context belongs to an account,
 * not to a source, so the fields that only make sense for a source are absent:
 * there is no source id to pass (the collector used to hand it a placeholder),
 * no per-source configuration, and no analytics access.
 */
export type ProviderContextOptions = Omit<CreateOptions, "host" | "sourceId" | "sourceConfig"> & {
  /** Account-scoped services. See {@link ProviderHost}. */
  host?: ProviderHost;
};

// ---------------------------------------------------------------------------
// Source definition (single-source packages)
// ---------------------------------------------------------------------------

/**
 * Definition for a single-source package.
 * Combines metadata, auth lifecycle, and sync logic into one object.
 *
 * @typeParam TCursor - Cursor type for type-safe sync state. Defaults to opaque `SyncCursor`.
 *
 * @example
 * ```typescript
 * interface MyCursor { lastModified: number }
 *
 * export default defineSource<MyCursor>({
 *   id: "my-source",
 *   name: "My Source",
 *   description: "Data from My App",
 *   authType: "local",
 *   create: async ({ sourceId, providerId }) => ({
 *     sync: async (cursor) => {
 *       const lastMod = cursor?.lastModified ?? 0;  // typed!
 *       return syncPage(docs, { lastModified: newMod });
 *     },
 *   }),
 * });
 * ```
 */
export interface SourceDefinition<
  TCursor extends SyncCursor = SyncCursor,
  TState extends SourceState = SourceState,
  TFields extends Record<string, ConfigField> = NoConfigFields,
> {
  readonly type: "source";

  // ── Metadata ──────────────────────────────────────────────────
  /** Source base ID (e.g. "things", "chrome-bookmarks"). No account suffix. */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description for CLI/UI listing */
  description: string;
  /**
   * Provider this source belongs to.
   * Optional for single-source packages — defaults to `{ id: source.id, name: source.name }`.
   * Set explicitly when the provider name differs from the source name,
   * or when the provider ID differs from the source ID
   * (e.g. Chrome source `"chrome-bookmarks"` under provider `"chrome"`).
   */
  provider?: { id: string; name: string };
  /** Auth mechanism */
  /**
   * How this source's persisted state and output meaning evolve, and which
   * generation of the authoring contract it is written against. See
   * `SourceContractDeclaration`.
   *
   * Every field is optional. A source that declares none of it keeps the
   * pre-versioning behaviour exactly: its stored bookmark is handed back raw,
   * and an unreadable one is indistinguishable from a first run.
   */
  contract?: SourceContractDeclaration<TState>;
  authType: AuthType;
  /**
   * The provider's `authFlow` consumes externally delivered authorization
   * codes via `callbacks.receiveCode` (gateway `/oauth/callback` redirect,
   * `POST /admin/auth-flows/:id/code`, or a manual paste). Gates the
   * paste-code affordances in the CLI / portal — a pasted code is only
   * offered when the flow can actually consume it. Providers that run
   * their own local callback listener leave this unset.
   */
  acceptsAuthCode?: boolean;
  /**
   * Mark this source as experimental / not yet battle-tested. The collector
   * hides experimental sources from the "Add source" picker (and the add /
   * instantiate path) unless the operator opts in by setting
   * `OMNESIS_EXPERIMENTAL=1` (experimental mode is a single on/off switch).
   * Synthetic mode (`OMNESIS_SYNTHETIC=1`) exposes experimental sources
   * unconditionally for tests / demos.
   */
  experimental?: boolean;
  /**
   * External widget-vendor origins this source's hosted `link-widget` needs the
   * browser to reach (its SDK CDN, iframe host, API endpoints). The collector
   * pushes the union across every loaded source to the gateway on boot (mirrors
   * `ownedWebDomains`), which folds it into the portal's Content-Security-Policy
   * so the widget can load — without any source name hardcoded gateway-side.
   * Only meaningful for `authType: "link-widget"`. See `WidgetOrigins`.
   */
  widgetOrigins?: WidgetOrigins;
  /**
   * Provider-owned browser module that renders this source's hosted widget.
   * Shared clients load it by opaque `kind` and do not know the vendor SDK.
   */
  widgetRenderer?: WidgetRendererSpec;
  /** Unit label for UI (e.g. "emails", "tasks") */
  unitName?: string;
  /** See `SourceDescriptor.primaryCount`. */
  primaryCount?: "documents" | "analytics";
  /** See `SourceDescriptor.gatewayHosted`. */
  gatewayHosted?: boolean;
  /** Icon for portal */
  icon?: SourceIcon;
  /**
   * Brand attribution requirements (e.g. Strava's "Powered by Strava"
   * byline). Each source package owns the wording; the portal/iOS render
   * it generically next to items from this source. Per-item deep links
   * are handled by `DocumentMetadata.sourceUrl`, not here.
   */
  attribution?: SourceAttribution;
  /** URL patterns for link resolution (regex → externalId extraction) */
  urlPatterns?: Array<{ regex: string; idGroup?: number }>;
  /**
   * Web hosts this source fully owns — i.e. the public hostnames of the
   * web app whose data this source already ingests (`mail.google.com` for
   * Gmail, `web.whatsapp.com` for WhatsApp, `www.notion.so` for Notion, …).
   *
   * Coarser and distinct in purpose from `urlPatterns`: `urlPatterns` match
   * *specific resource URLs* so an inbound link can resolve to a document,
   * whereas `ownedWebDomains` declares "another source already covers this
   * whole site — don't capture it." The gateway aggregates the union across
   * every loaded source (`owned-web-domains.ts`) and serves it so the
   * browser-capture source can skip any visited host already owned, instead
   * of double-ingesting it.
   *
   * Matching semantics (see `hostIsOwned` in `@omnesis/core`): a visited
   * host matches an entry `d` when `host === d` or `host` is a subdomain of
   * `d` (`host.endsWith("." + d)`). Declare bare lowercase hostnames with no
   * scheme, port, or path (e.g. `"drive.google.com"`). Each source declares
   * its own list — no central registry, no source name hardcoded downstream.
   */
  ownedWebDomains?: string[];
  /**
   * Per-host URL canonicalization. Declared when this source's resource
   * URL has multiple equivalent flavors (Gmail's `#inbox/<id>` vs
   * `#all/<id>`, Drive's `file/d/<id>/view` vs `document/d/<id>/edit`,
   * etc.). The collector ships this spec to the gateway; the gateway
   * applies it both at ingest time (so `source_url` is stored in
   * canonical form) and at lookup time (so `/documents/by-url` matches
   * a user's pasted URL against the stored row). Keeps all host-specific
   * URL knowledge inside the source package — core stays generic.
   */
  urlCanonicalizer?: UrlCanonicalizerSpec;
  /**
   * Default additive score adjustment applied to candidates from this
   * source in the boost stage. Mirrors the per-source-id-prefix weights
   * in `search.sourcePriors.weights` — negative downweights, positive
   * upweights. Cosine differences between competing results are often
   * <0.1, so even -0.04 is meaningful.
   *
   * User-supplied weights in `omnesis.json` take precedence over this
   * default. Sources without a declared default are unaffected (no
   * adjustment unless the user adds one).
   *
   * Bypass: the existing BM25-strong-hit bypass still applies — even
   * a downweighted source surfaces when BM25 has a rare-token match
   * (rank ≤ `bm25BypassRank`).
   */
  defaultSourcePrior?: number;
  /**
   * Documents from this source are URL-link hubs — dense bags of
   * referential URLs (the user's bookmarks, browsing history, and captured
   * pages) with no structural story. Set to `true`
   * to tell the gateway to skip `url`-typed graph edges to/from this
   * source's documents during subgraph BFS expansion; letting the walk
   * pivot through them otherwise inflates the neighbourhood without
   * adding signal. Structural URL edges between real sources (Gmail →
   * Drive, WhatsApp → Drive) still walk; only the `url` edges whose
   * OTHER endpoint sits in a hub source are dropped. The cited doc
   * still surfaces in the timeline as "cited by …" on the target.
   *
   * The collector pushes the union of urlHub-marked source-type
   * prefixes to the gateway on boot — keeping the per-source flag
   * inside `defineSource` rather than hardcoded gateway-side.
   */
  urlHub?: boolean;
  /**
   * Role this source's URL-addressed documents play when several documents
   * claim the same canonical `sourceUrl`.
   *
   * `"fallback"` means the document is a retained generic representation
   * (for example, a rendered Web Pages capture): inbound `url` edges should
   * prefer a non-fallback document with the same canonical URL, while the two
   * representations remain connected with `same-resource`.
   *
   * `"reference"` means `sourceUrl` names something the document points at,
   * rather than the document's own URL identity (for example, a bookmark).
   * Reference documents never become inbound `url` targets and never receive
   * `same-resource` edges solely because the referenced URL matches.
   *
   * This is deliberately independent of `urlHub`. A bookmark or browser-history
   * source can be a noisy traversal hub without its documents being fallback
   * representations of the resources it refers to.
   */
  urlTargetRole?: "fallback" | "reference";
  /**
   * Emits conversation docs and renders audio inline rather than as
   * attachment child-docs; shared code routes audio by this. A
   * conversation source (WhatsApp, iMessage) transcribes a voice note and
   * weaves the transcript into the message stream, so the spoken text is
   * part of the searchable conversation. A document source (email) leaves
   * audio to the shared attachment pipeline, which emits a separate child
   * doc. Defaults to false (document behavior).
   */
  conversational?: boolean;
  /**
   * Self-identity hook — declares how this source's account id maps to the
   * self LID alias its normalizer emits, so the gateway resolves the source's
   * self-authored PersonMentions to the canonical self person without
   * branching on a hardcoded source name. The collector pushes the union of
   * declared specs to the gateway on boot (mirrors `urlHub`). See
   * `SelfIdentitySpec`.
   */
  selfIdentity?: SelfIdentitySpec;
  /**
   * Whether a host admits at most one instance of this source (e.g. Apple
   * Notes, Things — each reads a single local database). Scope is per HOST: a
   * source configured on one collector is still addable on another. A
   * multi-source package declares this once on its `ProviderDefinition` and
   * every source inherits it. Defaults to false (multi-account capable).
   */
  singleInstance?: boolean;
  /**
   * How multiple devices may serve one account of this source. See
   * `SourceDescriptor.multiDevice` for the four modes and their
   * obligations and provider-specific acceptance required before a built-in
   * source may advertise any non-exclusive mode. Absent = `"exclusive"`.
   */
  multiDevice?: SourceMultiDeviceContract;
  /** See `SourceDescriptor.contentRetention`. */
  contentRetention?: "complete" | "best-effort";
  /**
   * Source is driven by an external push (e.g. iOS collector pushing Apple
   * Health data over HTTP). The desktop collector doesn't schedule sync
   * timers or invoke sync loops for push-based sources — their only job
   * on the Mac side is to exist in the registry so the CLI / status /
   * analytics catalog know about them.
   */
  /**
   * Who runs this source. Defaults to `"pull"` — the host does.
   *
   * A source whose documents arrive at the gateway from elsewhere declares
   * `"external"` and no factory: nothing here drives it, and there is nothing
   * for a factory to return. See {@link ExecutionMode}.
   */
  execution?: ExecutionMode;

  /**
   * @deprecated Declare `execution: "external"`. This asked the same
   * question and only its two answers were ever given.
   */
  pushBased?: boolean;
  /** User-supplied parameters (e.g. vault path) */
  /**
   * This source's configuration, declared once.
   *
   * The parsed type reaches `create()` as `options.config`, the serialisable
   * form is derived for every client, and one validator runs at both. When
   * present, `params` is derived from it — declare one or the other, never
   * both.
   */
  config?: ConfigSchema<TFields>;
  params?: SourceParam[];
  /**
   * Declares a one-time bulk-history import capability. When set, the
   * matching `SourceInstance.importHistory` runs the import; clients render a
   * generic form from `historyImport.fields`. Source-agnostic — the source owns
   * the artifact format and parsing.
   */
  historyImport?: HistoryImportSpec;
  /** Analytics table schemas (for structured sources) */
  analyticsSchemas?: AnalyticsTableSchema[];
  /**
   * Deterministic projections over typed document metadata fields.
   *
   * This declaration has three synchronization states: omit it to leave any
   * existing declaration untouched, provide specs to create or replace the
   * declaration, or provide `[]` to retire every projection owned by this
   * source. A source that previously declared projections must publish the
   * explicit empty array before removing this property.
   */
  documentTemporalProjections?: DocumentTemporalProjectionSpec[];
  /**
   * What this source's documents can be asked about — the document-side
   * counterpart of `analyticsSchemas`' categorical vocabularies.
   *
   * The collector publishes the declaration to the gateway, which persists it
   * so subscription compilation can build a bounded, opaque-handle projection
   * of the queryable surface. Omitting it keeps the source working; its
   * documents are then only addressable through the generic fields every
   * document has. See `DocumentEventProfile`.
   */
  documentEventProfile?: DocumentEventProfile;
  /**
   * Suggested sync interval when this source is added. Applied to the
   * source's stored config on `addSources`. The user can override later
   * by editing the source's config. Falls back to `defaultSyncInterval`
   * then 5m if unset. Useful for rate-limited providers (e.g. Notion:
   * "30m") where the global default is too aggressive.
   */
  defaultSyncInterval?: string;
  /**
   * Operating systems this source can run on. Undefined means the source
   * is cross-platform (default). When set, the collector's source registry
   * skips the descriptor on hosts whose `process.platform` is not in the
   * list. Use for sources that read OS-specific local databases (Things,
   * Screen Time on macOS).
   */
  supportedPlatforms?: SourcePlatform[];
  /**
   * OAuth credentials spec — set on providers that need user-supplied
   * (or overridable) OAuth credentials. Surfaces the setup wizard.
   */
  credentials?: ProviderCredentialsSpec;

  // ── Auth lifecycle ────────────────────────────────────────────
  /**
   * Auto-discover available accounts.
   *
   * A bare id is still the answer for a source with nothing more to say — a
   * local store has one account and no platform behind it. A source that knows
   * who the account belongs to returns an {@link AccountDescriptor} instead,
   * so consumers read a declared subject rather than guessing from the id's
   * shape.
   */
  discover?(ctx?: SourceLifecycleContext): Promise<Array<string | AccountDescriptor>>;
  /** Resolve the account for local setup parameters against this host's configured accounts. */
  resolveAccountId?(
    params: Record<string, string>,
    existing: readonly {
      accountId: string;
      params?: Record<string, string>;
    }[],
  ): string | Promise<string>;
  /**
   * Interactive auth flow. Returns the account id for the common
   * single-account flow, or an array when one session registers several
   * accounts at once, each with its own per-account credential. Each returned
   * account is registered independently under the same provider; a scalar
   * return stays back-compatible.
   */
  authFlow?(
    params?: Record<string, string>,
    callbacks?: AuthFlowCallbacks,
    ctx?: SourceLifecycleContext,
  ): Promise<string | string[]>;

  /**
   * Connect an account, asking the operator whatever this platform requires.
   *
   * Replaces {@link authFlow}. The session carries the two primitives a flow
   * needs — put something in front of the operator, or put something in front
   * of them and wait for the answer — so a flow can ask more than once, ask in
   * sequence, and carry its own words rather than relying on a client that
   * knows which platform it is talking about.
   *
   * The call stays resident for the whole exchange, because a pairing that
   * holds a socket or a redirect caught on this machine has nowhere else to
   * live. It returns the accounts it connected, each with the state it left
   * the credential in, and throws {@link AuthFailure} when it did not.
   *
   * A provider declaring both is run through this one.
   */
  authenticate?(session: AuthSession): Promise<AuthResult>;

  /** Clean up stored credentials for an account. */
  cleanupCredentials?(accountId: string, ctx?: SourceLifecycleContext): Promise<void>;

  // ── Factory ───────────────────────────────────────────────────
  /**
   * Create a live source instance for the given account.
   * This replaces the Provider class + setup function.
   *
   * Receives pre-composed `sourceId` and `providerId` in options — pass them
   * directly to your normalizer without manual composition.
   */
  /**
   * Create a live instance for one account.
   *
   * Optional only for a source that declares `execution: "external"`, which
   * nothing here drives. Required for every other source, and `defineSource`
   * refuses one that omits it — the same shape `authType` uses, because the
   * type cannot express "required unless a sibling field says otherwise"
   * without making every other source pay for it.
   */
  create?(options: CreateOptionsFor<TFields>): Promise<SourceInstance<TCursor>>;
}

// ---------------------------------------------------------------------------
// Source entry within a provider definition
// ---------------------------------------------------------------------------

/** A source entry within a multi-source ProviderDefinition. */
export interface ProviderSourceEntry<
  TContext = unknown,
  TCursor extends SyncCursor = SyncCursor,
  TState extends SourceState = SourceState,
  TFields extends Record<string, ConfigField> = NoConfigFields,
> {
  id: string;
  name: string;
  description: string;
  /**
   * See `SourceDefinition.experimental`. Set per-source within a provider to
   * mark one source experimental without hiding its siblings — when omitted the
   * source inherits the provider-level `ProviderDefinition.experimental` flag.
   * Use this when a multi-source provider ships a shipped, non-experimental
   * source alongside a new, not-yet-battle-tested one.
   */
  experimental?: boolean;
  /**
   * See `SourceDefinition.contract`. Declared per source entry, because two
   * sources sharing one account still persist unrelated state and evolve their
   * output independently — a Gmail history id and a Calendar sync token have
   * nothing to say to each other.
   */
  contract?: SourceContractDeclaration<TState>;
  unitName?: string;
  /** See `SourceDescriptor.primaryCount`. */
  primaryCount?: "documents" | "analytics";
  /** See `SourceDescriptor.gatewayHosted`. */
  gatewayHosted?: boolean;
  icon?: SourceIcon;
  /** See `SourceDefinition.attribution`. */
  attribution?: SourceAttribution;
  urlPatterns?: Array<{ regex: string; idGroup?: number }>;
  /** See `SourceDefinition.ownedWebDomains`. */
  ownedWebDomains?: string[];
  /** See `SourceDefinition.urlCanonicalizer`. */
  urlCanonicalizer?: UrlCanonicalizerSpec;
  /** See `SourceDefinition.defaultSourcePrior`. */
  defaultSourcePrior?: number;
  /** See `SourceDefinition.urlHub`. */
  urlHub?: boolean;
  /** See `SourceDefinition.urlTargetRole`. */
  urlTargetRole?: "fallback" | "reference";
  /** See `SourceDefinition.conversational`. Set per-source within a provider. */
  conversational?: boolean;
  /** See `SourceDefinition.selfIdentity`. Set per-source within a provider. */
  selfIdentity?: SelfIdentitySpec;
  /**
   * Who runs this source. Defaults to `"pull"` — the host does.
   *
   * A source whose documents arrive at the gateway from elsewhere declares
   * `"external"` and no factory: nothing here drives it, and there is nothing
   * for a factory to return. See {@link ExecutionMode}.
   */
  execution?: ExecutionMode;

  /**
   * @deprecated Declare `execution: "external"`. This asked the same
   * question and only its two answers were ever given.
   */
  pushBased?: boolean;
  /** See `SourceDescriptor.contentRetention`. */
  contentRetention?: "complete" | "best-effort";
  /**
   * This source's configuration, declared once.
   *
   * The parsed type reaches `create()` as `options.config`, the serialisable
   * form is derived for every client, and one validator runs at both. When
   * present, `params` is derived from it — declare one or the other, never
   * both.
   */
  config?: ConfigSchema<TFields>;
  params?: SourceParam[];
  /** See `SourceDefinition.historyImport`. */
  historyImport?: HistoryImportSpec;
  analyticsSchemas?: AnalyticsTableSchema[];
  /** See `SourceDefinition.documentTemporalProjections`. */
  documentTemporalProjections?: DocumentTemporalProjectionSpec[];
  /** See `SourceDefinition.documentEventProfile`. */
  documentEventProfile?: DocumentEventProfile;
  /** See SourceDefinition.defaultSyncInterval. */
  defaultSyncInterval?: string;
  /**
   * Per-source platform override within a provider. When unset, the source
   * inherits `ProviderDefinition.supportedPlatforms`. Use for the rare case
   * where one source in a provider supports a narrower set of OSes than its
   * siblings.
   */
  supportedPlatforms?: SourcePlatform[];

  /**
   * See `SourceDefinition.singleInstance`. Per-source override within a
   * provider; when unset the source inherits
   * `ProviderDefinition.singleInstance`. Use when one source under a provider
   * reads a single local artifact while its siblings are multi-account.
   */
  singleInstance?: boolean;
  /**
   * See `SourceDefinition.multiDevice`. Per-source override within a
   * provider; when unset the source inherits `ProviderDefinition.multiDevice`.
   */
  multiDevice?: SourceMultiDeviceContract;

  /**
   * Per-source account discovery within a multi-source provider. This narrows
   * the accounts returned by `ProviderDefinition.discover`; the provider must
   * define that parent hook. When unset, the source inherits provider
   * discovery. Use this when sibling sources depend on different host-local
   * stores and the presence of one store does not prove another is available.
   */
  discover?(ctx?: SourceLifecycleContext): Promise<string[]>;

  /** Create a live instance. Optional only for externally driven sources. */
  create?(options: CreateOptionsFor<TFields>, context: TContext): Promise<SourceInstance<TCursor>>;
}

// ---------------------------------------------------------------------------
// Provider definition (multi-source packages)
// ---------------------------------------------------------------------------

/**
 * Definition for a multi-source package (e.g. Google, Apple).
 * Sources share authentication via a context object created by `createContext()`.
 *
 * @typeParam TContext - Shared context type (e.g. OAuth client, DB handles).
 *
 * @example
 * ```typescript
 * export default defineProvider<GoogleContext>({
 *   provider: { id: "google", name: "Google" },
 *   authType: "oauth",
 *   createContext: async ({ accountId }) => loadOAuth(accountId),
 *   sources: [
 *     { id: "gmail", name: "Gmail", description: "...", create: async (opts, ctx) => ({ ... }) },
 *   ],
 * });
 * ```
 */
export interface ProviderDefinition<TContext = unknown> {
  readonly type: "provider";

  // ── Metadata ──────────────────────────────────────────────────
  provider: { id: string; name: string };
  /**
   * See `SourceDefinition.contract`. Declared at provider level for the parts
   * that belong to the package as a whole — the authoring generation it is
   * written against, and the host capabilities every source under it needs.
   * Each source entry declares its own `state` and `outputRevision`.
   */
  contract?: SourceContractDeclaration;
  authType: AuthType;
  /** See `SourceDefinition.acceptsAuthCode`. Applies to every source under this provider. */
  acceptsAuthCode?: boolean;
  /**
   * See `SourceDefinition.experimental`. The default for every source under
   * this provider; an individual entry can override it via its own
   * `ProviderSourceEntry.experimental` (e.g. one experimental source beside a
   * shipped one).
   */
  experimental?: boolean;
  /**
   * See `SourceDefinition.widgetOrigins`. Declared at the provider level — the
   * hosted-widget SDK (Plaid Link, …) is shared across every source under this
   * provider, so the origins it needs are too. Copied onto each source's
   * descriptor at registration time.
   */
  widgetOrigins?: WidgetOrigins;

  /**
   * See `SourceDefinition.widgetRenderer`. Declared at the provider level
   * because a hosted-widget renderer is shared by every source under the same
   * provider auth flow.
   */
  widgetRenderer?: WidgetRendererSpec;

  /**
   * Operating systems this provider's sources support, applied as the
   * default for every source entry. Individual entries can narrow it
   * further via their own `supportedPlatforms`. Undefined means the
   * provider is cross-platform.
   */
  supportedPlatforms?: SourcePlatform[];

  /**
   * See `SourceDefinition.singleInstance`. Declared at the provider level
   * because single-instance-ness follows the provider's authentication and
   * credential-storage model — a provider that reads one local database, or
   * that stores its account credential in a single shared file, admits exactly
   * one instance for all of its sources. Applied as the default for every
   * source entry; an entry can override it via its own `singleInstance`.
   */
  singleInstance?: boolean;
  /**
   * See `SourceDefinition.multiDevice`. Declared at the provider level as
   * the default for every source entry (the mode usually follows where the
   * provider's data lives); an entry can override it.
   */
  multiDevice?: SourceMultiDeviceContract;

  /**
   * OAuth credentials spec — set on providers that need user-supplied
   * (or overridable) OAuth credentials. Inherited by every source under
   * this provider so each source descriptor surfaces the wizard.
   */
  credentials?: ProviderCredentialsSpec;

  // ── Auth lifecycle (shared across all sources) ────────────────
  /** See `SourceDefinition.discover`. */
  discover?(ctx?: SourceLifecycleContext): Promise<Array<string | AccountDescriptor>>;
  /**
   * Interactive auth flow. Returns the account id, or an array when one
   * session registers several accounts at once, each with its own per-account
   * credential. A scalar return stays back-compatible.
   */
  authFlow?(
    params?: Record<string, string>,
    callbacks?: AuthFlowCallbacks,
    ctx?: SourceLifecycleContext,
  ): Promise<string | string[]>;

  /**
   * Connect an account, asking the operator whatever this platform requires.
   *
   * Replaces {@link authFlow}. The session carries the two primitives a flow
   * needs — put something in front of the operator, or put something in front
   * of them and wait for the answer — so a flow can ask more than once, ask in
   * sequence, and carry its own words rather than relying on a client that
   * knows which platform it is talking about.
   *
   * The call stays resident for the whole exchange, because a pairing that
   * holds a socket or a redirect caught on this machine has nowhere else to
   * live. It returns the accounts it connected, each with the state it left
   * the credential in, and throws {@link AuthFailure} when it did not.
   *
   * A provider declaring both is run through this one.
   */
  authenticate?(session: AuthSession): Promise<AuthResult>;

  cleanupCredentials?(accountId: string, ctx?: SourceLifecycleContext): Promise<void>;

  // ── Shared context ────────────────────────────────────────────
  /**
   * Create shared state (e.g. an authenticated upstream client) for every
   * source under this account.
   *
   * Receives an account-scoped {@link ProviderHost}: no analytics access,
   * because tables belong to sources and two sources under one account own
   * different ones.
   */
  createContext?(options: ProviderContextOptions): Promise<TContext>;
  /** Clean up shared context (e.g. revoke tokens, close connections). */
  disposeContext?(context: TContext): Promise<void>;

  /**
   * What state this account's credential is in.
   *
   * Read before every sync round. A state that blocks parks every source under
   * the account and pushes a re-authentication reminder, so the prohibition
   * matters: answer from what is stored, never from a request. A provider that
   * answered by calling its upstream would turn every outage into a false
   * revocation, and prompt the operator to renew a credential that was fine. A credential with a known deadline stays `connected` and names the
   * deadline, so a host can warn before it lapses instead of discovering it
   * afterwards. A grant that is alive but too narrow is neither connected nor
   * broken. And a credential that cannot be read — a locked keyring, an
   * unmounted volume — is `unknown`, which is a failure to answer rather than
   * an answer, and does not park anything.
   *
   */
  credentialState?(context: TContext): Promise<ConnectionState>;

  // ── Sources ───────────────────────────────────────────────────
  sources: ProviderSourceEntry<TContext>[];
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type SourceOrProviderDefinition = SourceDefinition | ProviderDefinition;

// ---------------------------------------------------------------------------
// Resolve provider info
// ---------------------------------------------------------------------------

/** Resolve provider info from a definition, applying defaults for defineSource. */
export function resolveProvider(def: SourceOrProviderDefinition): { id: string; name: string } {
  if (def.type === "provider") return def.provider;
  return def.provider ?? { id: def.id, name: def.name };
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * The member-scoped settings a definition declares, advanced ones included.
 *
 * `compileParams` produces what a form renders and so leaves advanced settings
 * out. The member-config contract needs the whole declaration — see
 * `SourceDescriptor.memberScopedParamNames`.
 */
export function memberScopedParamNames(
  def: Pick<SourceDefinition, "params" | "config"> | ProviderSourceEntry,
): string[] {
  // The schema first, deliberately. A definition that declares one also
  // carries a compiled `params` — the form's subset, advanced settings already
  // removed — so reading that first would reproduce the very omission this
  // exists to correct.
  const all =
    (def.config
      ? toSourceParams(def.config, nodePathProbe, { includeAdvanced: true })
      : def.params) ?? [];
  return all.filter((param) => param.scope === "member").map((param) => param.name);
}

function compileParams(
  def: Pick<SourceDefinition, "params" | "config"> | ProviderSourceEntry,
): SourceParam[] | undefined {
  return def.params ?? (def.config ? toSourceParams(def.config, nodePathProbe) : undefined);
}

function validateLocalAvailabilityParams(
  params: readonly SourceParam[] | undefined,
  owner: string,
  hasDiscovery: boolean,
): void {
  for (const param of params ?? []) {
    if (param.provesLocalAvailabilityForAccount === undefined) continue;
    if (
      param.scope !== "member" ||
      param.type !== "path" ||
      typeof param.validate !== "function" ||
      !hasDiscovery ||
      tryAccountId(param.provesLocalAvailabilityForAccount) === null
    ) {
      throw new Error(
        `${owner}: parameter '${param.name}' with 'provesLocalAvailabilityForAccount' must name an account and be a member-scoped path with validation on a source that supports discovery`,
      );
    }
  }
}

/**
 * Define a single-source package.
 *
 * @typeParam TCursor - Cursor type for type-safe sync state.
 * @throws {Error} if required fields are missing
 */
export function defineSource<
  TCursor extends SyncCursor = SyncCursor,
  TState extends SourceState = SourceState,
  TFields extends Record<string, ConfigField> = NoConfigFields,
>(
  def: Omit<SourceDefinition<TCursor, TState, TFields>, "type">,
): SourceDefinition<TCursor, TState, TFields> {
  // Validation
  if (!def.id) throw new Error("defineSource: 'id' is required");
  if (!def.name) throw new Error("defineSource: 'name' is required");
  if (!def.description) throw new Error("defineSource: 'description' is required");
  if (!def.authType) throw new Error("defineSource: 'authType' is required");
  if (executionModeOf(def) === "pull" && typeof def.create !== "function") {
    throw new Error(
      `defineSource('${def.id}'): a source the host drives needs a 'create'. ` +
        `Declare execution: "external" if nothing here runs it.`,
    );
  }
  if (def.supportedPlatforms && def.supportedPlatforms.length === 0) {
    throw new Error(
      `defineSource('${def.id}'): 'supportedPlatforms' must be undefined (cross-platform) or a non-empty list; an empty array makes the source globally unreachable`,
    );
  }
  const sourceParams = compileParams(def);
  validateLocalAvailabilityParams(sourceParams, `defineSource('${def.id}')`, !!def.discover);
  if (def.analyticsSchemas && def.analyticsSchemas.length > 0) {
    validateAnalyticsSchemaColumnTypes(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateAnalyticsSchemasReserveStreamColumn(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateAnalyticsSchemasHavePrimaryKey(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateAnalyticsDeleteKeys(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateAnalyticsOwnership(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateBoundDocuments(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateRecordCitationContract(def.analyticsSchemas, `defineSource('${def.id}')`);
    validateTemporalProjectionContracts(def.analyticsSchemas, `defineSource('${def.id}')`);
  }
  validateDocumentTemporalProjectionContracts(
    def.documentTemporalProjections,
    `defineSource('${def.id}')`,
  );
  validateDocumentEventProfile(def.documentEventProfile, `defineSource('${def.id}')`);
  validateContractDeclaration(def.contract, `defineSource('${def.id}')`);
  if (def.config && def.params && !isDerivedFromSchema(def.params)) {
    throw new Error(
      `defineSource('${def.id}'): declares both 'config' and 'params'. The form is derived from the ` +
        `schema, so declaring both means two statements of the same fact that nothing keeps in step.`,
    );
  }

  return {
    ...def,
    // Derived, so every client keeps receiving the shape it already renders
    // without the source stating it twice.
    params: sourceParams,
    type: "source" as const,
  };
}

/**
 * Define a multi-source provider package.
 *
 * @typeParam TContext - Shared context type.
 * @throws {Error} if required fields are missing
 */
// Preserve a declared factory on returned entries for factory-bearing providers.
export function defineProvider<TContext>(
  def: Omit<ProviderDefinition<TContext>, "type" | "sources"> & {
    sources: Array<
      ProviderSourceEntry<TContext> & {
        create: NonNullable<ProviderSourceEntry<TContext>["create"]>;
      }
    >;
  },
): Omit<ProviderDefinition<TContext>, "sources"> & {
  sources: Array<
    ProviderSourceEntry<TContext> & {
      create: NonNullable<ProviderSourceEntry<TContext>["create"]>;
    }
  >;
};
export function defineProvider<TContext>(
  def: Omit<ProviderDefinition<TContext>, "type">,
): ProviderDefinition<TContext>;
export function defineProvider<TContext>(
  def: Omit<ProviderDefinition<TContext>, "type">,
): ProviderDefinition<TContext> {
  // Validation
  if (!def.provider?.id) throw new Error("defineProvider: 'provider.id' is required");
  if (!def.provider?.name) throw new Error("defineProvider: 'provider.name' is required");
  if (!def.authType) throw new Error("defineProvider: 'authType' is required");
  if (!def.sources || def.sources.length === 0)
    throw new Error("defineProvider: at least one source is required");
  if (!def.discover && def.sources.some((source) => source.discover)) {
    throw new Error(
      `defineProvider('${def.provider.id}'): a source-level 'discover' hook requires provider-level 'discover' because child discovery only narrows the provider account set`,
    );
  }
  if (def.supportedPlatforms && def.supportedPlatforms.length === 0) {
    throw new Error(
      `defineProvider('${def.provider.id}'): 'supportedPlatforms' must be undefined (cross-platform) or a non-empty list; an empty array makes every child source globally unreachable`,
    );
  }
  validateContractDeclaration(def.contract, `defineProvider('${def.provider.id}')`);
  for (const s of def.sources) {
    if (!s.id) throw new Error(`defineProvider: source 'id' is required`);
    validateContractDeclaration(s.contract, `defineProvider source '${s.id}'`);
    if (s.config && s.params && !isDerivedFromSchema(s.params)) {
      throw new Error(
        `defineProvider: source '${s.id}' declares both 'config' and 'params'. The form is derived ` +
          `from the schema, so declaring both means two statements of the same fact.`,
      );
    }
    if (!s.name) throw new Error(`defineProvider: source '${s.id}' is missing 'name'`);
    if (!s.description)
      throw new Error(`defineProvider: source '${s.id}' is missing 'description'`);
    if (executionModeOf(s) === "pull" && typeof s.create !== "function")
      throw new Error(`defineProvider: source '${s.id}' is missing 'create' function`);
    if (s.supportedPlatforms && s.supportedPlatforms.length === 0) {
      throw new Error(
        `defineProvider: source '${s.id}' has empty 'supportedPlatforms'; use undefined to inherit from the provider or a non-empty list to narrow it`,
      );
    }
    validateLocalAvailabilityParams(
      compileParams(s),
      `defineProvider source '${s.id}'`,
      !!(s.discover ?? def.discover),
    );
    if (s.analyticsSchemas && s.analyticsSchemas.length > 0) {
      validateAnalyticsSchemaColumnTypes(s.analyticsSchemas, `defineProvider source '${s.id}'`);
      validateAnalyticsSchemasReserveStreamColumn(
        s.analyticsSchemas,
        `defineProvider source '${s.id}'`,
      );
      validateAnalyticsSchemasHavePrimaryKey(s.analyticsSchemas, `defineProvider source '${s.id}'`);
      validateAnalyticsDeleteKeys(s.analyticsSchemas, `defineProvider source '${s.id}'`);
      validateAnalyticsOwnership(s.analyticsSchemas, `defineProvider source '${s.id}'`);
      validateBoundDocuments(s.analyticsSchemas, `defineProvider source '${s.id}'`);
      validateRecordCitationContract(s.analyticsSchemas, `defineProvider source '${s.id}'`);
      validateTemporalProjectionContracts(s.analyticsSchemas, `defineProvider source '${s.id}'`);
    }
    validateDocumentTemporalProjectionContracts(
      s.documentTemporalProjections,
      `defineProvider source '${s.id}'`,
    );
    validateDocumentEventProfile(s.documentEventProfile, `defineProvider source '${s.id}'`);
  }

  return {
    ...def,
    // Derived per entry, exactly as `defineSource` does for a single-source
    // package. Without this an entry that declares a schema ships a descriptor
    // with no form: every client renders an empty add dialog and the auth flow
    // refuses for missing values nobody was asked for.
    sources: def.sources.map((s) => ({
      ...s,
      params: compileParams(s),
    })),
    type: "provider" as const,
  };
}

/**
 * Define a structured (analytics) source.
 * Like `defineSource()` but:
 * - `analyticsSchemas` is required
 * - The returned instance must have `syncStructured()` and `analyticsSchemas`
 * - A no-op `sync()` is automatically provided if the instance doesn't include one
 *
 * @typeParam TCursor - Cursor type for type-safe sync state.
 * @throws {Error} if required fields are missing
 */
export function defineStructuredSource<
  TCursor extends SyncCursor = SyncCursor,
  TState extends SourceState = SourceState,
  TFields extends Record<string, ConfigField> = NoConfigFields,
>(
  def: Omit<SourceDefinition<TCursor, TState, TFields>, "type" | "analyticsSchemas" | "create"> & {
    analyticsSchemas: AnalyticsTableSchema[];
    /**
     * Optional only for `execution: "external"`; see `SourceDefinition.create`.
     * The runtime check below refuses a driven source that omits it.
     */
    create?(options: CreateOptionsFor<TFields>): Promise<
      Omit<SourceInstance<TCursor>, "sync"> & {
        // `opts` is re-declared here, not just on SourceInstance: a narrower
        // signature in this position is the CONTEXTUAL type for the
        // implementation, so omitting it would reject a structured source that
        // wants to read the abort signal ("Target signature provides too few
        // arguments"). Both remain optional to implement.
        syncStructured(
          cursor: TCursor | null,
          opts?: SyncOptions,
        ): Promise<StructuredSyncResult<TCursor>>;
        analyticsSchemas: AnalyticsTableSchema[];
        sync?(cursor: TCursor | null, opts?: SyncOptions): Promise<SyncResult<TCursor>>;
      }
    >;
  },
): SourceDefinition<TCursor, TState, TFields> {
  // Validation
  if (!def.id) throw new Error("defineStructuredSource: 'id' is required");
  if (!def.name) throw new Error("defineStructuredSource: 'name' is required");
  if (!def.description) throw new Error("defineStructuredSource: 'description' is required");
  if (!def.authType) throw new Error("defineStructuredSource: 'authType' is required");
  if (!def.analyticsSchemas || def.analyticsSchemas.length === 0) {
    throw new Error("defineStructuredSource: 'analyticsSchemas' is required and must not be empty");
  }
  if (def.supportedPlatforms && def.supportedPlatforms.length === 0) {
    throw new Error(
      `defineStructuredSource('${def.id}'): 'supportedPlatforms' must be undefined (cross-platform) or a non-empty list; an empty array makes the source globally unreachable`,
    );
  }
  const structuredParams = compileParams(def);
  validateLocalAvailabilityParams(
    structuredParams,
    `defineStructuredSource('${def.id}')`,
    !!def.discover,
  );
  validateAnalyticsSchemasHavePrimaryKey(
    def.analyticsSchemas,
    `defineStructuredSource('${def.id}')`,
  );
  validateAnalyticsDeleteKeys(def.analyticsSchemas, `defineStructuredSource('${def.id}')`);
  validateAnalyticsOwnership(def.analyticsSchemas, `defineStructuredSource('${def.id}')`);
  validateAnalyticsSchemaColumnTypes(def.analyticsSchemas, `defineStructuredSource('${def.id}')`);
  validateAnalyticsSchemasReserveStreamColumn(
    def.analyticsSchemas,
    `defineStructuredSource('${def.id}')`,
  );
  validateBoundDocuments(def.analyticsSchemas, `defineStructuredSource('${def.id}')`);
  validateRecordCitationContract(def.analyticsSchemas, `defineStructuredSource('${def.id}')`);
  validateTemporalProjectionContracts(def.analyticsSchemas, `defineStructuredSource('${def.id}')`);
  validateDocumentTemporalProjectionContracts(
    def.documentTemporalProjections,
    `defineStructuredSource('${def.id}')`,
  );
  validateDocumentEventProfile(def.documentEventProfile, `defineStructuredSource('${def.id}')`);
  validateContractDeclaration(def.contract, `defineStructuredSource('${def.id}')`);
  if (executionModeOf(def) === "pull" && typeof def.create !== "function") {
    throw new Error(
      `defineStructuredSource('${def.id}'): a source the host drives needs a 'create'. ` +
        `Declare execution: "external" if nothing here runs it.`,
    );
  }

  // Wrap create to provide default no-op sync if missing. Absent entirely for
  // an external source, which is never instantiated — there is nothing to wrap
  // and nothing that would call it.
  const originalCreate = def.create;
  const wrappedCreate = originalCreate
    ? async (options: CreateOptionsFor<TFields>): Promise<SourceInstance<TCursor>> => {
        const instance = await originalCreate(options);
        return {
          ...instance,
          sync: instance.sync ?? (() => Promise.resolve(emptySync<TCursor>())),
        };
      }
    : undefined;

  if (def.config && def.params && !isDerivedFromSchema(def.params)) {
    throw new Error(
      `defineStructuredSource('${def.id}'): declares both 'config' and 'params'. The form is derived ` +
        `from the schema, so declaring both means two statements of the same fact.`,
    );
  }

  return {
    ...def,
    create: wrappedCreate,
    // Derived, exactly as the other two helpers do. Without it a structured
    // source declaring a schema ships a descriptor with no form at all, while
    // its instantiation is still gated on values no client ever asked for.
    params: structuredParams,
    type: "source" as const,
  };
}
