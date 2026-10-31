// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  dockerFolders,
  parseSharedFolders,
  shareFolderCommand,
  visibleInContainer,
  writeShareRequest,
} from "./docker-folders.js";
import { resolveOperatorPath } from "./operator-path.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docker-folders-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A config directory the installer marked as a Docker install's. */
function dockerInstall(services = "  gateway:\n  collector:\n"): string {
  const dir = join(root, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "install-method"), "docker\n");
  writeFileSync(join(dir, "docker-compose.yml"), `name: omnesis\nservices:\n${services}`);
  return dir;
}

describe("resolveOperatorPath", () => {
  test("reads ~ and a relative path against the host the launcher named", () => {
    const env = { OMNESIS_HOST_HOME: "/Users/maya", OMNESIS_HOST_CWD: "/Users/maya/Desktop" };
    expect(resolveOperatorPath("~", env)).toBe("/Users/maya");
    expect(resolveOperatorPath("  ~/Notes ", env)).toBe("/Users/maya/Notes");
    expect(resolveOperatorPath("../Notes", env)).toBe("/Users/maya/Notes");
    expect(resolveOperatorPath("/srv/notes", env)).toBe("/srv/notes");
  });
});

describe("dockerFolders", () => {
  test("is null outside a Docker install's container", () => {
    const dir = dockerInstall();
    expect(dockerFolders(dir, {})).toBeNull();
    expect(dockerFolders(join(root, "native"), { OMNESIS_HOST_HOME: "/Users/maya" })).toBeNull();
  });

  test("lists the shared folders and whether the launcher takes a request", () => {
    const dir = dockerInstall();
    writeFileSync(
      join(dir, "shared-folders"),
      "/Users/maya/Vault\n\nnot-absolute\n/Volumes/Mail\n",
    );
    expect(dockerFolders(dir, { OMNESIS_HOST_HOME: "/Users/maya" })).toEqual({
      projectDir: dir,
      shared: ["/Users/maya/Vault", "/Volumes/Mail"],
      canRequest: false,
    });
    expect(
      dockerFolders(dir, { OMNESIS_HOST_HOME: "/Users/maya", OMNESIS_DOCKER_SHARE_REQUEST: "1" })
        ?.canRequest,
    ).toBe(true);
  });

  test("a collector-only host's CLI finds its install one level up", () => {
    const dir = dockerInstall("  collector:\n");
    const found = dockerFolders(join(dir, "collector"), { OMNESIS_HOST_HOME: "/Users/maya" });
    expect(found?.projectDir).toBe(dir);
  });
});

describe("what the collector's container sees", () => {
  const folders = { projectDir: "/c/omnesis", shared: ["/Users/maya/Vault"], canRequest: false };
  test.each([
    ["/c/omnesis/imports/mail", true],
    ["/Users/maya/Vault", true],
    ["/Users/maya/Vault/Research", true],
    ["/Users/maya/Vault2", false],
    ["/Users/maya", false],
  ])("%s → %s", (path, visible) => {
    expect(visibleInContainer(path, folders)).toBe(visible);
  });

  test("parseSharedFolders drops what is not an absolute path", () => {
    expect(parseSharedFolders(" /a \nb\n\n/c\n")).toEqual(["/a", "/c"]);
  });
});

describe("writeShareRequest", () => {
  test("writes the folder and the resume command one word per line, owner-only", () => {
    const dir = dockerInstall();
    const folders = { projectDir: dir, shared: [], canRequest: true };
    const ok = writeShareRequest(folders, "/Users/maya/field-notes", [
      "sources",
      "add",
      "obsidian-notes",
      "/Users/maya/field-notes",
      "--device",
      "dev-1",
    ]);
    expect(ok).toBe(true);
    expect(readFileSync(join(dir, "share-request"), "utf8")).toBe(
      [
        "path=/Users/maya/field-notes",
        "arg=sources",
        "arg=add",
        "arg=obsidian-notes",
        "arg=/Users/maya/field-notes",
        "arg=--device",
        "arg=dev-1",
        "",
      ].join("\n"),
    );
  });

  test("refuses a word that cannot be one line", () => {
    const writes: string[] = [];
    const folders = { projectDir: root, shared: [], canRequest: true };
    expect(writeShareRequest(folders, "/Users/maya/a\nb", ["sources"], (f) => writes.push(f))).toBe(
      false,
    );
    expect(writeShareRequest(folders, "/ok", ["sources", "x\ny"], (f) => writes.push(f))).toBe(
      false,
    );
    expect(writes).toEqual([]);
  });

  test("shareFolderCommand quotes the path as one shell word", () => {
    expect(shareFolderCommand("/Users/maya/Jamie's Notes")).toBe(
      "omnesis folders share '/Users/maya/Jamie'\\''s Notes'",
    );
  });
});
