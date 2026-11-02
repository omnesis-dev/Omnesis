// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Records every `omnesis` process an installer run starts, for the release
 * skew lane (scripts/install-e2e/release-skew.sh).
 *
 *   NODE_OPTIONS=--require=<this file> OMNESIS_CLI_TRACE=<file.jsonl> sh install.sh …
 *
 * Preloaded into every Node process the installer starts. In the CLI's own
 * process (its entry is `packages/cli/src/index.ts`, or the published
 * `dist/index.js`) it appends one line when the process exits: the argv, the
 * exit code, and the first refusal the CLI printed — "Unknown option: …",
 * "Unknown command …" or "No command specified." — even when the installer
 * threw that output away (`2>/dev/null || true`). Every other process is left
 * alone.
 */

"use strict";

const traceFile = process.env.OMNESIS_CLI_TRACE;
const entry = process.argv[1] || "";
const isCli = /[/\\]packages[/\\]cli[/\\](?:src[/\\]index\.ts|dist[/\\]index\.js)$/.test(entry);

if (traceFile && isCli) {
  const fs = process.getBuiltinModule("node:fs");
  const REFUSAL = /(Unknown option: \S+|Unknown command \S+|No command specified\.)/;
  let refused = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (!refused) {
      // eslint-disable-next-line no-control-regex
      const text = String(chunk).replace(/\u001b\[[0-9;]*m/g, "");
      const match = REFUSAL.exec(text);
      if (match) refused = match[1];
    }
    return write(chunk, ...rest);
  };
  process.on("exit", (code) => {
    try {
      fs.appendFileSync(
        traceFile,
        `${JSON.stringify({ argv: process.argv.slice(2), code, refused })}\n`,
      );
    } catch {
      // A trace that cannot be written must not change what the CLI does.
    }
  });
}
