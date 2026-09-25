// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple Calendar source — synth pipeline coverage (e2e-minimal universe).
 *
 * Boots a real gateway, syncs ONLY `apple-calendar:john.smith@icloud.example`, and
 * locks in the source's document contract end-to-end:
 *
 *   1. Bootstrap ingests exactly the fixture entry count (3 in
 *      e2e-minimal) and persists a cursor.
 *   2. Documents carry `documentType: "event"` and resolved attendee
 *      mentions in the canonical `ListedDocument` projection.
 *   3. Attendee mentions reach the people graph — a person who exists in
 *      the corpus ONLY through a calendar attendee mention (no other
 *      source synced) resolves via `/people/search`.
 *   4. Event content is searchable via the LIKE endpoint.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getDocuments } from "./helpers.js";

const SOURCE_ID = "apple-calendar:john.smith@icloud.example";

interface ListedDoc {
  title: string;
  metadata?: {
    documentType?: string;
    people?: Array<{ role: string; name?: string; emails?: string[] }>;
  };
}

interface PeopleSearchResp {
  items?: Array<{ id: string; name?: string }>;
}

describe("Apple Calendar synth source (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(SOURCE_ID, 30_000);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("bootstrap ingests every fixture event and persists a cursor", async () => {
    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID);
    expect(count).toBe(3);
    const state = await harness.getSyncState(SOURCE_ID);
    expect(state).not.toBeNull();
  });

  test("documents carry the event documentType and attendee mentions", async () => {
    const docs = (await getDocuments(harness.gatewayUrl, harness.apiKey, SOURCE_ID)) as ListedDoc[];
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc.metadata?.documentType).toBe("event");
    }
    // "Dinner with Claire" carries a second attendee beyond self.
    const dinner = docs.find((d) => d.title === "Dinner with Claire");
    expect(dinner).toBeDefined();
    const attendees = (dinner?.metadata?.people ?? []).filter((p) => p.role === "attendee");
    expect(attendees.some((p) => p.emails?.includes("claire.smith@example.org"))).toBe(true);
  });

  test("attendee mentions reach the people graph", async () => {
    // Claire Smith appears in this harness ONLY as a calendar attendee
    // (no other source was synced), so resolving her proves the
    // attendee → person pipeline. The people-backfill writer is async —
    // poll until the person row lands.
    const deadline = Date.now() + 60_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const resp = await harness.gatewayJson<PeopleSearchResp>(
        "/people/search?q=Claire%20Smith&limit=3",
      );
      found = (resp.items ?? []).length > 0;
      if (!found) await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(found, "Claire Smith should resolve from a calendar attendee mention").toBe(true);
  }, 70_000);

  test("event content is searchable", async () => {
    const resp = await harness.gatewayJson<{ results?: Array<{ source_id: string }> }>(
      `/documents/search?q=${encodeURIComponent("Dentist check-up")}&limit=10`,
    );
    const fromCalendar = (resp.results ?? []).filter((r) => r.source_id === SOURCE_ID);
    expect(fromCalendar.length).toBeGreaterThan(0);
  });
});
