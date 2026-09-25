// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple voicemail source — synthetic pipeline coverage.
 *
 * Boots a real gateway, syncs only the voicemail source, and verifies the
 * production descriptor's day-document contract reaches storage, search, and
 * the people graph without any source-specific gateway code.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getDocuments } from "./helpers.js";

const SOURCE_ID = "apple-voicemail:john.smith@icloud.example";
const CONTACTS_SOURCE_ID = "apple-contacts:john.smith@icloud.example";

interface ListedDoc {
  title: string;
  content?: string;
  metadata?: {
    documentType?: string;
    rollingAggregate?: boolean;
    people?: Array<{ role: string; name?: string; emails?: string[]; phones?: string[] }>;
    extra?: {
      voicemailCount?: number;
      totalDurationSeconds?: number;
      transcriptCount?: number;
      voicemails?: Array<Record<string, unknown>>;
    };
  };
}

interface PeopleSearchResponse {
  items?: Array<{ id: string; name?: string }>;
}

interface PersonDetail {
  aliases?: Array<{ aliasType: string; alias: string }>;
}

describe("Apple voicemail synth source (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(CONTACTS_SOURCE_ID, 30_000);
    await harness.triggerSyncAndWait(SOURCE_ID, 30_000);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("bootstrap ingests every daily aggregate and persists a cursor", async () => {
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(3);
    expect(await harness.getSyncState(SOURCE_ID)).not.toBeNull();
  });

  test("daily documents carry transcripts, aggregate metadata, and participant identities", async () => {
    const allDocs = (await getDocuments(
      harness.gatewayUrl,
      harness.apiKey,
      SOURCE_ID,
    )) as ListedDoc[];
    const docs = allDocs.filter((doc) => doc.metadata?.documentType === "voicemail");
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc.metadata?.documentType).toBe("voicemail");
    }

    const day = docs.find((doc) => doc.title === "Voicemail — 2025-09-06");
    expect(day?.content).toContain("blue folder at the reception desk");
    expect(day?.content).toContain("community hall booking is confirmed");
    const people = day?.metadata?.people ?? [];
    expect(people.every((person) => person.role === "participant")).toBe(true);
    expect(people.some((person) => person.emails?.includes("john.smith@icloud.example"))).toBe(
      true,
    );
    expect(people.some((person) => person.phones?.includes("+15550102"))).toBe(true);
    expect(people.some((person) => person.phones?.includes("+15550101"))).toBe(true);
  });

  test("transcript text is searchable", async () => {
    const response = await harness.gatewayJson<{ results?: Array<{ source_id: string }> }>(
      `/documents/search?q=${encodeURIComponent("blue folder")}&limit=10`,
    );
    expect((response.results ?? []).some((result) => result.source_id === SOURCE_ID)).toBe(true);
  });

  test("a phone-only voicemail caller joins the named Contacts person", async () => {
    const deadline = Date.now() + 60_000;
    let joined = false;
    while (Date.now() < deadline && !joined) {
      const response = await harness.gatewayJson<PeopleSearchResponse>(
        `/people/search?q=${encodeURIComponent("Jane Doe")}&limit=3`,
      );
      const person = response.items?.[0];
      if (person) {
        const detail = await harness.gatewayJson<PersonDetail>(`/people/${person.id}`);
        const aliases = detail.aliases ?? [];
        joined =
          aliases.some((alias) => alias.aliasType === "name" && alias.alias === "Jane Doe") &&
          aliases.some((alias) => alias.aliasType === "phone" && alias.alias === "+15550101");
      }
      if (!joined) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(joined, "the voicemail phone should join the named Contacts person").toBe(true);
  }, 70_000);
});
