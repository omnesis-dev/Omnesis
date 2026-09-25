// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AnswerLog, attemptKey, type KeptRun } from "./answer-log.js";
import type { EvalTask, PromptArm, SampleOutcome } from "./harness.js";

const TASKS: readonly EvalTask[] = [
  {
    id: "a-request",
    query: "watch for a thing",
    reference: "a-watch",
    expect: "compiles",
    because: "a fixture, so the log has something shaped like a task to carry",
  },
];

const NO_TOKENS = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };

function outcome(sample: number, arm?: PromptArm): SampleOutcome {
  return {
    prompt: "a-request",
    sample,
    outcome: "ok",
    detail: "",
    turns: 1,
    usage: NO_TOKENS,
    ...(arm === undefined ? {} : { arm }),
  };
}

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "wv2-answer-log-")), "run.attempts.json");
}

function readBack(path: string): KeptRun {
  return JSON.parse(readFileSync(path, "utf8")) as KeptRun;
}

describe("AnswerLog", () => {
  it("holds every attempt a run paid for when the run never reaches its end", () => {
    // The failure this exists for: a sweep dies with attempts outstanding. What
    // it had already drawn must still be on disk and must still parse, because
    // re-scoring those answers later is the only reason to keep them at all.
    const path = scratch();
    const log = new AnswerLog(path, "a-model", TASKS);

    log.append(outcome(1));
    log.append(outcome(2));
    log.append(outcome(3));
    // ...and here the process dies. Nothing else is called.

    const kept = readBack(path);
    expect(kept.outcomes.map((o) => o.sample)).toEqual([1, 2, 3]);
    expect(kept.model).toBe("a-model");
    expect(kept.tasks).toHaveLength(1);
  });

  it("is readable after every single append, not just at the end", () => {
    const path = scratch();
    const log = new AnswerLog(path, "a-model", TASKS);
    for (let sample = 1; sample <= 5; sample += 1) {
      log.append(outcome(sample));
      expect(readBack(path).outcomes).toHaveLength(sample);
    }
  });

  it("exists and parses before any attempt has landed", () => {
    const path = scratch();
    new AnswerLog(path, "a-model", TASKS);
    expect(readBack(path).outcomes).toEqual([]);
  });

  it("leaves no half-written file beside the log", () => {
    // The log is renamed into place rather than written in place, so a reader
    // arriving mid-write sees a complete previous version instead of a truncated
    // current one. The temporary must not survive a successful write.
    const path = scratch();
    const log = new AnswerLog(path, "a-model", TASKS);
    log.append(outcome(1));
    expect(existsSync(`${path}.pending`)).toBe(false);
    expect(readdirSync(join(path, "..")).sort()).toEqual(["run.attempts.json"]);
  });
});

describe("attemptKey", () => {
  it("tells the two arms of one attempt apart", () => {
    // A run comparing two prompts draws sample #3 of a request under each. Keyed
    // without the arm they collide, and a rescore comparing before-and-after
    // reads one arm's class as if it were the other's.
    expect(attemptKey(outcome(3, "with-bounds"))).not.toBe(
      attemptKey(outcome(3, "without-bounds")),
    );
  });

  it("keeps its shape for a run with no arms", () => {
    expect(attemptKey(outcome(3))).toBe("a-request#3");
  });
});
