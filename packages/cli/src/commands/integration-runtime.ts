// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Exact clean checkout represented by a locally packed integration plugin. */
export function integrationSourceCommit(packageRoot: string): string | undefined {
  try {
    const repository = execFileSync("git", ["-C", packageRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["-C", repository, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty) return undefined;
    const commit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export function publishManifestForLocalInstall(
  manifest: Record<string, unknown>,
  sourceCommit?: string,
): Record<string, unknown> {
  return {
    ...manifest,
    ...(sourceCommit ? { omnesisSourceCommit: sourceCommit } : {}),
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./openclaw": {
        types: "./dist/openclaw.d.ts",
        default: "./dist/openclaw.js",
      },
    },
    files: [
      "dist",
      "openclaw.plugin.json",
      "openclaw-entry.mjs",
      "hermes/__init__.py",
      "hermes/adapter.py",
      "hermes/plugin.yaml",
      "hermes/windows-files.mjs",
    ],
    devDependencies: undefined,
    scripts: undefined,
  };
}

/** Fresh canonical runtime shared by source archives and Windows Hermes deployment. */
export function prepareIntegrationPackageRuntime(sourceOverride: {
  packageRoot: string;
  entry: string;
}): { packageRoot: string; cleanup(): void } {
  const packageRoot = sourceOverride.packageRoot;
  const entry = sourceOverride.entry;
  if (!entry.endsWith(join("src", "index.ts"))) return { packageRoot, cleanup() {} };
  const sourceCommit = integrationSourceCommit(packageRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), "omnesis-integration-runtime-"));
  const packRoot = join(tempRoot, "package");
  try {
    mkdirSync(join(packRoot, "dist"), { recursive: true });
    const typescriptEntry = fileURLToPath(import.meta.resolve("typescript"));
    const tsc = join(dirname(typescriptEntry), "..", "bin", "tsc");
    const platformEntry = fileURLToPath(import.meta.resolve("@omnesis/platform"));
    const platformRoot = dirname(dirname(platformEntry));
    execFileSync(
      process.execPath,
      [
        tsc,
        "--project",
        join(platformRoot, "tsconfig.json"),
        "--outDir",
        join(packRoot, "dist", "private-platform"),
        "--composite",
        "false",
        "--declaration",
        "false",
        "--declarationMap",
        "false",
        "--sourceMap",
        "false",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync(
      process.execPath,
      [
        tsc,
        "--project",
        join(packageRoot, "tsconfig.json"),
        "--outDir",
        join(packRoot, "dist"),
        "--tsBuildInfoFile",
        join(tempRoot, "agent-integration.tsbuildinfo"),
        "--composite",
        "false",
        "--declaration",
        "--declarationMap",
        "false",
        "--sourceMap",
        "false",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    // Enumerated, not the whole `hermes` directory: the adapter's test suite
    // lives beside it and has no business on an operator's machine. The
    // published tarball's own asset list (`scripts/release/stage-packages.mjs`)
    // names the same runtime files.
    for (const asset of [
      "openclaw-entry.mjs",
      "openclaw.plugin.json",
      join("hermes", "__init__.py"),
      join("hermes", "adapter.py"),
      join("hermes", "plugin.yaml"),
      join("hermes", "windows-files.mjs"),
    ]) {
      const destination = join(packRoot, asset);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(packageRoot, asset), destination);
    }
    const sourceManifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const publishManifest = publishManifestForLocalInstall(sourceManifest, sourceCommit);
    delete publishManifest.devDependencies;
    delete publishManifest.scripts;
    writeFileSync(join(packRoot, "package.json"), JSON.stringify(publishManifest, null, 2) + "\n");
    return {
      packageRoot: packRoot,
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Materialize exactly the Python adapter and its optional Windows runtime assets. */
export function prepareHermesRuntimeAssets(
  sourceOverride: { packageRoot: string; entry: string },
  platform = process.platform,
): { files: { file: string; content: Buffer }[]; cleanup(): void } {
  const originalRoot = sourceOverride.packageRoot;
  const runtime =
    platform === "win32"
      ? prepareIntegrationPackageRuntime(sourceOverride)
      : { packageRoot: originalRoot, cleanup() {} };
  try {
    const files = ["__init__.py", "adapter.py", "plugin.yaml"].map((file) => ({
      file,
      content: readFileSync(join(runtime.packageRoot, "hermes", file)),
    }));
    if (platform === "win32") {
      files.push({
        file: "windows-files.mjs",
        content: readFileSync(join(runtime.packageRoot, "hermes", "windows-files.mjs")),
      });
      files.push({
        file: join("runtime", "package.json"),
        content: Buffer.from('{"type":"module"}\n'),
      });
      for (const file of ["windows-files.js", "refresh-lease.js", "request-budgets.js"]) {
        files.push({
          file: join("runtime", file),
          content: readFileSync(join(runtime.packageRoot, "dist", file)),
        });
      }
      const visit = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const source = join(directory, entry.name),
            file = join(prefix, entry.name);
          if (entry.isDirectory()) visit(source, file);
          else if (entry.isFile() && entry.name.endsWith(".js"))
            files.push({ file, content: readFileSync(source) });
        }
      };
      visit(
        join(runtime.packageRoot, "dist", "private-platform"),
        join("runtime", "private-platform"),
      );
    }
    return { files, cleanup: runtime.cleanup };
  } catch (error) {
    runtime.cleanup();
    throw error;
  }
}
