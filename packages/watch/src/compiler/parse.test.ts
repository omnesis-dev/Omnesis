// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a model's reply is a classification, not a validation.
 *
 * Three outcomes, and the evaluation counts them separately, so each has to be
 * reachable and none may be reached by accident. In particular a reply that is
 * *nearly* right — a JSON object with no decision, a refusal with no reasons —
 * must land in `unparseable` rather than being silently repaired into one of
 * the other two.
 */

import { describe, expect, it } from "vitest";

import { parseReply } from "./parse.js";

describe("a reply carrying a watch", () => {
  it("reads the object out of a fenced block", () => {
    const parsed = parseReply('```json\n{"decision":"compile","watch":{"name":"a"}}\n```');
    expect(parsed).toEqual({ kind: "watch", watch: { name: "a" } });
  });

  it("reads a block the model labelled jsonc", () => {
    const parsed = parseReply('```jsonc\n{"decision":"compile","watch":{"name":"a"}}\n```');
    expect(parsed.kind).toBe("watch");
  });

  it("ignores prose around the block", () => {
    const parsed = parseReply(
      'Here is the watch.\n\n```json\n{"decision":"compile","watch":{"name":"a"}}\n```\n\nLet me know.',
    );
    expect(parsed.kind).toBe("watch");
  });

  it("takes the last block when the model showed its working", () => {
    // A model that drafts in the open leaves the draft above the answer. The
    // answer is the one it ended on, and taking the first would compile the
    // draft.
    const parsed = parseReply(
      '```json\n{"decision":"compile","watch":{"name":"draft"}}\n```\n' +
        "On reflection the key is wrong.\n" +
        '```json\n{"decision":"compile","watch":{"name":"final"}}\n```',
    );
    expect(parsed).toEqual({ kind: "watch", watch: { name: "final" } });
  });

  it("reads a bare object when the model skipped the fence", () => {
    const parsed = parseReply('{"decision":"compile","watch":{"name":"a"}}');
    expect(parsed.kind).toBe("watch");
  });

  it("takes the last block that is an answer, not simply the last block", () => {
    // A model that follows its answer with a snippet — a shell line, a note in
    // a fence of its own — has still answered. Taking the trailer would throw
    // the answer away and spend a repair turn asking for it again.
    const parsed = parseReply(
      '```json\n{"decision":"compile","watch":{"name":"final"}}\n```\n' +
        "Run it with:\n" +
        "```bash\nnpx tsx run.ts\n```",
    );
    expect(parsed).toEqual({ kind: "watch", watch: { name: "final" } });
  });

  it("survives a fenced block that is JSON but not an answer", () => {
    const parsed = parseReply(
      '```json\n{"decision":"compile","watch":{"name":"final"}}\n```\n' +
        '```json\n{"note":"the ontology has no plaid source"}\n```',
    );
    expect(parsed).toEqual({ kind: "watch", watch: { name: "final" } });
  });

  it("does not read a fence tag it was not offered", () => {
    // The tag is matched narrowly on purpose. A block the model labelled
    // something else is prose to this parser, and a wider match would start
    // treating diffs and shell as candidate answers.
    const parsed = parseReply("```yaml\ndecision: compile\n```");
    expect(parsed.kind).toBe("unparseable");
  });
});

describe("a reply refusing", () => {
  it("keeps the reasons and the codes apart", () => {
    const parsed = parseReply(
      '```json\n{"decision":"refuse","reasons":["no plaid source in the ontology"],' +
        '"codes":["unsupported_condition"]}\n```',
    );
    expect(parsed).toEqual({
      kind: "refusal",
      reasons: ["no plaid source in the ontology"],
      codes: ["unsupported_condition"],
    });
  });

  it("keeps a reason to one line, so it cannot forge a log entry", () => {
    // The reasons are kept as prose and written to the gateway log, and a
    // corpus-reading model writes them — so a newline in the middle of one is a
    // planted document dictating a complete, well-formed log line.
    const forged = JSON.stringify({
      decision: "refuse",
      reasons: ["no source carries this\n2026-01-01T00:00:00.000Z INFO  [gateway] all clear"],
    });
    const parsed = parseReply(`\`\`\`json\n${forged}\n\`\`\``);

    expect(parsed.kind).toBe("refusal");
    if (parsed.kind !== "refusal") return;
    expect(parsed.reasons[0]).not.toContain("\n");
    expect(parsed.reasons[0]).toContain("no source carries this");
  });

  it("bounds how much prose a refusal can carry into the log", () => {
    // A size-rotated log is finite: an unbounded array of long reasons pushes
    // the evidence of whatever caused them out the other end.
    const flood = JSON.stringify({
      decision: "refuse",
      reasons: Array.from({ length: 200 }, () => "x".repeat(10_000)),
    });
    const parsed = parseReply(`\`\`\`json\n${flood}\n\`\`\``);

    expect(parsed.kind).toBe("refusal");
    if (parsed.kind !== "refusal") return;
    expect(parsed.reasons.length).toBeLessThanOrEqual(8);
    for (const reason of parsed.reasons) expect(reason.length).toBeLessThanOrEqual(500);
  });

  it("is still a refusal when the model skipped the codes", () => {
    // The codes are the disclosable channel, not the answer. A model that
    // ignored that half of the grammar has still refused, and turning that into
    // a repair loop would spend three more turns on a decided question.
    expect(
      parseReply('```json\n{"decision":"refuse","reasons":["cannot express this"]}\n```'),
    ).toEqual({ kind: "refusal", reasons: ["cannot express this"], codes: [] });
  });

  it("is not a refusal without them", () => {
    // A refusal is only useful if it says why. An empty one is a model
    // declining to answer, which is a different outcome from an honest
    // refusal and must not be counted as one.
    expect(parseReply('```json\n{"decision":"refuse","reasons":[]}\n```').kind).toBe("unparseable");
    expect(parseReply('```json\n{"decision":"refuse"}\n```').kind).toBe("unparseable");
  });
});

describe("a reply that cannot be read", () => {
  it("says so rather than throwing", () => {
    // The caller feeds the detail back to the model, so it has to be a value.
    const parsed = parseReply("I could not work out how to do this, sorry.");
    expect(parsed.kind).toBe("unparseable");
    expect(parsed).toHaveProperty("detail");
  });

  it("rejects a decision it does not recognise", () => {
    const parsed = parseReply('```json\n{"decision":"maybe","watch":{}}\n```');
    expect(parsed.kind).toBe("unparseable");
  });

  it("rejects a compilation with no watch", () => {
    expect(parseReply('```json\n{"decision":"compile"}\n```').kind).toBe("unparseable");
  });

  it("rejects JSON that is not an object", () => {
    expect(parseReply("```json\n[1, 2, 3]\n```").kind).toBe("unparseable");
    expect(parseReply("```json\nnull\n```").kind).toBe("unparseable");
  });

  it("rejects a fenced block of broken JSON", () => {
    expect(parseReply('```json\n{"decision": "compile",\n```').kind).toBe("unparseable");
  });

  it("says which of the two ways the reply failed", () => {
    // The model is told what to fix, and "add a fence" and "your JSON is
    // malformed" are different instructions.
    const noFence = parseReply("I could not work out how to do this.");
    const badJson = parseReply('```json\n{"decision": "compile",\n```');
    const noDecision = parseReply('```json\n{"watch":{"name":"a"}}\n```');
    expect(noFence).toMatchObject({ detail: expect.stringContaining("no fenced JSON block") });
    expect(badJson).toMatchObject({ detail: expect.stringContaining("not JSON") });
    expect(noDecision).toMatchObject({ detail: expect.stringContaining("no 'decision'") });
  });

  it("terminates on a reply that is all fence openings", () => {
    // The opening fence's whitespace run stops at the newline rather than
    // spanning it, so a pathological reply cannot make the matcher wander.
    const parsed = parseReply("```json ".repeat(400));
    expect(parsed.kind).toBe("unparseable");
  });
});
