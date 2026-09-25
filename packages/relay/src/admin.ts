// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, statSync } from "node:fs";

import { digestSecret, RelayStore } from "./store.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const CREDENTIAL_PATTERN = /^omnrelay_v1_[A-Za-z0-9_-]{43}$/;
const DEFAULT_DB_PATH = "/var/lib/omnesis-relay/relay.db";

export interface RelayAdminIo {
  stdout(message: string): void;
  stderr(message: string): void;
  env: NodeJS.ProcessEnv;
  now(): number;
}

const processIo: RelayAdminIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  env: process.env,
  now: Date.now,
};

/** Offline operator commands. These open only SQLite and never load carrier configuration. */
export function runRelayAdminCommand(
  argv: readonly string[],
  io: RelayAdminIo = processIo,
): number {
  try {
    if (argv[0] !== "revoke") throw new UsageError(usage());
    const args = parseRevokeArgs(argv.slice(1), io.env);
    const digest = args.digest
      ? Buffer.from(args.digest, "hex")
      : digestSecret(readCredentialFile(args.secretFile!));
    if (!existsSync(args.dbPath) || !statSync(args.dbPath).isFile()) {
      throw new Error(`relay database does not exist: ${args.dbPath}`);
    }
    const store = new RelayStore(args.dbPath);
    try {
      const revoked = store.revokeCredential(digest, io.now());
      io.stdout(
        revoked ? "Revoked one relay credential." : "Credential was not active or not found.",
      );
      return revoked ? 0 : 1;
    } finally {
      store.close();
    }
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return err instanceof UsageError ? 64 : 1;
  }
}

function parseRevokeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { dbPath: string; secretFile?: string; digest?: string } {
  let dbPath = env.OMNESIS_RELAY_DB_PATH ?? DEFAULT_DB_PATH;
  let secretFile: string | undefined;
  let digest: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new UsageError(`${arg} requires a value\n\n${usage()}`);
      index += 1;
      return value;
    };
    if (arg === "--db") dbPath = next();
    else if (arg === "--secret-file") secretFile = next();
    else if (arg === "--digest") digest = next();
    else throw new UsageError(`unknown argument: ${arg}\n\n${usage()}`);
  }
  if ((secretFile ? 1 : 0) + (digest ? 1 : 0) !== 1) {
    throw new UsageError(`choose exactly one of --secret-file or --digest\n\n${usage()}`);
  }
  if (digest && !DIGEST_PATTERN.test(digest)) {
    throw new UsageError("--digest must be exactly 64 hexadecimal SHA-256 characters");
  }
  return {
    dbPath,
    ...(secretFile ? { secretFile } : {}),
    ...(digest ? { digest: digest.toLowerCase() } : {}),
  };
}

function readCredentialFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("credential secret path is not a regular file");
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("credential secret file must not be accessible by group or other users");
  }
  const credential = readFileSync(path, "utf8").trim();
  if (!CREDENTIAL_PATTERN.test(credential)) {
    throw new Error("credential secret file does not contain one valid relay credential");
  }
  return credential;
}

function usage(): string {
  return [
    "Usage:",
    "  omnesis-relay revoke [--db PATH] --secret-file PATH",
    "  omnesis-relay revoke [--db PATH] --digest SHA256_HEX",
  ].join("\n");
}

class UsageError extends Error {}
