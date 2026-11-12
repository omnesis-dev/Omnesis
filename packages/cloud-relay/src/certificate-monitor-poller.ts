// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type {
  CertificateIssuanceMonitor,
  CertificateMonitorStatus,
} from "./certificate-monitor.js";

/** Gateway-only opt-in lifecycle; importing this module schedules no work. */
export function startCertificateMonitorPoller(options?: {
  monitor: Pick<CertificateIssuanceMonitor, "check" | "status">;
  intervalMs?: number;
}):
  | {
      status(): CertificateMonitorStatus;
      check(): Promise<CertificateMonitorStatus>;
      stop(): Promise<void>;
    }
  | undefined {
  if (!options) return undefined;
  const interval = options.intervalMs ?? 900_000;
  if (!Number.isSafeInteger(interval) || interval < 60_000 || interval > 86_400_000)
    throw new Error("Invalid certificate monitor interval");
  const abort = new AbortController();
  let stopped = false,
    failures = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    pending: Promise<CertificateMonitorStatus> | undefined,
    unexpected = false;
  const status = (): CertificateMonitorStatus =>
    unexpected
      ? { ...options.monitor.status(), state: "unavailable", lastError: "ct-provider-unavailable" }
      : options.monitor.status();
  const check = (): Promise<CertificateMonitorStatus> => {
    if (stopped) return Promise.resolve(status());
    if (pending) return pending;
    clearTimeout(timer);
    pending = (async () => {
      try {
        await options.monitor.check(abort.signal);
        unexpected = false;
      } catch {
        unexpected = true;
      }
      const result = status();
      failures =
        result.state === "unavailable" || result.state === "stale" ? Math.min(failures + 1, 10) : 0;
      if (!stopped) {
        const retry = Math.max(0, (Date.parse(result.nextCheckAt ?? "") || 0) - Date.now());
        timer = setTimeout(
          () => {
            void check();
          },
          Math.max(Math.min(interval * 2 ** failures, Math.max(interval, 21_600_000)), retry),
        );
        timer.unref();
      }
      return result;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  void check();
  return {
    status,
    check,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      await pending;
    },
  };
}
