// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { installationId, loadTelemetrySecret, telemetryPeriod } from "./identity.js";
import { publicGatewayCommit } from "./commit.js";
import { telemetryForcedOff, telemetryRuntimeAllowed, telemetryTestRuntime } from "./policy.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ConfigStore } from "../config-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4_000;
const ENDPOINT = "https://telemetry.omnesis.app/v1/heartbeat";

export interface TelemetryPayload {
  schemaVersion: 1;
  installationId: string;
  gatewayVersion: string;
  gitCommit: string;
  os: "linux" | "darwin" | "win32" | "other";
  arch: "x64" | "arm64" | "arm" | "ia32" | "other";
  period: string;
}

export interface TelemetryTransport {
  send(payload: TelemetryPayload, signal: AbortSignal): Promise<void>;
}

/** Construction itself is guarded; tests cannot accidentally obtain this transport. */
export function productionTelemetryTransport(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryTransport | undefined {
  if (
    telemetryTestRuntime(process.env) ||
    !telemetryRuntimeAllowed({ env }) ||
    telemetryForcedOff(env)
  )
    return undefined;
  return {
    async send(payload, signal) {
      // Recheck at the final network seam, including an opt-out during preparation.
      if (
        telemetryTestRuntime(process.env) ||
        !telemetryRuntimeAllowed({ env }) ||
        telemetryForcedOff(env) ||
        signal.aborted
      )
        return;
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
        redirect: "error",
        credentials: "omit",
      });
      await response.body?.cancel();
    },
  };
}

interface Options {
  configDir: string;
  configStore: Pick<ConfigStore, "get" | "onChange">;
  version: string;
  transport: TelemetryTransport;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  random?: () => number;
  commit?: (signal: AbortSignal) => Promise<string>;
  firstDelayMs?: number;
  intervalMs?: number;
}

/** A test can exercise real HTTP only on literal loopback, never by overriding production. */
export function isolatedTelemetryTestTransport(
  env: NodeJS.ProcessEnv,
): TelemetryTransport | undefined {
  if (env.OMNESIS_RUNTIME_MODE !== "test" || env.OMNESIS_E2E_DISABLE_DEFAULT_RELAY !== "1")
    return undefined;
  try {
    const endpoint = new URL(env.OMNESIS_E2E_TELEMETRY_URL ?? "");
    if (
      endpoint.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/v1/heartbeat" ||
      !endpoint.port
    )
      return undefined;
    return {
      async send(payload, signal) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
          redirect: "error",
          credentials: "omit",
        });
        await response.body?.cancel();
      },
    };
  } catch {
    return undefined;
  }
}

export function runtimeInstallationTelemetry(
  options: Omit<Options, "transport">,
): InstallationTelemetry | undefined {
  const env = options.env ?? process.env;
  const production = productionTelemetryTransport(env);
  if (production) return new InstallationTelemetry({ ...options, transport: production });
  const isolated = isolatedTelemetryTestTransport(env);
  if (!isolated) return undefined;
  return new InstallationTelemetry({
    ...options,
    transport: isolated,
    firstDelayMs: 0,
    intervalMs: 250,
    random: () => 0,
    commit: async () => "custom",
  });
}

/** Best-effort census: one bounded attempt, no durable payloads or retry queue. */
export class InstallationTelemetry {
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private unsubscribe?: () => void;
  private stopped = false;
  private generation = 0;
  private lastAttempt = 0;
  private secret = "";
  private noticeShown = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: Options) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    // Runtime constructs this service before registering slower config listeners.
    // An opt-out aborts synchronously before their asynchronous reconciliation.
    this.unsubscribe = options.configStore.onChange((before, after) => {
      if (this.configAllows(before) !== this.configAllows(after)) this.reschedule();
    });
  }

  async start(): Promise<void> {
    try {
      this.secret = await loadTelemetrySecret(this.options.configDir);
      try {
        const value = Number(
          await readFile(join(this.options.configDir, "telemetry-last-attempt-v1"), "utf8"),
        );
        if (Number.isFinite(value) && value > 0 && value <= this.now()) this.lastAttempt = value;
      } catch {
        /* A new installation has no previous attempt. */
      }
      try {
        await access(join(this.options.configDir, "telemetry-notice-v1"));
        this.noticeShown = true;
      } catch {
        /* The portal supplies the first notice instead. */
      }
      this.reschedule();
    } catch {
      // Optional telemetry cannot affect gateway startup, even on a read-only disk.
      this.stop();
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private allowed(): boolean {
    return (
      !this.stopped &&
      !telemetryForcedOff(this.env) &&
      this.configAllows(this.options.configStore.get())
    );
  }

  private configAllows(value: OmnesisConfig): boolean {
    const config = value.telemetry;
    return (
      config?.enabled !== false &&
      (config?.acknowledged === true || config?.noticeShown === true || this.noticeShown)
    );
  }

  private cancel(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
  }

  private reschedule(): void {
    this.cancel();
    if (!this.secret || !this.allowed()) return;
    // First startup allows another minute to disable after the installer notice.
    const delay =
      this.lastAttempt === 0
        ? (this.options.firstDelayMs ?? 60_000)
        : Math.max(0, this.lastAttempt + (this.options.intervalMs ?? DAY_MS) - this.now());
    const jitter = Math.floor(this.random() * 60 * 60 * 1000);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      void this.report(generation);
    }, delay + jitter);
    this.timer.unref();
  }

  private async report(generation: number): Promise<void> {
    if (generation !== this.generation || !this.allowed()) return;
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      // Persist timing only; an outage never accumulates reports for later upload.
      this.lastAttempt = this.now();
      await writeFile(
        join(this.options.configDir, "telemetry-last-attempt-v1"),
        String(this.lastAttempt),
        { mode: 0o600 },
      );
      const gitCommit = await (this.options.commit ?? publicGatewayCommit)(controller.signal);
      if (generation !== this.generation || !this.allowed() || controller.signal.aborted) return;
      const period = telemetryPeriod(new Date(this.now()));
      const os = process.platform;
      const arch = process.arch;
      await this.options.transport.send(
        {
          schemaVersion: 1,
          installationId: installationId(this.secret, period),
          gatewayVersion: this.options.version,
          gitCommit,
          os: os === "linux" || os === "darwin" || os === "win32" ? os : "other",
          arch:
            arch === "x64" || arch === "arm64" || arch === "arm" || arch === "ia32"
              ? arch
              : "other",
          period,
        },
        controller.signal,
      );
    } catch {
      /* Network, storage and validation failures never reach gateway callers. */
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.request = undefined;
        this.reschedule();
      }
    }
  }
}
