// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  AudioRejectedError,
  MAX_TRANSCRIBE_AUDIO_BYTES,
  type AudioTranscribeFn,
} from "@omnesis/core";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { PlaudClient } from "./client.js";
import { EU_BASE, FakePlaud } from "./fake-plaud.js";
import { PlaudRecordingsSource } from "./recordings.js";
import { plaudRecordingsStateSpec } from "./state.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { PlaudRecordingsCursor } from "./types.js";

const EMAIL = "maya.reeves@example.com";
const DAY = 24 * 60 * 60 * 1000;

type Result = StructuredSyncResult<PlaudRecordingsCursor>;

function setup(
  opts: {
    transcribe?: AudioTranscribeFn | null;
    dataCutoff?: string;
    pageSize?: number;
  } = {},
) {
  const fake = new FakePlaud();
  const clock = { now: Date.UTC(2026, 10, 1, 8) };
  const client = new PlaudClient(
    EU_BASE,
    { accessToken: fake.accessToken, refreshToken: fake.refreshToken },
    {
      fetchImpl: fake.fetch,
      nowSeconds: () => 1_900_000_000,
      listingPageSize: 2,
    },
  );
  const transcribe =
    opts.transcribe === null
      ? undefined
      : (opts.transcribe ??
        vi.fn<AudioTranscribeFn>(async (bytes) => ({
          text: `Heard ${bytes.length} bytes`,
          language: "en",
        })));
  const source = new PlaudRecordingsSource(
    client,
    ProviderId(`plaud:${EMAIL}`),
    SourceId(`plaud-recordings:${EMAIL}`),
    EMAIL,
    opts.dataCutoff,
    transcribe,
    { pageSize: opts.pageSize ?? 2, now: () => new Date(clock.now).toISOString() },
  );
  return { fake, source, clock, transcribe };
}

/** A fresh source instance (and so a fresh client) over the same fake. */
function plaudRecordingsSourceFor(fake: FakePlaud, clock: { now: number }): PlaudRecordingsSource {
  return new PlaudRecordingsSource(
    new PlaudClient(EU_BASE, { accessToken: fake.accessToken }, { fetchImpl: fake.fetch }),
    ProviderId(`plaud:${EMAIL}`),
    SourceId(`plaud-recordings:${EMAIL}`),
    EMAIL,
    undefined,
    undefined,
    { now: () => new Date(clock.now).toISOString() },
  );
}

/** Run one tick: keep paging while the source says there is more. */
async function tick(
  source: PlaudRecordingsSource,
  cursor: PlaudRecordingsCursor | null,
): Promise<{ pages: Result[]; cursor: PlaudRecordingsCursor }> {
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

const docs = (pages: Result[]) => pages.flatMap((p) => p.documents ?? []);
const ids = (pages: Result[]) =>
  docs(pages)
    .map((d) => d.externalId)
    .sort();
const presence = (pages: Result[]) => pages.map((p) => p.presentExternalIds?.slice().sort());
const audioRequests = (fake: FakePlaud) =>
  fake.requests.filter((r) => r.includes("storage.example.com/audio/"));

describe("PlaudRecordingsSource", () => {
  test("the first sweep renders every recording and names them present only on its last page", async () => {
    const { fake, source } = setup();
    fake.addRecording({ id: "a", serial_number: "SN-0001" });
    fake.addRecording({ id: "b", is_summary: true, summary: { ai_content: "Budget review." } });
    fake.addRecording({ id: "c" });

    const { pages, cursor } = await tick(source, null);

    expect(pages).toHaveLength(2);
    expect(ids(pages)).toEqual(["a", "b", "c"]);
    expect(presence(pages)).toEqual([undefined, ["a", "b", "c"]]);
    expect(cursor.pending).toBeUndefined();
    expect(Object.keys(cursor.known ?? {}).sort()).toEqual(["a", "b", "c"]);
    const a = docs(pages).find((d) => d.externalId === "a")!;
    expect(a.content).toBe("## Transcript\n\nHeard 4 bytes");
    expect(a.metadata.extra).toMatchObject({ device: "Desk recorder", transcriptSource: "local" });
    const b = docs(pages).find((d) => d.externalId === "b")!;
    expect(b.content).toContain("## Summary\n\nBudget review.");
  });

  test("an unchanged account renders nothing and downloads nothing", async () => {
    const { fake, source } = setup();
    fake.addRecording({ id: "a" });
    const first = await tick(source, null);
    fake.requests.length = 0;

    const again = await tick(source, first.cursor);

    expect(docs(again.pages)).toEqual([]);
    expect(
      fake.requests.every((r) => r.includes("/file/simple/web") || r.includes("workspace")),
    ).toBe(true);
    expect(again.cursor).toEqual(first.cursor);
  });

  test("an edited and a new recording are rendered on the next sync, alone", async () => {
    const { fake, source } = setup();
    fake.addRecording({ id: "a" });
    fake.addRecording({ id: "b" });
    const first = await tick(source, null);

    fake.edit("a", { filename: "Renamed" });
    fake.addRecording({ id: "c" });
    const next = await tick(source, first.cursor);

    expect(ids(next.pages)).toEqual(["a", "c"]);
    expect(docs(next.pages).find((d) => d.externalId === "a")?.title).toBe("Renamed");
    // Not yet a day since the last snapshot: nothing is named present.
    expect(presence(next.pages)).toEqual([undefined]);
  });

  test("a recording Plaud finishes later is rendered again with its transcript", async () => {
    const { fake, source } = setup({ transcribe: null });
    fake.addRecording({ id: "a", transcript: [{ speaker: "Maya", content: "Morning." }] });
    const first = await tick(source, null);
    expect(docs(first.pages)[0]?.metadata.extra).toMatchObject({ transcriptSource: "none" });

    // Plaud finishing its transcript does not move the recording's version.
    fake.recordings.get("a")!.is_trans = true;
    const next = await tick(source, first.cursor);

    expect(docs(next.pages)[0]?.content).toBe("## Transcript\n\nMaya: Morning.");
    expect(docs(next.pages)[0]?.metadata.extra).toMatchObject({ transcriptSource: "plaud" });
  });

  describe("transcript", () => {
    const withPlaudTranscript = (fake: FakePlaud, id: string, extra = {}) =>
      fake.addRecording({
        id,
        is_trans: true,
        transcript: [
          { start_time: 2000, speaker: "Speaker 1", content: "words transcribed upstream." },
        ],
        ...extra,
      });

    test("without a transcriber, Plaud's is used and no audio is downloaded", async () => {
      const { fake, source } = setup({ transcribe: null });
      withPlaudTranscript(fake, "a");
      const { pages } = await tick(source, null);
      expect(docs(pages)[0]?.content).toBe(
        "## Transcript\n\n[00:00:02] Speaker 1: words transcribed upstream.",
      );
      expect(audioRequests(fake)).toEqual([]);
    });

    test("when no transcriber can run, Plaud's stands in and the page stops downloading audio", async () => {
      const transcribe = vi.fn<AudioTranscribeFn>(async () => null);
      const { fake, source } = setup({ transcribe });
      withPlaudTranscript(fake, "a");
      withPlaudTranscript(fake, "b");
      const { pages } = await tick(source, null);
      expect(docs(pages).map((d) => d.metadata.extra?.transcriptSource)).toEqual([
        "plaud",
        "plaud",
      ]);
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(audioRequests(fake)).toHaveLength(1);
    });

    test("a recording larger than the transcriber accepts is not downloaded", async () => {
      const { fake, source, transcribe } = setup();
      withPlaudTranscript(fake, "a", { audio: new Uint8Array(MAX_TRANSCRIBE_AUDIO_BYTES + 1) });
      const { pages } = await tick(source, null);
      expect(docs(pages)[0]?.metadata.extra).toMatchObject({ transcriptSource: "plaud" });
      expect(transcribe).not.toHaveBeenCalled();
    });

    test("audio the transcriber rejects falls back to Plaud's transcript", async () => {
      const transcribe = vi.fn<AudioTranscribeFn>(async () => {
        throw new AudioRejectedError("unreadable", "no audio in it");
      });
      const { fake, source } = setup({ transcribe });
      withPlaudTranscript(fake, "a");
      const { pages } = await tick(source, null);
      expect(docs(pages)[0]?.metadata.extra).toMatchObject({ transcriptSource: "plaud" });
    });

    test("a transcriber that heard nothing falls back to Plaud's transcript", async () => {
      const { fake, source } = setup({
        transcribe: vi.fn<AudioTranscribeFn>(async () => ({ text: " " })),
      });
      withPlaudTranscript(fake, "a");
      const { pages } = await tick(source, null);
      expect(docs(pages)[0]?.metadata.extra).toMatchObject({ transcriptSource: "plaud" });
    });

    test("a transcriber outage fails the page without moving the cursor", async () => {
      const transcribe = vi.fn<AudioTranscribeFn>(async () => {
        throw new SyncError("transient", "transcriber unreachable");
      });
      const { fake, source } = setup({ transcribe });
      fake.addRecording({ id: "a" });
      await expect(source.syncStructured(null)).rejects.toThrow(/transcriber unreachable/);
    });

    test("an expired content link is renewed by asking for the detail again", async () => {
      const { fake, source } = setup({ transcribe: null });
      withPlaudTranscript(fake, "a");
      fake.expireNextLinks = 1;
      const { pages } = await tick(source, null);
      expect(docs(pages)[0]?.metadata.extra).toMatchObject({ transcriptSource: "plaud" });
      expect(fake.requests.filter((r) => r.includes("/file/detail/a"))).toHaveLength(2);
    });
  });

  describe("deletions", () => {
    test("a daily snapshot names only what Plaud still lists", async () => {
      const { fake, source, clock } = setup();
      fake.addRecording({ id: "a" });
      fake.addRecording({ id: "b" });
      const first = await tick(source, null);

      fake.recordings.delete("b");
      const sameDay = await tick(source, first.cursor);
      expect(presence(sameDay.pages)).toEqual([undefined]);

      clock.now += DAY;
      const nextDay = await tick(source, sameDay.cursor);
      expect(presence(nextDay.pages)).toEqual([["a"]]);
      expect(Object.keys(nextDay.cursor.known ?? {})).toEqual(["a"]);
      expect(nextDay.cursor.lastSnapshotAt).toBe(new Date(clock.now).toISOString());
    });

    test("a listing that moved while it was read deletes nothing and waits a day", async () => {
      const { fake, source, clock } = setup();
      fake.addRecording({ id: "a" });
      const first = await tick(source, null);
      clock.now += DAY;
      fake.totalSkew = 1;

      const skewed = await tick(source, first.cursor);

      expect(presence(skewed.pages)).toEqual([undefined]);
      expect(skewed.cursor.lastSnapshotAt).toBe(new Date(clock.now).toISOString());
    });

    test("a recording Plaud cannot serve is skipped, reported, and tried again", async () => {
      const { fake, source } = setup();
      fake.addRecording({ id: "a" });
      fake.addRecording({ id: "b" });
      fake.failNext = { match: "/file/detail/a", status: 404 };

      const first = await tick(source, null);
      expect(ids(first.pages)).toEqual(["b"]);
      // Listed, so still present: a failed read never deletes.
      expect(presence(first.pages)).toEqual([["a", "b"]]);
      expect(first.pages.at(-1)?.issues).toMatchObject([
        { code: "plaud-unreadable-recording", count: 1, subject: "a" },
      ]);

      const retry = await tick(source, first.cursor);
      expect(ids(retry.pages)).toEqual(["a"]);
    });
  });

  describe("trusting a listing with absence", () => {
    test("two listings that disagree delete nothing", async () => {
      const { fake, source } = setup();
      fake.addRecording({ id: "a" });
      // Between the two listings of the first sweep, one recording goes and
      // another arrives: each listing is consistent on its own.
      fake.onListing = (started) => {
        if (started !== 1) return;
        fake.recordings.delete("a");
        fake.addRecording({ id: "b" });
      };
      const { pages } = await tick(source, null);
      expect(presence(pages)).toEqual([undefined]);
    });

    test("a listing read under another scope than before deletes nothing", async () => {
      const { fake, source, clock } = setup();
      fake.addRecording({ id: "a" });
      const first = await tick(source, null);
      expect(first.cursor.listingScope).toBe("workspace:personal-1");

      clock.now += DAY;
      fake.mintFailure = 500;
      const next = await tick(plaudRecordingsSourceFor(fake, clock), first.cursor);
      expect(presence(next.pages)).toEqual([undefined]);
      expect(next.cursor.listingScope).toBe("user");
    });
  });

  test("a failure on an early page is still reported when the sweep completes", async () => {
    const { fake, source } = setup({ pageSize: 1 });
    fake.addRecording({ id: "a" });
    fake.addRecording({ id: "b" });
    fake.addRecording({ id: "c" });
    // The listing is newest first: "c" renders on the first page.
    fake.failNext = { match: "/file/detail/c", status: 404 };
    const { pages } = await tick(source, null);
    expect(pages).toHaveLength(3);
    expect(pages.at(-1)?.issues).toMatchObject([{ count: 1, subject: "c" }]);
  });

  test("audio whose fresh link is refused too skips that recording, not the source", async () => {
    const { fake, source } = setup();
    fake.addRecording({ id: "a" });
    fake.addRecording({ id: "b" });
    // Each audio request hands out two links (MP3 and Opus): expire both
    // renditions of the first link and of its renewal.
    fake.expireNextLinks = 4;
    const { pages } = await tick(source, null);
    expect(ids(pages)).toHaveLength(1);
    expect(pages.at(-1)?.issues).toMatchObject([{ count: 1 }]);
  });

  test("once no transcriber can run, the rest of the sweep downloads no audio", async () => {
    const transcribe = vi.fn<AudioTranscribeFn>(async () => null);
    const { fake, source } = setup({ transcribe, pageSize: 1 });
    for (const id of ["a", "b", "c"]) fake.addRecording({ id });
    await tick(source, null);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(audioRequests(fake)).toHaveLength(1);
  });

  describe("transcripts already made", () => {
    test("an edit that leaves the audio alone is not transcribed again", async () => {
      const { fake, source, transcribe } = setup();
      fake.addRecording({ id: "a" });
      const first = await tick(source, null);
      fake.edit("a", { filename: "Renamed", is_summary: true, summary: "Short." });

      const next = await tick(source, first.cursor);

      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(audioRequests(fake)).toHaveLength(1);
      expect(docs(next.pages)[0]?.content).toContain("## Transcript\n\nHeard 4 bytes");
      expect(docs(next.pages)[0]?.title).toBe("Renamed");
    });

    test("changed audio is transcribed again", async () => {
      const { fake, source, transcribe } = setup();
      fake.addRecording({ id: "a" });
      const first = await tick(source, null);
      fake.edit("a", { duration: 60_000, audio: new Uint8Array(7) });

      const next = await tick(source, first.cursor);

      expect(transcribe).toHaveBeenCalledTimes(2);
      expect(docs(next.pages)[0]?.content).toContain("Heard 7 bytes");
    });
  });

  test("a recorder name that could not be looked up is filled in on the next sync", async () => {
    const { fake, source } = setup();
    fake.addRecording({ id: "a", serial_number: "SN-0001" });
    fake.failNext = { match: "/device/list", status: 503 };
    const first = await tick(source, null);
    expect(docs(first.pages)[0]?.metadata.extra).not.toHaveProperty("device");

    const next = await tick(source, first.cursor);
    expect(docs(next.pages)[0]?.metadata.extra).toMatchObject({ device: "Desk recorder" });
    const settled = await tick(source, next.cursor);
    expect(docs(settled.pages)).toEqual([]);
  });

  test("recordings started before the history cutoff are left out", async () => {
    const { fake, source } = setup({ dataCutoff: "2026-10-01T10:30:00.000Z" });
    fake.addRecording({ id: "old" });
    fake.addRecording({ id: "new" });
    const { pages } = await tick(source, null);
    expect(ids(pages)).toEqual(["new"]);
    expect(presence(pages).at(-1)).toEqual(["new"]);
  });

  test("the sign-in ending fails the sync as an auth failure on the connection", async () => {
    const { fake, source } = setup();
    fake.revokedAccessTokens.add(fake.accessToken);
    fake.mintFailure = 500;
    fake.refreshRefused = true;
    await expect(source.syncStructured(null)).rejects.toMatchObject({
      kind: "auth",
      scope: "connection",
    });
  });

  test("every cursor a sweep produces round-trips through the state spec", async () => {
    const { fake, source } = setup({ pageSize: 1 });
    fake.addRecording({ id: "a", keywords: ["budget"] });
    fake.addRecording({ id: "b" });
    const page1 = await source.syncStructured(null);
    expect(page1.hasMore).toBe(true);
    const settled = await tick(source, page1.cursor);
    for (const cursor of [page1.cursor, settled.cursor]) {
      const json = JSON.parse(JSON.stringify(cursor)) as unknown;
      expect(plaudRecordingsStateSpec.decode(json)).toEqual(cursor);
    }
    expect(plaudRecordingsStateSpec.decode({ pending: [{ id: "" }] })).toBeNull();
    expect(plaudRecordingsStateSpec.decode({ known: { a: 1 } })).toBeNull();
    // A presence ledger without the sweep it belongs to would vouch for a stale listing.
    expect(
      plaudRecordingsStateSpec.decode({ snapshot: page1.cursor.snapshot, known: {} }),
    ).toBeNull();
  });

  test("two accounts keep their own state", async () => {
    const one = setup();
    const two = setup();
    one.fake.addRecording({ id: "a" });
    two.fake.addRecording({ id: "z" });
    const [a, z] = await Promise.all([tick(one.source, null), tick(two.source, null)]);
    expect(ids(a.pages)).toEqual(["a"]);
    expect(ids(z.pages)).toEqual(["z"]);
  });

  test("an upstream that never changes settles and stops emitting", async () => {
    const { fake, source } = setup();
    fake.addRecording({ id: "a" });
    fake.addRecording({ id: "b", is_summary: true, summary: "Short." });
    fake.addRecording({ id: "c" });

    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      async step(cursor) {
        const { pages, cursor: next } = await tick(source, cursor as PlaudRecordingsCursor | null);
        const records = docs(pages).map((doc) => ({
          table: "documents",
          row: { externalId: doc.externalId, contentHash: doc.contentHash },
        }));
        return { records, cursor: next, hasMore: false };
      },
      primaryKey: () => ["externalId"],
      settleSteps: 3,
    });
  });
});
