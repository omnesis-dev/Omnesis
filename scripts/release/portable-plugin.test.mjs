// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const PLUGIN = "plugins/omnesis";

// Top-level fields the closed agent-plugins.org 1.0 manifest schema allows.
const AGENT_PLUGIN_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

describe("portable Omnesis plugin", () => {
  const manifest = readJson(`${PLUGIN}/plugin.json`);

  test("is an agent-plugins.org 1.0 package in product-version lockstep", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("omnesis");
    expect(manifest.version).toBe(readJson("packages/cli/package.json").version);
    expect(manifest.license).toBe("AGPL-3.0-or-later");
    expect(Object.keys(manifest).filter((key) => !AGENT_PLUGIN_FIELDS.has(key))).toEqual([]);
    // A host-specific manifest beside this one would be read instead of it, or
    // merged into it, depending on the host.
    expect(existsSync(join(repoRoot, PLUGIN, ".codex-plugin"))).toBe(false);
    expect(existsSync(join(repoRoot, PLUGIN, ".claude-plugin"))).toBe(false);
  });

  test("declares no MCP server, because each user's gateway has its own address", () => {
    expect(existsSync(join(repoRoot, PLUGIN, "mcp.json"))).toBe(false);
    expect(existsSync(join(repoRoot, PLUGIN, ".mcp.json"))).toBe(false);
    const text = readFileSync(join(repoRoot, PLUGIN, "plugin.json"), "utf8");
    expect(text).not.toContain("OMNESIS_TOKEN");
    expect(text).not.toMatch(/omn_[A-Za-z0-9_-]+/u);
    expect(text).not.toMatch(/\/mcp\b/u);
    expect(text).not.toMatch(/https?:\/\/[^\s"]+:7600/u);
  });

  test("gives OpenAI hosts a complete listing within their limits", () => {
    const listing = manifest.extensions["com.openai"].interface;
    expect(listing).toMatchObject({
      displayName: "Omnesis",
      developerName: "Omnesis",
      category: "Productivity",
      websiteURL: "https://omnesis.dev",
      privacyPolicyURL: "https://omnesis.dev/privacy",
    });
    expect(listing.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of listing.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
    for (const asset of [listing.composerIcon, listing.logo]) {
      expect(asset).toMatch(/^\.\/assets\/.+\.png$/u);
      const bytes = readFileSync(join(repoRoot, PLUGIN, asset));
      expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    }
  });

  test("ships one skill per directory, each named after its directory", () => {
    const skillRoot = join(repoRoot, PLUGIN, "skills");
    const directories = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([
      "connect-omnesis-chatgpt",
      "connect-omnesis-codex",
      "omnesis",
      "omnesis-direct",
    ]);
    for (const directory of directories) {
      const source = readFileSync(join(skillRoot, directory, "SKILL.md"), "utf8");
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1] ?? "";
      expect(frontmatter.match(/^name:\s*([^\n]+)$/mu)?.[1]?.trim()).toBe(directory);
      const description = frontmatter.match(/^description:\s*([^\n]+)$/mu)?.[1] ?? "";
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
    }
  });

  test("is what every non-Claude marketplace in the repository lists", () => {
    const codex = readJson(".agents/plugins/marketplace.json");
    expect(codex).toMatchObject({ name: "omnesis", interface: { displayName: "Omnesis" } });
    expect(codex.plugins).toEqual([
      {
        name: "omnesis",
        source: { source: "local", path: `./${PLUGIN}` },
        policy: { installation: "AVAILABLE" },
      },
    ]);
    // Copilot CLI and VS Code read .github/plugin/ before .claude-plugin/, so
    // they load this plugin instead of the Claude plugin, whose MCP URL only
    // its own host can fill in.
    const github = readJson(".github/plugin/marketplace.json");
    expect(github.name).toBe("omnesis");
    expect(github.owner.name).toBeTruthy();
    expect(github.plugins.map((plugin) => [plugin.name, plugin.source])).toEqual([
      ["omnesis", `./${PLUGIN}`],
    ]);
    expect(statSync(join(repoRoot, PLUGIN, "plugin.json")).isFile()).toBe(true);
  });
});
