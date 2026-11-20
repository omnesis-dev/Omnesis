// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensurePrivateDirs, ensurePrivateFileSync } from "@omnesis/core";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);

test.each(["control", "data"])(
  "an occupied %s listener exits with a safe error code and no private path",
  async (listener) => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-relay-startup-"));
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    try {
      await ensurePrivateDirs([directory]);
      const keyFile = join(directory, "fictional-sensitive-session-key");
      await writeFile(keyFile, Buffer.alloc(32, 1), { mode: 0o600 });
      ensurePrivateFileSync(keyFile);
      const port = String((occupied.address() as AddressInfo).port);
      const result = await new Promise<{
        code: number | string | null | undefined;
        output: string;
      }>((resolve) => {
        execFile(
          process.execPath,
          [
            "--import",
            pathToFileURL(require.resolve("tsx")).href,
            fileURLToPath(new URL("./main.ts", import.meta.url)),
            "serve",
          ],
          {
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              OMNESIS_CLOUD_RELAY_BIND: "127.0.0.1",
              OMNESIS_CLOUD_RELAY_KEY_FILE: keyFile,
              OMNESIS_CLOUD_RELAY_DB: join(directory, "accounts.sqlite"),
              OMNESIS_CLOUD_RELAY_PORT: listener === "control" ? port : "0",
              OMNESIS_CLOUD_RELAY_DATA_PORT: listener === "data" ? port : "0",
            },
            timeout: 20_000,
            killSignal: "SIGKILL",
          },
          (error, stdout, stderr) => resolve({ code: error?.code, output: `${stdout}${stderr}` }),
        );
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        "Cloud relay command failed; check configuration and credentials (EADDRINUSE)",
      );
      expect(result.output).not.toContain(directory);
      expect(result.output).not.toContain(keyFile);
      expect(result.output).not.toContain(`127.0.0.1:${port}`);
      expect(result.output).not.toContain("Listening on");
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
