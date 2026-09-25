// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const PACKAGE = resolve(SRC, "..");

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(SRC);
  return files.sort();
}

function importsOf(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const quoted = String.raw`["'\`]([^"'\`]+)["'\`]`;
  return [
    new RegExp(String.raw`(?:from|import)\s+${quoted}`, "g"),
    new RegExp(String.raw`\bimport\s*\(\s*${quoted}`, "g"),
    new RegExp(String.raw`\brequire\s*\(\s*${quoted}`, "g"),
  ].flatMap((pattern) => [...withoutComments.matchAll(pattern)].map((match) => match[1]!));
}

describe("relay package boundaries", () => {
  it("imports no Omnesis package except core", () => {
    const offenders = sourceFiles().flatMap((file) =>
      importsOf(readFileSync(file, "utf8"))
        .filter(
          (specifier) =>
            specifier.startsWith("@omnesis/") &&
            specifier !== "@omnesis/core" &&
            !specifier.startsWith("@omnesis/core/"),
        )
        .map((specifier) => `${relative(SRC, file)} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("contains no TLS server or certificate handling", () => {
    const offenders = sourceFiles().filter((file) => {
      const imports = importsOf(readFileSync(file, "utf8"));
      return imports.some((specifier) => ["node:https", "node:tls"].includes(specifier));
    });
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });

  it("declares core as its only Omnesis package dependency", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(
      Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@omnesis/")),
    ).toEqual(["@omnesis/core"]);
  });

  it("runs the image unprivileged on a non-privileged internal port", () => {
    const dockerfile = readFileSync(join(PACKAGE, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).not.toMatch(/EXPOSE\s+(?:80|443)\b/);
    expect(dockerfile).not.toMatch(/(?:\.p8|service-account\.json)/);
  });
});
