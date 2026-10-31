// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Run inside a runtime image with no network (`docker run --network none`):
 * the image's own analytics pool creates an encrypted store, reopens it, and
 * encrypts a plaintext one, as a gateway does on its first starts. Encrypted
 * analytics needs DuckDB's httpfs extension; this passes only when the image
 * carries the pinned build, because there is nothing to download it from.
 *
 *   docker run --rm --network none --read-only --tmpfs /tmp:... \
 *     --mount type=bind,source=scripts/docker/offline-analytics-probe.mjs,target=/probe.mjs,readonly \
 *     --entrypoint node <image> /probe.mjs
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The image's compiled pool; a checkout can point this at its source under tsx.
const poolModule =
  process.env.OMNESIS_PROBE_POOL_MODULE ??
  "/app/packages/gateway/dist/analytics/connection-pool.js";
const { AnalyticsConnectionPool, BUNDLED_DUCKDB_EXTENSION_DIRECTORY } = await import(poolModule);

const shipped = readdirSync(BUNDLED_DUCKDB_EXTENSION_DIRECTORY).filter((name) =>
  name.startsWith("v"),
);
assert.equal(shipped.length, 1, `expected one shipped DuckDB version, found ${shipped}`);
const platforms = readdirSync(join(BUNDLED_DUCKDB_EXTENSION_DIRECTORY, shipped[0]));
assert.equal(platforms.length, 1, `expected this image's platform only, found ${platforms}`);

const directory = mkdtempSync(join(tmpdir(), "omnesis-offline-analytics-"));
const keyHex = randomBytes(32).toString("hex");
const limits = { memoryLimitMiB: 512, threads: 2 };

async function withPool(path, opts, use) {
  const pool = new AnalyticsConnectionPool(path, { ...limits, ...opts });
  await pool.open(use?.init);
  try {
    return await pool.withConn(async ({ conn }) =>
      use?.query ? (await conn.runAndReadAll(use.query)).getRows() : null,
    );
  } finally {
    await pool.close();
  }
}

const encrypted = join(directory, "analytics.db");
await withPool(
  encrypted,
  { encryptionKeyHex: keyHex },
  { init: (conn) => conn.run("CREATE TABLE probe AS SELECT 21 AS n") },
);
const reopened = await withPool(
  encrypted,
  { encryptionKeyHex: keyHex },
  { query: "SELECT n FROM probe" },
);
assert.deepEqual(reopened, [[21]]);

const plaintext = join(directory, "plaintext.db");
await withPool(plaintext, {}, { init: (conn) => conn.run("CREATE TABLE probe AS SELECT 22 AS n") });
const migrated = await withPool(
  plaintext,
  { encryptionKeyHex: keyHex },
  { query: "SELECT n FROM probe" },
);
assert.deepEqual(migrated, [[22]]);

for (const store of [encrypted, plaintext]) {
  assert.equal(
    existsSync(join(`${store}.extensions`, shipped[0])),
    false,
    `${store} installed an extension instead of loading the shipped build`,
  );
}
console.log(
  `Encrypted analytics opened, reopened and migrated with no network on the shipped ${shipped[0]} ${platforms[0]} httpfs build`,
);
