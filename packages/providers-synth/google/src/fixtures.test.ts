// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { mapDriveFile } from "./fixtures.js";

describe("Synthetic drive extraction identity", () => {
  const ctx = {
    providerId: ProviderId("google:maya@example.com"),
    sourceId: SourceId("google-drive:maya@example.com"),
  };
  const fixture = {
    externalId: "fictional-original",
    name: "Equipment agreement.pdf",
    mimeType: "application/pdf",
    content: "Invented equipment agreement. Deposit: 240 units. Return after thirty days.",
    owner: "self",
    createdAt: "2025-02-01T09:00:00Z",
    modifiedAt: "2025-02-02T09:00:00Z",
  };

  test("different provider copies retain equal extracted identity and distinct render hashes", () => {
    const first = mapDriveFile(fixture, ctx);
    const second = mapDriveFile({ ...fixture, externalId: "fictional-copy" }, ctx);
    expect(first.extractedContentHash).toBe(computeContentHash(fixture.content));
    expect(second.extractedContentHash).toBe(first.extractedContentHash);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(first.metadata.sourceUrl).toBe(
      "https://drive.google.com/file/d/fictional-original/view",
    );
  });

  test("edited and empty extraction carry their own truthful raw hash", () => {
    expect(
      mapDriveFile({ ...fixture, content: "Revised equipment agreement. Deposit: 300 units." }, ctx)
        .extractedContentHash,
    ).not.toBe(mapDriveFile(fixture, ctx).extractedContentHash);
    expect(mapDriveFile({ ...fixture, content: "" }, ctx).extractedContentHash).toBe(
      computeContentHash(""),
    );
  });
});
