// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Isolated research schema. Never invoked by the production database opener. */
import { openIndexDb } from "../../../packages/gateway/src/indexer/db.js";

const TABLES = new Set(["chunks_fts", "research_next_fts", "research_previous_fts"]);

function table(name) {
  if (!TABLES.has(name)) throw new Error("Unknown research FTS table");
  return name;
}

function mode(value) {
  if (value !== "exact" && value !== "stem") throw new Error("Unknown analysis mode");
  return value;
}

export function registerNative(db, extension) {
  db.loadExtension(extension);
  // Fails before schema installation if SQLite cannot carry per-value locales.
  db.prepare("SELECT fts5_locale('en', 'capability probe')").get();
}

export function openPrototype(path, extension, options = {}) {
  const db = openIndexDb(path, options);
  try {
    registerNative(db, extension);
    const state = generation(db);
    if (state.active_fingerprint !== fingerprint(db, state.active_mode)) {
      throw new Error("The active index was built with a different analyzer binary");
    }
    if (state.pending_mode && state.pending_fingerprint !== fingerprint(db, state.pending_mode)) {
      throw new Error("The pending index was built with a different analyzer binary");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function generation(db) {
  return db.prepare("SELECT * FROM research_analysis_generation WHERE singleton=1").get();
}

export function fingerprint(db, analysisMode) {
  return db
    .prepare("SELECT omnesis_multilingual_fingerprint('und', ?) AS value")
    .get(mode(analysisMode)).value;
}

function createFts(db, name, analysisMode) {
  db.exec(`CREATE VIRTUAL TABLE ${table(name)} USING fts5(content,title,
    content='research_chunks_localized',content_rowid='rowid',locale=1,
    tokenize='omnesis_multilingual_v1 language und mode ${mode(analysisMode)}')`);
}

function refreshVocabulary(db) {
  db.exec(`DROP TABLE IF EXISTS chunks_fts_vocab;
    CREATE VIRTUAL TABLE chunks_fts_vocab USING fts5vocab(chunks_fts,'row')`);
}

function writeTriggers(db, target, tag, guard = "") {
  const name = table(target);
  const insertGuard = guard ? `WHEN new.rowid <= (${guard})` : "";
  const deleteGuard = guard ? `WHEN old.rowid <= (${guard})` : "";
  db.exec(`CREATE TRIGGER research_${tag}_ai AFTER INSERT ON chunks ${insertGuard} BEGIN
    INSERT INTO ${name}(rowid,content,title) VALUES(new.rowid,
      fts5_locale(new.research_language,new.content),
      fts5_locale(new.research_language,new.title)); END;
    CREATE TRIGGER research_${tag}_ad AFTER DELETE ON chunks ${deleteGuard} BEGIN
    INSERT INTO ${name}(${name},rowid,content,title) VALUES('delete',old.rowid,
      fts5_locale(old.research_language,old.content),
      fts5_locale(old.research_language,old.title)); END;
    CREATE TRIGGER research_${tag}_au AFTER UPDATE OF content,title,research_language ON chunks
      ${deleteGuard} BEGIN
    INSERT INTO ${name}(${name},rowid,content,title) VALUES('delete',old.rowid,
      fts5_locale(old.research_language,old.content),
      fts5_locale(old.research_language,old.title));
    INSERT INTO ${name}(rowid,content,title) VALUES(new.rowid,
      fts5_locale(new.research_language,new.content),
      fts5_locale(new.research_language,new.title)); END;`);
}

function refreshTriggers(db) {
  for (const tag of ["active", "pending", "previous"]) {
    for (const suffix of ["ai", "ad", "au"])
      db.exec(`DROP TRIGGER IF EXISTS research_${tag}_${suffix}`);
  }
  writeTriggers(db, "chunks_fts", "active");
  const state = generation(db);
  if (state.pending_mode) {
    writeTriggers(
      db,
      "research_next_fts",
      "pending",
      "SELECT watermark FROM research_analysis_generation WHERE singleton=1",
    );
  }
  if (state.previous_mode) writeTriggers(db, "research_previous_fts", "previous");
}

/** Original chunks stay authoritative; the view attaches only locale metadata. */
export function installPrototype(db, extension, analysisMode = "stem") {
  registerNative(db, extension);
  mode(analysisMode);
  if (db.prepare("SELECT 1 FROM chunks WHERE rowid<=0 LIMIT 1").get()) {
    throw new Error("Research generations require positive chunk rowids");
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_analysis_generation'").get()) {
    throw new Error("Research schema already installed; use the generation API");
  }
  db.transaction(() => {
    db.exec(`ALTER TABLE chunks ADD COLUMN research_language TEXT NOT NULL DEFAULT 'und';
      DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
      DROP TABLE chunks_fts_vocab; DROP TABLE chunks_fts;
      CREATE VIEW research_chunks_localized AS SELECT rowid,
        fts5_locale(research_language,content) AS content,
        fts5_locale(research_language,title) AS title FROM chunks;
      CREATE TABLE research_analysis_generation (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        epoch INTEGER NOT NULL,
        active_mode TEXT NOT NULL,
        active_fingerprint TEXT NOT NULL,
        pending_mode TEXT,
        pending_fingerprint TEXT,
        previous_mode TEXT,
        previous_fingerprint TEXT,
        watermark INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER research_language_changes AFTER UPDATE OF research_language ON chunks
        WHEN old.research_language != new.research_language BEGIN
        INSERT INTO chunks_fts_changes(chunk_rowid) VALUES(new.rowid); END;
      CREATE TRIGGER research_rowids_immutable BEFORE UPDATE OF rowid ON chunks
        WHEN old.rowid != new.rowid BEGIN
        SELECT RAISE(ABORT,'Research index requires stable chunk rowids'); END;
      CREATE TRIGGER research_positive_rowids AFTER INSERT ON chunks
        WHEN new.rowid<=0 BEGIN
        SELECT RAISE(ABORT,'Research index requires positive chunk rowids'); END;`);
    db.prepare(
      `INSERT INTO research_analysis_generation
      (singleton,epoch,active_mode,active_fingerprint) VALUES(1,1,?,?)`,
    ).run(analysisMode, fingerprint(db, analysisMode));
    createFts(db, "chunks_fts", analysisMode);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    refreshVocabulary(db);
    refreshTriggers(db);
  }).immediate();
}

/** Synthetic input writer; the production chunk-upsert API is not changed. */
export function putChunk(db, chunk) {
  const language = chunk.language ?? "und";
  if (!/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language) || language.includes("omnesis")) {
    throw new Error("Invalid document language");
  }
  db.prepare(
    `INSERT INTO chunks(id,document_id,chunk_index,content,title,source_id,
      document_type,source_created_at,embedding,research_language)
    VALUES(?,?,0,?,?,?,'note','2026-01-01T00:00:00Z',NULL,?)
    ON CONFLICT(id) DO UPDATE SET content=excluded.content,title=excluded.title,
      source_id=excluded.source_id,research_language=excluded.research_language`,
  ).run(
    chunk.id,
    chunk.documentId ?? chunk.id,
    chunk.content,
    chunk.title ?? "",
    chunk.sourceId ?? "synthetic-notes",
    language,
  );
}

export function assertGeneration(db, expected) {
  const state = generation(db);
  if (state.epoch !== expected.epoch || state.active_fingerprint !== expected.active_fingerprint) {
    throw new Error("Stale lexical analysis generation; rebuild the memory cache");
  }
  return state;
}

/** Start a resumable build. Writes mirror only rows already behind its cursor. */
export function beginGeneration(db, analysisMode) {
  mode(analysisMode);
  db.transaction(() => {
    const state = generation(db);
    if (state.pending_mode || state.previous_mode)
      throw new Error("Retire or discard the other generation first");
    if (state.active_mode === analysisMode)
      throw new Error("Analysis configuration is already active");
    createFts(db, "research_next_fts", analysisMode);
    db.prepare(
      `UPDATE research_analysis_generation SET pending_mode=?,pending_fingerprint=?,watermark=0
      WHERE singleton=1`,
    ).run(analysisMode, fingerprint(db, analysisMode));
    refreshTriggers(db);
  }).immediate();
}

/** Each bounded batch sees current chunk values under the single writer lock. */
export function backfillGeneration(db, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Invalid build batch size");
  return db
    .transaction(() => {
      const state = generation(db);
      if (!state.pending_mode) throw new Error("No pending analysis generation");
      const rows = db
        .prepare(
          `SELECT rowid,content,title,research_language FROM chunks
      WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(state.watermark, limit);
      const insert = db.prepare(`INSERT INTO research_next_fts(rowid,content,title)
      VALUES(?,fts5_locale(?,?),fts5_locale(?,?))`);
      for (const row of rows)
        insert.run(row.rowid, row.research_language, row.content, row.research_language, row.title);
      const watermark = rows.at(-1)?.rowid ?? state.watermark;
      db.prepare("UPDATE research_analysis_generation SET watermark=? WHERE singleton=1").run(
        watermark,
      );
      return {
        copied: rows.length,
        watermark,
        caughtUp: !db.prepare("SELECT 1 FROM chunks WHERE rowid>? LIMIT 1").get(watermark),
      };
    })
    .immediate();
}

/** The final catch-up check and schema switch share one transaction. */
export function activateGeneration(db, validate = () => {}) {
  db.transaction(() => {
    const state = generation(db);
    if (!state.pending_mode) throw new Error("No pending analysis generation");
    if (db.prepare("SELECT 1 FROM chunks WHERE rowid>? LIMIT 1").get(state.watermark)) {
      throw new Error("Pending generation is behind current writes");
    }
    validate(db);
    if (db.prepare("SELECT 1 FROM chunks WHERE rowid>? LIMIT 1").get(state.watermark)) {
      throw new Error("Validation changed the source beyond the pending build cursor");
    }
    db.exec("INSERT INTO research_next_fts(research_next_fts,rank) VALUES('integrity-check',1)");
    for (const tag of ["active", "pending"]) {
      for (const suffix of ["ai", "ad", "au"]) db.exec(`DROP TRIGGER research_${tag}_${suffix}`);
    }
    db.exec(`ALTER TABLE chunks_fts RENAME TO research_previous_fts;
      ALTER TABLE research_next_fts RENAME TO chunks_fts;
      UPDATE research_analysis_generation SET epoch=epoch+1,
        previous_mode=active_mode,previous_fingerprint=active_fingerprint,
        active_mode=pending_mode,active_fingerprint=pending_fingerprint,
        pending_mode=NULL,pending_fingerprint=NULL,watermark=0 WHERE singleton=1`);
    refreshVocabulary(db);
    refreshTriggers(db);
  }).immediate();
}

export function discardPending(db) {
  db.transaction(() => {
    if (!generation(db).pending_mode) throw new Error("No pending analysis generation");
    db.exec(
      "DROP TABLE research_next_fts; UPDATE research_analysis_generation SET pending_mode=NULL,pending_fingerprint=NULL,watermark=0 WHERE singleton=1",
    );
    refreshTriggers(db);
  }).immediate();
}

/** The retained index keeps following writes, so rollback returns current data. */
export function rollbackGeneration(db) {
  db.transaction(() => {
    const state = generation(db);
    if (!state.previous_mode) throw new Error("No retained analysis generation");
    for (const tag of ["active", "previous"]) {
      for (const suffix of ["ai", "ad", "au"]) db.exec(`DROP TRIGGER research_${tag}_${suffix}`);
    }
    db.exec(`DROP TABLE chunks_fts;
      ALTER TABLE research_previous_fts RENAME TO chunks_fts;
      UPDATE research_analysis_generation SET epoch=epoch+1,
        active_mode=previous_mode,active_fingerprint=previous_fingerprint,
        previous_mode=NULL,previous_fingerprint=NULL WHERE singleton=1`);
    refreshVocabulary(db);
    refreshTriggers(db);
  }).immediate();
}

export function retirePrevious(db) {
  db.transaction(() => {
    if (!generation(db).previous_mode) throw new Error("No retained analysis generation");
    db.exec(`DROP TABLE research_previous_fts;
      UPDATE research_analysis_generation SET previous_mode=NULL,previous_fingerprint=NULL WHERE singleton=1`);
    refreshTriggers(db);
  }).immediate();
}
