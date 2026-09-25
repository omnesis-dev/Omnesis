// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { LunchflowAccountsSource } from "./accounts.js";
import { lunchflowStateSpec } from "./state.js";
import type { LunchflowTransport, GetTransactionsParams } from "./client.js";
import type {
  LunchflowAccount,
  LunchflowBalance,
  LunchflowCursor,
  LunchflowTransaction,
} from "./types.js";

const providerId = ProviderId("lunchflow:test");
const sourceId = SourceId("lunchflow-accounts:test");
const CLOCK = () => new Date("2026-06-18T09:00:00.000Z");

const ACCOUNT: LunchflowAccount = {
  id: 481,
  name: "everyday current account",
  institution_name: "example bank",
  institution_logo: null,
  provider: "gocardless",
  currency: "GBP",
  status: "ACTIVE",
};

class FakeClient implements LunchflowTransport {
  async listAccounts(): Promise<LunchflowAccount[]> {
    return [ACCOUNT];
  }
  async getTransactions(
    _accountId: string,
    _params?: GetTransactionsParams,
  ): Promise<LunchflowTransaction[]> {
    return [];
  }
  async getBalance(_accountId: string): Promise<LunchflowBalance> {
    return { amount: 100, currency: "GBP" };
  }
}

function versionedInstance(): { instance: SourceInstance; outcomes: StateOutcome[] } {
  const source = new LunchflowAccountsSource(
    new FakeClient(),
    providerId,
    sourceId,
    "test-account",
    {
      now: CLOCK,
    },
  );
  const raw: SourceInstance = {
    sync: () => {
      throw new Error("sync not expected — this source is structured-only");
    },
    syncStructured: (cursor) => source.syncStructured(cursor as LunchflowCursor | null),
  };
  const outcomes: StateOutcome[] = [];
  const versioned = withVersionedState(raw, lunchflowStateSpec, {
    sourceId: "lunchflow-accounts:test",
    onResolve: (outcome) => outcomes.push(outcome),
  });
  return { instance: versioned, outcomes };
}

describe("lunchflowStateSpec via the host decorator", () => {
  test("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const { instance, outcomes } = versionedInstance();

    const first = await instance.syncStructured!(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await instance.syncStructured!(first.cursor as LunchflowCursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  test("resumes a cursor mid-`transactions` fanout, not only the settled shape between ticks", async () => {
    const { instance, outcomes } = versionedInstance();

    // Part-way through the per-account fanout: `accounts` and `accountIndex`
    // are both populated, which the settled `{ phase: "accounts" }` idle
    // shape between ticks never carries. `decode` must accept this or every
    // partial fanout page would be reclassified as legacy and re-migrated on
    // the next page.
    const midCycleCursor: LunchflowCursor = {
      phase: "transactions",
      accounts: [
        {
          id: "481",
          name: "everyday current account",
          institutionName: "example bank",
          currency: "GBP",
        },
      ],
      accountIndex: 0,
      lastDates: {},
      currencies: {},
    };
    expect(lunchflowStateSpec.decode(midCycleCursor)).not.toBeNull();

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
