// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLogger,
  setLogLevel,
  setLogFile,
  setLogFormat,
  setLogRotation,
  LogLevel,
} from "./logger.js";

describe("createLogger", () => {
  test("creates a logger with all level methods", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  test("child logger creates a sub-component label", () => {
    const log = createLogger("parent");
    const child = log.child("child");
    // child should work without error
    child.info("test message");
  });
});

describe("log levels", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setLogLevel(LogLevel.INFO); // reset
  });

  test("suppresses debug when level is INFO", () => {
    setLogLevel(LogLevel.INFO);
    const log = createLogger("test");
    log.debug("should not appear");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("shows debug when level is DEBUG", () => {
    setLogLevel(LogLevel.DEBUG);
    const log = createLogger("test");
    log.debug("should appear");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test("shows info when level is INFO", () => {
    setLogLevel(LogLevel.INFO);
    const log = createLogger("test");
    log.info("should appear");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test("suppresses info when level is WARN", () => {
    setLogLevel(LogLevel.WARN);
    const log = createLogger("test");
    log.info("should not appear");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("file logging", () => {
  const testLogFile = "/tmp/omnesis-logger-test.log";

  beforeEach(() => {
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  });

  afterEach(() => {
    setLogFile(null);
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  });

  test("writes to file when log file is set", () => {
    setLogFile(testLogFile);
    setLogLevel(LogLevel.DEBUG);
    const log = createLogger("filetest");
    log.info("hello from file");
    log.debug("debug msg", { key: "value" });

    const content = readFileSync(testLogFile, "utf-8");
    expect(content).toContain("[filetest]");
    expect(content).toContain("hello from file");
    expect(content).toContain("debug msg");
    expect(content).toContain('"key":"value"');
    setLogLevel(LogLevel.INFO);
  });

  test("does not write to file when log file is null", () => {
    setLogFile(null);
    const log = createLogger("nofile");
    log.info("no file output");
    expect(existsSync(testLogFile)).toBe(false);
  });
});

describe("JSON log format (OMNESIS_LOG_FORMAT=json)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const testLogFile = "/tmp/omnesis-logger-json-test.log";

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLogFormat("json");
    setLogLevel(LogLevel.INFO);
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setLogFormat("text");
    setLogFile(null);
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  });

  test("emits one valid JSON object per line to stderr with the fixed fields", () => {
    const log = createLogger("jsontest");
    log.info("hello json");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0]![0] as string;
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written);
    expect(parsed).toMatchObject({ level: "info", component: "jsontest", message: "hello json" });
    expect(typeof parsed.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.timestamp))).toBe(false);
    // No structured data → no `data` key.
    expect("data" in parsed).toBe(false);
  });

  test("nests structured data under a `data` key (never collides with fixed fields)", () => {
    const log = createLogger("jsondata");
    // A datum keyed `message` must NOT overwrite the top-level message.
    log.info("watch out", { message: "inner", count: 3 });

    const written = stderrSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.message).toBe("watch out");
    expect(parsed.level).toBe("info");
    expect(parsed.data).toEqual({ message: "inner", count: 3 });
  });

  test("writes JSON lines to the log file too", () => {
    setLogFile(testLogFile);
    const log = createLogger("jsonfile");
    log.error("boom", { code: 500 });

    const content = readFileSync(testLogFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed).toMatchObject({
      level: "error",
      component: "jsonfile",
      message: "boom",
      data: { code: 500 },
    });
  });

  test("setLogFormat('text') restores the human-readable format", () => {
    setLogFormat("text");
    const log = createLogger("backtotext");
    log.info("plain line");
    const written = stderrSpy.mock.calls[0]![0] as string;
    expect(() => JSON.parse(written)).toThrow();
    expect(written).toContain("[backtotext]");
    expect(written).toContain("plain line");
  });
});

describe("structured data", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test("includes data in log output", () => {
    setLogLevel(LogLevel.INFO);
    const log = createLogger("data-test");
    log.info("test message", { count: 42, source: "gmail" });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("test message");
    expect(output).toContain("42");
    expect(output).toContain("gmail");
  });
});

describe("stream routing", () => {
  afterEach(() => {
    setLogLevel(LogLevel.INFO);
  });

  // No level may write to stdout; stdout stays clean for machine-readable
  // program output (e.g. the CLI's `--json` payloads). This is the contract
  // CLI consumers depend on (`omnesis … --json | jq`). (WARN/ERROR go to
  // console.warn/console.error, INFO/DEBUG straight to process.stderr — all
  // stderr; the invariant under test is simply "never stdout".)
  test("no level writes to stdout", () => {
    setLogLevel(LogLevel.DEBUG);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const log = createLogger("route-test");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // INFO/DEBUG used to go to console.log (stdout) — the bug. They now go
  // straight to stderr.
  test("info/debug write to process.stderr, not console.log", () => {
    setLogLevel(LogLevel.DEBUG);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const log = createLogger("route-test");
      log.info("i");
      log.debug("d");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("log level suppression", () => {
  test("setLogLevel(ERROR) suppresses warn-level messages", () => {
    setLogLevel(LogLevel.ERROR);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const log = createLogger("suppress-test");
      log.warn("should be suppressed");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      setLogLevel(LogLevel.INFO);
    }
  });
});

describe("child logger chaining", () => {
  test("child().child() produces nested component label", () => {
    setLogLevel(LogLevel.INFO);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const log = createLogger("parent");
      const grandchild = log.child("child").child("grandchild");
      grandchild.info("nested message");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("[parent:child:grandchild]");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("log rotation", () => {
  let dir: string;
  let logPath: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const log = createLogger("rotate-test");

  // Every message below is padded to a fixed byte width so the test can
  // reason in exact line sizes. The on-disk line is
  // `<iso ts> <LEVEL> [rotate-test] <message>\n` — measure one line and
  // derive counts from it rather than hardcoding the prefix width.
  function writeLine(): void {
    log.info("x".repeat(40));
  }

  function lineBytes(): number {
    setLogFile(logPath);
    writeLine();
    const n = statSync(logPath).size;
    unlinkSync(logPath);
    setLogFile(logPath); // re-stat: fresh empty state
    return n;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-logger-rotate-"));
    logPath = join(dir, "test.log");
    setLogLevel(LogLevel.INFO);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setLogFile(null);
    setLogRotation(); // back to env/default thresholds
    rmSync(dir, { recursive: true, force: true });
  });

  test("rotates when the next line would exceed maxBytes", () => {
    const n = lineBytes();
    setLogRotation({ maxBytes: n * 3, keep: 2 });
    writeLine();
    writeLine();
    writeLine(); // fills exactly to maxBytes — no rotation yet
    expect(existsSync(`${logPath}.1`)).toBe(false);
    writeLine(); // would exceed — rotates first
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(n * 3);
    expect(statSync(logPath).size).toBe(n);
  });

  test("keep-count is enforced — the oldest rotated file is deleted", () => {
    const n = lineBytes();
    setLogRotation({ maxBytes: n, keep: 2 });
    // Each line beyond the first triggers a rotation; 4 rotations total.
    for (let i = 0; i < 5; i++) writeLine();
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(false);
  });

  test("size cache survives many writes — rotation lands on the exact boundary", () => {
    const n = lineBytes();
    setLogRotation({ maxBytes: n * 50, keep: 1 });
    for (let i = 0; i < 50; i++) writeLine();
    expect(existsSync(`${logPath}.1`)).toBe(false);
    writeLine(); // line 51 crosses the boundary
    expect(statSync(`${logPath}.1`).size).toBe(n * 50);
    expect(statSync(logPath).size).toBe(n);
  });

  test("external truncation re-syncs the cache instead of rotating", () => {
    const n = lineBytes();
    setLogRotation({ maxBytes: n * 4, keep: 2 });
    writeLine();
    writeLine();
    writeLine();
    writeFileSync(logPath, ""); // truncated externally
    writeLine();
    writeLine(); // cache says over-threshold; re-stat sees a small file
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(statSync(logPath).size).toBe(n * 2);
  });

  test("external deletion is handled — file is recreated, no crash", () => {
    const n = lineBytes();
    setLogRotation({ maxBytes: n * 10, keep: 2 });
    writeLine();
    unlinkSync(logPath);
    writeLine();
    expect(statSync(logPath).size).toBe(n);
  });

  test("setLogFile resets the cached size to the target file's real size", () => {
    const n = lineBytes();
    setLogRotation({ maxBytes: n * 3, keep: 2 });
    writeLine();
    writeLine();
    const otherPath = join(dir, "other.log");
    setLogFile(otherPath);
    // The fresh file must not inherit the old file's cached size.
    writeLine();
    writeLine();
    writeLine();
    expect(existsSync(`${otherPath}.1`)).toBe(false);
    // Switching back re-stats the original file, so the next over-the-
    // threshold write rotates based on its true size.
    setLogFile(logPath);
    writeLine();
    writeLine();
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(n * 3);
  });
});

describe("setLogFile directory creation", () => {
  test("creates directory if it does not exist", () => {
    const nestedPath = `/tmp/omnesis-test-${Date.now()}/nested/dir/test.log`;
    setLogFile(nestedPath);
    setLogLevel(LogLevel.INFO);
    const log = createLogger("dir-test");
    // Suppress console output
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      log.info("directory creation test");
      const content = readFileSync(nestedPath, "utf-8");
      expect(content).toContain("directory creation test");
    } finally {
      stderrSpy.mockRestore();
      setLogFile(null);
      // Clean up
      try {
        unlinkSync(nestedPath);
      } catch {}
    }
  });
});
