// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  quarantineCorruptUsearchAsync,
  USEARCH_FILE_REJECTED_EXIT_CODE,
} from "./usearch-boot-guard.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-async-graph-guard-"));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});
function validator(source: string) {
  const path = join(dir, "example-validator.mjs");
  writeFileSync(path, source);
  return { command: process.execPath, args: [path] };
}

describe("async graph validation", () => {
  it("shares the positive and corrupt classifications with the synchronous guard", async () => {
    const path = join(dir, "example.usearch");
    writeFileSync(path, "example index bytes");
    await expect(
      quarantineCorruptUsearchAsync(path, 3, undefined, validator("process.exit(0)")),
    ).resolves.toBe("ok");
    expect(existsSync(path)).toBe(true);
    await expect(
      quarantineCorruptUsearchAsync(
        path,
        3,
        undefined,
        validator(`process.exit(${USEARCH_FILE_REJECTED_EXIT_CODE})`),
      ),
    ).resolves.toBe("quarantined");
    expect(existsSync(path)).toBe(false);
  });

  it("does not quarantine a graph when the validator cannot run", async () => {
    const path = join(dir, "example.usearch");
    writeFileSync(path, "example index bytes");
    await expect(
      quarantineCorruptUsearchAsync(path, 3, undefined, {
        command: join(dir, "absent-program"),
        args: [],
      }),
    ).resolves.toBe("inconclusive");
    expect(existsSync(path)).toBe(true);
  });

  it("kills and reaps its validator on cancellation before rejecting, leaving graph data untouched", async () => {
    const path = join(dir, "example.usearch");
    const pidPath = join(dir, "validator.pid");
    writeFileSync(path, "example index bytes");
    const controller = new AbortController();
    const boot = quarantineCorruptUsearchAsync(
      path,
      3,
      controller.signal,
      validator(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `),
    );
    const assertion = expect(boot).rejects.toMatchObject({ name: "AbortError" });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const poll = (): void => {
          if (existsSync(pidPath)) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("Example validator did not start"));
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      });
      const pid = Number(readFileSync(pidPath, "utf8"));
      controller.abort();
      await assertion;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(path)).toBe(true);
    } finally {
      controller.abort();
      await boot.catch(() => {});
    }
  }, 15_000);
});
