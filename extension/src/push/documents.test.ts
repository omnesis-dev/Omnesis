// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { normalizeUrl, urlToExternalId } from "@omnesis/core";
import {
  WEB_PROVIDER_ID,
  WEB_SOURCE_ID,
  buildPageVisit,
  buildWebPageDocument,
} from "./documents.js";

const PROFILE = { deviceId: "11111111-1111-4111-8111-111111111111", label: "Personal" };

describe("buildWebPageDocument", () => {
  it("produces a `webpage` DocumentInput under the unified `web` source", async () => {
    const docInput = await buildWebPageDocument({
      normalizedUrl: "https://example.com/article",
      title: "An invented article",
      text: "Fictional body text.",
      contentHash: "abc123",
      visitedAt: "2026-01-01T12:00:00.000Z",
      browserProfile: PROFILE,
    });
    expect(docInput.providerId).toBe(WEB_PROVIDER_ID);
    expect(docInput.sourceId).toBe(WEB_SOURCE_ID);
    expect(docInput.metadata.documentType).toBe("webpage");
    expect(docInput.metadata.sourceUrl).toBe("https://example.com/article");
    expect(docInput.metadata.extra).toMatchObject({
      browserDeviceId: "11111111-1111-4111-8111-111111111111",
      browserProfileLabel: "Personal",
    });
    expect(docInput.content).toBe("Fictional body text.");
    expect(docInput.contentHash).toBe("abc123");
    expect(docInput.sourceCreatedAt).toBe("2026-01-01T12:00:00.000Z");
  });

  it("keys on external_id = SHA256(normalizedUrl)", async () => {
    // The builder is fed the normalized URL, so the identity is the hash of
    // that exact canonical string.
    const normalized = normalizeUrl("https://example.com/article");
    const docInput = await buildWebPageDocument({
      normalizedUrl: normalized,
      title: "An invented article",
      text: "body",
      contentHash: "h",
      visitedAt: "2026-01-01T12:00:00.000Z",
    });
    expect(docInput.externalId).toBe(urlToExternalId(normalized));
  });

  it("emits ids the branded validators accept (contract drift guard)", async () => {
    const docInput = await buildWebPageDocument({
      normalizedUrl: "https://example.com/x",
      title: "T",
      text: "y",
      contentHash: "h",
      visitedAt: "2026-01-01T00:00:00.000Z",
    });
    // If the provider/source id strings ever stopped matching the branded-id
    // grammar, these would throw — catching push-contract drift at test time.
    expect(() => ProviderId(docInput.providerId)).not.toThrow();
    expect(() => SourceId(docInput.sourceId)).not.toThrow();
    expect(docInput.providerId).toBe(WEB_PROVIDER_ID);
    expect(docInput.sourceId).toBe(WEB_SOURCE_ID);
  });

  it("falls back to the URL when the title is empty", async () => {
    const docInput = await buildWebPageDocument({
      normalizedUrl: "https://example.com/notitle",
      title: "",
      text: "z",
      contentHash: "h",
      visitedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(docInput.title).toBe("https://example.com/notitle");
  });
});

describe("buildPageVisit", () => {
  it("produces a page_visits row matching the schema PK columns", () => {
    const row = buildPageVisit({
      normalizedUrl: "https://example.com/article",
      title: "An invented article",
      visitedAt: "2026-01-01T12:00:00.000Z",
      dwellMs: 6123.7,
      browserProfile: PROFILE,
    });
    expect(row).toEqual({
      url: "https://example.com/article",
      domain: "example.com",
      title: "An invented article",
      visited_at: "2026-01-01T12:00:00.000Z",
      dwell_ms: 6124,
      browser_device_id: "11111111-1111-4111-8111-111111111111",
      browser_profile_label: "Personal",
    });
  });

  it("nulls an empty title and clamps negative dwell", () => {
    const row = buildPageVisit({
      normalizedUrl: "https://example.com/x",
      title: "",
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: -5,
    });
    expect(row.title).toBeNull();
    expect(row.dwell_ms).toBe(0);
  });
});
