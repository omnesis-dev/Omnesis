// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * People-backfill task coverage.
 *
 * Boots a real gateway against the `e2e-minimal` universe, syncs every
 * source, and asserts that `backfill.peopleBatch` materializes people
 * rows from document metadata and wires them back to the source docs.
 *
 * Catches regressions where `PeopleResolutionService` stops attaching
 * `document_people` rows correctly — currently only unit-tested. The
 * shape we lock in is the user-visible contract:
 *
 *   1. `/people` is non-empty after sync.
 *   2. A known fictional person from the e2e-minimal cast (Jane Doe —
 *      bidirectional WhatsApp + Gmail surfaces in the slim universe)
 *      shows up with `documentCount > 0` AND a `name` alias.
 *   3. `/people/:id/documents` returns at least one document for that
 *      person — proves `document_people` rows exist (`document_id`
 *      wiring), not just the bare `people` row.
 *   4. The reciprocal `/documents/:id/people` endpoint surfaces the
 *      same person back on at least one of those docs — closes the
 *      doc↔person loop both directions.
 *   5. `/admin/background-jobs` records at least one tick of
 *      `backfill.peopleBatch` — proves the scheduler is the thing that
 *      did the work, not some other ingest-side fallback.
 *
 * Cadence note: `peopleBatchTask` ticks every active-batch interval
 * (~1s) with a `startDelayMs` of 2s, draining the
 * `document_people_pending` queue in batches. Within the 90s post-sync
 * window we reliably observe the queue drain and the first tick land.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface PersonSummary {
  id: string;
  canonicalName: string;
  isSelf: boolean;
  aliasCount: number;
  documentCount: number;
}

interface PeopleSearchResp {
  items: PersonSummary[];
}

interface PersonAlias {
  aliasType: string;
  alias: string;
}

interface PersonDetail {
  id: string;
  canonicalName: string;
  isSelf: boolean;
  aliases: PersonAlias[];
}

interface PersonDocumentEntry {
  id: string;
  roles: string[];
}

interface PersonDocumentsResp {
  items: PersonDocumentEntry[];
}

interface DocumentPersonLink {
  personId: string;
  canonicalName: string;
  role: string;
  isSelf: boolean;
}

interface DocumentPeopleResp {
  people: DocumentPersonLink[];
}

interface JobObservation {
  state: string;
  lastTickAt?: number;
  ticksLastHour: number;
}

interface BackgroundJobsSnapshot {
  jobs: Array<{
    id: string;
    displayName: string;
    observation: JobObservation;
  }>;
}

describe("People-backfill scheduler task (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let janeId: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    // The backfill writer-handler is async — wait until Jane Doe (a
    // fictional cast member with bidirectional surfaces in the slim
    // universe) is both findable AND has a positive documentCount
    // before any per-person assertions run.
    janeId = await waitForPersonWithDocs(harness, "Jane Doe", 60_000);
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("peopleBatch task ticks at least once after sync", async () => {
    // The job's existence on the registry proves wiring; a tick proves
    // the scheduler actually ran it. 30s gives the 2s startDelay + a
    // few drain cycles head room beyond the beforeAll wait.
    await waitForJobTicked(harness, "backfill.peopleBatch", 30_000);
  }, 60_000);

  test("/people is non-empty after sync", async () => {
    const resp = await harness.gatewayJson<PeopleSearchResp>("/people?limit=100");
    expect(resp.items.length).toBeGreaterThan(0);
    // Every materialized row carries a canonical name and a non-negative
    // document count — guards against shape regressions in the query.
    for (const p of resp.items) {
      expect(typeof p.canonicalName).toBe("string");
      expect(p.canonicalName.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.documentCount) && p.documentCount >= 0).toBe(true);
      expect(Number.isFinite(p.aliasCount) && p.aliasCount >= 0).toBe(true);
    }
  });

  test("a known cast member materializes with a name alias and positive documentCount", async () => {
    const detail = await harness.gatewayJson<PersonDetail>(`/people/${janeId}`);
    const nameAliases = detail.aliases.filter((a) => a.aliasType === "name");
    // The cast carries `name: "Jane Doe"`, so the name alias should
    // land via the backfill resolver. Match case-insensitively in case
    // a source's surface form differs in casing.
    expect(nameAliases.some((a) => a.alias.toLowerCase() === "jane doe")).toBe(true);
  });

  test("/people/:id/documents returns at least one document_id-wired entry", async () => {
    const resp = await harness.gatewayJson<PersonDocumentsResp>(
      `/people/${janeId}/documents?limit=20`,
    );
    expect(resp.items.length).toBeGreaterThan(0);
    // Each entry must carry a doc id and at least one role string — the
    // pair the writer-handler is supposed to materialize. Roles is a
    // string[] (GROUP_CONCAT split client-side in the repo).
    for (const entry of resp.items) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.roles)).toBe(true);
      expect(entry.roles.length).toBeGreaterThan(0);
      for (const role of entry.roles) {
        expect(typeof role).toBe("string");
        expect(role.length).toBeGreaterThan(0);
      }
    }
  });

  test("/documents/:id/people closes the loop back to the person", async () => {
    // Pick one of Jane's docs and assert the reciprocal endpoint
    // surfaces Jane on it. This is the regression-catcher: if
    // `PeopleResolutionService` stops wiring `document_people`
    // correctly, the doc → people direction breaks even when the
    // person row exists.
    const docs = await harness.gatewayJson<PersonDocumentsResp>(
      `/people/${janeId}/documents?limit=20`,
    );
    expect(docs.items.length).toBeGreaterThan(0);

    let found = false;
    for (const entry of docs.items) {
      const resp = await harness.gatewayJson<DocumentPeopleResp>(
        `/documents/${encodeURIComponent(entry.id)}/people`,
      );
      if (resp.people.some((p) => p.personId === janeId)) {
        found = true;
        break;
      }
    }
    expect(found, "Jane should appear on at least one of her own documents").toBe(true);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Poll `/people/search` until a person matching `name` appears with a
 * `documentCount > 0` AND at least one alias attached. The peopleBatch
 * task drains the pending queue asynchronously after sync — the row
 * lands first, then aliases + counts catch up over the next few ticks.
 * Returns the resolved person id.
 */
async function waitForPersonWithDocs(
  harness: SyntheticE2EHarness,
  name: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await harness.gatewayJson<PeopleSearchResp>(
      `/people/search?q=${encodeURIComponent(name)}&limit=5`,
    );
    const hit = res.items.find((p) => p.documentCount > 0);
    if (hit) return hit.id;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForPersonWithDocs: ${name} did not surface with documents within ${timeoutMs}ms`,
  );
}

/**
 * Poll `/admin/background-jobs` until the named job has fired at least
 * one tick. Mirrors the helper in `people-graph.e2e.test.ts`.
 */
async function waitForJobTicked(
  harness: SyntheticE2EHarness,
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await harness.gatewayJson<BackgroundJobsSnapshot>("/admin/background-jobs");
    const job = snap.jobs.find((j) => j.id === jobId);
    if (job && (job.observation.lastTickAt != null || job.observation.ticksLastHour > 0)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`waitForJobTicked: ${jobId} did not tick within ${timeoutMs}ms`);
}
