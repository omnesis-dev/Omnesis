// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import {
  openEncryptedSqlite,
  sqliteFileLooksPlaintext,
  type EncryptedSqliteDatabase,
} from "../sqlite-encryption.js";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createServer } from "../server.js";
import { enqueueNewNotes, claimDueNote } from "../brain/note-agent/storage.js";
import { directWriteGate } from "../write-gate.js";
import { reconcileRestoredMainDatabase } from "./main-database.js";
import type { Db } from "../data/types.js";

let dir: string;
let sourceKey: Buffer;
let targetKey: Buffer;
let destinationKey: Buffer;
let source: EncryptedSqliteDatabase;
let target: EncryptedSqliteDatabase;
let ownerToken: string;
let ownerId: string;
let foreignToken: string;
let foreignId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-restore-db-"));
  sourceKey = randomBytes(32);
  targetKey = randomBytes(32);
  destinationKey = randomBytes(32);
  source = create("source.db", sourceKey);
  target = create("target.db", targetKey);
  const owner = createDevice(target as unknown as Db, {
    name: "Fictional target desktop",
    kind: "cli",
  });
  ownerId = owner.id;
  ownerToken = createToken(target as unknown as Db, owner.id, [SCOPE_ADMIN, SCOPE_READ]).token;
  const foreign = createDevice(source as unknown as Db, {
    name: "Fictional imported collector",
    kind: "collector",
  });
  foreignId = foreign.id;
  foreignToken = createToken(source as unknown as Db, foreign.id, [SCOPE_READ]).token;
  source
    .prepare(
      "UPDATE devices SET enrollment_public_key='foreign-key',install_id='foreign-install',relay_credential='foreign-relay-secret',apns_device_token='foreign-push' WHERE id=?",
    )
    .run(foreign.id);
  source
    .prepare(
      "INSERT INTO sources(id,type,account_id,device_id,config,enabled,created_at,updated_at) VALUES ('source-invented','invented','account-invented',?,'{}',1,1,1)",
    )
    .run(foreign.id);
  source
    .prepare(
      "INSERT INTO source_devices(source_id,device_id,added_at) VALUES ('source-invented',?,1)",
    )
    .run(foreign.id);
  source
    .prepare(
      "INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at) VALUES ('doc-invented','invented','source-invented','external-invented','Invented title','Invented private content','fixture','2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
    )
    .run();
});
afterEach(() => {
  if (source.open) source.close();
  if (target.open) target.close();
  rmSync(dir, { recursive: true, force: true });
});
function create(name: string, key: Buffer | null): EncryptedSqliteDatabase {
  const db = openEncryptedSqlite(join(dir, name), { key });
  // Invented input fixtures need real encryption/schema, not 220 durable migration commits.
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  runSchemaSetup(db as unknown as Db);
  runMigrations(db as unknown as Db);
  chmodSync(join(dir, name), 0o600);
  return db;
}
function reconcile() {
  source.close();
  target.close();
  return reconcileRestoredMainDatabase({
    sourcePath: join(dir, "source.db"),
    targetPath: join(dir, "target.db"),
    destinationPath: join(dir, "destination.db"),
    sourceKey,
    targetKey,
    destinationKey,
  });
}
function result(): EncryptedSqliteDatabase {
  return openEncryptedSqlite(join(dir, "destination.db"), { key: destinationKey });
}

test("keeps target native HTTP authority and imports encrypted inert personal data without foreign grants", async () => {
  target.prepare("INSERT INTO lab_features(id,enabled) VALUES ('brain',1)").run();
  const columns = source.prepare("PRAGMA table_info(agent_messages)").all() as Array<{
    name: string;
    type: string;
    pk: number;
    notnull: number;
    dflt_value: string | null;
  }>;
  source.exec("DROP TABLE agent_messages");
  source.exec(
    `CREATE TABLE agent_messages(${columns
      .reverse()
      .map(
        (column) =>
          `"${column.name}" ${column.type} ${column.pk ? "PRIMARY KEY" : ""} ${column.notnull ? "NOT NULL" : ""} ${column.dflt_value ? `DEFAULT ${column.dflt_value}` : ""}`,
      )
      .join(",")})`,
  );
  source
    .prepare(
      "INSERT INTO agent_messages(id,harness,channel,chat_id,day,role,text,occurred_at) VALUES('message-invented','openclaw','channel','chat-invented','2026-01-01','user','Invented archived message','2026-01-01T00:00:00Z')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO note_entries(id,day,captured_at,updated_at,received_at,text,from_owner) VALUES('note-invented','2026-01-01','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','Invented old note',1)",
    )
    .run();
  source
    .prepare(
      "INSERT INTO voice_note_transcriptions(note_id,audio,mime_type,saved_text,placeholder,next_attempt_at,created_at) VALUES('note-invented',?,'audio/wav','Invented old note',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
    )
    .run(Buffer.from("invented audio"));
  target
    .prepare(
      "INSERT INTO answer_workflows(id,owner_id,name,created_at,expires_at) VALUES('target-workflow','fictional-owner','Invented workflow',1,9999999999999)",
    )
    .run();
  target
    .prepare(
      "INSERT INTO subscriptions(id,integration_device_id,owner_id,workflow_id,client_request_id,request_fingerprint,status,created_at,updated_at) VALUES('target-subscription',?,'fictional-owner','target-workflow','request-invented','fixture','active',1,1)",
    )
    .run(ownerId);
  target
    .prepare(
      "INSERT INTO device_pairings(pairing_code,name,kind,created_at,expires_at) VALUES('invented-pending','Pending fictional device','cli',1,9999999999999)",
    )
    .run();
  const proof = reconcile();
  expect(proof).toMatchObject({
    sourcesPaused: 1,
    foreignDevicesRetained: 1,
    targetDevicesPreserved: 1,
    targetLabs: { brain: true, tasks: false, watches: false },
  });
  expect(sqliteFileLooksPlaintext(join(dir, "destination.db"))).toBe(false);
  expect(readFileSync(join(dir, "destination.db"), "utf8")).not.toContain(
    "Invented private content",
  );
  const db = result();
  const offlineDocuments = Number(db.prepare("SELECT count(*) FROM documents").pluck().get());
  const sourceRuntimes: Array<{ flushAll(): Promise<void>; dispose(): void }> = [];
  const app = createServer(db as unknown as Db, join(dir, "destination.db"), {
    configDir: dir,
    writeGate: directWriteGate(db as unknown as Db),
    onAgentConversationsRuntime: (runtime) => sourceRuntimes.push(runtime),
    onOmnesisNotesRuntime: (runtime) => sourceRuntimes.push(runtime),
  });
  try {
    const whoami = await app.request("/whoami", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({ deviceId: ownerId });
    expect(
      (await app.request("/whoami", { headers: { authorization: `Bearer ${foreignToken}` } }))
        .status,
    ).toBe(401);
    expect(db.prepare("SELECT content FROM documents WHERE id='doc-invented'").pluck().get()).toBe(
      "Invented private content",
    );
    expect(db.prepare("SELECT enabled FROM sources").pluck().get()).toBe(0);
    expect(
      db.prepare("SELECT text FROM agent_messages WHERE id='message-invented'").pluck().get(),
    ).toBe("Invented archived message");
    expect(
      db.prepare("SELECT count(*) FROM source_devices WHERE device_id=?").pluck().get(foreignId),
    ).toBe(1);
    const imported = db
      .prepare(
        "SELECT enrollment_public_key,install_id,relay_credential,apns_device_token,revoked_at,capabilities FROM devices WHERE id=?",
      )
      .get(foreignId);
    expect(imported).toMatchObject({
      enrollment_public_key: null,
      install_id: null,
      relay_credential: null,
      apns_device_token: null,
      capabilities: "{}",
    });
    expect((imported as { revoked_at: number }).revoked_at).toBeGreaterThan(0);
    expect(db.prepare("SELECT enabled FROM lab_features WHERE id='brain'").pluck().get()).toBe(0);
    expect(
      db.prepare("SELECT state FROM note_agent_runs WHERE entry_id='note-invented'").pluck().get(),
    ).toBe("skipped");
    expect(enqueueNewNotes(db as unknown as Db, Date.now())).toBe(0);
    expect(claimDueNote(db as unknown as Db, Date.now())).toBeNull();
    expect(db.prepare("SELECT next_attempt_at FROM voice_note_transcriptions").pluck().get()).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    expect(
      db.prepare("SELECT status FROM subscriptions WHERE id='target-subscription'").pluck().get(),
    ).toBe("paused");
    expect(db.prepare("SELECT count(*) FROM device_pairings").pluck().get()).toBe(0);
    // A valid backup can contain a committed ledger turn whose asynchronous
    // document projection had not run yet. Trusted boot adds that derived row.
    for (const runtime of sourceRuntimes) await runtime.flushAll();
    expect(Number(db.prepare("SELECT count(*) FROM documents").pluck().get())).toBeGreaterThan(
      offlineDocuments,
    );
    expect(db.prepare("SELECT content FROM documents WHERE id='doc-invented'").pluck().get()).toBe(
      "Invented private content",
    );
    expect(
      (
        await app.request("/documents/doc-invented", {
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).status,
    ).toBe(200);
  } finally {
    for (const runtime of sourceRuntimes) {
      await runtime.flushAll();
      runtime.dispose();
    }
    await app.close();
    db.close();
  }
});
test("never installs or invokes foreign triggers while reconstructing trusted schema", () => {
  source.exec(
    `CREATE TRIGGER restore_authority_attack AFTER UPDATE ON sources BEGIN INSERT INTO tokens(id,device_id,token_hash,scopes,created_at) VALUES ('attack','${foreignId}','foreign-trigger-hash','["admin"]',1); END`,
  );
  reconcile();
  const db = result();
  try {
    expect(
      db
        .prepare(
          "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='restore_authority_attack'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(db.prepare("SELECT count(*) FROM tokens WHERE id='attack'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM tokens").pluck().get()).toBe(1);
  } finally {
    db.close();
  }
});
test("unknown or forward schema refuses before creating a destination and leaves target byte-identical", () => {
  source.exec("CREATE TABLE unreviewed_authority(secret TEXT)");
  source.close();
  target.close();
  const before = readFileSync(join(dir, "target.db"));
  expect(() =>
    reconcileRestoredMainDatabase({
      sourcePath: join(dir, "source.db"),
      targetPath: join(dir, "target.db"),
      destinationPath: join(dir, "destination.db"),
      sourceKey,
      targetKey,
      destinationKey,
    }),
  ).toThrow("could not be reconciled");
  expect(existsSync(join(dir, "destination.db"))).toBe(false);
  expect(readFileSync(join(dir, "target.db"))).toEqual(before);
});
test("does not overwrite an existing destination and refuses damaged/wrong-key input", () => {
  const existing = create("destination.db", destinationKey);
  existing.close();
  const before = readFileSync(join(dir, "destination.db"));
  expect(() => reconcile()).toThrow("could not be reconciled");
  expect(readFileSync(join(dir, "destination.db"))).toEqual(before);
});

test("foreign generated columns are refused before any destination is created", () => {
  source.exec(
    "ALTER TABLE sources ADD COLUMN injected_generated TEXT GENERATED ALWAYS AS (lower(id)) VIRTUAL",
  );
  source.close();
  target.close();
  const before = readFileSync(join(dir, "target.db"));
  expect(() =>
    reconcileRestoredMainDatabase({
      sourcePath: join(dir, "source.db"),
      targetPath: join(dir, "target.db"),
      destinationPath: join(dir, "destination.db"),
      sourceKey,
      targetKey,
      destinationKey,
    }),
  ).toThrow("could not be reconciled");
  expect(existsSync(join(dir, "destination.db"))).toBe(false);
  expect(readFileSync(join(dir, "target.db"))).toEqual(before);
});

test("legacy SQLite images are read only from bounded memory and produce encrypted storage directly", () => {
  const image = source.serialize();
  expect(image.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  source.close();
  target.close();
  const before = readFileSync(join(dir, "target.db"));
  const proof = reconcileRestoredMainDatabase({
    sourceImage: image,
    targetPath: join(dir, "target.db"),
    destinationPath: join(dir, "destination.db"),
    targetKey,
    destinationKey,
  });
  expect(proof.sourcesPaused).toBe(1);
  expect(sqliteFileLooksPlaintext(join(dir, "destination.db"))).toBe(false);
  expect(readFileSync(join(dir, "destination.db"), "utf8")).not.toContain(
    "Invented private content",
  );
  expect(readFileSync(join(dir, "target.db"))).toEqual(before);
  const db = result();
  try {
    expect(db.prepare("SELECT content FROM documents WHERE id='doc-invented'").pluck().get()).toBe(
      "Invented private content",
    );
  } finally {
    db.close();
    image.fill(0);
  }
});
