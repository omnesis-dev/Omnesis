// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { PlaidSyncSource } from "./sync.js";
import { plaidStateSpec } from "./state.js";
import type { LinkTokenCreateParams, PlaidTransport, TransactionsSyncParams } from "./client.js";
import type {
  PlaidAccountsGetResponse,
  PlaidInstitutionGetByIdResponse,
  PlaidLinkTokenGetResponse,
  PlaidInvestmentsHoldingsGetResponse,
  PlaidTransactionsSyncResponse,
} from "./schemas.js";
import type { PlaidCursor } from "./types.js";

const PROVIDER_ID = ProviderId("plaid:item-1");
const SOURCE_ID = SourceId("plaid:item-1");
const ITEM_ID = "item-1";
const ACCESS_TOKEN = "access-sandbox-1";
const DAY = "2026-05-15";

/** A transport implementing every leg the phase machine can reach in these tests. */
class FakeTransport implements PlaidTransport {
  syncCalls: TransactionsSyncParams[] = [];

  accountsGet(): Promise<PlaidAccountsGetResponse> {
    return Promise.resolve({ accounts: [] });
  }
  investmentsHoldingsGet(): Promise<PlaidInvestmentsHoldingsGetResponse> {
    return Promise.resolve({ holdings: [], securities: [] });
  }
  transactionsSync(params: TransactionsSyncParams): Promise<PlaidTransactionsSyncResponse> {
    this.syncCalls.push({ ...params });
    return Promise.resolve({
      added: [],
      modified: [],
      removed: [],
      next_cursor: "cursor-end",
      has_more: false,
    });
  }
  linkTokenCreate(_p: LinkTokenCreateParams): Promise<never> {
    throw new Error("not used");
  }
  linkTokenGet(): Promise<PlaidLinkTokenGetResponse> {
    throw new Error("not used");
  }
  institutionGetById(): Promise<PlaidInstitutionGetByIdResponse> {
    throw new Error("not used");
  }
  itemPublicTokenExchange(): Promise<never> {
    throw new Error("not used");
  }
  itemGet(): Promise<{ item: { item_id: string; consent_expiration_time?: string | null } }> {
    return Promise.resolve({ item: { item_id: ITEM_ID, consent_expiration_time: null } });
  }
  itemRemove(): Promise<never> {
    throw new Error("not used");
  }
}

function versionedInstance(transport: FakeTransport): SourceInstance & {
  outcomes: () => StateOutcome[];
} {
  const source = new PlaidSyncSource(transport, PROVIDER_ID, SOURCE_ID, ITEM_ID, ACCESS_TOKEN, {
    institutionName: "example bank",
    now: () => new Date(`${DAY}T12:00:00.000Z`),
  });
  const instance: SourceInstance = {
    sync: () => {
      throw new Error("sync not expected — this source is structured-only");
    },
    syncStructured: (cursor) => source.syncStructured(cursor as PlaidCursor | null),
  };
  const outcomes: StateOutcome[] = [];
  const versioned = withVersionedState(instance, plaidStateSpec, {
    sourceId: "plaid:item-1",
    onResolve: (outcome) => outcomes.push(outcome),
  });
  return Object.assign(versioned, { outcomes: () => outcomes });
}

describe("Plaid — declared state", () => {
  test("resumes a mid-`transactions` delta, not just a settled cursor", async () => {
    // Mid-delta: a transactions cursor already advanced from a prior page,
    // snapshot bookkeeping untouched. `decode` must accept this partial
    // shape, not only the settled `incremental` one.
    const midDeltaCursor: PlaidCursor = {
      phase: "transactions",
      transactionsCursor: "cursor-mid-1",
      lastSnapshotDate: DAY,
    };
    const transport = new FakeTransport();
    const instance = versionedInstance(transport);

    const result = await instance.syncStructured!(midDeltaCursor);

    expect(instance.outcomes()[0]?.kind).toBe("resume");
    expect(transport.syncCalls[0]?.cursor).toBe("cursor-mid-1");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("rebootstraps rather than crashing on a phase this build no longer recognises", async () => {
    // Stands in for a retired or renamed phase from an older release. Plaid's
    // own `INVALID_CURSOR` handling in transactions.ts already rebuilds a
    // walk this way for a narrower reason; a lost cursor takes the same path,
    // just from the phase machine's start — now a named, logged outcome
    // instead of being indistinguishable from a genuine first run.
    const retiredPhaseCursor = { phase: "gear-refresh" };
    const transport = new FakeTransport();
    const instance = versionedInstance(transport);

    const result = await instance.syncStructured!(retiredPhaseCursor as unknown as PlaidCursor);

    expect(instance.outcomes()[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("round-trips a settled `incremental` cursor as an envelope", async () => {
    const settledCursor: PlaidCursor = { phase: "incremental", lastSnapshotDate: DAY };
    const transport = new FakeTransport();
    const instance = versionedInstance(transport);

    const result = await instance.syncStructured!(settledCursor);

    expect(instance.outcomes()[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});

describe("plaidStateSpec.decode — the fields a run actually writes", () => {
  /** A settled cursor carrying every field the phase machine can persist. */
  const full = {
    phase: "transactions",
    transactionsCursor: "c2",
    loopStartCursor: "c1",
    snapshotDate: "2026-05-15",
    lastSnapshotDate: "2026-05-14",
    backfillWaitSince: "2026-05-15T12:00:00Z",
    paginationRestarts: 2,
  };

  test("accepts a cursor carrying every field", () => {
    expect(plaidStateSpec.decode(full)).toEqual(full);
  });

  test.each([
    ["loopStartCursor", { ...full, loopStartCursor: 12345 }],
    ["backfillWaitSince", { ...full, backfillWaitSince: {} }],
    ["paginationRestarts", { ...full, paginationRestarts: "many" }],
  ])("rejects a cursor whose %s is the wrong type", (_field, value) => {
    // These three are read by the transactions phase: a non-string cursor is
    // sent to Plaid verbatim and refused on every call, and a non-numeric
    // restart count never reaches its bound. Rejecting here makes the
    // recovery the declared, logged rebootstrap rather than a silent one
    // further down.
    expect(plaidStateSpec.decode(value)).toBeNull();
  });
});
