// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import type { GatewayClient, SyncCursor, SyncOptions } from "@omnesis/source-sdk";
import type { SourceScopes } from "@omnesis/types";

/**
 * A collector that keeps running while source filters are switched on at the
 * gateway reports its stored records' filter facts at once, instead of at
 * each source's next interval.
 */

const engines: SyncEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stopSyncLoopAndDrain()));
});

const DECLARATIONS: Array<{ sourceType: string; scopes: SourceScopes }> = [
  { sourceType: "example-filterable", scopes: { items: [] } },
];

/** A gateway whose answer to "do you take filter facts" the test sets before each publication. */
function gatewayThatTakes(initial: boolean) {
  const state = { takes: initial };
  const gateway = {
    getSyncState: vi.fn(() => Promise.resolve(null)),
    getWipeEpoch: vi.fn(() => Promise.resolve(undefined)),
    setSourceMeta: vi.fn(() => Promise.resolve()),
    upsertWithCursor: vi.fn(() =>
      Promise.resolve({ ingested: 0, reconciledDeleted: 0, indexCleanedRows: 0 }),
    ),
    setSourceScopes: vi.fn((_entries: typeof DECLARATIONS) => Promise.resolve()),
    supportsSourceScopes: vi.fn((_minimum?: number) => Promise.resolve(state.takes)),
    getScopeRefreshState: vi.fn(() => Promise.resolve({ epochs: {}, requestIds: {} })),
  } satisfies Partial<GatewayClient>;
  return { state, gateway };
}

function collector(gateway: ReturnType<typeof gatewayThatTakes>["gateway"]) {
  const engine = new SyncEngine(gateway as unknown as GatewayClient);
  engines.push(engine);
  const source = (name: string, scopes?: SourceScopes) => {
    const sync = vi.fn((_cursor: SyncCursor | null, _options?: SyncOptions) =>
      Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
    );
    const providerId = ProviderId(`${name}:owner`);
    engine.registerProvider({
      id: providerId,
      name: `Example ${name}`,
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      renewableCredential: true,
      sources: [
        {
          id: SourceId(`${name}:owner`),
          providerId,
          name: `Example ${name}`,
          family: { name: `Example ${name}` },
          scopes,
          instance: { sync },
        },
      ],
    });
    return sync;
  };
  return {
    engine,
    filterable: source("example-filterable", { items: [] }),
    plain: source("example-plain"),
  };
}

test("a gateway that begins to take filter facts has every filterable source synced at once, and no other", async () => {
  const { state, gateway } = gatewayThatTakes(false);
  const { engine, filterable, plain } = collector(gateway);

  await engine.pushSourceScopes(DECLARATIONS);
  expect(gateway.setSourceScopes).toHaveBeenCalledWith(DECLARATIONS);
  state.takes = true;
  await engine.pushSourceScopes(DECLARATIONS);

  await vi.waitFor(() => expect(filterable).toHaveBeenCalledTimes(1));
  const options = filterable.mock.calls[0]![1]!;
  expect(options.scopeFactsSupported).toBe(true);
  // An ordinary sync brought forward: nothing is reset or sent again.
  expect(options.run).toMatchObject({ reason: "scheduled" });
  expect(filterable.mock.calls[0]![0]).toBeNull();
  await engine.stopSyncLoopAndDrain();
  expect(filterable).toHaveBeenCalledTimes(1);
  expect(plain).not.toHaveBeenCalled();
});

test.each([
  { name: "took them when the collector first connected", answers: [true] },
  { name: "takes them on every reconnection", answers: [true, true, true] },
  { name: "still takes none", answers: [false, false] },
  { name: "stops taking them", answers: [true, false] },
])("no sync is brought forward when the gateway $name", async ({ answers }) => {
  const { state, gateway } = gatewayThatTakes(false);
  const { engine, filterable } = collector(gateway);

  for (const takes of answers) {
    state.takes = takes;
    await engine.pushSourceScopes(DECLARATIONS);
  }

  expect(gateway.setSourceScopes).toHaveBeenCalledTimes(answers.length);
  await engine.stopSyncLoopAndDrain();
  expect(filterable).not.toHaveBeenCalled();
});

test("a publication that fails is no answer: the change is noticed at the next one that succeeds", async () => {
  const { state, gateway } = gatewayThatTakes(false);
  const { engine, filterable } = collector(gateway);

  await engine.pushSourceScopes(DECLARATIONS);
  state.takes = true;
  gateway.setSourceScopes.mockRejectedValueOnce(new Error("offline"));
  await expect(engine.pushSourceScopes(DECLARATIONS)).resolves.toBeUndefined();
  expect(filterable).not.toHaveBeenCalled();

  await engine.pushSourceScopes(DECLARATIONS);
  await vi.waitFor(() => expect(filterable).toHaveBeenCalledTimes(1));
});

test("a collector that is shutting down starts no sync", async () => {
  const { state, gateway } = gatewayThatTakes(false);
  const { engine, filterable } = collector(gateway);

  await engine.pushSourceScopes(DECLARATIONS);
  engine.stopSyncLoop();
  state.takes = true;
  await engine.pushSourceScopes(DECLARATIONS);

  await engine.stopSyncLoopAndDrain();
  expect(filterable).not.toHaveBeenCalled();
});

test("a gateway client without filter declarations is left alone", async () => {
  const engine = new SyncEngine({} as GatewayClient);
  engines.push(engine);
  await expect(engine.pushSourceScopes(DECLARATIONS)).resolves.toBeUndefined();
});
