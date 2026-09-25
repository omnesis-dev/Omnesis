// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { CONFIG_KEY, PAIRING_KEY, TOKEN_KEY } from "./chrome/storage.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(root, "src", "chrome", entry)],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    platform: "browser",
    logLevel: "silent",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

/**
 * The content script runs inside every HTTPS page the user visits — the least
 * trusted context the extension has. It needs the pairing (which gateway, which
 * device) but never the bearer token, so the built content bundle must not even
 * name the storage key the token lives under. The worker, which does the
 * uploading, must.
 */
describe("bundle boundaries", () => {
  it("keeps the token key out of the content-script bundle", async () => {
    const content = await bundle("content.ts");
    expect(content).toContain(PAIRING_KEY);
    expect(content).not.toContain(TOKEN_KEY);
    // The legacy combined record holds the token too; only the worker migrates it.
    expect(content).not.toContain(CONFIG_KEY);
  }, 30_000);

  it("keeps the token in the worker bundle where uploads happen", async () => {
    const background = await bundle("background.ts");
    expect(background).toContain(TOKEN_KEY);
  }, 30_000);
});
