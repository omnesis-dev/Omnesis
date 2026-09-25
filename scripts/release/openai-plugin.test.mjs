// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

describe("native OpenAI plugin package", () => {
  test("stays in product-version lockstep and exposes a structurally valid skill catalog", () => {
    const plugin = readJson("plugins/omnesis/.codex-plugin/plugin.json");
    const cli = readJson("packages/cli/package.json");
    expect(plugin.version).toBe(cli.version);
    expect(plugin).toMatchObject({
      skills: "./skills/",
      license: "AGPL-3.0-or-later",
    });
    expect(plugin).not.toHaveProperty("mcpServers");
    const skillRoot = join(repoRoot, "plugins/omnesis/skills");
    const skillDirectories = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(skillDirectories).toEqual([
      "connect-omnesis",
      "connect-omnesis-codex",
      "omnesis",
      "omnesis-direct",
    ]);
    const declaredNames = skillDirectories.map((directory) => {
      const source = readFileSync(join(skillRoot, directory, "SKILL.md"), "utf8");
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
      const name = frontmatter?.match(/^name:\s*([^\n]+)$/mu)?.[1]?.trim();
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      return name;
    });
    expect(new Set(declaredNames).size).toBe(declaredNames.length);
    expect(declaredNames.sort()).toEqual(skillDirectories);
  });

  test("publishes one skill package and leaves the user-specific remote connection to the host", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");
    expect(marketplace).toMatchObject({
      name: "omnesis-openai",
      interface: { displayName: "Omnesis" },
    });
    expect(marketplace.plugins).toEqual([
      {
        name: "omnesis",
        source: { source: "local", path: "./plugins/omnesis" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ]);
    const sourcePath = join(repoRoot, marketplace.plugins[0].source.path);
    expect(statSync(sourcePath).isDirectory()).toBe(true);
    expect(statSync(join(sourcePath, ".codex-plugin", "plugin.json")).isFile()).toBe(true);
  });

  test("contains no gateway credential or fixed operator gateway URL", () => {
    const manifest = readFileSync(
      join(repoRoot, "plugins/omnesis/.codex-plugin/plugin.json"),
      "utf8",
    );
    expect(manifest).not.toContain("OMNESIS_TOKEN");
    expect(manifest).not.toMatch(/omn_[A-Za-z0-9_-]+/u);
    expect(manifest).not.toMatch(/https?:\/\/[^\s"]+:7600/u);
  });
});
