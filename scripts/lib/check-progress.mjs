// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCLI } from "vitest/node";

/** Append a side-channel reporter without replacing a requested aggregate report. */
export function progressArgs(args) {
  const { options } = parseCLI(["vitest", "run", ...args]);
  // An explicit config owns its reporter policy unless CLI reporters override it.
  if (options.config && !options.reporter) return args;
  const extra = [
    ...(options.reporter ? [] : ["--reporter=default"]),
    `--reporter=${join(import.meta.dirname, "check-reporter.mjs")}`,
  ];
  const end = args.indexOf("--");
  return end < 0 ? [...args, ...extra] : [...args.slice(0, end), ...extra, ...args.slice(end)];
}

export function progressEnvironment(env) {
  const path =
    env.OMNESIS_CHECK_PROGRESS_FILE ??
    join(mkdtempSync(join(tmpdir(), "omnesis-check-progress-")), "progress.json");
  process.stderr.write(`[tests] Progress file: ${path}\n`);
  return { ...env, OMNESIS_CHECK_PROGRESS_FILE: path };
}
