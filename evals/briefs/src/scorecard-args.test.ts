// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { FROZEN_ARC_SEED } from "../../../packages/collector/src/e2e/briefs-arcs.js";
import { parseScorecardArgs } from "./scorecard-args.js";

describe("parseScorecardArgs", () => {
  test("defaults: scripted backend, perfect script, frozen seed", () => {
    expect(parseScorecardArgs([])).toEqual({
      backend: "scripted",
      script: "perfect",
      seed: FROZEN_ARC_SEED,
      iter: "-",
      out: "evals/briefs/scorecard.json",
      model: null,
    });
  });

  test("parses every flag", () => {
    expect(
      parseScorecardArgs([
        "--backend",
        "scripted",
        "--script",
        "saboteur",
        "--seed",
        "42",
        "--iter",
        "13",
        "--out",
        "custom.json",
      ]),
    ).toMatchObject({
      backend: "scripted",
      script: "saboteur",
      seed: 42,
      iter: "13",
      out: "custom.json",
    });
    expect(parseScorecardArgs(["--backend", "deepseek", "--model", "some-model"])).toMatchObject({
      backend: "deepseek",
      model: "some-model",
    });
  });

  test("rejects unknown flags, bad values, missing values, and --script on the deepseek lane", () => {
    expect(() => parseScorecardArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseScorecardArgs(["--backend", "local"])).toThrow(/scripted or deepseek/);
    expect(() => parseScorecardArgs(["--script", "chaotic"])).toThrow(/perfect or saboteur/);
    expect(() => parseScorecardArgs(["--seed", "many"])).toThrow(/integer/);
    expect(() => parseScorecardArgs(["--iter"])).toThrow(/requires a value/);
    expect(() => parseScorecardArgs(["--backend", "deepseek", "--script", "perfect"])).toThrow(
      /scripted-lane switch/,
    );
  });
});
