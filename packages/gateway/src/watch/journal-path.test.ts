// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Moving the watch journal onto its current name without losing anything.
 *
 * The rows are written and read back through the real driver, encrypted the
 * way a live install is, with the write-ahead log deliberately left populated —
 * because the failure this guards against is not "a few rows went missing" but
 * "the file does not open at all", and only a real WAL reproduces it.
 *
 * All fixture data is invented.
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedSqlite, sqliteFileLooksPlaintext } from "../sqlite-encryption.js";
import { resolveWatchJournal, WATCH_JOURNAL_FILENAME } from "./journal-path.js";

const LEGACY = "watch2.db";
const KEY = randomBytes(32);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A journal in the shape the runtime writes, with `rows` events.
 *
 * Closing the last connection folds the write-ahead log, so a fixture that
 * merely closes cannot reproduce the state this module exists for. Callers
 * that need an unfolded WAL use {@link snapshotMidTransaction}.
 */
function seedLegacy(rows: number, key: Buffer | null): string {
  const path = join(dir, LEGACY);
  const db = openEncryptedSqlite(path, { key });
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE watch_events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  db.exec("CREATE TABLE watch_defs (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  const event = db.prepare("INSERT INTO watch_events (seq, payload) VALUES (?, ?)");
  for (let i = 1; i <= rows; i += 1) event.run(i, `event-${i}`);
  db.prepare("INSERT INTO watch_defs (id, name) VALUES (?, ?)").run("w_1", "an-invoice-arrived");
  db.close();
  return path;
}

/**
 * The three files as they sit on disk while a gateway is running: a populated
 * write-ahead log that no clean shutdown has folded. Copied out from under a
 * live connection into a fresh directory, which is what a crash — or a `cp` of
 * a running install — actually leaves behind.
 */
function snapshotMidTransaction(rows: number, key: Buffer | null): string {
  const source = seedLegacyOpen(rows, key);
  const into = mkdtempSync(join(tmpdir(), "omnesis-journal-snap-"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${join(dir, LEGACY)}${suffix}`;
    if (existsSync(from)) copyFileSync(from, `${join(into, LEGACY)}${suffix}`);
  }
  source.close();
  return into;
}

/** Seed and hand back the still-open handle, so the WAL stays on disk. */
function seedLegacyOpen(rows: number, key: Buffer | null): { close: () => void } {
  const path = join(dir, LEGACY);
  const db = openEncryptedSqlite(path, { key });
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE watch_events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  db.exec("CREATE TABLE watch_defs (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  const event = db.prepare("INSERT INTO watch_events (seq, payload) VALUES (?, ?)");
  for (let i = 1; i <= rows; i += 1) event.run(i, `event-${i}`);
  db.prepare("INSERT INTO watch_defs (id, name) VALUES (?, ?)").run("w_1", "an-invoice-arrived");
  return db;
}

function readBack(path: string, key: Buffer | null): { events: number; watch: string | undefined } {
  const db = openEncryptedSqlite(path, { key, readonly: true });
  try {
    const events = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM watch_events").get();
    const watch = db.prepare<[], { name: string }>("SELECT name FROM watch_defs").get();
    return { events: events?.n ?? -1, watch: watch?.name };
  } finally {
    db.close();
  }
}

describe("adopting a journal written under the old name", () => {
  it("keeps every row, including the ones still in the write-ahead log", () => {
    const snap = snapshotMidTransaction(200, KEY);
    expect(existsSync(`${join(snap, LEGACY)}-wal`), "the fixture did not leave a WAL to lose").toBe(
      true,
    );

    const res = resolveWatchJournal(snap, KEY);

    expect(res.ok, res.ok ? "" : res.reason).toBe(true);
    if (!res.ok) return;
    expect(res.adopted).toBe(true);
    expect(res.existed).toBe(true);
    expect(res.path).toBe(join(snap, WATCH_JOURNAL_FILENAME));
    expect(readBack(res.path, KEY)).toEqual({ events: 200, watch: "an-invoice-arrived" });
    // Nothing live is left under the old name. A set-aside `-shm` may remain
    // (it is a regenerable index, and this module moves rather than deletes),
    // but a stranded `-wal` is what makes a moved database unopenable later.
    const liveLegacy = readdirSync(snap).filter(
      (f) => f === LEGACY || f === `${LEGACY}-wal` || f === `${LEGACY}-journal`,
    );
    expect(liveLegacy, "something live was left under the old name").toEqual([]);
    rmSync(snap, { recursive: true, force: true });
  });

  it("moves a plaintext journal without encrypting it on the boot path", () => {
    // Encrypting in place ends in a rename back onto the old name, which is
    // how a migration could create the two-file state. The ordinary opener
    // encrypts later, at the new name.
    const legacy = seedLegacy(5, null);
    expect(sqliteFileLooksPlaintext(legacy)).toBe(true);

    const res = resolveWatchJournal(dir, KEY);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readBack(res.path, null).events).toBe(5);
  });

  it("is idempotent — a second and third boot change nothing", () => {
    seedLegacy(3, KEY);
    const first = resolveWatchJournal(dir, KEY);
    expect(first.ok && first.adopted).toBe(true);

    for (const _ of [1, 2]) {
      const again = resolveWatchJournal(dir, KEY);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.adopted, "a settled install adopted something").toBe(false);
      expect(again.existed).toBe(true);
      expect(readBack(again.path, KEY).events).toBe(3);
    }
  });

  it("reports a fresh install as one that has never held a watch", () => {
    const res = resolveWatchJournal(dir, KEY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.adopted).toBe(false);
    // The distinction the anchor reconciler depends on: no watches because
    // there has never been a journal is not the operator removing them.
    expect(res.existed).toBe(false);
  });
});

describe("refusing rather than guessing", () => {
  it("will not choose between two journals that both hold data", () => {
    seedLegacy(4, KEY);
    // A second journal under the current name, also with rows.
    const target = join(dir, WATCH_JOURNAL_FILENAME);
    const db = openEncryptedSqlite(target, { key: KEY });
    db.exec("CREATE TABLE watch_events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    db.exec("CREATE TABLE watch_defs (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO watch_events (seq, payload) VALUES (1, 'other')").run();
    db.prepare("INSERT INTO watch_defs (id, name) VALUES ('w_2', 'another-watch')").run();
    db.close();

    const res = resolveWatchJournal(dir, KEY);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("both hold watch data");
    // Neither file was touched: the operator decides which one is theirs.
    expect(existsSync(join(dir, LEGACY))).toBe(true);
    expect(readBack(target, KEY).events).toBe(1);
  });

  it("sets aside an empty legacy journal a downgrade left behind", () => {
    // An older build opens the missing old name, creates an empty file and
    // boots green. Rolling forward finds two — but one provably holds nothing.
    seedLegacy(7, KEY);
    renameSync(join(dir, LEGACY), join(dir, WATCH_JOURNAL_FILENAME));
    for (const s of ["-wal", "-shm"]) {
      const from = `${join(dir, LEGACY)}${s}`;
      if (existsSync(from)) renameSync(from, `${join(dir, WATCH_JOURNAL_FILENAME)}${s}`);
    }
    const empty = openEncryptedSqlite(join(dir, LEGACY), { key: KEY });
    empty.exec("CREATE TABLE watch_events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    empty.close();

    const res = resolveWatchJournal(dir, KEY);

    expect(res.ok, res.ok ? "" : res.reason).toBe(true);
    if (!res.ok) return;
    expect(readBack(res.path, KEY).events).toBe(7);
    // Moved aside, never deleted.
    expect(readdirSync(dir).some((f) => f.includes("superseded"))).toBe(true);
  });

  it("will not move an encrypted journal it has no key for", () => {
    seedLegacy(9, KEY);

    const res = resolveWatchJournal(dir, null);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("no storage key");
    expect(
      existsSync(join(dir, LEGACY)),
      "an undecryptable file was moved into the live name",
    ).toBe(true);
  });

  it("sets aside a sidecar left behind by a database that is gone", () => {
    // Opening a new journal over a foreign write-ahead log is not something
    // that recovers.
    writeFileSync(join(dir, `${WATCH_JOURNAL_FILENAME}-wal`), "not really a wal");

    const res = resolveWatchJournal(dir, KEY);

    expect(res.ok).toBe(true);
    expect(existsSync(join(dir, `${WATCH_JOURNAL_FILENAME}-wal`))).toBe(false);
    expect(readdirSync(dir).some((f) => f.includes("orphan"))).toBe(true);
  });
});
