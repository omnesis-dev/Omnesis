// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { ensureInstallRootKey } from "../packages/core/src/secret-store.ts";
import { writeSecretTextFileSync } from "../packages/core/src/secret-file.ts";
import { readInstanceToken } from "./lib/instance-token.mjs";

const directories = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "instance-token-test-"));
  directories.push(dir);
  return dir;
}
it("reads an encrypted fixture through the shared shell helper from another directory", async () => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  const dir = fixture();
  await ensureInstallRootKey({ backend: "file", configDir: dir });
  const token = "fictional-token+with/reserved=characters&scope=read#fragment";
  writeSecretTextFileSync(join(dir, "token"), token, { backend: "file", configDir: dir });
  expect(readFileSync(join(dir, "token"), "utf8")).not.toContain(token);
  expect(readInstanceToken(dir)).toBe(token);
  const helper = resolve("scripts/lib/test_instance");
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; read_instance_token "$2" "$3"',
      "fixture",
      helper,
      relative(tmpdir(), dir),
      "https://example.com:43123",
    ],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, OMNESIS_SECRET_STORE: "file" },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(new URL(result.stdout).searchParams.get("token")).toBe(token);
  expect(result.stdout).not.toContain("omnesis.secret-file");
});
it("supports a legacy plaintext token and refuses missing or malformed secrets without leaking them", () => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  const dir = fixture();
  writeFileSync(join(dir, "token"), "fictional-legacy-token\n");
  expect(readInstanceToken(dir)).toBe("fictional-legacy-token");
  const malformed =
    '{"omnesis":"omnesis.secret-file","version":1,"ciphertext":"fictional-private-material"}';
  writeFileSync(join(dir, "token"), malformed);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/lib/instance-token.mjs", dir],
    { encoding: "utf8", env: { ...process.env, OMNESIS_SECRET_STORE: "file" } },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("fictional-private-material");
  expect(result.stderr).toContain("Cannot read the selected instance token");
  expect(() => readInstanceToken(fixture())).toThrow("Instance token is unavailable");
});
