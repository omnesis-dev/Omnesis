// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wraps-real WhatsApp synth path.
 *
 * Unlike the default synth twin — which renders pre-baked day-doc fixtures and
 * BYPASSES the real provider — this path drives the **real** `WhatsAppProvider`
 * (real durable `store.db`, the tri-state history-seal state machine, the
 * backfill / day-doc deepening) end-to-end. It injects a `FakeWhatsAppServer`
 * (seeded from the universe's `fake-corpus.json`) through the provider's
 * existing `SocketFactory` seam, then runs the exact production `create()`
 * choreography: `authenticate()` (connect) + the initial history push. The
 * returned `SourceInstance` is the real one — there are ZERO test-only branches
 * inside the real provider; all the test-shaped wiring lives here.
 *
 * The real provider needs a writable home for its `store.db` + Baileys auth
 * state; it reads it from `CreateOptions.configDir`. A gateway-
 * level E2E (`SyntheticE2EHarness`) sets `configDir` to its isolated temp dir.
 *
 * Backfill is driven out-of-band: the universe scenario may declare a `backfill`
 * batch of deeper (older) messages. The test reaches the per-source controller
 * via {@link getWhatsAppWrapsRealController} and calls `pushBackfill()` to stream
 * those messages into the live store after the first sync — the store re-marks
 * the affected days dirty and the next sync re-emits the deepened day-docs.
 */

import { createLogger, resolveAttachmentConfig } from "@omnesis/core";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import { WhatsAppProvider, WhatsAppMessagesSource } from "@omnesis/provider-whatsapp";
import { FakeWhatsAppServer } from "@omnesis/provider-whatsapp/testing";
import type { FakeCorpus, PushHistoryOptions } from "@omnesis/provider-whatsapp/testing";
import type { CreateOptions, SourceInstance } from "@omnesis/source-sdk";

const log = createLogger("provider:whatsapp-synth").child("wraps-real");

// ── Fixture schema (sources/whatsapp-messages/fake-corpus.json) ──────────────

/**
 * The universe fixture that opts WhatsApp into the wraps-real path. It carries
 * the {@link FakeCorpus} the `FakeWhatsAppServer` replays plus a `scenario`
 * directive describing how the server terminates the initial push (which drives
 * the history-seal outcome) and, optionally, a deeper `backfill` batch.
 */
export interface WhatsAppFakeCorpusFixture {
  /** The server-side corpus the fake replays through the real provider. */
  corpus: FakeCorpus;
  scenario: {
    /**
     * Seal outcome of the initial history push:
     * - `complete`: terminate `isLatest` → store seals `complete` (coverage
     *   reports `complete`).
     * - `interrupted`: terminate `paused` after deep batches → store seals
     *   `interrupted` synchronously (coverage reports `partial`).
     */
    mode: "complete" | "interrupted";
    /**
     * Most-recent N messages per chat delivered in the INITIAL push. A shallow
     * initial depth models the recent-window slice WhatsApp streams a fresh
     * companion; the `backfill` then deepens those days with older messages.
     * Omit for "all".
     */
    initialDepth?: number;
    /**
     * Messages-per-batch for the initial push. Defaults to the fake's 50.
     */
    chunkSize?: number;
    /**
     * Optional deeper history streamed later via `pushBackfill()`. When present,
     * a second push (full depth) re-streams the corpus so days already emitted
     * gain their older messages — the day-doc deepening. The controller
     * exposes `pushBackfill()`; the test calls it between syncs.
     */
    backfill?: {
      /** Most-recent N messages per chat in the backfill push (default: all). */
      depth?: number;
    };
  };
}

const FIXTURE_FILE = "fake-corpus.json";

/** True when the active universe ships a wraps-real `fake-corpus.json`. */
export function universeHasFakeCorpus(): boolean {
  try {
    loadFakeCorpusFixture();
    return true;
  } catch {
    return false;
  }
}

let cachedFixture: WhatsAppFakeCorpusFixture | null = null;

/** Load + cache the active universe's wraps-real fixture. */
function loadFakeCorpusFixture(): WhatsAppFakeCorpusFixture {
  if (cachedFixture) return cachedFixture;
  cachedFixture = loadSourceFixtureJson<WhatsAppFakeCorpusFixture>(
    loadActiveUniverse(),
    "whatsapp-messages",
    FIXTURE_FILE,
  );
  return cachedFixture;
}

// ── Per-source controller registry (test side-channel) ───────────────────────

/**
 * Handle the test reaches to drive backfill on a live wraps-real source. Kept
 * out of the `SourceInstance` interface so the contract stays clean — the twin
 * is test-only infrastructure, so a module-level registry is the right seam.
 */
export interface WhatsAppWrapsRealController {
  /** The injected fake server (assertion records, manual driving). */
  fake: FakeWhatsAppServer;
  /** The live real provider (durable store, seal state). */
  provider: WhatsAppProvider;
  /**
   * Stream the scenario's deeper history into the live store. No-op (returns
   * false) when the scenario declares no `backfill`. The store re-marks the
   * affected days dirty so the next sync re-emits the deepened day-docs.
   */
  pushBackfill(): boolean;
}

const controllers = new Map<string, WhatsAppWrapsRealController>();

/** Look up the controller for a fully-qualified `whatsapp-messages:<account>` source id. */
export function getWhatsAppWrapsRealController(
  sourceId: string,
): WhatsAppWrapsRealController | undefined {
  return controllers.get(sourceId);
}

// ── The wraps-real create() ──────────────────────────────────────────────────

/**
 * Build a wraps-real `SourceInstance`: instantiate the real provider against a
 * `FakeWhatsAppServer` seeded from the universe, run the production connect +
 * initial-history choreography, and return the real source's instance.
 */
export async function createWrapsRealWhatsApp(opts: CreateOptions): Promise<SourceInstance> {
  const { accountId, sourceId, configDir, sourceConfig, dataCutoff, extractAttachment } = opts;
  if (!configDir) {
    // The real provider keeps a durable store.db; without a writable home it
    // would fall back to DEFAULT_CONFIG_DIR and clobber the operator's data.
    throw new Error(
      "wraps-real WhatsApp twin requires CreateOptions.configDir — the harness must thread the collector config dir.",
    );
  }

  const fixture = loadFakeCorpusFixture();
  const { corpus, scenario } = fixture;

  // The injected fake supplies `creds.me.id` directly, so this path skips the
  // real provider's disk-creds `isAuthenticated()` check entirely. The store
  // self-creates its dir under `<configDir>/whatsapp/<account>` on construction.
  const fake = new FakeWhatsAppServer(corpus);
  const provider = new WhatsAppProvider(accountId, configDir, fake.factory);
  await provider.initialize();

  // Drive the production connect choreography. `authenticate()` resolves once
  // the socket emits `connection.update {open}` — register listeners (a
  // microtask) before driving the fake open.
  const authPromise = provider.authenticate();
  await Promise.resolve();
  fake.connect();
  await authPromise;
  log.info(`Connected wraps-real WhatsApp account ${accountId} (mode=${scenario.mode})`);

  // Initial history push. `complete` seals via isLatest; `interrupted` seals
  // synchronously via a `paused` milestone after deep RECENT batches —
  // no quiet-gap wall-clock wait, so the gateway-level E2E stays fast.
  const initialPush: PushHistoryOptions =
    scenario.mode === "complete"
      ? {
          terminate: "isLatest",
          initialDepth: scenario.initialDepth,
          chunkSize: scenario.chunkSize,
          syncType: 3, // RECENT — deep history, mirrors a real recent-window slice
        }
      : {
          terminate: "paused",
          initialDepth: scenario.initialDepth,
          chunkSize: scenario.chunkSize,
          syncType: 3,
        };
  fake.pushInitialHistory(initialPush);
  // Let the synchronous seal resolution settle (the provider's handlers run on
  // emit, so this is just a microtask flush).
  //
  // Note what this means for what the E2E can see: the seal resolves before
  // the source is constructed, so no sync run here ever spans one. The
  // real-world sequence — a run that reports "still arriving" on its early
  // pages and "finished" on a later one, deliberately, because `hasMore` is
  // held open across the history push so the run observes the seal — is
  // therefore not exercised end to end. It is pinned at the provider
  // (`messages.test.ts`) and at the aggregator (`source-lifecycle.test.ts`)
  // instead. An E2E that wanted it would have to push the history after the
  // first sync had started.
  await Promise.resolve();
  log.info(
    `Initial history pushed for ${accountId}: seal=${provider.getStore().historySyncState}, messages=${provider.getStore().totalMessages}`,
  );

  const attachmentConfig = resolveAttachmentConfig(sourceConfig, { defaultEnabled: true });
  const source = new WhatsAppMessagesSource(provider.getStore(), accountId, {
    dataCutoff,
    attachmentConfig,
    extractAttachment,
    downloadMedia: provider.getMediaDownloader(),
    onConnectionError: (handler) => provider.onConnectionError(handler),
  });

  let backfillPushed = false;
  const controller: WhatsAppWrapsRealController = {
    fake,
    provider,
    pushBackfill() {
      if (!scenario.backfill) return false;
      if (backfillPushed) return false;
      backfillPushed = true;
      // Re-stream the corpus at the backfill depth. Days already emitted gain
      // their older messages (the deepening); the store re-marks them
      // dirty. The seal is already complete/interrupted, so this push doesn't
      // re-enter the seal state machine — it just deepens the durable store.
      fake.pushInitialHistory({
        terminate: "bootstrap-only",
        initialDepth: scenario.backfill.depth,
        chunkSize: scenario.chunkSize,
        syncType: 3,
      });
      log.info(
        `Backfill pushed for ${accountId}: messages now ${provider.getStore().totalMessages}`,
      );
      return true;
    },
  };
  controllers.set(String(sourceId), controller);

  return {
    sync: (cursor) => source.sync(cursor),
    onPushEvent: (cb: () => void) => source.onPushEvent(cb),
    onSourceError: (cb: (error: string) => void) => source.onSourceError(cb),
    onResync: () => source.onResync(),
    async dispose() {
      controllers.delete(String(sourceId));
      await provider.disconnect();
    },
  };
}
