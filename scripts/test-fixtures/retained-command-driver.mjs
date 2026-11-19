// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Runs inside an outer job object on Windows. Report a finite shell command separately
// from the lifetime of the daemons it deliberately leaves for its test to use.
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
let completed = false;
let released = false;
const finish = () => {
  if (completed && released) process.exit(0);
};
process.stdin.on("end", () => {
  released = true;
  finish();
});
process.stdin.resume();
execFile(
  config.command,
  config.args,
  { cwd: config.cwd, timeout: config.timeout, maxBuffer: config.maxBuffer, encoding: "utf8" },
  (error, stdout, stderr) => {
    const stage = `${config.result}.tmp`;
    writeFileSync(stage, JSON.stringify({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
    renameSync(stage, config.result);
    completed = true;
    finish();
  },
);
