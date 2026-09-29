// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatDecisionCassetteEntry,
  type DecisionRequest,
  type ResolvedAssignment,
} from "@omnesis/core";
import { DecisionService } from "./decision-service.js";
import { ReplayDecision } from "./replay-decision.js";
import { TypeSafeDecision } from "./typesafe-client.js";

const request: DecisionRequest = {
  state: {
    subject: "Dentist reminder",
    from: "Clinic <front@example.org>",
    body: "Tuesday 10:00.",
  },
  questions: { worth_score: { type: "score", instructions: "?", criteria: ["a", "b", "c", "d"] } },
};

const typesafe = (
  over: Partial<Extract<ResolvedAssignment, { kind: "typesafe" }>> = {},
): ResolvedAssignment => ({
  role: "decision",
  kind: "typesafe",
  model: "jev-1.13.0",
  url: "http://127.0.0.1:9/v1/systemone",
  allowRemoteInference: true,
  hasApiKey: true,
  available: true,
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cassetteDir(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-decision-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gate.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "notes.txt"), "not a cassette");
  return dir;
}

describe("DecisionService", () => {
  it("returns null while the role is unassigned", () => {
    const service = new DecisionService({
      resolveAssignment: () => ({ role: "decision", kind: "disabled" }),
      readTypeSafeApiKey: () => "k",
    });
    expect(service.get()).toBeNull();
  });

  it("returns null for an unavailable TypeSafe assignment (no key, egress off)", () => {
    const service = new DecisionService({
      resolveAssignment: () => typesafe({ available: false, reason: "no key" }),
      readTypeSafeApiKey: () => null,
    });
    expect(service.get()).toBeNull();
  });

  it("builds a TypeSafe client pinned to the assigned model and reuses it until the assignment changes", () => {
    let resolved = typesafe();
    let key = "apikey_one_0123456789";
    const service = new DecisionService({
      resolveAssignment: () => resolved,
      readTypeSafeApiKey: () => key,
    });
    const first = service.get();
    expect(first).toBeInstanceOf(TypeSafeDecision);
    expect(first?.modelId).toBe("jev-1.13.0");
    expect(service.get()).toBe(first);
    key = "apikey_two_0123456789";
    const second = service.get();
    expect(second).not.toBe(first);
    resolved = typesafe({ model: "jev-1.14.0" });
    expect(service.get()?.modelId).toBe("jev-1.14.0");
  });

  it("loads a replay fixture directory and answers recorded requests only", async () => {
    const response = {
      model: "jev-1.13.0",
      answers: { worth_score: { type: "score" as const, score: 2.1 } },
    };
    const dir = cassetteDir([formatDecisionCassetteEntry(request, response)]);
    const service = new DecisionService({
      resolveAssignment: () => ({ role: "decision", kind: "replay" }),
      readTypeSafeApiKey: () => null,
      defaultReplayFixture: () => dir,
    });
    const capability = service.get();
    expect(capability).toBeInstanceOf(ReplayDecision);
    await expect(capability!.decide(request)).resolves.toEqual({
      model: "replay:jev-1.13.0",
      answers: response.answers,
    });
    await expect(
      capability!.decide({ ...request, state: { subject: "unrecorded" } }),
    ).rejects.toThrow(/No recorded decision/);
  });

  it("returns null for replay without a fixture or with an unreadable one", () => {
    expect(
      new DecisionService({
        resolveAssignment: () => ({ role: "decision", kind: "replay" }),
        readTypeSafeApiKey: () => null,
      }).get(),
    ).toBeNull();
    expect(
      new DecisionService({
        resolveAssignment: () => ({
          role: "decision",
          kind: "replay",
          fixture: "/nonexistent/fixture.jsonl",
        }),
        readTypeSafeApiKey: () => null,
      }).get(),
    ).toBeNull();
  });
});
