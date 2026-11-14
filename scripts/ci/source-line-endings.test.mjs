// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a checkout with automatic CRLF conversion preserves canonical source, native batch files and binary bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "source-line-endings-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "--quiet");
    git("config", "core.autocrlf", "true");
    copyFileSync(new URL("../../.gitattributes", import.meta.url), join(root, ".gitattributes"));
    const source = "export const fictional = 1;\n";
    const batch = "@echo off\r\necho fictional\r\n";
    const binary = Buffer.from([0, 255, 10, 13, 0]);
    writeFileSync(join(root, "source.ts"), source);
    writeFileSync(join(root, "launch.bat"), batch);
    writeFileSync(join(root, "data.bin"), binary);
    git("add", ".");
    const checkout = join(root, "checked out");
    mkdirSync(checkout);
    git("checkout-index", "--all", "--force", `--prefix=${checkout.replaceAll("\\", "/")}/`);
    expect(readFileSync(join(checkout, "source.ts"), "utf8")).toBe(source);
    expect(readFileSync(join(checkout, "launch.bat"), "utf8")).toBe(batch);
    expect(readFileSync(join(checkout, "data.bin"))).toEqual(binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
