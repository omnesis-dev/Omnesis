#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArguments } from "./arguments.mjs";
import { inventoryBundle } from "./native-inventory.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";

const execute = promisify(execFile);

/** Closed qualification environment: never grant production telemetry authority. */
export function smokeRuntimeEnvironment(runtime, home) {
  return {
    PATH: join(runtime, "bin") + ":/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    OMNESIS_RUNTIME_MODE: "test",
    OMNESIS_TELEMETRY: "0",
    OMNESIS_E2E_DESKTOP_RUNTIME_SMOKE: "1",
    OMNESIS_CONFIG_DIR: join(home, "unrelated-headless"),
    OMNESIS_SECRET_SERVICE: "dev.omnesis.unrelated-fixture",
    OMNESIS_GATEWAY_URL: "https://unreachable.example.test",
    OMNESIS_TOKEN: "omn_test",
  };
}

/** Exercise the actual compiled closure with no host Node/npm or personal state. */
async function smokeRuntime(sourceRuntime) {
  const manifestBytes = await readFile(join(sourceRuntime, "desktop-runtime.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.codeUsageProtocol !== 1 ||
    manifest.dataUsageProtocol !== 1 ||
    manifest.processAuthorityProtocol !== 3 ||
    manifest.runtimeLauncher !== "runtime-exec"
  )
    throw new Error("Bundled runtime lacks its code and data lifetime protocols");
  if (manifest.architecture !== process.arch)
    throw new Error("Run the bundle on its target architecture");
  const inventory = (await inventoryBundle(sourceRuntime, manifest.architecture)).filter(
    (entry) => entry.path !== "desktop-runtime.json",
  );
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.inventory))
    throw new Error("Runtime differs from its sealed build inventory");
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-desktop-bundle-smoke-")));
  const cache = join(home, "runtime-cache");

  const runtime = join(cache, createHash("sha256").update(manifestBytes).digest("hex"));

  const env = smokeRuntimeEnvironment(runtime, home);
  const node = join(runtime, "runtime-exec");
  const script = join(runtime, "packages/cli/dist/index.js");
  try {
    await mkdir(cache, { mode: 0o700 });
    await cp(sourceRuntime, runtime, { recursive: true, verbatimSymlinks: true });
    await chmod(runtime, 0o700);
    const version = await execute(node, ["--node", script, "--version"], {
      cwd: runtime,
      env,
      timeout: 30_000,
    });
    if (!version.stdout.includes(manifest.productVersion))
      throw new Error("Compiled CLI version mismatch");
    // The database probe is a real data consumer, distinct from the unconfigured
    // welcome bridge below. Give it an owned fixture installation and native SH.
    const configDir = join(home, "database-fixture");
    await mkdir(configDir, { mode: 0o700 });
    await mkdir(configDir + ".bootstrap", { mode: 0o700 });
    const identity = createHash("sha256").update(configDir).digest("hex");
    const scope = {
      format: 1,
      configDir,
      instance: "desktop-" + identity.slice(0, 16),
      secretService: "dev.omnesis.desktop." + identity,
    };
    await writeFile(
      join(configDir, "desktop-install.json"),
      JSON.stringify({
        version: 1,
        owner: "omnesis-desktop",
        instance: scope.instance,
        secretService: scope.secretService,
        phase: "configured",
      }),
      { flag: "wx", mode: 0o600 },
    );
    // Instantiate both SQLite builds and DuckDB, rather than merely dlopen their
    // modules. In-memory databases cannot contain or modify an existing library.
    await execute(
      node,
      [
        "--data-use",
        Buffer.from(JSON.stringify(scope)).toString("base64url"),
        "--node",
        "--input-type=module",
        "--eval",
        `
      import Database from 'better-sqlite3';
      import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';
      import { DuckDBInstance } from '@duckdb/node-api';
      import { join } from 'node:path';
      import { randomBytes } from 'node:crypto';
      for (const Driver of [Database, EncryptedDatabase]) {
        const db = new Driver(':memory:');
        if (db.prepare('SELECT 42 AS result').get().result !== 42) throw new Error('SQLite smoke failed');
        db.close();
      }
      const instance = await DuckDBInstance.create(':memory:', {
        autoload_known_extensions: 'false', autoinstall_known_extensions: 'false',
      });
      const connection = await instance.connect();
      const crypto = await connection.runAndReadAll("SELECT installed, install_mode, install_path FROM duckdb_extensions() WHERE extension_name='httpfs'");
      const row = crypto.getRowObjects()[0];
      if (row?.installed !== true || row.install_mode !== 'STATICALLY_LINKED' || row.install_path !== '(BUILT-IN)')
        throw new Error('Desktop analytics crypto is not linked into its signed library');
      await connection.run('LOAD httpfs');
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      const key = randomBytes(32).toString('hex');
      const database = join(process.env.HOME, 'encrypted-analytics.duckdb');
      await connection.run('ATTACH ' + quote(database) + ' AS protected (ENCRYPTION_KEY ' + quote(key) + ')');
      await connection.run('CREATE TABLE protected.smoke AS SELECT 42 AS result');
      await connection.run('DETACH protected');
      await connection.run('ATTACH ' + quote(database) + ' AS protected (READ_ONLY, ENCRYPTION_KEY ' + quote(key) + ')');
      const result = await connection.runAndReadAll('SELECT result FROM protected.smoke');
      if (result.getRowObjects()[0]?.result !== 42) throw new Error('Encrypted analytics smoke failed');
      await connection.run('DETACH protected');
      connection.closeSync();
      instance.closeSync();
    `,
      ],
      { cwd: join(runtime, "packages/gateway"), env, timeout: 30_000 },
    );
    await new Promise((resolveSmoke, rejectSmoke) => {
      const child = spawn(node, ["--node", script, "desktop", "bridge"], {
        cwd: runtime,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let failure;
      let termination;
      const stop = (message) => {
        if (failure) return;
        failure = new Error(message);
        child.kill("SIGTERM");
        termination = setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const timeout = setTimeout(() => stop("Bundled desktop bridge did not answer"), 30_000);
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 65_536) {
          stop("Unexpected desktop bridge output");
          return;
        }
        if (stdout.includes("\n")) child.stdin.end();
      });
      // Drain diagnostic output without putting credentials or local paths in CI logs.
      child.stderr.resume();
      child.on("error", (error) => {
        clearTimeout(timeout);
        clearTimeout(termination);
        rejectSmoke(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        clearTimeout(termination);
        if (failure) return rejectSmoke(failure);
        try {
          const reply = JSON.parse(stdout.trim());
          const answered =
            code === 0 &&
            reply.version === 1 &&
            reply.id === "bundle-status" &&
            reply.ok === true &&
            reply.result?.phase === "welcome";
          if (!answered) throw new Error("Bundled desktop bridge failed its first-run contract");
          resolveSmoke();
        } catch {
          rejectSmoke(new Error("Bundled desktop bridge failed its first-run contract"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.write(
        JSON.stringify({ version: 1, id: "bundle-status", command: "status" }) + "\n",
      );
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (isEntryScript(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), {
    values: ["runtime"],
    required: ["runtime"],
  });
  await smokeRuntime(resolve(args.get("runtime")));
}
