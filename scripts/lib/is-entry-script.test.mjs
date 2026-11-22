// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isEntryScript } from "./is-entry-script.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isEntryScript", () => {
  it("is false for a module that was imported rather than started", () => {
    expect(isEntryScript(import.meta.url)).toBe(false);
  });

  // A directory symlink, which Windows creates only with developer mode or
  // elevation; the comparison itself is the same on every platform.
  it.skipIf(process.platform === "win32")(
    "runs a script started through a symlinked directory",
    () => {
      const sandbox = mkdtempSync(join(tmpdir(), "omnesis-entry-script-"));
      sandboxes.push(sandbox);
      symlinkSync(join(root, "scripts"), join(sandbox, "scripts"));
      const result = spawnSync(
        process.execPath,
        [join(sandbox, "scripts", "install-e2e", "redact.mjs")],
        { input: "OMNESIS_TOKEN=secret-value next\n", encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("OMNESIS_TOKEN=*** next\n");
    },
  );
});

describe("entry-script checks under scripts/", () => {
  // Node gives `import.meta.url` the entry script's real path, so a check that
  // compares it with `process.argv[1]` without resolving symlinks skips the
  // script's main block, and the script exits 0 having done nothing, whenever it
  // is started through a symlinked path.
  it("compare real paths", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--", "scripts/*.mjs", "scripts/**/*.mjs", "scripts/*.ts", "scripts/**/*.ts"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => file && !/\.test\.(mjs|ts)$/.test(file));
    const blind = [];
    for (const file of files) {
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          const comparesPaths =
            /process\.argv\[1\]/.test(line) &&
            /import\.meta\.url|fileURLToPath|pathToFileURL|resolve\(/.test(line);
          if (comparesPaths && !/realpath/.test(line)) {
            blind.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(blind).toEqual([]);
  });
});
