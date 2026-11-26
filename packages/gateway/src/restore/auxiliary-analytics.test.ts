// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, expect, test, vi } from "vitest";
import { BUNDLED_DUCKDB_EXTENSION_DIRECTORY } from "../analytics/connection-pool.js";
import { AnalyticsDb } from "../analytics-db.js";
import { rebuildRestoredAnalyticsDatabase } from "./auxiliary-analytics.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function engine() {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    temp_directory: "",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
  });
  const connection = await instance.connect();
  const [version, platform] = (
    await connection.runAndReadAll("SELECT version(), (SELECT platform FROM pragma_platform())")
  ).getRows()[0]!;
  const extension = join(
    BUNDLED_DUCKDB_EXTENSION_DIRECTORY,
    String(version),
    String(platform),
    "httpfs.duckdb_extension",
  );
  await connection.run(`LOAD '${extension.replace(/'/g, "''")}'`);
  return { instance, connection };
}
async function fixture(encrypted = true, executable?: "view" | "macro" | "generated" | "check") {
  const home = await mkdtemp(join(tmpdir(), "omnesis-rebuilt-analytics-"));
  homes.push(home);
  const sourcePath = join(home, "source.db"),
    destinationPath = join(home, "restored.db");
  const sourceKey = Buffer.alloc(32, 7),
    destinationKey = Buffer.alloc(32, 8);
  const { instance, connection } = await engine();
  try {
    await connection.run(
      `ATTACH '${sourcePath}' AS invented${encrypted ? ` (ENCRYPTION_KEY '${sourceKey.toString("hex")}')` : ""}`,
    );
    await connection.run(
      "CREATE TABLE invented.main.records (id BIGINT PRIMARY KEY, content VARCHAR NOT NULL, enabled BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT current_timestamp)",
    );
    await connection.run(
      "INSERT INTO invented.main.records(id,content) VALUES(1,'invented private analytics marker'),(2,'invented second row')",
    );
    await connection.run("CREATE SCHEMA invented._omnesis_internal");
    await connection.run(
      "CREATE SEQUENCE invented._omnesis_internal.watch_analytics_outbox_seq START 20",
    );
    await connection.run(
      "CREATE TABLE invented._omnesis_internal.watch_analytics_outbox(page_seq BIGINT PRIMARY KEY, records_json VARCHAR, consumed_at TIMESTAMPTZ)",
    );
    await connection.run(
      "INSERT INTO invented._omnesis_internal.watch_analytics_outbox VALUES(1,'invented completed history',current_timestamp),(2,'invented pending delivery',NULL)",
    );
    if (executable === "view")
      await connection.run(
        "CREATE VIEW invented.main.foreign_program AS SELECT 'invented forbidden program' AS value",
      );
    if (executable === "macro")
      await connection.run(
        "CREATE MACRO invented.main.foreign_program() AS 'invented forbidden program'",
      );
    if (executable === "generated")
      await connection.run(
        "CREATE TABLE invented.main.foreign_program(id BIGINT, value BIGINT GENERATED ALWAYS AS (id+1))",
      );
    if (executable === "check")
      await connection.run("CREATE TABLE invented.main.foreign_program(id BIGINT CHECK(id > 0))");
    await connection.run("CHECKPOINT invented");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  await chmod(sourcePath, 0o600);
  return {
    home,
    sourcePath,
    sourceKey,
    destinationPath,
    destinationKey,
    signal: new AbortController().signal,
  };
}
async function inspect(path: string, key: Buffer) {
  const { instance, connection } = await engine();
  try {
    await connection.run(
      `ATTACH '${path}' AS result (READ_ONLY,ENCRYPTION_KEY '${key.toString("hex")}')`,
    );
    return {
      rows: (
        await connection.runAndReadAll(
          "SELECT id,content,enabled FROM result.main.records ORDER BY id",
        )
      ).getRows(),
      outbox: (
        await connection.runAndReadAll(
          "SELECT count(*) FROM result._omnesis_internal.watch_analytics_outbox",
        )
      ).getRows()[0]![0],
      constraints: (
        await connection.runAndReadAll(
          "SELECT count(*) FROM duckdb_constraints() WHERE database_name='result' AND table_name IN ('records','watch_analytics_outbox') AND constraint_type='PRIMARY KEY'",
        )
      ).getRows()[0]![0],
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
test("encrypted analytics rebuild keeps base rows and constraints under the current key, discarding pending delivery work", async () => {
  const f = await fixture();
  const result = await rebuildRestoredAnalyticsDatabase(f);
  expect(result).toEqual({ rowsPreserved: 3, watchesPaused: 0, pendingWorkDiscarded: 1 });
  expect(await inspect(f.destinationPath, f.destinationKey)).toEqual({
    rows: [
      [1n, "invented private analytics marker", false],
      [2n, "invented second row", false],
    ],
    outbox: 1n,
    constraints: 2n,
  });
  expect(
    (await readFile(f.destinationPath)).includes(Buffer.from("invented private analytics marker")),
  ).toBe(false);
});
test("legacy plaintext analytics is consumed through bounded memory ranges and only encrypted output persists", async () => {
  vi.stubEnv("http_proxy", "http://127.0.0.1:9");
  vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
  const f = await fixture(false),
    sourceImage = await readFile(f.sourcePath);
  await rm(f.sourcePath);
  try {
    await rebuildRestoredAnalyticsDatabase({
      sourceImage,
      destinationPath: f.destinationPath,
      destinationKey: f.destinationKey,
      signal: f.signal,
    });
    expect((await inspect(f.destinationPath, f.destinationKey)).rows).toHaveLength(2);
    expect(await readdir(f.home)).toEqual(["restored.db"]);
    expect(
      (await readFile(f.destinationPath)).includes(
        Buffer.from("invented private analytics marker"),
      ),
    ).toBe(false);
  } finally {
    sourceImage.fill(0);
  }
});
test("foreign views, macros and generated expressions are refused and never published", async () => {
  for (const kind of ["view", "macro", "generated", "check"] as const) {
    const f = await fixture(true, kind);
    await expect(rebuildRestoredAnalyticsDatabase(f)).rejects.toThrow(/unreviewed|reviewed/);
    await expect(stat(f.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

const historicalSchema: AnalyticsTableSchema = {
  tableName: "fixture_calendar_events",
  displayName: "Fictional events",
  description: "Invented historical events for restore tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Id" },
    { name: "source_account", type: "VARCHAR", description: "Account" },
    { name: "title", type: "VARCHAR", description: "Title" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "End" },
  ],
  primaryKey: ["id"],
  sharedDiscriminatorColumn: "source_account",
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["title"], keyColumns: ["start_time", "end_time"] },
  boundDocument: { externalIdColumns: ["id"] },
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    kind: "appointment",
    modality: "scheduled",
    status: "active",
  },
};
const historyWindow = {
  fromMs: Date.parse("2026-01-01T00:00:00Z"),
  toMs: Date.parse("2026-01-10T00:00:00Z"),
};
function productionStore(path: string, key: Buffer): AnalyticsDb {
  return new AnalyticsDb(path, {
    encryptionKeyHex: key.toString("hex"),
    maxPoolSize: 1,
    memoryLimitMiB: 128,
    threads: 1,
  });
}
async function historicalState(db: AnalyticsDb) {
  return {
    rows: (
      await db.executeQuery(
        "SELECT id,source_account,title,start_time,end_time FROM fixture_calendar_events ORDER BY id",
      )
    ).rows,
    projections: await db.queryTemporalProjections(historyWindow),
    coverage: await db.getTemporalProjectionCoverage(),
    moves: await db.nextTemporalProjectionMoves(),
  };
}
async function productionFixture({
  empty = false,
  rekey = true,
}: {
  empty?: boolean;
  rekey?: boolean;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "omnesis-production-analytics-restore-"));
  homes.push(home);
  const sourcePath = join(home, "source.db"),
    destinationPath = join(home, "restored.db");
  const sourceKey = Buffer.alloc(32, 7),
    destinationKey = Buffer.alloc(32, 8);
  const db = productionStore(sourcePath, sourceKey);
  let expected: Awaited<ReturnType<typeof historicalState>> | undefined;
  try {
    await db.open();
    if (!empty) {
      await db.ingestPage({
        tableName: historicalSchema.tableName,
        schema: historicalSchema,
        sourceId: "schedule:alpha@example.com",
        records: [2, 3].map((day) => ({
          id: `fixture:event-${day}`,
          source_account: "alpha@example.com",
          title: `Fictional historical appointment ${day}`,
          start_time: `2026-01-0${day}T09:00:00Z`,
          end_time: `2026-01-0${day}T10:00:00Z`,
        })),
      });
      if (rekey)
        await db.ensureTable(
          {
            ...historicalSchema,
            primaryKey: ["source_account", "id"],
            deleteKey: ["id"],
            boundDocument: { externalIdColumns: ["id"], sourceKeyColumns: ["source_account"] },
          },
          "schedule:beta@example.com",
        );
      expected = await historicalState(db);
      expect(expected.projections).toHaveLength(2);
      expect(expected.coverage).not.toEqual([]);
      if (rekey) expect(expected.moves?.moves).toHaveLength(2);
      else expect(expected.moves).toBeNull();
    }
  } finally {
    await db.close();
  }
  await chmod(sourcePath, 0o600);
  return {
    home,
    sourcePath,
    sourceKey,
    destinationPath,
    destinationKey,
    signal: new AbortController().signal,
    expected,
  };
}
async function alterProductionSource(
  f: Awaited<ReturnType<typeof productionFixture>>,
  kind:
    | "legacy"
    | "foreign-check"
    | "foreign-default"
    | "invalid-vocabulary"
    | "partial-empty"
    | "legacy-no-moves"
    | "missing-coverage"
    | "missing-projections",
) {
  const { instance, connection } = await engine();
  try {
    await connection.run(
      `ATTACH '${f.sourcePath}' AS invented (ENCRYPTION_KEY '${f.sourceKey.toString("hex")}')`,
    );
    if (kind === "legacy-no-moves") {
      await connection.run("DROP TABLE invented.main._temporal_projection_moves");
    } else if (kind === "missing-coverage") {
      await connection.run("DROP TABLE invented.main._temporal_projection_sources");
    } else if (kind === "missing-projections") {
      await connection.run("DROP TABLE invented.main._temporal_projections");
    } else if (kind === "foreign-default") {
      await connection.run(
        "ALTER TABLE invented.main._temporal_projections ALTER COLUMN label SET DEFAULT 'fictional injected default'",
      );
    } else if (kind === "partial-empty") {
      await connection.run("DROP TABLE invented.main._temporal_projection_sources");
      await connection.run("DROP TABLE invented.main._temporal_projection_moves");
    } else {
      const columns = (
        await connection.runAndReadAll(
          "SELECT column_name,data_type,is_nullable FROM duckdb_columns() WHERE database_name='invented' AND table_name='_temporal_projections' ORDER BY column_index",
        )
      ).getRowObjects();
      const definitions = columns.map((column) => {
        expect(column.column_name).toMatch(/^[a-z_]+$/);
        return `${column.column_name} ${column.data_type}${column.column_name === "id" ? " PRIMARY KEY" : column.is_nullable ? "" : " NOT NULL"}`;
      });
      if (kind === "foreign-check") definitions.push("CHECK(length(label)>0)");
      await connection.run(
        "CREATE TABLE invented.main.fixture_saved AS SELECT * FROM invented.main._temporal_projections",
      );
      await connection.run("DROP TABLE invented.main._temporal_projections");
      await connection.run(
        `CREATE TABLE invented.main._temporal_projections(${definitions.join(",")})`,
      );
      await connection.run(
        "INSERT INTO invented.main._temporal_projections SELECT * FROM invented.main.fixture_saved",
      );
      await connection.run("DROP TABLE invented.main.fixture_saved");
      if (kind === "invalid-vocabulary")
        await connection.run(
          "UPDATE invented.main._temporal_projections SET kind='fixture-unrecognized-kind'",
        );
    }
    await connection.run("CHECKPOINT invented");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

test.each(["current", "legacy"] as const)(
  "real encrypted %s production analytics preserves historical projections, coverage and pending moves without provider reread",
  async (profile) => {
    const f = await productionFixture();
    if (profile === "legacy") await alterProductionSource(f, "legacy");
    const before = await readFile(f.sourcePath);
    await rebuildRestoredAnalyticsDatabase(f);
    expect(await readFile(f.sourcePath)).toEqual(before);
    const restored = productionStore(f.destinationPath, f.destinationKey);
    try {
      await restored.open();
      // No ingest or descriptor registration runs after restore: these are the
      // original historical results and unfinished cross-store identity repairs.
      expect(await historicalState(restored)).toEqual(f.expected);
    } finally {
      await restored.close();
    }
    expect(
      (await readFile(f.destinationPath)).includes(Buffer.from("Fictional historical appointment")),
    ).toBe(false);
  },
);
test("an interrupted empty production temporal family is completed from trusted compiled schema", async () => {
  const f = await productionFixture({ empty: true });
  await alterProductionSource(f, "partial-empty");
  await rebuildRestoredAnalyticsDatabase(f);
  const restored = productionStore(f.destinationPath, f.destinationKey);
  try {
    await restored.open();
    expect(await restored.queryTemporalProjections(historyWindow)).toEqual([]);
    expect(await restored.getTemporalProjectionCoverage()).toEqual([]);
    expect(await restored.nextTemporalProjectionMoves()).toBeNull();
  } finally {
    await restored.close();
  }
});
test("legitimate legacy projections and coverage survive without a move ledger that never held work", async () => {
  const f = await productionFixture({ rekey: false });
  expect(f.expected?.moves).toBeNull();
  await alterProductionSource(f, "legacy");
  await alterProductionSource(f, "legacy-no-moves");
  const before = await readFile(f.sourcePath);
  await rebuildRestoredAnalyticsDatabase(f);
  expect(await readFile(f.sourcePath)).toEqual(before);
  const restored = productionStore(f.destinationPath, f.destinationKey);
  try {
    await restored.open();
    expect(await historicalState(restored)).toEqual(f.expected);
  } finally {
    await restored.close();
  }
});
test.each(["missing-coverage", "missing-projections"] as const)(
  "nonempty temporal history with %s refuses instead of inventing its missing companion",
  async (kind) => {
    const f = await productionFixture();
    await alterProductionSource(f, kind);
    const before = await readFile(f.sourcePath);
    await expect(rebuildRestoredAnalyticsDatabase(f)).rejects.toThrow(
      "missing a required companion table",
    );
    expect(await readFile(f.sourcePath)).toEqual(before);
    await expect(stat(f.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test.each(["foreign-check", "foreign-default", "invalid-vocabulary"] as const)(
  "same-name temporal %s refuses instead of importing executable schema or silently dropping history",
  async (kind) => {
    const f = await productionFixture();
    await alterProductionSource(f, kind);
    const before = await readFile(f.sourcePath);
    await expect(rebuildRestoredAnalyticsDatabase(f)).rejects.toThrow(/constraint|schema/i);
    expect(await readFile(f.sourcePath)).toEqual(before);
    await expect(stat(f.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
