#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArguments } from "./arguments.mjs";
import { inventoryBundle } from "./native-inventory.mjs";

const execute = promisify(execFile);

/** Exercise the actual compiled closure with no host Node/npm or personal state. */
async function smokeRuntime(sourceRuntime) {
  const manifestBytes = await readFile(join(sourceRuntime, "desktop-runtime.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.codeUsageProtocol !== 1 || manifest.runtimeLauncher !== "runtime-exec")
    throw new Error("Bundled runtime lacks its code-lifetime protocol");
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

  const env = {
    PATH: join(runtime, "bin") + ":/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    OMNESIS_CONFIG_DIR: join(home, "unrelated-headless"),
    OMNESIS_SECRET_SERVICE: "dev.omnesis.unrelated-fixture",
    OMNESIS_GATEWAY_URL: "https://unreachable.example.test",
    OMNESIS_TOKEN: "omn_test",
  };
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
    // Instantiate both SQLite builds and DuckDB, rather than merely dlopen their
    // modules. In-memory databases cannot contain or modify an existing library.
    await execute(
      node,
      [
        "--node",
        "--input-type=module",
        "--eval",
        `
      import Database from 'better-sqlite3';
      import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';
      import { DuckDBInstance } from '@duckdb/node-api';
      for (const Driver of [Database, EncryptedDatabase]) {
        const db = new Driver(':memory:');
        if (db.prepare('SELECT 42 AS result').get().result !== 42) throw new Error('SQLite smoke failed');
        db.close();
      }
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      await connection.run('SELECT 42');
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

const args = parseArguments(process.argv.slice(2), { values: ["runtime"], required: ["runtime"] });
await smokeRuntime(resolve(args.get("runtime")));
