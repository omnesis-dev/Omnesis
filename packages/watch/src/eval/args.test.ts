// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The flags decide how much money a run may spend, so a mistyped one has to
 * stop it rather than change it.
 *
 * Both failures here are silent by nature. `Number("abc")` is `NaN`, and `NaN`
 * compares false against everything — so a ceiling that failed to parse passes
 * every spend check and a sample count that failed to parse quietly does no
 * work and reports a clean zero.
 */

import { describe, expect, it } from "vitest";

import { parseEvalArgs } from "./args.js";

describe("a flag that is not a number", () => {
  it.each(["--samples", "--concurrency", "--ceiling"])("stops the run: %s", (flag) => {
    expect(() => parseEvalArgs([flag, "abc"])).toThrow(/positive number/);
  });

  it("stops on zero and on a negative, which are as bad as NaN", () => {
    expect(() => parseEvalArgs(["--samples", "0"])).toThrow(/positive number/);
    expect(() => parseEvalArgs(["--ceiling", "-5"])).toThrow(/positive number/);
  });

  it("stops on Infinity, which no comparison would catch", () => {
    expect(() => parseEvalArgs(["--ceiling", "Infinity"])).toThrow(/positive number/);
  });

  it("names the flag and what it was given", () => {
    // The person reading this is at a terminal about to spend money.
    expect(() => parseEvalArgs(["--ceiling", "abc"])).toThrow(/--ceiling.*'abc'/);
  });
});

describe("a count that truncates to nothing", () => {
  it("stops, because it is the same silent nothing as NaN", () => {
    // `Array.from({ length: 1e-9 })` has length zero: the sweep builds no work,
    // does nothing, and prints a clean 0/0. NaN was blocked and this was not.
    expect(() => parseEvalArgs(["--samples", "1e-9"])).toThrow(/whole number/);
    expect(() => parseEvalArgs(["--samples", "1.5"])).toThrow(/whole number/);
    expect(() => parseEvalArgs(["--concurrency", "0.4"])).toThrow(/whole number/);
  });

  it("still allows a fractional ceiling, which is money and not a count", () => {
    expect(parseEvalArgs(["--ceiling", "2.5"]).ceiling).toBe(2.5);
  });
});

describe("a value that is really the next flag", () => {
  it("stops rather than swallowing it", () => {
    // `--out --set` would write the report to a file called `--set`.
    expect(() => parseEvalArgs(["--out", "--set"])).toThrow(/got the flag/);
    expect(() => parseEvalArgs(["--only", "--samples"])).toThrow(/got the flag/);
  });

  it("still takes a value that merely looks unusual", () => {
    expect(parseEvalArgs(["--out", "-report.md"]).out).toBe("-report.md");
  });
});

describe("a flag that is not a choice", () => {
  it("stops rather than falling back", () => {
    expect(() => parseEvalArgs(["--set", "everything"])).toThrow(/must be one of/);
  });

  it("takes the ones it offers", () => {
    expect(parseEvalArgs(["--set", "paired"]).set).toBe("paired");
    expect(parseEvalArgs(["--set", "unseen"]).set).toBe("unseen");
  });
});

describe("the flags themselves", () => {
  it("defaults to a sweep with a ceiling", () => {
    const args = parseEvalArgs([]);
    expect(args.samples).toBeGreaterThan(1);
    expect(args.ceiling).toBeGreaterThan(0);
    expect(args.set).toBe("both");
  });

  it("reads what it is given", () => {
    const args = parseEvalArgs(["--samples", "3", "--ceiling", "2.5", "--only", "a-watch"]);
    expect(args).toMatchObject({ samples: 3, ceiling: 2.5, only: "a-watch" });
  });

  it("stops on a flag it does not know rather than ignoring it", () => {
    // A typo that is silently dropped is a run that did something other than
    // what was asked, and looked fine doing it.
    expect(() => parseEvalArgs(["--sampels", "5"])).toThrow(/unknown flag/);
  });

  it("stops on a flag with no value", () => {
    expect(() => parseEvalArgs(["--samples"])).toThrow(/needs a value/);
  });

  it("names the control arm when asked for it alone", () => {
    // A noise measurement repeats one setup and reports the spread. The setup
    // has to be a named arm rather than the current default, or a later change
    // to what the default is silently changes what the band describes.
    expect(parseEvalArgs(["--arms", "control"]).arms).toBe("control");
  });

  it("runs one arm unless asked for two", () => {
    // The expensive mode is the one that must be asked for by name: `ab`
    // doubles the attempts and the spend.
    expect(parseEvalArgs([]).arms).toBe("current");
    expect(parseEvalArgs(["--arms", "ab"]).arms).toBe("ab");
  });

  it("refuses an arm setting it does not know", () => {
    expect(() => parseEvalArgs(["--arms", "both"])).toThrow();
  });
});
