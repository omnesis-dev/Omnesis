// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins every entry of the declared `documentEventProfile` to a document the
 * real sync path produces — a declared field or role nobody emits compiles a
 * watch condition that can never fire — and checks the rest of the
 * descriptor's presentation contract.
 */

import { describe, expect, test } from "vitest";
import {
  checkContractCompatibility,
  encodeSourceState,
  validateDocumentEventProfile,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { PlaudClient } from "./client.js";
import { EU_BASE, FakePlaud } from "./fake-plaud.js";
import { fingerprint, MAX_SNAPSHOT_ITEMS, PlaudRecordingsSource } from "./recordings.js";
import { plaudRecordingsStateSpec } from "./state.js";
import plaudProvider from "./index.js";
import type { DocumentInput } from "@omnesis/types";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { FileSummary } from "./schemas.js";
import type { PlaudRecordingsCursor } from "./types.js";

const definition = plaudProvider.sources[0]!;
const profile = definition.documentEventProfile!;

/** One document from each transcript path, so every declared field is written by one of them. */
async function syncedDocuments(): Promise<DocumentInput[]> {
  const out: DocumentInput[] = [];
  for (const transcribe of [undefined, async () => ({ text: "Shall we start?", language: "en" })]) {
    const fake = new FakePlaud();
    fake.addRecording({
      id: "rec-1",
      serial_number: "SN-0001",
      keywords: ["budget"],
      is_trans: true,
      is_summary: true,
      transcript: [{ start_time: 0, speaker: "Speaker 1", content: "Shall we start?" }],
      summary: { ai_content: "Q4 budget review." },
    });
    const source = new PlaudRecordingsSource(
      new PlaudClient(EU_BASE, { accessToken: fake.accessToken }, { fetchImpl: fake.fetch }),
      ProviderId("plaud:maya.reeves@example.com"),
      SourceId("plaud-recordings:maya.reeves@example.com"),
      "maya.reeves@example.com",
      undefined,
      transcribe,
    );
    const page = await source.syncStructured(null);
    out.push(page.documents![0]!);
  }
  return out;
}

const TYPE_CHECKS: Record<DocumentMetadataFieldSpec["type"], (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  "string-array": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

const at = (doc: DocumentInput, path: string) =>
  path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], doc.metadata);

describe("plaud-recordings descriptor", () => {
  test("the profile is valid", () => {
    expect(() => validateDocumentEventProfile(profile, "provider-plaud")).not.toThrow();
  });

  test("declares exactly the document types and roles the sync emits", async () => {
    for (const doc of await syncedDocuments()) {
      expect(profile.documentTypes).toEqual([doc.metadata.documentType]);
      expect(new Set(profile.personRoles)).toEqual(
        new Set(doc.metadata.people!.map((p) => p.role)),
      );
    }
  });

  test("every declared metadata field is written with its declared type", async () => {
    const docs = await syncedDocuments();
    for (const field of profile.metadataFields ?? []) {
      const values = docs.map((d) => at(d, field.path)).filter((v) => v !== undefined);
      expect(values.length, field.path).toBeGreaterThan(0);
      for (const v of values) expect(TYPE_CHECKS[field.type](v), field.path).toBe(true);
    }
  });

  test("every metadata field the sync writes is declared", async () => {
    const declared = new Set((profile.metadataFields ?? []).map((f) => f.path));
    for (const doc of await syncedDocuments()) {
      for (const key of Object.keys(doc.metadata.extra ?? {})) {
        expect(declared.has(`extra.${key}`), key).toBe(true);
      }
    }
  });

  test("carries a complete icon, a unit noun, and is experimental and conversational", () => {
    expect(definition.icon).toEqual(
      expect.objectContaining({
        sfSymbol: expect.any(String),
        color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        imageDataUri: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      }),
    );
    expect(definition.unitName).toBe("recordings");
    expect(plaudProvider.experimental).toBe(true);
    expect(definition.conversational).toBe(true);
  });

  test("this host accepts its contract", () => {
    expect(checkContractCompatibility(definition.contract, "plaud-recordings")).toBeNull();
  });

  test("a cursor for the largest account a sweep accepts fits the state ceiling", () => {
    // A first sweep just started over the largest listing: every recording
    // pending with a long title and keywords, in the ledger, and known.
    const files: FileSummary[] = Array.from({ length: MAX_SNAPSHOT_ITEMS }, (_, i) => ({
      id: `0123456789abcdef0123456789ab${String(i).padStart(6, "0")}`,
      filename: "A fairly long recording title for a weekly planning meeting with notes",
      filesize: 12_345_678,
      start_time: 1_790_000_000_000 + i,
      end_time: 1_790_003_600_000 + i,
      duration: 3_600_000,
      edit_time: 1_790_003_700,
      version_ms: 1_790_003_700_000,
      serial_number: "8810B30227298497",
      filetag_id_list: ["0123456789abcdef"],
      keywords: ["budget", "planning", "travel", "hiring", "roadmap"],
      is_trash: false,
      is_trans: true,
      is_summary: true,
    }));
    const cursor: PlaudRecordingsCursor = {
      known: Object.fromEntries(files.map((f) => [f.id, fingerprint(f)])),
      pending: files,
      lastSnapshotAt: "2026-11-01T08:00:00.000Z",
      snapshot: { ids: { recordings: files.map((f) => f.id) } },
    };
    const bytes = Buffer.byteLength(
      JSON.stringify(encodeSourceState(plaudRecordingsStateSpec, cursor)),
    );
    expect(bytes).toBeLessThan(plaudRecordingsStateSpec.maxBytes!);
  });
});
