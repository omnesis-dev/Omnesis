// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { tableWrites } from "@omnesis/source-sdk";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { PaperlessClient } from "./client.js";
import { PaperlessDocumentsSource } from "./documents.js";
import { FAKE_BASE_URL, FAKE_TOKEN, FakePaperless } from "./fake-paperless.js";
import { paperlessDocumentsStateSpec } from "./state.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { PaperlessDocumentsCursor } from "./types.js";

const ACCOUNT = "maya@paperless.example.com+8000";

function setup(opts: { pageSize?: number; dataCutoff?: string; now?: () => string } = {}) {
  const fake = new FakePaperless();
  fake.tags.set(1, { id: 1, name: "Tax" });
  fake.tags.set(2, { id: 2, name: "Paid" });
  fake.correspondents.set(10, { id: 10, name: "Stellar Energy" });
  fake.documentTypes.set(20, { id: 20, name: "Invoice" });
  fake.customFields.set(30, { id: 30, name: "Amount due", data_type: "monetary" });
  const client = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, { fetchImpl: fake.fetch });
  let clock = Date.UTC(2026, 3, 1);
  const source = new PaperlessDocumentsSource(
    client,
    ProviderId(`paperless:${ACCOUNT}`),
    SourceId(`paperless-documents:${ACCOUNT}`),
    ACCOUNT,
    opts.dataCutoff,
    {
      pageSize: opts.pageSize ?? 2,
      now: opts.now ?? (() => new Date((clock += 60_000)).toISOString()),
    },
  );
  return { fake, source };
}

type Result = StructuredSyncResult<PaperlessDocumentsCursor>;

/** Run one tick: keep paging while the source says there is more. */
async function tick(
  source: PaperlessDocumentsSource,
  cursor: PaperlessDocumentsCursor | null,
): Promise<{ pages: Result[]; cursor: PaperlessDocumentsCursor }> {
  const pages: Result[] = [];
  let next = cursor;
  for (let i = 0; i < 100; i++) {
    const page = await source.syncStructured(next);
    pages.push(page);
    next = page.cursor;
    if (!page.hasMore) return { pages, cursor: page.cursor };
  }
  throw new Error("sweep never finished");
}

const docIds = (pages: Result[]) =>
  pages.flatMap((p) => p.documents ?? []).map((d) => d.externalId);
const rowsOf = (page: Result, table: string) =>
  tableWrites(page.analytics)
    .filter((w) => w.tableName === table)
    .flatMap((w) => w.records ?? []);

describe("PaperlessDocumentsSource", () => {
  test("the first sweep reads every document, and names them present only on its last page", async () => {
    const { fake, source } = setup();
    fake.addDocument({
      id: 1,
      title: "March electricity",
      correspondent: 10,
      document_type: 20,
      tags: [1],
      custom_fields: [{ field: 30, value: "EUR84.20" }],
    });
    fake.addDocument({ id: 2 });
    fake.addDocument({ id: 3 });

    const { pages, cursor } = await tick(source, null);

    expect(pages).toHaveLength(2);
    expect(docIds(pages).sort()).toEqual(["1", "2", "3"]);
    expect(pages[0]!.presentExternalIds).toBeUndefined();
    expect(tableWrites(pages[0]!.analytics).some((w) => w.presentKeys)).toBe(false);
    expect(pages[1]!.presentExternalIds?.sort()).toEqual(["1", "2", "3"]);
    const last = tableWrites(pages[1]!.analytics);
    expect(last.find((w) => w.tableName === "paperless_documents")?.presentKeys).toEqual(
      expect.arrayContaining([1, 2, 3].map((id) => ({ source_account_id: ACCOUNT, id }))),
    );
    expect(cursor.phase).toBe("incremental");
    expect(cursor.pending).toBeUndefined();
    expect(cursor.watermark).toBe(fake.documents.get(3)!.modified);

    const fieldRows = pages.flatMap((p) => rowsOf(p, "paperless_custom_field_values"));
    expect(fieldRows).toEqual([
      expect.objectContaining({
        document_id: 1,
        field_name: "Amount due",
        value_number: 84.2,
        currency: "EUR",
      }),
    ]);
  });

  test("custom field values are replaced whole: the deletion is written before the rows", async () => {
    const { fake, source } = setup();
    fake.addDocument({ id: 1, custom_fields: [{ field: 30, value: "EUR10.00" }] });

    const { pages } = await tick(source, null);

    const writes = tableWrites(pages[0]!.analytics).filter(
      (w) => w.tableName === "paperless_custom_field_values",
    );
    expect(writes[0]).toEqual(
      expect.objectContaining({ deletedKeys: [{ source_account_id: ACCOUNT, document_id: 1 }] }),
    );
    expect(writes[0]!.records).toBeUndefined();
    expect(writes[1]!.records).toHaveLength(1);
  });

  test("an incremental tick fetches only what changed since the watermark", async () => {
    const { fake, source } = setup();
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    const first = await tick(source, null);

    fake.editDocument(2, { tags: [2] });
    fake.addDocument({ id: 3 });
    fake.requests.length = 0;
    const second = await tick(source, first.cursor);

    expect(docIds(second.pages).sort()).toEqual(["2", "3"]);
    expect(second.pages.at(-1)!.presentExternalIds).toBeUndefined();
    expect(fake.requests.some((r) => r.includes("modified__gt="))).toBe(true);
    expect(second.cursor.watermark).toBe(fake.documents.get(3)!.modified);

    const third = await tick(source, second.cursor);
    expect(docIds(third.pages)).toEqual([]);
  });

  test("a daily snapshot names every document present but re-reads only the changed ones", async () => {
    let now = Date.UTC(2026, 3, 1);
    const { fake, source } = setup({ now: () => new Date(now).toISOString() });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    fake.addDocument({ id: 3 });
    const first = await tick(source, null);

    fake.documents.delete(2);
    fake.editDocument(3, { title: "Renamed" });
    now += 25 * 60 * 60 * 1000;
    const snap = await tick(source, first.cursor);

    expect(docIds(snap.pages)).toEqual(["3"]);
    expect(snap.pages.at(-1)!.presentExternalIds?.sort()).toEqual(["1", "3"]);
    expect(snap.cursor.lastSnapshotAt).toBe(new Date(now).toISOString());
  });

  test("renaming a tag re-reads every document, since Paperless does not touch their modified", async () => {
    const { fake, source } = setup();
    fake.addDocument({ id: 1, tags: [1] });
    fake.addDocument({ id: 2 });
    const first = await tick(source, null);

    fake.tags.set(1, { id: 1, name: "Taxes 2026" });
    const second = await tick(source, first.cursor);

    expect(docIds(second.pages).sort()).toEqual(["1", "2"]);
    const doc1 = second.pages.flatMap((p) => p.documents ?? []).find((d) => d.externalId === "1");
    expect(doc1?.metadata.tags).toEqual(["Taxes 2026"]);

    const third = await tick(source, second.cursor);
    expect(docIds(third.pages)).toEqual([]);
  });

  test("a document deleted between the listing and the fetch is skipped, not failed", async () => {
    const { fake, source } = setup({ pageSize: 5 });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    fake.vanishOnFetch.add(2);

    const { pages } = await tick(source, null);

    expect(docIds(pages)).toEqual(["1"]);
    // Named present by the listing; the next listing decides.
    expect(pages[0]!.presentExternalIds?.sort()).toEqual(["1", "2"]);
  });

  test("a malformed document is skipped, reported, kept present, and tried again", async () => {
    let now = Date.UTC(2026, 3, 1);
    const { fake, source } = setup({ pageSize: 5, now: () => new Date(now).toISOString() });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2, tags: null as unknown as number[] });

    const first = await tick(source, null);

    expect(docIds(first.pages)).toEqual(["1"]);
    const last = first.pages.at(-1)!;
    // Skipping it is not evidence it was deleted.
    expect(last.presentExternalIds?.sort()).toEqual(["1", "2"]);
    expect(last.issues).toEqual([
      expect.objectContaining({ scope: "item", count: 1, code: "paperless-unreadable-document" }),
    ]);

    // Once readable, the next snapshot reads it, though its modified never moved.
    fake.documents.get(2)!.tags = [];
    now += 25 * 60 * 60 * 1000;
    const snap = await tick(source, first.cursor);
    expect(docIds(snap.pages)).toEqual(["2"]);
    expect(snap.pages.at(-1)!.issues).toEqual([]);
  });

  test("a document the server cannot serve costs only itself", async () => {
    const { fake, source } = setup({ pageSize: 5 });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    fake.addDocument({ id: 3 });
    fake.poison.add(2);

    const { pages } = await tick(source, null);

    expect(docIds(pages).sort()).toEqual(["1", "3"]);
    expect(pages.at(-1)!.presentExternalIds?.sort()).toEqual(["1", "2", "3"]);
    expect(pages.at(-1)!.issues?.[0]).toEqual(expect.objectContaining({ count: 1, subject: "2" }));
  });

  test("the last document of a sweep being unservable does not stall the source", async () => {
    const { fake, source } = setup({ pageSize: 1 });
    fake.addDocument({ id: 1 });
    fake.poison.add(1);

    const { pages, cursor } = await tick(source, null);

    expect(docIds(pages)).toEqual([]);
    expect(cursor.pending).toBeUndefined();
    expect(pages.at(-1)!.issues?.[0]).toEqual(expect.objectContaining({ count: 1 }));
  });

  test("a snapshot reads a document whose custom fields a bulk edit changed", async () => {
    let now = Date.UTC(2026, 3, 1);
    const { fake, source } = setup({ now: () => new Date(now).toISOString() });
    fake.addDocument({ id: 1, custom_fields: [{ field: 30, value: "EUR10.00" }] });
    fake.addDocument({ id: 2 });
    const first = await tick(source, null);

    // Paperless's bulk custom-field edit leaves `modified` alone.
    fake.documents.get(1)!.custom_fields = [{ field: 30, value: "EUR12.00" }];
    expect(docIds((await tick(source, first.cursor)).pages)).toEqual([]);
    now += 25 * 60 * 60 * 1000;
    const snap = await tick(source, first.cursor);

    expect(docIds(snap.pages)).toEqual(["1"]);
    const values = snap.pages.flatMap((p) => rowsOf(p, "paperless_custom_field_values"));
    expect(values).toEqual([expect.objectContaining({ document_id: 1, value_number: 12 })]);
  });

  test("a snapshot reads a document no earlier listing named, whatever its modified", async () => {
    let now = Date.UTC(2026, 3, 1);
    const { fake, source } = setup({ now: () => new Date(now).toISOString() });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    const first = await tick(source, null);

    // Committed late, or newly shared with the token's user: older than the
    // watermark, so no incremental listing names it.
    fake.addDocument({ id: 3, modified: "2026-01-01T00:00:00.000000+00:00" });
    expect(docIds((await tick(source, first.cursor)).pages)).toEqual([]);
    now += 25 * 60 * 60 * 1000;
    const snap = await tick(source, first.cursor);

    expect(docIds(snap.pages)).toEqual(["3"]);
  });

  test("a new tag or correspondent re-reads nothing; only a rename does", async () => {
    const { fake, source } = setup();
    fake.addDocument({ id: 1, tags: [1] });
    fake.addDocument({ id: 2 });
    const first = await tick(source, null);

    fake.tags.set(3, { id: 3, name: "Warranty" });
    fake.correspondents.set(11, { id: 11, name: "Northstar Insurance" });
    const second = await tick(source, first.cursor);
    expect(docIds(second.pages)).toEqual([]);

    // Removing one is a change: documents that carried it read differently.
    fake.tags.delete(1);
    const third = await tick(source, second.cursor);
    expect(docIds(third.pages).sort()).toEqual(["1", "2"]);
  });

  test("a document edited mid-sweep is picked up by the next sweep", async () => {
    const { fake, source } = setup({ pageSize: 1 });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    const page1 = await source.syncStructured(null);
    expect(page1.hasMore).toBe(true);

    fake.editDocument(Number(page1.documents![0]!.externalId), { title: "Edited mid-sweep" });
    const rest = await tick(source, page1.cursor);
    const next = await tick(source, rest.cursor);

    const titles = next.pages.flatMap((p) => p.documents ?? []).map((d) => d.title);
    expect(titles).toEqual(["Edited mid-sweep"]);
  });

  test("the history cutoff is sent as a created-date filter", async () => {
    const { fake, source } = setup({ dataCutoff: "2026-01-01T00:00:00.000Z" });
    fake.addDocument({ id: 1, created: "2025-06-01" });
    fake.addDocument({ id: 2, created: "2026-02-01" });

    const { pages } = await tick(source, null);

    expect(fake.requests.some((r) => r.includes("created__gte=2026-01-01"))).toBe(true);
    expect(docIds(pages)).toEqual(["2"]);
  });

  test("an empty archive completes with an empty snapshot", async () => {
    const { source } = setup();
    const { pages, cursor } = await tick(source, null);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.presentExternalIds).toEqual([]);
    expect(cursor.phase).toBe("incremental");
  });

  test("an outage fails the page and leaves the installed cursor to retry from", async () => {
    const { fake, source } = setup();
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    fake.addDocument({ id: 3 });
    const page1 = await source.syncStructured(null);

    fake.outage = true;
    const err = await source.syncStructured(page1.cursor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("transient");
    fake.outage = false;

    const retried = await tick(source, page1.cursor);
    expect(docIds([page1, ...retried.pages]).sort()).toEqual(["1", "2", "3"]);
  });

  test("a listing that repeats an id fails before any state moves", async () => {
    const { fake } = setup();
    fake.addDocument({ id: 1 });
    const realFetch = fake.fetch;
    const client = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: async (input, init) => {
        if (String(input).includes("id__gt=")) {
          const m = "2026-03-01T09:00:01.000001+00:00";
          return new Response(
            JSON.stringify({
              count: 2,
              next: null,
              previous: null,
              results: [
                { id: 1, modified: m },
                { id: 1, modified: m },
              ],
            }),
          );
        }
        return realFetch(input, init);
      },
    });
    const broken = new PaperlessDocumentsSource(
      client,
      ProviderId(`paperless:${ACCOUNT}`),
      SourceId(`paperless-documents:${ACCOUNT}`),
      ACCOUNT,
      undefined,
    );
    await expect(broken.syncStructured(null)).rejects.toThrow(/invalid document listing/);
  });

  test("every cursor a sweep produces round-trips through the state spec", async () => {
    const { fake, source } = setup({ pageSize: 1 });
    fake.addDocument({ id: 1 });
    fake.addDocument({ id: 2 });
    const page1 = await source.syncStructured(null);
    const settled = await tick(source, page1.cursor);
    for (const cursor of [page1.cursor, settled.cursor]) {
      const json = JSON.parse(JSON.stringify(cursor)) as unknown;
      expect(paperlessDocumentsStateSpec.decode(json)).toEqual(cursor);
    }
    expect(paperlessDocumentsStateSpec.decode({ phase: "bogus" })).toBeNull();
    expect(paperlessDocumentsStateSpec.decode({ phase: "incremental", pending: [0] })).toBeNull();
    // A full or snapshot sweep in progress without what it has listed would
    // end by vouching for an empty archive.
    expect(paperlessDocumentsStateSpec.decode({ phase: "full", pending: [3] })).toBeNull();
    expect(paperlessDocumentsStateSpec.decode({ phase: "snapshot", pending: [3] })).toBeNull();
  });

  test("an upstream that never changes settles and stops emitting", async () => {
    const { fake, source } = setup();
    fake.addDocument({ id: 1, tags: [1], custom_fields: [{ field: 30, value: "EUR5.00" }] });
    fake.addDocument({ id: 2 });
    fake.addDocument({ id: 3 });

    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      async step(cursor) {
        const { pages, cursor: next } = await tick(
          source,
          cursor as PaperlessDocumentsCursor | null,
        );
        const records = pages.flatMap((page) => [
          ...(page.documents ?? []).map((doc) => ({
            table: "documents",
            row: { externalId: doc.externalId, contentHash: doc.contentHash },
          })),
          ...tableWrites(page.analytics).flatMap((w) =>
            (w.records ?? []).map((row) => ({ table: w.tableName, row })),
          ),
        ]);
        return { records, cursor: next, hasMore: false };
      },
      primaryKey: (table) =>
        table === "documents"
          ? ["externalId"]
          : table === "paperless_documents"
            ? ["source_account_id", "id"]
            : ["source_account_id", "document_id", "field_id"],
      settleSteps: 3,
    });
  });
});
