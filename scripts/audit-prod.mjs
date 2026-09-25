// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Production dependency audit gate (run as `npm run audit:prod`).
 *
 * `npm audit` has no native allowlist, so this wraps it: it fails CI on any
 * moderate-or-higher advisory in the production dependency tree EXCEPT the ones
 * explicitly reviewed and accepted below. Prefer fixing (a version bump or a
 * package.json `overrides` entry) over allowlisting; only add an entry when the
 * advisory genuinely does not apply to how Omnesis ships, and say why.
 */

import { execFileSync } from "node:child_process";

/**
 * Reviewed, accepted advisories keyed by GHSA id. Keep this list SHORT and each
 * entry justified — an unjustified allowlist is worse than a red build.
 */
const ALLOWLIST = {
  "GHSA-frvp-7c67-39w9":
    "@hono/node-server serve-static path traversal is Windows-only (an encoded " +
    "backslash, %5C, is only a path separator on Windows). Omnesis's gateway " +
    "runs on Linux/macOS only. The fix is @hono/node-server 2.x, which violates " +
    "@hono/node-ws@1.x's peer dependency (^1.19.11) and would break the gateway " +
    "WebSocket stack. Revisit when @hono/node-ws supports node-server 2.x.",
  "GHSA-r292-9mhp-454m":
    "node-tar's stack-overflow DoS needs a crafted archive with member " +
    "selection. Omnesis never imports the package — its own archive handling " +
    "does not use it, and the only `tar` in the source tree is a test shelling " +
    "out to the system binary. The production path is node-llama-cpp > " +
    "cmake-js, which extracts CMake and Node header archives from their " +
    "official release hosts while compiling the native addon at install time. " +
    "Nothing reads an untrusted archive through it at runtime. A patched 7.5.22 " +
    "exists; take it whenever cmake-js widens its range or the dependency tree " +
    "is next refreshed.",
};

const SEV_FAIL = new Set(["moderate", "high", "critical"]);

let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--audit-level=moderate", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // npm audit exits non-zero when advisories exist; the JSON report is still on stdout.
  raw = (err.stdout ?? "").toString();
  if (!raw) {
    console.error("npm audit produced no output:", err.message);
    process.exit(2);
  }
}

const report = JSON.parse(raw);
const seen = new Map(); // ghsa -> { pkg, severity, title }
for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== "object") continue;
    const ghsa = String(via.url ?? "")
      .split("/")
      .pop();
    if (!ghsa || !SEV_FAIL.has(via.severity)) continue;
    if (!seen.has(ghsa)) seen.set(ghsa, { pkg, severity: via.severity, title: via.title ?? "" });
  }
}

const accepted = [];
const unaccepted = [];
for (const [ghsa, info] of seen) (ALLOWLIST[ghsa] ? accepted : unaccepted).push({ ghsa, ...info });

for (const a of accepted) {
  console.log(`ACCEPTED ${a.ghsa} — ${a.pkg} (${a.severity}): ${ALLOWLIST[a.ghsa]}`);
}
if (unaccepted.length > 0) {
  console.error(`\n${unaccepted.length} unaccepted production advisory/ies (moderate+):`);
  for (const a of unaccepted) console.error(`  - ${a.ghsa}  ${a.pkg} (${a.severity}): ${a.title}`);
  console.error(
    "\nFix it (version bump or a package.json `overrides` entry). Only if the " +
      "advisory genuinely does not apply to how Omnesis ships, add it to the " +
      "ALLOWLIST in scripts/audit-prod.mjs with a reason.",
  );
  process.exit(1);
}
console.log(`\nProduction audit clean (${accepted.length} reviewed+accepted advisory/ies).`);
