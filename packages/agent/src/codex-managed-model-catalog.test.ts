// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  readManagedCodexCatalogFile,
  managedCodexCatalogFromCache,
  sanitizeManagedCodexModelCatalog,
} from "./codex-managed-model-catalog.js";

const model = (slug = "fixture-model", tool_mode: string | null = "code_mode_only") => ({
  slug,
  display_name: "Fixture model",
  description: "Invented catalog metadata",
  supported_reasoning_levels: [{ effort: "high", description: "More reasoning" }],
  default_reasoning_level: "high",
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: "freeform",
  tool_mode,
  experimental_supported_tools: ["clock", "send_user_message_async"],
  truncation_policy: { mode: "bytes", limit: 10000 },
  context_window: 123456,
  max_context_window: 234567,
  auto_compact_token_limit: 110000,
  input_modalities: ["text", "image"],
  model_messages: { instructions_template: "Invented vendor instructions" },
});

test.each([null, "code_mode", "code_mode_only"])(
  "native-capable model metadata %s preserves model semantics while removing native selectors",
  (mode) => {
    const original = {
      models: [
        { ...model("fixture-model", mode), multi_agent_tools_in_code_mode: true },
        model("fixture-second", mode),
      ],
    };
    const sanitized = sanitizeManagedCodexModelCatalog(
      original,
      ["fixture-model", "fixture-second"],
      "0.171.0",
    );
    expect(sanitized.models).toHaveLength(2);
    expect(sanitized.models[0]).toMatchObject({
      slug: "fixture-model",
      shell_type: "disabled",
      apply_patch_tool_type: null,
      tool_mode: "direct",
      experimental_supported_tools: [],
      node_repl_disabled: true,
      multi_agent_tools_in_code_mode: false,
      context_window: 123456,
      max_context_window: 234567,
      auto_compact_token_limit: 110000,
      supported_reasoning_levels: original.models[0]!.supported_reasoning_levels,
      input_modalities: ["text", "image"],
      model_messages: original.models[0]!.model_messages,
    });
    expect(original.models[0]!.apply_patch_tool_type).toBe("freeform");
  },
);

test("unknown fields, versions and model fallback are refused without exposing cache details", () => {
  for (const [value, selected, version] of [
    [{ models: [model()], identity: "fixture-private-metadata" }, ["fixture-model"], "0.171.0"],
    [{ models: [{ ...model(), unknown_tool_policy: true }] }, ["fixture-model"], "0.171.0"],
    [{ models: [model()] }, ["missing-model"], "0.171.0"],
    [{ models: [model()] }, ["fixture-model"], "0.170.0"],
    [{ models: [model(), model()] }, ["fixture-model"], "0.171.0"],
    [
      { models: [{ ...model(), multi_agent_tools_in_code_mode: "unreviewed" }] },
      ["fixture-model"],
      "0.171.0",
    ],
  ] as const) {
    expect(() => sanitizeManagedCodexModelCatalog(value, selected, version)).toThrow(
      /model metadata could not be isolated/u,
    );
  }
});

test("catalog reads hold private bounded bytes and reject final or parent aliases", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-model-catalog-")));
  try {
    const directory = join(root, "catalog");
    await mkdir(directory, { mode: 0o700 });
    const file = join(directory, "models.json"),
      bytes = JSON.stringify({ models: [model()] });
    await writeFile(file, bytes, { mode: 0o600 });
    expect((await readManagedCodexCatalogFile(file)).bytes.toString()).toBe(bytes);
    await symlink(file, join(root, "final.json"));
    await expect(readManagedCodexCatalogFile(join(root, "final.json"))).rejects.toThrow();
    await symlink(directory, join(root, "alias"));
    await expect(readManagedCodexCatalogFile(join(root, "alias", "models.json"))).rejects.toThrow();
    await chmod(file, 0o644);
    await expect(readManagedCodexCatalogFile(file)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh vendor cache metadata is validated in memory and omitted from the derived catalog", () => {
  const startedAt = Date.now();
  const cache = {
    fetched_at: new Date(startedAt).toISOString(),
    etag: "fixture-cache-tag",
    identity: "a".repeat(64),
    client_version: "0.171.0",
    models: [model()],
  };
  const bytes = Buffer.from(JSON.stringify(cache));
  const catalog = managedCodexCatalogFromCache(bytes, ["fixture-model"], null, "0.171.0");
  expect(Object.keys(catalog)).toEqual(["models"]);
  expect(JSON.stringify(catalog)).not.toContain(cache.identity);
  expect(JSON.stringify(catalog)).not.toContain(cache.etag);
  expect(() =>
    managedCodexCatalogFromCache(
      bytes,
      ["fixture-model"],
      createHash("sha256").update(bytes).digest("hex"),
      "0.171.0",
    ),
  ).toThrow(/model metadata/u);
  expect(() =>
    managedCodexCatalogFromCache(
      Buffer.from("{fixture-malformed"),
      ["fixture-model"],
      null,
      "0.171.0",
    ),
  ).toThrow(/model metadata/u);
});
