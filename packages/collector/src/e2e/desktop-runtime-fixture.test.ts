// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createDesktopNodeAdapter } from "./desktop-node-adapter.js";
import { installDesktopAccountBridge } from "./desktop-account-bridge.js";
import { DesktopRuntimeFixture, desktopKeychainFixtureProgram } from "./desktop-runtime-fixture.js";
const execute = promisify(execFile);

test("generated OS-keyring fixture parses and models isolated services, atomic insertion and locked reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-desktop-keyring-script-"));
  try {
    await mkdir(join(root, "keychain"));
    const script = join(root, "security.cjs");
    await writeFile(script, desktopKeychainFixtureProgram(root), { mode: 0o700 });
    await execute(process.execPath, ["--check", script]);
    const command = (...args: string[]) => execute(process.execPath, [script, ...args]);
    await command(
      "add-generic-password",
      "-s",
      "fixture-service-a",
      "-a",
      "fixture-account",
      "-w",
      "fixture first value",
    );
    await command(
      "add-generic-password",
      "-s",
      "fixture-service-b",
      "-a",
      "fixture-account",
      "-w",
      "fixture second value",
    );
    expect(
      (await command("find-generic-password", "-s", "fixture-service-a", "-a", "fixture-account"))
        .stdout,
    ).toBe("fixture first value\n");
    expect(
      (await command("find-generic-password", "-s", "fixture-service-b", "-a", "fixture-account"))
        .stdout,
    ).toBe("fixture second value\n");
    await expect(
      command(
        "add-generic-password",
        "-s",
        "fixture-service-a",
        "-a",
        "fixture-account",
        "-w",
        "fixture forbidden overwrite",
      ),
    ).rejects.toMatchObject({ code: 45 });
    await writeFile(join(root, "keychain-locked"), "locked");
    await expect(
      command("find-generic-password", "-s", "fixture-service-a", "-a", "fixture-account"),
    ).rejects.toMatchObject({ code: 36 });
    expect((await command("-h")).stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source runtime adapter fixes system trust for unmodified executable-path descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-desktop-node-policy-"));
  try {
    const adapter = await createDesktopNodeAdapter(root);
    const { stdout } = await execute(adapter, [
      "--input-type=module",
      "-e",
      `
      import {execFileSync} from 'node:child_process';
      if (!process.execArgv.includes('--use-system-ca')) process.exit(2);
      process.stdout.write(execFileSync(process.execPath, ['-p', "JSON.stringify({system:process.execArgv.includes('--use-system-ca'),path:process.execPath})"], {encoding:'utf8'}));
    `,
    ]);
    expect(JSON.parse(stdout)).toEqual({ system: true, path: adapter });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the source bridge keeps an unclaimed profile empty and runs the real welcome protocol", async () => {
  const fixture = await DesktopRuntimeFixture.create({
    prepareInstall: false,
    systemTrustRuntime: true,
    relayUrl: "https://relay.example.test",
  });
  try {
    expect(await readdir(fixture.profile.configDir)).toEqual([]);
    await installDesktopAccountBridge(fixture, {});
    expect(await fixture.command("status")).toMatchObject({ phase: "welcome" });
    expect(await readdir(fixture.profile.configDir)).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 30_000);
