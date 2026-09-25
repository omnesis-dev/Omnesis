#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The filter every diagnostic of the install/update lane passes through
 * before it reaches a public Actions log or artifact.
 *
 *   <command> 2>&1 | node scripts/install-e2e/redact.mjs
 *
 * It masks what a log line could carry that must not be published: bearer
 * and `omn_` tokens, pairing codes, keyring recovery codes, the tailnet's
 * addresses, and the tailnet's own DNS name (the node label before it stays,
 * since the lane names its nodes neutrally). Exact values the run knows are
 * secret — a pairing code read from the mailbox, say — are masked too: they
 * come one per line from the file named by `INSTALL_E2E_SECRETS_FILE`.
 *
 * The same values are also registered with `::add-mask::` by the steps that
 * learn them; this filter is the second net, for text the runner's masking
 * never sees (a file written by a daemon, an artifact).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RULES = [
  // Authorization headers and their JSON/env spellings.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
  [
    /("(?:token|accessToken|refreshToken|adminToken|deviceToken|pairingCode|code|recoveryCode)"\s*:\s*")[^"]*(")/g,
    "$1***$2",
  ],
  [/\b(OMNESIS_TOKEN|OMNESIS_ADMIN_TOKEN|TS_AUTHKEY|TS_OAUTH_SECRET)=\S+/g, "$1=***"],
  // Product tokens: omn_<kind>_<secret>.
  [/\bomn_[a-z0-9]+_[A-Za-z0-9_-]{8,}/g, "omn_***"],
  // Keyring recovery codes: base32 in dash-separated groups of four.
  [/\b[A-Z2-7]{4}(?:-[A-Z2-7]{1,4}){5,}\b/g, "<recovery-code>"],
  // Pairing codes: ten upper-case hex characters, alone. At least one letter,
  // so a ten-digit number (a Unix timestamp) survives; an all-digit code is
  // still masked through the exact values the run registers.
  [/(?<![0-9A-Za-z-])(?=[0-9]*[A-F])[0-9A-F]{10}(?![0-9A-Za-z-])/g, "<pairing-code>"],
  [/(--code(?:=|\s+))\S+/g, "$1<pairing-code>"],
  // The tailnet: its DNS suffix, IPv4 CGNAT range and IPv6 ULA prefix.
  [/\b([a-z0-9-]+)\.[a-z0-9-]+\.ts\.net\b/gi, "$1.<tailnet>.ts.net"],
  [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, "<tailnet-ip>"],
  [/\bfd7a:115c:a1e0(?::[0-9a-f]{0,4}){1,6}(?:\/\d+)?/gi, "<tailnet-ip6>"],
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a line redactor from the exact secret values this run knows. */
export function createRedactor(secrets = []) {
  const exact = secrets
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    // Longest first, so a value containing another is masked whole.
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(escapeRegExp(s), "g"));
  return (line) => {
    let out = line;
    for (const re of exact) out = out.replace(re, "***");
    for (const [re, replacement] of RULES) out = out.replace(re, replacement);
    return out;
  };
}

export function readSecretsFile(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n");
}

async function main() {
  const redact = createRedactor(readSecretsFile(process.env.INSTALL_E2E_SECRETS_FILE));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) process.stdout.write(redact(line) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`redact: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
