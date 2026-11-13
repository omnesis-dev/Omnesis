// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function canonicalDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return join(canonicalDirectory(dirname(path)), basename(path));
  }
}

/** Resolve parent aliases, retaining the leaf entry that atomic rename actually replaces. */
function destination(path: string): string {
  const absolute = resolve(path);
  return join(canonicalDirectory(dirname(absolute)), basename(absolute));
}

/** Compare actual entries without folding case in case-sensitive directories. */
function sameEntry(left: string, right: string): boolean {
  try {
    const a = lstatSync(left, { bigint: true }),
      b = lstatSync(right, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (!missing(error)) throw error;
    return false;
  }
}

function sameTargetEntry(entry: string, path: string): boolean {
  try {
    const a = lstatSync(entry, { bigint: true }),
      b = statSync(path, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (!missing(error)) throw error;
    return false;
  }
}

/** Operator-only protection against replacing an identity, including aliases through parent directories. */
export function assertRecoveryArtifactDestination(
  output: string,
  protectedPaths: readonly (string | undefined)[],
): string {
  try {
    const target = destination(output);
    for (const path of protectedPaths) {
      if (path === undefined) continue;
      if (target === destination(path) || sameEntry(target, path) || sameTargetEntry(target, path))
        throw new Error();
      // Identity reads follow a leaf symlink; protect its real target as well as its configured entry.
      try {
        if (target === realpathSync(path)) throw new Error();
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return target;
  } catch {
    // Filesystem errors can contain private paths, so expose no nested cause.

    throw new Error("Recovery artifacts cannot replace protected identity files or signing keys");
  }
}

/** Default identity paths must be protected even when their explicit override is absent. */
export function recoveryArtifactPaths(
  env: NodeJS.ProcessEnv,
  protectRoutingKey: boolean,
  signingRole?: "policy" | "receipt",
): string[] {
  const fields = [
    "OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_SESSION_FILE",
    "OMNESIS_CLOUD_RELAY_DB",
    "OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE",
    "OMNESIS_CLOUD_RELAY_TLS_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_TLS_CERT_FILE",
    "OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE",
    "OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_ACME_JOURNAL",
    "OMNESIS_TLS_KEY",
    "OMNESIS_TLS_CERT",
    "OMNESIS_ACME_CERT_FILE",
    "OMNESIS_ACME_KEY_FILE",
    "OMNESIS_ACME_ACCOUNT_KEY_FILE",
    "OMNESIS_ACME_DNS_TOKEN_FILE",
    "OMNESIS_ACME_CA_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE",
    "OMNESIS_CLOUD_RELAY_CERTSPOTTER_API_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_DEVICE_FILE",
    "OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE",
    "OMNESIS_CLOUD_RELAY_ID_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE",
  ];
  if (signingRole !== "policy") fields.push("OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE");
  if (signingRole !== "receipt") fields.push("OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE");
  if (protectRoutingKey) fields.push("OMNESIS_CLOUD_RELAY_KEY_FILE");
  const paths = fields
    .map((field) => env[field])
    .filter((path): path is string => path !== undefined);
  if (env.OMNESIS_CLOUD_RELAY_DB !== undefined)
    paths.push(join(dirname(env.OMNESIS_CLOUD_RELAY_DB), "account-authority.pem"));
  const session = env.OMNESIS_CLOUD_RELAY_SESSION_FILE;
  if (session !== undefined) {
    paths.push(`${session}.owner-key`);
    if (signingRole !== "receipt") paths.push(`${session}.recovery.json`);
  }
  const cert = env.OMNESIS_ACME_CERT_FILE;
  if (cert !== undefined)
    paths.push(`${cert}.key`, `${cert}.acme-account`, `${cert}.acme-account.dns-journal`);
  const account = env.OMNESIS_ACME_ACCOUNT_KEY_FILE;
  if (account !== undefined) paths.push(`${account}.dns-journal`);
  const config = env.OMNESIS_CONFIG_DIR;
  if (config !== undefined)
    paths.push(
      join(config, "tls/key.pem"),
      join(config, "tls/cert.pem"),
      join(config, "cloud-relay/certificate-incidents.json"),
    );
  return paths;
}
