// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-level E2E driving the REAL Immich source through the full
 * collector → gateway → indexer → search pipeline.
 *
 * The `immich-sync` universe ships a `fake-corpus.json`, so the synth Immich
 * twin runs the real client, sync source and normalizer over the in-memory
 * `SimulatedImmich` (the client's `fetch` seam); only the API-key sign-in is
 * replaced. Asserts, through a spawned gateway:
 *   - the first sweep lands one document per owned, visible asset — the
 *     partner's shared photo (only the user's own are indexed), the
 *     trashed photo, the live photo's hidden motion part and the locked photo
 *     stay out — and the documents are searchable by description and place;
 *   - album names and named faces land on the documents, each named face
 *     becomes a person carrying its user-namespaced lid, and an own photo's
 *     owner is the operator's self person;
 *   - an edit made in Immich reaches the stored document on the next sync;
 *   - trashing an asset in Immich removes its document on the next sync.
 *
 * A hard delete is found only by the daily rewalk and corroborated by the
 * gateway over several of them, which a test cannot wait for; the rewalk's
 * presence list is covered against the same real source in
 * `packages/providers/immich/src/source.test.ts`.
 *
 * The controller is reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { ImmichWrapsRealController } from "@omnesis/provider-immich-synth";

const SOURCE_ID = "immich:maya.reeves@example.com";
const SELF_USER_ID = "8a1d2c3e-0000-4000-8000-00000000a001";
const asset = (n: string) => `5c3f4e5a-0000-4000-8000-00000000c${n}`;
const SARAH_PERSON_ID = "7d4a5b6c-0000-4000-8000-00000000d001";

interface DocRow {
  external_id: string;
  title: string;
  content: string;
  metadata: string;
}

async function controller(): Promise<ImmichWrapsRealController> {
  const mod = await import("@omnesis/provider-immich-synth");
  const ctrl = mod.getImmichWrapsRealController(SOURCE_ID);
  if (!ctrl) throw new Error(`no wraps-real controller registered for ${SOURCE_ID}`);
  return ctrl;
}

describe("Immich wraps-real: owned assets, albums and faces, edits and trash", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;

  const docs = (): DocRow[] =>
    db
      .prepare(
        "SELECT external_id, title, content, metadata FROM documents WHERE source_id = ? ORDER BY external_id",
      )
      .all(SOURCE_ID) as DocRow[];
  const doc = (externalId: string): DocRow | undefined =>
    docs().find((d) => d.external_id === externalId);

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "immich-sync",
      extraGatewayConfig: {
        self: { name: "Maya Reeves", emails: ["maya.reeves@example.com"] },
      },
    });
    await harness.start();
    db = new Database(harness.getDbPath(), { readonly: true });
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  });

  test("the first sweep indexes exactly the owned, visible assets", () => {
    expect(docs().map((d) => d.external_id)).toEqual([
      asset("001"),
      asset("002"),
      asset("003"),
      asset("004"),
    ]);
  });

  test("albums and named faces land on the documents", () => {
    const kite = doc(asset("001"))!;
    const metadata = JSON.parse(kite.metadata) as {
      documentType: string;
      sourceUrl: string;
      extra: { albums: string[]; people: string[]; city: string };
    };
    expect(kite.title).toBe("Kite festival on the harbour wall");
    expect(metadata.documentType).toBe("photo");
    expect(metadata.sourceUrl).toBe(`http://immich.example.com:2283/photos/${asset("001")}`);
    expect(metadata.extra.albums).toEqual(["Harbour Weekend"]);
    expect(metadata.extra.people).toEqual(["Sarah Mendez"]);
    expect(metadata.extra.city).toBe("Example Harbour");
    expect(JSON.parse(doc(asset("002"))!.metadata).documentType).toBe("video");
  });

  test("a named face becomes a person under its user-namespaced lid", () => {
    const person = db
      .prepare(
        `SELECT p.canonical_name AS name FROM person_aliases a
         JOIN people p ON p.id = a.person_id
         WHERE a.alias_type = 'lid' AND a.alias = ? AND p.merged_into IS NULL`,
      )
      .get(`immich:${SELF_USER_ID}/${SARAH_PERSON_ID}`) as { name: string } | undefined;
    expect(person?.name).toBe("Sarah Mendez");
  });

  test("the owner of an own photo is the operator's self person", () => {
    const owners = db
      .prepare(
        `SELECT p.is_self AS isSelf FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
         JOIN people p ON p.id = dp.person_id
         WHERE d.source_id = ? AND d.external_id = ? AND dp.role = 'owner'`,
      )
      .all(SOURCE_ID, asset("001")) as Array<{ isSelf: number }>;
    expect(owners).toEqual([{ isSelf: 1 }]);
  });

  test("documents are searchable by description and by place", async () => {
    await harness.refreshSearchSnapshot();
    for (const [query, title] of [
      ["pottery wheel", "Pottery wheel demonstration"],
      ["Example Harbour", "Kite festival on the harbour wall"],
    ] as const) {
      const res = (await harness.gatewayJson(
        `/documents/search?q=${encodeURIComponent(query)}&limit=50`,
      )) as { results?: Array<{ source_id: string; title: string }> };
      const titles = (res.results ?? [])
        .filter((r) => r.source_id === SOURCE_ID)
        .map((r) => r.title);
      expect(titles, query).toContain(title);
    }
  });

  test("an edit in Immich reaches the stored document on the next sync", async () => {
    const { server } = await controller();
    server.editAsset(asset("004"), (a) => {
      a.exifInfo = { ...a.exifInfo, description: "Marathon entry form, posted" };
    });
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    expect(doc(asset("004"))?.title).toBe("Marathon entry form, posted");
  });

  test("trashing an asset in Immich removes its document on the next sync", async () => {
    const { server } = await controller();
    server.trashAsset(asset("003"));
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    // The gateway applies a page's deletions after the page lands.
    const deadline = Date.now() + 30_000;
    while (doc(asset("003")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    expect(doc(asset("003"))).toBeUndefined();
    expect(doc(asset("001"))).toBeDefined();
  });
});
