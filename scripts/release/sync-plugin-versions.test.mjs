// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  PLUGIN_MANIFESTS,
  PRODUCT_VERSION_CONTRACTS,
  YAML_PLUGIN_MANIFESTS,
  syncPluginVersions,
} from "./sync-plugin-versions.mjs";

describe("syncPluginVersions", () => {
  test("copies the lockstep CLI version into every host plugin manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-plugin-versions-"));
    try {
      mkdirSync(join(root, "packages", "cli"), { recursive: true });
      writeFileSync(join(root, "packages", "cli", "package.json"), '{"version":"7.8.9"}\n');
      for (const relativePath of PLUGIN_MANIFESTS) {
        const path = join(root, relativePath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          '{\n  "name": "fixture",\n  "version": "0.0.1",\n  "scopes": ["write:web"],\n  "nested": { "version": "keep" }\n}\n',
        );
      }
      for (const relativePath of YAML_PLUGIN_MANIFESTS) {
        const path = join(root, relativePath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "name: fixture\nversion: 0.0.1\n");
      }
      for (const relativePath of PRODUCT_VERSION_CONTRACTS) {
        const path = join(root, relativePath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          '{\n  "client": "fixture",\n  "productVersion": "0.0.1",\n  "tokenScopes": ["write:web"]\n}\n',
        );
      }

      syncPluginVersions(root);

      for (const relativePath of PLUGIN_MANIFESTS) {
        // The bump edits only the top-level version: nested keys and the
        // file's existing formatting (the inline array) are untouched.
        expect(readFileSync(join(root, relativePath), "utf8")).toBe(
          '{\n  "name": "fixture",\n  "version": "7.8.9",\n  "scopes": ["write:web"],\n  "nested": { "version": "keep" }\n}\n',
        );
      }
      for (const relativePath of YAML_PLUGIN_MANIFESTS) {
        expect(readFileSync(join(root, relativePath), "utf8")).toContain("version: 7.8.9");
      }
      for (const relativePath of PRODUCT_VERSION_CONTRACTS) {
        expect(readFileSync(join(root, relativePath), "utf8")).toBe(
          '{\n  "client": "fixture",\n  "productVersion": "7.8.9",\n  "tokenScopes": ["write:web"]\n}\n',
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
