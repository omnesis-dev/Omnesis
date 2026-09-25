// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A real gateway proves both Watch ingest paths survive pressure and restart. */
import "./synth-env.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

const PLAID = "plaid:plaid-item-johnsmith";
let harness: SyntheticE2EHarness;

beforeEach(async () => {
  harness = new SyntheticE2EHarness({
    gatewayMode: "experimental",
    universe: "e2e-minimal",
    extraGatewayConfig: {
      gateway: {
        // With the former RAM hand-off, the page below exceeded this capacity
        // before the first two-second drain and permanently lost its tail.
        watch: { batchSize: 500, queueCapacity: 1_000 },
      },
    },
  });
  await harness.start();
  await harness.triggerSyncAndWait(PLAID, 60_000);
  // Let the deliberately tiny batch drain the fixture rows before watches are
  // installed at the journal head; only rows created by the test may fire.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}, 240_000);

afterEach(async () => {
  await harness.destroy();
}, 15_000);

async function fingerprint(): Promise<string> {
  return (await harness.gatewayJson<{ fingerprint: string }>("/admin/watch/ontology")).fingerprint;
}

async function add(dsl: unknown): Promise<string> {
  const { watch } = await harness.gatewayJson<{ watch: { id: string } }>("/admin/watch/watches", {
    method: "POST",
    body: JSON.stringify({ dsl }),
  });
  return watch.id;
}

async function firingCount(id: string): Promise<number> {
  const { watches } = await harness.gatewayJson<{
    watches: Array<{ id: string; firings: number }>;
  }>("/admin/watch/watches");
  return watches.find((watch) => watch.id === id)?.firings ?? 0;
}

async function waitForCount(id: string, expected: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await firingCount(id)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(await firingCount(id)).toBe(expected);
}

describe("Watch durable ingest", () => {
  test("keeps synthetic analytics rows and documents across a backlog restart", async () => {
    const ontology = await fingerprint();
    const analyticsWatch = await add({
      watch: {
        name: "durable-invented-payments",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology,
        nodes: [
          {
            id: "payment",
            type: "source.analytics_row",
            table: "plaid_transactions",
            op: ["inserted"],
            predicate: "amount < -100",
            output_map: { id: "$e.row.transaction_id" },
          },
        ],
        sink: { input: "payment", output_map: { id: "$n.payment.id" } },
      },
    });
    const documentWatch = await add({
      watch: {
        name: "durable-invented-documents",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology,
        nodes: [
          {
            id: "mail",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            output_map: { id: "$e.docId" },
          },
        ],
        sink: { input: "mail", output_map: { id: "$n.mail.id" } },
      },
    });

    for (let index = 0; index < 3; index += 1) {
      await harness.pushDocument({
        externalId: `durable-message-${index}`,
        sourceId: "gmail",
        providerId: "google",
        documentType: "email",
        title: `Invented durable message ${index}`,
        content: "Entirely fictional test content.",
      });
    }
    await waitForCount(documentWatch, 3);

    const { wipeEpoch } = await harness.gatewayJson<{ wipeEpoch: number }>(
      `/sync-state/${encodeURIComponent(PLAID)}`,
    );
    await harness.gatewayJson("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: "plaid_transactions",
        sourceId: PLAID,
        writeEpoch: wipeEpoch,
        records: Array.from({ length: 1_012 }, (_, index) => ({
          transaction_id: `durable-invented-${index}`,
          item_id: "plaid-item-johnsmith",
          account_id: "plaid-account-checking",
          date: "2026-05-15",
          amount: "-250.00",
          currency: "USD",
          name: `Invented durable payment ${index}`,
          pending: false,
        })),
      }),
    });

    // The first batch cannot have consumed the whole page yet.
    await harness.restartGateway();
    await waitForCount(analyticsWatch, 1_012);
    expect(await firingCount(documentWatch)).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(await firingCount(analyticsWatch), "analytics rows repeated after settling").toBe(1_012);
    expect(await firingCount(documentWatch), "documents repeated after settling").toBe(3);
  }, 240_000);
});
