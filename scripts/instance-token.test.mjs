// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { ensureInstallRootKey } from "../packages/core/src/secret-store.ts";
import { writeSecretTextFileSync } from "../packages/core/src/secret-file.ts";
import { readInstanceToken } from "./lib/instance-token.mjs";
import { bashExecutable, bashEnvironment, bashFixturePath } from "./lib/test-shell.mjs";

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
it.each(["relative", "absolute"])(
  "reads an encrypted fixture through the shared shell helper with a %s directory",
  async (kind) => {
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    const dir = fixture();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const token = "fictional-token+with/reserved=characters&scope=read#fragment";
    writeSecretTextFileSync(join(dir, "token"), token, { backend: "file", configDir: dir });
    expect(readFileSync(join(dir, "token"), "utf8")).not.toContain(token);
    expect(readInstanceToken(dir)).toBe(token);
    const helper = resolve("scripts/lib/test_instance");
    const result = spawnSync(
      bashExecutable(),
      [
        "-c",
        'source "$1"; read_instance_token "$2" "$3"',
        "fixture",
        bashFixturePath(helper),
        kind === "absolute" ? dir : relative(tmpdir(), dir),
        "https://example.com:43123",
      ],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: bashEnvironment({ ...process.env, OMNESIS_SECRET_STORE: "file" }),
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(new URL(result.stdout).searchParams.get("token")).toBe(token);
    expect(result.stdout).not.toContain("omnesis.secret-file");
  },
);
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

it.each(["encrypted", "legacy"])(
  "passes the decoded %s token through the real portal capture entrypoint without logging it",
  async (kind) => {
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    const dir = fixture();
    const token = "fictional-capture-token+reserved/characters=read&scope";
    if (kind === "encrypted") {
      await ensureInstallRootKey({ backend: "file", configDir: dir });
      writeSecretTextFileSync(join(dir, "token"), token, { backend: "file", configDir: dir });
    } else writeFileSync(join(dir, "token"), token + "\n");
    const stored = readFileSync(join(dir, "token"), "utf8").trim();
    mkdirSync(join(dir, "tls"));
    writeFileSync(join(dir, "tls", "cert.pem"), "invented-fixture-certificate");
    const received = join(dir, "received-token");
    const output = join(dir, "capture.png");
    const result = spawnSync(
      bashExecutable(),
      [
        "-c",
        `curl() {
  [[ "$*" == *"https://localhost:43123/health"* && "$*" == *"--cacert"* ]] || return 91
  printf '200'
}
npx() {
  [[ "$#" == 3 && "$1" == playwright && "$2" == install && "$3" == chromium ]] || return 92
  return 0
}
bash() { echo 'Unexpected service lifecycle invocation' >&2; return 93; }
node() {
  if [[ "$#" == 1 && "$1" == "$CAPTURE_BROWSER_ENTRY" ]]; then
    printf '%s' "$PORTAL_TOKEN" > "$CAPTURE_RECEIVED_TOKEN"
    printf 'invented capture bytes' > "$PORTAL_OUT"
  else
    "$CAPTURE_REAL_NODE" "$@"
  fi
}
export -f curl npx bash node
source "$1" "" --keep --out "$2"`,
        "fixture",
        bashFixturePath(resolve("scripts/shot-portal.sh")),
        bashFixturePath(output),
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        timeout: 15000,
        env: bashEnvironment(
          {
            ...process.env,
            OMNESIS_SHOT_CONFIG_DIR: dir,
            OMNESIS_SHOT_PORT: "43123",
            OMNESIS_SECRET_STORE: "file",
            CAPTURE_REAL_NODE: process.execPath,
            CAPTURE_BROWSER_ENTRY: resolve("scripts/shot-portal.mjs"),
            CAPTURE_RECEIVED_TOKEN: received,
          },
          {
            pathKeys: [
              "OMNESIS_SHOT_CONFIG_DIR",
              "CAPTURE_REAL_NODE",
              "CAPTURE_BROWSER_ENTRY",
              "CAPTURE_RECEIVED_TOKEN",
            ],
          },
        ),
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(received, "utf8")).toBe(token);
    expect(readFileSync(output, "utf8")).toBe("invented capture bytes");
    expect(result.stdout).toContain("Reusing the synthetic gateway");
    for (const value of [token, stored, "omnesis.secret-file"]) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
  },
);
