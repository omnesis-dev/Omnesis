// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { checkRelayHealth, type RelayHealthCheckOptions } from "./health-check.js";

const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 60;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface RelayHealthCommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
  now(): number;
  fetchFn: NonNullable<RelayHealthCheckOptions["fetchFn"]>;
}

const processIo: RelayHealthCommandIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  now: Date.now,
  fetchFn: fetch,
};

export async function runRelayHealthCommand(
  argv: readonly string[],
  io: RelayHealthCommandIo = processIo,
): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 64;
  }

  const result = await checkRelayHealth({
    ...options,
    now: io.now,
    fetchFn: io.fetchFn,
  });
  const message = result.kind === "healthy" ? `OK: ${result.message}` : `ERROR: ${result.message}`;
  if (result.kind === "healthy") io.stdout(message);
  else io.stderr(message);
  return result.kind === "healthy" ? 0 : result.kind === "unhealthy" ? 1 : 2;
}

function parseArgs(argv: readonly string[]): {
  url: URL;
  maxSuccessAgeMs: number;
  maxClockSkewMs: number;
  timeoutMs: number;
} {
  let urlValue: string | undefined;
  let maxSuccessAgeSeconds: number | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let maxClockSkewSeconds = DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value\n\n${usage()}`);
      index += 1;
      return value;
    };
    if (arg === "--url") urlValue = next();
    else if (arg === "--max-success-age-seconds") {
      maxSuccessAgeSeconds = positiveNumber(next(), arg);
    } else if (arg === "--timeout-seconds") timeoutSeconds = positiveNumber(next(), arg);
    else if (arg === "--max-clock-skew-seconds") {
      maxClockSkewSeconds = nonnegativeNumber(next(), arg);
    } else throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!urlValue) throw new Error(`--url is required\n\n${usage()}`);
  if (maxSuccessAgeSeconds === undefined) {
    throw new Error(`--max-success-age-seconds is required\n\n${usage()}`);
  }
  return {
    url: safeRelayOrigin(urlValue),
    maxSuccessAgeMs: secondsToMilliseconds(maxSuccessAgeSeconds, "--max-success-age-seconds"),
    maxClockSkewMs: secondsToMilliseconds(maxClockSkewSeconds, "--max-clock-skew-seconds"),
    timeoutMs: timeoutMilliseconds(timeoutSeconds),
  };
}

function safeRelayOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--url must be a valid relay origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("--url must be an origin without credentials, path, query, or fragment");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--url must use HTTPS (HTTP is allowed only for loopback testing)");
  }
  return new URL(url.origin);
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function nonnegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function secondsToMilliseconds(value: number, name: string): number {
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds))
    throw new Error(`${name} is outside the supported range`);
  return milliseconds;
}

function timeoutMilliseconds(value: number): number {
  const milliseconds = secondsToMilliseconds(value, "--timeout-seconds");
  if (milliseconds > MAX_TIMEOUT_MS) {
    throw new Error("--timeout-seconds is outside the supported range");
  }
  return milliseconds;
}

function usage(): string {
  return [
    "Usage:",
    "  omnesis-relay check-health --url ORIGIN --max-success-age-seconds N",
    "    [--timeout-seconds N] [--max-clock-skew-seconds N]",
  ].join("\n");
}
