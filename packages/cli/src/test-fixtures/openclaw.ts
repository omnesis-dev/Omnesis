// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { strictEqual } from "node:assert";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A real Node CLI, injected only at the external OpenClaw executable boundary. */
export function scriptedOpenClaw(
  root: string,
  stdout: string,
  exitCode = 0,
): {
  env: NodeJS.ProcessEnv;
  argsFile: string;
  run: typeof spawnSync;
} {
  const argsFile = join(root, "args");
  const entry = join(root, "openclaw fixture.cjs");
  writeFileSync(
    entry,
    `const {writeFileSync}=require('node:fs');
writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n')+'\\n');
process.stdout.write(${JSON.stringify(stdout)});
process.exitCode=${JSON.stringify(exitCode)};
`,
  );
  const run = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    strictEqual(command, "openclaw");
    return spawnSync(process.execPath, [entry, ...args], options);
  }) as typeof spawnSync;
  return { env: { ...process.env, PATH: root }, argsFile, run };
}
