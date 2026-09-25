// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Codex keeps its sessions in a directory, and this declares that setting.
 *
 * The source used to carry a form field and a validator written out by hand,
 * both of which expanded a leading tilde before looking anything up. That
 * expansion is now the host's, and these tests exist to prove the move did not
 * change what an operator can type.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hostConfigIssues, nodePathProbe } from "@omnesis/source-sdk";
import definition from "./index.js";

describe("the Codex home setting", () => {
  let dir: string;
  const schema = definition.config!;
  const issues = (dbPath: string) => hostConfigIssues(schema, { codexHome: dbPath }, nodePathProbe);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-config-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a directory that exists is accepted", () => {
    expect(issues(dir)).toEqual([]);
  });

  test("a directory that does not exist is refused", () => {
    expect(issues(join(dir, "nowhere"))[0]?.message).toMatch(/does not exist/i);
  });

  test("a file where a directory belongs is refused", () => {
    const file = join(dir, "notadir");
    writeFileSync(file, "");
    expect(issues(file)[0]?.message).toMatch(/must be a folder/i);
  });

  test("a leading tilde resolves against the running user's home directory", () => {
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".codex"));
    expect(issues("~/.codex")).toEqual([]);
  });

  test("blank means the source picks the location, so nothing is checked", () => {
    // Nothing here can fail to be detected: the default is a fixed location,
    // and a missing one is an empty sync rather than a misconfiguration the
    // operator could fix at this field.
    expect(issues("")).toEqual([]);
    expect(hostConfigIssues(schema, {}, nodePathProbe)).toEqual([]);
  });

  test("whitespace is blank", () => {
    // A hand-edited configuration file can hold a space where a form would
    // have held nothing. Refusing one and accepting the other would make the
    // source unavailable over a character nobody can see.
    expect(issues("   ")).toEqual([]);
  });

  test("the operator is told what leaving it blank does", () => {
    // The label alone used to end in "(optional)", which said the field could
    // be skipped but not what skipping it meant.
    expect(definition.params?.find((p) => p.name === "codexHome")?.help).toMatch(/blank/i);
  });

  test("the setting is member-scoped, because it names a directory on one machine", () => {
    expect(definition.params?.find((p) => p.name === "codexHome")?.scope).toBe("member");
  });
});
