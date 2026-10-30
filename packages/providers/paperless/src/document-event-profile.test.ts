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
import { PaperlessClient } from "./client.js";
import { PaperlessDocumentsSource } from "./documents.js";
import { FAKE_BASE_URL, FAKE_TOKEN, FakePaperless } from "./fake-paperless.js";
import { paperlessDocumentsStateSpec } from "./state.js";
import paperlessProvider from "./index.js";
import type { PaperlessDocumentsCursor } from "./types.js";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";

const definition = paperlessProvider.sources[0]!;
const profile = definition.documentEventProfile!;

async function syncedDocument() {
  const fake = new FakePaperless();
  fake.tags.set(1, { id: 1, name: "Tax" });
  fake.correspondents.set(10, { id: 10, name: "Riverside Clinic" });
  fake.documentTypes.set(20, { id: 20, name: "Receipt" });
  fake.addDocument({
    id: 1,
    correspondent: 10,
    document_type: 20,
    tags: [1],
    archive_serial_number: 77,
  });
  const source = new PaperlessDocumentsSource(
    new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, { fetchImpl: fake.fetch }),
    ProviderId("paperless:maya@paperless.example.com-8000"),
    SourceId("paperless-documents:maya@paperless.example.com-8000"),
    "maya@paperless.example.com-8000",
    undefined,
  );
  const page = await source.syncStructured(null);
  return page.documents![0]!;
}

const TYPE_CHECKS: Record<DocumentMetadataFieldSpec["type"], (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  "string-array": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

describe("paperless-documents descriptor", () => {
  test("the profile is valid", () => {
    expect(() => validateDocumentEventProfile(profile, "provider-paperless")).not.toThrow();
  });

  test("declares exactly the document types and roles the sync emits", async () => {
    const doc = await syncedDocument();
    expect(profile.documentTypes).toEqual([doc.metadata.documentType]);
    expect(new Set(profile.personRoles)).toEqual(new Set(doc.metadata.people!.map((p) => p.role)));
  });

  test("every declared metadata field is written with its declared type", async () => {
    const doc = await syncedDocument();
    for (const field of profile.metadataFields ?? []) {
      const value = field.path
        .split(".")
        .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], doc.metadata);
      expect(value, field.path).toBeDefined();
      expect(TYPE_CHECKS[field.type](value), field.path).toBe(true);
    }
  });

  test("every metadata field the sync writes is declared", async () => {
    // The other direction: an undeclared field is absent from the watch journal.
    const doc = await syncedDocument();
    const declared = new Set((profile.metadataFields ?? []).map((f) => f.path));
    const written = [
      ...(doc.metadata.tags ? ["tags"] : []),
      ...Object.keys(doc.metadata.extra ?? {}).map((key) => `extra.${key}`),
    ];
    for (const path of written) expect(declared.has(path), path).toBe(true);
  });

  test("carries a complete icon, a unit noun and the experimental gate", () => {
    expect(definition.icon).toEqual(
      expect.objectContaining({
        sfSymbol: expect.any(String),
        color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        url: expect.stringMatching(/^https:\/\//),
      }),
    );
    expect(definition.unitName).toBe("documents");
    expect(definition.experimental).toBe(true);
  });

  test("declares the host generation and capability it needs, and an older host refuses it", () => {
    const contract = definition.contract;
    expect(contract?.apiVersion).toBe(2);
    expect(checkContractCompatibility(contract, "paperless-documents")).toBeNull();
    expect(
      checkContractCompatibility(contract, "paperless-documents", { apiVersion: 1 })?.kind,
    ).toBe("api-too-new");
    expect(
      checkContractCompatibility(contract, "paperless-documents", {
        capabilities: ["multi-table-batch"],
      })?.kind,
    ).toBe("missing-capability");
  });

  test("a cursor for the largest archive a sweep accepts fits the state ceiling", () => {
    // 500,000 documents, a full sweep just started: every id pending, listed
    // in the ledger and known with a custom-field fingerprint.
    const n = 500_000;
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const cursor: PaperlessDocumentsCursor = {
      phase: "full",
      sweepWatermark: "2026-03-01T09:00:00.000000Z",
      pending: ids,
      lookups: Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`t${i}`, "0a1b2c3d4e"])),
      known: Object.fromEntries(ids.map((id) => [String(id), "0a1b2c3d4e"])),
      snapshot: { ids: { documents: ids.map(String) } },
    };
    const bytes = Buffer.byteLength(
      JSON.stringify(encodeSourceState(paperlessDocumentsStateSpec, cursor)),
    );
    expect(bytes).toBeLessThan(paperlessDocumentsStateSpec.maxBytes!);
  });
});
