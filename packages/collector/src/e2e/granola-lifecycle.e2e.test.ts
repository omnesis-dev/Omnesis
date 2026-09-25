// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { emptySync, withVersionedState } from "@omnesis/source-sdk";
import { GranolaMeetingsSource, granolaMeetingsSchema } from "@omnesis/provider-granola";
import { GranolaClient } from "@omnesis/provider-granola/src/client.js";
import { granolaMeetingsStateSpec } from "@omnesis/provider-granola/src/state.js";
import { SyncEngine } from "../sync-engine.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type {
  GranolaMeetingsCursor,
  GranolaNoteDetail,
} from "@omnesis/provider-granola/src/types.js";
import type { RegisteredSource } from "../sync-engine-types.js";

const sourceId = SourceId("granola-meetings:fixture");
const providerId = ProviderId("granola:fixture");
const note = (id: string): GranolaNoteDetail => ({
  id,
  object: "note",
  title: `Fixture meeting ${id}`,
  created_at: "2026-01-01T12:00:00.000Z",
  updated_at: "2026-01-02T12:00:00.000Z",
  web_url: `https://granola.ai/notes/${id}`,
  summary_text: "Fictional project meeting",
  summary_markdown: null,
  transcript: null,
  owner: { name: "Fixture", email: "owner@example.com" },
  attendees: [],
  calendar_event: null,
  folder_membership: [],
});

describe("real Granola lifecycle through collector and gateway", () => {
  let harness: MultiCollectorHarness;
  let gateway: HttpGatewayClient;
  let engine: SyncEngine;
  let source: RegisteredSource;
  let upstream = [note("not_kept"), note("not_removed")];
  let failListing = false;
  let unreadableNote: string | undefined;
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const countRows = async () => {
    const result = await harness.json<{ rows: number[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT count(*) FROM granola_meetings" }),
    });
    return Number(result.rows[0]![0]);
  };
  const documents = async () =>
    (await gateway.listDocuments({ limit: 100 })).documents.filter(
      (document) => document.sourceId === sourceId,
    );
  const sweep = async () => {
    for (let pass = 0; pass < 2; pass++)
      await harness.json("/admin/background/run/absence.sweep", { method: "POST" });
  };
  const sync = async () => {
    now += 24 * 60 * 60 * 1000;
    await engine.syncSource(source);
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
      gatewayConfig: {
        gateway: {
          snapshotAbsence: {
            minObservations: 3,
            minAge: "10ms",
            deletionGrace: "1ms",
            maxMarksPerSnapshot: 200,
          },
        },
      },
    });
    await harness.start();
    const collector = await harness.addCollector({
      name: "meeting-fixture",
      hostableSourceTypes: ["granola-meetings"],
    });
    gateway = new HttpGatewayClient(harness.gatewayUrl, collector.token);
    expect(
      (
        await gateway.bulkUpsertSources([
          { type: SourceType("granola-meetings"), accountId: AccountId("fixture"), enabled: true },
        ])
      ).errors,
    ).toEqual([]);
    // Substitute only HTTP: the real client, normalizers, state wrapper and
    // collector write path all run against a separate synthetic gateway.
    const client = new GranolaClient("fixture-key", {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/notes")
          return failListing
            ? new Response("Unavailable", { status: 503 })
            : Response.json({ notes: upstream, hasMore: false, cursor: null });
        const id = url.pathname.split("/").at(-1);
        const detail = upstream.find((entry) => entry.id === id);
        return !detail || id === unreadableNote
          ? new Response("Not found", { status: 404 })
          : Response.json(detail);
      },
    });
    const implementation = new GranolaMeetingsSource(
      client,
      providerId,
      sourceId,
      undefined,
      "fixture",
      { now: () => new Date(now).toISOString() },
    );
    source = {
      id: sourceId,
      providerId,
      name: "Fixture meetings",
      family: { name: "Granola" },
      instance: withVersionedState(
        {
          sync: async () => emptySync(),
          analyticsSchemas: [granolaMeetingsSchema],
          syncStructured: (cursor) =>
            implementation.syncStructured(cursor as GranolaMeetingsCursor | null),
        },
        granolaMeetingsStateSpec,
        { sourceId },
      ),
    };
    engine = new SyncEngine(gateway);
    engine.registerProvider({
      id: providerId,
      name: "Fixture meetings",
      renewableCredential: false,
      credentialState: async () => ({ status: "connected" }),
      sources: [source],
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
  }, 20_000);

  test("updates both planes, retains unreadable data, and reconciles deletions and an empty account", async () => {
    await sync();
    expect(await documents()).toHaveLength(2);
    expect(await countRows()).toBe(2);
    upstream[0]!.title = "Updated fixture meeting";
    upstream[0]!.updated_at = "2026-01-03T12:00:00.000Z";
    await sync();
    expect((await documents()).map((document) => document.title)).toContain(
      "Updated fixture meeting",
    );

    unreadableNote = "not_removed";
    for (let cycle = 0; cycle < 3; cycle++) await sync();
    await sweep();
    expect(await documents()).toHaveLength(2);
    expect(await countRows()).toBe(2);
    unreadableNote = undefined;
    upstream = [upstream[0]!];
    failListing = true;
    await sync();
    expect(engine.getStatuses().find((status) => status.sourceId === sourceId)?.state).toBe(
      "error",
    );
    await sweep();
    expect(await documents()).toHaveLength(2);
    expect(await countRows()).toBe(2);

    failListing = false;
    for (let cycle = 0; cycle < 3; cycle++) await sync();
    expect(engine.getStatuses().find((status) => status.sourceId === sourceId)?.state).toBe("idle");
    await sweep();
    expect(await documents()).toHaveLength(1);
    expect(await countRows()).toBe(1);
    upstream = [];
    for (let cycle = 0; cycle < 3; cycle++) await sync();
    await sweep();
    expect(await documents()).toHaveLength(0);
    expect(await countRows()).toBe(0);
  }, 60_000);
});
