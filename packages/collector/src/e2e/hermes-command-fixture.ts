// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A genuine executable fixture; never interpret a shell script on Windows. */
import { copyFileSync, statSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function prepareHermesCommandFixture(directory: string): NodeJS.ProcessEnv {
  const executable = join(directory, process.platform === "win32" ? "hermes.exe" : "hermes");
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  const identity = statSync(executable, { bigint: true });
  const preload = join(directory, "hermes command preload.mjs");
  writeFileSync(
    preload,
    `
import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const executable = ${JSON.stringify(realpathSync.native(executable))};
if (realpathSync.native(process.execPath) === executable) {
  const identity = statSync(process.execPath, {bigint:true});
  if (String(identity.dev) !== ${JSON.stringify(String(identity.dev))} || String(identity.ino) !== ${JSON.stringify(String(identity.ino))}) throw new Error('Hermes fixture executable changed');
  if (JSON.stringify(process.argv.slice(1)) !== JSON.stringify([resolve('plugins'),'enable','--no-allow-tool-override','omnesis-integration']) || !process.env.HERMES_HOME) process.exit(64);
  writeFileSync(join(process.env.HERMES_HOME, '.omnesis-hermes-enabled-e2e'), '', {mode:0o600});
  process.exit(0);
}
`,
  );
  const inherited = process.env.NODE_OPTIONS?.trim();
  return {
    NODE_OPTIONS: [inherited, `--import=${JSON.stringify(pathToFileURL(preload).href)}`]
      .filter(Boolean)
      .join(" "),
  };
}
