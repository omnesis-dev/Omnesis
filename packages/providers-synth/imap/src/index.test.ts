// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { ImapEmailSource } from "@omnesis/provider-imap";
import { ProviderId, SourceId } from "@omnesis/types";
import { fixtureClient, loadMessages, type ImapFixtureMessage } from "./index.js";
const state = vi.hoisted(() => ({ fixture: [] as unknown }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadSourceFixtureJson: () => state.fixture,
  loadActiveUniverse: () => ({}),
}));
const row = (uid: number): ImapFixtureMessage => ({
  uid,
  mailbox: "INBOX",
  subject: "Fictional appointment",
  from: "office@example.org",
  to: ["owner@example.com"],
  body: `Invented appointment ${uid} is confirmed.`,
  sentAt: "2026-10-03T12:00:00Z",
});
const instances: ImapEmailSource[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
});
describe("synthetic IMAP production seam", () => {
  test("bootstrap and appended UID use real normalization and incremental cursor", async () => {
    const entries = [row(1)];
    const instance = new ImapEmailSource(
      SourceId("imap:owner@example.com"),
      ProviderId("imap:owner@example.com"),
      () => fixtureClient(entries),
    );
    instances.push(instance);
    let result = await instance.sync(null);
    const first = [...result.documents];
    while (result.hasMore) {
      result = await instance.sync(result.cursor);
      first.push(...result.documents);
    }
    expect(first).toHaveLength(1);
    expect(first[0]?.metadata.documentType).toBe("email");
    expect(first[0]?.content).toContain("Invented appointment 1");
    entries.push(row(2));
    result = await instance.sync(result.cursor);
    const next = [...result.documents];
    while (result.hasMore) {
      result = await instance.sync(result.cursor);
      next.push(...result.documents);
    }
    expect(next).toHaveLength(1);
    expect(next[0]?.content).toContain("Invented appointment 2");
  });
  test("duplicate mailbox UIDs and invalid addresses fail fixture validation", () => {
    state.fixture = [row(1), row(1)];
    expect(loadMessages).toThrow("repeats a mailbox UID");
    state.fixture = [{ ...row(1), from: "not-an-address" }];
    expect(loadMessages).toThrow();
  });
  test("equal UIDs in distinct mailboxes stay distinct conversations through the production mapper", async () => {
    const entries = [
      row(1),
      { ...row(1), mailbox: "Archive", body: "An unrelated archived message." },
    ];
    const sourceId = SourceId("imap:owner@example.com");
    const instance = new ImapEmailSource(sourceId, ProviderId("imap:owner@example.com"), () =>
      fixtureClient(entries, sourceId),
    );
    instances.push(instance);
    let result = await instance.sync(null);
    const documents = [...result.documents];
    while (result.hasMore) {
      result = await instance.sync(result.cursor);
      documents.push(...result.documents);
    }
    expect(documents).toHaveLength(2);
    expect(new Set(documents.map((document) => document.externalId)).size).toBe(2);
    expect(new Set(documents.map((document) => document.metadata.extra?.threadId)).size).toBe(2);
    expect(documents.map((document) => document.content).join("\n")).toContain(
      "unrelated archived message",
    );
  });
  test("fallback identities include the source while explicit Message-IDs remain unchanged", async () => {
    const first = fixtureClient([row(1)], "imap:first@example.com");
    const second = fixtureClient([row(1)], "imap:second@example.com");
    const firstId = (await first.fetch([1], 1024))[0]?.envelope.messageId;
    const secondId = (await second.fetch([1], 1024))[0]?.envelope.messageId;
    expect(firstId).toMatch(/^<synthetic-[a-f0-9]{64}@example\.com>$/);
    expect(firstId).not.toBe(secondId);
    expect(
      (await fixtureClient([row(1)], "imap:first@example.com").fetch([1], 1024))[0]?.envelope
        .messageId,
    ).toBe(firstId);
    const explicit = "<original-fictional-message@example.org>";
    expect(
      (await fixtureClient([{ ...row(1), messageId: explicit }]).fetch([1], 1024))[0]?.envelope
        .messageId,
    ).toBe(explicit);
  });
  test("unsupported binary part fails rather than fetching an upstream service", async () => {
    await expect(fixtureClient([row(1)]).fetchAttachment(1, "2", 100)).rejects.toThrow("no binary");
  });
});
