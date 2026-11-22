// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join, resolve } from "node:path";
import { readSecretTextFileSync } from "../../packages/core/src/secret-file.ts";
import { isEntryScript } from "./is-entry-script.mjs";

/** Read only the explicitly selected instance, using its configured secret backend. */
export function readInstanceToken(configDir) {
  if (!configDir) throw new Error("An explicit instance config directory is required");
  const directory = resolve(configDir);
  const token = readSecretTextFileSync(join(directory, "token"), { configDir: directory })?.trim();
  // Malformed encrypted envelopes may be treated as legacy plaintext by the
  // general secret reader. Reject serialized objects instead of echoing them;
  // retain legacy opaque token characters and encode them only at URL output.
  if (!token || /[\r\n\0]/.test(token) || token.startsWith("{") || token.startsWith("["))
    throw new Error("Instance token is unavailable");
  return token;
}

if (isEntryScript(import.meta.url)) {
  try {
    const token = readInstanceToken(process.argv[2]);
    if (process.argv[3]) {
      const url = new URL("/portal/", process.argv[3]);
      url.searchParams.set("token", token);
      process.stdout.write(url.href);
    } else process.stdout.write(token);
  } catch {
    // Never print an encrypted envelope, backend exception or secret material.
    process.stderr.write("Cannot read the selected instance token through its secret store.\n");
    process.exitCode = 1;
  }
}
