// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  ensureInstallRootKey,
  ensureStorageKey,
  markStorageEncryptionRequired,
  storageKeyPath,
} from "@omnesis/core";
import { MessageStore, inspectMessageStore } from "./message-store.js";
import type { StoredMessage } from "./types.js";

function msg(over: Partial<StoredMessage> & { id: string; timestamp: number }): StoredMessage {
  return {
    chatJid: "111@s.whatsapp.net",
    senderJid: "111@s.whatsapp.net",
    senderName: "Maya Reeves",
    fromMe: false,
    type: "text",
    text: "hello",
    ...over,
  };
}

/** Unix seconds for a fixed UTC instant on a given day. */
function ts(date: string, hour = 12): number {
  return Math.floor(Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1000);
}

describe("MessageStore (durable SQLite)", () => {
  let dir: string;
  let store: MessageStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-wa-store-"));
    store = new MessageStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("LID→phone conflict guard", () => {
    it("contests a LID seen mapping to a second phone (emits LID-only thereafter)", () => {
      store.setLIDPhone("111@lid", "+15550100301");
      expect(store.hasLIDPhone("111@lid")).toBe(true);
      // A second, different phone for the same LID → contested; no phone resolved.
      store.setLIDPhone("111@lid", "+15550100302");
      expect(store.hasLIDPhone("111@lid")).toBe(false);
      // Further mapping attempts stay suppressed.
      store.setLIDPhone("111@lid", "+15550100301");
      expect(store.hasLIDPhone("111@lid")).toBe(false);
    });

    it("keeps an idempotent (same-phone) LID mapping", () => {
      store.setLIDPhone("222@lid", "+15550100303");
      store.setLIDPhone("222@lid", "+15550100303");
      expect(store.hasLIDPhone("222@lid")).toBe(true);
    });

    it("persists contested status across reopen", () => {
      store.setLIDPhone("333@lid", "+15550100304");
      store.setLIDPhone("333@lid", "+15550100305"); // contest
      store.close();
      const reopened = new MessageStore(dir);
      expect(reopened.hasLIDPhone("333@lid")).toBe(false);
      reopened.setLIDPhone("333@lid", "+15550100304"); // still suppressed
      expect(reopened.hasLIDPhone("333@lid")).toBe(false);
      reopened.close();
      store = new MessageStore(dir); // so afterEach's close() is valid
    });
  });

  it("stores messages and renders the complete day on drain", () => {
    store.addMessages([
      msg({ id: "a", timestamp: ts("2026-01-02", 10), text: "first" }),
      msg({ id: "b", timestamp: ts("2026-01-02", 11), text: "second" }),
    ]);
    const { messagesByKey } = store.drain();
    const day = messagesByKey.get("111@s.whatsapp.net:2026-01-02");
    expect(day?.map((m) => m.text)).toEqual(["first", "second"]);
    expect(store.totalMessages).toBe(2);
  });

  it("buckets messages by UTC day", () => {
    store.addMessages([
      msg({ id: "a", timestamp: ts("2026-01-02", 23) }),
      msg({ id: "b", timestamp: ts("2026-01-03", 1) }),
    ]);
    const { messagesByKey } = store.drain();
    expect(messagesByKey.has("111@s.whatsapp.net:2026-01-02")).toBe(true);
    expect(messagesByKey.has("111@s.whatsapp.net:2026-01-03")).toBe(true);
  });

  describe("commit-gated dirty clearing", () => {
    it("refuses an acknowledgement ahead of a restored store's sequence counter", () => {
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
      const first = store.drain();
      expect(store.drain({ committedSeq: first.emitSeq + 100 }).messagesByKey.size).toBe(1);
    });
    it("does NOT clear a drained day until the gateway-confirmed committedSeq advances", () => {
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
      const first = store.drain({ committedSeq: 0 });
      expect(first.messagesByKey.size).toBe(1);
      expect(first.emitSeq).toBeGreaterThan(0);

      // Simulate a failed POST: the cursor did not advance, so committedSeq
      // stays 0. The day must re-emit.
      const retry = store.drain({ committedSeq: 0 });
      expect(retry.messagesByKey.has("111@s.whatsapp.net:2026-01-02")).toBe(true);
    });

    it("clears a day only once committedSeq proves it landed", () => {
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
      const first = store.drain({ committedSeq: 0 });
      // Gateway confirmed the page (cursor advanced to first.emitSeq).
      const next = store.drain({ committedSeq: first.emitSeq });
      expect(next.messagesByKey.size).toBe(0);
      expect(next.dirtyKeys.size).toBe(0);
    });

    it("re-dirties an already-committed day when a new message arrives for it", () => {
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02", 9) })]);
      const first = store.drain({ committedSeq: 0 });
      // Confirm, then a later message lands for the same day.
      store.addMessages([msg({ id: "b", timestamp: ts("2026-01-02", 18), text: "later" })]);
      const next = store.drain({ committedSeq: first.emitSeq });
      const day = next.messagesByKey.get("111@s.whatsapp.net:2026-01-02");
      // Full day re-rendered (old + new), never shrinks.
      expect(day?.map((m) => m.text)).toEqual(["hello", "later"]);
    });
  });

  it("paginates the dirty set and reports morePending", () => {
    for (let d = 1; d <= 5; d++) {
      store.addMessages([msg({ id: `m${d}`, timestamp: ts(`2026-01-0${d}`) })]);
    }
    const page = store.drain({ limit: 2, committedSeq: 0 });
    expect(page.dirtyKeys.size).toBe(2);
    expect(page.morePending).toBe(true);
  });

  it("skips deleted messages but keeps them in the archive", () => {
    store.addMessages([
      msg({ id: "a", timestamp: ts("2026-01-02", 10), text: "keep" }),
      msg({ id: "b", timestamp: ts("2026-01-02", 11), text: "gone" }),
    ]);
    store.markDeleted("111@s.whatsapp.net", "b", ts("2026-01-02", 11));
    const { messagesByKey } = store.drain();
    const day = messagesByKey.get("111@s.whatsapp.net:2026-01-02");
    expect(day?.map((m) => m.text)).toEqual(["keep"]);
    expect(store.totalMessages).toBe(2); // archive still holds both rows
  });

  it("applies edits in place", () => {
    store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02"), text: "typo" })]);
    store.drain({ committedSeq: 0 });
    store.updateMessage("111@s.whatsapp.net", "a", "fixed");
    const { messagesByKey } = store.drain();
    expect(messagesByKey.get("111@s.whatsapp.net:2026-01-02")?.[0].text).toBe("fixed");
  });

  describe("durability", () => {
    it("persists the archive identity across restarts and distinguishes new archives", () => {
      const original = store.storeId;
      expect(original).toMatch(/^[0-9a-f-]{36}$/);
      store.close();
      store = new MessageStore(dir);
      expect(store.storeId).toBe(original);
      const other = new MessageStore();
      try {
        expect(other.storeId).not.toBe(original);
      } finally {
        other.close();
      }
    });

    it("assigns a stable identity to an existing archive without clearing pending data", () => {
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
      store.drain();
      store.close();
      const db = new Database(join(dir, "store.db"));
      db.prepare("DELETE FROM meta WHERE key = 'store_id'").run();
      db.close();
      store = new MessageStore(dir);
      const identity = store.storeId;
      expect(store.drain().messagesByKey.size).toBe(1);
      store.close();
      store = new MessageStore(dir);
      expect(store.storeId).toBe(identity);
    });
    it("refuses to open plaintext once encryption is armed and the key is missing", async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "omnesis-wa-armed-config-"));
      const priorSecretStore = process.env.OMNESIS_SECRET_STORE;
      process.env.OMNESIS_SECRET_STORE = "file";
      try {
        // A host where `keyring init` armed the marker but nothing minted the
        // collector's keys: the archive must not quietly open unencrypted.
        await markStorageEncryptionRequired(dir);
        const accountDir = join(dir, "whatsapp", "+15550100001");
        expect(() => new MessageStore(accountDir)).toThrow(
          /WhatsApp store encryption is required.*omnesis keyring storage-init/u,
        );
        expect(existsSync(join(accountDir, "store.db"))).toBe(false);
      } finally {
        if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
        else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
      }
    });

    it("encrypts store.db when a wrapped whatsapp-store key exists", async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "omnesis-wa-secure-config-"));
      const priorSecretStore = process.env.OMNESIS_SECRET_STORE;
      process.env.OMNESIS_SECRET_STORE = "file";
      try {
        await ensureInstallRootKey({ backend: "file", configDir: dir });
        await ensureStorageKey("whatsapp-store", { backend: "file", configDir: dir });
        const accountDir = join(dir, "whatsapp", "+15550100001");
        store = new MessageStore(accountDir);
        store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02"), text: "encrypted row" })]);
        store.close();

        const dbPath = join(accountDir, "store.db");
        expect(readFileSync(dbPath).subarray(0, "SQLite format 3\0".length).toString()).not.toBe(
          "SQLite format 3\0",
        );
        expect(() => {
          const raw = new Database(dbPath, { readonly: true });
          try {
            raw.prepare("SELECT COUNT(*) FROM messages").get();
          } finally {
            raw.close();
          }
        }).toThrow();

        store = new MessageStore(accountDir);
        expect(store.totalMessages).toBe(1);
      } finally {
        if (priorSecretStore === undefined) {
          delete process.env.OMNESIS_SECRET_STORE;
        } else {
          process.env.OMNESIS_SECRET_STORE = priorSecretStore;
        }
      }
    });

    it("rekeys a copy, so the plaintext archive survives an interrupted migration", async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "omnesis-wa-rekey-config-"));
      const priorSecretStore = process.env.OMNESIS_SECRET_STORE;
      process.env.OMNESIS_SECRET_STORE = "file";
      try {
        const accountDir = join(dir, "whatsapp", "+15550100002");
        // An archive written while the install still had no storage keys.
        store = new MessageStore(accountDir);
        store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02"), text: "written plain" })]);
        store.close();

        const dbPath = join(accountDir, "store.db");
        // Held open across the migration. What this descriptor can still read
        // afterwards is exactly what a machine losing power mid-rekey would be
        // left holding: bytes are only safe if the migration never wrote them.
        const held = openSync(dbPath, "r");
        try {
          await ensureInstallRootKey({ backend: "file", configDir: dir });
          await ensureStorageKey("whatsapp-store", { backend: "file", configDir: dir });

          store = new MessageStore(accountDir);
          expect(store.totalMessages).toBe(1);

          const survivor = readFileSync(held);
          expect(survivor.subarray(0, "SQLite format 3\0".length).toString()).toBe(
            "SQLite format 3\0",
          );
          const survivorPath = join(dir, "survivor.db");
          writeFileSync(survivorPath, survivor);
          const raw = new Database(survivorPath, { readonly: true });
          try {
            expect(raw.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
          } finally {
            raw.close();
          }
        } finally {
          closeSync(held);
        }
        // Nothing of the staging copy outlives a completed migration.
        expect(existsSync(`${dbPath}.rekey`)).toBe(false);
      } finally {
        if (priorSecretStore === undefined) {
          delete process.env.OMNESIS_SECRET_STORE;
        } else {
          process.env.OMNESIS_SECRET_STORE = priorSecretStore;
        }
      }
    });

    it("keeps the plaintext archive when the encryption migration cannot finish", async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "omnesis-wa-rekey-fail-"));
      const priorSecretStore = process.env.OMNESIS_SECRET_STORE;
      process.env.OMNESIS_SECRET_STORE = "file";
      try {
        const accountDir = join(dir, "whatsapp", "+15550100004");
        store = new MessageStore(accountDir);
        store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02"), text: "written plain" })]);
        store.close();

        await ensureInstallRootKey({ backend: "file", configDir: dir });
        await ensureStorageKey("whatsapp-store", { backend: "file", configDir: dir });

        const dbPath = join(accountDir, "store.db");
        // The staging path cannot be written — the shape a full disk or a bad
        // permission takes. Everything the migration read succeeded, so the
        // archive is fine and must be left alone rather than quarantined.
        mkdirSync(`${dbPath}.rekey`, { recursive: true });

        expect(() => new MessageStore(accountDir)).toThrow(/encryption failed/i);
        expect(
          readdirSync(accountDir).filter((f) => f.includes(".corrupt-")),
          "a readable archive was quarantined because the copy failed",
        ).toEqual([]);

        rmSync(`${dbPath}.rekey`, { recursive: true, force: true });
        store = new MessageStore(accountDir);
        expect(store.totalMessages, "the archive did not survive the failed migration").toBe(1);
      } finally {
        if (priorSecretStore === undefined) {
          delete process.env.OMNESIS_SECRET_STORE;
        } else {
          process.env.OMNESIS_SECRET_STORE = priorSecretStore;
        }
      }
    });

    it("survives reopen with messages and metadata intact", () => {
      store.addChats([{ jid: "g@g.us", name: "Team", isGroup: true, participants: ["x@lid"] }]);
      store.addContacts([
        { jid: "111@s.whatsapp.net", name: "Maya Reeves", phoneNumber: "111@s.whatsapp.net" },
      ]);
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
      const seq = store.drain({ committedSeq: 0 }).emitSeq;
      store.drain({ committedSeq: seq }); // confirm — clears dirty
      store.close();

      const reopened = new MessageStore(dir);
      try {
        expect(reopened.totalMessages).toBe(1);
        expect(reopened.getChat("g@g.us")?.name).toBe("Team");
        expect(reopened.getContact("111@s.whatsapp.net")?.name).toBe("Maya Reeves");
        // A resync re-dirties the archive from disk.
        reopened.markAllDirty();
        expect(reopened.drain().messagesByKey.size).toBe(1);
      } finally {
        reopened.close();
      }
    });
  });

  describe("history sync state (tri-state)", () => {
    it("defaults to streaming and maps historySyncComplete", () => {
      expect(store.historySyncState).toBe("streaming");
      expect(store.historySyncComplete).toBe(false);
      store.setHistorySyncState("complete");
      expect(store.historySyncComplete).toBe(true);
      store.setHistorySyncState("interrupted");
      expect(store.historySyncComplete).toBe(false);
    });
  });

  describe("onChange/offChange (push registration)", () => {
    it("stops firing after offChange, and a later registration survives an earlier handler's unsubscribe", () => {
      const first: string[] = [];
      const second: string[] = [];
      const handlerA = (): void => {
        first.push("a");
      };
      const handlerB = (): void => {
        second.push("b");
      };

      store.onChange(handlerA);
      store.addMessages([msg({ id: "m1", timestamp: ts("2026-01-01") })]);
      expect(first).toEqual(["a"]);

      store.offChange(handlerA);
      store.addMessages([msg({ id: "m2", timestamp: ts("2026-01-02") })]);
      expect(first).toEqual(["a"]); // no further call

      // A second registration replaces the first; the first handler's own
      // unsubscribe must not silence the live one (identity-guarded offChange).
      store.onChange(handlerB);
      store.offChange(handlerA);
      store.addMessages([msg({ id: "m3", timestamp: ts("2026-01-03") })]);
      expect(second).toEqual(["b"]);
      expect(first).toEqual(["a"]);
    });
  });

  describe("migration from legacy message-store.json", () => {
    it("imports residue messages + metadata, maps the bool, and deletes the json", () => {
      const d = mkdtempSync(join(tmpdir(), "omnesis-wa-mig-"));
      const legacy = {
        messages: {
          "111@s.whatsapp.net": {
            a: msg({ id: "a", timestamp: ts("2026-01-02"), text: "residue" }),
          },
        },
        chats: { "g@g.us": { jid: "g@g.us", name: "Team", isGroup: true } },
        contacts: {
          "12125550123@s.whatsapp.net": {
            jid: "12125550123@s.whatsapp.net",
            name: "Maya Reeves",
            lid: "999@lid",
            phoneNumber: "12125550123@s.whatsapp.net",
          },
        },
        historySyncComplete: false,
      };
      writeFileSync(join(d, "message-store.json"), JSON.stringify(legacy));

      const migrated = new MessageStore(d);
      try {
        expect(migrated.totalMessages).toBe(1);
        // false → interrupted (never silently complete).
        expect(migrated.historySyncState).toBe("interrupted");
        // residue is marked dirty so it re-emits.
        expect(migrated.drain().messagesByKey.size).toBe(1);
        // lid→phone seeded from the imported contact.
        expect(migrated.hasLIDPhone("999@lid")).toBe(true);
        // json deleted.
        expect(existsSync(join(d, "message-store.json"))).toBe(false);
      } finally {
        migrated.close();
        rmSync(d, { recursive: true, force: true });
      }
    });

    it("is a no-op on a second open (removable migration branch)", () => {
      const d = mkdtempSync(join(tmpdir(), "omnesis-wa-mig2-"));
      writeFileSync(
        join(d, "message-store.json"),
        JSON.stringify({ messages: {}, chats: {}, contacts: {}, historySyncComplete: true }),
      );
      new MessageStore(d).close();
      // json gone; second open does not throw or re-import.
      expect(existsSync(join(d, "message-store.json"))).toBe(false);
      const again = new MessageStore(d);
      try {
        expect(again.historySyncState).toBe("complete");
      } finally {
        again.close();
      }
      rmSync(d, { recursive: true, force: true });
    });
  });

  describe("corrupt-db resilience", () => {
    it("skips malformed media JSON in retry scheduling without losing the message", () => {
      store.addMessages([
        msg({
          id: "broken-media",
          timestamp: ts("2025-01-02"),
          type: "image",
          media: { mimetype: "image/png", mediaKey: "AQID", url: "https://example.com/image.png" },
        }),
      ]);
      store.close();
      const raw = new Database(join(dir, "store.db"));
      try {
        raw.prepare("UPDATE messages SET media_json = '{broken' WHERE id = ?").run("broken-media");
      } finally {
        raw.close();
      }
      store = new MessageStore(dir);
      expect(() => store.onChange(() => {})).not.toThrow();
      expect(store.markDueMediaDirty()).toBe(0);
      expect(store.totalMessages).toBe(1);
      expect(store.drain().messagesByKey.size).toBe(1);
    });

    it("tolerates a torn JSON cell on reopen instead of crashing startup", async () => {
      store.addChats([{ jid: "g@g.us", name: "Team", isGroup: true, participants: ["x@lid"] }]);
      store.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
      store.close();

      // Corrupt the participants_json cell directly (simulates a torn write).
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(join(dir, "store.db"));
      raw
        .prepare(`UPDATE chats SET participants_json = '{not valid json' WHERE jid = 'g@g.us'`)
        .run();
      raw.close();

      // Reopen — must NOT throw out of the constructor.
      const reopened = new MessageStore(dir);
      try {
        expect(reopened.getChat("g@g.us")?.name).toBe("Team");
        expect(reopened.getChat("g@g.us")?.participants).toBeUndefined(); // bad cell dropped
        expect(reopened.totalMessages).toBe(1);
      } finally {
        reopened.close();
      }
    });

    it("quarantines a corrupt store.db together with the WAL holding its pages", () => {
      const d = mkdtempSync(join(tmpdir(), "omnesis-wa-quarantine-"));
      writeFileSync(join(d, "store.db"), "this is not a sqlite database");
      writeFileSync(join(d, "store.db-wal"), "write-ahead pages");
      writeFileSync(join(d, "store.db-shm"), "shared-memory index");

      const fresh = new MessageStore(d);
      try {
        fresh.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
        expect(fresh.totalMessages).toBe(1);

        // The sidecar travelled with the file it belongs to. It holds the
        // pages that would roll the quarantined archive back, so discarding it
        // makes setting the database aside indistinguishable from deleting it.
        const quarantined = readdirSync(d).filter((f) => f.includes(".corrupt-"));
        expect(quarantined.some((f) => f.endsWith("-wal"))).toBe(true);
        expect(readFileSync(join(d, quarantined.find((f) => f.endsWith("-wal"))!)).toString()).toBe(
          "write-ahead pages",
        );
      } finally {
        fresh.close();
        rmSync(d, { recursive: true, force: true });
      }
    });

    it("quarantines a corrupt store.db and starts fresh", () => {
      const d = mkdtempSync(join(tmpdir(), "omnesis-wa-corrupt-"));
      writeFileSync(join(d, "store.db"), "this is not a sqlite database");
      const fresh = new MessageStore(d);
      try {
        fresh.addMessages([msg({ id: "a", timestamp: ts("2026-01-02") })]);
        expect(fresh.totalMessages).toBe(1);
        // The bad file was quarantined; a real DB now lives at store.db.
        expect(readFileSync(join(d, "store.db")).length).toBeGreaterThan(100);
      } finally {
        fresh.close();
        rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe("voice-note transcripts", () => {
    it("persists a transcript and hydrates it on drain (incl. after reopen)", () => {
      store.addMessages([msg({ id: "vn", timestamp: ts("2026-01-02"), type: "audio", text: "" })]);
      store.setTranscript("111@s.whatsapp.net", "vn", "hello there");

      const day = store.drain().messagesByKey.get("111@s.whatsapp.net:2026-01-02");
      expect(day?.[0].transcript).toBe("hello there");

      store.close();
      const reopened = new MessageStore(dir);
      try {
        const after = reopened.drain().messagesByKey.get("111@s.whatsapp.net:2026-01-02");
        expect(after?.[0].transcript).toBe("hello there");
      } finally {
        reopened.close();
      }
    });

    it("hydrates an un-transcribed message's transcript as undefined", () => {
      store.addMessages([msg({ id: "vn", timestamp: ts("2026-01-02"), type: "audio", text: "" })]);
      const day = store.drain().messagesByKey.get("111@s.whatsapp.net:2026-01-02");
      expect(day?.[0].transcript).toBeUndefined();
    });

    it("preserves a stored transcript when the message is re-upserted from history", () => {
      store.addMessages([msg({ id: "vn", timestamp: ts("2026-01-02"), type: "audio", text: "" })]);
      store.setTranscript("111@s.whatsapp.net", "vn", "keep me");
      // A later history batch re-delivers the same message id.
      store.addMessages([msg({ id: "vn", timestamp: ts("2026-01-02"), type: "audio", text: "" })]);
      const day = store.drain().messagesByKey.get("111@s.whatsapp.net:2026-01-02");
      expect(day?.[0].transcript).toBe("keep me");
    });

    it("adds the transcript column to a store.db created before transcription existed", () => {
      const d = mkdtempSync(join(tmpdir(), "omnesis-wa-pretranscript-"));
      // Build a messages table without the `transcript` column, then let the
      // store's idempotent ADD COLUMN backfill it on open.
      const legacy = new Database(join(d, "store.db"));
      legacy.exec(
        `CREATE TABLE messages (chat_jid TEXT NOT NULL, id TEXT NOT NULL, sender_jid TEXT NOT NULL,
          sender_name TEXT NOT NULL, from_me INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
          text TEXT NOT NULL, media_json TEXT, reaction_emoji TEXT, reaction_target_id TEXT,
          quoted_text TEXT, quoted_sender TEXT, deleted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_jid, id));`,
      );
      legacy.close();

      const upgraded = new MessageStore(d);
      try {
        upgraded.addMessages([msg({ id: "vn", timestamp: ts("2026-01-02"), type: "audio" })]);
        upgraded.setTranscript("111@s.whatsapp.net", "vn", "backfilled");
        const day = upgraded.drain().messagesByKey.get("111@s.whatsapp.net:2026-01-02");
        expect(day?.[0].transcript).toBe("backfilled");
      } finally {
        upgraded.close();
        rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe("voice-note transcript re-render", () => {
    const CHAT = "111@s.whatsapp.net";
    const voiceNote = (id: string, t: number): StoredMessage =>
      msg({
        id,
        timestamp: t,
        type: "audio",
        text: "",
        media: {
          isVoiceNote: true,
          mediaKey: "k",
          directPath: "/x",
          seconds: 9,
          mimetype: "audio/ogg",
        },
      });

    it("drain surfaces a persisted transcript when the day is re-dirtied by later activity", () => {
      store.addMessages([voiceNote("vn1", ts("2026-02-01", 10))]);
      const s1 = store.drain({ committedSeq: 0 });
      store.drain({ committedSeq: s1.emitSeq }); // confirm emit → clears the day
      store.setTranscript(CHAT, "vn1", "hello there");
      // later activity re-dirties the day
      store.addMessages([msg({ id: "t2", timestamp: ts("2026-02-01", 11), text: "later" })]);
      const day = store.drain({ committedSeq: s1.emitSeq }).messagesByKey.get(`${CHAT}:2026-02-01`);
      expect(day?.find((m) => m.id === "vn1")?.transcript).toBe("hello there");
    });

    it("a transcript persisted AFTER its day was committed re-emits the day (no stale placeholder)", () => {
      store.addMessages([voiceNote("vn1", ts("2026-02-02", 10))]);
      const s1 = store.drain({ committedSeq: 0 });
      expect(s1.messagesByKey.get(`${CHAT}:2026-02-02`)?.[0].transcript).toBeUndefined();
      store.drain({ committedSeq: s1.emitSeq }); // confirm emit → clears the dirty day

      // Transcription persists out-of-band (e.g. a media-retry that only succeeds
      // on a later sync). The day must re-emit so the transcript reaches the
      // gateway doc — otherwise the conversation is stuck on a [Voice note]
      // placeholder until unrelated activity happens to re-dirty the day.
      store.setTranscript(CHAT, "vn1", "the spoken words");

      const day = store.drain({ committedSeq: s1.emitSeq }).messagesByKey.get(`${CHAT}:2026-02-02`);
      expect(day, "a newly-persisted transcript must re-dirty + re-emit its day").toBeDefined();
      expect(day?.find((m) => m.id === "vn1")?.transcript).toBe("the spoken words");
    });
  });
});

describe("inspectMessageStore", () => {
  let configDir: string;
  let priorSecretStore: string | undefined;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-wa-inspect-"));
    priorSecretStore = process.env.OMNESIS_SECRET_STORE;
    process.env.OMNESIS_SECRET_STORE = "file";
  });
  afterEach(() => {
    if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
    rmSync(configDir, { recursive: true, force: true });
  });
  const accountDir = () => join(configDir, "whatsapp", "+15550100001");

  it("reports an archive that was never written as absent", () => {
    expect(inspectMessageStore(accountDir())).toEqual({
      keyName: "whatsapp-store",
      label: "WhatsApp message archive",
      state: "absent",
    });
  });

  it("reports a plaintext archive, and an encrypted one as locked until its key exists", async () => {
    const plain = new MessageStore(accountDir());
    plain.addMessages([msg({ id: "a", timestamp: ts("2026-01-02"), text: "plain" })]);
    plain.close();
    expect(inspectMessageStore(accountDir())).toMatchObject({ state: "plaintext" });

    await ensureInstallRootKey({ backend: "file", configDir });
    await ensureStorageKey("whatsapp-store", { backend: "file", configDir });
    // Opening with the key migrates the archive; the probe then verifies it
    // opens with this host's key without touching it.
    const encrypted = new MessageStore(accountDir());
    expect(encrypted.totalMessages).toBe(1);
    encrypted.close();
    expect(inspectMessageStore(accountDir())).toMatchObject({ state: "encrypted" });

    // The wrapped key gone: the archive is not plaintext and cannot be verified.
    rmSync(storageKeyPath("whatsapp-store", configDir));
    expect(inspectMessageStore(accountDir())).toMatchObject({
      state: "locked",
      detail: "No wrapped key exists for it.",
    });

    // A fresh key that never wrote the archive does not open it.
    await ensureStorageKey("whatsapp-store", { backend: "file", configDir });
    expect(inspectMessageStore(accountDir())).toMatchObject({
      state: "unverifiable",
      detail: "It did not open with this host's key.",
    });
  });
});
