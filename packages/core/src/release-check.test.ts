// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  compareStableReleaseVersions,
  detectDockerInstall,
  detectInstallMethod,
  newestStableTag,
  type DetectFs,
} from "./release-check.js";

function fakeFs(files: Record<string, string>, real = "/repo/packages/cli/src/index.ts"): DetectFs {
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
        fakeFs({ "/repo/package.json": '{"name":"omnesis"}', "/repo/.git": "" }),
      ),
    ).toEqual({ method: "source", rootDir: "/repo" });

    expect(
      detectInstallMethod("entry", fakeFs({}, "/prefix/lib/node_modules/omnesis/dist/index.js")),
    ).toEqual({ method: "npm-global" });
  });

  test("Docker's installer marker outranks entry-script detection", () => {
    const fs = fakeFs({
      "/state/install-method": "docker\n",
      "/state/docker-compose.yml": "services: {}",
    });
    expect(detectDockerInstall("/state", fs)).toEqual({
      method: "docker",
      composeFile: "/state/docker-compose.yml",
      projectDir: "/state",
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
