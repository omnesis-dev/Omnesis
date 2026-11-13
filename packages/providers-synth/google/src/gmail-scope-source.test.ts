// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
vi.mock("@omnesis/providers-synth-common", async (original) => ({
  ...(await original<typeof import("@omnesis/providers-synth-common")>()),
  personMention: (name: string, role: string) => ({ name, role }),
}));
import { createGmailFixtureSource } from "./gmail-source.js";
import type { EmailEntry } from "./fixtures.js";
const context = {
  sourceId: SourceId("gmail:owner@example.org"),
  providerId: ProviderId("google:owner@example.org"),
};
const entry = (i: number): EmailEntry => ({
  externalId: `mail-${i}`,
  subject: "Cedar plan",
  body: "Invented scope proof.",
  from: "author",
  fromEmail: "author@example.org",
  to: ["self"],
  toEmails: ["owner@example.org"],
  sentAt: "2026-01-02T12:00:00Z",
  threadId: `thread-${i}`,
  labels: ["Cedar"],
  labelIds: ["native-cedar"],
});
const options = (epoch: string, requestId?: string, actorId = "collector-a") => ({
  scopeFactsSupported: true,
  scopeRefreshEpochsSupported: true,
  scopeRefreshEpochs: { label: epoch },
  scopeRefreshRequestIds: { label: requestId },
  scopeRefreshActorId: actorId,
});
describe("synthetic native label refresh", () => {
  it("bounds malformed oversized native label bags and keeps them unknown", async () => {
    const large = {
      ...entry(1),
      labelIds: Array.from({ length: 20_000 }, (_, i) => `native-label-${i}`),
    };
    const source = createGmailFixtureSource([large], context, {});
    const result = await source.sync(null, { scopeFactsSupported: true });
    expect(result.documents[0]?.metadata.scopeFacts?.facts).toHaveLength(16_383);
    expect(result.documents[0]?.metadata.scopeFacts?.complete).toEqual([]);
    expect(result.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: false }]);
  });

  it("publishes bounded metadata-only label proof after an acknowledged cut and replays persisted progress", async () => {
    const extract = vi.fn();
    const source = createGmailFixtureSource(
      Array.from({ length: 257 }, (_, i) => entry(i)),
      context,
      { extractAttachment: extract },
    );
    const first = await source.sync(
      { offset: 257, attachmentIds: ["mail-0/att/0"], binaryParents: [] },
      options("required-b"),
    );
    const opts = options("required-c", first.scopeUpdates?.refreshes?.[0]?.requestId);
    const page = await source.sync(first.cursor, opts);
    const replay = await source.sync(first.cursor, opts);
    expect(replay).toEqual(page);
    let cursor = first.cursor;
    const ids = new Set<string>();
    let done = false;
    for (let index = 0; index < 5; index++) {
      const result = await source.sync(cursor, opts);
      expect(result.documents).toEqual([]);
      expect(result.cursor.offset).toBe(257);
      expect(result.cursor.attachmentIds).toEqual(["mail-0/att/0"]);
      expect(result.scopeUpdates?.documents?.length ?? 0).toBeLessThanOrEqual(100);
      for (const update of result.scopeUpdates?.documents ?? []) {
        expect(update.facts.refreshEpochs?.label).toBe("required-c");
        ids.add(update.externalId);
      }
      cursor = result.cursor;
      if (result.scopeUpdates?.refreshes?.some((refresh) => !refresh.active)) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
    expect(ids.size).toBe(257);
    expect(extract).not.toHaveBeenCalled();
    const peer = await source.sync(
      cursor,
      options("required-c", first.scopeUpdates?.refreshes?.[0]?.requestId, "collector-b"),
    );
    expect(peer.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
  });
  it("starts a fresh acknowledged cut if native input changes during a pass", async () => {
    const entries = [entry(1)];
    const source = createGmailFixtureSource(entries, context, {});
    const first = await source.sync(null, options("required-b"));
    const published = await source.sync(
      first.cursor,
      options("required-c", first.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    entries[0]!.labelIds = ["native-recreated"];
    const changed = await source.sync(published.cursor, options("required-c"));
    expect(changed.documents).toEqual([]);
    expect(changed.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    expect(changed.scopeUpdates?.documents).toBeUndefined();
  });
});
