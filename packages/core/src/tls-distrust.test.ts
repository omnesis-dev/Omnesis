// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DISTRUSTED_ROOT_SHA256,
  distrustingNodeOptions,
  isDistrustedRoot,
  publicRoots,
} from "./tls-distrust.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const sha256 = (pem: string) =>
  new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();

/** The hex fingerprints a restatement carries, read from its source. */
const fingerprintsIn = (path: string) =>
  new Set(readFileSync(join(repoRoot, path), "utf8").match(/\b[0-9a-f]{64}\b/gu));

const PRINT_DISTRUSTED_IN_DEFAULT_STORE = `
  const { X509Certificate } = require("node:crypto");
  const distrusted = new Set(${JSON.stringify([...DISTRUSTED_ROOT_SHA256])});
  const found = require("node:tls").getCACertificates("default")
    .map((pem) => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase())
    .filter((hash) => distrusted.has(hash));
  process.stdout.write(JSON.stringify(found));
`;

describe("distrusted roots", () => {
  it("are the emSign roots wherever Node still bundles them", () => {
    for (const pem of getCACertificates("bundled").filter(isDistrustedRoot)) {
      expect(new X509Certificate(pem).subject).toMatch(/CN=emSign (ECC )?Root CA - (G3|C1|C3)/u);
    }
  });

  it("are gone from this thread's default store once the module loads", () => {
    expect(
      getCACertificates("default")
        .map(sha256)
        .filter((h) => DISTRUSTED_ROOT_SHA256.has(h)),
    ).toEqual([]);
  });

  it("are left out of the public roots, and nothing else is", () => {
    const bundled = getCACertificates("bundled");
    const roots = publicRoots();
    expect(roots.some(isDistrustedRoot)).toBe(false);
    expect(roots).toEqual(bundled.filter((pem) => !DISTRUSTED_ROOT_SHA256.has(sha256(pem))));
  });

  it("are dropped by the core barrel before any other module it loads", () => {
    const barrel = readFileSync(join(repoRoot, "packages/core/src/index.ts"), "utf8");
    const firstStatement = barrel.split("\n").find((line) => /^(?:import|export)\b/u.test(line));
    expect(firstStatement).toBe('import "./tls-distrust.js";');
  });

  it.each(["packages/agent-integration/src/trust.ts", "scripts/install.sh"])(
    "are restated exactly by %s",
    (path) => {
      expect(fingerprintsIn(path)).toEqual(new Set(DISTRUSTED_ROOT_SHA256));
    },
  );
});

describe("distrustingNodeOptions", () => {
  it("keeps the distrusted roots out of a child Node process", () => {
    const run = (env: NodeJS.ProcessEnv) =>
      JSON.parse(
        execFileSync(process.execPath, ["-e", PRINT_DISTRUSTED_IN_DEFAULT_STORE], {
          env: { PATH: process.env.PATH, ...env },
          encoding: "utf8",
        }),
      ) as string[];
    // The control: without the preload the child trusts whatever Node bundles.
    const bundledDistrusted = getCACertificates("bundled").filter(isDistrustedRoot).length;
    expect(run({})).toHaveLength(bundledDistrusted);
    expect(run({ NODE_OPTIONS: distrustingNodeOptions("") })).toEqual([]);
  });

  it("appends to options the caller already set", () => {
    const options = distrustingNodeOptions("--max-old-space-size=4096");
    expect(options).toMatch(
      /^--max-old-space-size=4096 --import=file:\/\/\S+\/distrust-roots\.mjs$/u,
    );
    expect(distrustingNodeOptions(undefined)).toMatch(/--import=file:/u);
  });
});
