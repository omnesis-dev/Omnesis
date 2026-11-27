// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { emptySync } from "@omnesis/source-sdk";
import { syncCalls } from "@omnesis/provider-omatel/src/calls.js";
import { isOmatelCursor } from "@omnesis/provider-omatel/src/group-sync.js";
import { syncMessages } from "@omnesis/provider-omatel/src/messages.js";
import {
  OMATEL_CALL_LOG_TABLE,
  OMATEL_MESSAGES_TABLE,
  omatelCallLogSchema,
  omatelMessagesSchema,
} from "@omnesis/provider-omatel/src/schemas.js";
import {
  addCall,
  addConversation,
  addMessage,
  omatelFixture,
  type OmatelFixture,
} from "@omnesis/provider-omatel/src/testing/fixtures.js";
import { SyncEngine } from "../sync-engine.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { RegisteredSource } from "../sync-engine-types.js";

/**
 * The real omatel sources behind a real collector's sync engine and a real
 * gateway: a call the owner deletes leaves the analytics table through the
 * gateway's own absence sweep — corroborated by spaced snapshots past the age
 * floor, and capped per snapshot — with no other change to the phone, and a
 * store that goes missing in between costs nothing.
 */

const providerId = ProviderId("omatel");
const callsId = SourceId("omatel-calls:local");
const messagesId = SourceId("omatel-messages:local");
const PEER = "+12025550141";
/** Marks one snapshot may record: fewer than the calls the test deletes. */
const MAX_MARKS = 4;
const CALLS = 12;
const DELETED = 10;

describe("omatel analytics deletion through the gateway's absence sweep", () => {
  let harness: MultiCollectorHarness;
  let gateway: HttpGatewayClient;
  let engine: SyncEngine;
  let fx: OmatelFixture;
  let calls: RegisteredSource;
  let messages: RegisteredSource;

  const sql = async (query: string) =>
    (
      await harness.json<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: query }),
      })
    ).rows;
  const callIds = async () =>
    (await sql(`SELECT id FROM ${OMATEL_CALL_LOG_TABLE} ORDER BY CAST(id AS INTEGER)`)).map((r) =>
      String(r[0]),
    );
  const messageCount = async () =>
    Number((await sql(`SELECT count(*) FROM ${OMATEL_MESSAGES_TABLE}`))[0]![0]);
  const documentsOf = async (sourceId: SourceId) =>
    (await gateway.listDocuments({ limit: 100 })).documents
      .filter((doc) => doc.sourceId === sourceId)
      .map((doc) => doc.title)
      .sort();
  const sweep = async () => {
    // One pass deletes what is due; a second proves the pass left nothing due behind.
    for (let i = 0; i < 2; i++)
      await harness.json("/admin/background/run/absence.sweep", { method: "POST" });
  };
  /** One sync of a source, which must end idle. */
  const tick = async (source: RegisteredSource) => {
    await engine.syncSource(source);
    expect(engine.getStatuses().find((s) => s.sourceId === source.id)?.state).toBe("idle");
  };

  const registered = (
    id: SourceId,
    name: string,
    schema: typeof omatelCallLogSchema,
    sync: RegisteredSource["instance"]["syncStructured"],
  ): RegisteredSource => ({
    id,
    providerId,
    name,
    family: { name: "omatel" },
    instance: {
      sync: () => Promise.resolve(emptySync()),
      analyticsSchemas: [schema],
      syncStructured: sync,
    },
  });

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1", OMNESIS_EXPERIMENTAL: "1" },
      gatewayConfig: {
        gateway: {
          snapshotAbsence: {
            minObservations: 3,
            minAge: "10ms",
            deletionGrace: "1ms",
            maxMarksPerSnapshot: MAX_MARKS,
          },
        },
      },
    });
    await harness.start();
    const collector = await harness.addCollector({
      name: "omatel-phone",
      hostableSourceTypes: ["omatel-calls", "omatel-messages"],
    });
    gateway = new HttpGatewayClient(harness.gatewayUrl, collector.token);
    expect(
      (
        await gateway.bulkUpsertSources([
          { type: SourceType("omatel-calls"), accountId: AccountId("local"), enabled: true },
          { type: SourceType("omatel-messages"), accountId: AccountId("local"), enabled: true },
        ])
      ).errors,
    ).toEqual([]);

    fx = omatelFixture();
    const callsDb = fx.calls();
    for (let day = 1; day <= CALLS; day++) {
      addCall(callsDb, {
        number: PEER,
        direction: day % 2 === 0 ? "out" : "in",
        outcome: "answered",
        startedAt: Date.UTC(2026, 2, day, 9),
        duration: 30 + day,
      });
    }
    const messagesDb = fx.messages();
    const conversation = addConversation(messagesDb, PEER);
    addMessage(messagesDb, conversation, {
      direction: "in",
      body: "lunch at noon",
      at: Date.UTC(2026, 2, 1, 11),
    });
    addMessage(messagesDb, conversation, {
      direction: "out",
      body: "see you there",
      at: Date.UTC(2026, 2, 1, 11, 5),
    });

    const options = { dataDir: fx.dir, providerId };
    calls = registered(callsId, "omatel calls", omatelCallLogSchema, (cursor) =>
      Promise.resolve(
        syncCalls(isOmatelCursor(cursor) ? cursor : null, { ...options, sourceId: callsId }),
      ),
    );
    messages = registered(messagesId, "omatel messages", omatelMessagesSchema, (cursor) =>
      Promise.resolve(
        syncMessages(isOmatelCursor(cursor) ? cursor : null, { ...options, sourceId: messagesId }),
      ),
    );
    engine = new SyncEngine(gateway);
    engine.registerProvider({
      id: providerId,
      name: "omatel",
      renewableCredential: false,
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      sources: [calls, messages],
    });
    await tick(calls);
    await tick(messages);
  }, 60_000);

  afterAll(async () => {
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
    fx?.cleanup();
  }, 20_000);

  test("bootstrap writes one row per call and message and one document per day", async () => {
    expect(await callIds()).toHaveLength(CALLS);
    expect(await messageCount()).toBe(2);
    expect(await documentsOf(callsId)).toHaveLength(CALLS);
    expect(await documentsOf(messagesId)).toHaveLength(1);
  });

  test("a missing calls.db deletes nothing, even across sweeps", async () => {
    const restore = fx.hide("calls.db");
    try {
      for (let i = 0; i < 4; i++) await tick(calls);
      await sweep();
      expect(await callIds()).toHaveLength(CALLS);
      expect(await documentsOf(callsId)).toHaveLength(CALLS);
    } finally {
      restore();
    }
  }, 60_000);

  test("deleted calls leave the table after corroborating unchanged cycles, past the per-snapshot cap", async () => {
    const callDocsBefore = await documentsOf(callsId);
    const messageDocsBefore = await documentsOf(messagesId);
    const callsDb = fx.calls();
    const kept = (
      callsDb.prepare("SELECT id FROM calls ORDER BY id DESC LIMIT ?").all(CALLS - DELETED) as {
        id: number;
      }[]
    )
      .map((row) => String(row.id))
      .reverse();
    callsDb.prepare(`DELETE FROM calls WHERE id NOT IN (${kept.join(", ")})`).run();

    // The cycle that sees the deletion removes the days' documents by id at once.
    await tick(calls);
    expect(await documentsOf(callsId)).toEqual(callDocsBefore.slice(DELETED));

    // One more unchanged cycle is still short of the corroboration floor.
    await tick(calls);
    await sweep();
    expect(await callIds()).toHaveLength(CALLS);

    // Unchanged cycles keep sending the snapshot until every deleted row is gone.
    let cycles = 2;
    while ((await callIds()).length > kept.length && cycles < 20) {
      await tick(calls);
      await tick(messages);
      await sweep();
      cycles++;
    }

    expect(await callIds()).toEqual(kept);
    // More deletions than one snapshot may mark take several snapshots each.
    expect(cycles).toBeGreaterThan(Math.ceil(DELETED / MAX_MARKS));
    // Nothing else changed: no document came back or appeared, and the
    // messages table, synced alongside throughout, kept its rows.
    expect(await documentsOf(callsId)).toEqual(callDocsBefore.slice(DELETED));
    expect(await documentsOf(messagesId)).toEqual(messageDocsBefore);
    expect(await messageCount()).toBe(2);
  }, 120_000);
});
