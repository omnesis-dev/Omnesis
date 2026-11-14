// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, resolveSubprocessEntry } from "@omnesis/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EMBEDDING_DIM, purgeUsearchSidecars } from "./db.js";
import { UsearchWriteHandle } from "./usearch-index.js";
import { quarantineCorruptUsearch, USEARCH_NATIVE_STAGE_PREFIX } from "./usearch-boot-guard.js";

describe("quarantineCorruptUsearch", () => {
  const dirs: string[] = [];
  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), "usearch-guard-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function writeValidIndex(path: string): void {
    const h = new UsearchWriteHandle(path, EMBEDDING_DIM);
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = 1;
    h.add(1n, v);
    h.add(2n, v);
    h.save();
    h.close();
  }

  /** A stand-in validator: a Node script with the given source. */
  function fakeValidator(dir: string, source: string): { command: string; args: string[] } {
    const script = join(dir, "fake-validator.mjs");
    writeFileSync(script, source);
    return { command: process.execPath, args: [script] };
  }

  function stagedValidator(dir: string, body: string): { command: string; args: string[] } {
    return fakeValidator(
      dir,
      `
import {writeSync} from "node:fs";
const prefix=${JSON.stringify(USEARCH_NATIVE_STAGE_PREFIX)};
const begin=prefix+':'+process.argv[4]+':begin'+String.fromCharCode(10);
const complete=prefix+':'+process.argv[4]+':complete'+String.fromCharCode(10);
writeSync(1,begin);
${body}
`,
    );
  }

  function quarantinedCopies(dir: string): string[] {
    return readdirSync(dir)
      .filter((f) => f.includes(".corrupt-"))
      .sort();
  }

  test("absent file is a no-op", () => {
    const dir = tmpDir();
    expect(quarantineCorruptUsearch(join(dir, "nope.usearch"), EMBEDDING_DIM)).toBe("absent");
  });

  test("a valid sidecar is left in place", () => {
    const dir = tmpDir();
    const path = join(dir, "good.usearch");
    writeValidIndex(path);

    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("ok");
    expect(existsSync(path)).toBe(true);
  });

  test("a corrupt sidecar is quarantined without crashing the caller", () => {
    // These bytes declare enormous vector counts to the allocating loader.
    // The mapped validator must reject the impossible matrix span first,
    // allowing quarantine without an unbounded native allocation.
    const dir = tmpDir();
    const path = join(dir, "garbage.usearch");
    writeFileSync(path, Buffer.from("not a usearch index — random bytes ".repeat(64)));

    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("quarantined");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("garbage.usearch.corrupt-"))).toBe(true);
  });

  test("an oversized matrix declaration in a tiny file is quarantined", () => {
    const dir = tmpDir();
    const path = join(dir, "oversized.usearch");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0xffffffff, 0);
    header.writeUInt32LE(0xffffffff, 4);
    writeFileSync(path, header);

    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("quarantined");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("oversized.usearch.corrupt-"))).toBe(true);
  });

  test("a wrong-dimension sidecar is quarantined", () => {
    const dir = tmpDir();
    const path = join(dir, "wrongdim.usearch");
    const h = new UsearchWriteHandle(path, EMBEDDING_DIM);
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = 1;
    h.add(1n, v);
    h.save();
    h.close();

    // Validating at a different dimension than the file was written at fails.
    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM + 128)).toBe("quarantined");
    expect(existsSync(path)).toBe(false);
  });

  describe("telling corruption from a validator that could not run", () => {
    test("a validator that cannot load its modules leaves the file and logs why", () => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      writeValidIndex(path);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const validator = fakeValidator(dir, 'import "@omnesis/no-such-package";\n');

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe("inconclusive");
      expect(existsSync(path)).toBe(true);
      expect(quarantinedCopies(dir)).toEqual([]);
      expect(warn.mock.calls.flat().join("\n")).toContain("ERR_MODULE_NOT_FOUND");
    });

    test.each([1, 2, 3])("a plain exit %i is not a verdict on the file", (status) => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      writeFileSync(path, "contents the validator never looked at");

      const validator = fakeValidator(dir, `process.exit(${status});\n`);

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe("inconclusive");
      expect(existsSync(path)).toBe(true);
    });

    test("a native abort quarantines only when the OS reports a recognized crash signal", () => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      writeFileSync(path, "bytes that made the loader abort");

      const started = join(dir, "abort-entered");
      const validator = fakeValidator(
        dir,
        `import { writeFileSync } from "node:fs";writeFileSync(${JSON.stringify(started)}, "ready");process.abort();\n`,
      );
      if (process.platform === "win32") {
        // Record the actual CRT result without interpreting a numeric status
        // as proof that a native file open found corruption.
        const result = spawnSync(validator.command, validator.args, {
          timeout: 5_000,
          stdio: ["ignore", "ignore", "pipe"],
          encoding: "utf8",
        });
        expect(result.error).toBeUndefined();
        expect(existsSync(started)).toBe(true);
        expect(result.status).not.toBe(0);
        createLogger("gateway:usearch:boot-guard:test").info(
          `Native abort probe: status=${result.status} signal=${result.signal}`,
        );
        rmSync(started);
      }

      // An exit status alone cannot distinguish a native file rejection from
      // validator startup failure; Windows native recovery needs that proof.
      const expected = process.platform === "win32" ? "inconclusive" : "quarantined";
      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe(expected);
      expect(existsSync(started)).toBe(true);
      expect(existsSync(path)).toBe(process.platform === "win32");
    });

    test("a validator killed from outside leaves the file in place", () => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      writeFileSync(path, "contents the validator never finished reading");

      const validator = fakeValidator(dir, 'process.kill(process.pid, "SIGKILL");\n');

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe("inconclusive");
      expect(existsSync(path)).toBe(true);
    });

    test("the rejected file's reason reaches the log", () => {
      const dir = tmpDir();
      const path = join(dir, "wrongdim.usearch");
      writeValidIndex(path);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM + 128)).toBe("quarantined");
      expect(warn.mock.calls.flat().join("\n")).toContain(`expected ${EMBEDDING_DIM + 128}`);
    });
  });

  describe("trusted native-open control channel", () => {
    test.each([1, 2, 3, 17])(
      "unknown exit %i after native open refuses in-process access",
      (status) => {
        const dir = tmpDir(),
          path = join(dir, "index.usearch");
        writeFileSync(path, "unverified graph");
        expect(() =>
          quarantineCorruptUsearch(
            path,
            EMBEDDING_DIM,
            stagedValidator(dir, `process.exit(${status});`),
          ),
        ).toThrow("native validation did not complete");
        expect(existsSync(path)).toBe(true);
        expect(quarantinedCopies(dir)).toEqual([]);
      },
    );

    test("external cancellation during native validation preserves the file and refuses opening", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "unverified graph");
      expect(() =>
        quarantineCorruptUsearch(
          path,
          EMBEDDING_DIM,
          stagedValidator(dir, 'process.kill(process.pid,"SIGKILL");'),
        ),
      ).toThrow("native validation did not complete");
      expect(existsSync(path)).toBe(true);
    });

    test.each([0xc0000005, -1073741819, 0xc000001d, 0xc00000fd, 0xc0000374, 0xc0000409])(
      "a documented Windows native status %i requires an unfinished trusted stage",
      (status) => {
        const dir = tmpDir(),
          path = join(dir, "index.usearch");
        writeFileSync(path, "unverified graph");
        const validator = stagedValidator(dir, `process.exit(${status});`);
        if (process.platform === "win32") {
          expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe("quarantined");
          expect(existsSync(path)).toBe(false);
        } else {
          expect(() => quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toThrow(
            "native validation did not complete",
          );
          expect(existsSync(path)).toBe(true);
        }
      },
    );

    test.each(["wrong nonce", "truncated", "duplicate", "complete only", "noise"])(
      "%s control output cannot authorize file removal",
      (variant) => {
        const dir = tmpDir(),
          path = join(dir, "index.usearch");
        writeFileSync(path, "unverified graph");
        const output = {
          "wrong nonce":
            'writeSync(1,prefix+":"+process.argv[4].replace(/^./,c=>c==="0"?"1":"0")+":begin"+String.fromCharCode(10));',
          truncated: "writeSync(1,begin.slice(0,-1));",
          duplicate: "writeSync(1,begin+begin);",
          "complete only": "writeSync(1,complete);",
          noise: 'writeSync(1,begin+"unexpected output");',
        }[variant]!;
        const validator = fakeValidator(
          dir,
          `import {writeSync} from "node:fs";const prefix=${JSON.stringify(USEARCH_NATIVE_STAGE_PREFIX)};const begin=prefix+':'+process.argv[4]+':begin'+String.fromCharCode(10),complete=prefix+':'+process.argv[4]+':complete'+String.fromCharCode(10);${output}process.exit(3);`,
        );
        expect(() => quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toThrow(
          "Invalid usearch validation control response",
        );
        expect(existsSync(path)).toBe(true);
        expect(quarantinedCopies(dir)).toEqual([]);
      },
    );

    test("a marker in diagnostics cannot authorize native crash quarantine", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "unverified graph");
      const validator = fakeValidator(
        dir,
        `import {writeSync} from "node:fs";writeSync(2,${JSON.stringify(USEARCH_NATIVE_STAGE_PREFIX)}+':'+process.argv[4]+':begin'+String.fromCharCode(10));process.exit(3);`,
      );
      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe("inconclusive");
      expect(existsSync(path)).toBe(true);
      expect(quarantinedCopies(dir)).toEqual([]);
    });

    test("bounded output overflow cannot authorize an unverified native open", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "unverified graph");
      const validator = stagedValidator(
        dir,
        'writeSync(2,"x".repeat(70_000));setInterval(()=>{},1000);',
      );
      expect(() => quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toThrow(
        "refusing in-process open",
      );
      expect(existsSync(path)).toBe(true);
      expect(quarantinedCopies(dir)).toEqual([]);
    });

    test("success without native completion is not proof that opening is safe", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "unverified graph");
      expect(() =>
        quarantineCorruptUsearch(path, EMBEDDING_DIM, fakeValidator(dir, "process.exit(0);")),
      ).toThrow("Missing usearch validation completion");
      expect(existsSync(path)).toBe(true);
    });

    test("an exit after completed validation does not quarantine a validated graph", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "validated graph");
      const validator = stagedValidator(dir, "writeSync(1,complete);process.exit(3);");
      expect(() => quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toThrow(
        "failed after native completion",
      );
      expect(existsSync(path)).toBe(true);
      expect(quarantinedCopies(dir)).toEqual([]);
    });

    test("POSIX native destruction after completion retains native abort protection", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "graph whose native destructor aborted");
      const validator = stagedValidator(dir, "writeSync(1,complete);process.abort();");
      if (process.platform === "win32") {
        expect(() => quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toThrow(
          "failed after native completion",
        );
        expect(existsSync(path)).toBe(true);
      } else {
        expect(quarantineCorruptUsearch(path, EMBEDDING_DIM, validator)).toBe("quarantined");
        expect(existsSync(path)).toBe(false);
      }
    });

    test("failed quarantine refuses to open the unchanged corrupt sidecar", () => {
      const dir = tmpDir(),
        path = join(dir, "index.usearch");
      writeFileSync(path, "bad graph");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
      const collision = path + ".corrupt-20260301T120000";
      mkdirSync(collision);
      writeFileSync(join(collision, "owned"), "block rename");
      try {
        expect(() =>
          quarantineCorruptUsearch(path, EMBEDDING_DIM, fakeValidator(dir, "process.exit(65);")),
        ).toThrow("Cannot quarantine corrupt usearch sidecar");
        expect(existsSync(path)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test("the real validator reaches a verdict from outside the workspace, with npm unable to fetch", () => {
    const dir = tmpDir();
    const path = join(dir, "index.usearch");
    writeValidIndex(path);

    const entry = resolveSubprocessEntry("./usearch-validate-subprocess.ts", import.meta.url);
    const nonce = "00112233445566778899aabbccddeeff";
    const result = spawnSync(entry.command, [...entry.args, path, String(EMBEDDING_DIM), nonce], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: join(dir, "empty-npm-cache"),
        npm_config_offline: "true",
      },
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${USEARCH_NATIVE_STAGE_PREFIX}:${nonce}:begin\n${USEARCH_NATIVE_STAGE_PREFIX}:${nonce}:complete\n`,
    );
    expect(result.status).toBe(0);
  });

  describe("retention of quarantined copies", () => {
    test("a second quarantine leaves exactly one copy, the new one", () => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      const older = "index.usearch.corrupt-20200101T000000";
      writeFileSync(join(dir, older), "an earlier quarantined graph");
      writeFileSync(path, "not a usearch index".repeat(64));

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("quarantined");

      const copies = quarantinedCopies(dir);
      expect(copies).toHaveLength(1);
      expect(copies[0]).not.toBe(older);
    });

    test.each([
      ["validates", (path: string) => writeValidIndex(path), "ok"],
      ["is absent", () => {}, "absent"],
    ] as const)("a pile from earlier boots shrinks when the sidecar %s", (_name, arrange, want) => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      arrange(path);
      const newest = "index.usearch.corrupt-20260301T000000";
      for (const name of [
        "index.usearch.corrupt-20260101T000000",
        "index.usearch.corrupt-20260201T000000",
        newest,
      ]) {
        writeFileSync(join(dir, name), name);
      }

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe(want);
      expect(quarantinedCopies(dir)).toEqual([newest]);
    });

    test("a retired generation's copies go, unrelated files stay", () => {
      const dir = tmpDir();
      const path = join(dir, "index-5.usearch");
      writeValidIndex(path);
      const unrelated = ["omnesis.db.corrupt-20200101T000000", "index-4.usearch", "notes.txt"];
      for (const name of [...unrelated, "index-4.usearch.corrupt-20260101T000000"]) {
        writeFileSync(join(dir, name), name);
      }

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("ok");

      expect(existsSync(join(dir, "index-4.usearch.corrupt-20260101T000000"))).toBe(false);
      for (const name of unrelated) expect(existsSync(join(dir, name))).toBe(true);
    });

    test("secure storage's purge removes the copy this guard writes", () => {
      const dir = tmpDir();
      const path = join(dir, "index.usearch");
      writeFileSync(path, "not a usearch index".repeat(64));

      expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("quarantined");
      expect(quarantinedCopies(dir)).toHaveLength(1);

      expect(purgeUsearchSidecars(dir)).toBe(1);
      expect(quarantinedCopies(dir)).toEqual([]);
    });
  });
});
