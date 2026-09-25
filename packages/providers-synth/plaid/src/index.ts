// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Plaid twin.
 *
 * Spreads the REAL Plaid provider descriptor (icon, name, schemas, cursor
 * validator, unit noun) and overrides only the auth lifecycle and `create()`.
 * The override builds the REAL `PlaidSyncSource` driven by a REAL `PlaidClient`
 * whose HTTP layer is the synthetic fetch — so the synth path runs the
 * production phase machine (transactions → snapshot-balances →
 * snapshot-holdings → incremental), normalizer, keying, composite-PK append-only
 * snapshot upserts, and transactions delta idempotency unchanged. The only
 * thing replaced is the network and the auth handshake (the real source's
 * sign-in happens on a Plaid-hosted page the synth path can't drive).
 *
 * `now` is pinned so repeated synth syncs write the same UTC snapshot date and
 * are therefore byte-stable (every snapshot row re-upserts onto the same
 * composite primary key).
 */

import realPlaid, {
  allSchemas,
  PlaidSyncSource,
  validatePlaidCursor,
} from "@omnesis/provider-plaid";
import { defineProvider, emptySync } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  selfAccountId,
} from "@omnesis/providers-synth-common";
import { PLAID_DESCRIPTOR_ID, activeResponses, syntheticPlaidClient } from "./fixtures.js";

const { type: _type, ...rest } = realPlaid;

// The item id comes from the cast like every other synth identity, so the
// universe manifest, discover(), and the fixtures all agree on the source-id
// suffix.
const accountId = selfAccountId("extra", "plaidItemId");

/**
 * Default UTC day the snapshot phases write to — repeated synth syncs re-emit
 * the same balances/holdings snapshot rows byte-stably (same composite PK,
 * overwrite not append), so a re-sync on the same day is exactly idempotent.
 */
const DEFAULT_SYNTH_DAY = "2026-05-15";

/**
 * Snapshot clock. Defaults to {@link DEFAULT_SYNTH_DAY}; an E2E can override the
 * day via `OMNESIS_PLAID_SYNTH_DAY=YYYY-MM-DD` to drive a second snapshot and
 * prove balance-over-time accumulates a new day (point-in-time history is
 * retained, not overwritten). Read per-call so a test can change it between
 * syncs of the same gateway process.
 */
function synthNow(): Date {
  const day = process.env.OMNESIS_PLAID_SYNTH_DAY ?? DEFAULT_SYNTH_DAY;
  return new Date(`${day}T12:00:00.000Z`);
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "api-key",
  credentials: undefined,
  supportedPlatforms: undefined,
  discover: async () => preDiscoveredAccounts(PLAID_DESCRIPTOR_ID, [accountId]),
  // The real flow sends the user to a Plaid-hosted page — a local pair shim
  // stands in for that browser leg on the synth path.
  authFlow: async () => fakeLocalFlow(PLAID_DESCRIPTOR_ID, accountId),
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
      // A REAL PlaidSyncSource over the canned fixture corpus — the synth path
      // differs from production only in its network and auth handshake.
      const source = new PlaidSyncSource(
        syntheticPlaidClient(activeResponses()),
        providerId,
        sourceId,
        sourceAccountId,
        "access-synthetic-plaid",
        { institutionName: "Northstar Bank", now: synthNow },
      );
      return {
        sync: () => Promise.resolve(emptySync()),
        syncStructured: (cursor, opts) => source.syncStructured(validatePlaidCursor(cursor), opts),
        analyticsSchemas: allSchemas,
      };
    },
  })),
});
