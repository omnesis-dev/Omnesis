// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Baileys runs libsignal inside the collector process, so anything libsignal
// writes to the console lands in the collector's service log. Unpatched, it
// prints whole session records (ratchet private keys, root keys, chain keys)
// whenever a session is opened, closed or pruned. `patches/libsignal+6.0.0.patch`
// removes every console call; these tests load libsignal the way Baileys
// resolves it and fail if a console write is reachable again, including after
// a version bump the patch no longer applies to.

interface IndexInfo {
  baseKey: Buffer;
  baseKeyType: number;
  closed: number;
  remoteIdentityKey: Buffer;
}

interface SessionEntry {
  registrationId: number;
  indexInfo: IndexInfo;
  currentRatchet: {
    ephemeralKeyPair: { pubKey: Buffer; privKey: Buffer };
    lastRemoteEphemeralKey: Buffer;
    previousCounter: number;
    rootKey: Buffer;
  };
}

interface SessionRecord {
  sessions: Record<string, SessionEntry>;
  setSession(session: SessionEntry): void;
  openSession(session: SessionEntry): void;
  closeSession(session: SessionEntry): void;
  removeOldSessions(): void;
}

interface SessionRecordClass {
  new (): SessionRecord;
  createEntry(): SessionEntry;
  migrate(data: { _sessions: Record<string, { indexInfo: { closed: number } }> }): void;
}

interface Curve {
  generateKeyPair(): { pubKey: Buffer; privKey: Buffer };
  calculateAgreement(pubKey: Buffer, privKey: Buffer): Buffer;
}

type QueueJob = (bucket: unknown, awaitable: () => Promise<void>) => Promise<void>;

const baileysManifest = createRequire(import.meta.url).resolve(
  "@whiskeysockets/baileys/package.json",
);
const requireLibsignal = createRequire(baileysManifest);
const libsignalRoot = dirname(requireLibsignal.resolve("libsignal/package.json"));
const SessionRecord = requireLibsignal("libsignal/src/session_record.js") as SessionRecordClass;
const curve = requireLibsignal("libsignal/src/curve.js") as Curve;
const queueJob = requireLibsignal("libsignal/src/queue_job.js") as QueueJob;

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir"] as const;

/** A session entry whose key fields are distinct invented byte patterns. */
function inventedEntry(seed: number): SessionEntry {
  const bytes = (offset: number) => Buffer.alloc(32, (seed * 7 + offset) % 256);
  return Object.assign(SessionRecord.createEntry(), {
    registrationId: 1000 + seed,
    indexInfo: {
      baseKey: Buffer.concat([Buffer.from([5]), bytes(1)]),
      baseKeyType: 2,
      closed: -1,
      remoteIdentityKey: Buffer.concat([Buffer.from([5]), bytes(2)]),
    },
    currentRatchet: {
      ephemeralKeyPair: { pubKey: bytes(3), privKey: bytes(4) },
      lastRemoteEphemeralKey: bytes(5),
      previousCounter: 0,
      rootKey: bytes(6),
    },
  });
}

describe("libsignal console output", () => {
  let spies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const expectSilentConsole = () => {
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  };

  test("opening, closing and pruning sessions writes nothing to the console", () => {
    const record = new SessionRecord();
    const entries = Array.from({ length: 42 }, (_, i) => inventedEntry(i));
    for (const entry of entries) {
      record.setSession(entry);
      record.openSession(entry);
      record.openSession(entry);
      record.closeSession(entry);
      record.closeSession(entry);
    }
    record.removeOldSessions();

    expect(Object.keys(record.sessions)).toHaveLength(40);
    expectSilentConsole();
  });

  test("migrating an unversioned record writes nothing to the console", () => {
    SessionRecord.migrate({ _sessions: { invented: { indexInfo: { closed: -1 } } } });
    expectSilentConsole();
  });

  test("an unprefixed public key and an unnamed queue bucket write nothing", async () => {
    const ours = curve.generateKeyPair();
    const theirs = curve.generateKeyPair();
    curve.calculateAgreement(theirs.pubKey.subarray(1), ours.privKey);
    await queueJob({ invented: true }, async () => {});
    expectSilentConsole();
  });

  test("no libsignal source file references the console", () => {
    const srcDir = join(libsignalRoot, "src");
    const offenders = readdirSync(srcDir)
      .filter((name) => name.endsWith(".js"))
      .filter((name) => /\bconsole\b/.test(readFileSync(join(srcDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
