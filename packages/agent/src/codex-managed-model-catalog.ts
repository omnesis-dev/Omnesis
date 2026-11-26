// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MANAGED_CODEX_QUALIFIED_VERSION } from "./codex-managed-policy-version.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 1000;
const fields = new Set([
  "guardian",
  "slug",
  "display_name",
  "description",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "additional_speed_tiers",
  "service_tiers",
  "default_service_tier",
  "available_access_programs",
  "availability_nux",
  "upgrade",
  "model_messages",
  "include_skills_usage_instructions",
  "include_plugin_usage_instructions",
  "include_apps_usage_instructions",
  "supports_reasoning_summary_parameter",
  "default_reasoning_summary",
  "support_verbosity",
  "default_verbosity",
  "apply_patch_tool_type",
  "web_search_tool_type",
  "web_search_provider",
  "truncation_policy",
  "supports_image_detail_original",
  "context_window",
  "max_context_window",
  "auto_compact_token_limit",
  "comp_hash",
  "effective_context_window_percent",
  "experimental_supported_tools",
  "input_modalities",
  "supports_search_tool",
  "supports_experimental_context",
  "use_responses_lite",
  "supports_reasoning_effort_updates",
  "node_repl_auto_review_required",
  "node_repl_disabled",
  "auto_review_model_override",
  "model_specialty",
  "tool_mode",
  "multi_agent_version",
  "multi_agent_reasoning_effort",
  "multi_agent_tools_in_code_mode",
]);
const refused = () =>
  new Error(
    "Codex model metadata could not be isolated. Refresh the model list or use an API-key backend.",
  );
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const slug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(value);

export interface ManagedCodexModelCatalog {
  readonly models: readonly Record<string, unknown>[];
}

/** Pinned ModelInfo schema: preserve public model behavior; remove native tool selectors. */
export function sanitizeManagedCodexModelCatalog(
  value: unknown,
  selectedSlugs: readonly string[],
  version: string,
): ManagedCodexModelCatalog {
  if (
    version !== MANAGED_CODEX_QUALIFIED_VERSION ||
    selectedSlugs.length === 0 ||
    selectedSlugs.length > MAX_MODELS ||
    selectedSlugs.some((item) => !slug(item))
  )
    throw refused();
  const response = record(value);
  if (
    !response ||
    Object.keys(response).some((key) => key !== "models") ||
    !Array.isArray(response.models) ||
    response.models.length < 1 ||
    response.models.length > MAX_MODELS
  )
    throw refused();
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw refused();
  }
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw refused();
  const ids = new Set<string>();
  const copied = JSON.parse(encoded) as { models: unknown[] };
  const models = copied.models.map((item) => {
    const model = record(item);
    if (
      !model ||
      Object.keys(model).some((key) => !fields.has(key)) ||
      !slug(model.slug) ||
      ids.has(model.slug) ||
      typeof model.display_name !== "string" ||
      model.display_name.length > 256 ||
      !Array.isArray(model.supported_reasoning_levels) ||
      model.supported_reasoning_levels.length > 16 ||
      !["default", "shell_command", "local", "unified_exec", "disabled"].includes(
        String(model.shell_type),
      ) ||
      !["list", "hide", "none"].includes(String(model.visibility)) ||
      typeof model.supported_in_api !== "boolean" ||
      !Number.isSafeInteger(model.priority) ||
      typeof model.support_verbosity !== "boolean" ||
      !record(model.truncation_policy) ||
      (model.tool_mode != null &&
        !["direct", "code_mode", "code_mode_only"].includes(String(model.tool_mode))) ||
      (model.apply_patch_tool_type != null && model.apply_patch_tool_type !== "freeform") ||
      !Array.isArray(model.experimental_supported_tools) ||
      (model.multi_agent_tools_in_code_mode != null &&
        typeof model.multi_agent_tools_in_code_mode !== "boolean")
    )
      throw refused();
    ids.add(model.slug);
    return {
      ...model,
      shell_type: "disabled",
      apply_patch_tool_type: null,
      tool_mode: "direct",
      experimental_supported_tools: [],
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      supports_search_tool: false,
      supports_experimental_context: false,
      use_responses_lite: false,
      node_repl_disabled: true,
      multi_agent_version: null,
      multi_agent_reasoning_effort: null,
      multi_agent_tools_in_code_mode: false,
    };
  });
  if (selectedSlugs.some((item) => !ids.has(item))) throw refused();
  // No cache identity, account, timestamp or ETag accompanies the public catalog.
  return { models };
}

export interface ManagedCodexCatalogFile {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/** Caller holds the shared-home discovery lease and has physically joined its discovery client. */
async function readCatalogFile(path: string): Promise<ManagedCodexCatalogFile> {
  if ((await realpath(dirname(path))) !== resolve(dirname(path))) throw refused();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size < 1n ||
      before.size > BigInt(MAX_BYTES)
    )
      throw refused();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }),
      published = await lstat(path, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      published.isSymbolicLink() ||
      published.dev !== before.dev ||
      published.ino !== before.ino ||
      (await realpath(dirname(path))) !== resolve(dirname(path))
    )
      throw refused();
    const result = bytes.subarray(0, length);
    return {
      bytes: result,
      sha256: createHash("sha256").update(result).digest("hex"),
      device: before.dev,
      inode: before.ino,
    };
  } catch {
    throw refused();
  } finally {
    await file.close();
  }
}

export async function readManagedCodexCatalogFile(path: string): Promise<ManagedCodexCatalogFile> {
  try {
    return await readCatalogFile(path);
  } catch {
    throw refused();
  }
}

/** Extract only public ModelInfo from the exact, freshly discovered pinned cache schema. */
export function managedCodexCatalogFromCache(
  bytes: Uint8Array,
  selectedSlugs: readonly string[],
  previousSha256: string | null,
  version: string,
): ManagedCodexModelCatalog {
  if (
    bytes.byteLength > MAX_BYTES ||
    (previousSha256 !== null && !/^[a-f0-9]{64}$/u.test(previousSha256))
  )
    throw refused();
  if (
    previousSha256 !== null &&
    createHash("sha256").update(bytes).digest("hex") === previousSha256
  )
    throw refused();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw refused();
  }
  const cache = record(value);
  if (
    !cache ||
    Object.keys(cache).some(
      (key) => !["fetched_at", "etag", "client_version", "identity", "models"].includes(key),
    ) ||
    cache.client_version !== version ||
    typeof cache.identity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(cache.identity) ||
    typeof cache.fetched_at !== "string"
  )
    throw refused();
  const fetchedAt = Date.parse(cache.fetched_at);
  if (!Number.isFinite(fetchedAt)) throw refused();
  return sanitizeManagedCodexModelCatalog({ models: cache.models }, selectedSlugs, version);
}
