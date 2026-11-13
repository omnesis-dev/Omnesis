// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, cloudRelayEnabled } from "@omnesis/core";
import { runRelayCommand } from "./runtime.js";

const log = createLogger("cloud-relay");
try {
  if (!cloudRelayEnabled()) throw new Error("Cloud relay requires OMNESIS_CLOUD_RELAY_ENABLED=1");
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
} catch {
  // Errors may originate in credential parsers; never log their payloads.
  log.error("Cloud relay command failed; check configuration and credentials");
  process.exitCode = 1;
}
