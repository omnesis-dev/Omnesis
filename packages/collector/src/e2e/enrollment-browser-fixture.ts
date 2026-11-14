// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Replace only the platform browser launch, retaining real child-process/exit semantics. */
export async function writeNoBrowserPreload(directory: string): Promise<string> {
  const file = join(directory, "no-browser-preload.cjs");
  const launches = join(directory, "launches.txt");
  await writeFile(
    file,
    `
const childProcess = require('node:child_process');
const { basename } = require('node:path');
const original = childProcess.spawn;
childProcess.spawn = function(command, args = [], options) {
  const name = basename(String(command)).toLowerCase().replace(/\\.exe$/, '');
  let url;
  if ((process.platform === 'linux' && name === 'xdg-open') || (process.platform === 'darwin' && name === 'open')) url = args[0];
  if (process.platform === 'win32' && name === 'rundll32' && args[0] === 'url.dll,FileProtocolHandler') url = args[1];
  if (process.platform === 'win32' && name === 'powershell') {
    const script = args.at(-1);
    const match = typeof script === 'string' && /^Start-Process -FilePath '((?:[^']|'')*)'$/.exec(script);
    if (match) url = match[1].replaceAll("''", "'");
  }
  if (typeof url !== 'string') return original.call(this, command, args, options);
  return original.call(this, process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1], process.argv[2]+"\\\\n");process.exitCode=1', ${JSON.stringify(launches)}, url], options);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  return file;
}
