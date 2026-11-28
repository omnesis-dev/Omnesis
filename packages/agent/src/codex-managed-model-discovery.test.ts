// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  prepareManagedCodexModelCatalog,
  assertManagedCodexStaticCatalog,
  type ManagedCatalogPlatform,
} from "./codex-managed-model-discovery.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-model-discovery-")));
  const configDir = join(root, "library"),
    instance = "desktop-" + "a".repeat(16);
  const home = join(configDir, "codex-home", instance),
    state = join(root, "worker");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const model = {
    slug: "fixture-model",
    display_name: "Fixture model",
    description: null,
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: ["clock"],
    apply_patch_tool_type: "freeform",
    tool_mode: "code_mode_only",
    model_messages: { instructions_template: "Invented vendor instructions" },
    context_window: 123456,
  };
  const bytes = Buffer.from(
    JSON.stringify({
      client_version: "0.171.0",
      fetched_at: new Date().toISOString(),
      identity: "a".repeat(64),
      models: [model],
    }),
  );
  return {
    root,
    home,
    state,
    bytes,
    cache: join(home, "models_cache.json"),
    options: {
      scope: { configDir, instance, secretService: "dev.omnesis.desktop." + "a".repeat(64) },
      codexHome: home,
      stateHome: state,
      command: "/example/sdk",
      args: ["app-server"],
      version: "0.171.0",
      timeoutMs: 5000,
    },
  };
}

test("catalog publication and cache cleanup wait for physical discovery disposal", async () => {
  const f = await fixture();
  try {
    let disposed = false;
    const platform: ManagedCatalogPlatform = {
      invocation: (command, args) => ({ command, args: [...args] }),
      previousSha256: async () => {
        expect(disposed).toBe(true);
        return null;
      },
    };
    const descriptor = await prepareManagedCodexModelCatalog({
      ...f.options,
      platform,
      open: async () => ({
        request: async () => {
          await writeFile(f.cache, f.bytes, { mode: 0o600 });
          return { data: [{ model: "fixture-model" }] };
        },
        dispose: async () => {
          disposed = true;
        },
      }),
    });
    const value = JSON.parse(await readFile(descriptor.path, "utf8"));
    expect(value.models[0]).toMatchObject({
      slug: "fixture-model",
      tool_mode: "direct",
      apply_patch_tool_type: null,
      context_window: 123456,
    });
    expect(value.identity).toBeUndefined();
    const readback = {
      layers: [{ name: { type: "sessionFlags" }, config: { model_catalog_json: descriptor.path } }],
    };
    await expect(
      assertManagedCodexStaticCatalog(descriptor, readback, "fixture-model"),
    ).resolves.toBeUndefined();
    await expect(
      assertManagedCodexStaticCatalog(descriptor, readback, "missing-model"),
    ).rejects.toThrow(/model discovery/u);
    await expect(assertManagedCodexStaticCatalog(descriptor, { layers: [] })).rejects.toThrow(
      /model discovery/u,
    );
    await expect(assertManagedCodexStaticCatalog({ ...descriptor }, readback)).rejects.toThrow(
      /model discovery/u,
    );

    await expect(access(f.cache)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an unchanged cache is cleared only after disposal, then discovery is retried once", async () => {
  const f = await fixture();
  try {
    await writeFile(f.cache, f.bytes, { mode: 0o600 });
    let attempt = 0,
      disposed = 0;
    const previous = createHash("sha256").update(f.bytes).digest("hex");
    const platform: ManagedCatalogPlatform = {
      invocation: (command, args) => ({ command, args: [...args] }),
      previousSha256: async () => {
        expect(disposed).toBe(attempt);
        return attempt === 1 ? previous : null;
      },
    };
    const descriptor = await prepareManagedCodexModelCatalog({
      ...f.options,
      platform,
      open: async () => {
        attempt++;
        if (attempt === 2) await expect(access(f.cache)).rejects.toMatchObject({ code: "ENOENT" });
        return {
          request: async () => {
            if (attempt === 2) await writeFile(f.cache, f.bytes, { mode: 0o600 });
            return { data: [{ model: "fixture-model" }] };
          },
          dispose: async () => {
            disposed++;
          },
        };
      },
    });
    expect(attempt).toBe(2);
    expect(descriptor.slugs).toEqual(["fixture-model"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
