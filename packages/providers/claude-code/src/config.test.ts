// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sessions-directory setting, declared rather than hand-written.
 *
 * The source used to carry a form field and a validator written out by hand,
 * each expanding a leading tilde before looking anything up. Both jobs are the
 * host's now, and these prove the move did not change what an operator can
 * type or what they are told when it is wrong.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hostConfigIssues, nodePathProbe, resolveDeclaredPaths } from "@omnesis/source-sdk";
import definition from "./index.js";

describe("the sessions-directory setting", () => {
  let dir: string;
  const schema = definition.config!;
  const issues = (value: string) =>
    hostConfigIssues(schema, { sessionsPath: value }, nodePathProbe);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-code-config-"));
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

  test("a home-relative path is accepted, and the source is handed it resolved", () => {
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".claude/projects"), { recursive: true });
    expect(issues("~/.claude/projects")).toEqual([]);

    const parsed = schema.parse({ sessionsPath: "~/.claude/projects" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const handed = resolveDeclaredPaths(
      schema,
      parsed.value as Record<string, unknown>,
      nodePathProbe,
    );
    expect(handed.sessionsPath).toBe(join(dir, ".claude/projects"));
  });

  test("blank and whitespace are the same gesture, and neither is an error", () => {
    // A hand-edited configuration file can hold a space where a form would
    // have held nothing. Refusing one and accepting the other would make the
    // source unavailable over a character nobody can see.
    expect(issues("")).toEqual([]);
    expect(issues("   ")).toEqual([]);
    expect(hostConfigIssues(schema, {}, nodePathProbe)).toEqual([]);
  });

  test("the operator is told what leaving it blank does", () => {
    // The label alone used to end in "(optional)", which said the field could
    // be skipped but not what skipping it meant.
    const param = definition.params?.find((p) => p.name === "sessionsPath");
    expect(param?.help).toMatch(/blank/i);
    expect(param?.label).toBe("Sessions directory");
  });

  test("the setting is member-scoped, because it names a directory on one machine", () => {
    expect(definition.params?.find((p) => p.name === "sessionsPath")?.scope).toBe("member");
  });
});
