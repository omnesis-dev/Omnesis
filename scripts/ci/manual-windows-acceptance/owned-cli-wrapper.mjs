// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
const manifest = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8"));
const args = JSON.parse(process.argv[3]);
if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
  throw new Error("Invalid owned CLI argv");
const require = createRequire(pathToFileURL(join(manifest.runtimeRoot, "package.json")));
const core = await import(pathToFileURL(require.resolve("@omnesis/core")).href);
const child = spawn(manifest.nodePath, [...(manifest.nodeArgs ?? []), manifest.cliEntry, ...args], {
  cwd: manifest.runtimeRoot,
  env: process.env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let shutdownRequested = false,
  ipcAccepted = false,
  failed = false;
const emit = (value) => process.stderr.write("AUDIT_OWNED_CLI:" + JSON.stringify(value) + "\n");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let control = Promise.resolve();
input.on("line", (line) => {
  control = control
    .then(async () => {
      const command = JSON.parse(line);
      if (command.type !== "shutdown" || command.version !== 1)
        throw new Error("Invalid private wrapper command");
      if (shutdownRequested) return;
      shutdownRequested = true;
      ipcAccepted = await core.requestChildShutdown(child);
      emit({ event: "shutdown-request", ipcAccepted });
      if (!ipcAccepted) {
        failed = true;
        process.exitCode = 1;
      }
    })
    .catch(() => {
      failed = true;
      process.exitCode = 1;
      emit({ event: "control-failed" });
    });
});
child.once("error", () => {
  failed = true;
  process.exitCode = 1;
  emit({ event: "spawn-failed" });
});
child.once("close", (code, signal) => {
  void control.then(() => {
    emit({ event: "closed", code, signal, shutdownRequested, ipcAccepted });
    process.exitCode = failed || code !== 0 ? 1 : 0;
    input.close();
    process.stdin.destroy();
  });
});
