// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISTRUSTED_ROOT_SHA256,
  distrustCompromisedRoots,
  distrustingNodeOptions,
  isDistrustedRoot,
  PRELOAD_SOURCE,
  publicRoots,
} from "./tls-distrust.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const sha256 = (pem: string) =>
  new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();

/** The hex fingerprints a restatement carries, read from its source. */
const fingerprintsIn = (path: string) =>
  new Set(readFileSync(join(repoRoot, path), "utf8").match(/\b[0-9a-f]{64}\b/gu));

/**
 * The emSign roots themselves. Node 24.22.1 and 26.12.1 bundle none of them,
 * so a test that only reads the bundled store passes there whatever the
 * filter does; these keep every test meaningful on any Node.
 */
const EMSIGN_ROOTS_FILE = join(here, "testdata", "emsign-roots.pem");
const EMSIGN_ROOTS =
  readFileSync(EMSIGN_ROOTS_FILE, "utf8").match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
  ) ?? [];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-tls-distrust-test-"));
  scratch.push(dir);
  return dir;
};

/** A child Node process's distrusted default roots, after `NODE_OPTIONS`. */
const PRINT_DISTRUSTED_IN_DEFAULT_STORE = `
  const { X509Certificate } = require("node:crypto");
  const distrusted = new Set(${JSON.stringify([...DISTRUSTED_ROOT_SHA256])});
  const found = require("node:tls").getCACertificates("default")
    .map((pem) => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase())
    .filter((hash) => distrusted.has(hash));
  process.stdout.write(JSON.stringify(found));
`;

/** A `--require` that puts the emSign roots into the child's default store first. */
function seedEmSignRoots(): string {
  const seed = join(scratchDir(), "seed.cjs");
  writeFileSync(
    seed,
    `const tls = require("node:tls");
const pems = require("node:fs").readFileSync(${JSON.stringify(EMSIGN_ROOTS_FILE)}, "utf8")
  .match(/-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----/g);
tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...pems]);
`,
  );
  return `--require=${seed}`;
}

const distrustedInChild = (nodeOptions: string) =>
  JSON.parse(
    execFileSync(process.execPath, ["-e", PRINT_DISTRUSTED_IN_DEFAULT_STORE], {
      env: { PATH: process.env.PATH, NODE_OPTIONS: nodeOptions },
      encoding: "utf8",
    }),
  ) as string[];

/** The preload heredoc a script writes: the lines after `opening`, up to EOF. */
function scriptPreload(path: string, opening: string): string {
  const script = readFileSync(join(repoRoot, path), "utf8");
  const start = script.indexOf(`${opening}\n`);
  expect(start).toBeGreaterThan(0);
  const body = start + opening.length + 1;
  return script.slice(body, script.indexOf("\nEOF\n", body) + 1);
}

const INSTALLER_PRELOAD = "npm_trust_preload() {\n  cat <<'EOF'";
const HARDENED_PRELOAD = `  cat > "$BUILD_DIR/distrust-roots.mjs" <<'EOF'`;

describe("distrusted roots", () => {
  it("are the three emSign roots, matched from their PEM encoding", () => {
    expect(EMSIGN_ROOTS).toHaveLength(3);
    for (const pem of EMSIGN_ROOTS) {
      expect(new X509Certificate(pem).subject).toMatch(/CN=emSign (ECC )?Root CA - (G3|C1|C3)/u);
      expect(isDistrustedRoot(pem)).toBe(true);
    }
    expect(new Set(EMSIGN_ROOTS.map(sha256))).toEqual(new Set(DISTRUSTED_ROOT_SHA256));
  });

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

  it("are removed from a default store that holds them, and nothing else is", () => {
    const original = getCACertificates("default");
    try {
      setDefaultCACertificates([...original, ...EMSIGN_ROOTS]);
      distrustCompromisedRoots();
      // setDefaultCACertificates does not keep its input's order.
      expect(getCACertificates("default").map(sha256).sort()).toEqual(original.map(sha256).sort());
    } finally {
      setDefaultCACertificates(original);
    }
  });

  it("are left out of the public roots, and nothing else is", () => {
    const bundled = getCACertificates("bundled");
    const roots = publicRoots();
    expect(roots.some(isDistrustedRoot)).toBe(false);
    expect(roots).toEqual(bundled.filter((pem) => !DISTRUSTED_ROOT_SHA256.has(sha256(pem))));
  });

  it("are left out of public roots built from a set that holds them", () => {
    const bundled = getCACertificates("bundled");
    expect(publicRoots([...bundled, ...EMSIGN_ROOTS])).toEqual(publicRoots(bundled));
    expect(publicRoots(EMSIGN_ROOTS)).toEqual([]);
  });

  it("are dropped by the core barrel before any other module it loads", () => {
    const barrel = readFileSync(join(repoRoot, "packages/core/src/index.ts"), "utf8");
    const firstStatement = barrel.split("\n").find((line) => /^(?:import|export)\b/u.test(line));
    expect(firstStatement).toBe('import "./tls-distrust.js";');
  });

  it.each([
    "packages/agent-integration/src/trust.ts",
    "scripts/install.sh",
    "scripts/hardened-gateway.sh",
  ])("are restated exactly by %s", (path) => {
    expect(fingerprintsIn(path)).toEqual(new Set(DISTRUSTED_ROOT_SHA256));
  });

  it("leave the core barrel able to load on a Node without setDefaultCACertificates", () => {
    // Node before 24.5, which the published engines range admits: a hook
    // serves node:tls without the export, so a static import of it fails
    // to link exactly as it does there.
    const shim = join(scratchDir(), "old-node.mjs");
    writeFileSync(
      shim,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:tls" || specifier === "tls") return { url: "old-node:tls", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== "old-node:tls") return next(url, context);
    const names = Object.keys(process.getBuiltinModule("node:tls"))
      .filter((name) => name !== "setDefaultCACertificates");
    const source = [
      "const tls = { ...process.getBuiltinModule('node:tls') };",
      "delete tls.setDefaultCACertificates;",
      "export default tls;",
      ...names.map((name) => "export const " + name + " = tls." + name + ";"),
    ].join("\\n");
    return { format: "module", source, shortCircuit: true };
  },
});
`,
    );
    // The barrel, not this module alone: any module it loads that imports the
    // name stops every Omnesis process loading.
    const moduleUrl = pathToFileURL(join(here, "index.ts")).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        shim,
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(moduleUrl)});
process.stdout.write(String(m.publicRoots().some(m.isDistrustedRoot)));`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(output).toBe("false");
  });
});

describe("distrustingNodeOptions", () => {
  it("keeps the distrusted roots out of a child Node process", () => {
    const seed = seedEmSignRoots();
    // The control: without the preload the child trusts the roots it was given.
    expect(distrustedInChild(seed)).toHaveLength(3);
    expect(distrustedInChild(distrustingNodeOptions(seed))).toEqual([]);
  });

  it("appends to options the caller already set", () => {
    const options = distrustingNodeOptions("--max-old-space-size=4096");
    expect(options).toMatch(
      /^--max-old-space-size=4096 --import=file:\/\/\S+\/distrust-roots\.mjs$/u,
    );
    expect(distrustingNodeOptions(undefined)).toMatch(/--import=file:/u);
  });

  it("writes the preload again when a temp cleaner removed it", () => {
    const preloadOf = (options: string) =>
      fileURLToPath(/--import=(\S+)$/u.exec(options)?.[1] ?? "");
    const first = preloadOf(distrustingNodeOptions(""));
    rmSync(dirname(first), { recursive: true, force: true });
    const second = preloadOf(distrustingNodeOptions(""));
    expect(existsSync(second)).toBe(true);
    expect(
      distrustedInChild(`${seedEmSignRoots()} --import=${pathToFileURL(second).href}`),
    ).toEqual([]);
  });

  it("removes the preload when the process exits", () => {
    const moduleUrl = pathToFileURL(join(here, "tls-distrust.ts")).href;
    const preload = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(moduleUrl)});
process.stdout.write(/--import=(\\S+)$/.exec(m.distrustingNodeOptions(""))[1]);`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(preload).toMatch(/^file:.*\/distrust-roots\.mjs$/u);
    expect(existsSync(dirname(fileURLToPath(preload)))).toBe(false);
  });

  it.each([
    ["scripts/install.sh", INSTALLER_PRELOAD],
    ["website/install.sh", INSTALLER_PRELOAD],
    ["scripts/hardened-gateway.sh", HARDENED_PRELOAD],
    ["website/hardened-gateway.sh", HARDENED_PRELOAD],
  ])("is the preload %s writes, byte for byte", (path, opening) => {
    expect(scriptPreload(path, opening)).toBe(PRELOAD_SOURCE);
  });
});
