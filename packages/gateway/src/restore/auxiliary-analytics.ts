// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { z } from "zod";
import { fsyncFileSync } from "@omnesis/core";
import { normalizeAnalyticsColumnType } from "@omnesis/source-sdk";
import { BUNDLED_DUCKDB_EXTENSION_DIRECTORY } from "../analytics/connection-pool.js";
import {
  ensureAnalyticsTemporalProjectionSchema,
  TEMPORAL_PROJECTIONS_TABLE,
  TEMPORAL_PROJECTION_SOURCES_TABLE,
  TEMPORAL_PROJECTION_MOVES_TABLE,
} from "../analytics/temporal-projection-store.js";
import { serveRestoreMemoryFile } from "./auxiliary-memory-file.js";
import type { AuxiliaryRestoreResult, RestoredAuxiliarySource } from "./auxiliary-watch.js";

const name = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/.test(value));
const tableSchema = z.object({
  schema_name: name,
  table_name: name,
  sql: z.string().max(1024 * 1024),
});
const columnSchema = z.object({
  column_name: name,
  data_type: z.string().max(256),
  is_nullable: z.boolean(),
  column_default: z.string().max(4096).nullable(),
});
const constraintSchema = z.object({
  constraint_type: z.string().max(64),
  columns: z.string().max(32 * 1024),
  constraint_text: z.string().max(32 * 1024),
});
const temporalTables = new Set([
  TEMPORAL_PROJECTIONS_TABLE,
  TEMPORAL_PROJECTION_SOURCES_TABLE,
  TEMPORAL_PROJECTION_MOVES_TABLE,
]);

/** Worker-only, catalog is data: no foreign DDL, views, macros, generated expressions or extension loading. */
export async function rebuildRestoredAnalyticsDatabase(
  options: RestoredAuxiliarySource & {
    destinationPath: string;
    destinationKey: Buffer;
    signal: AbortSignal;
  },
): Promise<AuxiliaryRestoreResult> {
  if (
    options.destinationKey.length !== 32 ||
    (options.sourceKey && options.sourceKey.length !== 32)
  )
    throw new Error("The analytics restore storage keys are unavailable");
  if (
    options.sourceImage &&
    (options.sourceImage.length > 64 * 1024 ** 2 ||
      options.sourceImage.subarray(8, 12).toString("ascii") !== "DUCK" ||
      options.sourceImage.readBigUInt64LE(20) & 1n)
  )
    throw new Error("Unsupported memory-only legacy analytics image");
  try {
    await lstat(options.destinationPath);
    throw new Error("The analytics restore destination already exists");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let instance: DuckDBInstance | undefined, connection: DuckDBConnection | undefined;
  let memoryFile: Awaited<ReturnType<typeof serveRestoreMemoryFile>> | undefined;
  let output: { dev: bigint; ino: bigint } | undefined,
    completed = false;
  let result: AuxiliaryRestoreResult | undefined;
  let failed = false,
    operationFailure: unknown;
  const interrupt = () => {
    try {
      connection?.interrupt();
    } catch {
      /* The owned connection may already be draining. */
    }
  };
  try {
    options.signal.throwIfAborted();
    instance = await DuckDBInstance.create(":memory:", {
      threads: "1",
      memory_limit: "128MB",
      temp_directory: "",
      autoload_known_extensions: "false",
      autoinstall_known_extensions: "false",
      allow_unsigned_extensions: "false",
      enable_external_file_cache: "false",
    });
    connection = await instance.connect();
    options.signal.addEventListener("abort", interrupt, { once: true });
    const [version, platform] = (
      await connection.runAndReadAll("SELECT version(), (SELECT platform FROM pragma_platform())")
    ).getRows()[0]!;
    const extension = join(
      BUNDLED_DUCKDB_EXTENSION_DIRECTORY,
      String(version),
      String(platform),
      "httpfs.duckdb_extension",
    );
    await connection.run(`LOAD ${literal(extension)}`);
    await connection.run("SET enable_http_metadata_cache=false");
    await connection.run("SET http_proxy=''");
    await connection.run("SET enable_http_logging=false");
    let source = options.sourcePath;
    if (options.sourceImage) {
      memoryFile = await serveRestoreMemoryFile(options.sourceImage, options.signal);
      source = memoryFile.url;
      // Empty proxy settings trigger httpfs's native getenv fallback. Pin its proxy transport
      // to this same closed loopback endpoint, which accepts only its exact capability URL.
      await connection.run(`SET http_proxy=${literal(new URL(source).origin)}`);
    }
    if (!source) throw new Error("The analytics restore source is unavailable");
    const sourceKey = options.sourceKey
      ? `, ENCRYPTION_KEY ${literal(options.sourceKey.toString("hex"))}`
      : "";
    // HTTP attachment must happen before disabling external access. It reads only the exact owned
    // capability URL's catalog, with autoload/install disabled; foreign row expressions run nowhere.
    await connection.run(`ATTACH ${literal(source)} AS backup (READ_ONLY${sourceKey})`);
    await connection.run(
      `ATTACH ${literal(options.destinationPath)} AS restored (ENCRYPTION_KEY ${literal(options.destinationKey.toString("hex"))})`,
    );
    const destination = await lstat(options.destinationPath, { bigint: true });
    if (!destination.isFile() || destination.isSymbolicLink())
      throw new Error("Invalid analytics restore destination");
    output = { dev: destination.dev, ino: destination.ino };
    await chmod(options.destinationPath, 0o600);
    await connection.run(
      `SET allowed_paths=[${[source, options.destinationPath, options.destinationPath + ".wal"].map(literal).join(",")}]`,
    );
    await connection.run("SET enable_external_access=false");
    await connection.run("SET lock_configuration=true");
    const forbidden = await connection.runAndReadAll(`
      SELECT count(*) FROM (
        SELECT 1 FROM duckdb_views() WHERE database_name='backup' AND NOT internal
        UNION ALL SELECT 1 FROM duckdb_functions() WHERE database_name='backup'
        UNION ALL SELECT 1 FROM duckdb_types() WHERE database_name='backup' AND NOT internal
      )`);
    if (count(forbidden.getRows()[0]?.[0]) !== 0)
      throw new Error("The analytics backup contains unreviewed executable objects");
    const tables = z
      .array(tableSchema)
      .max(4096)
      .parse(
        (
          await connection.runAndReadAll(
            "SELECT schema_name,table_name,sql FROM duckdb_tables() WHERE database_name='backup' AND NOT internal ORDER BY schema_name,table_name",
          )
        ).getRowObjects(),
      );
    for (const table of tables) {
      if (
        !["main", "_omnesis_internal"].includes(table.schema_name) ||
        /\bGENERATED\s+ALWAYS\s+AS\s*\(/i.test(table.sql)
      )
        throw new Error("The analytics backup table needs reviewed schema handling");
    }
    await validateTemporalFamily(connection, tables);
    let rowsPreserved = 0,
      pendingWorkDiscarded = 0;
    // Only compiled product DDL creates these constrained internal tables.
    // Missing siblings can be a first boot interrupted between CREATEs.
    await connection.run("USE restored");
    await ensureAnalyticsTemporalProjectionSchema(connection);
    const schemaNames = new Set<string>();
    for (const table of tables) {
      options.signal.throwIfAborted();
      if (!schemaNames.has(table.schema_name)) {
        await connection.run(
          `CREATE SCHEMA IF NOT EXISTS restored.${identifier(table.schema_name)}`,
        );
        schemaNames.add(table.schema_name);
      }
      const condition = `database_name='backup' AND schema_name=${literal(table.schema_name)} AND table_name=${literal(table.table_name)}`;
      const columns = z
        .array(columnSchema)
        .min(1)
        .max(4096)
        .parse(
          (
            await connection.runAndReadAll(
              `SELECT column_name,data_type,is_nullable,column_default FROM duckdb_columns() WHERE ${condition} ORDER BY column_index`,
            )
          ).getRowObjects(),
        );
      const constraints = z
        .array(constraintSchema)
        .max(4096)
        .parse(
          (
            await connection.runAndReadAll(
              `SELECT constraint_type,to_json(constraint_column_names)::VARCHAR AS columns,constraint_text FROM duckdb_constraints() WHERE ${condition}`,
            )
          ).getRowObjects(),
        );
      const destinationTable = `restored.${identifier(table.schema_name)}.${identifier(table.table_name)}`;
      const trustedTemporal = table.schema_name === "main" && temporalTables.has(table.table_name);
      if (trustedTemporal) {
        await validateTemporalSchema(connection, table.table_name, columns, constraints);
      } else {
        const definitions = columns.map((column) => {
          const type = normalizeAnalyticsColumnType(column.data_type, "Restored analytics");
          return `${identifier(column.column_name)} ${type}${column.is_nullable ? "" : " NOT NULL"}${defaultValue(column.column_default, type)}`;
        });
        for (const constraint of constraints) {
          if (constraint.constraint_type === "NOT NULL") continue;
          if (!["PRIMARY KEY", "UNIQUE"].includes(constraint.constraint_type))
            throw new Error("The analytics backup contains an unreviewed constraint");
          const names = z
            .array(name)
            .min(1)
            .max(columns.length)
            .parse(JSON.parse(constraint.columns));
          if (names.some((value) => !columns.some((column) => column.column_name === value)))
            throw new Error("Invalid analytics constraint");
          definitions.push(`${constraint.constraint_type} (${names.map(identifier).join(",")})`);
        }
        await connection.run(`CREATE TABLE ${destinationTable} (${definitions.join(",")})`);
      }
      const sourceTable = `backup.${identifier(table.schema_name)}.${identifier(table.table_name)}`;
      const names = columns.map(({ column_name }) => identifier(column_name)).join(",");
      const pending =
        table.schema_name === "_omnesis_internal" && table.table_name === "watch_analytics_outbox";
      const filter = pending ? " WHERE consumed_at IS NOT NULL" : "";
      const expected = count(
        (
          await connection.runAndReadAll(`SELECT count(*) FROM ${sourceTable}${filter}`)
        ).getRows()[0]?.[0],
      );
      await connection.run(
        `INSERT INTO ${destinationTable} (${names}) SELECT ${names} FROM ${sourceTable}${filter}`,
      );
      const actual = count(
        (
          await connection.runAndReadAll(`SELECT count(*) FROM ${destinationTable}`)
        ).getRows()[0]?.[0],
      );
      if (actual !== expected) throw new Error("The restored analytics row count changed");
      rowsPreserved += actual;
      if (pending)
        pendingWorkDiscarded += count(
          (
            await connection.runAndReadAll(
              `SELECT count(*) FROM ${sourceTable} WHERE consumed_at IS NULL`,
            )
          ).getRows()[0]?.[0],
        );
      if (!Number.isSafeInteger(rowsPreserved) || !Number.isSafeInteger(pendingWorkDiscarded))
        throw new Error("Invalid restored analytics row count");
    }
    const sequences = (
      await connection.runAndReadAll(
        "SELECT schema_name,sequence_name,last_value,start_value,increment_by,cycle FROM duckdb_sequences() WHERE database_name='backup'",
      )
    ).getRowObjects();
    for (const sequence of sequences) {
      if (
        sequence.schema_name !== "_omnesis_internal" ||
        sequence.sequence_name !== "watch_analytics_outbox_seq" ||
        sequence.increment_by !== 1n ||
        sequence.cycle !== false
      )
        throw new Error("The analytics backup contains an unreviewed sequence");
      const last = sequence.last_value ?? sequence.start_value;
      if (typeof last !== "bigint" || last < 0n || last >= 0x7fff_ffff_ffff_ffffn)
        throw new Error("Invalid analytics sequence");
      await connection.run(`CREATE SCHEMA IF NOT EXISTS restored._omnesis_internal`);
      await connection.run(
        `CREATE SEQUENCE restored._omnesis_internal.watch_analytics_outbox_seq START ${last + 1n}`,
      );
    }
    options.signal.throwIfAborted();
    await connection.run("CHECKPOINT restored");
    connection.closeSync();
    connection = undefined;
    instance.closeSync();
    instance = undefined;
    fsyncFileSync(options.destinationPath);
    const handle = await open(options.destinationPath, "r");
    const header = Buffer.alloc(28);
    try {
      const read = await handle.read(header, 0, header.length, 0);
      if (read.bytesRead !== header.length)
        throw new Error("The restored analytics header is incomplete");
    } finally {
      await handle.close();
    }
    if (
      header.subarray(8, 12).toString("ascii") !== "DUCK" ||
      (header.readBigUInt64LE(20) & 1n) !== 1n
    )
      throw new Error("The restored analytics database was not encrypted");
    completed = true;
    result = { rowsPreserved, pendingWorkDiscarded, watchesPaused: 0 };
  } catch (error) {
    failed = true;
    operationFailure = error;
  }
  {
    options.signal.removeEventListener("abort", interrupt);
    const cleanupErrors: unknown[] = [];
    try {
      connection?.closeSync();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      instance?.closeSync();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await memoryFile?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (output && !completed) {
      try {
        const actual = await lstat(options.destinationPath, { bigint: true });
        if (actual.isFile() && actual.dev === output.dev && actual.ino === output.ino) {
          await unlink(options.destinationPath);
          await unlink(options.destinationPath + ".wal").catch(() => {});
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failed ? [operationFailure, ...cleanupErrors] : cleanupErrors,
        "The owned analytics restore cleanup did not finish",
      );
  }
  if (failed) throw operationFailure;
  if (!result) throw new Error("The owned analytics restore did not finish");
  return result;
}
async function validateTemporalFamily(
  connection: DuckDBConnection,
  tables: z.infer<typeof tableSchema>[],
): Promise<void> {
  const present = new Set(
    tables
      .filter((table) => table.schema_name === "main" && temporalTables.has(table.table_name))
      .map((table) => table.table_name),
  );
  // Projections and coverage shipped together; the move ledger came later.
  if (
    present.size === 0 ||
    present.size === temporalTables.size ||
    (present.has(TEMPORAL_PROJECTIONS_TABLE) && present.has(TEMPORAL_PROJECTION_SOURCES_TABLE))
  )
    return;
  // An interrupted first boot may have made only empty tables. Nonempty
  // unsupported partial layouts must not acquire invented coverage/history.
  for (const table of present) {
    const populated = count(
      (
        await connection.runAndReadAll(
          `SELECT count(*) FROM (SELECT 1 FROM backup.main.${identifier(table)} LIMIT 1)`,
        )
      ).getRows()[0]?.[0],
    );
    if (populated !== 0)
      throw new Error("The analytics temporal history is missing a required companion table");
  }
}
async function validateTemporalSchema(
  connection: DuckDBConnection,
  table: string,
  columns: z.infer<typeof columnSchema>[],
  constraints: z.infer<typeof constraintSchema>[],
): Promise<void> {
  const condition = `database_name='restored' AND schema_name='main' AND table_name=${literal(table)}`;
  const expectedColumns = z
    .array(columnSchema)
    .min(1)
    .max(4096)
    .parse(
      (
        await connection.runAndReadAll(
          `SELECT column_name,data_type,is_nullable,column_default FROM duckdb_columns() WHERE ${condition} ORDER BY column_index`,
        )
      ).getRowObjects(),
    );
  const describeColumns = (rows: z.infer<typeof columnSchema>[]) =>
    rows
      .map((column) =>
        JSON.stringify([
          column.column_name,
          normalizeAnalyticsColumnType(column.data_type, "Restored analytics"),
          column.is_nullable,
          column.column_default,
        ]),
      )
      .sort();
  if (JSON.stringify(describeColumns(columns)) !== JSON.stringify(describeColumns(expectedColumns)))
    throw new Error("The analytics temporal history needs a reviewed schema migration");
  const expectedConstraints = z
    .array(constraintSchema)
    .max(4096)
    .parse(
      (
        await connection.runAndReadAll(
          `SELECT constraint_type,to_json(constraint_column_names)::VARCHAR AS columns,constraint_text FROM duckdb_constraints() WHERE ${condition}`,
        )
      ).getRowObjects(),
    );
  const descriptor = (constraint: z.infer<typeof constraintSchema>) =>
    JSON.stringify([constraint.constraint_type, constraint.columns, constraint.constraint_text]);
  const remaining = new Map<string, number>();
  for (const constraint of expectedConstraints) {
    const key = descriptor(constraint);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const constraint of constraints) {
    const key = descriptor(constraint);
    const count = remaining.get(key) ?? 0;
    if (count === 0)
      throw new Error("The analytics temporal history contains an unreviewed constraint");
    remaining.set(key, count - 1);
  }
  // Older live tables predate the three vocabulary CHECKs. Their rows still
  // pass through today's compiled checks on INSERT; no foreign CHECK is run.
  for (const constraint of expectedConstraints) {
    if (constraint.constraint_type !== "CHECK" && remaining.get(descriptor(constraint)) !== 0)
      throw new Error("The analytics temporal history needs a reviewed schema migration");
  }
}
function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function count(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid analytics row count");
  return result;
}
function defaultValue(value: string | null, type: string): string {
  if (value === null) return "";
  const scalar = /^(?:NULL|true|false|-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/i;
  if (scalar.test(value)) return ` DEFAULT ${value}`;
  if (
    ["TIMESTAMP", "TIMESTAMPTZ"].includes(type) &&
    /^(?:current_timestamp|get_current_timestamp\(\))$/i.test(value)
  )
    return " DEFAULT current_timestamp";
  const cast = /^CAST\((NULL|true|false|-?\d+(?:\.\d+)?|'(?:[^']|'')*') AS ([A-Z ]+)\)$/i.exec(
    value,
  );
  if (cast && normalizeAnalyticsColumnType(cast[2], "Restored default") === type)
    return ` DEFAULT CAST(${cast[1]} AS ${type})`;
  throw new Error("The analytics backup contains an unreviewed default expression");
}
