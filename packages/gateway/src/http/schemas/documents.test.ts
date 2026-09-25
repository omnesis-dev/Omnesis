// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SOURCE_ICON_MAX_INPUT_CHARS } from "../../icon-limits.js";
import {
  documentsContentHashSiblingsBody,
  ingestDocumentsBody,
  reconcileDocumentsBody,
  setSyncStateBody,
  upsertWithCursorBody,
} from "./documents.js";

/**
 * Provider responses are typed at compile time but not
 * validated at the trust boundary. The gateway's `/documents` POST
 * accepts inputs from the collector subprocess, the iOS push path,
 * and any operator running `curl` by hand — none of which are
 * compile-time-typed against `DocumentInput`. Pinning the required
 * fields here prevents a missing key from surfacing as a SQLite
 * NOT-NULL error inside the writer worker.
 */
describe("ingestDocumentsBody", () => {
  const validDoc = {
    providerId: "google:user@gmail.com",
    sourceId: "gmail:user@gmail.com",
    externalId: "msg-1",
    title: "Hello",
    content: "Hello, world.",
    contentHash: "sha256:abc",
    metadata: {},
    sourceCreatedAt: "2026-04-15T10:00:00.000Z",
    sourceUpdatedAt: "2026-04-15T10:00:00.000Z",
  };

  it("accepts a well-formed envelope with one document", () => {
    expect(ingestDocumentsBody.safeParse({ documents: [validDoc] }).success).toBe(true);
  });

  it("accepts an empty documents array", () => {
    expect(ingestDocumentsBody.safeParse({ documents: [] }).success).toBe(true);
  });

  it("accepts a document with extra unknown fields (passthrough)", () => {
    // The collector may ship ahead of a schema bump; extra fields
    // shouldn't 400 the whole batch.
    const result = ingestDocumentsBody.safeParse({
      documents: [{ ...validDoc, futureFlag: "yes" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional extractedContentHash", () => {
    const result = ingestDocumentsBody.safeParse({
      documents: [{ ...validDoc, extractedContentHash: "sha256:def" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts old browser payloads without retaining their retired producer detail", () => {
    const result = ingestDocumentsBody.safeParse({
      documents: [
        {
          ...validDoc,
          metadata: { documentType: "webpage", captureMethod: "extension-dom" },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documents[0].metadata).toEqual({ documentType: "webpage" });
    }
  });

  // ── Required-field rejections ───────────────────────────────────────────
  for (const field of [
    "providerId",
    "sourceId",
    "externalId",
    "contentHash",
    "metadata",
    "sourceCreatedAt",
    "sourceUpdatedAt",
  ] as const) {
    it(`rejects a document missing ${field}`, () => {
      const doc = { ...validDoc } as Record<string, unknown>;
      delete doc[field];
      const result = ingestDocumentsBody.safeParse({ documents: [doc] });
      expect(result.success).toBe(false);
    });
  }

  // ── Empty-string rejections (nonEmptyString) ─────────────────────────────
  for (const field of [
    "providerId",
    "sourceId",
    "externalId",
    "contentHash",
    "sourceCreatedAt",
    "sourceUpdatedAt",
  ] as const) {
    it(`rejects an empty ${field}`, () => {
      const result = ingestDocumentsBody.safeParse({
        documents: [{ ...validDoc, [field]: "" }],
      });
      expect(result.success).toBe(false);
    });
  }

  // ── Type rejections ─────────────────────────────────────────────────────
  it("rejects a document where metadata is a string instead of an object", () => {
    const result = ingestDocumentsBody.safeParse({
      documents: [{ ...validDoc, metadata: "not an object" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a document where metadata is null", () => {
    const result = ingestDocumentsBody.safeParse({
      documents: [{ ...validDoc, metadata: null }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when documents itself is not an array", () => {
    expect(ingestDocumentsBody.safeParse({ documents: validDoc }).success).toBe(false);
  });

  it("rejects when documents is missing entirely", () => {
    expect(ingestDocumentsBody.safeParse({}).success).toBe(false);
  });
});

describe("documentsContentHashSiblingsBody", () => {
  it("accepts a non-empty documentIds array", () => {
    expect(documentsContentHashSiblingsBody.safeParse({ documentIds: ["a", "b"] }).success).toBe(
      true,
    );
  });

  it("rejects an empty array", () => {
    expect(documentsContentHashSiblingsBody.safeParse({ documentIds: [] }).success).toBe(false);
  });

  it("rejects missing documentIds", () => {
    expect(documentsContentHashSiblingsBody.safeParse({}).success).toBe(false);
  });

  it("rejects empty-string ids", () => {
    expect(documentsContentHashSiblingsBody.safeParse({ documentIds: ["a", ""] }).success).toBe(
      false,
    );
  });

  it("rejects over-cap arrays (>500)", () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    expect(documentsContentHashSiblingsBody.safeParse({ documentIds: ids }).success).toBe(false);
  });

  it("accepts exactly 500 ids", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    expect(documentsContentHashSiblingsBody.safeParse({ documentIds: ids }).success).toBe(true);
  });
});

describe("upsertWithCursorBody watermarks", () => {
  it("retains account and family declarations on atomic sync pages", () => {
    const meta = {
      account: { id: "local", subject: { kind: "opaque", value: "upstream-1" } },
      family: { label: "Example sources" },
    };
    const parsed = upsertWithCursorBody.parse({
      providerId: "example:local",
      sourceId: "example:local",
      documents: [],
      cursor: {},
      hasMore: false,
      meta,
    });
    expect(parsed.meta).toEqual(meta);
  });
  const terminalPage = {
    providerId: "example:account",
    sourceId: "example:account",
    hasMore: false,
    cursor: {},
  };

  it("accepts a watermark on a terminal page", () => {
    expect(
      upsertWithCursorBody.safeParse({
        ...terminalPage,
        watermark: { guarantee: "snapshot", observedAt: "2026-08-01T12:00:00.000Z" },
      }).success,
    ).toBe(true);
  });

  it("rejects a watermark on a non-terminal page", () => {
    expect(
      upsertWithCursorBody.safeParse({
        ...terminalPage,
        hasMore: true,
        watermark: { guarantee: "change-cut", upstreamCut: "opaque" },
      }).success,
    ).toBe(false);
  });
});

describe("setSyncStateBody urlPatterns validation (SEC-18)", () => {
  const base = { cursor: {} };

  it("accepts the real provider URL patterns currently in use", () => {
    // Sampled from the live `defineSource` descriptors — the validator must
    // not reject any legitimate pattern (incl. nested optional groups).
    const realPatterns = [
      "mail\\.google\\.com/mail/.*#[^/]*/([a-f0-9]+)$",
      "notion\\.so/(?:[^?#]*[/-])?([a-f0-9]{32})(?:\\?.*)?$",
      "strava\\.com/activities/(\\d+)",
    ];
    for (const regex of realPatterns) {
      const result = setSyncStateBody.safeParse({ ...base, urlPatterns: [{ regex }] });
      expect(result.success, regex).toBe(true);
    }
  });

  it("rejects an uncompilable regex at the write boundary", () => {
    const result = setSyncStateBody.safeParse({ ...base, urlPatterns: [{ regex: "([a-z" }] });
    expect(result.success).toBe(false);
  });

  it("rejects an empty regex", () => {
    expect(setSyncStateBody.safeParse({ ...base, urlPatterns: [{ regex: "" }] }).success).toBe(
      false,
    );
  });

  it("rejects an over-length regex (>300 chars)", () => {
    const huge = "a".repeat(301);
    expect(setSyncStateBody.safeParse({ ...base, urlPatterns: [{ regex: huge }] }).success).toBe(
      false,
    );
  });

  it("rejects too many patterns (>50)", () => {
    const many = Array.from({ length: 51 }, () => ({ regex: "x" }));
    expect(setSyncStateBody.safeParse({ ...base, urlPatterns: many }).success).toBe(false);
  });
});

describe("source icon input limits", () => {
  const oversizedIcon = "A".repeat(SOURCE_ICON_MAX_INPUT_CHARS + 1);

  it("rejects oversized sync-state icons", () => {
    expect(setSyncStateBody.safeParse({ cursor: {}, icon: oversizedIcon }).success).toBe(false);
  });

  it("rejects oversized with-cursor icons", () => {
    expect(
      upsertWithCursorBody.safeParse({
        providerId: "example-provider",
        sourceId: "example-source",
        documents: [],
        hasMore: false,
        cursor: {},
        meta: { icon: oversizedIcon },
      }).success,
    ).toBe(false);
  });
});

/**
 * The two spellings of a snapshot are one question at two scopes. Both
 * endpoints that accept one have to answer a caller sending both the same
 * way, or a source's mistake is a 400 on one route and a silently narrowed
 * sweep on the other.
 */
describe("saying what a snapshot covers", () => {
  const base = { providerId: "example-provider", sourceId: "example-source:one" };

  it("takes a whole-source enumeration", () => {
    expect(
      reconcileDocumentsBody.safeParse({ ...base, presentExternalIds: ["a", "b"] }).success,
    ).toBe(true);
  });

  it("takes per-partition claims", () => {
    expect(
      reconcileDocumentsBody.safeParse({
        ...base,
        presentClaims: [{ partition: "store/one", ids: ["a"] }],
      }).success,
    ).toBe(true);
  });

  it("refuses both — two answers about what was read", () => {
    const result = reconcileDocumentsBody.safeParse({
      ...base,
      presentExternalIds: ["a"],
      presentClaims: [{ partition: "store/one", ids: ["a"] }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("send one");
  });

  it("refuses neither — a reconcile with nothing to reconcile against", () => {
    // Sweeping on an absent snapshot would read as "the source holds nothing".
    expect(reconcileDocumentsBody.safeParse(base).success).toBe(false);
  });

  it("with-cursor refuses both the same way", () => {
    expect(
      upsertWithCursorBody.safeParse({
        ...base,
        documents: [],
        hasMore: false,
        cursor: {},
        presentExternalIds: ["a"],
        presentClaims: [{ partition: "store/one", ids: ["a"] }],
      }).success,
    ).toBe(false);
  });
});
