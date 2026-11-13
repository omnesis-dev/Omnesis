// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { bindingOrigin } from "./gateway-binding.js";
import type {
  CertificateIncident,
  CertificateMonitorOptions,
  CertificateMonitorStatus,
  CertificateIssuanceMonitor,
} from "./certificate-monitor.js";
import type { startCertificateMonitorPoller } from "./certificate-monitor-poller.js";

export type GatewayCertificateMonitorStatus = Omit<
  CertificateMonitorStatus,
  "hostname" | "state" | "lastError"
> & {
  enabled: boolean;
  hostname?: string;
  state: CertificateMonitorStatus["state"] | "disabled";
  lastError?: CertificateMonitorStatus["lastError"] | "ct-configuration-invalid";
};
type Monitor = Pick<CertificateIssuanceMonitor, "check" | "status">;
export interface GatewayCertificateMonitorOptions {
  env: NodeJS.ProcessEnv;
  configDir: string;
  identity(): { publicOrigin?: string; spkiFingerprint?: string } | undefined;
  /**
   * Every incident the journal holds when the monitor opens, then each new one before it is
   * recorded. Called again for incidents it was already told about, so it must be idempotent.
   */
  onIncident?(incidents: CertificateIncident[]): Promise<void>;
  create?: (options: Omit<CertificateMonitorOptions, "provider">) => Promise<Monitor>;
  now?: () => number;
}

/**
 * Gateway-owned observer. Status polling can initialize it after setup. It has no relay
 * dependency; what an incident changes is decided by `onIncident`.
 */
export class GatewayCertificateMonitor {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private poller: NonNullable<ReturnType<typeof startCertificateMonitorPoller>> | undefined;
  private initializing: Promise<void> | undefined;
  private closed = false;
  private retryAt = 0;
  private failure: GatewayCertificateMonitorStatus["lastError"] | undefined;
  private hostname: string | undefined;
  constructor(private readonly options: GatewayCertificateMonitorOptions) {
    // Automatic enrollment relies on this to spot a substituted certificate, so opting out is explicit.
    this.enabled = options.env.OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED !== "0";
    this.now = options.now ?? Date.now;
  }
  start(): void {
    if (!this.enabled || this.closed || this.initializing || this.now() < this.retryAt) return;
    if (this.poller) {
      try {
        const identity = this.options.identity();
        this.failure = undefined;
        if (identity?.spkiFingerprint !== undefined && this.poller.status().state === "pending")
          void this.poller.check();
      } catch {
        this.failure = "ct-configuration-invalid";
      }
      return;
    }
    let hostname: string, interval: number | undefined, providerUrl: string | undefined;
    try {
      const identity = this.options.identity();
      if (!identity?.publicOrigin || identity.spkiFingerprint === undefined) return;
      hostname = bindingOrigin(identity.publicOrigin).hostname;
      if (!/^[a-f0-9]{64}$/.test(identity.spkiFingerprint)) throw new Error();
      const configured = this.options.env.OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_INTERVAL_MS;
      if (configured !== undefined) {
        interval = Number(configured);
        if (
          !/^\d+$/.test(configured) ||
          !Number.isSafeInteger(interval) ||
          interval < 60000 ||
          interval > 86400000
        )
          throw new Error();
      }
      providerUrl = this.options.env.OMNESIS_CLOUD_RELAY_CERTSPOTTER_URL;
      if (providerUrl !== undefined) {
        const url = new URL(providerUrl);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
          throw new Error();
        // A base path, so `v1/issuances` resolves below it.
        providerUrl = url.href.endsWith("/") ? url.href : `${url.href}/`;
      }
    } catch {
      this.failure = "ct-configuration-invalid";
      this.retryAt = this.now() + 60000;
      return;
    }
    this.hostname = hostname;
    const expectedSpkiFingerprint = () => {
      try {
        const current = this.options.identity();
        return current?.publicOrigin && bindingOrigin(current.publicOrigin).hostname === hostname
          ? current.spkiFingerprint
          : undefined;
      } catch {
        return undefined;
      }
    };
    this.initializing = (async () => {
      const { startCertificateMonitorPoller } = await import("./certificate-monitor-poller.js");
      const input = {
        hostname,
        expectedSpkiFingerprint,
        journalFile: join(this.options.configDir, "cloud-relay/certificate-incidents.json"),
        ...(this.options.onIncident ? { onIncident: this.options.onIncident } : {}),
      };
      let monitor: Monitor;
      if (this.options.create) monitor = await this.options.create(input);
      else {
        const [{ CertificateIssuanceMonitor }, { CertSpotterProvider }] = await Promise.all([
          import("./certificate-monitor.js"),
          import("./certificate-monitor-certspotter.js"),
        ]);
        monitor = await CertificateIssuanceMonitor.open({
          ...input,
          provider: new CertSpotterProvider({
            apiKeyFile: this.options.env.OMNESIS_CLOUD_RELAY_CERTSPOTTER_API_KEY_FILE,
            ...(providerUrl ? { baseUrl: providerUrl } : {}),
          }),
        });
      }
      if (this.closed) return;
      // Incidents recorded before a restart, or before a version that acted on them, count too.
      const recorded = monitor.status().incidents;
      if (recorded.length) await this.options.onIncident?.(recorded);
      this.poller = startCertificateMonitorPoller({ monitor, intervalMs: interval });
      this.failure = undefined;
    })()
      .catch(() => {
        this.failure = "ct-provider-unavailable";
        this.retryAt = this.now() + 60000;
      })
      .finally(() => {
        this.initializing = undefined;
      });
  }
  status(): GatewayCertificateMonitorStatus {
    this.start();
    if (!this.enabled || this.closed)
      return { enabled: this.enabled, provider: "certspotter", state: "disabled", incidents: [] };
    return this.poller
      ? {
          enabled: true,
          ...this.poller.status(),
          ...(this.failure ? { state: "unavailable" as const, lastError: this.failure } : {}),
        }
      : {
          enabled: true,
          provider: "certspotter",
          hostname: this.hostname,
          state: this.failure ? "unavailable" : "pending",
          lastError: this.failure,
          incidents: [],
        };
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.poller?.stop();
    this.poller = undefined;
  }
}
