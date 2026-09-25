// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the scripted loop-model's pure decision function — the
 * per-turn brain the fake OpenAI server exposes to the run driver. Each
 * test replays a message history the wire would carry and asserts the
 * next emitted action, so the reconcile e2e never debugs scripting logic
 * through a spawned gateway.
 */

import { describe, expect, test } from "vitest";
import { decideNextTurn, parseRunPrompt, startScriptedLoopModelServer } from "./fake-loop-model.js";
import type { ArcDocBehavior } from "./briefs-arcs.js";

type Msg = {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

const DOC_ID = "doc-abc-123";

function dataPrompt(event: "created" | "updated", extra = ""): string {
  const line =
    event === "created"
      ? `A new document arrived: ${DOC_ID}. Fetch its content with fetch_many.`
      : `Document ${DOC_ID} was updated. Fetch the current content with fetch_many.`;
  return [
    `Loop agent run run_test_1 (kind: data, attempt 1).`,
    "",
    line,
    "The datum is dated 2026-07-02T00:00:00.000Z; today is 2026-07-02T01:00:00.000Z — it is from today.",
    extra,
  ].join("\n");
}

function history(
  prompt: string,
  steps: Array<{ name: string; args: unknown; result: unknown }>,
): Msg[] {
  const messages: Msg[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: prompt },
  ];
  steps.forEach((s, i) => {
    const id = `call_${i + 1}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id, type: "function", function: { name: s.name, arguments: JSON.stringify(s.args) } },
      ],
    });
    messages.push({ role: "tool", content: JSON.stringify(s.result), tool_call_id: id });
  });
  return messages;
}

function fetchResult(title: string): unknown {
  // `fetch_many` returns a `document.batch` wrapping one document child per id.
  return {
    kind: "document.batch",
    items: [{ kind: "document", ref: {}, document: { id: DOC_ID, title } }],
  };
}

function searchResult(loops: unknown[]): unknown {
  return {
    kind: "structured",
    resultType: "open_loop.search_results",
    data: { query: "q", loops },
  };
}

const COMMIT: ArcDocBehavior = {
  onCreated: {
    kind: "commit",
    marker: "INV-2041",
    loopTitle: "Pay invoice INV-2041",
    briefTitle: "Invoice INV-2041 needs payment",
    searchQuery: "invoice INV-2041",
  },
};

const RESOLVE: ArcDocBehavior = {
  onCreated: {
    kind: "resolve",
    marker: "INV-2041",
    ambiguous: false,
    searchQuery: "invoice INV-2041",
    ledgerNote: "payment confirmed; closing",
  },
};

const RESOLVE_AMBIGUOUS: ArcDocBehavior = {
  onCreated: {
    kind: "resolve",
    marker: "Harborview-lease",
    ambiguous: true,
    searchQuery: "Harborview-lease",
    ledgerNote: "partial fulfilment",
    confirmBriefTitle: "Is the Harborview-lease paperwork fully sent?",
  },
};

const SCHEDULE: ArcDocBehavior = {
  onCreated: {
    kind: "schedule",
    marker: "library-books",
    loopTitle: "Return the library books (library-books)",
    briefTitle: "Return the library books (library-books) — due today",
    searchQuery: "library-books",
    nextShow: "2026-07-04T08:00:00.000Z",
    eventAt: "2026-07-04T09:00:00.000Z",
    scheduleWhen: "2026-07-04T07:00:00.000Z",
  },
};

const RESOLVED_COMMIT: ArcDocBehavior = {
  onCreated: {
    kind: "resolvedCommit",
    marker: "REG-5150",
    loopTitle: "Registration REG-5150 payment (already settled)",
    searchQuery: "registration REG-5150",
    ledgerNote: "already confirmed before this request synced; tracked as done",
  },
};

const RETRACT: ArcDocBehavior = {
  onCreated: {
    kind: "retract",
    marker: "PO-4242",
    searchQuery: "purchase order PO-4242",
  },
};

function behaviors(title: string, b: ArcDocBehavior): Map<string, ArcDocBehavior> {
  return new Map([[title, b]]);
}

describe("parseRunPrompt", () => {
  test("parses run id, kind, event, and doc id for created and updated data runs", () => {
    expect(parseRunPrompt(dataPrompt("created"))).toMatchObject({
      runId: "run_test_1",
      kind: "data",
      event: "created",
      docId: DOC_ID,
      hasDiff: false,
    });
    expect(parseRunPrompt(dataPrompt("updated", "<diff>\n-a\n+b\n</diff>"))).toMatchObject({
      event: "updated",
      docId: DOC_ID,
      hasDiff: true,
    });
  });
});

describe("decideNextTurn", () => {
  test("first turn of a data run fetches the triggering document", () => {
    const turn = decideNextTurn(history(dataPrompt("created"), []), behaviors("t", COMMIT));
    expect(turn).toEqual({
      kind: "tool",
      name: "fetch_many",
      args: { documents: [{ documentId: DOC_ID }] },
    });
  });

  test("non-data run kinds end immediately without tools", () => {
    const prompt = "Loop agent run run_x (kind: daily, attempt 1).";
    const turn = decideNextTurn(history(prompt, []), behaviors("t", COMMIT));
    expect(turn.kind).toBe("final");
  });

  test("an unknown document title ends without mutating", () => {
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult("Some other doc"),
      },
    ]);
    const turn = decideNextTurn(msgs, behaviors("Known title", COMMIT));
    expect(turn.kind).toBe("final");
  });

  test("commit: reconciles first (search), then creates loop, then brief, then finishes", () => {
    const title = "Invoice INV-2041 from Cedar Grove Supplies";
    const b = behaviors(title, COMMIT);
    const afterFetch = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
    ]);
    expect(decideNextTurn(afterFetch, b)).toEqual({
      kind: "tool",
      name: "open_loop_search",
      args: { query: "invoice INV-2041" },
    });

    const afterMiss = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      { name: "open_loop_search", args: { query: "invoice INV-2041" }, result: searchResult([]) },
    ]);
    const create = decideNextTurn(afterMiss, b);
    expect(create).toMatchObject({ kind: "tool", name: "open_loop_create" });
    expect(
      (
        create as {
          args: { title: string; docs: string[]; annotationDependencies: unknown[] };
        }
      ).args,
    ).toMatchObject({
      title: "Pay invoice INV-2041",
      docs: [DOC_ID],
      annotationDependencies: [],
    });

    const withCreate = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      { name: "open_loop_search", args: { query: "invoice INV-2041" }, result: searchResult([]) },
      {
        name: "open_loop_create",
        args: { title: "Pay invoice INV-2041" },
        result: {
          kind: "structured",
          resultType: "open_loop.created",
          data: { loop: { id: "loop_1" } },
        },
      },
    ]);
    const brief = decideNextTurn(withCreate, b);
    expect(brief).toMatchObject({ kind: "tool", name: "brief_create" });
    expect(
      (
        brief as {
          args: {
            relatedLoopIds: string[];
            citations: string[];
            annotationDependencies: unknown[];
          };
        }
      ).args,
    ).toMatchObject({
      relatedLoopIds: ["loop_1"],
      citations: [DOC_ID],
      annotationDependencies: [],
    });

    const done = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      { name: "open_loop_search", args: { query: "invoice INV-2041" }, result: searchResult([]) },
      {
        name: "open_loop_create",
        args: { title: "Pay invoice INV-2041" },
        result: {
          kind: "structured",
          resultType: "open_loop.created",
          data: { loop: { id: "loop_1" } },
        },
      },
      {
        name: "brief_create",
        args: { kind: "loop" },
        result: { kind: "structured", resultType: "brief.created", data: {} },
      },
    ]);
    expect(decideNextTurn(done, b).kind).toBe("final");
  });

  test("commit: adopts an existing matching loop with a ledger append instead of minting a duplicate", () => {
    const title = "Fwd: deposit reminder";
    const b = behaviors(title, COMMIT);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "invoice INV-2041" },
        result: searchResult([
          { id: "loop_1", title: "Pay invoice INV-2041", state: "open", attachedBriefs: [] },
        ]),
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_ledger_append" });
    expect((turn as { args: { id: string } }).args.id).toBe("loop_1");
  });

  test("schedule: reconciles, creates the loop, a held brief (nextShow/eventAt), then a re-verify run tied to the loop", () => {
    const title = "Return the library books (library-books)";
    const b = behaviors(title, SCHEDULE);
    const base = [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      { name: "open_loop_search", args: { query: "library-books" }, result: searchResult([]) },
    ];

    // After reconcile miss → create the tracking loop.
    const create = decideNextTurn(history(dataPrompt("created"), base), b);
    expect(create).toMatchObject({
      kind: "tool",
      name: "open_loop_create",
      args: { title: "Return the library books (library-books)", docs: [DOC_ID] },
    });

    const afterCreate = [
      ...base,
      {
        name: "open_loop_create",
        args: { title: "Return the library books (library-books)" },
        result: {
          kind: "structured",
          resultType: "open_loop.created",
          data: { loop: { id: "loop_lib" } },
        },
      },
    ];
    // The brief is HELD until the scheduled-day morning (nextShow) with
    // eventAt on the day, attached to the loop.
    const brief = decideNextTurn(history(dataPrompt("created"), afterCreate), b);
    expect(brief).toMatchObject({ kind: "tool", name: "brief_create" });
    expect(
      (
        brief as {
          args: {
            relatedLoopIds: string[];
            nextShow: string;
            eventAt: string;
            citations: string[];
          };
        }
      ).args,
    ).toMatchObject({
      relatedLoopIds: ["loop_lib"],
      nextShow: "2026-07-04T08:00:00.000Z",
      eventAt: "2026-07-04T09:00:00.000Z",
      citations: [DOC_ID],
    });

    const afterBrief = [
      ...afterCreate,
      {
        name: "brief_create",
        args: { kind: "loop" },
        result: { kind: "structured", resultType: "brief.created", data: {} },
      },
    ];
    // The re-verify run is scheduled for the day, carrying the loop's id so
    // #1165's cascade can retract it if the task completes first.
    const schedule = decideNextTurn(history(dataPrompt("created"), afterBrief), b);
    expect(schedule).toMatchObject({ kind: "tool", name: "schedule_agent_run" });
    expect((schedule as { args: { when: string; loopId: string } }).args).toMatchObject({
      when: "2026-07-04T07:00:00.000Z",
      loopId: "loop_lib",
    });

    const done = [
      ...afterBrief,
      {
        name: "schedule_agent_run",
        args: { when: "2026-07-04T07:00:00.000Z", loopId: "loop_lib" },
        result: { kind: "structured", resultType: "agent_run.scheduled", data: {} },
      },
    ];
    expect(decideNextTurn(history(dataPrompt("created"), done), b).kind).toBe("final");
  });

  test("resolve (unambiguous): closes the loop, deletes its active briefs, appends the ledger note", () => {
    const title = "Payment received for invoice INV-2041";
    const b = behaviors(title, RESOLVE);
    const base = [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "invoice INV-2041" },
        result: searchResult([
          {
            id: "loop_1",
            title: "Pay invoice INV-2041",
            state: "open",
            attachedBriefs: [
              { id: "brief_1", state: "unread" },
              { id: "brief_2", state: "dismissed_wrong" },
            ],
          },
        ]),
      },
    ];
    const close = decideNextTurn(history(dataPrompt("created"), base), b);
    expect(close).toMatchObject({
      kind: "tool",
      name: "open_loop_update",
      args: { id: "loop_1", state: "done", annotationDependencies: [] },
    });

    const afterClose = [
      ...base,
      {
        name: "open_loop_update",
        args: { id: "loop_1", state: "done" },
        result: { kind: "structured", resultType: "open_loop.updated", data: {} },
      },
    ];
    const del = decideNextTurn(history(dataPrompt("created"), afterClose), b);
    // Only the ACTIVE brief is deleted; the terminally-dismissed one survives.
    expect(del).toMatchObject({ kind: "tool", name: "brief_delete", args: { id: "brief_1" } });

    const afterDelete = [
      ...afterClose,
      {
        name: "brief_delete",
        args: { id: "brief_1" },
        result: { kind: "structured", resultType: "brief.deleted", data: {} },
      },
    ];
    const ledger = decideNextTurn(history(dataPrompt("created"), afterDelete), b);
    expect(ledger).toMatchObject({ kind: "tool", name: "open_loop_ledger_append" });

    const done = [
      ...afterDelete,
      {
        name: "open_loop_ledger_append",
        args: { id: "loop_1", note: "payment confirmed; closing" },
        result: { kind: "structured", resultType: "open_loop.ledger_appended", data: {} },
      },
    ];
    expect(decideNextTurn(history(dataPrompt("created"), done), b).kind).toBe("final");
  });

  test("resolve (ambiguous): refreshes the loop's active card into a confirmation", () => {
    const title = "Re: Harborview-lease — got one attachment";
    const b = behaviors(title, RESOLVE_AMBIGUOUS);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "Harborview-lease" },
        result: searchResult([
          {
            id: "loop_9",
            title: "Send Harborview-lease documents",
            state: "open",
            attachedBriefs: [{ id: "brief_9", state: "unread" }],
          },
        ]),
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "brief_update" });
    expect(
      (
        turn as {
          args: {
            id: string;
            title: string;
            relatedLoopIds: string[];
            annotationDependencies: unknown[];
          };
        }
      ).args,
    ).toMatchObject({
      id: "brief_9",
      title: "Is the Harborview-lease paperwork fully sent?",
      relatedLoopIds: ["loop_9"],
      annotationDependencies: [],
    });
  });

  test("resolve (ambiguous): creates a confirmation card when the loop has none", () => {
    const title = "Re: Harborview-lease — got one attachment";
    const b = behaviors(title, RESOLVE_AMBIGUOUS);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "Harborview-lease" },
        result: searchResult([
          {
            id: "loop_9",
            title: "Send Harborview-lease documents",
            state: "open",
            attachedBriefs: [],
          },
        ]),
      },
    ]);
    expect(decideNextTurn(msgs, b)).toMatchObject({
      kind: "tool",
      name: "brief_create",
      args: { kind: "loop", relatedLoopIds: ["loop_9"] },
    });
  });

  test("resolve (ambiguous): supersedes a snoozed card so the confirmation can surface", () => {
    const title = "Re: Harborview-lease — got one attachment";
    const b = behaviors(title, RESOLVE_AMBIGUOUS);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "Harborview-lease" },
        result: searchResult([
          {
            id: "loop_9",
            title: "Send Harborview-lease documents",
            state: "open",
            attachedBriefs: [{ id: "brief_snoozed", state: "dismissed_snoozed" }],
          },
        ]),
      },
    ]);
    expect(decideNextTurn(msgs, b)).toMatchObject({
      kind: "tool",
      name: "brief_create",
      args: {
        kind: "loop",
        relatedLoopIds: ["loop_9"],
        supersedes: ["brief_snoozed"],
      },
    });
  });

  test("resolve on a search miss mints a detectable follow-up loop (the failure the instrument must observe)", () => {
    const title = "Payment received for invoice INV-2041";
    const b = behaviors(title, RESOLVE);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      { name: "open_loop_search", args: { query: "invoice INV-2041" }, result: searchResult([]) },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_create" });
    expect((turn as { args: { title: string } }).args.title).toContain("INV-2041");
  });

  test("resolvedCommit on a search miss: create, then close, then ledger — never a brief", () => {
    const title = "Registration REG-5150 — payment required";
    const b = behaviors(title, RESOLVED_COMMIT);
    const fetched = {
      name: "fetch_many",
      args: { documentId: DOC_ID },
      result: fetchResult(title),
    };
    const searched = {
      name: "open_loop_search",
      args: { query: "registration REG-5150" },
      result: searchResult([]),
    };

    // After the miss: track the already-settled obligation.
    expect(decideNextTurn(history(dataPrompt("created"), [fetched, searched]), b)).toMatchObject({
      kind: "tool",
      name: "open_loop_create",
    });

    // After the create: close it (the id read from the create result).
    const created = {
      name: "open_loop_create",
      args: { title: "Registration REG-5150 payment (already settled)" },
      result: { kind: "structured", data: { loop: { id: "loop_77" } } },
    };
    const closeTurn = decideNextTurn(
      history(dataPrompt("created"), [fetched, searched, created]),
      b,
    );
    expect(closeTurn).toMatchObject({ kind: "tool", name: "open_loop_update" });
    expect((closeTurn as { args: { id: string; state: string } }).args).toMatchObject({
      id: "loop_77",
      state: "done",
    });

    // Then the ledger note, then done — no brief_create anywhere.
    const closed = {
      name: "open_loop_update",
      args: { id: "loop_77", state: "done" },
      result: { kind: "structured", data: {} },
    };
    expect(
      decideNextTurn(history(dataPrompt("created"), [fetched, searched, created, closed]), b),
    ).toMatchObject({ kind: "tool", name: "open_loop_ledger_append" });
    const ledgered = {
      name: "open_loop_ledger_append",
      args: { id: "loop_77", note: "already confirmed before this request synced" },
      result: { kind: "structured", data: {} },
    };
    expect(
      decideNextTurn(
        history(dataPrompt("created"), [fetched, searched, created, closed, ledgered]),
        b,
      ).kind,
    ).toBe("final");
  });

  test("feedback already_handled: correct policy closes related loops as done; saboteur deletes them", () => {
    const prompt = [
      "Loop agent run run_fb (kind: feedback, attempt 1).",
      "",
      'The user reacted to brief brief_9 ("Membership GM-1234 lapses next week"). Its state is now: dismissed_already_handled.',
      "They typed no free text.",
      "Related loops: loop_gym (brief_fetch / open_loop_fetch for detail).",
      "",
      "The user dismissed this brief as ALREADY HANDLED.",
    ].join("\n");
    const none = new Map();
    // Correct policy: ledger note first, then state done.
    const first = decideNextTurn(history(prompt, []), none, "correct");
    expect(first).toMatchObject({ kind: "tool", name: "open_loop_ledger_append" });
    const ledgered = {
      name: "open_loop_ledger_append",
      args: {
        id: "loop_gym",
        note: "User dismissed the brief as already handled; closing as done.",
      },
      result: { kind: "structured", data: {} },
    };
    const second = decideNextTurn(history(prompt, [ledgered]), none, "correct");
    expect(second).toMatchObject({ kind: "tool", name: "open_loop_update" });
    expect((second as { args: { id: string; state: string } }).args).toMatchObject({
      id: "loop_gym",
      state: "done",
    });
    // Saboteur policy: the wrong verb — delete.
    const sab = decideNextTurn(history(prompt, []), none, "saboteur");
    expect(sab).toMatchObject({ kind: "tool", name: "open_loop_delete" });
  });

  test("feedback not_relevant: correct policy deletes related loops; saboteur ignores the signal", () => {
    const prompt = [
      "Loop agent run run_fb2 (kind: feedback, attempt 1).",
      "",
      'The user reacted to brief brief_8 ("Early-bird stand pricing (EB-321) ends Friday"). Its state is now: dismissed_not_relevant.',
      "They typed no free text.",
      "Related loops: loop_fair (brief_fetch / open_loop_fetch for detail).",
    ].join("\n");
    const none = new Map();
    const correct = decideNextTurn(history(prompt, []), none, "correct");
    expect(correct).toMatchObject({ kind: "tool", name: "open_loop_delete" });
    expect((correct as { args: { id: string } }).args.id).toBe("loop_fair");
    const sab = decideNextTurn(history(prompt, []), none, "saboteur");
    expect(sab.kind).toBe("final");
  });

  test("feedback snoozed/acknowledged/wrong: correct plans per state; saboteur plants the wrong verb", () => {
    const none = new Map();
    const fbPrompt = (state: string, extra = "") =>
      [
        "Loop agent run run_fb3 (kind: feedback, attempt 1).",
        "",
        `The user reacted to brief brief_7 ("Winter concert tickets (SN-1111) on sale Monday"). Its state is now: ${state}.`,
        "They typed no free text.",
        "Related loops: loop_sn (brief_fetch / open_loop_fetch for detail).",
        extra,
      ].join("\n");

    // snoozed: honour the picked time on the brief; keep the loop.
    const snoozed = decideNextTurn(
      history(
        fbPrompt(
          "dismissed_snoozed",
          "The user picked when it should re-surface: 2026-07-03T08:00:00.000Z. Honour that time.",
        ),
        [],
      ),
      none,
      "correct",
    );
    expect(snoozed).toMatchObject({ kind: "tool", name: "brief_update" });
    expect((snoozed as { args: { id: string; nextShow: string } }).args).toMatchObject({
      id: "brief_7",
      nextShow: "2026-07-03T08:00:00.000Z",
    });
    expect(
      decideNextTurn(history(fbPrompt("dismissed_snoozed"), []), none, "saboteur"),
    ).toMatchObject({ kind: "tool", name: "open_loop_delete" });

    // acknowledged: delete the brief; the saboteur invents a loop.
    const acked = decideNextTurn(history(fbPrompt("dismissed_acknowledged"), []), none, "correct");
    expect(acked).toMatchObject({ kind: "tool", name: "brief_delete" });
    expect(
      decideNextTurn(history(fbPrompt("dismissed_acknowledged"), []), none, "saboteur"),
    ).toMatchObject({ kind: "tool", name: "open_loop_create" });

    // wrong: delete the misread loop; the saboteur marks it done.
    const wrong = decideNextTurn(history(fbPrompt("dismissed_wrong"), []), none, "correct");
    expect(wrong).toMatchObject({ kind: "tool", name: "open_loop_delete" });
    const wrongSab = decideNextTurn(history(fbPrompt("dismissed_wrong"), []), none, "saboteur");
    expect(wrongSab).toMatchObject({ kind: "tool", name: "open_loop_update" });
    expect((wrongSab as { args: { state: string } }).args.state).toBe("done");
  });

  test("retract with a matching loop deletes it — never marks it done", () => {
    const title = "Re: PO-4242 — please disregard, wrong person";
    const b = behaviors(title, RETRACT);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "purchase order PO-4242" },
        result: searchResult([
          {
            id: "loop_po",
            title: "Approve purchase order PO-4242",
            state: "open",
            attachedBriefs: [{ id: "brief_po", state: "unread" }],
          },
        ]),
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_delete" });
    expect((turn as { args: { id: string } }).args.id).toBe("loop_po");

    // After the delete the plan is complete — no update, no brief calls.
    const deleted = {
      name: "open_loop_delete",
      args: { id: "loop_po" },
      result: { kind: "structured", data: { loopId: "loop_po", deletedBriefIds: ["brief_po"] } },
    };
    const done = decideNextTurn(
      history(dataPrompt("created"), [
        {
          name: "fetch_many",
          args: { documents: [{ documentId: DOC_ID }] },
          result: fetchResult(title),
        },
        {
          name: "open_loop_search",
          args: { query: "purchase order PO-4242" },
          result: searchResult([
            {
              id: "loop_po",
              title: "Approve purchase order PO-4242",
              state: "open",
              attachedBriefs: [{ id: "brief_po", state: "unread" }],
            },
          ]),
        },
        deleted,
      ]),
      b,
    );
    expect(done.kind).toBe("final");
  });

  test("retract on a search miss is a clean no-op", () => {
    const title = "Re: PO-4242 — please disregard, wrong person";
    const b = behaviors(title, RETRACT);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "purchase order PO-4242" },
        result: searchResult([]),
      },
    ]);
    expect(decideNextTurn(msgs, b).kind).toBe("final");
  });

  test("resolvedCommit with a matching open loop closes it instead of creating", () => {
    const title = "Registration REG-5150 — payment required";
    const b = behaviors(title, RESOLVED_COMMIT);
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "registration REG-5150" },
        result: searchResult([
          { id: "loop_5", title: "Pay registration REG-5150", state: "open", attachedBriefs: [] },
        ]),
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_update" });
    expect((turn as { args: { id: string; state: string } }).args).toMatchObject({
      id: "loop_5",
      state: "done",
    });
  });

  test("updated documents use onUpdated when declared", () => {
    const title = "Shared notes: workshop agenda";
    const b: ArcDocBehavior = {
      onCreated: { kind: "ignore" },
      onUpdated: {
        kind: "note",
        marker: "workshop",
        searchQuery: "workshop agenda",
        ledgerNote: "doc changed",
      },
    };
    const msgs = history(dataPrompt("updated"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
    ]);
    const turn = decideNextTurn(msgs, behaviors(title, b));
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_search" });
  });

  test("ignore behavior finishes right after the fetch", () => {
    const title = "Nothing important";
    const msgs = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
    ]);
    const turn = decideNextTurn(msgs, behaviors(title, { onCreated: { kind: "ignore" } }));
    expect(turn.kind).toBe("final");
  });
});

describe("scripted loop-model HTTP server", () => {
  test("serves /v1/models, rejects streaming with a 400, and answers non-streamed completions", async () => {
    const server = await startScriptedLoopModelServer({ behaviors: new Map() });
    try {
      const models = (await (await fetch(`${server.url}/v1/models`)).json()) as {
        data: Array<{ id: string }>;
      };
      expect(models.data[0]?.id).toBe(server.modelId);

      const streamRes = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: server.modelId, stream: true, messages: [] }),
      });
      expect(streamRes.status).toBe(400);

      const res = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: server.modelId,
          stream: false,
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: dataPrompt("created") },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        choices: Array<{
          message: { tool_calls?: Array<{ function: { name: string } }> };
          finish_reason: string;
        }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      expect(json.choices[0]?.finish_reason).toBe("tool_calls");
      expect(json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("fetch_many");
      expect(json.usage.prompt_tokens).toBeGreaterThan(0);
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]?.docId).toBe(DOC_ID);
    } finally {
      await server.close();
    }
  });
});
