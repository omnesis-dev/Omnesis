// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { MessageStore } from "../message-store.js";
import { importWhatsAppHistory } from "./importer.js";
import {
  buildChatStorageDb,
  makeEncryptedBackup,
  type FixtureCorpus,
} from "./testing/make-backup.js";
import type { StoredMessage } from "../types.js";

const scratches = vi.hoisted(() => [] as string[]);
vi.mock("@omnesis/core", async (original) => {
  const actual = await original<typeof import("@omnesis/core")>();
  return {
    ...actual,
    createPrivateScratch: (namespace: string) => {
      const scratch = actual.createPrivateScratch(namespace);
      scratches.push(scratch.path);
      return scratch;
    },
  };
});

const OWN = { jid: "15550100001@s.whatsapp.net", name: "Me" };
const CHAT = "15550100123@s.whatsapp.net";

function ts(date: string): number {
  return Math.floor(Date.parse(`${date}T12:00:00.000Z`) / 1000);
}

const CORPUS: FixtureCorpus = {
  chats: [{ pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" }],
  members: [],
  messages: [
    { pk: 1, stanzaId: "ID0001", chatPk: 1, fromMe: 0, ts: ts("2022-01-01"), type: 0, text: "one" },
    { pk: 2, stanzaId: "ID0002", chatPk: 1, fromMe: 1, ts: ts("2022-01-02"), type: 0, text: "two" },
    {
      pk: 3,
      stanzaId: "ID0003",
      chatPk: 1,
      fromMe: 0,
      ts: ts("2022-01-03"),
      type: 0,
      text: "three",
    },
  ],
};

describe("importWhatsAppHistory — merge + idempotency", () => {
  const dirs: string[] = [];
  let store: MessageStore | null = null;

  afterEach(() => {
    for (const path of scratches.splice(0)) expect(existsSync(path)).toBe(false);
    store?.close();
    store = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freshStore(): MessageStore {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-store-"));
    dirs.push(dir);
    return new MessageStore(dir);
  }

  it("imports all messages, marks days dirty, and is idempotent on re-run", async () => {
    const backup = makeEncryptedBackup({
      chatStorageBytes: buildChatStorageDb(CORPUS),
      password: "pw",
    });
    dirs.push(backup);
    store = freshStore();

    const phases: string[] = [];
    const first = await importWhatsAppHistory({
      backupPath: backup,
      passphrase: "pw",
      store,
      own: OWN,
      callbacks: { onProgress: (p) => phases.push(p.phase) },
    });

    expect(first).toEqual({ imported: 3, merged: 0, skipped: 0 });
    expect(store.totalMessages).toBe(3);
    expect(phases).toContain("decrypt");
    expect(phases).toContain("parse");
    expect(phases).toContain("merge");

    // Imported days are dirty → the normal drain will publish them.
    const drained = store.drain();
    expect(drained.dirtyKeys.size).toBeGreaterThan(0);
    expect([...drained.messagesByKey.values()].flat().length).toBe(3);

    // Re-running the same import double-counts nothing.
    const second = await importWhatsAppHistory({
      backupPath: backup,
      passphrase: "pw",
      store,
      own: OWN,
    });
    expect(second).toEqual({ imported: 0, merged: 3, skipped: 0 });
    expect(store.totalMessages).toBe(3);
  });

  it("merges with live-synced rows by stable id without double-counting", async () => {
    const backup = makeEncryptedBackup({
      chatStorageBytes: buildChatStorageDb(CORPUS),
      password: "pw",
    });
    dirs.push(backup);
    store = freshStore();

    // A message already present from live sync, sharing one imported id.
    const live: StoredMessage = {
      id: "ID0002",
      chatJid: CHAT,
      senderJid: OWN.jid,
      senderName: OWN.name,
      fromMe: true,
      timestamp: ts("2022-01-02"),
      type: "text",
      text: "two",
    };
    store.addMessages([live]);
    expect(store.totalMessages).toBe(1);

    const summary = await importWhatsAppHistory({
      backupPath: backup,
      passphrase: "pw",
      store,
      own: OWN,
    });
    expect(summary).toEqual({ imported: 2, merged: 1, skipped: 0 });
    expect(store.totalMessages).toBe(3); // union, not 1 + 3
  });

  it("never clobbers a richer live row's media with the sparse backup blob", async () => {
    const backup = makeEncryptedBackup({
      chatStorageBytes: buildChatStorageDb(CORPUS),
      password: "pw",
    });
    dirs.push(backup);
    store = freshStore();

    // A live-synced row carrying downloadable media (mediaKey + url) that the
    // backup parser never produces. Its id collides with an imported row.
    const live: StoredMessage = {
      id: "ID0002",
      chatJid: CHAT,
      senderJid: OWN.jid,
      senderName: OWN.name,
      fromMe: true,
      timestamp: ts("2022-01-02"),
      type: "image",
      text: "",
      media: {
        mimetype: "image/jpeg",
        mediaKey: "k123",
        url: "https://example.com/m",
        directPath: "/d",
      },
    };
    store.addMessages([live]);

    await importWhatsAppHistory({ backupPath: backup, passphrase: "pw", store, own: OWN });

    // The surviving ID0002 must still be the rich live row (downloadable), not
    // the sparse backup blob — otherwise the attachment becomes unrecoverable.
    const all = [...store.drain().messagesByKey.values()].flat();
    const survivor = all.find((m) => m.id === "ID0002");
    expect(survivor?.media?.mediaKey).toBe("k123");
    expect(survivor?.media?.url).toBe("https://example.com/m");
    expect(survivor?.type).toBe("image");
  });

  it("merges across multiple worker batches with a correct tally", async () => {
    const backup = makeEncryptedBackup({
      chatStorageBytes: buildChatStorageDb(CORPUS),
      password: "pw",
    });
    dirs.push(backup);
    store = freshStore();

    let mergeEvents = 0;
    const summary = await importWhatsAppHistory({
      backupPath: backup,
      passphrase: "pw",
      store,
      own: OWN,
      batchSize: 2, // 3 messages → 2 batches
      callbacks: {
        onProgress: (p) => {
          if (p.phase === "merge") mergeEvents++;
        },
      },
    });
    expect(summary).toEqual({ imported: 3, merged: 0, skipped: 0 });
    expect(store.totalMessages).toBe(3);
    expect(mergeEvents).toBeGreaterThan(1); // tally summed across >1 batch
  });

  it("removes decrypted files after cancellation during parsing", async () => {
    const backup = makeEncryptedBackup({
      chatStorageBytes: buildChatStorageDb(CORPUS),
      password: "pw",
    });
    dirs.push(backup);
    store = freshStore();
    const controller = new AbortController();
    let observedPlaintext = false;
    await expect(
      importWhatsAppHistory({
        backupPath: backup,
        passphrase: "pw",
        store,
        own: OWN,
        callbacks: {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase !== "parse") return;
            const path = join(scratches.at(-1)!, "ChatStorage.sqlite");
            observedPlaintext = existsSync(path);
            expect(statSync(path).mode & 0o777).toBe(0o600);
            controller.abort();
          },
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(observedPlaintext).toBe(true);
  });

  it("removes scratch after a worker decrypt error", async () => {
    store = freshStore();
    await expect(
      importWhatsAppHistory({
        backupPath: "/nonexistent-fictional-backup",
        passphrase: "pw",
        store,
        own: OWN,
      }),
    ).rejects.toThrow(/Manifest.plist/);
    expect(scratches.length).toBe(1);
  });

  it("rejects immediately when the abort signal is already aborted", async () => {
    const backup = makeEncryptedBackup({
      chatStorageBytes: buildChatStorageDb(CORPUS),
      password: "pw",
    });
    dirs.push(backup);
    store = freshStore();
    const ac = new AbortController();
    ac.abort();
    await expect(
      importWhatsAppHistory({
        backupPath: backup,
        passphrase: "pw",
        store,
        own: OWN,
        callbacks: { signal: ac.signal },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(store.totalMessages).toBe(0);
  });
});
