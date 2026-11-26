// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { resolveManagedCodexNativeCommand } from "./codex-managed-native-command.js";

const execute = promisify(execFile);
test("the pinned npm launcher resolves to its architecture-specific native executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-sdk-native-"));
  try {
    const require = createRequire(import.meta.url);
    const command = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
    const info = await resolveManagedCodexNativeCommand({
      source: "managed",
      command,
      packageName: "@openai/codex",
      packageVersion: "0.171.0",
    });
    expect(info.command).not.toBe(command);
    expect(info.command.endsWith("/bin/codex")).toBe(true);
    expect((await resolveManagedCodexNativeCommand(info)).command).toBe(info.command);
    const result = await execute(info.command, ["--version"], {
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
      timeout: 10000,
    });
    expect(result.stdout.trim()).toBe("codex-cli 0.171.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an arbitrary interpreter cannot replace the managed native executable", async () => {
  await expect(
    resolveManagedCodexNativeCommand({ source: "override", command: process.execPath }),
  ).rejects.toThrow(/pinned native Codex executable/u);
});
