// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { tableWrites } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
const state = vi.hoisted(() => ({ fixture: [] as unknown }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadSourceFixtureJson: () => state.fixture,
  loadActiveUniverse: () => ({}),
}));
import source, { loadPages, mapPage } from "./index.js";
const row = {
  url: "https://example.org/garden#section",
  title: "Garden guide",
  content: "Invented garden watering guide",
  visitedAt: "2026-10-03T12:00:00Z",
  dwellMs: 10000,
};
const sourceId = SourceId("web:synthetic");
const providerId = ProviderId("web:synthetic");
describe("synthetic browser capture", () => {
  test("real extension document builder keeps normalized hashed URL identity", async () => {
    const first = await mapPage(row, sourceId, providerId);
    const second = await mapPage(
      { ...row, url: "https://example.org/garden#other" },
      sourceId,
      providerId,
    );
    expect(first.externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.externalId).toBe(second.externalId);
    expect(first.metadata.sourceUrl).toBe("https://example.org/garden");
  });
  test("bootstrap emits content and visits; incremental cursor does not duplicate either", async () => {
    state.fixture = [row];
    const instance = await source.create!({ sourceId, providerId } as never);
    const result = await instance.syncStructured!(null);
    expect(result.documents).toHaveLength(1);
    expect(tableWrites(result.analytics)[0]?.records).toMatchObject([
      { domain: "example.org", dwell_ms: 10000 },
    ]);
    const next = await instance.syncStructured!(result.cursor);
    expect(next.documents).toEqual([]);
    expect(tableWrites(next.analytics)[0]?.records).toEqual([]);
  });
  test("short dwell and invalid URL fail rather than inventing a confirmed visit", () => {
    state.fixture = [{ ...row, dwellMs: 1 }];
    expect(loadPages).toThrow();
    state.fixture = [{ ...row, url: "invalid" }];
    expect(loadPages).toThrow();
  });
});
