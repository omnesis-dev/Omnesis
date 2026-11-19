// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  quarantineCorruptUsearchAsync,
  USEARCH_FILE_REJECTED_EXIT_CODE,
  USEARCH_NATIVE_STAGE_PREFIX,
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

function nativeValidator(body: string) {
  return validator(`
    import { writeSync } from 'node:fs';
    const prefix = ${JSON.stringify(USEARCH_NATIVE_STAGE_PREFIX)};
    const begin = prefix + ':' + process.argv[4] + ':begin\\n';
    const complete = prefix + ':' + process.argv[4] + ':complete\\n';
    writeSync(1, begin);
    ${body}
  `);
}

describe("async graph validation", () => {
  it("shares the positive and corrupt classifications with the synchronous guard", async () => {
    const path = join(dir, "example.usearch");
    writeFileSync(path, "example index bytes");
    await expect(
      quarantineCorruptUsearchAsync(path, 3, undefined, nativeValidator("writeSync(1, complete);")),
    ).resolves.toBe("ok");
    expect(existsSync(path)).toBe(true);
    await expect(
      quarantineCorruptUsearchAsync(
        path,
        3,
        undefined,
        nativeValidator(`process.exit(${USEARCH_FILE_REJECTED_EXIT_CODE})`),
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

  it("refuses a native open without a trusted completion frame", async () => {
    const path = join(dir, "example.usearch");
    writeFileSync(path, "unverified graph bytes");
    await expect(
      quarantineCorruptUsearchAsync(path, 3, undefined, nativeValidator("process.exit(3);")),
    ).rejects.toThrow("native validation did not complete");
    expect(readFileSync(path, "utf8")).toBe("unverified graph bytes");
  });

  it.each(["wrong nonce", "duplicate", "truncated"])(
    "refuses %s control frames instead of quarantining",
    async (variant) => {
      const path = join(dir, "example.usearch");
      writeFileSync(path, "unverified graph bytes");
      const output = {
        "wrong nonce": `writeSync(1, prefix + ':wrong:begin\\n');`,
        duplicate: "writeSync(1, begin);",
        truncated: "writeSync(1, complete.slice(0, -1));",
      }[variant];
      await expect(
        quarantineCorruptUsearchAsync(
          path,
          3,
          undefined,
          nativeValidator(`${output} process.exit(65);`),
        ),
      ).rejects.toThrow("Invalid usearch validation control response");
      expect(existsSync(path)).toBe(true);
    },
  );

  it.each([1, 2])(
    "bounds stream %i and refuses truncated output before native access",
    async (stream) => {
      const path = join(dir, "example.usearch");
      writeFileSync(path, "unverified graph bytes");
      await expect(
        quarantineCorruptUsearchAsync(
          path,
          3,
          undefined,
          nativeValidator(`writeSync(${stream}, Buffer.alloc(70_000, 120)); process.exit(65);`),
        ),
      ).rejects.toThrow("Truncated usearch validation output");
      expect(existsSync(path)).toBe(true);
    },
  );

  it("keeps a resource-exhausted graph even when the validator aborts after native entry", async () => {
    const path = join(dir, "example.usearch");
    writeFileSync(path, "unverified graph bytes");
    await expect(
      quarantineCorruptUsearchAsync(
        path,
        3,
        undefined,
        nativeValidator(
          `writeSync(2, 'FATAL ERROR: Allocation failed - JavaScript heap out of memory\\n'); process.abort();`,
        ),
      ),
    ).rejects.toThrow("native validation did not complete");
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
