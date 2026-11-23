// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hostConfigIssues, nodePathProbe } from "@omnesis/source-sdk";
import definition from "./index.js";

describe("the Antigravity home setting", () => {
  let dir: string;
  const schema = definition.config!;
  const issues = (homePath: string) =>
    hostConfigIssues(schema, { antigravityHome: homePath }, nodePathProbe);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "antigravity-config-"));
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
    vi.stubEnv("OMNESIS_HOST_HOME", dir);
    mkdirSync(join(dir, ".gemini", "antigravity-cli"), { recursive: true });
    expect(issues("~/.gemini/antigravity-cli")).toEqual([]);
  });

  test("blank means the source picks the default locations", () => {
    expect(issues("")).toEqual([]);
    expect(hostConfigIssues(schema, {}, nodePathProbe)).toEqual([]);
  });

  test("whitespace is blank", () => {
    expect(issues("   ")).toEqual([]);
  });

  test("the operator is told what leaving it blank does", () => {
    expect(definition.params?.find((p) => p.name === "antigravityHome")?.help).toMatch(/blank/i);
  });

  test("the setting is member-scoped, because it names a directory on one machine", () => {
    expect(definition.params?.find((p) => p.name === "antigravityHome")?.scope).toBe("member");
  });
});
