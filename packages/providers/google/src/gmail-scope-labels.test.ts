// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";
import { gmailLabelFacts } from "./gmail-scope-labels.js";
import type { GmailSyncCursor } from "./gmail.js";

const supported = { scopeFactsSupported: true };
const incremental: GmailSyncCursor = {
  phase: "incremental",
  historyId: "original-history",
  scopeLabelsVersion: 1,
};

describe("Gmail native label facts", () => {
  it("refreshes again for a new gateway epoch even when an old completed cursor survives", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "old-mail" }] } });
    gmail.users.messages.get.mockResolvedValue({ data: { id: "old-mail", labelIds: ["INBOX"] } });
    const source = createGmailSource(gmail);
    let cursor: GmailSyncCursor = {
      ...incremental,
      scopeLabelsCut: { epoch: "epoch-old", authority: "holder", completed: true },
    };
    const installed = cursor;
    const original = structuredClone(cursor);
    let requiredEpoch = "epoch-current";
    let acknowledgedRequestId: string | undefined;
    let sawProof = false;
    let sawCompletion = false;
    for (let page = 0; page < 12; page++) {
      const result = await source.sync(cursor, {
        ...supported,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: requiredEpoch },
        scopeRefreshRequestIds: { label: acknowledgedRequestId },
      });
      sawProof ||=
        result.scopeUpdates?.documents?.some(
          (update) => update.facts.refreshEpochs?.label === requiredEpoch,
        ) ?? false;
      sawCompletion ||=
        result.scopeUpdates?.refreshes?.some(
          (refresh) => !refresh.active && refresh.epoch === requiredEpoch,
        ) ?? false;
      cursor = result.cursor as GmailSyncCursor;
      const restart = result.scopeUpdates?.refreshes?.find((refresh) => refresh.restart);
      if (restart) {
        requiredEpoch = "epoch-rotated";
        acknowledgedRequestId = restart.requestId;
      }
      if (cursor.scopeLabelsCut?.completed && cursor.scopeLabelsCut.epoch === requiredEpoch) break;
    }
    expect(installed).toEqual(original);
    expect(cursor.scopeLabelsCut).toMatchObject({
      epoch: "epoch-rotated",
      authority: "holder",
      completed: true,
    });
    expect(sawProof).toBe(true);
    expect(sawCompletion).toBe(true);
    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
  });
  it("does not resume a peer collector's native cut after actor handover", async () => {
    const gmail = createMockGmail();
    const result = await createGmailSource(gmail).sync(
      {
        ...incremental,
        scopeLabelsStage: "scan",
        scopeLabelsPageToken: "peer-page",
        scopeLabelsCut: { epoch: "epoch-current", authority: "holder", actorId: "collector-peer" },
      },
      {
        ...supported,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: "epoch-current" },
        scopeRefreshActorId: "collector-current",
      },
    );
    expect(result.cursor.scopeLabelsCut).toMatchObject({
      actorId: "collector-current",
      restarting: true,
    });
    expect(result.cursor.scopeLabelsPageToken).toBeUndefined();
    expect(result.scopeUpdates?.refreshes?.[0]?.requestId).toEqual(expect.any(String));
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
  });
  it("requires its own nonce acknowledgment before adopting another epoch", async () => {
    const gmail = createMockGmail();
    const source = createGmailSource(gmail);
    const first = await source.sync(incremental, {
      ...supported,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { label: "epoch-original" },
    });
    const second = await source.sync(first.cursor, {
      ...supported,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { label: "epoch-other" },
      scopeRefreshRequestIds: { label: "00000000-0000-4000-8000-000000000001" },
    });
    expect(second.cursor.scopeLabelsCut).toMatchObject({ epoch: "epoch-other", restarting: true });
    expect((second.cursor as GmailSyncCursor).scopeLabelsCut?.requestId).not.toBe(
      (first.cursor as GmailSyncCursor).scopeLabelsCut?.requestId,
    );
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
  });
  it("restarts a pending metadata cut when the required epoch changes", async () => {
    const gmail = createMockGmail();
    const cursor: GmailSyncCursor = {
      ...incremental,
      scopeLabelsVersion: undefined,
      scopeLabelsStage: "scan",
      scopeLabelsHistoryId: "old-cut",
      scopeLabelsPageToken: "old-page",
      scopeLabelsCut: { epoch: "epoch-old", authority: "holder" },
    };
    const result = await createGmailSource(gmail).sync(cursor, {
      ...supported,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { label: "epoch-new" },
    });
    expect(result.cursor.scopeLabelsCut).toMatchObject({ epoch: "epoch-new", restarting: true });
    expect(result.cursor.scopeLabelsPageToken).toBeUndefined();
    expect(result.scopeUpdates?.refreshes).toEqual([
      {
        kind: "label",
        active: true,
        epoch: "epoch-new",
        restart: true,
        requestId: expect.any(String),
      },
    ]);
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
  });
  it("stops an unacknowledged restart instead of spinning the collector", async () => {
    const gmail = createMockGmail();
    const source = createGmailSource(gmail);
    const options = {
      ...supported,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { label: "epoch-current" },
    };
    const first = await source.sync(incremental, options);
    expect(first.hasMore).toBe(true);
    const deferred = await source.sync(first.cursor, options);
    expect(deferred.hasMore).toBe(false);
    expect(deferred.scopeUpdates?.refreshes).toEqual([
      {
        kind: "label",
        active: true,
        epoch: "epoch-current",
        restart: true,
        requestId: expect.any(String),
      },
    ]);
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
    expect(gmail.users.getProfile).not.toHaveBeenCalled();
  });
  it("rotates an expired pinned cut so prior observations cannot bless omissions", async () => {
    const gmail = createMockGmail();
    gmail.users.history.list.mockRejectedValueOnce(
      Object.assign(new Error("Expired"), { code: 404 }),
    );
    const source = createGmailSource(gmail);
    const result = await source.sync(
      {
        ...incremental,
        scopeLabelsVersion: undefined,
        scopeLabelsStage: "history",
        scopeLabelsHistoryId: "expired-cut",
        scopeLabelsCut: { epoch: "epoch-current", authority: "holder" },
      },
      {
        ...supported,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: "epoch-current" },
      },
    );
    expect(result.scopeUpdates?.refreshes).toEqual([
      {
        kind: "label",
        active: true,
        epoch: "epoch-current",
        restart: true,
        requestId: expect.any(String),
      },
    ]);
    expect(result.cursor.scopeLabelsCut).toMatchObject({
      epoch: "epoch-current",
      restarting: true,
    });
    const resumed = await source.sync(result.cursor, {
      ...supported,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { label: "epoch-restarted" },
      scopeRefreshRequestIds: {
        label: (result.cursor as GmailSyncCursor).scopeLabelsCut?.requestId,
      },
    });
    expect(resumed.cursor.scopeLabelsCut).toMatchObject({
      epoch: "epoch-restarted",
      authority: "holder",
    });
    expect(resumed.scopeUpdates?.replaceEntityKinds).toEqual(["label"]);
  });
  it("preserves full bootstrap catchup across the required cut handshake", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "new-mail" }] } });
    gmail.users.messages.get.mockResolvedValue({ data: makeGmailMessage("new-mail") });
    const source = createGmailSource(gmail);
    const first = await source.sync(null, {
      ...supported,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { label: "epoch-initial" },
    });
    expect(first.cursor.scopeLabelsBootstrap).toBe(true);
    let cursor = first.cursor;
    let completed = false;
    let sawBody = false;
    for (let page = 0; page < 12; page++) {
      const result = await source.sync(cursor, {
        ...supported,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { label: "epoch-current" },
        scopeRefreshRequestIds: {
          label: (first.cursor as GmailSyncCursor).scopeLabelsCut?.requestId,
        },
      });
      sawBody ||= result.documents.some(
        (doc) => doc.metadata.scopeFacts?.refreshEpochs?.label === "epoch-current",
      );
      completed ||=
        result.scopeUpdates?.refreshes?.some(
          (control) => !control.active && control.epoch === "epoch-current",
        ) ?? false;
      cursor = result.cursor;
      if (completed) break;
    }
    expect(sawBody).toBe(true);
    expect(completed).toBe(true);
  });
  it("omits epoch extensions for a v1 gateway while preserving its ordinary native label flow", async () => {
    const gmail = createMockGmail();
    gmail.users.history.list.mockResolvedValue({
      data: {
        historyId: "next-history",
        history: [{ labelsAdded: [{ message: { id: "old-mail" } }] }],
      },
    });
    gmail.users.messages.get.mockResolvedValue({ data: { id: "old-mail", labelIds: ["INBOX"] } });
    const result = await createGmailSource(gmail).sync(
      {
        ...incremental,
        scopeLabelsCut: { epoch: "epoch-old", authority: "holder", completed: true },
      },
      supported,
    );
    expect(result.cursor.scopeLabelsCut).toBeUndefined();
    expect(result.cursor.scopeLabelsVersion).toBeUndefined();
    expect(result.scopeUpdates?.refreshes).toEqual([{ kind: "label", active: true }]);
    expect(result.scopeUpdates?.documents?.[0]?.facts).not.toHaveProperty("refreshEpochs");
  });

  it("records stable IDs only after negotiation and keeps legacy metadata unchanged", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "mail-1" }] } });
    gmail.users.messages.get.mockResolvedValue({
      data: makeGmailMessage("mail-1", { labelIds: ["Label_cedar"] }),
    });
    gmail.users.labels.list.mockResolvedValue({
      data: { labels: [{ id: "Label_cedar", name: "Cedar notes" }] },
    });
    const source = createGmailSource(gmail);
    const legacy = await source.sync(null);
    expect(legacy.documents[0]?.metadata).not.toHaveProperty("scopeFacts");
    const next = await source.sync(null, supported);
    expect(next.documents[0]?.metadata.scopeFacts).toEqual(
      gmailLabelFacts(["Label_cedar"], ["Cedar notes"]),
    );
    expect(next.documents[0]?.metadata.tags).toEqual(["Cedar notes"]);
    expect(gmailLabelFacts(["Label_cedar"])).not.toEqual(gmailLabelFacts(["Label_recreated"]));
  });

  it("updates an old message after a label-only change without reading its body or attachments", async () => {
    const gmail = createMockGmail();
    gmail.users.history.list.mockResolvedValue({
      data: {
        historyId: "next-history",
        history: [{ labelsAdded: [{ message: { id: "old-mail" }, labelIds: ["Label_cedar"] }] }],
      },
    });
    gmail.users.messages.get.mockResolvedValue({
      data: { id: "old-mail", labelIds: ["Label_cedar"] },
    });
    const result = await createGmailSource(gmail).sync(incremental, supported);
    expect(result.documents).toEqual([]);
    expect(result.scopeUpdates?.documents?.[0]).toMatchObject({
      externalId: "old-mail",
      facts: gmailLabelFacts(["Label_cedar"], ["Label_cedar"]),
    });
    expect(gmail.users.messages.get).toHaveBeenCalledExactlyOnceWith({
      userId: "me",
      id: "old-mail",
      format: "metadata",
      metadataHeaders: ["List-Unsubscribe", "Precedence", "Auto-Submitted"],
      fields: "id,labelIds,payload/headers",
    });
    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
    expect(result.cursor.historyId).toBe("next-history");
  });

  it("keeps the full-body legacy label change path without scope support", async () => {
    const gmail = createMockGmail();
    gmail.users.history.list.mockResolvedValue({
      data: {
        historyId: "next-history",
        history: [{ labelsAdded: [{ message: { id: "old-mail" }, labelIds: ["Label_cedar"] }] }],
      },
    });
    gmail.users.messages.get.mockResolvedValue({ data: makeGmailMessage("old-mail") });
    const result = await createGmailSource(gmail).sync(incremental);
    expect(result.scopeUpdates).toBeUndefined();
    expect(result.documents[0]?.metadata).not.toHaveProperty("scopeFacts");
    expect(result.cursor).not.toHaveProperty("scopeLabelsVersion");
    expect(gmail.users.messages.get).toHaveBeenCalledWith({
      userId: "me",
      id: "old-mail",
      format: "full",
    });
  });

  it("refreshes installed messages using minimal pages and catches changes made during the walk before ready", async () => {
    const gmail = createMockGmail();
    gmail.users.getProfile.mockResolvedValue({ data: { historyId: "refresh-start" } });
    gmail.users.labels.list.mockResolvedValue({
      data: { labels: [{ id: "Label_cedar", name: "Cedar notes" }] },
    });
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "old-mail" }] } });
    let labels = ["Label_cedar"];
    gmail.users.messages.get.mockImplementation(async ({ id }: { id: string }) => ({
      data: { id, labelIds: labels },
    }));
    const source = createGmailSource(gmail);
    const catalogue = await source.sync(
      { phase: "incremental", historyId: "original-history" },
      supported,
    );
    expect(catalogue.scopeUpdates?.entities).toEqual([
      { kind: "label", id: "Label_cedar", label: "Cedar notes" },
    ]);
    expect(catalogue.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: false }]);
    const contentPage = await source.sync(catalogue.cursor, supported);
    const scan = await source.sync(contentPage.cursor, supported);
    expect(scan.scopeUpdates?.documents?.[0]?.facts).toEqual(
      gmailLabelFacts(labels, ["Cedar notes"]),
    );
    expect(scan.cursor.historyId).toBe("history-2");
    labels = [];
    gmail.users.history.list.mockResolvedValue({
      data: {
        historyId: "refresh-end",
        history: [{ labelsRemoved: [{ message: { id: "old-mail" }, labelIds: ["Label_cedar"] }] }],
      },
    });
    const anotherContentPage = await source.sync(scan.cursor, supported);
    const catchup = await source.sync(anotherContentPage.cursor, supported);
    expect(gmail.users.history.list).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: "refresh-start" }),
    );
    expect(catchup.scopeUpdates?.documents?.[0]?.facts).toEqual(gmailLabelFacts([]));
    expect(catchup.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: true }]);
    expect(catchup.cursor).toMatchObject({ historyId: "refresh-end", scopeLabelsVersion: 1 });
    expect(
      gmail.users.messages.get.mock.calls.every(
        ([request]: [{ format: string }]) => request.format === "metadata",
      ),
    ).toBe(true);
  });

  it("forces a new refresh when an unsupported gateway interval ends, including rollback mid-refresh", async () => {
    const gmail = createMockGmail();
    const source = createGmailSource(gmail);
    const legacy = await source.sync(incremental);
    expect(legacy.cursor.scopeLabelsVersion).toBeUndefined();
    const refreshed = await source.sync(legacy.cursor, supported);
    expect(refreshed.cursor.scopeLabelsStage).toBe("scan");
    const rolledBack = await source.sync(refreshed.cursor);
    expect(rolledBack.cursor.scopeLabelsStage).toBeUndefined();
    expect(rolledBack.scopeUpdates).toBeUndefined();
    const resumed = await source.sync(rolledBack.cursor, supported);
    expect(resumed.scopeUpdates?.replaceEntityKinds).toEqual(["label"]);
    expect(resumed.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: false }]);
  });

  it("does not advance the caller's metadata cursor after a minimal fetch failure", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "old-mail" }] } });
    const source = createGmailSource(gmail);
    const first = await source.sync(
      { phase: "incremental", historyId: "original-history" },
      supported,
    );
    const contentPage = await source.sync(first.cursor, supported);
    const before = structuredClone(contentPage.cursor);
    gmail.users.messages.get.mockRejectedValue(
      Object.assign(new Error("Rate limited"), { code: 429 }),
    );
    await expect(source.sync(contentPage.cursor, supported)).rejects.toMatchObject({
      kind: "rate-limit",
    });
    expect(contentPage.cursor).toEqual(before);
  });

  it("uses a bounded refresh instead of emitting an oversized bulk-label history patch", async () => {
    const gmail = createMockGmail();
    const changes = Array.from({ length: 300 }, (_, index) => ({
      message: { id: `mail-${index}` },
      labelIds: ["Label_cedar"],
    }));
    gmail.users.history.list.mockResolvedValue({
      data: { historyId: "after-bulk", history: [{ labelsAdded: changes }] },
    });
    const result = await createGmailSource(gmail).sync(incremental, supported);
    expect(result.scopeUpdates?.documents).toBeUndefined();
    expect(result.scopeUpdates?.refreshes).toEqual([{ kind: "label", active: true }]);
    expect(result.cursor.historyId).toBe("after-bulk");
    expect(result.cursor.scopeLabelsVersion).toBeUndefined();
    expect(gmail.users.messages.get).not.toHaveBeenCalled();
  });

  it("keeps the explicit refresh fence active when catchup expires or is too large", async () => {
    const gmail = createMockGmail();
    gmail.users.history.list.mockRejectedValueOnce(
      Object.assign(new Error("Expired"), { code: 404 }),
    );
    const state = {
      phase: "incremental" as const,
      historyId: "mail-history",
      scopeLabelsStage: "history" as const,
      scopeLabelsHistoryId: "label-cut",
    };
    const expired = await createGmailSource(gmail).sync(state, supported);
    expect(expired.scopeUpdates?.refreshes).toEqual([{ kind: "label", active: true }]);
    expect(expired.cursor.scopeLabelsVersion).toBeUndefined();
    gmail.users.history.list.mockResolvedValue({
      data: {
        history: [
          {
            labelsAdded: Array.from({ length: 300 }, (_, index) => ({
              message: { id: `mail-${index}` },
            })),
          },
        ],
      },
    });
    const oversized = await createGmailSource(gmail).sync(state, supported);
    expect(oversized.scopeUpdates?.refreshes).toEqual([{ kind: "label", active: true }]);
    expect(gmail.users.messages.get).not.toHaveBeenCalled();
  });

  it("delivers new content between metadata pages while retaining an independent label history cut", async () => {
    const gmail = createMockGmail();
    gmail.users.getProfile.mockResolvedValue({ data: { historyId: "label-history-cut" } });
    gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: "old-mail" }], nextPageToken: "more-old-mail" },
    });
    gmail.users.messages.get.mockImplementation(
      async ({ id, format }: { id: string; format: string }) => ({
        data: format === "full" ? makeGmailMessage(id) : { id, labelIds: ["INBOX"] },
      }),
    );
    const source = createGmailSource(gmail);
    const catalogue = await source.sync(
      { phase: "incremental", historyId: "mail-before" },
      supported,
    );
    gmail.users.history.list.mockResolvedValueOnce({
      data: {
        historyId: "mail-after-one",
        history: [{ messagesAdded: [{ message: { id: "new-mail-one" } }] }],
      },
    });
    const firstContent = await source.sync(catalogue.cursor, supported);
    expect(firstContent.documents.map((doc) => doc.externalId)).toContain("new-mail-one");
    expect(firstContent.cursor).toMatchObject({
      historyId: "mail-after-one",
      scopeLabelsStage: "scan",
      scopeLabelsHistoryId: "label-history-cut",
    });
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
    const metadata = await source.sync(firstContent.cursor, supported);
    expect(metadata.cursor.scopeLabelsPageToken).toBe("more-old-mail");
    gmail.users.history.list.mockResolvedValueOnce({
      data: {
        historyId: "mail-after-two",
        history: [{ messagesAdded: [{ message: { id: "new-mail-two" } }] }],
      },
    });
    const secondContent = await source.sync(metadata.cursor, supported);
    expect(secondContent.documents.map((doc) => doc.externalId)).toContain("new-mail-two");
    expect(secondContent.cursor).toMatchObject({
      historyId: "mail-after-two",
      scopeLabelsStage: "scan",
      scopeLabelsPageToken: "more-old-mail",
      scopeLabelsHistoryId: "label-history-cut",
    });
    expect(secondContent.cursor.scopeLabelsVersion).toBeUndefined();
  });

  it("collects initial bootstrap labels naturally and establishes readiness after history catchup", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "first-mail" }] } });
    gmail.users.messages.get.mockResolvedValue({ data: makeGmailMessage("first-mail") });
    const source = createGmailSource(gmail);
    const bootstrap = await source.sync(null, supported);
    expect(bootstrap.cursor).toMatchObject({
      scopeLabelsVersion: 1,
      scopeLabelsBootstrapCatchup: true,
    });
    expect(bootstrap.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: false }]);
    const caughtUp = await source.sync(bootstrap.cursor, supported);
    expect(caughtUp.scopeUpdates?.readiness).toEqual([{ kind: "label", complete: true }]);
    expect(caughtUp.cursor.scopeLabelsBootstrapCatchup).toBeUndefined();
    expect(gmail.users.messages.list).toHaveBeenCalledOnce();
    expect(gmail.users.getProfile).toHaveBeenCalledOnce();
  });

  it("keeps filter identity on rename while a recreated label gets a new identity", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list
      .mockResolvedValueOnce({ data: { labels: [{ id: "Label_old", name: "Cedar" }] } })
      .mockResolvedValueOnce({ data: { labels: [{ id: "Label_old", name: "Cedar renamed" }] } })
      .mockResolvedValueOnce({ data: { labels: [{ id: "Label_new", name: "Cedar renamed" }] } });
    const cursor = { phase: "incremental" as const, historyId: "original-history" };
    const first = await createGmailSource(gmail).sync(cursor, supported);
    const renamed = await createGmailSource(gmail).sync(cursor, supported);
    const recreated = await createGmailSource(gmail).sync(cursor, supported);
    expect(first.scopeUpdates?.entities?.[0]?.id).toBe(renamed.scopeUpdates?.entities?.[0]?.id);
    expect(renamed.scopeUpdates?.entities?.[0]?.label).toBe("Cedar renamed");
    expect(recreated.scopeUpdates?.entities?.[0]?.id).not.toBe(
      renamed.scopeUpdates?.entities?.[0]?.id,
    );
  });
});
