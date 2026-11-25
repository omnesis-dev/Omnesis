// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { CODEX_RUNTIME_COMPAT } from "@omnesis/agent";
import { CodexRuntimeService } from "./codex-runtime-service.js";

const script = fileURLToPath(
  new URL("../../../agent/src/test-fixtures/fake-codex-app-server.mjs", import.meta.url),
);
const fixtures: Array<{ dir: string; service: CodexRuntimeService }> = [];
async function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omnesis-codex-managed-fixture-")));
  const service = new CodexRuntimeService({
    configDir: dir,
    command: process.execPath,
    args: [script, "app-server", "--listen", "stdio://"],
    versionArgs: [script, "--version"],
    cliArgsPrefix: [script],
    interactivePoolSize: 1,
    inferencePoolSize: 1,
    backgroundPoolSize: 1,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      OMNESIS_DESKTOP_MANAGED: "1",
      OMNESIS_FAKE_CODEX_VERSION: CODEX_RUNTIME_COMPAT.testedVersion,
      OMNESIS_SERVICE_INSTANCE: "desktop-0000000000000001",
      ...extraEnv,
    },
  });
  fixtures.push({ dir, service });
  return { dir, service };
}
afterEach(async () => {
  for (const { dir, service } of fixtures.splice(0)) {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

test("managed status uses login status instead of requiring a plaintext auth file", async () => {
  const { dir, service } = await fixture();
  expect(await service.refresh()).toMatchObject({ loggedIn: true, configured: true, status: "ok" });
  await expect(readFile(join(dir, "codex-home", "auth.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each(["codex-home", "codex-home-pool/inference/0"])(
  "legacy credential at %s refuses use without deleting or promoting it",
  async (relative) => {
    const { dir, service } = await fixture();
    const home = join(dir, relative);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), "invented earlier credential");
    expect(await service.refresh()).toMatchObject({
      loggedIn: false,
      status: "unreachable",
      reason: expect.stringMatching(/Sign out/i),
      runtime: { supported: true },
    });
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe("invented earlier credential");
  },
);

test("helper exit zero cannot mark login complete after writing plaintext credentials", async () => {
  const { service } = await fixture({ OMNESIS_FAKE_CODEX_LOGIN_AUTO_COMPLETE: "1" });
  await service.startDeviceLogin();
  await vi.waitFor(() =>
    expect(service.getLoginFlow()).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/Keychain/),
    }),
  );
});

test("weakened effective runtime policy blocks device login before any credential helper starts", async () => {
  const { service } = await fixture({ OMNESIS_FAKE_CODEX_SCENARIO: "managed-policy-refused" });
  await expect(service.startDeviceLogin()).rejects.toThrow(/strict Keychain/);
  expect(service.getLoginFlow()).toBeNull();
  expect(await service.refresh()).toMatchObject({
    loggedIn: false,
    status: "unreachable",
    reason: expect.stringMatching(/strict Keychain/),
  });
});

test("sign-out refuses a remaining scoped Keychain entry and only reports success after verified absence", async () => {
  const { dir, service } = await fixture();
  const accounts = [
    core.codexKeyringAccount(core.codexPaths(dir, "desktop-0000000000000001").home),
    core.codexKeyringAccount(core.codexPaths(dir).home),
  ];
  const absence = vi.spyOn(core, "confirmMacosKeychainEntriesAbsent").mockResolvedValue(false);
  await expect(service.logout()).rejects.toThrow(/remains in Keychain/);
  expect(absence).toHaveBeenCalledWith(accounts, {
    backend: "macos-keychain",
    service: core.CODEX_KEYRING_SERVICE,
  });
  absence.mockResolvedValue(true);
  expect(await service.logout()).toMatchObject({ ok: true, status: { loggedIn: false } });
});
