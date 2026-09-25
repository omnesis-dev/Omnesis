// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Coinbase twin (#754).
 *
 * Spreads the REAL Coinbase provider descriptor (icon, name, schemas, cursor
 * validator, unit noun) and overrides only the auth lifecycle and `create()`.
 * The override builds the REAL `CoinbaseSnapshotSource` driven by a REAL
 * `CoinbaseClient` whose HTTP layer is the synthetic fetch — so the synth path
 * runs the production phase machine, normalizer, keying, watermarks, idempotent
 * upserts, and graceful-degrade ledger unchanged. The only thing replaced is
 * the network and the auth handshake.
 *
 * `now` is pinned so repeated synth syncs write the same UTC snapshot date and
 * are therefore byte-stable (every row re-upserts onto the same primary key).
 */

import realCoinbase, {
  allSchemas,
  CoinbaseSnapshotSource,
  validateCoinbaseCursor,
} from "@omnesis/provider-coinbase";
import { defineProvider, emptySync } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  selfAccountId,
} from "@omnesis/providers-synth-common";
import { activeResponses, COINBASE_DESCRIPTOR_ID, syntheticCoinbaseClient } from "./fixtures.js";

const { type: _type, ...rest } = realCoinbase;

// The portfolio slug comes from the cast like every other synth identity, so
// the universe manifest, discover(), and the fixtures all agree on the
// source-id suffix.
const accountId = selfAccountId("extra", "coinbaseAccountId");

/**
 * Default UTC day the snapshot phases write to — repeated synth syncs re-emit
 * the same balances/holdings snapshot rows byte-stably (same PK, overwrite not
 * append), so a re-sync on the same day is exactly idempotent.
 */
const DEFAULT_SYNTH_DAY = "2025-12-31";

/**
 * Snapshot clock. Defaults to {@link DEFAULT_SYNTH_DAY}; an E2E can override the
 * day via `OMNESIS_COINBASE_SYNTH_DAY=YYYY-MM-DD` to drive a second snapshot and
 * prove net-worth-over-time accumulates a new day (point-in-time history is
 * retained, not overwritten). Read per-call so a test can change it between
 * syncs of the same gateway process.
 */
function synthNow(): Date {
  const day = process.env.OMNESIS_COINBASE_SYNTH_DAY ?? DEFAULT_SYNTH_DAY;
  return new Date(`${day}T12:00:00.000Z`);
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "api-key",
  credentials: undefined,
  supportedPlatforms: undefined,
  discover: async () => preDiscoveredAccounts(COINBASE_DESCRIPTOR_ID, [accountId]),
  // An api-key source has no browser leg — a local pair shim stands in.
  authFlow: async () => fakeLocalFlow(COINBASE_DESCRIPTOR_ID, accountId),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  // A double drives its own cursor, which the real source's decoder does not
  // know. Inheriting the declaration would refuse that cursor on the tick
  // after the first one and park the source.
  contract: undefined,
  cleanupCredentials: undefined,
  createContext: async () => ({}),
  // A synthetic double has no credential to be in a state about, and says so
  // outright: the real provider's declaration would otherwise leak through
  // the spread above with a context type this double does not have.
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  sources: rest.sources.map((s) => ({
    ...s,
    // The double drives its own cursor; the real source's decoder does not
    // know it. Inheriting the declaration refuses that cursor on the next tick.
    contract: undefined,
    analyticsSchemas: allSchemas,
    async create({ sourceId, providerId, accountId: sourceAccountId }) {
      // A REAL CoinbaseSnapshotSource over the canned fixture corpus — the synth
      // path differs from production only in its network and auth handshake.
      const source = new CoinbaseSnapshotSource(
        syntheticCoinbaseClient(activeResponses()),
        providerId,
        sourceId,
        sourceAccountId,
        sourceAccountId,
        { now: synthNow },
      );
      return {
        sync: () => Promise.resolve(emptySync()),
        syncStructured: (cursor) => source.syncStructured(validateCoinbaseCursor(cursor)),
        analyticsSchemas: allSchemas,
      };
    },
  })),
});
