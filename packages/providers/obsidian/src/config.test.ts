// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The vault setting, declared rather than hand-written.
 *
 * These are migration tests before they are unit tests. The source used to
 * carry a form field and a validator function written out by hand, and now
 * carries one schema the host derives both from. What matters is that nothing
 * the operator could do before produces a different answer now — in
 * particular the check that separates a vault from any folder of Markdown,
 * which is the one a shape-only schema would have quietly dropped.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  formatConfigIssues,
  hostConfigIssues,
  memberScopedParamNames,
  nodePathProbe,
  toSourceParams,
  resolveDeclaredPaths,
} from "@omnesis/source-sdk";
import definition from "./index.js";

describe("the obsidian vault setting", () => {
  let dir: string;
  const schema = definition.config!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obsidian-config-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const issues = (params: Record<string, unknown>) => {
    const parsed = schema.parse(params);
    if (!parsed.ok) return formatConfigIssues(parsed.issues);
    const host = hostConfigIssues(schema, parsed.value as Record<string, unknown>, nodePathProbe);
    return host.length > 0 ? formatConfigIssues(host) : null;
  };

  test("a real vault is accepted", () => {
    mkdirSync(join(dir, ".obsidian"));
    expect(issues({ vaultPath: dir })).toBeNull();
  });

  test("a folder of Markdown that Obsidian has never opened is refused", () => {
    writeFileSync(join(dir, "note.md"), "# Note\n");
    expect(issues({ vaultPath: dir })).toMatch(/not an Obsidian vault/i);
  });

  test("a path that does not exist says so, rather than blaming the vault marker", () => {
    // An unmounted drive is not a vault problem, and telling the operator it
    // is sends them looking in the wrong place.
    expect(issues({ vaultPath: join(dir, "nowhere") })).toMatch(/does not exist/i);
  });

  test("a file where a folder belongs says so", () => {
    const file = join(dir, "vault.md");
    writeFileSync(file, "");
    expect(issues({ vaultPath: file })).toMatch(/must be a folder/i);
  });

  test("a folder holding a file named like the marker is not a vault", () => {
    writeFileSync(join(dir, ".obsidian"), "");
    expect(issues({ vaultPath: dir })).toMatch(/not an Obsidian vault/i);
  });

  test("the vault path is required, and says so before any filesystem is touched", () => {
    expect(issues({})).toMatch(/required/i);
  });

  test("the form asks for the vault and nothing else", () => {
    // The exclusion list is declared but advanced: an operator adding a vault
    // does not yet know which parts of it they want to leave out.
    expect(definition.params?.map((p) => p.name)).toEqual(["vaultPath"]);
  });

  test("the vault path belongs to the machine holding it; the exclusions are shared", () => {
    // A second machine hosting the same vault — synced there by iCloud or by
    // the editor's own sync — keeps it somewhere of its own, so a shared value
    // would hand that machine a path it cannot open. The exclusions are
    // vault-relative, so they describe the notes and stay shared.
    const declared = { params: definition.params, config: definition.config };
    const hostLocal = memberScopedParamNames(declared);
    expect(hostLocal).toEqual(["vaultPath"]);
    // Named explicitly, because "not in the member list" is also what a
    // renamed or deleted setting looks like: `exclude` is a real setting, it
    // is advanced, and the contract still resolves it as shared.
    expect(
      toSourceParams(definition.config!, nodePathProbe, { includeAdvanced: true }).map(
        (param) => param.name,
      ),
    ).toContain("exclude");
  });

  test("the vault field carries a validator a form can run while the operator types", () => {
    const validate = definition.params?.[0]?.validate;
    expect(validate).toBeTypeOf("function");
    mkdirSync(join(dir, ".obsidian"));
    expect(validate!(dir)).toBeNull();
    expect(validate!(join(dir, "nowhere"))).toMatch(/does not exist/i);
  });

  test("a home-relative path is accepted, and the source is handed it resolved", () => {
    // The failure this closes: the check expanded the tilde and the factory
    // did not, so a path the form accepted threw on the first sync.
    mkdirSync(join(dir, ".obsidian"));
    vi.stubEnv("HOME", dir);
    expect(issues({ vaultPath: "~" })).toBeNull();

    const parsed = schema.parse({ vaultPath: "~" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const handed = resolveDeclaredPaths(
      schema,
      parsed.value as Record<string, unknown>,
      nodePathProbe,
    );
    expect(handed.vaultPath).toBe(dir);
  });

  test("exclusions typed as one line per pattern parse into a list", () => {
    // Every channel that reaches a stored setting is text: a hand-edited
    // config file, a form post, a CLI prompt. A list that only accepted an
    // array would be declarable and unsettable.
    const parsed = schema.parse({ vaultPath: dir, exclude: "templates/**\narchive/**" });
    expect(parsed.ok && parsed.value.exclude).toEqual(["templates/**", "archive/**"]);
  });

  test("no exclusions means an empty list, not undefined", () => {
    const parsed = schema.parse({ vaultPath: dir });
    expect(parsed.ok && parsed.value.exclude).toEqual([]);
  });
});
