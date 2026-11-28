// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertManagedCodexProcessPolicy,
  managedCodexProcessArgs,
} from "./codex-managed-process.js";

export function managedCodexAuth(env: NodeJS.ProcessEnv): boolean {
  return env.OMNESIS_DESKTOP_MANAGED === "1";
}

/** Read back the effective supported policy; inherited managed requirements must not weaken it. */
export function assertManagedCodexPolicy(value: unknown): void {
  const record = (input: unknown): Record<string, unknown> | undefined =>
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const config = record(record(value)?.config);
  if (
    config?.cli_auth_credentials_store !== "keyring" ||
    record(config.features)?.secret_auth_storage !== false ||
    record(config.history)?.persistence !== "none" ||
    record(config.analytics)?.enabled !== false ||
    record(config.otel)?.log_user_prompt !== false ||
    record(config.otel)?.log_agent_responses !== false ||
    record(config.otel)?.log_sse_deltas !== false ||
    record(config.otel)?.exporter !== "none" ||
    record(config.otel)?.trace_exporter !== "none" ||
    record(config.otel)?.metrics_exporter !== "none"
  )
    throw new Error(
      "Codex could not confirm this app's strict Keychain and history policy. Review the runtime configuration before signing in.",
    );
  assertManagedCodexProcessPolicy(value);
}

/** Supported pinned Codex policy; never `auto`, which permits plaintext fallback. */
export function managedCodexArgs(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  stateHome: string,
): string[] {
  if (!managedCodexAuth(env)) return [...args];
  return managedCodexProcessArgs([
    ...args,
    "-c",
    'cli_auth_credentials_store="keyring"',
    "-c",
    "features.secret_auth_storage=false",
    "-c",
    'history.persistence="none"',
    "-c",
    "analytics.enabled=false",
    "-c",
    "otel.log_user_prompt=false",
    "-c",
    "otel.log_agent_responses=false",
    "-c",
    "otel.log_sse_deltas=false",
    "-c",
    'otel.exporter="none"',
    "-c",
    'otel.trace_exporter="none"',
    "-c",
    'otel.metrics_exporter="none"',
    "-c",
    `sqlite_home=${JSON.stringify(join(stateHome, "sqlite"))}`,
    "-c",
    `log_dir=${JSON.stringify(join(stateHome, "log"))}`,
  ]);
}

/** Keyring mode ignores legacy files; their continued presence is still unsafe. */
export async function assertNoManagedCodexAuthFile(
  env: NodeJS.ProcessEnv,
  homes: readonly string[],
): Promise<void> {
  if (!managedCodexAuth(env)) return;
  for (const home of new Set(homes)) {
    try {
      await lstat(join(home, "auth.json"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    throw new Error(
      "An earlier desktop Codex sign-in left credentials outside Keychain. Sign out of ChatGPT in Omnesis, then sign in again to store this app’s credentials in Keychain.",
    );
  }
}

/** Bounded owned pool traversal; never follow a member alias to other credentials. */
export async function managedCodexPoolAuthFiles(poolHome: string): Promise<string[]> {
  const pending = [poolHome];
  const files: string[] = [];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("The desktop Codex pool contains an unsafe directory alias.");
      for await (const entry of await opendir(directory)) {
        if (++entries > 50_000)
          throw new Error(
            "The desktop Codex pool exceeds its bounded credential inspection limit.",
          );
        const path = join(directory, entry.name);
        if (entry.name === "auth.json") files.push(path);
        else if (entry.isDirectory()) pending.push(path);
        else if (entry.isSymbolicLink())
          throw new Error("The desktop Codex pool contains an unsafe state alias.");
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
  }
  return files;
}

/** Explicit sign-out only: unlink owned credential files, never read or promote them. */
export async function removeManagedCodexPoolAuth(poolHome: string): Promise<void> {
  for (const path of await managedCodexPoolAuthFiles(poolHome)) await unlink(path);
  if ((await managedCodexPoolAuthFiles(poolHome)).length)
    throw new Error("Earlier desktop ChatGPT credentials could not be confirmed removed.");
}
