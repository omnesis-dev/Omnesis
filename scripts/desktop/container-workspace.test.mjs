// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("container dependencies retain shared payloads but workspace imports resolve to the copied source", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-workspace-")));
  try {
    const root = join(scratch, "source"),
      dependencies = join(scratch, "dependencies");
    const workspace = join(root, "packages", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(dependencies, "fixture-dependency"), { recursive: true });
    mkdirSync(join(dependencies, "@omnesis"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "@omnesis/fixture" }));
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
        },
      },
    );
    expect(readlinkSync(join(root, "node_modules", "fixture-dependency"))).toBe(
      join(dependencies, "fixture-dependency"),
    );
    expect(readlinkSync(join(root, "node_modules", "@omnesis", "fixture"))).toBe(workspace);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the account container mount preserves Node's sibling package resolution", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-module-resolution-")));
  try {
    const producer = readFileSync(new URL("./test-account-container.mjs", import.meta.url), "utf8");
    const mount = /const mountedDependencies = "([^"]+)";/.exec(producer)?.[1];
    expect(mount).toBeTruthy();
    const dependencies = join(scratch, mount.slice(1));
    const root = join(scratch, "source");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
    for (const name of ["fixture-runner", "fixture-transformer"]) {
      const directory = join(dependencies, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
      );
      writeFileSync(
        join(directory, "index.mjs"),
        name === "fixture-runner"
          ? "export { marker } from 'fixture-transformer';"
          : "export const marker = 'owned-sibling-module';",
      );
    }
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
        },
      },
    );
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {marker} from 'fixture-runner'; process.stdout.write(marker);",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(output).toBe("owned-sibling-module");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
