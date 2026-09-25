// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

describe("plugin skill", () => {
  it("teaches the MCP Answer boundary without shell access", () => {
    expect(skill).toMatch(/^---[\s\S]*?\nname:\s*omnesis\s*\n/);
    expect(skill).toContain("`ask_omnesis`");
    expect(skill).toContain("`get_answer_status`");
    expect(skill).not.toContain("allowed-tools: Bash");
    expect(skill).not.toContain("omnesis agent instructions");
  });

  it("explains every public Answer outcome", () => {
    for (const status of ["released", "released_with_reductions", "approval_required", "denied"]) {
      expect(skill).toContain(`\`${status}\``);
    }
  });

  it("keeps Answer and Direct as separate boundaries within one connection", () => {
    expect(skill).toMatch(/Direct retrieval tools may also be present/i);
    expect(skill).toMatch(/separate, raw-data boundary/i);
    expect(skill).toMatch(/Never use Direct tools/i);
    expect(skill).toMatch(/reconstruct or route around a held, reduced, or denied Answer result/i);
  });

  it("declares the interactive approval input", () => {
    expect(skill).toContain('`approval: "allow"`');
    expect(skill).toMatch(/wait for the user to explicitly confirm/i);
    expect(skill).toMatch(/Do not busy-poll/i);
  });
});
