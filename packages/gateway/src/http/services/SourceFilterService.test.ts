// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The owner's filter screens over a read port whose answers the tests
 * release by hand: the structure comes back at once, whole-account counts
 * come back pending and land from a background pass, and the passes are
 * bounded, cached by what they depend on, and retried after a failure.
 *
 * All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FILTER_COUNTS_RETRY_MS,
  SourceFilterService,
  type SourceFilterReads,
} from "./SourceFilterService.js";
import type {
  FilterEditorField,
  FilterFieldCounts,
  SourceFilterEditorStructure,
  SourceFilterPreview,
} from "../../access/source-filter-editor.js";
import type { FilterEditorResult, FilterOptions } from "../../access/filter-editor-reads.js";
import type { FilterRef, SourceFilter } from "@omnesis/types";

const SOURCE = "ledger:northstar";
const LABEL = { one: "label", many: "labels" };
const FOLDER = { one: "folder", many: "folders" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Let settled passes reach the cache. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function field(path: string, overrides: Partial<FilterEditorField> = {}): FilterEditorField {
  return {
    field: path,
    capability: "membership",
    noun: LABEL,
    picker: "search",
    scope: "global",
    state: { status: "ready" },
    ...overrides,
  };
}

let structure: SourceFilterEditorStructure;

function counts(unmatched: number): FilterFieldCounts {
  return { tooOld: 0, unmatched, tooOldText: null, unmatchedText: `${unmatched} unmatched` };
}

const ref = (id: string): FilterRef => ({ capability: "membership", field: "extra.labelIds", id });

const draft = (id: string): SourceFilter => ({
  sourceId: SOURCE,
  audience: { accessLevel: "level-1", capability: "direct" },
  rules: [{ match: [ref(id)], action: "hide" }],
  otherwise: "share",
});

function previewValue(visible: number): FilterEditorResult<SourceFilterPreview> {
  return {
    ok: true,
    value: {
      sourceId: SOURCE,
      connected: true,
      total: 10,
      visible,
      hidden: 10 - visible,
      tooOld: 0,
      unmatched: 0,
      tooOldText: null,
      unmatchedText: null,
      items: [],
    } as unknown as SourceFilterPreview,
  };
}

/** Every read the service needs; the slow ones wait for the test to release them. */
function reads() {
  const fieldCounts: Array<{ field: string; pass: Deferred<FilterFieldCounts | null> }> = [];
  const entryCounts: Array<{ refs: FilterRef[]; pass: Deferred<number[]> }> = [];
  const previews: Array<{
    filter: SourceFilter;
    pass: Deferred<FilterEditorResult<SourceFilterPreview>>;
  }> = [];
  const port = {
    sourceFilterEditor: vi.fn(async () => structure),
    sourceFilterFieldCounts: vi.fn((_sourceId: string, path: string) => {
      const pass = deferred<FilterFieldCounts | null>();
      fieldCounts.push({ field: path, pass });
      return pass.promise;
    }),
    sourceFilterOptionsPage: vi.fn(
      async (): Promise<FilterEditorResult<FilterOptions & { stamp: string }>> => ({
        ok: true,
        value: {
          sourceId: SOURCE,
          field: "extra.labelIds",
          items: [
            { ref: ref("L-1"), label: "Finance", shortLabel: "Finance" },
            { ref: ref("L-2"), label: "Clients", shortLabel: "Clients" },
          ],
          stamp: structure.stamp,
        } as unknown as FilterOptions & { stamp: string },
      }),
    ),
    sourceFilterEntryCounts: vi.fn((_sourceId: string, refs: FilterRef[]) => {
      const pass = deferred<number[]>();
      entryCounts.push({ refs, pass });
      return pass.promise;
    }),
    sourceFilterPreview: vi.fn((_sourceId: string, filter: SourceFilter) => {
      const pass = deferred<FilterEditorResult<SourceFilterPreview>>();
      previews.push({ filter, pass });
      return pass.promise;
    }),
    documentFilterDetails: vi.fn(async () => null),
    documentAccessAudit: vi.fn(async () => null),
    filterReadableDocumentIds: vi.fn(async () => []),
  };
  return {
    port: port as unknown as SourceFilterReads,
    spies: port,
    fieldCounts,
    entryCounts,
    previews,
  };
}

beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  structure = {
    sourceId: SOURCE,
    sourceType: "ledger",
    sourceName: "Ledger",
    devices: [{ id: "dev-laptop", name: "Laptop" }],
    showDeviceLevel: false,
    profile: "declared",
    profileText: null,
    connected: true,
    stamp: "stamp-1",
    fields: [
      field("extra.labelIds"),
      field("extra.folderIds", { capability: "tree", noun: FOLDER }),
    ],
  };
});

afterEach(() => vi.unstubAllEnvs());

describe("the editor", () => {
  test("returns at once with counts pending, then ready once the background pass lands", async () => {
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    const first = await service.editor(SOURCE);
    expect(first).toMatchObject({
      sourceId: SOURCE,
      connected: true,
      retryAfterMs: FILTER_COUNTS_RETRY_MS,
      fields: [
        { field: "extra.labelIds", counts: { status: "pending" } },
        { field: "extra.folderIds", counts: { status: "pending" } },
      ],
    });
    expect(first.resync).toBeUndefined();
    expect(fake.fieldCounts.map((pass) => pass.field)).toEqual([
      "extra.labelIds",
      "extra.folderIds",
    ]);
    // Asking again while the passes run starts nothing new.
    await service.editor(SOURCE);
    expect(fake.spies.sourceFilterFieldCounts).toHaveBeenCalledTimes(2);

    fake.fieldCounts[0]!.pass.resolve(counts(4));
    fake.fieldCounts[1]!.pass.resolve(null);
    await settle();
    const ready = await service.editor(SOURCE);
    expect(ready.retryAfterMs).toBeUndefined();
    expect(ready.fields.map((entry) => entry.counts)).toEqual([
      { status: "ready", ...counts(4) },
      { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null },
    ]);
    expect(fake.spies.sourceFilterFieldCounts).toHaveBeenCalledTimes(2);
  });

  test("takes the counts again when the account changes", async () => {
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    await service.editor(SOURCE);
    for (const pass of fake.fieldCounts) pass.pass.resolve(counts(1));
    await settle();
    expect((await service.editor(SOURCE)).retryAfterMs).toBeUndefined();

    structure = { ...structure, stamp: "stamp-2" };
    const changed = await service.editor(SOURCE);
    expect(changed.retryAfterMs).toBe(FILTER_COUNTS_RETRY_MS);
    expect(changed.fields.every((entry) => entry.counts.status === "pending")).toBe(true);
    expect(fake.spies.sourceFilterFieldCounts).toHaveBeenCalledTimes(4);
  });

  test("runs at most two background passes at once and starts the rest on a later request", async () => {
    structure.fields.push(field("extra.tagIds"));
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    await service.editor(SOURCE);
    expect(fake.fieldCounts.map((pass) => pass.field)).toEqual([
      "extra.labelIds",
      "extra.folderIds",
    ]);
    await service.editor(SOURCE);
    expect(fake.fieldCounts).toHaveLength(2);

    fake.fieldCounts[0]!.pass.resolve(counts(1));
    await settle();
    const next = await service.editor(SOURCE);
    expect(fake.fieldCounts.map((pass) => pass.field)).toEqual([
      "extra.labelIds",
      "extra.folderIds",
      "extra.tagIds",
    ]);
    expect(next.fields.map((entry) => entry.counts.status)).toEqual([
      "ready",
      "pending",
      "pending",
    ]);
  });

  test("retries a failed pass on the next request", async () => {
    structure.fields = [field("extra.labelIds")];
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    await service.editor(SOURCE);
    fake.fieldCounts[0]!.pass.reject(new Error("Synthetic worker failure"));
    await settle();
    const retried = await service.editor(SOURCE);
    expect(retried.fields[0]!.counts).toEqual({ status: "pending" });
    expect(fake.fieldCounts).toHaveLength(2);
    fake.fieldCounts[1]!.pass.resolve(counts(2));
    await settle();
    expect((await service.editor(SOURCE)).fields[0]!.counts).toEqual({
      status: "ready",
      ...counts(2),
    });
  });

  test("polls while a resync runs and says one sentence for every field waiting on it", async () => {
    structure.fields = [
      field("extra.labelIds", {
        state: { status: "needs-resync", cost: "This reads about 95,000 entries a day.", text: "" },
      }),
      field("extra.folderIds", {
        capability: "tree",
        noun: FOLDER,
        state: { status: "needs-resync", cost: null, text: "" },
      }),
    ];
    const fake = reads();
    const service = new SourceFilterService(fake.port, undefined, () => "entries");
    const editor = await service.editor(SOURCE);
    expect(editor.resync).toMatchObject({
      state: "needs-resync",
      fields: ["extra.labelIds", "extra.folderIds"],
      text: expect.stringContaining("Ledger"),
    });
    expect(editor.resync!.text).toContain("entries");

    structure.fields = [
      field("extra.labelIds", {
        state: { status: "resyncing", processed: 3, total: 10, text: "" },
      }),
    ];
    for (const pass of fake.fieldCounts) pass.pass.resolve(counts(0));
    await settle();
    const resyncing = await service.editor(SOURCE);
    expect(resyncing.resync).toMatchObject({ state: "resyncing", processed: 3, total: 10 });
    expect(resyncing.retryAfterMs).toBe(FILTER_COUNTS_RETRY_MS);
  });

  test("names a gone account's saved entries at once and counts nothing", async () => {
    structure = {
      ...structure,
      connected: false,
      stamp: "",
      fields: [field("extra.labelIds", { state: { status: "disconnected", text: "Gone." } })],
    };
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    const editor = await service.editor(SOURCE);
    expect(editor).toMatchObject({
      connected: false,
      fields: [{ counts: { status: "ready", tooOld: 0, unmatched: 0 } }],
    });
    expect(editor.retryAfterMs).toBeUndefined();
    expect(fake.spies.sourceFilterFieldCounts).not.toHaveBeenCalled();

    const preview = service.preview(SOURCE, draft("L-1"));
    await settle();
    fake.previews[0]!.pass.resolve(previewValue(0));
    expect(await preview).toMatchObject({ status: "ready", visible: 0 });
  });
});

describe("the picker and the preview", () => {
  test("options list at once with null counts, then the counts", async () => {
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    const request = { sourceId: SOURCE, field: "extra.labelIds" };
    const first = await service.options(request);
    expect(first.items.map((item) => item.count)).toEqual([null, null]);
    expect(first.retryAfterMs).toBe(FILTER_COUNTS_RETRY_MS);
    expect(fake.entryCounts[0]!.refs).toEqual([ref("L-1"), ref("L-2")]);
    fake.entryCounts[0]!.pass.resolve([7, 0]);
    await settle();
    const second = await service.options(request);
    expect(second.items.map((item) => item.count)).toEqual([7, 0]);
    expect(second.retryAfterMs).toBeUndefined();
    expect(fake.spies.sourceFilterEntryCounts).toHaveBeenCalledTimes(1);
  });

  test("a preview is pending, then ready for the same draft, and a new draft takes its own pass", async () => {
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    expect(await service.preview(SOURCE, draft("L-1"))).toEqual({
      status: "pending",
      retryAfterMs: FILTER_COUNTS_RETRY_MS,
    });
    fake.previews[0]!.pass.resolve(previewValue(8));
    await settle();
    expect(await service.preview(SOURCE, draft("L-1"))).toMatchObject({
      status: "ready",
      visible: 8,
    });
    expect((await service.preview(SOURCE, draft("L-2"))).status).toBe("pending");
    expect(fake.previews.map((pass) => pass.filter.rules[0].match[0])).toEqual([
      ref("L-1"),
      ref("L-2"),
    ]);
  });

  test("a preview the read refuses is a 400 naming the problem", async () => {
    const fake = reads();
    const service = new SourceFilterService(fake.port);
    await service.preview(SOURCE, draft("L-1"));
    fake.previews[0]!.pass.resolve({ ok: false, error: "invalid-filter" });
    await settle();
    await expect(service.preview(SOURCE, draft("L-1"))).rejects.toMatchObject({ status: 400 });
  });
});

describe("limits and availability", () => {
  test("interactive reads apply backpressure and release capacity after a worker failure", async () => {
    const fake = reads();
    const pending: Array<Deferred<SourceFilterEditorStructure>> = [];
    fake.spies.sourceFilterEditor.mockImplementation(() => {
      const read = deferred<SourceFilterEditorStructure>();
      pending.push(read);
      return read.promise;
    });
    const service = new SourceFilterService(fake.port);
    const calls = [1, 2, 3, 4].map(() => service.editor(SOURCE));
    await expect(service.editor(SOURCE)).rejects.toMatchObject({ status: 503 });
    expect(fake.spies.sourceFilterEditor).toHaveBeenCalledTimes(4);
    const failed = expect(calls[0]).rejects.toThrow("Synthetic worker failure");
    pending[0]!.reject(new Error("Synthetic worker failure"));
    await failed;
    const replacement = service.editor(SOURCE);
    expect(fake.spies.sourceFilterEditor).toHaveBeenCalledTimes(5);
    for (const read of pending.slice(1)) read.resolve(structure);
    for (const result of await Promise.all([...calls.slice(1), replacement]))
      expect(result.sourceId).toBe(SOURCE);
  });

  test("without a read worker the screens are unavailable, and without filter editing they are not found", async () => {
    await expect(new SourceFilterService(undefined).editor(SOURCE)).rejects.toMatchObject({
      status: 503,
    });
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    const fake = reads();
    await expect(new SourceFilterService(fake.port).editor(SOURCE)).rejects.toMatchObject({
      status: 404,
    });
    const saved = new SourceFilterService(fake.port, (id) => id === SOURCE);
    expect((await saved.editor(SOURCE)).sourceId).toBe(SOURCE);
  });

  test("the identifier check returns the canonical identifier or the sentence to show", () => {
    const service = new SourceFilterService(undefined);
    expect(service.identifier("phone", "00 1 (555) 010-0142")).toEqual({
      identifier: { type: "phone", value: "+15550100142" },
    });
    expect(service.identifier("phone", "+44 (0)7700 900123")).toEqual({
      error: "Enter a valid phone number. Include the international country code.",
    });
  });
});
