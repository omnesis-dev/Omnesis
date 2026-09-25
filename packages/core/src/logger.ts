// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lightweight structured logger for Omnesis.
 *
 * Features:
 * - Log levels: DEBUG, INFO, WARN, ERROR
 * - Component labels (e.g. [gateway], [gmail])
 * - ISO timestamps
 * - Optional file output with size-based rotation
 * - Configurable via env vars:
 *   - OMNESIS_LOG_LEVEL: debug | info | warn | error (default: info)
 *   - OMNESIS_LOG_FILE: path to log file (optional; logs always go to stderr too)
 *   - OMNESIS_LOG_MAX_BYTES: rotate the log file when it would exceed this
 *     size (default: 10 MiB)
 *   - OMNESIS_LOG_KEEP: number of rotated files to keep as file.1 … file.N
 *     (default: 5; the oldest is deleted on each rotation)
 *   - OMNESIS_LOG_FORMAT: `text` (default, human-readable) or `json` (one
 *     JSON object per line, to both stderr and the log file, for ingestion
 *     by a log/monitoring pipeline)
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "\x1b[36m", // cyan
  [LogLevel.INFO]: "\x1b[32m", // green
  [LogLevel.WARN]: "\x1b[33m", // yellow
  [LogLevel.ERROR]: "\x1b[31m", // red
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value?.toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

/** Output format for log lines: human-readable text or one JSON object per line. */
export type LogFormat = "text" | "json";

function parseLogFormat(value: string | undefined): LogFormat {
  return value?.toLowerCase() === "json" ? "json" : "text";
}

let globalLevel = parseLogLevel(process.env.OMNESIS_LOG_LEVEL);
let logFormat: LogFormat = parseLogFormat(process.env.OMNESIS_LOG_FORMAT);
let logFilePath = process.env.OMNESIS_LOG_FILE ?? null;
// Logs are written to stderr (see writeLog), so colorize based on stderr's TTY.
const isTTY = process.stderr.isTTY ?? false;

// ── Size-based rotation (#50) ───────────────────────────────────────
// When appending a line would push the file past `maxBytes`, the file is
// shifted to `<file>.1` (existing `<file>.N` → `<file>.N+1`, the oldest
// — `<file>.keep` — dropped) and a fresh file starts. The running size is
// cached in memory (one stat at init / setLogFile / per rotation event)
// so steady-state logging never pays a stat() per line.

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_KEEP = 5;

interface LogRotation {
  maxBytes: number;
  keep: number;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function rotationFromEnv(): LogRotation {
  const maxBytes = parseNonNegativeInt(process.env.OMNESIS_LOG_MAX_BYTES);
  return {
    maxBytes: maxBytes && maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES,
    keep: parseNonNegativeInt(process.env.OMNESIS_LOG_KEEP) ?? DEFAULT_LOG_KEEP,
  };
}

let rotation = rotationFromEnv();

/** Cached byte size of the current log file; -1 means "unknown, stat lazily". */
let logFileSize = -1;

function statFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Override the rotation thresholds at runtime. Called with no argument
 * (or partial options), missing fields re-derive from the env vars.
 */
export function setLogRotation(opts?: { maxBytes?: number; keep?: number }) {
  const env = rotationFromEnv();
  rotation = {
    maxBytes: opts?.maxBytes ?? env.maxBytes,
    keep: opts?.keep ?? env.keep,
  };
}

/**
 * Shift rotated files up one slot and move the live file to `<path>.1`.
 * `<path>.(keep)` is overwritten by the rename of `<path>.(keep-1)`, so
 * at most `keep` rotated files ever exist. With `keep === 0` the live
 * file is simply deleted.
 */
function rotateLogFiles(path: string, keep: number): void {
  if (keep <= 0) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
    return;
  }
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    } catch {
      // slot empty — nothing to shift
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // live file vanished externally — nothing to rotate
  }
}

/**
 * Append one line to the log file, rotating first when the cached size
 * says the line would push the file past the threshold. The cache is
 * verified with a real stat at each rotation trigger (cheap — once per
 * ~maxBytes of output), which also re-syncs gracefully after external
 * truncation or deletion.
 */
function appendToLogFile(path: string, line: string): void {
  const lineBytes = Buffer.byteLength(line);
  if (logFileSize < 0) logFileSize = statFileSize(path);
  if (logFileSize > 0 && logFileSize + lineBytes > rotation.maxBytes) {
    const actual = statFileSize(path);
    if (actual > 0 && actual + lineBytes > rotation.maxBytes) {
      rotateLogFiles(path, rotation.keep);
      logFileSize = 0;
    } else {
      // The cache had drifted (file truncated/deleted externally) —
      // adopt the real size and keep appending.
      logFileSize = actual;
    }
  }
  try {
    appendFileSync(path, line);
    logFileSize += lineBytes;
  } catch {
    // The file's directory may have vanished — recreate and retry once.
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
    logFileSize = statFileSize(path);
  }
}

if (logFilePath) {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
  } catch {
    // directory may already exist
  }
  logFileSize = statFileSize(logFilePath);
}

/** Update the global log level at runtime */
export function setLogLevel(level: LogLevel) {
  globalLevel = level;
}

/** Update the global log output format at runtime (`text` or `json`). */
export function setLogFormat(format: LogFormat) {
  logFormat = format;
}

/** Update the log file path at runtime */
export function setLogFile(path: string | null) {
  logFilePath = path;
  logFileSize = -1;
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // directory may already exist
    }
    logFileSize = statFileSize(path);
  }
}

function formatForFile(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const levelStr = LEVEL_NAMES[level].padEnd(5);
  const dataStr = data ? " " + JSON.stringify(data) : "";
  return `${timestamp} ${levelStr} [${component}] ${message}${dataStr}\n`;
}

/**
 * One JSON object per line (`OMNESIS_LOG_FORMAT=json`), for ingestion by a
 * log/monitoring pipeline. The fixed fields are `timestamp` (ISO), `level`
 * (lowercase name), `component`, and `message`; any structured `data` is
 * nested under a `data` key so it can never collide with a fixed field. No
 * trailing newline — the caller adds one (matching `formatForConsole`).
 */
function formatAsJson(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: LEVEL_NAMES[level].toLowerCase(),
    component,
    message,
  };
  if (data) entry.data = data;
  return JSON.stringify(entry);
}

function formatForConsole(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const color = LEVEL_COLORS[level];
  const levelStr = LEVEL_NAMES[level].padEnd(5);

  if (isTTY) {
    const dataStr = data
      ? `\n  ${DIM}${JSON.stringify(data, null, 2).replace(/\n/g, "\n  ")}${RESET}`
      : "";
    return `${DIM}${timestamp}${RESET} ${color}${levelStr}${RESET} ${DIM}[${component}]${RESET} ${message}${dataStr}`;
  }

  // Non-TTY: no colors, single line
  const dataStr = data ? " " + JSON.stringify(data) : "";
  return `${timestamp} ${levelStr} [${component}] ${message}${dataStr}`;
}

function writeLog(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
) {
  if (level < globalLevel) return;

  // All levels are written to stderr. stdout is reserved for machine-readable
  // program output (e.g. the CLI's `--json` payloads and `--version`); mixing
  // diagnostic logs into stdout corrupts that output for anything that parses
  // it (`omnesis … --json | jq`, version checks, etc.). WARN/ERROR keep
  // console.warn/console.error (both target stderr); INFO/DEBUG — which used
  // to go to console.log (stdout) — are written straight to stderr.
  // In JSON mode both stderr and the file get the same single-line JSON
  // object (so journald / a log pipeline scraping stderr sees JSON too).
  const json = logFormat === "json";
  const consoleLine = json
    ? formatAsJson(level, component, message, data)
    : formatForConsole(level, component, message, data);
  if (level >= LogLevel.ERROR) {
    console.error(consoleLine);
  } else if (level >= LogLevel.WARN) {
    console.warn(consoleLine);
  } else {
    process.stderr.write(consoleLine + "\n");
  }

  // File output (with size-based rotation — see appendToLogFile)
  if (logFilePath) {
    const fileLine = json
      ? formatAsJson(level, component, message, data) + "\n"
      : formatForFile(level, component, message, data);
    try {
      appendToLogFile(logFilePath, fileLine);
    } catch {
      // Silently ignore file write errors to avoid log loops
    }
  }
}

/**
 * A Logger instance scoped to a specific component.
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /** Create a child logger with a sub-component label */
  child(subComponent: string): Logger;
}

/**
 * Create a logger for a specific component.
 *
 * @param component - Label for this logger (e.g. "gateway", "collector", "gmail")
 */
export function createLogger(component: string): Logger {
  return {
    debug: (message, data?) => writeLog(LogLevel.DEBUG, component, message, data),
    info: (message, data?) => writeLog(LogLevel.INFO, component, message, data),
    warn: (message, data?) => writeLog(LogLevel.WARN, component, message, data),
    error: (message, data?) => writeLog(LogLevel.ERROR, component, message, data),
    child: (subComponent) => createLogger(`${component}:${subComponent}`),
  };
}
