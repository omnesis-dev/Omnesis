// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the host lends a live source.
 *
 * A source needs a handful of things it cannot build for itself: somewhere to
 * keep a durable local store, a logger already named after it, a clock a test
 * can move, the ability to turn an attachment into text. Until now it received
 * those alongside the entire Omnesis configuration, the collector's config
 * directory, and the collector's own gateway client — an interface of roughly
 * forty methods including global search, listing every document in the install,
 * and deleting every document of a provider.
 *
 * ## What the breadth actually cost
 *
 * Not a security hole. In-process code can already reach the filesystem and the
 * network, and no shape of injected object changes that; anyone reasoning about
 * this as a sandbox is reasoning about the wrong thing. What it cost was three
 * concrete things:
 *
 * - **Every internal gateway change became a public API change.** Publishing
 *   `GatewayClient` to source authors froze the collector's transport as
 *   contract.
 * - **A source could act outside itself by accident.** Nothing in the types
 *   distinguished reading your own rows from deleting another provider's.
 * - **Testing a source meant faking a gateway.** A fake host is a handful of
 *   members; a fake gateway is a day's work, so it does not get written.
 *
 * ## Scope is per source, not per provider
 *
 * Two sources sharing one account are still two sources. Each gets its own
 * logger, its own state directory and analytics access scoped to its own
 * tables, so one source's enrichment query cannot read another's rows even
 * under the same login. Account-wide machinery — a refreshed upstream client, a
 * shared request budget — belongs on the provider context, which already
 * exists.
 */

import type { AttachmentExtractFn, AudioTranscribeFn, Logger } from "@omnesis/core";
import type { DocumentIngestionContext } from "@omnesis/types";

/**
 * Read access to the analytics tables *this source declares*.
 *
 * Present only for a source that declares analytics schemas. A documents-only
 * source has no tables, so it has no reason to hold a query handle, and giving
 * it one would be the same mistake at a smaller scale.
 *
 * The narrowing is enforced, not just intended: the host binds the source id
 * to this handle and the gateway derives the readable tables from the catalog
 * rows the source's own schemas created, so a query naming another source's
 * table is refused rather than answered. A source holding this can only hand
 * over SQL; it cannot say whose tables to read.
 *
 * There is deliberately no write method here. Writing is what a sync page is
 * for, and a page can name every table a source fills, so a second way in
 * would only be a way to write outside the checkpoint, the write epoch and the
 * sync lease. Reading is different: it has no such contract to skip, and it is
 * what makes multi-phase enrichment possible at all.
 */
export interface SourceAnalyticsAccess {
  /**
   * Run a read-only query against this source's own tables.
   *
   * This is what makes multi-phase enrichment possible: a source sweeps a
   * listing, then asks which of the rows it already stored still lack their
   * expensive detail, and fetches only those. Without it the alternative is
   * re-walking the whole upstream every cycle, which costs a third-party call
   * per item per cycle forever.
   *
   * The query may name only tables this source declares — its own, and any it
   * shares with a sibling source of the same type. Naming another source's
   * table is an error, and so is anything that is not a single SELECT.
   */
  query(
    sql: string,
    opts?: { limit?: number },
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
}

/**
 * The services shared by everything under one account.
 *
 * This is what a provider's `createContext` receives. It deliberately has no
 * analytics access: a provider context has no tables of its own, because
 * tables belong to sources, and two sources under one account own different
 * ones.
 */
export interface ProviderHost {
  /** A logger already named for this source. */
  readonly log: Logger;

  /**
   * The current time.
   *
   * Injected rather than read from the global clock so a test can drive a
   * source's own time-based behaviour — a backoff window, a day boundary, a
   * staleness check — without waiting for it or stubbing a global.
   */
  now(): Date;

  /**
   * A directory scoped to this provider and account, for a durable local
   * store.
   *
   * A source joins filenames to it rather than re-deriving a path. It is
   * created before it is handed over, and sources under one account share it.
   *
   * It is **not** guaranteed to be a provider's credential directory. Most
   * providers root credentials at exactly this path, but the key is a
   * provider's own choice and need not match the id it declares — one package
   * in the tree stores credentials under a different name from its id, so
   * substituting this for that path would point it at a directory that does
   * not exist while discovery kept finding the account under the old one. A
   * provider with its own layout keeps using {@link configDir} and its own
   * segment; anything genuinely new belongs here.
   */
  readonly stateDir: string;

  /**
   * The collector's configuration root.
   *
   * Present because credential layouts are addressed from it and moving them
   * would be a migration with no benefit. Prefer {@link stateDir} for anything
   * a source owns outright.
   */
  readonly configDir: string;

  /** Locale and region captured from the device, for parsing locale-dependent text. */
  readonly ingestion?: DocumentIngestionContext;
  /** Turn attachment bytes into text, when the host can. */
  readonly extractAttachment?: AttachmentExtractFn;
}

/**
 * The services a live source instance is given.
 *
 * Everything here is scoped to one configured source. Nothing on it can reach
 * another source's data, the whole configuration, or any administrative
 * operation.
 */
export interface SourceHost extends ProviderHost {
  /**
   * Transcribe audio inline, for a conversational source when the host has
   * speech-to-text enabled. A document source receives nothing here: its audio
   * flows through the attachment pipeline as a child document instead.
   *
   * Source-scoped rather than account-scoped, because the routing depends on
   * whether *this* source is conversational. A provider context has no source
   * to route for, so it is not offered a value it would have to guess at.
   */
  readonly transcribeAudio?: AudioTranscribeFn;

  /**
   * Whether audio types join this source's attachment allow-list. True only
   * for a document source with speech-to-text enabled; a conversational source
   * handles audio inline through {@link transcribeAudio}. The two are mutually
   * exclusive by construction.
   */
  readonly includeAudioTypes: boolean;

  /** Analytics access, for a source that declares tables. */
  readonly analytics?: SourceAnalyticsAccess;
}
