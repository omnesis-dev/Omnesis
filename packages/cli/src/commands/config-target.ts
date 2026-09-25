// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where `omnesis config` reads and writes.
 *
 * Normally that is the running gateway's admin config API, which owns
 * `omnesis.json`, watches it and applies changes live. When the gateway this
 * CLI targets runs on this machine and is certainly not running, the commands
 * work on the file it will load instead: otherwise a gateway that fails on
 * start could not be reconfigured by the one command meant for it.
 *
 * "Certainly not running" needs all three: the gateway URL names this
 * machine, no live process holds the config directory's gateway lock (a
 * booting or draining gateway holds it before and after it listens), and
 * every address the URL resolves to refuses the connection. Anything else —
 * a remote gateway, a TLS or HTTP error, a timeout — goes to the gateway as
 * before, so its own error surfaces.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyMergePatch, diffConfigPaths, validateConfig } from "@omnesis/config";
import {
  atomicWriteFileSync,
  cleanupConfigSecretMaterialization,
  DEFAULT_CONFIG_DIR,
  liveGatewayHolder,
  materializeConfigSecrets,
  type GatewayLockHolder,
} from "@omnesis/core";
import {
  CliError,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  gatewayFetch,
  gatewayJson,
  targetsLocalGateway,
  withSpinner,
  GATEWAY_REQUEST_URL,
} from "../utils.js";

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigSnapshot {
  config: Record<string, unknown>;
  version: number;
}

export type ConfigMutation =
  | { ok: true; changedPaths: string[]; version: number }
  | { ok: false; error: string; errors?: ConfigIssue[] };

export interface ConfigTarget {
  readonly kind: "gateway" | "file";
  load(): Promise<ConfigSnapshot>;
  loadRaw(): Promise<string>;
  version(): Promise<number>;
  /** RFC 7396 merge patch. */
  patch(patch: unknown): Promise<ConfigMutation>;
  /** Full replacement. */
  replace(next: unknown): Promise<ConfigMutation>;
}

interface GatewayMutationResponse {
  ok: boolean;
  changedPaths?: string[];
  version?: number;
  error?: string;
  errors?: ConfigIssue[];
}

/** The running gateway's `/admin/config` API. */
export class GatewayConfigTarget implements ConfigTarget {
  readonly kind = "gateway";

  load(): Promise<ConfigSnapshot> {
    return withSpinner("Loading config", () => gatewayJson<ConfigSnapshot>("/admin/config"));
  }

  loadRaw(): Promise<string> {
    return withSpinner("Loading config", async () => {
      const res = await gatewayFetch("/admin/config/raw");
      if (!res.ok) {
        throw new Error(
          `Gateway ${res.status} /admin/config/raw: ${await res.text().catch(() => "")}`,
        );
      }
      return res.text();
    });
  }

  async version(): Promise<number> {
    const status = await gatewayJson<{ version: number }>("/admin/config/status");
    return status.version;
  }

  patch(patch: unknown): Promise<ConfigMutation> {
    return this.mutate("PATCH", patch);
  }

  replace(next: unknown): Promise<ConfigMutation> {
    return this.mutate("PUT", next);
  }

  private mutate(method: "PATCH" | "PUT", body: unknown): Promise<ConfigMutation> {
    return withSpinner("Saving config", async () => {
      const res = await gatewayFetch("/admin/config", { method, body: JSON.stringify(body) });
      const parsed = (await res.json()) as GatewayMutationResponse;
      if (!res.ok) {
        return { ok: false, error: parsed.error ?? `Gateway ${res.status}`, errors: parsed.errors };
      }
      return { ok: true, changedPaths: parsed.changedPaths ?? [], version: parsed.version ?? 0 };
    });
  }
}

/**
 * `omnesis.json` itself, for a gateway on this machine that is not running.
 *
 * Mutations follow the gateway's own write path: inline API keys move to the
 * secret store, the result is validated as strictly as an admin API write,
 * a no-op leaves the file untouched, and the file is replaced atomically,
 * readable by its owner only. The starting point is what the gateway would
 * load at boot — unrecognised keys dropped — so a write settles the file on
 * exactly what the gateway would have kept.
 */
export class FileConfigTarget implements ConfigTarget {
  readonly kind = "file";
  readonly path: string;

  constructor(
    private readonly configDir: string,
    private readonly gatewayHolder: (
      configDir: string,
    ) => GatewayLockHolder | null = liveGatewayHolder,
  ) {
    this.path = join(configDir, "omnesis.json");
  }

  load(): Promise<ConfigSnapshot> {
    return settle(() => ({ config: this.read(), version: this.fileVersion() }));
  }

  loadRaw(): Promise<string> {
    return settle(() => (existsSync(this.path) ? readFileSync(this.path, "utf8") : "{}\n"));
  }

  version(): Promise<number> {
    return settle(() => this.fileVersion());
  }

  patch(patch: unknown): Promise<ConfigMutation> {
    return settle(() => this.commit(patch, "patch"));
  }

  replace(next: unknown): Promise<ConfigMutation> {
    return settle(() => this.commit(next, "put"));
  }

  private commit(body: unknown, mode: "put" | "patch"): ConfigMutation {
    const current = this.read();
    const holder = this.gatewayHolder(this.configDir);
    if (holder) {
      throw new CliError(
        `A gateway (PID ${holder.pid}) started while this command ran, so ${this.path} was left unchanged. Run the command again to apply it through that gateway.`,
        EXIT_FAILURE,
      );
    }
    const materialized = materializeConfigSecrets(body, current, this.configDir, mode);
    const candidate =
      mode === "patch" ? applyMergePatch(current, materialized.body) : materialized.body;
    const validation = validateConfig(candidate);
    if (!validation.ok) {
      cleanupConfigSecretMaterialization(materialized, false, this.configDir);
      return { ok: false, error: "Validation failed", errors: validation.errors };
    }
    const changedPaths = diffConfigPaths(current, validation.config);
    if (changedPaths.length > 0) {
      try {
        atomicWriteFileSync(this.path, JSON.stringify(validation.config, null, 2) + "\n", {
          mode: 0o600,
          ensureDir: true,
        });
      } catch (err) {
        cleanupConfigSecretMaterialization(materialized, false, this.configDir);
        throw err;
      }
    }
    cleanupConfigSecretMaterialization(materialized, true, this.configDir, validation.config);
    return { ok: true, changedPaths, version: this.fileVersion() };
  }

  /**
   * The config as the gateway would load it at boot. A file that parses but
   * fails validation is still returned as written: the mutation being applied
   * may be the one that repairs it, and the strict check on the result decides.
   */
  private read(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      throw new CliError(`Cannot read ${this.path}: ${errorMessage(err)}`, EXIT_FAILURE);
    }
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch (err) {
      throw new CliError(
        `${this.path} is not valid JSON (${errorMessage(err)}). Fix the file in an editor, then retry.`,
        EXIT_USER_ERROR,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CliError(
        `${this.path} must hold a JSON object. Fix the file in an editor, then retry.`,
        EXIT_USER_ERROR,
      );
    }
    const validation = validateConfig(parsed, { stripUnknownKeys: true });
    return validation.ok ? validation.config : (parsed as Record<string, unknown>);
  }

  private fileVersion(): number {
    return existsSync(this.path) ? Math.trunc(statSync(this.path).mtimeMs) : 0;
  }
}

export type GatewayProbe = "answered" | "refused" | "unreachable";

export interface ConfigTargetEnvironment {
  gatewayUrl: string;
  configDir: string;
  gatewayHolder: (configDir: string) => GatewayLockHolder | null;
  probe: (gatewayUrl: string) => Promise<GatewayProbe>;
}

export function defaultConfigTargetEnvironment(): ConfigTargetEnvironment {
  return {
    gatewayUrl: GATEWAY_REQUEST_URL,
    configDir: process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
    gatewayHolder: liveGatewayHolder,
    probe: probeGateway,
  };
}

export async function resolveConfigTarget(
  env: ConfigTargetEnvironment = defaultConfigTargetEnvironment(),
): Promise<ConfigTarget> {
  if (!targetsLocalGateway(env.gatewayUrl)) return new GatewayConfigTarget();
  if (env.gatewayHolder(env.configDir)) return new GatewayConfigTarget();
  if ((await env.probe(env.gatewayUrl)) !== "refused") return new GatewayConfigTarget();
  return new FileConfigTarget(env.configDir, env.gatewayHolder);
}

/** Whether anything answers at the gateway URL. Any HTTP response counts. */
export async function probeGateway(gatewayUrl: string, timeoutMs = 2000): Promise<GatewayProbe> {
  try {
    await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return "answered";
  } catch (err) {
    return isConnectionRefused(err) ? "refused" : "unreachable";
  }
}

/**
 * Whether a failed connection was refused outright. A host name that resolves
 * to several addresses reports one error per attempt; it counts only when
 * every attempt was refused.
 */
export function isConnectionRefused(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length > 0) return errors.every(isConnectionRefused);
  if (code === "ECONNREFUSED") return true;
  return isConnectionRefused(cause);
}

/** Run synchronous work behind the async `ConfigTarget` interface, rejecting on a throw. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
