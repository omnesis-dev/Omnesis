// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Linux source E2E substitute for the packaged native adapter's fixed Node trust policy. */
export async function createDesktopNodeAdapter(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, "desktop-node"),
    registration = join(directory, "runtime-policy.mjs");
  await writeFile(
    registration,
    `Object.defineProperty(process, 'execPath', {value:${JSON.stringify(executable)},writable:false,configurable:false});\n`,
    { mode: 0o600 },
  );
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} --use-system-ca --import ${quote(pathToFileURL(registration).href)} "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}
