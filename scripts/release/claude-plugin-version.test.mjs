// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

describe("Claude plugin release", () => {
  test("stays in lockstep with the Omnesis product version", () => {
    const plugin = readJson("plugins/omnesis-claude/.claude-plugin/plugin.json");
    const cli = readJson("packages/cli/package.json");
    expect(plugin.version).toBe(cli.version);
  });

  test("provides one native HTTP MCP server for both grant capabilities", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const manifest = readJson("plugins/omnesis-claude/.claude-plugin/plugin.json");
    const mcp = readJson("plugins/omnesis-claude/.mcp.json");

    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "omnesis",
      source: "./plugins/omnesis-claude",
    });
    const pluginRoot = join(repoRoot, marketplace.plugins[0].source);
    expect(statSync(pluginRoot).isDirectory()).toBe(true);
    expect(statSync(join(pluginRoot, ".claude-plugin", "plugin.json")).isFile()).toBe(true);
    // The host loads `.mcp.json` and `skills/` from the plugin root by
    // default; naming them again in the manifest only loads them twice.
    expect(manifest.name).toBe("omnesis");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("skills");
    expect(statSync(join(pluginRoot, ".mcp.json")).isFile()).toBe(true);
    expect(statSync(join(pluginRoot, "skills")).isDirectory()).toBe(true);
    expect(manifest.userConfig).toEqual({
      omnesis_mcp_url: {
        type: "string",
        title: "MCP URL",
        description: expect.stringMatching(/HTTPS URL.*\/mcp/u),
        required: true,
      },
    });
    expect(mcp).toEqual({
      mcpServers: {
        omnesis: {
          type: "http",
          url: "${user_config.omnesis_mcp_url}",
        },
      },
    });
    const references = [
      ...JSON.stringify(mcp).matchAll(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/gu),
    ].map((match) => match[1]);
    const requiredConfig = Object.entries(manifest.userConfig)
      .filter(([, definition]) => definition.required === true)
      .map(([name]) => name);
    expect([...new Set(references)].sort()).toEqual(requiredConfig.sort());
    const configuredUrl = "https://gateway.example.org/mcp";
    const resolved = JSON.parse(
      JSON.stringify(mcp).replace("${user_config.omnesis_mcp_url}", configuredUrl),
    );
    expect(resolved.mcpServers).toEqual({
      omnesis: { type: "http", url: configuredUrl },
    });
  });
});
