// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { buildNpmEnv } from "./codex-npm.js";

describe("buildNpmEnv", () => {
  it("retains case-insensitive Windows host variables and drops unrelated secrets", () => {
    const env = buildNpmEnv(
      {
        Path: "synthetic path",
        SYSTEMROOT: "synthetic root",
        Temp: "synthetic temp",
        https_proxy: "https://proxy.example.com",
        OPENAI_API_KEY: "must-not-leak",
        npm_config_registry: "https://registry.example.com",
      },
      "private home",
      "private cache",
      "win32",
    );
    expect(env).toMatchObject({
      PATH: "synthetic path",
      SystemRoot: "synthetic root",
      TEMP: "synthetic temp",
      HTTPS_PROXY: "https://proxy.example.com",
      HOME: "private home",
      USERPROFILE: "private home",
      npm_config_registry: "https://registry.npmjs.org/",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("https_proxy");
    expect(env).not.toHaveProperty("Path");
  });

  it("preserves case-sensitive POSIX proxy variables", () => {
    const env = buildNpmEnv(
      { HTTPS_PROXY: "upper", https_proxy: "lower" },
      "private home",
      "private cache",
      "linux",
    );
    expect(env.HTTPS_PROXY).toBe("upper");
    expect(env.https_proxy).toBe("lower");
  });
});
