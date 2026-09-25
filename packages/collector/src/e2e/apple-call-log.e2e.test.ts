// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple Call Log source — synth pipeline coverage (e2e-minimal universe).
 *
 * Boots a real gateway, syncs ONLY `apple-call-log:john.smith@icloud.example`,
 * and locks in the source's document contract end-to-end:
 *
 *   1. Bootstrap ingests exactly the fixture entry count (3 day-documents in
 *      e2e-minimal) and persists a cursor.
 *   2. Documents carry `documentType: "call-log"` and resolved peer
 *      `participant` mentions (symmetric co-consumption, no self/peer role
 *      asymmetry) in the canonical `ListedDocument` projection.
 *   3. A peer who exists in the corpus ONLY through a call-log participant
 *      mention (no other source synced in this harness) resolves via
 *      `/people/search` — the same peer → person pipeline Apple Calendar's
 *      attendee mentions use.
 *   4. Call-log content is searchable via the LIKE endpoint.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getDocuments } from "./helpers.js";

const SOURCE_ID = "apple-call-log:john.smith@icloud.example";

interface ListedDoc {
  title: string;
  content?: string;
  metadata?: {
    documentType?: string;
    people?: Array<{ role: string; name?: string; emails?: string[]; phones?: string[] }>;
  };
}

interface PeopleSearchResp {
  items?: Array<{ id: string; name?: string }>;
}

describe("Apple Call Log synth source (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(SOURCE_ID, 30_000);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("bootstrap ingests every fixture day-document and persists a cursor", async () => {
    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID);
    expect(count).toBe(3);
    const state = await harness.getSyncState(SOURCE_ID);
    expect(state).not.toBeNull();
  });

  test("documents carry the call-log documentType and participant mentions", async () => {
    const docs = (await getDocuments(harness.gatewayUrl, harness.apiKey, SOURCE_ID)) as ListedDoc[];
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc.metadata?.documentType).toBe("call-log");
    }

    const day = docs.find((d) => d.title === "Calls — 2025-09-05");
    expect(day).toBeDefined();
    const people = day?.metadata?.people ?? [];
    // Symmetric co-consumption: self AND every peer are role "participant",
    // no producer/consumer asymmetry.
    expect(people.every((p) => p.role === "participant")).toBe(true);
    expect(people.some((p) => p.emails?.includes("john.smith@icloud.example"))).toBe(true);
    expect(people.some((p) => p.emails?.includes("claire.smith@example.org"))).toBe(true);
    expect(people.some((p) => p.phones?.includes("+447700900123"))).toBe(true);
  });

  test("a peer known only via call-log participation reaches the people graph", async () => {
    // Daniel Harper appears in this harness ONLY as a call-log participant
    // (no other source was synced), so resolving him proves the
    // participant → person pipeline. The people-backfill writer is async —
    // poll until the person row lands.
    const deadline = Date.now() + 60_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const resp = await harness.gatewayJson<PeopleSearchResp>(
        "/people/search?q=Daniel%20Harper&limit=3",
      );
      found = (resp.items ?? []).length > 0;
      if (!found) await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(found, "Daniel Harper should resolve from a call-log participant mention").toBe(true);
  }, 70_000);

  test("call-log content is searchable", async () => {
    const resp = await harness.gatewayJson<{ results?: Array<{ source_id: string }> }>(
      `/documents/search?q=${encodeURIComponent("Daniel Harper")}&limit=10`,
    );
    const fromCallLog = (resp.results ?? []).filter((r) => r.source_id === SOURCE_ID);
    expect(fromCallLog.length).toBeGreaterThan(0);
  });
});
