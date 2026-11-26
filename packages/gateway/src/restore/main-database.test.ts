// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DeviceId, SourceId, SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import {
  openEncryptedSqlite,
  sqliteFileLooksPlaintext,
  type EncryptedSqliteDatabase,
} from "../sqlite-encryption.js";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { runPostMigrationSchemaSetup } from "../data/post-migration-schema.js";
import { createDatabase } from "../db.js";
import { readKnowledgeSourceRevision } from "../brain/knowledge/source-revision.js";
import { registerKnowledgeEvidence } from "../brain/knowledge/storage-evidence.js";
import { upsertConversationDocument } from "../sources/omnesis-chat/document-writer.js";
import { buildDocumentInput } from "../sources/omnesis-chat/upsert.js";
import { renderConversation } from "../sources/omnesis-chat/render.js";
import {
  conversationEvidenceProjection,
  readConversationEvidence,
  CONVERSATION_AUTHORITY_POLICY,
} from "../sources/omnesis-chat/evidence-projection.js";
import {
  createDevice,
  getDevice,
  listDevices,
  revokeDevice,
} from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createServer } from "../server.js";
import { enqueueNewNotes, claimDueNote } from "../brain/note-agent/storage.js";
import { directWriteGate } from "../write-gate.js";
import {
  retireDeviceSources,
  sourceArchivedDevices,
} from "../data/repositories/DeviceRetirementRepository.js";
import { desktopRestoreReviewedTables } from "./authority-policy.js";
import { reconcileRestoredMainDatabase, inspectRestoredMainDatabase } from "./main-database.js";
import type { Db } from "../data/types.js";
import type { ConversationRecord } from "../agent/conversation-store.js";

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-restore-db-")));
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
  runPostMigrationSchemaSetup(db as unknown as Db);
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
    recordings: 0,
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

function retirementSource(
  db: EncryptedSqliteDatabase,
  id: string,
  deviceId: string,
  createdAt = 123,
) {
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,config,enabled,created_at,updated_at) VALUES (?,'invented',?,?,'{}',1,?,?)",
  ).run(id, id, deviceId, createdAt, createdAt);
  db.prepare("INSERT INTO source_devices(source_id,device_id,added_at) VALUES(?,?,1)").run(
    id,
    deviceId,
  );
  db.prepare(
    "INSERT INTO source_member_config_contracts(source_id,param_names) VALUES(?,'[\"path\"]')",
  ).run(id);
}
function retire(db: EncryptedSqliteDatabase, id: string, choice: "keep" | "delete") {
  revokeDevice(db as unknown as Db, DeviceId(id));
  retireDeviceSources(db as unknown as Db, DeviceId(id), choice);
}
function matchingDevice(db: EncryptedSqliteDatabase, id: string) {
  db.prepare(
    "INSERT INTO devices(id,name,kind,capabilities,paired_at) VALUES(?,?,'collector','{}',1)",
  ).run(id, "Invented counterpart " + id);
}

test("real encrypted empty current schema has exactly the reviewed ordinary tables including empty retirement tables", () => {
  const empty = createDatabase(join(dir, "empty.db"), { encryptionKey: destinationKey });
  const tables = empty
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(desktopRestoreReviewedTables());
  expect(tables).toContain("forgotten_devices");
  expect(tables).toContain("source_device_archives");
  empty.close();
  chmodSync(join(dir, "empty.db"), 0o600);
  expect(
    inspectRestoredMainDatabase({ sourcePath: join(dir, "empty.db"), sourceKey: destinationKey }),
  ).toMatchObject({ devices: 0, sources: 0, documents: 0 });
});

test("real source-owned conversation seals and temporal epochs are rebuilt with fresh local authority", () => {
  const record: ConversationRecord = {
    id: "fictional-archive-dialogue",
    callerId: "fictional-owner",
    model: "fixture",
    backend: "scripted",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    title: "Fictional archive dialogue",
    pinned: false,
    messages: [
      { role: "user", parts: [{ kind: "text", text: "Keep this archive note precise." }] },
      { role: "assistant", parts: [{ kind: "text", text: "Here is the archival summary." }] },
    ],
  };
  const rendered = renderConversation(record);
  upsertConversationDocument(
    source as unknown as Db,
    buildDocumentInput(record),
    conversationEvidenceProjection(rendered),
    [],
  );
  const id = source
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id=?")
    .get(record.id)!.id;
  expect(readConversationEvidence(source as unknown as Db, id, rendered.body)).not.toBeNull();
  const foreignReceipt = registerKnowledgeEvidence(
    source as unknown as Db,
    {
      documentId: id,
      contentHash: conversationEvidenceProjection(rendered).bodyHash,
      quote: "Keep this archive note precise.",
    },
    Date.parse(record.createdAt),
  );
  const foreignRevision = foreignReceipt.revision;
  expect(foreignRevision).not.toBeNull();
  source
    .prepare("INSERT INTO knowledge_temporal_document_epochs(document_id,epoch) VALUES(?,91)")
    .run(id);
  source.prepare("UPDATE knowledge_temporal_epoch_reset SET generation=99 WHERE id=1").run();
  target.prepare("UPDATE knowledge_temporal_epoch_reset SET generation=77 WHERE id=1").run();

  reconcile();
  const db = result();
  let freshRevision: string | null;
  try {
    expect(db.prepare("SELECT * FROM knowledge_temporal_document_epochs").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM knowledge_temporal_epoch_reset").all()).toEqual([
      { id: 1, generation: 0 },
    ]);
    expect(db.prepare("SELECT * FROM conversation_evidence_projections").all()).toEqual([]);
    const restored = db
      .prepare<[string], { content: string; metadata: string }>(
        "SELECT content,metadata FROM documents WHERE id=?",
      )
      .get(id)!;
    expect(restored.content).toBe(rendered.body);
    expect(JSON.parse(restored.metadata).evidenceAuthority).toBe(
      `unavailable:${CONVERSATION_AUTHORITY_POLICY}`,
    );
    expect(readConversationEvidence(db as unknown as Db, id, rendered.body)).toBeNull();
    freshRevision = readKnowledgeSourceRevision(db as unknown as Db, id);
    expect(freshRevision).not.toBeNull();
    expect(freshRevision).not.toBe(foreignRevision);
    // The local trusted trigger invalidates downstream receipts after the
    // imported seal is dropped; copied pending work cannot satisfy this check.
    expect(
      db
        .prepare<[string, string | null], { count: number }>(
          "SELECT count(*) AS count FROM knowledge_cascade_jobs WHERE kind='invalidate' AND target_kind='source' AND target_id=? AND revision=?",
        )
        .get(id, freshRevision)?.count,
    ).toBe(1);
    db.prepare("DELETE FROM documents WHERE id='doc-invented'").run();
    expect(
      db.prepare("SELECT generation FROM knowledge_temporal_epoch_reset WHERE id=1").pluck().get(),
    ).toBe(1);
  } finally {
    db.close();
  }
  expect(sqliteFileLooksPlaintext(join(dir, "destination.db"))).toBe(false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = createDatabase(join(dir, "destination.db"), {
      encryptionKey: destinationKey,
    });
    try {
      expect(readKnowledgeSourceRevision(reopened, id)).toBe(freshRevision);
      expect(reopened.prepare("SELECT * FROM conversation_evidence_projections").all()).toEqual([]);
      expect(
        reopened
          .prepare("SELECT generation FROM knowledge_temporal_epoch_reset WHERE id=1")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      reopened.close();
    }
  }
});

test("foreign retired provenance stays archived while target retirement and absent archive choices win over an older backup", () => {
  retire(source, foreignId, "keep");
  const targetRetired = createDevice(target as unknown as Db, {
    name: "Invented retired target",
    kind: "collector",
  });
  retirementSource(target, "retirement-choice", targetRetired.id);
  // Target discarded its contribution while a sibling kept this source alive: no archive edge is earned.
  const sibling = createDevice(target as unknown as Db, {
    name: "Invented surviving sibling",
    kind: "collector",
  });
  target
    .prepare("UPDATE sources SET multi_device_mode='partitioned' WHERE id='retirement-choice'")
    .run();
  target
    .prepare(
      "INSERT INTO source_devices(source_id,device_id,added_at) VALUES('retirement-choice',?,1)",
    )
    .run(sibling.id);
  retire(target, targetRetired.id, "delete");
  matchingDevice(source, targetRetired.id);
  retirementSource(source, "retirement-choice", targetRetired.id);
  // Even a backup keep edge for the known target ID must not override the target's absent edge.
  retire(source, targetRetired.id, "keep");
  const expected = target.prepare("SELECT * FROM forgotten_devices ORDER BY device_id").all();
  reconcile();
  const db = result();
  try {
    expect(
      db.prepare("SELECT * FROM forgotten_devices WHERE device_id=?").all(targetRetired.id),
    ).toEqual(expected);
    expect(getDevice(db as unknown as Db, targetRetired.id)).toBeNull();
    expect(listDevices(db as unknown as Db).some((device) => device.id === targetRetired.id)).toBe(
      false,
    );
    expect(
      db
        .prepare("SELECT count(*) FROM source_devices WHERE device_id IN (?,?)")
        .pluck()
        .get(targetRetired.id, foreignId),
    ).toBe(0);
    expect(
      db
        .prepare("SELECT count(*) FROM source_device_archives WHERE device_id=?")
        .pluck()
        .get(targetRetired.id),
    ).toBe(0);
    expect(sourceArchivedDevices(db as unknown as Db, SourceId("source-invented"))).toMatchObject([
      { deviceId: foreignId },
    ]);
    expect(
      db
        .prepare(
          "SELECT param_names FROM source_member_config_contracts WHERE source_id='retirement-choice'",
        )
        .pluck()
        .get(),
    ).toBe('["path"]');
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});

test("target forgotten identity cannot be revived by older active backup memberships", () => {
  const retired = createDevice(target as unknown as Db, {
    name: "Invented retired owner",
    kind: "collector",
  });
  retirementSource(target, "target-retained-history", retired.id);
  retire(target, retired.id, "keep");
  matchingDevice(source, retired.id);
  retirementSource(source, "target-retained-history", retired.id);
  const expected = target
    .prepare("SELECT * FROM forgotten_devices WHERE device_id=?")
    .get(retired.id);
  reconcile();
  const db = result();
  try {
    expect(db.prepare("SELECT * FROM forgotten_devices WHERE device_id=?").get(retired.id)).toEqual(
      expected,
    );
    expect(
      sourceArchivedDevices(db as unknown as Db, SourceId("target-retained-history")),
    ).toMatchObject([{ deviceId: retired.id }]);
    expect(getDevice(db as unknown as Db, retired.id)).toBeNull();
    expect(
      db.prepare("SELECT count(*) FROM source_devices WHERE device_id=?").pluck().get(retired.id),
    ).toBe(0);
    expect(
      db.prepare("SELECT device_id FROM sources WHERE id='target-retained-history'").pluck().get(),
    ).toBe(retired.id);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});

test("source retirement conflicting with an active target device refuses without changing target authority", () => {
  matchingDevice(source, ownerId);
  retirementSource(source, "conflicting-retirement", ownerId);
  retire(source, ownerId, "keep");
  const before = readFileSync(join(dir, "target.db"));
  expect(() => reconcile()).toThrow("could not be reconciled");
  expect(readFileSync(join(dir, "target.db"))).toEqual(before);
  expect(existsSync(join(dir, "destination.db"))).toBe(false);
});

test.each(["missing", "different-incarnation"])(
  "target archive edge is not attached to %s restored source",
  (mode) => {
    const retired = createDevice(target as unknown as Db, {
      name: "Invented historical host",
      kind: "collector",
    });
    retirementSource(target, "historical-source", retired.id);
    retire(target, retired.id, "keep");
    if (mode === "different-incarnation")
      retirementSource(source, "historical-source", foreignId, 456);
    reconcile();
    const db = result();
    try {
      expect(
        db
          .prepare("SELECT count(*) FROM forgotten_devices WHERE device_id=?")
          .pluck()
          .get(retired.id),
      ).toBe(1);
      expect(
        db
          .prepare("SELECT count(*) FROM source_device_archives WHERE device_id=?")
          .pluck()
          .get(retired.id),
      ).toBe(0);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  },
);

test("completed and unfinished recording blobs and metadata survive reconstruction unchanged", () => {
  source
    .prepare(
      "INSERT INTO recording_sessions(id,started_at,last_activity_at,created_at) VALUES('invented-recording','2026-01-01','2026-01-01','2026-01-01')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO recording_chunks(session_id,seq,started_at,duration_ms,audio,status,text,voice_vectors,next_attempt_at,received_at) VALUES('invented-recording',0,'2026-01-01',1000,?,'pending','Invented transcript',?,'2026-01-01','2026-01-01')",
    )
    .run(Buffer.from("invented audio"), Buffer.from("invented vectors"));
  source
    .prepare(
      "INSERT INTO recording_marks(session_id,note_id,marked_at) VALUES('invented-recording','invented-note','2026-01-01')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO recording_speakers(session_id,speaker,name) VALUES('invented-recording',1,'Invented speaker')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO recording_suggestion_dismissals(session_id,key,dismissed_at) VALUES('invented-recording','invented-choice','2026-01-01')",
    )
    .run();
  const tables = [
    "recording_sessions",
    "recording_chunks",
    "recording_marks",
    "recording_speakers",
    "recording_suggestion_dismissals",
  ];
  const expected = tables.map((table) => source.prepare(`SELECT * FROM ${table}`).all());
  expect(reconcile().recordings).toBe(1);
  const db = result();
  try {
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(expected);
  } finally {
    db.close();
  }
});
