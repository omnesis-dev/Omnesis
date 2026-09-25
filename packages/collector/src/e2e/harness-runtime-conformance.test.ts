// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";

import { isolatedHarnessEnvironment } from "./harness-runtime-conformance.js";

const saved = {
  hermesBin: process.env.OMNESIS_HERMES_BIN,
  libraryPath: process.env.LD_LIBRARY_PATH,
  modelKey: process.env.OPENAI_API_KEY,
};

afterEach(() => {
  restore("OMNESIS_HERMES_BIN", saved.hermesBin);
  restore("LD_LIBRARY_PATH", saved.libraryPath);
  restore("OPENAI_API_KEY", saved.modelKey);
});

describe("isolatedHarnessEnvironment", () => {
  test("keeps the pinned Hermes interpreter's linker path without ambient model keys", () => {
    process.env.OMNESIS_HERMES_BIN = "/tmp/pinned-hermes/bin/hermes";
    process.env.LD_LIBRARY_PATH = "/tmp/pinned-python/lib";
    process.env.OPENAI_API_KEY = "must-not-cross-the-boundary";

    const environment = isolatedHarnessEnvironment({
      harness: "hermes",
      repositoryRoot: "/tmp/repository",
      home: "/tmp/hermes-home",
      osHome: "/tmp/os-home",
      tempDir: "/tmp/process-temp",
    });

    expect(environment.LD_LIBRARY_PATH).toBe("/tmp/pinned-python/lib");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });

  test("does not invent a linker path when the pinned runtime does not need one", () => {
    process.env.OMNESIS_HERMES_BIN = "/tmp/pinned-hermes/bin/hermes";
    delete process.env.LD_LIBRARY_PATH;

    const environment = isolatedHarnessEnvironment({
      harness: "hermes",
      repositoryRoot: "/tmp/repository",
      home: "/tmp/hermes-home",
      osHome: "/tmp/os-home",
      tempDir: "/tmp/process-temp",
    });

    expect(environment.LD_LIBRARY_PATH).toBeUndefined();
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
