// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { EnableBankingAccountsSource } from "./accounts.js";
import { saveSession } from "./session.js";
import { enableBankingStateSpec } from "./state.js";
import type { EbBalance, EbTransactionsPage, EnableBankingCursor, StoredSession } from "./types.js";
import type { EnableBankingTransport, GetTransactionsParams } from "./client.js";

const providerId = ProviderId("enable-banking:test");
const sourceId = SourceId("enable-banking-accounts:test");
const ACCOUNT_ID = "test-bank";
const NOW = new Date("2026-06-01T08:00:00.000Z");

function makeSession(): StoredSession {
  return {
    session_id: "sess-1",
    valid_until: "2026-11-28T00:00:00.000Z",
    aspsp: { name: "example bank", country: "DE" },
    accounts: [
      {
        account_key: "hash-eur",
        uid: "uid-eur-1",
        iban: "DE89975713758667268881",
        currency: "EUR",
        name: "Main EUR",
        cash_account_type: "CACC",
        product: null,
      },
    ],
  };
}

class FakeClient implements EnableBankingTransport {
  async getBalances(_uid: string): Promise<EbBalance[]> {
    return [];
  }
  async getTransactions(
    _uid: string,
    _params: GetTransactionsParams = {},
  ): Promise<EbTransactionsPage> {
    return { transactions: [] };
  }
}

let configDir: string;

function versionedInstance(): { instance: SourceInstance; outcomes: StateOutcome[] } {
  const source = new EnableBankingAccountsSource(
    new FakeClient(),
    providerId,
    sourceId,
    ACCOUNT_ID,
    {
      now: () => NOW,
      configDir,
    },
  );
  const raw: SourceInstance = {
    sync: () => {
      throw new Error("sync not expected — this source is structured-only");
    },
    syncStructured: (cursor) => source.syncStructured(cursor as EnableBankingCursor | null),
  };
  const outcomes: StateOutcome[] = [];
  const versioned = withVersionedState(raw, enableBankingStateSpec, {
    sourceId: "enable-banking-accounts:test",
    onResolve: (outcome) => outcomes.push(outcome),
  });
  return { instance: versioned, outcomes };
}

describe("enableBankingStateSpec via the host decorator", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "enable-banking-state-"));
    saveSession(ACCOUNT_ID, makeSession(), configDir);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const { instance, outcomes } = versionedInstance();

    const first = await instance.syncStructured!(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await instance.syncStructured!(first.cursor as EnableBankingCursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  test("resumes a cursor mid-`bootstrap`, not only the settled `incremental` shape", async () => {
    const { instance, outcomes } = versionedInstance();

    // A page part-way through one account's network-fallback bootstrap
    // window: `cachePageIndex` is absent (network path, not the cache
    // drain), but `windowMaxBookingDate`, `windowHashCounts` and
    // `lastBookingDates` are all populated — none of which the settled
    // `incremental` shape carries. `decode` must accept this or every
    // partial bootstrap page would be reclassified as legacy and
    // re-migrated on the next page.
    const midCycleCursor: EnableBankingCursor = {
      phase: "bootstrap",
      accountIndex: 0,
      bootstrapSessionId: "sess-1",
      windowMaxBookingDate: "2026-05-20",
      windowHashCounts: { "hash-eur:2026-05-20:23.40": 1 },
      lastBookingDates: {},
    };
    expect(enableBankingStateSpec.decode(midCycleCursor)).not.toBeNull();

    const result = await instance.syncStructured!(midCycleCursor);
    expect(outcomes[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("an unrecognised stored value rebootstraps rather than silently wedging", async () => {
    const { instance, outcomes } = versionedInstance();

    const result = await instance.syncStructured!({ somethingElse: true } as never);
    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
