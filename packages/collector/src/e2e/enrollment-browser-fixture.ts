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
function browserUrl(command, args) {
  const name = basename(String(command)).toLowerCase().replace(/\\.exe$/, '');
  let url;
  if ((process.platform === 'linux' && name === 'xdg-open') || (process.platform === 'darwin' && name === 'open')) url = args[0];
  if (process.platform === 'win32' && name === 'rundll32' && args[0] === 'url.dll,FileProtocolHandler') url = args[1];
  if (process.platform === 'win32' && name === 'powershell') {
    const encoded = args.findIndex((value) => typeof value === 'string' && value.toLowerCase() === '-encodedcommand');
    const script = encoded >= 0 && typeof args[encoded + 1] === 'string'
      ? Buffer.from(args[encoded + 1], 'base64').toString('utf16le')
      : args.at(-1);
    const match = typeof script === 'string' && /^Start-Process -FilePath '((?:[^']|'')*)'$/.exec(script);
    if (match) url = match[1].replaceAll("''", "'");
  }
  return url;
}
function intercepted(original) {
  return function(command, args = [], options) {
    const url = browserUrl(command, args);
    if (typeof url !== 'string') return original.call(this, command, args, options);
    return original.call(this, process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1], process.argv[2]+"\\\\n");process.exitCode=1', ${JSON.stringify(launches)}, url], options);
  };
}
childProcess.spawn = intercepted(childProcess.spawn);
childProcess.spawnSync = intercepted(childProcess.spawnSync);
require('node:module').syncBuiltinESMExports();
`,
  );
  return file;
}
