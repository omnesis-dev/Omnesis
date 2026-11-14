// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  compareStableReleaseVersions,
  detectDockerInstall,
  detectInstallMethod,
  newestStableTag,
  type DetectFs,
} from "./release-check.js";

const REPO = resolve("/fixture-repository");

function fakeFs(
  files: Record<string, string>,
  real = join(REPO, "packages", "cli", "src", "index.ts"),
): DetectFs {
  return {
    realpath: () => real,
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error("missing");
      return files[path]!;
    },
  };
}

describe("shared release-check primitives", () => {
  test("detects the source root and a global package from the same entry evidence", () => {
    expect(
      detectInstallMethod(
        "entry",
        fakeFs({ [join(REPO, "package.json")]: '{"name":"omnesis"}', [join(REPO, ".git")]: "" }),
      ),
    ).toEqual({ method: "source", rootDir: REPO });

    expect(
      detectInstallMethod(
        "entry",
        fakeFs({}, join(resolve("/prefix"), "lib", "node_modules", "omnesis", "dist", "index.js")),
      ),
    ).toEqual({ method: "npm-global" });
  });

  test("Docker's installer marker outranks entry-script detection", () => {
    const state = resolve("/fixture-state");
    const fs = fakeFs({
      [join(state, "install-method")]: "docker\n",
      [join(state, "docker-compose.yml")]: "services: {}",
    });
    expect(detectDockerInstall(state, fs)).toEqual({
      method: "docker",
      composeFile: join(state, "docker-compose.yml"),
      projectDir: state,
    });
  });

  test("only native separators identify an npm package directory", () => {
    const real = join(REPO, "lookalike\\node_modules\\omnesis\\dist\\index.js");
    expect(detectInstallMethod("entry", fakeFs({}, real))).toEqual({
      method: process.platform === "win32" ? "npm-global" : "unknown",
    });
  });

  test("orders arbitrarily large stable identifiers without numeric coercion", () => {
    expect(compareStableReleaseVersions("99999999999999999999.1.0", "9.999.999")).toBe(1);
    expect(compareStableReleaseVersions("1.2.3-beta.1", "1.2.3")).toBeNull();
    expect(
      newestStableTag("a refs/tags/v1.9.0\nb refs/tags/v2.0.0\nc refs/tags/v2.0.0-beta.1\n"),
    ).toBe("v2.0.0");
  });
});
