// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
// npm runs these root hooks during the selective workspace install. Derive
// their standalone Node entrypoints, rather than mirroring a fixed hook list.
const hooks = [manifest.scripts.preinstall, manifest.scripts.postinstall].flatMap((command) =>
  [...command.matchAll(/(?:^|&&)\s*node\s+(scripts\/[^\s]+\.mjs)/gu)].map((match) => match[1]),
);
function assertContext(source, stage) {
  const body = source.split(new RegExp(`^FROM .+ AS ${stage}$`, "mu"))[1]?.split(/^FROM /mu)[0];
  expect(body, "actual selective install stage").toBeTypeOf("string");
  const copied = new Set();
  for (const match of body.matchAll(/^COPY (scripts\/[^\n]+)$/gmu)) {
    const paths = match[1].split(/\s+/u);
    const destination = paths.pop();
    for (const path of paths)
      if (destination === path || (destination.endsWith("/") && path.startsWith(destination)))
        copied.add(path);
  }
  for (const hook of hooks) {
    expect(copied.has(hook), `${stage} must stage root lifecycle input ${hook}`).toBe(true);
    execFileSync(process.execPath, ["--check", resolve(hook)], { stdio: "pipe" });
  }
}
test("selective Docker install contexts contain every standalone root lifecycle hook", () => {
  expect(hooks.length).toBeGreaterThanOrEqual(2);
  assertContext(dockerfile, "workspace-install");
  assertContext(dockerfile, "runtime-dependencies");
});
test.each(["workspace-install", "runtime-dependencies"])(
  "missing postinstall input is rejected in %s",
  (stage) => {
    const omitted = dockerfile.replaceAll(" scripts/native-vector-compat.mjs", "");
    expect(() => assertContext(omitted, stage)).toThrow("native-vector-compat.mjs");
  },
);
