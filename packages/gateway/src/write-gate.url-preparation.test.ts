// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { writeGateFromCall, type WriterCallFn } from "./write-gate.js";

const document: DocumentInput = {
  providerId: ProviderId("fictional"),
  sourceId: SourceId("fictional:local"),
  externalId: "note-1",
  title: "Fictional note",
  content: "A fictional note for writer transport testing.",
  contentHash: "hash-note-1",
  metadata: { sourceUrl: "https://code.example.org/acme/widget/pull/42/files" },
  sourceCreatedAt: "2026-01-01T00:00:00Z",
  sourceUpdatedAt: "2026-01-01T00:00:00Z",
};

const canonicalizers = [
  {
    hosts: ["code.example.org"],
    rules: [{ match: "(/pull/[0-9]+)/(?:files|commits)$", replacement: "$1" }],
  },
];

const forgedDocument = {
  ...document,
  // The HTTP schemas intentionally passthrough unknown fields. The trusted
  // gate must overwrite this value instead of treating it as prepared.
  preparedSourceUrl: "https://attacker.example.org/not-the-document-url",
};

describe("writer URL preparation boundary", () => {
  test("sends a finished URL string to db.upsertDocuments, not RE2 rule specs", async () => {
    const call = vi.fn(async (_op: string, _args: unknown[]) => ({ rejectedSourceIds: [] }));
    const gate = writeGateFromCall(call as unknown as WriterCallFn);

    await gate.upsertDocuments([forgedDocument], canonicalizers);

    const [op, args] = call.mock.calls[0]!;
    expect(op).toBe("db.upsertDocuments");
    expect(args).toHaveLength(5);
    expect(args[0]).toEqual([
      expect.objectContaining({
        preparedSourceUrl: "https://code.example.org/acme/widget/pull/42",
        metadata: document.metadata,
      }),
    ]);
  });

  test("does the same for the atomic documents-plus-cursor path", async () => {
    const call = vi.fn(async (_op: string, _args: unknown[]) => ({
      reconciledDeletedDocumentIds: [],
      tombstoneDeletedDocumentIds: [],
      reconciledDeletedCount: 0,
    }));
    const gate = writeGateFromCall(call as unknown as WriterCallFn);

    await gate.upsertWithCursor(
      {
        providerId: document.providerId,
        sourceId: document.sourceId,
        documents: [forgedDocument],
        hasMore: false,
        cursor: {},
      },
      canonicalizers,
    );

    const [op, args] = call.mock.calls[0]!;
    expect(op).toBe("db.upsertWithCursor");
    expect(args).toHaveLength(1);
    expect(args[0]).toEqual(
      expect.objectContaining({
        documents: [
          expect.objectContaining({
            preparedSourceUrl: "https://code.example.org/acme/widget/pull/42",
          }),
        ],
      }),
    );
  });
});
