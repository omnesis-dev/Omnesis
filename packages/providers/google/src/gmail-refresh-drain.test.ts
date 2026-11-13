// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { createGmailSource, createMockGmail } from "./testing/mock-google.js";
import type { SyncOptions } from "@omnesis/source-sdk";
import type { GmailSyncCursor } from "./gmail.js";

afterEach(() => vi.restoreAllMocks());

test.each(["holder", "member"] as const)(
  "a quiet mailbox drains its %s label refresh within the current run",
  async (role) => {
    const gmail = createMockGmail();
    const operations: string[] = [];
    gmail.users.getProfile.mockImplementation(() => {
      operations.push("anchor");
      return Promise.resolve({ data: { historyId: "native-anchor" } });
    });
    gmail.users.labels.list.mockImplementation(() => {
      operations.push("catalogue");
      return Promise.resolve({ data: { labels: [{ id: "Label_plan", name: "Planning" }] } });
    });
    gmail.users.messages.list.mockImplementation(({ pageToken }: { pageToken?: string }) => {
      operations.push(pageToken ? "scan-second" : "scan-first");
      return Promise.resolve({
        data: pageToken
          ? { messages: [{ id: "mail-b" }] }
          : { messages: [{ id: "mail-a" }], nextPageToken: "metadata-page-b" },
      });
    });
    let removed = false;
    gmail.users.messages.get.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({ data: { id, labelIds: removed ? [] : ["Label_plan"] } }),
    );
    let contentPages = 0;
    gmail.users.history.list.mockImplementation(
      ({ startHistoryId }: { startHistoryId: string }) => {
        if (startHistoryId === "native-anchor") {
          operations.push("catchup");
          removed = true;
          return Promise.resolve({
            data: {
              historyId: "native-end",
              history: [
                { labelsRemoved: [{ message: { id: "mail-a" }, labelIds: ["Label_plan"] }] },
              ],
            },
          });
        }
        operations.push("content");
        return Promise.resolve({ data: { history: [], historyId: `content-${++contentPages}` } });
      },
    );
    const source = createGmailSource(gmail);
    let cursor: GmailSyncCursor = {
      phase: "incremental",
      historyId: "content-start",
      scopeLabelsVersion: 1,
      scopeLabelsCut: {
        epoch: "previous-cut",
        actorId: "fixture-collector",
        authority: role,
        completed: true,
      },
    };
    let requiredEpoch = "required-cut";
    let acknowledgedRequest: string | undefined;
    let released = false;
    let ready = false;
    const observations: string[] = [];

    // Follow exactly the continuation decision the collector sees.
    for (let page = 0; page < 20; page++) {
      const result = await source.sync(cursor, {
        scopeFactsSupported: true,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: requiredEpoch },
        scopeRefreshRequestIds: { label: acknowledgedRequest },
        scopeRefreshActorId: "fixture-collector",
        run: { id: "refresh-run", reason: "scheduled", start: "resume", page, role },
      });
      const restart = result.scopeUpdates?.refreshes?.find((entry) => entry.restart);
      if (restart) {
        requiredEpoch = "accepted-cut";
        acknowledgedRequest = restart.requestId;
      }
      for (const update of result.scopeUpdates?.documents ?? []) {
        expect(update.facts.refreshEpochs?.label).toBe(requiredEpoch);
        observations.push(update.externalId);
      }
      released ||= result.scopeUpdates?.refreshes?.some((entry) => !entry.active) ?? false;
      ready ||= result.scopeUpdates?.readiness?.some((entry) => entry.complete) ?? false;
      if (role === "member") {
        expect(result.scopeUpdates?.refreshes).toBeUndefined();
        expect(result.scopeUpdates?.readiness).toBeUndefined();
      }
      cursor = result.cursor as GmailSyncCursor;
      if (!result.hasMore) break;
      expect(page).toBeLessThan(19);
    }

    expect(cursor.scopeLabelsCut).toMatchObject({
      epoch: requiredEpoch,
      actorId: "fixture-collector",
      authority: role,
      completed: true,
    });
    expect(cursor.scopeLabelsStage).toBeUndefined();
    expect(cursor.scopeLabelsVersion).toBe(1);
    expect(observations).toEqual(["mail-a", "mail-b", "mail-a"]);
    expect(operations).toEqual([
      "anchor",
      "catalogue",
      "content",
      "scan-first",
      "content",
      "scan-second",
      "content",
      "catchup",
      "content",
    ]);
    expect(contentPages).toBe(4);
    expect(released).toBe(role === "holder");
    expect(ready).toBe(role === "holder");
    expect(
      gmail.users.messages.get.mock.calls.every(
        ([request]: [{ format: string }]) => request.format === "metadata",
      ),
    ).toBe(true);
    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
  },
);

test("a pending label scan still pauses at the run budget and resumes its saved page in a fresh run", async () => {
  const gmail = createMockGmail();
  gmail.users.messages.list.mockResolvedValue({
    data: { messages: [], nextPageToken: "scan-next" },
  });
  const source = createGmailSource(gmail);
  let clock = Date.UTC(2026, 0, 1);
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const options = (id: string, page: number): SyncOptions => ({
    scopeFactsSupported: true,
    scopeRefreshEpochsSupported: true,
    scopeRefreshEpochs: { label: "accepted-cut" },
    scopeRefreshActorId: "fixture-collector",
    run: { id, reason: "scheduled", start: "resume", page, role: "holder" },
  });
  const cursor: GmailSyncCursor = {
    phase: "incremental",
    historyId: "content-start",
    scopeLabelsStage: "scan",
    scopeLabelsPageToken: "scan-current",
    scopeLabelsHistoryId: "native-anchor",
    scopeLabelsYieldToContent: true,
    scopeLabelsCut: { epoch: "accepted-cut", authority: "holder", actorId: "fixture-collector" },
  };

  const content = await source.sync(cursor, options("run-1", 0));
  expect(content.hasMore).toBe(true);
  expect(content.cursor).toMatchObject({
    historyId: "history-2",
    scopeLabelsPageToken: "scan-current",
    scopeLabelsHistoryId: "native-anchor",
    scopeLabelsYieldToContent: false,
  });
  clock += 21 * 60_000;
  const paused = await source.sync(content.cursor, options("run-1", 1));
  expect(paused.hasMore).toBe(false);
  expect(paused.cursor).toMatchObject({
    scopeLabelsPageToken: "scan-next",
    scopeLabelsHistoryId: "native-anchor",
    scopeLabelsYieldToContent: true,
    scopeLabelsCut: { epoch: "accepted-cut", actorId: "fixture-collector" },
  });
  const resumed = await source.sync(paused.cursor, options("run-2", 0));
  expect(resumed.hasMore).toBe(true);
  expect(resumed.cursor.scopeLabelsPageToken).toBe("scan-next");
  await source.sync(resumed.cursor, options("run-2", 1));
  expect(
    gmail.users.messages.list.mock.calls.map(
      ([request]: [{ pageToken?: string }]) => request.pageToken,
    ),
  ).toEqual(["scan-current", "scan-next"]);
});
