// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Inspected against the pinned 0.169.0 runtime's recognized feature catalog.
// ShellSnapshot is independently enabled by default even when ShellTool is disabled.
export const MANAGED_CODEX_PROCESS_FEATURES = Object.freeze({
  shell_tool: false,
  unified_exec: false,
  shell_snapshot: false,
  shell_snapshot_v2: false,
  login_shell_package_path: false,
  hooks: false,
  plugins: false,
  skill_mcp_dependency_install: false,
  multi_agent: false,
  apps: false,
  enable_mcp_apps: false,
  view_image: false,
  image_generation: false,
  memories: false,
  goals: false,
  code_mode: false,
  code_mode_host: false,
  code_mode_host_grpc: false,
  code_mode_prewarm: false,
  executor_capability_discovery: false,
  executor_capability_discovery_v2: false,
  skip_host_skill_discovery: true,
});

const refused = () =>
  new Error(
    "Codex could not confirm this app's isolated process policy. Use an API-key backend until this runtime can be verified.",
  );
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Appended after caller settings for both device login and app-server startup. */
export function managedCodexProcessArgs(args: readonly string[]): string[] {
  return [
    ...args,
    ...Object.entries(MANAGED_CODEX_PROCESS_FEATURES).flatMap(([name, value]) => [
      "-c",
      `features.${name}=${value}`,
    ]),
    "-c",
    "mcp_servers={}",
    "-c",
    "notify=[]",
    "-c",
    "allow_login_shell=false",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "tools.experimental_request_user_input.enabled=false",
    "-c",
    "tools.update_plan.enabled=false",
  ];
}

/** A table override may deep-merge: reject every surviving server or notification command. */
export function assertManagedCodexProcessPolicy(value: unknown): void {
  const response = record(value),
    config = record(response?.config),
    features = record(config?.features),
    servers = record(config?.mcp_servers);
  // The pinned typed effective-config DTO omits these two supported tool controls.
  // Its bounded, unambiguous highest-priority sessionFlags layer preserves them.
  const layers = response?.layers;
  const flags =
    Array.isArray(layers) && layers.length <= 64
      ? layers.map(record).filter((layer) => record(layer?.name)?.type === "sessionFlags")
      : [];
  const tools = flags.length === 1 ? record(record(flags[0]?.config)?.tools) : undefined;
  if (
    !config ||
    !features ||
    !servers ||
    Object.keys(servers).length !== 0 ||
    !Array.isArray(config.notify) ||
    config.notify.length !== 0 ||
    config.allow_login_shell !== false ||
    config.project_doc_max_bytes !== 0 ||
    record(tools?.experimental_request_user_input)?.enabled !== false ||
    record(tools?.update_plan)?.enabled !== false ||
    Object.entries(MANAGED_CODEX_PROCESS_FEATURES).some(
      ([name, expected]) => features[name] !== expected,
    )
  )
    throw refused();
}

/** Raw config echo cannot prove a key is implemented. Read the effective recognized catalog. */
export async function assertManagedCodexEffectiveFeatures(
  request: (params: { cursor?: string; limit: number; threadId?: string }) => Promise<unknown>,
  threadId?: string,
  runtimeVersion?: string,
): Promise<void> {
  if (runtimeVersion !== "0.169.0") throw refused();
  const enabled = new Map<string, boolean>();
  let cursor: string | undefined;
  for (let page = 0; page < 16; page++) {
    const response = record(
      await request({
        ...(cursor ? { cursor } : {}),
        limit: 128,
        ...(threadId ? { threadId } : {}),
      }),
    );
    if (!response || !Array.isArray(response.data) || response.data.length > 128) throw refused();
    for (const item of response.data) {
      const feature = record(item);
      if (
        !feature ||
        typeof feature.name !== "string" ||
        feature.name.length > 128 ||
        typeof feature.enabled !== "boolean" ||
        enabled.has(feature.name)
      )
        throw refused();
      if (
        Object.hasOwn(MANAGED_CODEX_PROCESS_FEATURES, feature.name) &&
        !["stable", "beta", "underDevelopment", "deprecated"].includes(String(feature.stage))
      )
        throw refused();
      enabled.set(feature.name, feature.enabled);
    }
    if (response.nextCursor == null) {
      if (
        Object.entries(MANAGED_CODEX_PROCESS_FEATURES).some(([name, expected]) =>
          name === "unified_exec"
            ? // Pinned ManagedFeatures normalization keeps the executor implementation enabled.
              // ShellTool=false is the separate, recognized gate before registering exec tools.
              typeof enabled.get(name) !== "boolean"
            : enabled.get(name) !== expected,
        )
      )
        throw refused();
      return;
    }
    if (
      typeof response.nextCursor !== "string" ||
      !response.nextCursor ||
      response.nextCursor.length > 4096 ||
      response.nextCursor === cursor
    )
      throw refused();
    cursor = response.nextCursor;
  }
  throw refused();
}

/** The vendor never receives a project/config repository or shell startup workspace. */
export async function assertManagedCodexWorkspace(workspace: string): Promise<void> {
  const info = await lstat(workspace);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await realpath(workspace)) !== resolve(workspace) ||
    (await readdir(workspace)).length !== 0
  )
    throw refused();
}

export function managedCodexThreadConfig<T extends { features: object }>(
  _config: T,
): T & {
  features: T["features"] & typeof MANAGED_CODEX_PROCESS_FEATURES;
  mcp_servers: object;
  notify: never[];
  allow_login_shell: false;
  project_doc_max_bytes: 0;
  tools: { experimental_request_user_input: { enabled: false }; update_plan: { enabled: false } };
} {
  throw new Error(
    "Managed Codex conversations are unavailable until model tool metadata can be isolated. Use an API-key backend.",
  );
}
