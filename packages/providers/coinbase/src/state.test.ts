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
import { CoinbaseSnapshotSource } from "./snapshot.js";
import { coinbaseStateSpec } from "./state.js";
import type { CoinbaseClient } from "./client.js";
import type { CoinbaseAccountsPage, CoinbaseOrdersPage } from "./schemas.js";
import type { CoinbaseCursor } from "./types.js";

const PROVIDER_ID = ProviderId("coinbase:11111111-2222-3333-4444-555555555555");
const SOURCE_ID = SourceId("coinbase:11111111-2222-3333-4444-555555555555");
const ACCOUNT_KEY = "11111111-2222-3333-4444-555555555555";

/**
 * Minimal fake — the orders reads a mid-walk page needs, plus an empty
 * balances page for the rebootstrap case (a rebootstrapped cursor always
 * re-enters at `snapshot-balances`, the phase machine's start).
 */
class FakeClient {
  constructor(private readonly pages: CoinbaseOrdersPage[] = []) {}
  getOrdersPage(opts: { cursor?: string } = {}): Promise<CoinbaseOrdersPage> {
    const idx = opts.cursor ? Number(opts.cursor.replace("ord-", "")) : 0;
    return Promise.resolve(this.pages[idx] ?? { orders: [], has_next: false });
  }
  getAccountsPage(): Promise<CoinbaseAccountsPage> {
    return Promise.resolve({ accounts: [], has_next: false });
  }
}

function versionedInstance(client: FakeClient): SourceInstance & {
  outcomes: () => StateOutcome[];
} {
  const source = new CoinbaseSnapshotSource(
    client as unknown as CoinbaseClient,
    PROVIDER_ID,
    SOURCE_ID,
    ACCOUNT_KEY,
    ACCOUNT_KEY,
  );
  const instance: SourceInstance = {
    sync: () => {
      throw new Error("sync not expected — this source is structured-only");
    },
    syncStructured: (cursor) => source.syncStructured(cursor as CoinbaseCursor | null),
  };
  const outcomes: StateOutcome[] = [];
  const versioned = withVersionedState(instance, coinbaseStateSpec, {
    sourceId: "coinbase:11111111-2222-3333-4444-555555555555",
    onResolve: (outcome) => outcomes.push(outcome),
  });
  return Object.assign(versioned, { outcomes: () => outcomes });
}

describe("Coinbase — declared state", () => {
  test("resumes a mid-`orders` walk, not just a settled cursor", async () => {
    // Mid-walk: a page cursor and a running sweep max, with the watermark not
    // yet promoted (that only happens once the walk completes). `decode` must
    // accept this partial shape, not only the settled `incremental` one.
    const midWalkCursor: CoinbaseCursor = {
      phase: "orders",
      ordersSweepMax: "2026-01-01T00:00:00Z",
    };
    const client = new FakeClient([{ orders: [], has_next: true, cursor: "ord-2" }]);
    const instance = versionedInstance(client);

    const result = await instance.syncStructured!(midWalkCursor);

    expect(instance.outcomes()[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
    const envelope = result.cursor as unknown as { state: CoinbaseCursor };
    expect(envelope.state.phase).toBe("orders");
  });

  test("rebootstraps rather than crashing on a phase this build no longer recognises", async () => {
    // Stands in for a retired or renamed phase from an older release. Unlike
    // Strava's multi-tier enrichment, Coinbase's re-walk is cheap and
    // idempotent, so the declared policy is "rebootstrap" — but it is now a
    // *named*, logged outcome instead of being indistinguishable from a
    // genuine first run.
    const retiredPhaseCursor = { phase: "gear-refresh" };
    const client = new FakeClient([]);
    const instance = versionedInstance(client);

    const result = await instance.syncStructured!(retiredPhaseCursor as unknown as CoinbaseCursor);

    expect(instance.outcomes()[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("round-trips a settled `incremental` cursor as an envelope", async () => {
    const settledCursor: CoinbaseCursor = {
      phase: "incremental",
      lastSnapshotDate: "2026-01-01",
    };
    const client = new FakeClient([]);
    const instance = versionedInstance(client);

    const result = await instance.syncStructured!(settledCursor);

    expect(instance.outcomes()[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
