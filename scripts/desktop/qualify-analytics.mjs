// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stagePinnedDuckDbExtensions } from "./pinned-extensions.mjs";

const program = String.raw`
const { createRequire } = require('node:module');
const { join } = require('node:path');
const requireFrom = createRequire(join(process.argv[1], 'package.json'));
const { DuckDBInstance } = requireFrom('@duckdb/node-api');
(async () => {
  let input = '';
  for await (const block of process.stdin) {
    input += block;
    if (input.length > 16384) throw new Error('invalid fixture input');
  }
  const { database, key, extension, step } = JSON.parse(input);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const instance = await DuckDBInstance.create(':memory:', {
    autoload_known_extensions: 'false', autoinstall_known_extensions: 'false',
  });
  const conn = await instance.connect();
  try {
    if (extension) await conn.run('LOAD ' + quote(extension));
    else {
      const crypto = await conn.runAndReadAll("SELECT installed,install_mode,install_path FROM duckdb_extensions() WHERE extension_name='httpfs'");
      const row = crypto.getRowObjects()[0];
      if (row?.installed !== true || row.install_mode !== 'STATICALLY_LINKED' || row.install_path !== '(BUILT-IN)')
        throw new Error('missing built-in module');
      await conn.run('LOAD httpfs');
    }
    await conn.run('ATTACH ' + quote(database) + ' AS qualified (ENCRYPTION_KEY ' + quote(key) + ')');
    if (step === 1) await conn.run('CREATE TABLE qualified.proof (value INTEGER CHECK(value=42)); INSERT INTO qualified.proof VALUES (42)');
    const rows = (await conn.runAndReadAll('SELECT value FROM qualified.proof')).getRowObjects();
    if (rows.length !== step || rows.some(row => row.value !== 42)) throw new Error('encrypted fixture differs');
    if (step < 3) await conn.run('INSERT INTO qualified.proof VALUES (42)');
    await conn.run('DETACH qualified');
    process.stdout.write('qualified\n');
  } finally { conn.closeSync(); instance.closeSync(); }
})().catch(() => { process.stderr.write('Analytics compatibility qualification failed\n'); process.exitCode=1; });
`;

/** Three real processes cross the upstream/custom encryption boundary in both directions. */
export function qualifyDesktopAnalytics(
  { input, target, node, architecture, scratch, env },
  { run = spawnSync, stageExtensions = stagePinnedDuckDbExtensions } = {},
) {
  const home = join(scratch, "analytics-qualification");
  mkdirSync(home, { mode: 0o700 });
  stageExtensions({ input, target: home, node, architecture, env });
  const manifest = JSON.parse(
    readFileSync(join(home, "packages/gateway/duckdb-extensions/manifest.json"), "utf8"),
  );
  const platform = architecture === "arm64" ? "osx_arm64" : "osx_amd64";
  const extension = join(
    home,
    "packages/gateway/duckdb-extensions",
    manifest.duckdbVersion,
    platform,
    "httpfs.duckdb_extension",
  );
  const key = randomBytes(32).toString("hex");
  for (const [index, root] of [input, target, input].entries()) {
    const result = run(node, ["--eval", program, root], {
      cwd: home,
      env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", LANG: "C" },
      input: JSON.stringify({
        database: join(home, "proof.duckdb"),
        key,
        step: index + 1,
        extension: index === 1 ? undefined : extension,
      }),
      encoding: "utf8",
      maxBuffer: 16384,
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0 || result.stdout !== "qualified\n")
      throw new Error(
        "The packaged analytics engine failed upstream encrypted-file interoperability",
      );
  }
}
