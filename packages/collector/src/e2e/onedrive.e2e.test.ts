// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { REWALK_BUMP } from "@omnesis/provider-outlook-synth";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getJson } from "./helpers.js";

/**
 * End-to-end coverage for the synthetic OneDrive source — the
 * Microsoft-side sibling of Google Drive. The synth twin feeds canned Microsoft
 * Graph `driveItem` delta pages + file content into the REAL `OneDriveSource`,
 * so this exercises the production delta walk → `driveItem`→`DocumentInput`
 * normalize → content extract → gateway ingest path, not a re-implementation.
 *
 * It proves the frozen success criteria through the gateway that the unit tests
 * can only prove on the source in isolation: (1) files are searchable by their
 * extracted content with per-file metadata (webUrl, mime, size, folder path,
 * shared-with people); (2) incremental delta is correct and bounded — a deleted
 * file is removed, an unchanged re-sync is idempotent; and (3) an expired delta
 * token (410) recovers via a bounded re-walk that re-extracts only the changed
 * file, never a from-zero re-bootstrap.
 *
 * The synth twin honors three env switches that mutate the synthetic drive
 * between sync ticks against one running gateway:
 *   OMNESIS_ONEDRIVE_SYNTH_DELETE=<id>          — next tick tombstones that file
 *   OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA=1        — next deltaLink fetch throws 410
 *   OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE=<id>    — bumps one file's content/eTag
 *
 * Tests run in declared order (vitest is sequential within a file), each phase
 * building on the prior gateway state.
 */

const SOURCE_ID = "onedrive:john.smith@example.com";

interface RecentDoc {
  id: string;
  externalId: string;
  title: string;
  documentType: string;
}

interface FullDoc {
  id: string;
  content: string;
  metadata: string; // JSON string
}

async function getRecentDocs(harness: SyntheticE2EHarness): Promise<RecentDoc[]> {
  const data = (await getJson(
    `${harness.gatewayUrl}/documents/recent/${encodeURIComponent(SOURCE_ID)}?limit=100`,
    harness.apiKey,
  )) as { documents: RecentDoc[] };
  return data.documents;
}

async function getFullDoc(harness: SyntheticE2EHarness, docId: string): Promise<FullDoc> {
  return (await getJson(
    `${harness.gatewayUrl}/documents/${encodeURIComponent(docId)}`,
    harness.apiKey,
  )) as FullDoc;
}

async function searchTitles(harness: SyntheticE2EHarness, q: string): Promise<string[]> {
  const res = (await harness.gatewayJson(
    `/documents/search?q=${encodeURIComponent(q)}&sources=${encodeURIComponent(SOURCE_ID)}&limit=20`,
  )) as { results?: Array<{ title: string }> };
  return (res.results ?? []).map((d) => d.title);
}

function clearSynthEnv(): void {
  delete process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE;
  delete process.env.OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA;
  delete process.env.OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE;
}

describe("Synthetic provider — OneDrive (file source, sibling of Google Drive)", () => {
  let harness: SyntheticE2EHarness;

  function pendingAbsenceIds(): string[] {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM document_absences WHERE source_id = ? ORDER BY external_id",
        )
        .all(SOURCE_ID)
        .map((row) => row.external_id);
    } finally {
      db.close();
    }
  }

  beforeAll(async () => {
    clearSynthEnv();
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    await harness.refreshSearchSnapshot();
  }, 240000);

  afterAll(async () => {
    clearSynthEnv();
    await harness.destroy();
  }, 15000);

  test("bootstrap ingests every fixture file as a searchable document", async () => {
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(3);

    const docs = await getRecentDocs(harness);
    expect(docs.map((d) => d.title).sort()).toEqual([
      "Q4-budget-review.md",
      "marathon-training-plan.md",
      "vendor-shortlist.md",
    ]);
    // Every OneDrive document carries the generic "file" document type.
    expect(docs.every((d) => d.documentType === "file")).toBe(true);
  });

  test("files are searchable by their extracted content", async () => {
    // A phrase that appears only inside the file body (not the title) — proves
    // the downloaded content was extracted and indexed, not just the metadata.
    // The legacy /documents/search is a substring LIKE over `content`, so each
    // query must be a contiguous run from the fixture body.
    expect(await searchTitles(harness, "Northstar launch ships")).toContain("Q4-budget-review.md");
    expect(await searchTitles(harness, "long run 16k Sunday")).toContain(
      "marathon-training-plan.md",
    );
  });

  test("per-file metadata: webUrl→sourceUrl, mime, size, folder path, content", async () => {
    const docs = await getRecentDocs(harness);
    const budget = docs.find((d) => d.title === "Q4-budget-review.md");
    expect(budget).toBeDefined();

    const full = await getFullDoc(harness, budget!.id);
    const metadata = JSON.parse(full.metadata) as {
      documentType: string;
      sourceUrl?: string;
      extra?: { mimeType?: string; folderPath?: string; fileSize?: number };
    };
    expect(metadata.documentType).toBe("file");
    // webUrl → sourceUrl: the same URL Outlook referenceAttachment links point
    // at, so the reference graph can later auto-resolve email→OneDrive.
    expect(metadata.sourceUrl).toBe(
      "https://onedrive.live.com/?id=onedrive-file-001&cid=drive-john",
    );
    expect(metadata.extra?.mimeType).toBe("text/markdown");
    expect(metadata.extra?.folderPath).toBe("/Documents/Finance");
    expect(metadata.extra?.fileSize).toBe(196);
    // The wrapped content carries the file body.
    expect(full.content).toContain("Q4 Budget Review");
  });

  test("a shared file feeds its sharer into the people graph", async () => {
    const docs = await getRecentDocs(harness);
    const shared = docs.find((d) => d.title === "vendor-shortlist.md");
    expect(shared).toBeDefined();

    const full = await getFullDoc(harness, shared!.id);
    const metadata = JSON.parse(full.metadata) as {
      people?: Array<{ role: string; name?: string; emails?: string[] }>;
    };
    const sharer = (metadata.people ?? []).find((p) => p.emails?.includes("jane.doe@acme.example"));
    expect(sharer, "the sharedBy person should be a person mention").toBeDefined();
  });

  test("an unchanged incremental re-sync is idempotent — no duplicates, no drops", async () => {
    clearSynthEnv();
    await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(3);

    // The persisted cursor advanced to the incremental phase after bootstrap.
    const state = await harness.getSyncState(SOURCE_ID);
    expect((state!.cursor as { phase?: string }).phase).toBe("incremental");
  }, 120000);

  test("a deleted file is removed end-to-end via the delta deleted facet", async () => {
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(3);

    process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE = "onedrive-file-002";
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    } finally {
      clearSynthEnv();
    }
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(2);
    const docs = await getRecentDocs(harness);
    expect(docs.map((d) => d.title)).not.toContain("marathon-training-plan.md");
  }, 120000);

  test("an expired delta token (410) recovers via a bounded re-walk", async () => {
    // The drive still has the file deleted in the prior phase removed, so the
    // re-walk enumerates the two surviving files. One file's content is bumped:
    // the bounded re-walk must re-extract ONLY that file (fingerprint changed),
    // leave the other untouched, and recover WITHOUT a from-zero re-bootstrap
    // (no document duplication — count stays 2).
    process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE = "onedrive-file-002";
    process.env.OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA = "1";
    process.env.OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE = "onedrive-file-001";
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    } finally {
      clearSynthEnv();
    }

    // Recovered: still exactly the two surviving files, no duplication.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(2);

    // The cursor stayed incremental (a bounded re-walk, not a bootstrap reset).
    const state = await harness.getSyncState(SOURCE_ID);
    expect((state!.cursor as { phase?: string }).phase).toBe("incremental");

    // The bumped file carries the content the switch appended — the assertion
    // that separates "re-extracted" from "the document is merely still there",
    // since the unbumped body is what every earlier phase already saw.
    await harness.refreshSearchSnapshot();
    const docs = await getRecentDocs(harness);
    const budget = docs.find((d) => d.title === "Q4-budget-review.md");
    expect(budget).toBeDefined();
    const full = await getFullDoc(harness, budget!.id);
    expect(full.content).toContain("Q4 Budget Review");
    expect(full.content.trimEnd().endsWith(REWALK_BUMP)).toBe(true);
  }, 120000);

  test("a file missing from an expired-delta rewalk is marked absent", async () => {
    // The recovery case a tombstone can never cover. The deletion is published
    // against the token that expired, so the fresh from-zero enumeration the
    // re-walk issues carries no `deleted` facet for it — the file is simply
    // absent. Both switches fire on the SAME tick so no tombstone tick ever
    // reaches the gateway: absence is the only signal available.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(2);

    // The two prior phases' mutations stay in force alongside the new deletion,
    // so the re-walk sees exactly the drive the gateway last agreed on, minus
    // file-003 — nothing else changes underneath and can be mistaken for it.
    process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE = "onedrive-file-002,onedrive-file-003";
    process.env.OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE = "onedrive-file-001";
    process.env.OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA = "1";
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    } finally {
      clearSynthEnv();
    }

    // No tombstone reached the gateway, so the re-walk's omission is evidence,
    // not an immediate delete. The post-boot grace keeps the file queryable and
    // the durable ledger proves exactly which file was marked.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(2);
    expect(pendingAbsenceIds()).toEqual(["onedrive-file-003"]);
    await harness.refreshSearchSnapshot();
    const docs = await getRecentDocs(harness);
    expect(docs.map((d) => d.title).sort()).toEqual(
      ["Q4-budget-review.md", "vendor-shortlist.md"].sort(),
    );

    // The survivor kept the body the prior phase gave it: reconciling a
    // deletion must not disturb the file next to it.
    const budget = docs.find((doc) => doc.title === "Q4-budget-review.md");
    expect(budget).toBeDefined();
    const full = await getFullDoc(harness, budget!.id);
    expect(full.content.trimEnd().endsWith(REWALK_BUMP)).toBe(true);

    // Recovery leaves the cursor on the incremental stream, not back at
    // bootstrap — the re-walk is a repair, not a restart.
    const state = await harness.getSyncState(SOURCE_ID);
    expect((state!.cursor as { phase?: string }).phase).toBe("incremental");
  }, 120000);
});
