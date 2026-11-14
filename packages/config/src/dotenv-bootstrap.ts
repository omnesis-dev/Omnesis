// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname } from "node:path";
import {
  readWindowsPrivateFileContentsSync,
  secureWindowsPrivatePathSync,
} from "@omnesis/platform/windows-private-file";
import { loadDotEnv, type LoadDotEnvOptions, type LoadDotEnvResult } from "./dotenv-reader.js";

export class DotEnvBootstrapError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Refusing to load ${path}: Windows access controls were not verified.`, { cause });
  }
}

/** Verify Windows config bytes before they can affect module initialization. */
export function loadBootstrapDotEnv(
  opts: Omit<LoadDotEnvOptions, "readFile"> = {},
): LoadDotEnvResult | null {
  return loadDotEnv({
    ...opts,
    ...(process.platform === "win32"
      ? {
          readFile: (path: string) => {
            try {
              return readWindowsPrivateFileContentsSync(path).toString("utf8");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
              throw new DotEnvBootstrapError(path, error);
            }
          },
        }
      : {}),
  });
}

/** Repair without exposing config bytes to the loader; the caller must exit afterward. */
export function repairBootstrapDotEnvAccess(error: DotEnvBootstrapError): void {
  if (process.platform !== "win32") throw new Error("Windows bootstrap repair is unavailable");
  secureWindowsPrivatePathSync(dirname(error.path), "directory");
  secureWindowsPrivatePathSync(error.path, "file");
}
