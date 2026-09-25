// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runSchemaSetup } from "../../packages/gateway/src/data/schema.js";
import { createIndexDatabase } from "../../packages/gateway/src/indexer/db.js";
import {
  SEEDED_STATE_MANIFEST,
  SEEDED_STATE_MARKER,
  createSeededStateArtifact,
  installSeededStateArtifact,
  readAndVerifySeededStateArtifact,
  seededStateTableSpec,
  sha256File,
} from "../seeded-state/artifact.mjs";

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omnesis-seeded-state-"));
  temporaryDirectories.push(root);
  const sourcePath = join(root, "source.db");
  const seedPath = join(root, "seed.json");
  writeFileSync(seedPath, '{"universe":"fictional-minimal"}\n');
  const source = new Database(sourcePath);
  source.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE INDEX documents_title ON documents(title);
    CREATE TABLE future_unclassified_table (secret TEXT NOT NULL);
    CREATE TABLE tokens (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '{}',
      paired_at INTEGER NOT NULL,
      apns_device_token TEXT,
      fcm_registration_token TEXT,
      relay_url TEXT,
      relay_credential TEXT,
      notification_delivery_health TEXT
    );
    INSERT INTO documents VALUES ('doc-1', 'Riverside planning notes');
    INSERT INTO tokens VALUES ('token-1', 'must-not-ship');
    INSERT INTO devices VALUES (
      'device-1', 'Fictional collector', 'collector', '{}', 100,
      'apns-secret', 'fcm-secret', 'https://relay.example', 'relay-secret', 'healthy'
    );
    INSERT INTO devices VALUES (
      'bootstrap-device', 'bootstrap', 'cli', '{}', 101,
      NULL, NULL, NULL, NULL, NULL
    );
    PRAGMA user_version = 17;
  `);
  source.close();
  return {
    root,
    sourcePath,
    seedPath,
    artifact: join(root, "artifact"),
    state: join(root, "state"),
  };
}

function spec(paths, tables = ["documents"]) {
  return {
    formatVersion: 1,
    productVersion: "0.2.0",
    schemaVersion: 17,
    seed: {
      name: "fictional-minimal",
      inputs: [{ name: "universe.json", path: paths.seedPath }],
    },
    databases: [{ source: paths.sourcePath, target: "omnesis.db", tables }],
    expected: { rowCounts: { "omnesis.db": { documents: 1 } } },
  };
}

function manifestSha(paths) {
  return sha256File(join(paths.artifact, SEEDED_STATE_MANIFEST));
}

function installOptions(paths, overrides = {}) {
  return {
    expectedManifestSha256: manifestSha(paths),
    productVersion: "0.2.0",
    maxSchemaVersion: 17,
    ...overrides,
  };
}

describe("seeded-state artifacts", () => {
  it("classifies every table in the current gateway and index schemas", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-seeded-schema-"));
    temporaryDirectories.push(root);
    const gateway = new Database(join(root, "omnesis.db"));
    runSchemaSetup(gateway);
    const index = createIndexDatabase(join(root, "index.db"), { skipWal: true });

    for (const database of [gateway, index]) {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .pluck()
        .all();
      expect(() => {
        for (const table of tables) {
          const columns = database
            .prepare("SELECT name FROM pragma_table_info(?)")
            .pluck()
            .all(table);
          seededStateTableSpec(table, columns);
        }
      }).not.toThrow();
      database.close();
    }
  });

  it("retains operational schemas but resets reconciliation and cleanup work", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-seeded-absence-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "source.db");
    const seedPath = join(root, "seed.json");
    const artifact = join(root, "artifact");
    writeFileSync(seedPath, '{"universe":"fictional-absence"}\n');
    const source = new Database(sourcePath);
    runSchemaSetup(source);
    source.exec(`
      INSERT INTO documents (
        id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at
      ) VALUES (
        'doc-absence', 'provider-fictional', 'source-fictional', 'external-fictional',
        'Fictional absence record', 'Synthetic document body', 'hash-fictional',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO document_absences (
        document_id, provider_id, source_id, stream_id, external_id,
        generation, first_absent_at, last_absent_at, observations
      ) VALUES ('doc-absence', 'provider-fictional', 'source-fictional', '',
        'external-fictional', 2, 100, 200, 3);
      INSERT INTO document_absence_scopes (
        provider_id, source_id, stream_id, generation, revision
      ) VALUES ('provider-fictional', 'source-fictional', '', 2, 4);
      INSERT INTO document_absence_observations (
        provider_id, source_id, stream_id, observation_id, created_at
      ) VALUES ('provider-fictional', 'source-fictional', '', 'observation-fictional', 200);
      INSERT INTO snapshot_absence_cascade_outbox (
        created_at, document_ids, index_done, cognition_done
      ) VALUES (200, '["doc-absence"]', 0, 0);
      INSERT INTO snapshot_absence_deletions (
        deleted_at, provider_id, source_id, stream_id, external_ids, document_count
      ) VALUES (200, 'provider-fictional', 'source-fictional', '',
        '["external-fictional"]', 1);
      INSERT INTO source_stream_cleanups (
        source_id, device_id, generation, queued_at, attempts, last_error
      ) VALUES ('source-fictional', 'device-fictional', 3, 200, 2, 'synthetic cleanup failure');
      INSERT INTO devices (id, name, kind, paired_at)
      VALUES ('00000000-0000-4000-8000-000000000001', 'collector-fictional', 'collector', 100);
      INSERT INTO device_doctor_runs (
        device_id, run_id, state, requested_at, report_json
      ) VALUES (
        '00000000-0000-4000-8000-000000000001', 'run-fictional', 'complete', 200,
        '{"target":"collector","checks":[]}'
      );
      INSERT INTO sources (
        id, type, account_id, device_id, multi_device_mode, created_at, updated_at
      ) VALUES (
        'source-transition', 'provider-fictional', 'fictional',
        '00000000-0000-4000-8000-000000000001', 'exclusive', 100, 100
      );
      INSERT INTO source_mode_transitions (
        source_id, from_mode, to_mode, owner_device_id, prepared_at, last_error
      ) VALUES (
        'source-transition', 'exclusive', 'partitioned',
        '00000000-0000-4000-8000-000000000001', 200, 'synthetic adoption failure'
      );
      INSERT INTO source_mode_transition_publications (
        source_id, completed_at, last_error
      ) VALUES (
        'source-transition', 300, 'synthetic config publication failure'
      );
      PRAGMA user_version = 148;
    `);
    source.close();

    const absenceTables = [
      "document_absences",
      "document_absence_scopes",
      "document_absence_observations",
      "device_doctor_runs",
      "snapshot_absence_cascade_outbox",
      "snapshot_absence_deletions",
      "source_stream_cleanups",
      "source_mode_transition_publications",
      "source_mode_transitions",
    ];
    createSeededStateArtifact(
      {
        formatVersion: 1,
        productVersion: "0.2.0",
        schemaVersion: 148,
        seed: { name: "fictional-absence", inputs: [{ name: "seed.json", path: seedPath }] },
        databases: [{ source: sourcePath, target: "omnesis.db", tables: absenceTables }],
        expected: {
          rowCounts: {
            "omnesis.db": Object.fromEntries(absenceTables.map((table) => [table, 0])),
          },
        },
      },
      artifact,
    );

    const output = new Database(join(artifact, "omnesis.db"), { readonly: true });
    for (const table of absenceTables) {
      expect(output.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(
      output
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_%absence%' ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual(
      [
        "idx_document_absence_observations_source_nonshared_stream",
        "idx_document_absence_observations_source_stream",
        "idx_document_absence_observations_created",
        "idx_document_absence_scopes_source_nonshared_stream",
        "idx_document_absence_scopes_source_stream",
        "idx_document_absences_source_nonshared_stream",
        "idx_document_absences_source_stream",
        "idx_document_absences_scope",
        "idx_snapshot_absence_deletions_source_nonshared_stream",
        "idx_snapshot_absence_deletions_source_stream",
        "idx_snapshot_absence_deletions_at",
      ].sort(),
    );
    expect(
      output
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_source_stream_cleanups_pending'",
        )
        .pluck()
        .get(),
    ).toBe("idx_source_stream_cleanups_pending");
    output.close();
  });

  it("redacts member-local source paths while preserving membership", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-seeded-member-config-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "source.db");
    const seedPath = join(root, "seed.json");
    const artifact = join(root, "artifact");
    writeFileSync(seedPath, '{"universe":"fictional-member-config"}\n');
    const source = new Database(sourcePath);
    runSchemaSetup(source);
    source.exec(`
      INSERT INTO devices (id, name, kind, paired_at)
      VALUES ('00000000-0000-4000-8000-000000000001', 'collector-fictional', 'collector', 100);
      INSERT INTO sources (
        id, type, account_id, device_id, multi_device_mode, created_at, updated_at
      ) VALUES (
        'claude-code:local', 'claude-code', 'local',
        '00000000-0000-4000-8000-000000000001', 'partitioned', 100, 100
      );
      INSERT INTO source_devices (
        source_id, device_id, added_at, config_override
      ) VALUES (
        'claude-code:local', '00000000-0000-4000-8000-000000000001', 100,
        '{"params":{"sessionsPath":"/tmp/fictional-origin/claude"}}'
      );
      PRAGMA user_version = 142;
    `);
    source.close();

    createSeededStateArtifact(
      {
        formatVersion: 1,
        productVersion: "0.2.0",
        schemaVersion: 142,
        seed: { name: "fictional-member-config", inputs: [{ name: "seed.json", path: seedPath }] },
        databases: [
          {
            source: sourcePath,
            target: "omnesis.db",
            tables: [
              seededStateTableSpec("source_devices", [
                "source_id",
                "device_id",
                "added_at",
                "config_override",
              ]),
            ],
          },
        ],
        expected: { rowCounts: { "omnesis.db": { source_devices: 1 } } },
      },
      artifact,
    );

    const output = new Database(join(artifact, "omnesis.db"), { readonly: true });
    expect(output.prepare("SELECT * FROM source_devices").get()).toEqual({
      source_id: "claude-code:local",
      device_id: "00000000-0000-4000-8000-000000000001",
      added_at: 100,
      config_override: "{}",
    });
    output.close();
    expect(
      readFileSync(join(artifact, "omnesis.db")).includes(
        Buffer.from("/tmp/fictional-origin/claude"),
      ),
    ).toBe(false);
  });

  it("classifies production tables with a default-deny export policy", () => {
    expect(seededStateTableSpec("documents", ["id", "title"])).toBe("documents");
    expect(seededStateTableSpec("chunks", ["id", "content"])).toBe("chunks");
    expect(
      seededStateTableSpec("source_devices", [
        "source_id",
        "device_id",
        "added_at",
        "config_override",
      ]),
    ).toEqual({
      name: "source_devices",
      columns: ["source_id", "device_id", "added_at"],
    });
    for (const table of [
      "document_absences",
      "document_absence_scopes",
      "document_absence_observations",
      "snapshot_absence_cascade_outbox",
      "snapshot_absence_deletions",
      "source_stream_cleanups",
      "source_mode_transition_publications",
      "source_mode_transitions",
    ]) {
      expect(seededStateTableSpec(table, [])).toBe(table);
    }
    expect(seededStateTableSpec("privacy_policy_families", ["id", "name"])).toBe(
      "privacy_policy_families",
    );
    expect(seededStateTableSpec("notifications", ["id", "body"])).toBeNull();
    expect(seededStateTableSpec("reauth_reminders", ["reservation_token"])).toBeNull();
    expect(seededStateTableSpec("mobile_permission_health", ["reserved_until"])).toBeNull();
    for (const table of [
      "access_audit_events",
      "access_grant_capabilities",
      "access_grants",
      "access_level_capabilities",
      "access_levels",
      "access_principals",
      "agent_pairing_redemption_receipts",
      "pairing_redemption_receipts",
      "oauth_access_tokens",
      "oauth_authorization_requests",
      "oauth_clients",
      "oauth_execution_bindings",
      "oauth_refresh_tokens",
      "principal_credentials",
    ]) {
      expect(seededStateTableSpec(table, ["secret"])).toBeNull();
    }
    for (const table of [
      "chunks_fts",
      "chunks_fts_config",
      "chunks_fts_data",
      "chunks_fts_docsize",
      "chunks_fts_idx",
      "chunks_fts_vocab",
    ]) {
      expect(seededStateTableSpec(table, [])).toBeNull();
    }
    expect(() => seededStateTableSpec("future_unclassified_table", ["secret"])).toThrow(
      /unclassified/u,
    );

    const paths = fixture();
    expect(() =>
      createSeededStateArtifact(
        spec(paths, ["documents", "future_unclassified_table"]),
        paths.artifact,
      ),
    ).toThrow(/unclassified/u);
    expect(existsSync(paths.artifact)).toBe(false);
  });

  it("omits the complete FTS5 table family and retains canonical chunks", () => {
    const paths = fixture();
    const source = new Database(paths.sourcePath);
    source.exec(`
      CREATE TABLE chunks (content TEXT NOT NULL, title TEXT NOT NULL);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        title,
        content='chunks',
        content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE chunks_fts_vocab USING fts5vocab(chunks_fts, 'row');
      INSERT INTO chunks VALUES ('Northstar workshop recipes', 'Workshop notes');
      INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
    `);
    const tables = source
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'chunks%' ORDER BY name",
      )
      .pluck()
      .all();
    source.close();

    expect(tables).toEqual([
      "chunks",
      "chunks_fts",
      "chunks_fts_config",
      "chunks_fts_data",
      "chunks_fts_docsize",
      "chunks_fts_idx",
      "chunks_fts_vocab",
    ]);
    const exportTables = tables.map((table) => seededStateTableSpec(table, [])).filter(Boolean);
    expect(exportTables).toEqual(["chunks"]);

    expect(() =>
      createSeededStateArtifact(spec(paths, ["chunks", "chunks_fts"]), paths.artifact),
    ).toThrow(/derived table must be rebuilt/u);
    expect(existsSync(paths.artifact)).toBe(false);

    const artifactSpec = spec(paths, exportTables);
    artifactSpec.expected.rowCounts["omnesis.db"] = { chunks: 1 };
    createSeededStateArtifact(artifactSpec, paths.artifact);
    const output = new Database(join(paths.artifact, "omnesis.db"), { readonly: true });
    expect(output.prepare("SELECT COUNT(*) FROM chunks").pluck().get()).toBe(1);
    expect(
      output.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'chunks_fts%'").pluck().all(),
    ).toEqual([]);
    output.close();
  });

  it("copies only explicitly allowlisted tables and preserves supporting schema", () => {
    const paths = fixture();
    const manifest = createSeededStateArtifact(spec(paths), paths.artifact);
    const output = new Database(join(paths.artifact, "omnesis.db"), { readonly: true });

    expect(manifest.databases[0].rowCounts).toEqual({ documents: 1 });
    expect(output.prepare("SELECT title FROM documents").pluck().get()).toBe(
      "Riverside planning notes",
    );
    expect(
      output.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").pluck().all(),
    ).toContain("documents_title");
    // A credential table ships its schema but never a row. The artifact records
    // the source's user_version, and a gateway restoring it runs no migrations,
    // so a missing table would stay missing and fail at the first query against
    // it. Emptiness is what protects the bearer material, not absence.
    expect(output.prepare("SELECT name FROM sqlite_schema WHERE name = 'tokens'").get()).toEqual({
      name: "tokens",
    });
    expect(output.prepare("SELECT COUNT(*) FROM tokens").pluck().get()).toBe(0);
    expect(manifest.databases[0].rowCounts.tokens).toBeUndefined();
    expect(output.pragma("user_version", { simple: true })).toBe(17);
    expect(statSync(paths.artifact).mode & 0o777).toBe(0o755);
    expect(statSync(join(paths.artifact, SEEDED_STATE_MANIFEST)).mode & 0o777).toBe(0o444);
    expect(statSync(join(paths.artifact, "omnesis.db")).mode & 0o777).toBe(0o444);
    output.close();
  });

  it("rejects credential tables and requires safe projections for credential-bearing rows", () => {
    const forbidden = fixture();
    expect(() =>
      createSeededStateArtifact(spec(forbidden, ["documents", "tokens"]), forbidden.artifact),
    ).toThrow(/credential-bearing table/u);

    const unprojected = fixture();
    expect(() =>
      createSeededStateArtifact(spec(unprojected, ["documents", "devices"]), unprojected.artifact),
    ).toThrow(/explicit safe column projection/u);

    const projected = fixture();
    createSeededStateArtifact(
      spec(projected, [
        "documents",
        {
          name: "devices",
          columns: ["id", "name", "kind", "capabilities", "paired_at"],
        },
      ]),
      projected.artifact,
    );
    const output = new Database(join(projected.artifact, "omnesis.db"), { readonly: true });
    const device = output.prepare("SELECT * FROM devices").get();
    expect(output.prepare("SELECT COUNT(*) FROM devices").pluck().get()).toBe(1);
    expect(device.name).toBe("Fictional collector");
    expect(device.apns_device_token).toBeNull();
    expect(device.fcm_registration_token).toBeNull();
    expect(device.relay_credential).toBeNull();
    output.close();
  });

  it("requires an externally pinned manifest and detects database corruption", () => {
    const paths = fixture();
    createSeededStateArtifact(spec(paths), paths.artifact);
    const expectedManifest = manifestSha(paths);

    expect(() => readAndVerifySeededStateArtifact(paths.artifact, "b".repeat(64))).toThrow(
      /authenticity/u,
    );
    chmodSync(join(paths.artifact, "omnesis.db"), 0o644);
    writeFileSync(join(paths.artifact, "omnesis.db"), "corrupt");
    expect(() => readAndVerifySeededStateArtifact(paths.artifact, expectedManifest)).toThrow(
      /corruption/u,
    );
  });

  it("enforces product and forward-schema compatibility before installation", () => {
    const paths = fixture();
    createSeededStateArtifact(spec(paths), paths.artifact);

    expect(() =>
      installSeededStateArtifact(
        paths.artifact,
        paths.state,
        installOptions(paths, { productVersion: "0.3.0" }),
      ),
    ).toThrow(/product version/u);
    expect(() =>
      installSeededStateArtifact(
        paths.artifact,
        paths.state,
        installOptions(paths, { maxSchemaVersion: 16 }),
      ),
    ).toThrow(/newer/u);
  });

  it("installs privately once, is idempotent, and refuses occupied or partial state", () => {
    const paths = fixture();
    createSeededStateArtifact(spec(paths), paths.artifact);
    const options = installOptions(paths);

    expect(installSeededStateArtifact(paths.artifact, paths.state, options).installed).toBe(true);
    expect(installSeededStateArtifact(paths.artifact, paths.state, options).installed).toBe(false);
    expect(readFileSync(join(paths.state, SEEDED_STATE_MARKER), "utf8")).toBe(
      `${options.expectedManifestSha256}\n`,
    );
    expect(statSync(paths.state).mode & 0o777).toBe(0o700);
    expect(statSync(join(paths.state, "omnesis.db")).mode & 0o777).toBe(0o600);

    const occupied = join(paths.root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "existing"), "data");
    expect(() => installSeededStateArtifact(paths.artifact, occupied, options)).toThrow(/empty/u);

    const partial = join(paths.root, "partial");
    mkdirSync(partial);
    writeFileSync(join(partial, ".seed-install.lock"), "interrupted");
    expect(() => installSeededStateArtifact(paths.artifact, partial, options)).toThrow(
      /interrupted/u,
    );
  });

  it("rejects reserved targets, wrong schema labels, and wrong semantic counts", () => {
    const reserved = fixture();
    const reservedSpec = spec(reserved);
    reservedSpec.databases[0].target = SEEDED_STATE_MANIFEST;
    expect(() => createSeededStateArtifact(reservedSpec, reserved.artifact)).toThrow(
      /non-reserved/u,
    );

    const schema = fixture();
    const schemaSpec = spec(schema);
    schemaSpec.schemaVersion = 18;
    expect(() => createSeededStateArtifact(schemaSpec, schema.artifact)).toThrow(/schemaVersion/u);

    const count = fixture();
    const countSpec = spec(count);
    countSpec.expected.rowCounts["omnesis.db"].documents = 2;
    expect(() => createSeededStateArtifact(countSpec, count.artifact)).toThrow(/expected 2 rows/u);
  });
});
