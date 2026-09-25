// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** One-shot worker entry for host security collection. */

import { parentPort, workerData } from "node:worker_threads";
import { collectSecurityData } from "./security.js";
import type {
  DoctorSecurityWorkerInput,
  DoctorSecurityWorkerMessage,
} from "./security-worker-protocol.js";

if (!parentPort) throw new Error("security-worker-entry must run as a Node worker_thread");

const port = parentPort;

async function main(): Promise<void> {
  const input = workerData as DoctorSecurityWorkerInput;
  const security = await collectSecurityData({
    configDir: input.configDir,
    component: input.component,
    fixPermissions: false,
  });
  const message: DoctorSecurityWorkerMessage = { type: "done", security };
  port.postMessage(message);
}

main().catch((err: unknown) => {
  const message: DoctorSecurityWorkerMessage = {
    type: "error",
    error: err instanceof Error ? err.message : String(err),
  };
  port.postMessage(message);
});
