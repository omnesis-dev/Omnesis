// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  linkSync,
  statSync,
  openSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  copyWindowsPrivateFileSync,
  inspectWindowsPrivatePathSync,
  secureWindowsPrivatePathSync,
} from "./windows-private-file.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.runIf(process.platform === "win32")(
  "copies bytes privately, replaces prior content, and preserves it after failed source validation",
  () => {
    const root = mkdtempSync(join(tmpdir(), "private-copy-"));
    roots.push(root);
    const privateDir = join(root, "private");
    mkdirSync(privateDir);
    secureWindowsPrivatePathSync(privateDir, "directory");
    const source = join(root, "invented [$&] 雪.db");
    const destination = join(privateDir, "backup.db");
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0xa7);
    writeFileSync(source, bytes);
    execFileSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
      [source, "/grant", "*S-1-1-0:(R)", "/Q"],
      { windowsHide: true },
    );
    expect(inspectWindowsPrivatePathSync(source, "file").private).toBe(false);
    copyWindowsPrivateFileSync(source, destination);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(inspectWindowsPrivatePathSync(destination, "file").private).toBe(true);
    writeFileSync(source, "new invented snapshot");
    copyWindowsPrivateFileSync(source, destination);
    expect(readFileSync(destination, "utf8")).toBe("new invented snapshot");
    expect(inspectWindowsPrivatePathSync(destination, "file").private).toBe(true);
    expect(() => copyWindowsPrivateFileSync(join(root, "missing.db"), destination)).toThrow();
    expect(() => copyWindowsPrivateFileSync(root, destination)).toThrow();
    expect(readFileSync(destination, "utf8")).toBe("new invented snapshot");
    expect(readdirSync(privateDir)).toEqual(["backup.db"]);
  },
  60_000,
);

test.runIf(process.platform === "win32")(
  "refuses a source directory junction and preserves the existing destination",
  () => {
    const root = mkdtempSync(join(tmpdir(), "private-copy-boundary-"));
    roots.push(root);
    const directory = join(root, "owned");
    mkdirSync(directory);
    secureWindowsPrivatePathSync(directory, "directory");
    writeFileSync(join(directory, "source.db"), "invented source");
    const destination = join(directory, "backup.db");
    writeFileSync(destination, "invented previous backup");
    symlinkSync(directory, join(root, "alias"), "junction");
    expect(() =>
      copyWindowsPrivateFileSync(join(root, "alias", "source.db"), destination),
    ).toThrow();
    expect(readFileSync(destination, "utf8")).toBe("invented previous backup");
    expect(readdirSync(directory).sort()).toEqual(["backup.db", "source.db"]);
  },
  60_000,
);

test.runIf(process.platform === "win32")(
  "refuses same-object case and hard-link aliases without changing the source",
  () => {
    const root = mkdtempSync(join(tmpdir(), "private-copy-alias-"));
    roots.push(root);
    secureWindowsPrivatePathSync(root, "directory");
    const source = join(root, "source.db");
    const alias = join(root, "alias.db");
    writeFileSync(source, "invented source bytes");
    linkSync(source, alias);
    const before = statSync(source, { bigint: true });
    for (const destination of [alias, source.toUpperCase()].filter(existsSync)) {
      expect(() => copyWindowsPrivateFileSync(source, destination)).toThrow();
      expect(readFileSync(source, "utf8")).toBe("invented source bytes");
      const after = statSync(source, { bigint: true });
      expect([after.dev, after.ino, after.ctimeNs]).toEqual([
        before.dev,
        before.ino,
        before.ctimeNs,
      ]);
    }
    expect(readdirSync(root).sort()).toEqual(["alias.db", "source.db"]);
  },
  60_000,
);

test.runIf(process.platform === "win32")(
  "copies a stable file while its writer handle remains open",
  () => {
    const root = mkdtempSync(join(tmpdir(), "private-copy-writer-"));
    roots.push(root);
    secureWindowsPrivatePathSync(root, "directory");
    const source = join(root, "source.db");
    const destination = join(root, "backup.db");
    writeFileSync(source, "invented committed snapshot");
    const writer = openSync(source, "r+");
    try {
      copyWindowsPrivateFileSync(source, destination);
      expect(readFileSync(destination, "utf8")).toBe("invented committed snapshot");
    } finally {
      closeSync(writer);
    }
  },
  60_000,
);
