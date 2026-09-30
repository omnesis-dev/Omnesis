// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDecisionCassette,
  decisionRowToEntry,
  refuseLiveDatabase,
} from "./decision-cassette.mjs";
import {
  decisionFingerprint,
  parseDecisionCassette,
} from "../../packages/core/src/models/decision-cassette.ts";

const QUESTIONS = {
  worth_score: {
    type: "score",
    instructions: "How much is this worth recording?",
    criteria: ["Nothing", "A little", "Worth it", "Important"],
  },
};

/** A ledger row as the gateway writes it: the request carries the model id. */
function row(id, state, score, extra = {}) {
  return {
    id,
    run_id: `run_${id}`,
    request_json: JSON.stringify({ model: "jev-1.13.0", state, questions: QUESTIONS }),
    response_json: JSON.stringify({
      model: "jev-1.13.0",
      answers: { worth_score: { type: "score", score } },
    }),
    input_tokens: 412,
    created_at: 1,
    ...extra,
  };
}

const STATE = {
  subject: "Quarterly budget review",
  from: "Maya Reeves <maya.reeves@example.org>",
  body: "The Q4 budget draft is ready for your comments by Friday.",
};

describe("decision cassette recorder", () => {
  it("drops the model from the request, so the entry replays under any pinned version", () => {
    const { request, response } = decisionRowToEntry(row("d1", STATE, 2.3));
    expect(request).toEqual({ state: STATE, questions: QUESTIONS });
    expect(response).toEqual({
      model: "jev-1.13.0",
      answers: { worth_score: { type: "score", score: 2.3 } },
      inputTokens: 412,
    });
  });

  it("writes lines the replay backend's parser accepts, keyed by the request fingerprint", () => {
    const { jsonl, lines } = buildDecisionCassette([row("d1", STATE, 2.3)]);
    expect(lines).toHaveLength(1);
    const entries = parseDecisionCassette(jsonl);
    const fp = decisionFingerprint({ state: STATE, questions: QUESTIONS });
    expect(entries.get(fp)?.response.answers.worth_score).toEqual({ type: "score", score: 2.3 });
  });

  it("keeps one line per request, with the newest answer", () => {
    const other = { ...STATE, subject: "Marathon entry form" };
    const { jsonl, lines } = buildDecisionCassette([
      row("d1", STATE, 0.4),
      row("d2", other, 1.9),
      row("d3", STATE, 2.6),
    ]);
    expect(lines).toHaveLength(2);
    const entries = [...parseDecisionCassette(jsonl).values()];
    expect(entries.map((e) => e.request.state.subject)).toEqual([
      "Quarterly budget review",
      "Marathon entry form",
    ]);
    expect(entries[0].response.answers.worth_score.score).toBe(2.6);
  });

  it("refuses to write anything real-looking, naming the decision", () => {
    const leaky = {
      ...STATE,
      body: "Your access token is tok9f8a7b6c5d4e3f2a1b0c9d8e7f6 do not share.",
    };
    expect(() => buildDecisionCassette([row("d1", STATE, 1), row("d9", leaky, 1)])).toThrow(
      /Refusing to write a decision cassette[\s\S]*d9: base64ish/,
    );
  });

  it("rejects a row whose stored request is not a decision request", () => {
    expect(() =>
      decisionRowToEntry({ id: "d1", request_json: "{}", response_json: "{}", input_tokens: null }),
    ).toThrow(/d1: request_json has no \{state, questions\}/);
  });
});

describe("live database guard", () => {
  let home;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it("refuses a database inside ~/.config/omnesis, directly or through a symlink", () => {
    home = mkdtempSync(join(tmpdir(), "decision-recorder-home-"));
    const live = join(home, ".config", "omnesis");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "omnesis.db"), "");
    expect(() => refuseLiveDatabase(join(live, "omnesis.db"), home)).toThrow(
      /live config directory/,
    );

    const link = join(home, "linked.db");
    symlinkSync(join(live, "omnesis.db"), link);
    expect(() => refuseLiveDatabase(link, home)).toThrow(/live config directory/);
  });

  it("accepts a database elsewhere", () => {
    home = mkdtempSync(join(tmpdir(), "decision-recorder-home-"));
    expect(() => refuseLiveDatabase(join(home, "dev-instance", "omnesis.db"), home)).not.toThrow();
  });
});
