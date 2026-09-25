// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { formatCognitionRunEnvelope } from "@omnesis/core";
import {
  call,
  collectToolSteps,
  decideNextTurn,
  readRunContext,
  ref,
  resolveArgs,
  type WireMessage,
} from "./puppet-plan.js";

function prompt(kind: string, body: string, attempt = 1): string {
  return [formatCognitionRunEnvelope({ runId: "run_1", kind, attempt }), "", body].join("\n");
}

function convo(runPrompt: string, ...steps: Array<[string, unknown, unknown]>): WireMessage[] {
  const messages: WireMessage[] = [{ role: "user", content: runPrompt }];
  steps.forEach(([name, args, result], i) => {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: JSON.stringify(result) });
  });
  return messages;
}

const structured = (data: unknown) => ({ kind: "structured", resultType: "x", data });
const fetched = (title: string) => ({
  kind: "document.batch",
  items: [{ kind: "document", document: { title } }],
});

describe("readRunContext", () => {
  test("identifies each run flavour and its subject from the real prompt shapes", () => {
    const cases: Array<[string, string, string, string | null]> = [
      [
        "data",
        "A new document arrived: doc_7. Fetch its content with fetch_many.",
        "data.created",
        "doc_7",
      ],
      [
        "data",
        "Document doc_8 was updated. Fetch the current content with fetch_many.",
        "data.updated",
        "doc_8",
      ],
      [
        "data",
        "The created document doc_9 that triggered this run has been DELETED since the run was enqueued (possibly a privacy delete).",
        "data.deleted",
        "doc_9",
      ],
      [
        "daily",
        "Morning digest for 2026-08-21. Compose EXACTLY ONE brief",
        "daily.digest",
        "2026-08-21",
      ],
      [
        "daily",
        'Daily batch review for source "gmail:a@example.com": examine that source\'s data points',
        "daily.source",
        "gmail:a@example.com",
      ],
      [
        "time_based",
        "This is a decay status-check: no new data has touched open loop loop_3 for a while, so decide whether it still matters.",
        "time_based.decay",
        "loop_3",
      ],
      [
        "feedback",
        'The user reacted to brief brief_2 ("Deposit due"). Its state is now: dismissed_not_relevant.',
        "feedback.dismissal",
        "brief_2",
      ],
      [
        "feedback",
        'Provenance re-check for brief brief_5 ("Card", state: unread). It was built while these annotation priors',
        "feedback.provenance",
        "brief_5",
      ],
      [
        "synthesis",
        'Synthesis pass ("Noticing") for 2026-08-21. Range over the user\'s recent life',
        "synthesis.noticing",
        "2026-08-21",
      ],
      [
        "synthesis",
        "Cross-loop collision check. These distinct open loops share a structural key (a shared attribute): loop_1, loop_2.",
        "synthesis.collision.loops",
        null,
      ],
      [
        "synthesis",
        "Annotation-contradiction check. These live annotations make the same kind of claim",
        "synthesis.contradiction",
        null,
      ],
      [
        "sweep",
        'Scheduled sweep "may-day" for 2026-08-21. Carry out the steering',
        "sweep",
        "may-day",
      ],
      [
        "bootstrap",
        "RETROSPECTIVE BOOTSTRAP. This is a PAST document (doc_11) that still carries a semantic time",
        "bootstrap",
        "doc_11",
      ],
      [
        "verification",
        "Re-verification pass over the doc annotation store. These live annotations are due",
        "verification",
        "doc",
      ],
      [
        "merge_adjudication",
        "You are adjudicating ONE pending person-merge candidate — the judgment work",
        "merge_adjudication",
        null,
      ],
      [
        "notes_compaction",
        "Notes compaction: your agent notes are 9000 bytes against the 8000-byte soft cap. Rewrite them",
        "notes_compaction",
        "9000",
      ],
    ];
    for (const [kind, body, flavour, subject] of cases) {
      const ctx = readRunContext(prompt(kind, body));
      expect(ctx, `${kind}/${flavour}`).not.toBeNull();
      expect(ctx!.kind, `${kind}/${flavour}`).toBe(kind);
      expect(ctx!.flavour, `${kind}/${flavour}`).toBe(flavour);
      expect(ctx!.subject, `${kind}/${flavour}`).toBe(subject);
    }
  });

  test("a scheduled follow-up carries its stored instruction", () => {
    const ctx = readRunContext(
      prompt(
        "time_based",
        "A previous run scheduled this check with the following instruction:\n<scheduled-instruction>\nRe-verify the deposit.\n</scheduled-instruction>\nCarry it out with fresh eyes",
      ),
    );
    expect(ctx!.flavour).toBe("time_based.scheduled");
    expect(ctx!.detail).toBe("Re-verify the deposit.");
  });

  test("text that is not a run prompt yields nothing", () => {
    expect(readRunContext("hello")).toBeNull();
  });
});

describe("decideNextTurn", () => {
  const behaviors = {
    behaviors: [
      {
        flavour: "data.created" as const,
        docTitle: "Deposit request",
        plan: {
          calls: [
            call("open_loop_search", { query: "deposit" }),
            call("open_loop_create", {
              title: "Send the deposit",
              confidence: 0.9,
              importance: 0.8,
            }),
            call("open_loop_ledger_append", {
              id: ref("open_loop_create", "loop.id"),
              note: "Tracked.",
            }),
          ],
          finalText: "Done tracking.",
        },
      },
    ],
  };

  const body = "A new document arrived: doc_7. Fetch its content with fetch_many.";

  test("a document-subject run fetches the document before consulting the table", () => {
    const turn = decideNextTurn(convo(prompt("data", body)), behaviors);
    expect(turn).toEqual({
      kind: "tool",
      name: "fetch_many",
      args: { documents: [{ documentId: "doc_7" }] },
    });
  });

  test("the plan runs in order, and the loop/brief tools always carry annotationDependencies", () => {
    const p = prompt("data", body);
    const afterFetch = convo(p, ["fetch_many", {}, fetched("Deposit request")]);
    expect(decideNextTurn(afterFetch, behaviors)).toEqual({
      kind: "tool",
      name: "open_loop_search",
      args: { query: "deposit" },
    });

    const afterSearch = convo(
      p,
      ["fetch_many", {}, fetched("Deposit request")],
      ["open_loop_search", { query: "deposit" }, structured({ loops: [] })],
    );
    expect(decideNextTurn(afterSearch, behaviors)).toEqual({
      kind: "tool",
      name: "open_loop_create",
      args: {
        annotationDependencies: [],
        title: "Send the deposit",
        confidence: 0.9,
        importance: 0.8,
      },
    });
  });

  test("a ref reads the id the real tool minted", () => {
    const afterCreate = convo(
      prompt("data", body),
      ["fetch_many", {}, fetched("Deposit request")],
      ["open_loop_search", { query: "deposit" }, structured({ loops: [] })],
      ["open_loop_create", {}, structured({ loop: { id: "loop_minted" } })],
    );
    expect(decideNextTurn(afterCreate, behaviors)).toEqual({
      kind: "tool",
      name: "open_loop_ledger_append",
      args: { id: "loop_minted", note: "Tracked." },
    });
  });

  test("an exhausted plan finishes with its closing text", () => {
    const done = convo(
      prompt("data", body),
      ["fetch_many", {}, fetched("Deposit request")],
      ["open_loop_search", {}, structured({ loops: [] })],
      ["open_loop_create", {}, structured({ loop: { id: "loop_minted" } })],
      ["open_loop_ledger_append", {}, structured({})],
    );
    expect(decideNextTurn(done, behaviors)).toEqual({ kind: "final", text: "Done tracking." });
  });

  test("a repeated tool is counted, not deduplicated — three appends emit three times", () => {
    const table = {
      behaviors: [
        {
          flavour: "sweep" as const,
          plan: {
            calls: [
              call("open_loop_ledger_append", { id: "l1", note: "one" }),
              call("open_loop_ledger_append", { id: "l1", note: "two" }),
              call("open_loop_ledger_append", { id: "l1", note: "three" }),
            ],
          },
        },
      ],
    };
    const p = prompt("sweep", 'Scheduled sweep "s" for 2026-08-21. Carry out');
    const emitted: string[] = [];
    const steps: Array<[string, unknown, unknown]> = [];
    for (let i = 0; i < 4; i++) {
      const turn = decideNextTurn(convo(p, ...steps), table);
      if (turn.kind === "final") {
        emitted.push("final");
        break;
      }
      emitted.push(String((turn.args as { note?: string }).note));
      steps.push([turn.name, turn.args, structured({})]);
    }
    expect(emitted).toEqual(["one", "two", "three", "final"]);
  });

  test("a rejected write still counts as executed, so a gated plan cannot spin", () => {
    const table = {
      behaviors: [
        {
          flavour: "sweep" as const,
          plan: { calls: [call("annotate_durable", { docId: "d1" })], finalText: "moved on" },
        },
      ],
    };
    const p = prompt("sweep", 'Scheduled sweep "s" for 2026-08-21. Carry out');
    const afterRefusal = convo(p, [
      "annotate_durable",
      { docId: "d1" },
      { kind: "error", code: "evidence_does_not_entail_claim" },
    ]);
    expect(decideNextTurn(afterRefusal, table)).toEqual({ kind: "final", text: "moved on" });
  });

  test("an unmatched run does nothing, and says which run it could not place", () => {
    const turn = decideNextTurn(convo(prompt("sweep", 'Scheduled sweep "unknown" for x.')), {
      behaviors: [],
    });
    expect(turn.kind).toBe("final");
    expect((turn as { text: string }).text).toContain("sweep");
  });

  test("behaviors match on kind, subject, attempt and prompt content", () => {
    const table = {
      behaviors: [
        { kind: "sweep", subject: "health", plan: { calls: [], finalText: "health sweep" } },
        { kind: "sweep", plan: { calls: [], finalText: "other sweep" } },
      ],
    };
    const health = decideNextTurn(
      convo(prompt("sweep", 'Scheduled sweep "health" for 2026-08-21. x')),
      table,
    );
    expect((health as { text: string }).text).toBe("health sweep");
    const other = decideNextTurn(
      convo(prompt("sweep", 'Scheduled sweep "money" for 2026-08-21. x')),
      table,
    );
    expect((other as { text: string }).text).toBe("other sweep");
  });

  test("a re-attempt can be scripted differently from the first", () => {
    const table = {
      behaviors: [
        { kind: "sweep", attempt: 2, plan: { calls: [], finalText: "retry path" } },
        { kind: "sweep", plan: { calls: [], finalText: "first path" } },
      ],
    };
    const first = decideNextTurn(convo(prompt("sweep", 'Scheduled sweep "s" for x.', 1)), table);
    expect((first as { text: string }).text).toBe("first path");
    const second = decideNextTurn(convo(prompt("sweep", 'Scheduled sweep "s" for x.', 2)), table);
    expect((second as { text: string }).text).toBe("retry path");
  });
});

describe("plumbing", () => {
  test("tool steps are reconstructed from the wire history", () => {
    const steps = collectToolSteps(
      convo("p", ["a", { x: 1 }, structured({ y: 2 })], ["b", { z: 3 }, null]),
    );
    expect(steps.map((s) => s.name)).toEqual(["a", "b"]);
    expect(steps[0]!.args).toEqual({ x: 1 });
    expect(steps[0]!.result).toEqual(structured({ y: 2 }));
  });

  test("refs resolve through nesting and arrays; unresolved ones become undefined", () => {
    const steps = collectToolSteps(
      convo("p", ["open_loop_search", {}, structured({ loops: [{ id: "loop_a" }] })]),
    );
    expect(
      resolveArgs(
        {
          id: ref("open_loop_search", "loops.0.id"),
          nested: { deep: [ref("open_loop_search", "loops.0.id")] },
          missing: ref("brief_create", "brief.id"),
        },
        steps,
      ),
    ).toEqual({ id: "loop_a", nested: { deep: ["loop_a"] }, missing: undefined });
  });
});
