// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Reusable worker launcher for the synchronous host security audit. */

import { Worker } from "node:worker_threads";
import { resolveWorkerEntry } from "../worker-entry.js";
import type { SecurityData } from "./types.js";
import type {
  DoctorSecurityWorkerInput,
  DoctorSecurityWorkerMessage,
} from "./security-worker-protocol.js";

export const SECURITY_SCAN_TIMEOUT_MS = 30_000;

export interface CollectSecurityDataInWorkerOptions {
  configDir: string;
  component?: "gateway" | "collector";
  timeoutMs?: number;
}

/**
 * Collect security posture away from the caller's event loop. Permission
 * repair is intentionally unavailable here: worker-backed audits are remote
 * observations, while repair remains an explicit local operator action.
 */
export function collectSecurityDataInWorker(
  opts: CollectSecurityDataInWorkerOptions,
): Promise<SecurityData> {
  const input: DoctorSecurityWorkerInput = {
    configDir: opts.configDir,
    component: opts.component ?? "gateway",
  };
  const timeoutMs = opts.timeoutMs ?? SECURITY_SCAN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Security scan timeout must be a positive finite number"));
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      const entry = resolveWorkerEntry(
        "./security-worker-entry.ts",
        import.meta.url,
        "./register-tsx.mjs",
      );
      worker = new Worker(entry.url, { workerData: input, execArgv: entry.execArgv });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    const settle = (result: { security: SecurityData } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if ("security" in result) resolve(result.security);
      else reject(result.error);
    };

    const timer = setTimeout(
      () => settle({ error: new Error(`Security posture scan timed out after ${timeoutMs}ms`) }),
      timeoutMs,
    );
    timer.unref();
    worker.unref();

    worker.on("message", (message: DoctorSecurityWorkerMessage) => {
      if (message?.type === "done" && message.security) {
        settle({ security: message.security });
      } else if (message?.type === "error" && typeof message.error === "string") {
        settle({ error: new Error(message.error) });
      } else {
        settle({ error: new Error("Security posture worker returned an invalid message") });
      }
    });
    worker.on("error", (err) => settle({ error: err }));
    worker.on("exit", (code) => {
      settle({
        error: new Error(
          code === 0
            ? "Security posture worker exited before reporting"
            : `Security posture worker exited with code ${code}`,
        ),
      });
    });
  });
}
