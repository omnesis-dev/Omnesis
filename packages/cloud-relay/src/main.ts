// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { runRelayCommand } from "./runtime.js";

const log = createLogger("cloud-relay");
const diagnosticCodes = new Set([
  "EADDRINUSE",
  "EACCES",
  "ENOENT",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
]);

function commandFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    // Reading the data descriptor avoids invoking an error's code accessor.
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return typeof code === "string" && diagnosticCodes.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

try {
  const runtime = await runRelayCommand(process.argv[2] ?? "serve", process.env);
  if (runtime) {
    log.info(`Listening on ${runtime.url}`);
    if ("dataPort" in runtime) log.info(`TLS passthrough port ${runtime.dataPort}`);
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      try {
        await runtime.close();
      } catch {
        log.error("Cloud relay shutdown failed");
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
  } else if (process.argv[2] !== "prepare-owner") {
    log.info("Cloud relay command complete");
  }
} catch (error) {
  // Errors may originate in credential parsers; never log their payloads.
  // See #1086 — intermittent startup failures need privacy-safe diagnostics.
  const code = commandFailureCode(error);
  log.error(
    `Cloud relay command failed; check configuration and credentials${code ? ` (${code})` : ""}`,
  );
  process.exitCode = 1;
}
