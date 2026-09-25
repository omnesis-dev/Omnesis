// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderOmnesisDirectSkill } from "../../../../scripts/generate-omnesis-direct-skill.js";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

describe("native OpenAI Direct capability skill", () => {
  it("is generated from the canonical retrieval playbook", () => {
    expect(skill).toBe(renderOmnesisDirectSkill());
  });
});
