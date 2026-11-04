// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const workflow = (name) => parse(readFileSync(join(root, ".github", "workflows", name), "utf8"));
const FREE = "./.github/actions/free-runner-disk";

// A hosted Ubuntu runner has too little free disk for the Omnesis images next
// to its stock toolchains: builds there have failed with "no space left on device".
describe("jobs that build the Omnesis images free the runner's disk first", () => {
  const jobs = [
    ["docker-smoke.yml", "install-and-update"],
    ["docker-smoke.yml", "compiled-runtime-smoke"],
    ["release.yml", "images"],
  ];
  for (const [file, job] of jobs) {
    test(`${file} ${job}`, () => {
      const steps = workflow(file).jobs[job].steps;
      const free = steps.findIndex((step) => step.uses === FREE);
      expect(free, "no free-runner-disk step").toBeGreaterThan(-1);
      // A local action needs the checkout before it.
      const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout).toBeGreaterThan(-1);
      expect(checkout).toBeLessThan(free);
    });
  }

  test("the action removes only toolchains, and reports the space", () => {
    const action = parse(
      readFileSync(join(root, ".github", "actions", "free-runner-disk", "action.yml"), "utf8"),
    );
    const run = action.runs.steps.map((step) => step.run).join("\n");
    expect(run).toMatch(/df -h \//);
    expect(run).toContain("sudo rm -rf /usr/share/dotnet");
    expect(run).not.toMatch(/docker (system|image) prune/);
  });
});
