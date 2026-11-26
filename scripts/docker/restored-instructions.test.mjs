// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  markSecretFileEncryptionRequired,
  readSecretTextFileSync,
  writeSecretTextFile,
} from "@omnesis/core";

const run = promisify(execFile);
const expected = "Standing instructions at backup time.\n";

// This exercises the smoke's real checker against a local HTTP fixture, not a
// full Docker restore. Its child has the same missing bootstrap selectors as
// `compose exec`: only the config directory and port are exported.
test("restored-instructions checker loads passphrase selectors from .env and keeps strict checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-docker-prose-"));
  const options = { backend: "passphrase", configDir: dir };
  const passFile = join(dir, "keyring.pass");
  let server;
  try {
    await writeFile(passFile, "fictional fixture passphrase only\n", { mode: 0o600 });
    vi.stubEnv("OMNESIS_KEYRING_PASSPHRASE_FILE", passFile);
    vi.stubEnv("OMNESIS_KEYRING_PASSPHRASE", undefined);
    await ensureInstallRootKey(options);
    await markSecretFileEncryptionRequired(dir, options);
    await writeSecretTextFile(join(dir, "token"), "fictional-admin-token", options);
    await writeSecretTextFile(join(dir, "OMNESIS.md"), expected, options);
    await writeFile(
      join(dir, ".env"),
      `OMNESIS_SECRET_STORE=passphrase\nOMNESIS_KEYRING_PASSPHRASE_FILE=${passFile}\n`,
      { mode: 0o600 },
    );
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ]);
    let requests = 0;
    server = createServer(
      {
        key: await readFile(join(dir, "key.pem")),
        cert: await readFile(join(dir, "cert.pem")),
      },
      (request, response) => {
        requests++;
        if (
          request.url !== "/admin/instructions" ||
          request.headers.authorization !==
            `Bearer ${readSecretTextFileSync(join(dir, "token"), options)}`
        ) {
          response.writeHead(403).end();
          return;
        }
        const content = readSecretTextFileSync(join(dir, "OMNESIS.md"), options);
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            exists: true,
            problem: null,
            truncated: false,
            content,
          }),
        );
      },
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const script = await readFile(new URL("../docker-install-smoke.sh", import.meta.url), "utf8");
    const block = script.split("exec -T gateway node --input-type=module - <<'NODE'")[1];
    expect(block).toBeTypeOf("string");
    const start = block.indexOf('import assert from "node:assert/strict";');
    expect(start).toBeGreaterThanOrEqual(0);
    const checker = block.slice(start).split("\nNODE")[0];
    // The noninteractive verifier must not inherit conflicting reporter color
    // settings: tsx otherwise emits a Node warning even on successful reads.
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", "1");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("OMNESIS_")),
    );
    delete env.FORCE_COLOR;
    env.NO_COLOR = "1";
    env.OMNESIS_CONFIG_DIR = dir;
    env.OMNESIS_GATEWAY_PORT = String(server.address().port);
    const check = () =>
      run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", checker], {
        env,
        timeout: 15_000,
        maxBuffer: 128 * 1024,
      });
    await expect(check()).resolves.toMatchObject({ stdout: "", stderr: "" });
    expect(requests).toBe(1);

    await writeSecretTextFile(
      join(dir, "OMNESIS.md"),
      "Different fictional instructions.\n",
      options,
    );
    await expect(check()).rejects.toThrow("Standing instructions at backup time.");
    expect(requests).toBe(2);

    await writeFile(join(dir, "OMNESIS.md"), expected, { mode: 0o600 });
    await expect(check()).rejects.toThrow("restored instructions must be encrypted at rest");
    expect(requests).toBe(2);
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    clearSecretFileKeyCacheForTests();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
