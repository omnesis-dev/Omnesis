// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { GmailLabelScopes, GMAIL_LABEL_CATALOGUE_TTL_MS } from "./gmail-scope-labels.js";
import { createMockGmail, createGmailSource } from "./testing/mock-google.js";
import type { GmailSyncCursor } from "./gmail.js";

const base: GmailSyncCursor = {
  phase: "incremental",
  historyId: "native-history",
  scopeLabelsVersion: 1,
};
function scopes(gmail: ReturnType<typeof createMockGmail>) {
  return new GmailLabelScopes(
    gmail,
    () => Promise.resolve([]),
    () => 1,
    () => {},
  );
}

describe("periodic Gmail label catalogue", () => {
  it("updates a rename without history events, metadata refresh or body fetch", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list.mockResolvedValue({
      data: { labels: [{ id: "label-cedar", name: "Cedar" }] },
    });
    const seed = await scopes(gmail).cataloguePage(base, 1);
    const source = createGmailSource(gmail);
    gmail.users.labels.list.mockResolvedValue({
      data: { labels: [{ id: "label-cedar", name: "Cedar renamed" }] },
    });
    const result = await source.sync(
      { ...base, ...seed.cursor, scopeLabelsCatalogueCheckedAt: 0 },
      { scopeFactsSupported: true },
    );
    expect(result.scopeUpdates?.entities).toEqual([
      { kind: "label", id: "label-cedar", label: "Cedar renamed" },
    ]);
    expect(result.scopeUpdates?.refreshes).toBeUndefined();
    expect(result.cursor.scopeLabelsVersion).toBe(1);
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
    expect(gmail.users.messages.get).not.toHaveBeenCalled();
    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
    const calls = gmail.users.labels.list.mock.calls.length;
    await source.sync(result.cursor, { scopeFactsSupported: true });
    expect(gmail.users.labels.list).toHaveBeenCalledTimes(calls);
  });

  it("fences a deleted/recreated ID set and resets native progress instead of blessing stale facts", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list.mockResolvedValue({
      data: { labels: [{ id: "label-old", name: "Cedar" }] },
    });
    const seed = await scopes(gmail).cataloguePage(base, 1);
    gmail.users.labels.list.mockResolvedValue({
      data: { labels: [{ id: "label-new", name: "Cedar" }] },
    });
    const result = await createGmailSource(gmail).sync(
      {
        ...base,
        ...seed.cursor,
        scopeLabelsCatalogueCheckedAt: 0,
        scopeLabelsCut: { epoch: "required-cut", authority: "holder", completed: true },
      },
      {
        scopeFactsSupported: true,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: "required-cut" },
      },
    );
    expect(result.scopeUpdates?.refreshes).toEqual([{ kind: "label", active: true }]);
    expect(result.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: false }]);
    expect(result.cursor.scopeLabelsVersion).toBeUndefined();
    expect(result.cursor.scopeLabelsCut).toBeUndefined();
    expect(result.hasMore).toBe(true);
    expect(gmail.users.messages.get).not.toHaveBeenCalled();
  });

  it("refreshes once when old completed cursors have no stable ID-set evidence", async () => {
    const gmail = createMockGmail();
    const result = await createGmailSource(gmail).sync(
      { ...base, scopeLabelsCatalogueCheckedAt: Date.now() },
      { scopeFactsSupported: true },
    );
    expect(result.scopeUpdates?.refreshes).toEqual([{ kind: "label", active: true }]);
    expect(result.cursor.scopeLabelsVersion).toBeUndefined();
    expect(result.cursor.scopeLabelsIdSetHash).toEqual(expect.any(String));
  });

  it("never lets a member rotate or release a source-wide catalogue fence", async () => {
    const gmail = createMockGmail();
    const result = await createGmailSource(gmail).sync(
      { ...base, scopeLabelsCut: { epoch: "required-cut", authority: "member", completed: true } },
      {
        scopeFactsSupported: true,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: "required-cut" },
        run: { id: "member-run", role: "member", reason: "scheduled", start: "resume", page: 0 },
      },
    );
    expect(result.scopeUpdates?.refreshes).toBeUndefined();
    expect(result.scopeUpdates?.readiness).toBeUndefined();
  });

  it("paginates large catalogues durably and replays a rejected page exactly", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list.mockResolvedValue({
      data: {
        labels: Array.from({ length: 250 }, (_, i) => ({ id: `label-${i}`, name: `Cedar ${i}` })),
      },
    });
    const helper = scopes(gmail);
    const seed = await helper.cataloguePage(base, 1);
    const input = { ...base, ...seed.cursor, scopeLabelsCatalogueCheckedAt: 0 };
    const first = await helper.cataloguePage(input, GMAIL_LABEL_CATALOGUE_TTL_MS + 1);
    const replay = await helper.cataloguePage(input, GMAIL_LABEL_CATALOGUE_TTL_MS + 1);
    expect(replay).toEqual(first);
    expect(first.updates?.entities).toHaveLength(100);
    expect(first.updates?.replaceEntityKinds).toEqual(["label"]);
    const second = await scopes(gmail).cataloguePage(
      { ...base, ...first.cursor },
      GMAIL_LABEL_CATALOGUE_TTL_MS + 1,
    );
    const third = await scopes(gmail).cataloguePage(
      { ...base, ...second.cursor },
      GMAIL_LABEL_CATALOGUE_TTL_MS + 1,
    );
    expect(second.updates?.entities).toHaveLength(100);
    expect(second.updates?.replaceEntityKinds).toBeUndefined();
    expect(third.updates?.entities).toHaveLength(50);
    expect(third.more).toBe(false);
    expect(
      new Set(
        [
          ...first.updates!.entities!,
          ...second.updates!.entities!,
          ...third.updates!.entities!,
        ].map((row) => row.id),
      ).size,
    ).toBe(250);
  });
});
