// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const openAiSkill = readFileSync(join(here, "SKILL.md"), "utf8");
const claudeSkill = readFileSync(
  join(here, "..", "..", "..", "omnesis-claude", "skills", "omnesis", "SKILL.md"),
  "utf8",
);

describe("native OpenAI answer skill", () => {
  it("stays semantically aligned with the Claude answer skill", () => {
    expect(openAiSkill.replace("ChatGPT or Codex", "Claude")).toBe(claudeSkill);
  });
});
