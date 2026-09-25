#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const SEEDED_STATE_FORMAT = 1;
export const SEEDED_STATE_MANIFEST = "seeded-state-manifest.json";
export const SEEDED_STATE_MARKER = ".omnesis-seeded-state";

const INSTALL_LOCK = ".seed-install.lock";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESERVED_TARGETS = new Set([SEEDED_STATE_MANIFEST, SEEDED_STATE_MARKER, INSTALL_LOCK]);

// The FTS index and vocabulary, plus FTS5's implementation-private shadow
// tables, are derived from `chunks`. Shipping them would couple artifacts to
// SQLite's internal representation; the index database boot path recreates
// and rebuilds them from the canonical chunk rows when they are absent.
const REBUILT_TABLES = new Set([
  "chunks_fts",
  "chunks_fts_config",
  "chunks_fts_data",
  "chunks_fts_docsize",
  "chunks_fts_idx",
  "chunks_fts_vocab",
]);

// These tables contain bearer material or active delivery claims and may never
// cross the seeded-state boundary, even when a caller mistakenly allowlists one.
const FORBIDDEN_TABLES = new Set([
  // Exact unfinished source output is live write authority, never a seed.
  "pending_source_pages",
  "pending_source_page_observations",
  "access_audit_events",
  "access_grant_capabilities",
  "access_grants",
  "access_level_capabilities",
  "access_levels",
  "access_principals",
  "agent_pairing_redemption_receipts",
  "pairing_redemption_receipts",
  "answer_approvals",
  "answer_audit_events",
  "answer_audit_payloads",
  // Direct-tool audit transcripts and their payloads are the Direct lane's
  // analog of the Answer audit tables: tool arguments and results that may
  // carry corpus data, so a provisioned clone starts with none.
  "direct_audit_events",
  "direct_audit_payloads",
  "direct_audit_sessions",
  "tokens",
  "sessions",
  "device_pairings",
  "notifications",
  "notification_deliveries",
  "mobile_permission_health",
  "oauth_access_tokens",
  "oauth_authorization_requests",
  "oauth_clients",
  "oauth_execution_bindings",
  "oauth_refresh_tokens",
  "principal_credentials",
  "reauth_reminders",
  "token_identity_labels",
  "answer_conversation_tombstones",
  "answer_conversations",
  "answer_completion_deliveries",
  "answer_egress_events",
  "answer_egress_payloads",
  "answer_messages",
  "answer_releases",
  "answer_request_tombstones",
  "answer_tasks",
  "answer_workflow_disclosure",
  "answer_workflow_grants",
  "answer_workflows",
  "subscription_approvals",
  "subscription_audit_events",
  "subscription_deliveries",
  "subscription_firing_answer_authorities",
  "subscription_firing_evidence",
  "subscription_firing_outcome_authorities",
  "subscription_firing_outcomes",
  "subscription_firings",
  "subscription_grants",
  "subscription_revisions",
  "subscription_workflow_disclosure",
  "subscriptions",
]);

// Export is deliberately default-deny. Adding a production table requires an
// explicit classification here or above so schema drift cannot silently move
// credentials, delivery payloads, leases, or other live authority into a seed.
const SAFE_TABLES = new Set([
  "agent_messages",
  "brief_citations",
  "brief_claims",
  "brief_related_loops",
  "briefs",
  "canonicalization_state",
  "catalog_table_stats",
  "chunk_embeddings_building",
  "chunks",
  "cognition_consumption_edges",
  "cognition_coverage",
  "cognition_engine_state",
  "cognition_notes",
  "cognition_run_attribution",
  "cognition_runs",
  "cognition_spend",
  "cognition_spend_daily",
  "cognition_sweep_tally",
  "conversation_read_state",
  "dev_annotations",
  "device_doctor_runs",
  "devices",
  "doc_annotation_evidence",
  "doc_annotations",
  "document_absence_observations",
  "document_absence_scopes",
  "document_absences",
  "document_extracted_dates",
  "document_links",
  "document_people",
  "document_temporal_projection_sources",
  "document_temporal_projections",
  "documents",
  "index_meta",
  "index_totals",
  "index_versions",
  "indexed_documents",
  "indexing_errors",
  "link_reconcile_state",
  "link_stats",
  "link_stats_counters",
  "merge_candidates",
  "merge_rules",
  "mutable_list_revisions",
  "near_dup_df",
  "near_dup_df_meta",
  "near_dup_edges",
  "near_dup_inbox",
  "near_dup_lsh_buckets",
  "near_dup_signatures",
  "non_identifying_emails",
  "note_entries",
  "open_loop_docs",
  "open_loop_ledger",
  "open_loop_people",
  "open_loops",
  "pending_edges",
  "pending_document_index_purges",
  "pending_source_index_purges",
  "pending_vector_deletes",
  "people",
  "person_aliases",
  // Which sources vouch for each identifier. Seeded with the aliases it
  // describes: without it a clone's aliases are vouched for by nobody, and the
  // first source removal takes identifiers every other source still asserts.
  "person_alias_assertions",
  "person_annotation_evidence",
  "person_annotations",
  "person_equivalences",
  "privacy_policy_families",
  "privacy_policy_state",
  "privacy_policy_versions",
  "refresh_meta",
  "removed_documents",
  "removed_sources",
  "replica_deletion_claims",
  "retired_loops",
  "schema_migrations",
  "source_document_profiles",
  "source_devices",
  // A source family's declared name and glyph: product strings the
  // collector re-pushes on every boot, and useful in a clone before it does.
  "source_family_meta",
  "source_index_stats",
  "source_member_config_contracts",
  "source_mode_transition_publications",
  "source_stats",
  "source_stream_cleanups",
  "source_mode_transitions",
  "source_watermarks",
  "source_wipe_epoch",
  "source_wire_contracts",
  "source_sync_issues",
  "sources",
  "snapshot_absence_cascade_outbox",
  "snapshot_absence_deletions",
  "sync_state",
  "temporal_annotation_documents",
  "temporal_annotation_evidence",
  "temporal_annotation_loops",
  "temporal_annotation_people",
  "temporal_annotation_projections",
  "temporal_annotations",
  "watermark",
]);

const SENSITIVE_COLUMNS = new Map([
  [
    "devices",
    new Set([
      "apns_device_token",
      "fcm_registration_token",
      "relay_url",
      "relay_credential",
      "notification_delivery_health",
    ]),
  ],
  // Member-local source parameters may contain absolute filesystem paths.
  // A provisioned clone starts from the shared source config and discovers
  // its own local path instead of inheriting another installation's.
  ["source_devices", new Set(["config_override"])],
]);
const SAFE_ROW_FILTERS = new Map([
  ["devices", `"name" <> 'bootstrap'`],
  // Reconciliation rows are time-dependent work, not canonical seed data.
  // Retain their schemas and supporting indexes so the gateway can resume
  // normally, but every provisioned clone starts with a clean epoch.
  ["document_absence_observations", "0"],
  ["document_absence_scopes", "0"],
  ["document_absences", "0"],
  // Doctor runs are transient observations about one installation's hosts.
  // Preserve the table shape without cloning host-local health details.
  ["device_doctor_runs", "0"],
  ["snapshot_absence_cascade_outbox", "0"],
  ["snapshot_absence_deletions", "0"],
  // Replica deletion verdicts describe one installation's members disagreeing
  // about items; a clone starts with no dispute to inherit.
  ["replica_deletion_claims", "0"],
  // A cleanup journal carries live destructive work for one installation.
  // Keep its schema in a seed, never its pending or completed jobs.
  ["source_stream_cleanups", "0"],
  ["source_mode_transition_publications", "0"],
  ["source_mode_transitions", "0"],
]);

/** Return the safe export projection for a schema table, or null when it must be omitted. */
export function seededStateTableSpec(name, availableColumns) {
  if (REBUILT_TABLES.has(name)) return null;
  if (FORBIDDEN_TABLES.has(name)) return null;
  if (!SAFE_TABLES.has(name)) throw new Error(`unclassified seeded-state table: ${name}`);
  const sensitive = SENSITIVE_COLUMNS.get(name);
  if (!sensitive) return name;
  return {
    name,
    columns: availableColumns.filter((column) => !sensitive.has(column)),
  };
}

function quoteIdentifier(value) {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`invalid SQLite identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function updateHashFromFile(hash, path) {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

export function sha256File(path) {
  const hash = createHash("sha256");
  updateHashFromFile(hash, path);
  return hash.digest("hex");
}

export function sha256Inputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("seed.inputs must contain at least one provenance file");
  }
  const normalized = inputs
    .map((input) => {
      if (
        typeof input?.path !== "string" ||
        typeof input?.name !== "string" ||
        input.name.startsWith("/") ||
        input.name.split("/").includes("..")
      ) {
        throw new Error("seed input requires a safe logical name and file path");
      }
      const stats = statSync(input.path);
      if (!stats.isFile()) throw new Error(`seed input is not a regular file: ${input.path}`);
      return input;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(normalized.map((input) => input.name)).size !== normalized.length) {
    throw new Error("seed input logical names must be unique");
  }
  const hash = createHash("sha256");
  for (const input of normalized) {
    hash.update(input.name);
    hash.update("\0");
    updateHashFromFile(hash, input.path);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function manifestBytes(manifest) {
  return `${JSON.stringify(canonicalJson(manifest), null, 2)}\n`;
}

function assertSafeTarget(target) {
  if (!SAFE_NAME.test(target) || basename(target) !== target || RESERVED_TARGETS.has(target)) {
    throw new Error(`database target must be a safe, non-reserved file name: ${target}`);
  }
}

function normalizeTableSpecs(rawTables) {
  if (!Array.isArray(rawTables) || rawTables.length === 0) {
    throw new Error("at least one table is required");
  }
  const tables = rawTables
    .map((value) => (typeof value === "string" ? { name: value } : value))
    .map((table) => {
      quoteIdentifier(table?.name);
      if (REBUILT_TABLES.has(table.name)) {
        throw new Error(`derived table must be rebuilt instead of exported: ${table.name}`);
      }
      if (FORBIDDEN_TABLES.has(table.name)) {
        throw new Error(`credential-bearing table cannot be exported: ${table.name}`);
      }
      if (!SAFE_TABLES.has(table.name)) {
        throw new Error(`unclassified seeded-state table: ${table.name}`);
      }
      const columns = table.columns === undefined ? null : [...new Set(table.columns)].sort();
      columns?.forEach(quoteIdentifier);
      const sensitive = SENSITIVE_COLUMNS.get(table.name);
      if (sensitive && columns === null) {
        throw new Error(`${table.name} requires an explicit safe column projection`);
      }
      for (const column of columns ?? []) {
        if (sensitive?.has(column)) {
          throw new Error(`sensitive column cannot be exported: ${table.name}.${column}`);
        }
      }
      return { name: table.name, columns, rowFilter: SAFE_ROW_FILTERS.get(table.name) ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw new Error("allowlisted table names must be unique");
  }
  return tables;
}

function copyDatabase(spec, outputDirectory) {
  if (!existsSync(spec.source)) throw new Error(`source database does not exist: ${spec.source}`);
  assertSafeTarget(spec.target);
  const tables = normalizeTableSpecs(spec.tables);
  const tableNames = tables.map((table) => table.name);
  const views = [...new Set(spec.views ?? [])].sort();
  views.forEach(quoteIdentifier);

  const target = join(outputDirectory, spec.target);
  const source = new Database(spec.source, { readonly: true, fileMustExist: true });
  const destination = new Database(target);
  try {
    // The allowlist intentionally omits credential-bearing tables. Their rows
    // must never ship, but their schema must: the artifact records the source's
    // `user_version`, so a gateway restoring it runs no migrations and would be
    // left claiming a schema whose tables do not exist. Omitted tables are
    // therefore created empty below, and foreign keys are off while the copy is
    // assembled because parents may be populated after their children.
    destination.pragma("foreign_keys = OFF");
    destination.pragma("journal_mode = DELETE");
    destination.exec("ATTACH DATABASE '" + spec.source.replaceAll("'", "''") + "' AS seed_source");
    const schema = source
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL")
      .all();
    const byName = new Map(schema.map((row) => [`${row.type}:${row.name}`, row]));

    destination.transaction(() => {
      for (const table of tables) {
        const row = byName.get(`table:${table.name}`);
        if (!row) throw new Error(`${spec.target}: missing allowlisted table ${table.name}`);
        const availableColumns = new Set(
          source
            .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
            .all()
            .map((column) => column.name),
        );
        const selectedColumns = table.columns ?? [...availableColumns];
        if (
          selectedColumns.length === 0 ||
          selectedColumns.some((column) => !availableColumns.has(column))
        ) {
          throw new Error(`${spec.target}: invalid column projection for ${table.name}`);
        }
        destination.exec(row.sql);
        const quotedTable = quoteIdentifier(table.name);
        const quotedColumns = selectedColumns.map(quoteIdentifier).join(", ");
        destination.exec(
          `INSERT INTO main.${quotedTable} (${quotedColumns}) ` +
            `SELECT ${quotedColumns} FROM seed_source.${quotedTable}` +
            (table.rowFilter ? ` WHERE ${table.rowFilter}` : ""),
        );
      }

      for (const view of views) {
        const row = byName.get(`view:${view}`);
        if (!row) throw new Error(`${spec.target}: missing allowlisted view ${view}`);
        destination.exec(row.sql);
      }

      // Forbidden tables carry bearer material, so their rows never ship — but
      // their schema must. The artifact records the source's `user_version`, and
      // a gateway restoring it runs no migrations, so omitting the schema too
      // leaves it claiming tables that do not exist and failing at the first
      // query against one: a pairing redemption against a missing receipts
      // table, for instance. Rebuilt tables are different — the gateway
      // recreates those itself, so they stay out entirely.
      const omittedTables = schema
        .filter(
          (row) =>
            row.type === "table" &&
            !tableNames.includes(row.name) &&
            FORBIDDEN_TABLES.has(row.name),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const row of omittedTables) destination.exec(row.sql);

      const carriedTables = [...tableNames, ...omittedTables.map((row) => row.name)];
      const supportingObjects = schema
        .filter(
          (row) =>
            (row.type === "index" || row.type === "trigger") &&
            carriedTables.includes(row.tbl_name),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const row of supportingObjects) destination.exec(row.sql);

      destination.pragma(`user_version = ${source.pragma("user_version", { simple: true })}`);
    })();
    destination.exec("DETACH DATABASE seed_source");
    destination.exec("VACUUM");

    const rowCounts = Object.fromEntries(
      tables.map((table) => [
        table.name,
        destination.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`).get()
          .count,
      ]),
    );
    return {
      name: spec.target,
      bytes: statSync(target).size,
      sha256: sha256File(target),
      tables,
      views,
      rowCounts,
      userVersion: destination.pragma("user_version", { simple: true }),
    };
  } finally {
    source.close();
    destination.close();
  }
}

function validateExpectedCounts(databases, expected) {
  for (const [databaseName, counts] of Object.entries(expected?.rowCounts ?? {})) {
    const database = databases.find((entry) => entry.name === databaseName);
    if (!database) throw new Error(`expected counts reference unknown database: ${databaseName}`);
    for (const [table, count] of Object.entries(counts)) {
      if (database.rowCounts[table] !== count) {
        throw new Error(
          `${databaseName}.${table}: expected ${count} rows, found ${database.rowCounts[table] ?? "no table"}`,
        );
      }
    }
  }
}

export function createSeededStateArtifact(spec, outputDirectory) {
  if (spec.formatVersion !== SEEDED_STATE_FORMAT) {
    throw new Error(`unsupported seeded-state format: ${spec.formatVersion}`);
  }
  if (
    typeof spec.productVersion !== "string" ||
    spec.productVersion.length === 0 ||
    !Number.isSafeInteger(spec.schemaVersion) ||
    spec.schemaVersion < 0 ||
    typeof spec.seed?.name !== "string" ||
    spec.seed.name.length === 0 ||
    !Array.isArray(spec.databases) ||
    spec.databases.length === 0
  ) {
    throw new Error("product, schema, seed inputs, and at least one database are required");
  }
  const targets = spec.databases.map((database) => database.target);
  targets.forEach(assertSafeTarget);
  if (new Set(targets).size !== targets.length) throw new Error("database targets must be unique");

  mkdirSync(dirname(outputDirectory), { recursive: true });
  try {
    // Claim the final path atomically so cleanup can never remove output that
    // a concurrent creator won after a racy existence check.
    mkdirSync(outputDirectory, { mode: 0o755 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`output already exists: ${outputDirectory}`, { cause: error });
    }
    throw error;
  }
  try {
    const databases = spec.databases.map((database) => copyDatabase(database, outputDirectory));
    const main = databases.find((database) => database.name === "omnesis.db");
    if (!main || main.userVersion !== spec.schemaVersion) {
      throw new Error("schemaVersion must match the exported omnesis.db user_version");
    }
    validateExpectedCounts(databases, spec.expected);
    const manifest = {
      formatVersion: SEEDED_STATE_FORMAT,
      productVersion: spec.productVersion,
      schemaVersion: spec.schemaVersion,
      seed: { name: spec.seed.name, digest: sha256Inputs(spec.seed.inputs) },
      databases,
      expected: spec.expected ?? {},
    };
    const manifestPath = join(outputDirectory, SEEDED_STATE_MANIFEST);
    writeFileSync(manifestPath, manifestBytes(manifest), { mode: 0o444 });
    chmodSync(manifestPath, 0o444);
    for (const database of databases) chmodSync(join(outputDirectory, database.name), 0o444);
    chmodSync(outputDirectory, 0o755);
    return manifest;
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function validateManifest(manifest) {
  if (
    manifest?.formatVersion !== SEEDED_STATE_FORMAT ||
    typeof manifest.productVersion !== "string" ||
    manifest.productVersion.length === 0 ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 0 ||
    typeof manifest.seed?.name !== "string" ||
    !SHA256.test(manifest.seed?.digest ?? "") ||
    !Array.isArray(manifest.databases) ||
    manifest.databases.length === 0
  ) {
    throw new Error("invalid seeded-state manifest");
  }
  const names = manifest.databases.map((database) => database.name);
  names.forEach(assertSafeTarget);
  if (new Set(names).size !== names.length) throw new Error("duplicate seeded-state database name");
  for (const database of manifest.databases) {
    if (
      !Number.isSafeInteger(database.bytes) ||
      database.bytes < 0 ||
      !SHA256.test(database.sha256)
    ) {
      throw new Error(`invalid seeded-state metadata: ${database.name}`);
    }
  }
}

export function readAndVerifySeededStateArtifact(directory, expectedManifestSha256) {
  if (!SHA256.test(expectedManifestSha256 ?? "")) {
    throw new Error("an externally pinned manifest SHA-256 is required");
  }
  const manifestPath = join(directory, SEEDED_STATE_MANIFEST);
  if (sha256File(manifestPath) !== expectedManifestSha256) {
    throw new Error("seeded-state manifest authenticity check failed");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  for (const database of manifest.databases) {
    const path = join(directory, database.name);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size !== database.bytes || sha256File(path) !== database.sha256) {
      throw new Error(`seeded-state corruption detected: ${database.name}`);
    }
    const sqlite = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const userVersion = sqlite.pragma("user_version", { simple: true });
      if (userVersion !== database.userVersion) {
        throw new Error(`seeded-state schema metadata mismatch: ${database.name}`);
      }
    } finally {
      sqlite.close();
    }
  }
  const main = manifest.databases.find((database) => database.name === "omnesis.db");
  if (!main || main.userVersion !== manifest.schemaVersion) {
    throw new Error("seeded-state main schema metadata mismatch");
  }
  return manifest;
}

export function installSeededStateArtifact(artifactDirectory, stateDirectory, options) {
  const manifest = readAndVerifySeededStateArtifact(
    artifactDirectory,
    options?.expectedManifestSha256,
  );
  if (manifest.productVersion !== options?.productVersion) {
    throw new Error("seeded-state product version does not match this runtime");
  }
  if (
    !Number.isSafeInteger(options?.maxSchemaVersion) ||
    manifest.schemaVersion > options.maxSchemaVersion
  ) {
    throw new Error("seeded-state schema is newer than this runtime supports");
  }
  const digest = options.expectedManifestSha256;
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const lockPath = join(stateDirectory, INSTALL_LOCK);
  let lock;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(
      "seeded-state installation is already active or was interrupted; use fresh state",
      { cause: error },
    );
  }

  const markerPath = join(stateDirectory, SEEDED_STATE_MARKER);
  const temporaryFiles = [];
  const finalFiles = [];
  try {
    if (existsSync(markerPath)) {
      const installed = readFileSync(markerPath, "utf8").trim();
      if (installed !== digest) throw new Error("state was initialized from a different artifact");
      return { installed: false, digest };
    }
    const existing = readdirSync(stateDirectory).filter((entry) => entry !== INSTALL_LOCK);
    if (existing.length > 0) {
      throw new Error("seeded state requires empty, non-partial state; use fresh state");
    }

    for (const database of manifest.databases) {
      const temporary = join(stateDirectory, `.${database.name}.seed-tmp`);
      copyFileSync(join(artifactDirectory, database.name), temporary);
      chmodSync(temporary, 0o600);
      if (sha256File(temporary) !== database.sha256) {
        throw new Error(`seeded-state copy verification failed: ${database.name}`);
      }
      temporaryFiles.push({ temporary, final: join(stateDirectory, database.name) });
    }
    for (const file of temporaryFiles) {
      renameSync(file.temporary, file.final);
      finalFiles.push(file.final);
    }
    writeFileSync(markerPath, `${digest}\n`, { mode: 0o600, flag: "wx" });
    return { installed: true, digest };
  } catch (error) {
    for (const path of [...temporaryFiles.map((file) => file.temporary), ...finalFiles]) {
      rmSync(path, { force: true });
    }
    throw error;
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "create") {
    if (!first || !second) throw new Error("usage: artifact.mjs create <spec.json> <output-dir>");
    const spec = JSON.parse(readFileSync(resolve(first), "utf8"));
    const output = resolve(second);
    const manifest = createSeededStateArtifact(spec, output);
    console.log(
      JSON.stringify(
        { manifest, manifestSha256: sha256File(join(output, SEEDED_STATE_MANIFEST)) },
        null,
        2,
      ),
    );
  } else if (command === "verify") {
    if (!first) throw new Error("usage: artifact.mjs verify <artifact-dir>");
    console.log(
      JSON.stringify(
        readAndVerifySeededStateArtifact(
          resolve(first),
          process.env.OMNESIS_SEEDED_STATE_MANIFEST_SHA256,
        ),
        null,
        2,
      ),
    );
  } else if (command === "install") {
    if (!first || !second)
      throw new Error("usage: artifact.mjs install <artifact-dir> <state-dir>");
    console.log(
      JSON.stringify(
        installSeededStateArtifact(resolve(first), resolve(second), {
          expectedManifestSha256: process.env.OMNESIS_SEEDED_STATE_MANIFEST_SHA256,
          productVersion: process.env.OMNESIS_SEEDED_STATE_PRODUCT_VERSION,
          maxSchemaVersion: Number(process.env.OMNESIS_SEEDED_STATE_MAX_SCHEMA_VERSION),
        }),
      ),
    );
  } else {
    throw new Error("usage: artifact.mjs <create|verify|install> ...");
  }
}
