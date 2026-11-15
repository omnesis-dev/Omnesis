// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import PlainDatabase from "better-sqlite3";
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { spawnE2ESubprocess } from "../../packages/collector/src/e2e/e2e-owned-process.ts";
import {
  registerSubprocessGroup,
  killSubprocessGroup,
} from "../../packages/collector/src/e2e/subprocess-reaper.ts";

const require = createRequire(import.meta.url);
const results = [];
for (const writer of ["better-sqlite3", "better-sqlite3-multiple-ciphers"]) {
  for (const abrupt of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "omnesis-sqlite-restart-diagnostic-"));
    const database = join(root, "fixture.db");
    const ready = join(root, "ready");
    const driver = pathToFileURL(require.resolve(writer)).href;
    const shutdown = new URL("../../packages/core/src/parent-shutdown.ts", import.meta.url).href;
    const code = `import Database from ${JSON.stringify(driver)};import {writeFileSync} from 'node:fs';import {installParentShutdownHandler} from ${JSON.stringify(shutdown)};const db=new Database(${JSON.stringify(database)});db.pragma('journal_mode=WAL');db.exec('CREATE TABLE fixture(value INTEGER);INSERT INTO fixture VALUES(1)');installParentShutdownHandler(()=>{db.close();process.exit(0);});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},60000);`;
    const child = spawnE2ESubprocess(
      process.execPath,
      [
        "--import",
        pathToFileURL(require.resolve("tsx/esm")).href,
        "--input-type=module",
        "-e",
        code,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        detached: true,
      },
    );
    let joined = false;
    try {
      await registerSubprocessGroup(child);
      const deadline = Date.now() + 60_000;
      while (!existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (!existsSync(ready)) throw Error("Diagnostic writer did not become ready");
      await killSubprocessGroup(child, { initialSignal: abrupt ? "SIGKILL" : "SIGTERM" });
      joined = true;
      for (const [reader, Database] of [
        ["plain", PlainDatabase],
        ["cipher", CipherDatabase],
      ]) {
        let db;
        try {
          db = new Database(database, { fileMustExist: true });
          const version = db.prepare("SELECT sqlite_version() AS version").get();
          const before = db.prepare("SELECT * FROM fixture").all();
          db.transaction(() => db.prepare("INSERT INTO fixture VALUES(2)").run()).immediate();
          results.push({ writer, abrupt, reader, version, before, ok: true });
        } catch (error) {
          results.push({
            writer,
            abrupt,
            reader,
            ok: false,
            code: error.code,
            error: error.message,
          });
        } finally {
          db?.close();
        }
      }
    } finally {
      if (!joined) await killSubprocessGroup(child);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ sqliteRestartDiagnostics: results }));
