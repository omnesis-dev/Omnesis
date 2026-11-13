// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
vi.mock("@omnesis/providers-synth-common", async (original) => ({
  ...(await original<typeof import("@omnesis/providers-synth-common")>()),
  loadActiveUniverse: () => ({ dir: fixtureState.universe }),
  personMention: (name: string, role: string) => ({ name, role }),
}));
const fixtureState = vi.hoisted(() => ({ entries: [] as EmailEntry[], universe: "" }));
vi.mock("./fixtures.js", async (original) => ({
  ...(await original<typeof import("./fixtures.js")>()),
  loadEmails: () => fixtureState.entries,
}));
import { mapEmail, type EmailEntry } from "./fixtures.js";
import { mapEmailWithAssets } from "./gmail-attachments.js";
import { createGmailFixtureSource } from "./gmail-source.js";
import google from "./index.js";

let universe: string;
const bytes = Buffer.from([0, 255, 128, 37, 80, 68, 70]);
const context = {
  sourceId: SourceId("gmail:owner@example.org"),
  providerId: ProviderId("google:owner@example.org"),
};
const entry = (externalId = "original"): EmailEntry => ({
  externalId,
  subject: "Original proof",
  from: "author",
  fromEmail: "author@example.org",
  to: ["self"],
  toEmails: ["owner@example.org"],
  body: "Original proof is attached.",
  sentAt: "2026-01-02T12:00:00Z",
  threadId: "proof-thread",
  labels: ["INBOX"],
  attachments: [{ filename: "scan.pdf", mimeType: "application/pdf", assetPath: "scan.pdf" }],
});
const config = () =>
  resolveAttachmentConfig(undefined, { defaultEnabled: true, includeAudioTypes: true });
beforeEach(() => {
  universe = mkdtempSync(join(tmpdir(), "synthetic-gmail-assets-"));
  fixtureState.universe = universe;
  writeFileSync(join(universe, "scan.pdf"), bytes);
});
afterEach(() => {
  rmSync(universe, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("real binary bytes reach the injected host, preserving extraction provenance and stable parent links", async () => {
  const extract = vi.fn(async (received: Uint8Array, mime: string) => {
    expect(Buffer.from(received)).toEqual(bytes);
    expect(mime).toBe("application/pdf");
    return { text: "Invented original proof", truncated: true, pages: 1, extra: { ocr: true } };
  });
  const docs = await mapEmailWithAssets(entry(), context, {
    universeDir: universe,
    extractAttachment: extract,
    attachmentConfig: config(),
  });
  expect(extract).toHaveBeenCalledTimes(1);
  expect(docs).toHaveLength(2);
  expect(Array.isArray(docs) && docs[1]?.metadata.extra).toMatchObject({
    ocr: true,
    truncated: true,
    pages: 1,
    parentExternalId: "original",
    sizeBytes: bytes.length,
  });
  expect(Array.isArray(docs) && docs[1]?.content).toBe("Invented original proof");
  expect(() => mapEmail(entry(), context)).toThrow("host extraction");
});

test("legacy pre-extracted fixture shape remains unchanged", async () => {
  const legacy = {
    ...entry(),
    attachments: [
      {
        filename: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        extractedText: "Invented note",
      },
    ],
  };
  const extract = vi.fn();
  expect(await mapEmailWithAssets(legacy, context, { extractAttachment: extract })).toEqual(
    mapEmail(legacy, context),
  );
  expect(extract).not.toHaveBeenCalled();
});

test("disabled extraction does not read missing assets or claim successful extraction", async () => {
  rmSync(join(universe, "scan.pdf"));
  const extract = vi.fn();
  const docs = await mapEmailWithAssets(entry(), context, {
    universeDir: universe,
    extractAttachment: extract,
    attachmentConfig: { ...config(), enabled: false },
  });
  expect(docs).toHaveLength(1);
  expect(Array.isArray(docs) && docs[0]?.metadata.extra?.attachments).toMatchObject([
    { extracted: false },
  ]);
  expect(extract).not.toHaveBeenCalled();
});

test.each([null, { text: "", truncated: false, noText: true as const }])(
  "no extraction content never fabricates a child: %j",
  async (result) => {
    const docs = await mapEmailWithAssets(entry(), context, {
      universeDir: universe,
      extractAttachment: async () => result,
      attachmentConfig: config(),
    });
    expect(docs).toHaveLength(1);
    expect(Array.isArray(docs) && docs[0]?.metadata.extra?.attachments).toMatchObject([
      { extracted: false },
    ]);
  },
);

test("permanent failures remain truthful while transient host failure fails the page", async () => {
  const options = { universeDir: universe, attachmentConfig: config() };
  const failed = await mapEmailWithAssets(entry(), context, {
    ...options,
    extractAttachment: async () => {
      throw new Error("Invalid fixture media");
    },
  });
  expect(failed).toHaveLength(1);
  await expect(
    createGmailFixtureSource([entry()], context, {
      ...options,
      extractAttachment: async () => {
        throw new SyncError("transient", "Fixture service unavailable");
      },
    }).sync(null),
  ).rejects.toMatchObject({ kind: "transient" });
});

test("rejects a binary fixture with invented extracted text or a false declared byte size", async () => {
  const e = entry();
  await expect(
    mapEmailWithAssets(
      { ...e, attachments: [{ ...e.attachments![0]!, extractedText: "Pretend text" }] },
      context,
      { universeDir: universe },
    ),
  ).rejects.toThrow("pre-extracted");
  await expect(
    mapEmailWithAssets(
      { ...e, attachments: [{ ...e.attachments![0]!, sizeBytes: bytes.length + 1 }] },
      context,
      { universeDir: universe },
    ),
  ).rejects.toThrow("declared size");
});

test("duplicate binary names have distinct stable child identities", async () => {
  const e = entry();
  e.attachments!.push({ ...e.attachments![0]! });
  const docs = await mapEmailWithAssets(e, context, {
    universeDir: universe,
    attachmentConfig: config(),
    extractAttachment: async () => ({ text: "Invented proof", truncated: false }),
  });
  expect(Array.isArray(docs) && new Set(docs.map((doc) => doc.externalId)).size).toBe(3);
});

test("extracts only current-page assets and resumes full snapshots without replaying older pages", async () => {
  vi.stubEnv("OMNESIS_SYNTH_BATCH_SIZE", "2");
  const entries = [entry("one"), entry("two"), entry("three")];
  const extract = vi.fn(async () => ({ text: "Invented proof", truncated: false }));
  const options = { universeDir: universe, extractAttachment: extract, attachmentConfig: config() };
  const first = await createGmailFixtureSource(entries, context, options).sync(null);
  expect(extract).toHaveBeenCalledTimes(2);
  expect(first.documents).toHaveLength(4);
  expect(first.presentExternalIds).toBeUndefined();
  const resumed = createGmailFixtureSource(entries, context, options);
  const final = await resumed.sync(first.cursor);
  expect(extract).toHaveBeenCalledTimes(3);
  expect(final.presentExternalIds?.sort()).toEqual(
    [...first.documents, ...final.documents].map((doc) => doc.externalId).sort(),
  );
  const idle = await createGmailFixtureSource(entries, context, options).sync(final.cursor);
  expect(extract).toHaveBeenCalledTimes(3);
  expect(idle.documents).toEqual([]);
  expect(idle.presentExternalIds?.slice().sort()).toEqual(final.presentExternalIds?.slice().sort());
});

test("degraded reads withhold whole-source snapshots, partitioned reads claim only readable evidence", async () => {
  const entries = [entry("one"), entry("two"), entry("three"), entry("four")];
  const options = {
    universeDir: universe,
    extractAttachment: async () => ({ text: "Invented proof", truncated: false }),
    attachmentConfig: config(),
  };
  vi.stubEnv("OMNESIS_SYNTH_READ_IMPAIRMENT", "*:degraded:1");
  const degraded = await createGmailFixtureSource(entries, context, options).sync(null);
  expect(degraded.presentExternalIds).toBeUndefined();
  vi.stubEnv("OMNESIS_SYNTH_READ_IMPAIRMENT", "*:partitioned:0");
  const partitioned = await createGmailFixtureSource(entries, context, options).sync(null);
  expect(partitioned.presentExternalIds).toBeUndefined();
  expect(partitioned.presentClaims).toHaveLength(1);
  expect(partitioned.presentClaims?.[0]?.ids.sort()).toEqual(
    partitioned.documents.map((doc) => doc.externalId).sort(),
  );
});

test("provider factory routes binary audio through the host instead of legacy text mapping", async () => {
  writeFileSync(join(universe, "voice.wav"), bytes);
  const audio = entry();
  audio.attachments = [{ filename: "voice.wav", mimeType: "audio/wav", assetPath: "voice.wav" }];
  fixtureState.entries = [audio];
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", universe);
  const extract = vi.fn(async (received: Uint8Array, mime: string) => {
    expect(Buffer.from(received)).toEqual(bytes);
    expect(mime).toBe("audio/wav");
    return { text: "Invented spoken commitment", truncated: false, extra: { transcribed: true } };
  });
  const instance = await google.sources.find((source) => source.id === "gmail")!.create!(
    {
      ...context,
      accountId: "owner@example.org",
      sourceConfig: {},
      host: { includeAudioTypes: true, extractAttachment: extract },
    } as never,
    {},
  );
  const result = await instance.sync(null);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(result.documents[1]?.metadata.extra).toMatchObject({
    transcribed: true,
    mimeType: "audio/wav",
  });
});

test("an inherited completed offset cannot delete genuine binary children with an unknown inventory", async () => {
  const entries = [entry("one"), entry("two")];
  const extract = vi.fn(async () => ({ text: "Invented proof", truncated: false }));
  const options = { universeDir: universe, extractAttachment: extract, attachmentConfig: config() };
  const idle = await createGmailFixtureSource(entries, context, options).sync({
    offset: entries.length,
  });
  expect(idle.documents).toEqual([]);
  expect(idle.presentExternalIds).toBeUndefined();
  expect(idle.presentClaims).toBeUndefined();
  expect(extract).not.toHaveBeenCalled();
  const resumed = await createGmailFixtureSource(entries, context, options).sync(idle.cursor);
  expect(resumed.presentExternalIds).toBeUndefined();
  const bootstrap = await createGmailFixtureSource(entries, context, options).sync(null);
  expect(bootstrap.presentExternalIds?.sort()).toEqual(
    bootstrap.documents.map((doc) => doc.externalId).sort(),
  );
});

test("partitioned bootstrap cannot claim newly visible skipped binary parents after recovery", async () => {
  const entries = [entry("one"), entry("two"), entry("three"), entry("four")];
  const extract = vi.fn(async () => ({ text: "Invented proof", truncated: false }));
  const options = { universeDir: universe, extractAttachment: extract, attachmentConfig: config() };
  vi.stubEnv("OMNESIS_SYNTH_READ_IMPAIRMENT", "*:partitioned:0");
  const partial = await createGmailFixtureSource(entries, context, options).sync(null);
  expect(partial.presentClaims).toHaveLength(1);
  vi.unstubAllEnvs();
  const recovered = await createGmailFixtureSource(entries, context, options).sync(partial.cursor);
  expect(recovered.presentExternalIds).toBeUndefined();
  expect(recovered.presentClaims).toBeUndefined();
  expect(extract).toHaveBeenCalledTimes(
    partial.documents.length / 2 + recovered.documents.length / 2,
  );
});

test("changed attachment definitions invalidate earlier parent inventory without snapshot extraction", async () => {
  const entries = [entry("one")];
  const extract = vi.fn(async () => ({ text: "", truncated: false, noText: true as const }));
  const options = { universeDir: universe, extractAttachment: extract, attachmentConfig: config() };
  const first = await createGmailFixtureSource(entries, context, options).sync(null);
  expect(first.presentExternalIds).toEqual(["one"]);
  entries[0]!.attachments!.push({ ...entries[0]!.attachments![0]!, filename: "second.pdf" });
  const resumed = await createGmailFixtureSource(entries, context, options).sync(first.cursor);
  expect(resumed.presentExternalIds).toBeUndefined();
  expect(extract).toHaveBeenCalledTimes(1);
});

test("temporary impairment preserves known child inventory for subsequent healthy snapshots", async () => {
  const entries = [entry("one"), entry("two"), entry("three"), entry("four")];
  const extract = vi.fn(async () => ({ text: "Invented proof", truncated: false }));
  const options = { universeDir: universe, extractAttachment: extract, attachmentConfig: config() };
  const first = await createGmailFixtureSource(entries, context, options).sync(null);
  vi.stubEnv("OMNESIS_SYNTH_READ_IMPAIRMENT", "*:partitioned:0");
  const partial = await createGmailFixtureSource(entries, context, options).sync(first.cursor);
  vi.unstubAllEnvs();
  const recovered = await createGmailFixtureSource(entries, context, options).sync(partial.cursor);
  expect(recovered.presentExternalIds?.slice().sort()).toEqual(
    first.presentExternalIds?.slice().sort(),
  );
  expect(extract).toHaveBeenCalledTimes(4 + recovered.documents.length / 2);
});
