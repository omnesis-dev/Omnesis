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
  // Production shape: the static run rules come first, the envelope after.
  return [
    "Data run: a document arrived or changed. The run envelope follows these rules.",
    "",
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
    observation: "Invoice INV-2041 needs payment",
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
    confirmObservation: "Is the Harborview-lease paperwork fully sent?",
  },
};

const SCHEDULE: ArcDocBehavior = {
  onCreated: {
    kind: "schedule",
    marker: "library-books",
    loopTitle: "Return the library books (library-books)",
    observation: "Return the library books (library-books) — due today",
    searchQuery: "library-books",
    windowStart: "2026-07-04T08:00:00.000Z",
    relevantUntil: "2026-07-04T09:00:00.000Z",
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

  test("commit: reconciles first (search), then creates the loop, then notes an observation, then finishes", () => {
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
    // The observation list is read before anything is noted, so a repeat
    // never duplicates an open item.
    expect(decideNextTurn(withCreate, b)).toMatchObject({
      kind: "tool",
      name: "observation_list",
    });
    const withList = history(dataPrompt("created"), [
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
        name: "observation_list",
        args: {},
        result: { kind: "structured", resultType: "observation.list", data: { observations: [] } },
      },
    ]);
    const noted = decideNextTurn(withList, b);
    expect(noted).toMatchObject({ kind: "tool", name: "observation_note" });
    expect(
      (
        noted as {
          args: {
            summary: string;
            relatedLoopIds: string[];
            citations: string[];
            annotationDependencies: unknown[];
          };
        }
      ).args,
    ).toMatchObject({
      summary: "Invoice INV-2041 needs payment",
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
        name: "observation_list",
        args: {},
        result: { kind: "structured", resultType: "observation.list", data: { observations: [] } },
      },
      {
        name: "observation_note",
        args: { summary: "Invoice INV-2041 needs payment" },
        result: { kind: "structured", resultType: "observation.noted", data: { id: "obs_1" } },
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
          { id: "loop_1", title: "Pay invoice INV-2041", state: "open", attachedObservations: [] },
        ]),
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_ledger_append" });
    expect((turn as { args: { id: string } }).args.id).toBe("loop_1");
  });

  test("schedule: reconciles, creates the loop, a windowed observation, then a re-verify run tied to the loop", () => {
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

    const replay = [
      base[0]!,
      {
        name: "open_loop_search",
        args: { query: "library-books" },
        result: searchResult([
          {
            id: "existing",
            title,
            state: "open",
            docs: [DOC_ID],
            attachedObservations: [{ id: "held", state: "live" }],
          },
        ]),
      },
    ];
    expect(decideNextTurn(history(dataPrompt("created"), replay), b)).toMatchObject({
      kind: "final",
    });

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
    expect(decideNextTurn(history(dataPrompt("created"), afterCreate), b)).toMatchObject({
      kind: "tool",
      name: "observation_list",
    });
    const afterList = [
      ...afterCreate,
      {
        name: "observation_list",
        args: {},
        result: { kind: "structured", resultType: "observation.list", data: { observations: [] } },
      },
    ];
    // The observation matters from the scheduled-day morning (windowStart)
    // until the appointed time (relevantUntil), attached to the loop.
    const noted = decideNextTurn(history(dataPrompt("created"), afterList), b);
    expect(noted).toMatchObject({ kind: "tool", name: "observation_note" });
    expect(
      (
        noted as {
          args: {
            relatedLoopIds: string[];
            windowStart: string;
            relevantUntil: string;
            citations: string[];
          };
        }
      ).args,
    ).toMatchObject({
      relatedLoopIds: ["loop_lib"],
      windowStart: "2026-07-04T08:00:00.000Z",
      relevantUntil: "2026-07-04T09:00:00.000Z",
      citations: [DOC_ID],
    });

    const afterNote = [
      ...afterList,
      {
        name: "observation_note",
        args: { summary: "Return the library books (library-books) — due today" },
        result: { kind: "structured", resultType: "observation.noted", data: { id: "obs_1" } },
      },
    ];
    // The re-verify run is scheduled for the day, carrying the loop's id so
    // the completion cascade can retract it if the task completes first.
    const schedule = decideNextTurn(history(dataPrompt("created"), afterNote), b);
    expect(schedule).toMatchObject({ kind: "tool", name: "schedule_agent_run" });
    expect((schedule as { args: { when: string; loopId: string } }).args).toMatchObject({
      when: "2026-07-04T07:00:00.000Z",
      loopId: "loop_lib",
    });

    const done = [
      ...afterNote,
      {
        name: "schedule_agent_run",
        args: { when: "2026-07-04T07:00:00.000Z", loopId: "loop_lib" },
        result: { kind: "structured", resultType: "agent_run.scheduled", data: {} },
      },
    ];
    expect(decideNextTurn(history(dataPrompt("created"), done), b).kind).toBe("final");
  });

  test("resolve (unambiguous): closes the loop and appends the ledger note; its observations drop with it", () => {
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
            attachedObservations: [{ id: "obs_1", state: "live" }],
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
    // No observation call: closing the loop drops its open observations.
    const ledger = decideNextTurn(history(dataPrompt("created"), afterClose), b);
    expect(ledger).toMatchObject({ kind: "tool", name: "open_loop_ledger_append" });

    const done = [
      ...afterClose,
      {
        name: "open_loop_ledger_append",
        args: { id: "loop_1", note: "payment confirmed; closing" },
        result: { kind: "structured", resultType: "open_loop.ledger_appended", data: {} },
      },
    ];
    expect(decideNextTurn(history(dataPrompt("created"), done), b).kind).toBe("final");
  });

  test("resolve (ambiguous): a confirmation observation supersedes the loop's open one", () => {
    const title = "Re: Harborview-lease — got one attachment";
    const b = behaviors(title, RESOLVE_AMBIGUOUS);
    const steps = [
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
            attachedObservations: [{ id: "obs_9", state: "live" }],
          },
        ]),
      },
    ];
    expect(decideNextTurn(history(dataPrompt("created"), steps), b)).toMatchObject({
      kind: "tool",
      name: "observation_list",
    });
    const turn = decideNextTurn(
      history(dataPrompt("created"), [
        ...steps,
        {
          name: "observation_list",
          args: {},
          result: {
            kind: "structured",
            resultType: "observation.list",
            data: { observations: [] },
          },
        },
      ]),
      b,
    );
    expect(turn).toMatchObject({
      kind: "tool",
      name: "observation_note",
      args: {
        summary: "Is the Harborview-lease paperwork fully sent?",
        relatedLoopIds: ["loop_9"],
        supersedes: ["obs_9"],
        annotationDependencies: [],
      },
    });
  });

  test("resolve (ambiguous): a reoffered source adopts its existing current confirmation", () => {
    const title = "Re: Harborview-lease — got one attachment";
    const turn = decideNextTurn(
      history(dataPrompt("created"), [
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
              attachedObservations: [
                {
                  id: "obs_confirmation",
                  summary: "Is the Harborview-lease paperwork fully sent?",
                  state: "live",
                },
              ],
            },
          ]),
        },
        {
          name: "observation_list",
          args: {},
          result: {
            kind: "structured",
            resultType: "observation.list",
            data: { observations: [] },
          },
        },
      ]),
      behaviors(title, RESOLVE_AMBIGUOUS),
    );
    expect(turn.kind, JSON.stringify(turn)).toBe("final");
  });

  test("resolve (ambiguous): notes a confirmation without superseding when the loop has none", () => {
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
            attachedObservations: [],
          },
        ]),
      },
      {
        name: "observation_list",
        args: {},
        result: { kind: "structured", resultType: "observation.list", data: { observations: [] } },
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({
      kind: "tool",
      name: "observation_note",
      args: { relatedLoopIds: ["loop_9"] },
    });
    expect((turn as { args: Record<string, unknown> }).args.supersedes).toBeUndefined();
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

  test("reconsideration recognizes a retired commitment instead of recreating it", () => {
    const title = "Registration REG-5150 — payment required";
    const turns = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      {
        name: "open_loop_search",
        args: { query: "registration REG-5150" },
        result: {
          kind: "structured",
          data: { loops: [], retired: [{ title: "Registration REG-5150", outcome: "done" }] },
        },
      },
    ]);
    expect(decideNextTurn(turns, behaviors(title, RESOLVED_COMMIT)).kind).toBe("final");
  });

  test("a retry uses a freshly fetched terminal owner when active search no longer returns it", () => {
    const title = "Payment confirmation";
    const turns = history(dataPrompt("created"), [
      {
        name: "fetch_many",
        args: { documents: [{ documentId: DOC_ID }] },
        result: fetchResult(title),
      },
      { name: "open_loop_search", args: { query: "invoice INV-2041" }, result: searchResult([]) },
      {
        name: "open_loop_fetch",
        args: { id: "original-loop" },
        result: {
          kind: "structured",
          data: {
            id: "original-loop",
            title: "Pay invoice INV-2041",
            state: "done",
            attachedObservations: [],
          },
        },
      },
    ]);
    expect(decideNextTurn(turns, behaviors(title, RESOLVE))).toMatchObject({
      kind: "tool",
      name: "open_loop_update",
      args: { id: "original-loop", state: "done" },
    });
  });

  test("a planted duplicate is created for a different source, not again for its own source", () => {
    const title = "Repeated invoice notice";
    const sabotage: ArcDocBehavior = {
      onCreated: { ...COMMIT.onCreated, forceCreate: true } as Extract<
        ArcDocBehavior["onCreated"],
        { kind: "commit" }
      >,
    };
    const decide = (docs: string[]) =>
      decideNextTurn(
        history(dataPrompt("created"), [
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
                id: "existing",
                title: "Pay invoice INV-2041",
                state: "open",
                docs,
                attachedObservations: [{ id: "obs-existing", state: "live" }],
              },
            ]),
          },
        ]),
        behaviors(title, sabotage),
      );
    expect(decide(["another-source"])).toMatchObject({ kind: "tool", name: "open_loop_create" });
    expect(decide([DOC_ID]).kind).toBe("final");
  });

  test("resolvedCommit on a search miss: create, then close, then ledger — never an observation", () => {
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

    // Then the ledger note, then done — no observation_note anywhere.
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
            attachedObservations: [{ id: "obs_po", state: "live" }],
          },
        ]),
      },
    ]);
    const turn = decideNextTurn(msgs, b);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_delete" });
    expect((turn as { args: { id: string } }).args.id).toBe("loop_po");

    // After the delete the plan is complete — no update, no observation calls.
    const deleted = {
      name: "open_loop_delete",
      args: { id: "loop_po" },
      result: {
        kind: "structured",
        data: { loopId: "loop_po", deletedObservationIds: ["obs_po"] },
      },
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
              attachedObservations: [{ id: "obs_po", state: "live" }],
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
          {
            id: "loop_5",
            title: "Pay registration REG-5150",
            state: "open",
            attachedObservations: [],
          },
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

test("maintenance reads the actual offered source before completing discovery", () => {
  const prompt =
    "Loop agent run run_current (kind: synthesis, attempt 1).\nMaintain the evidence-backed synthesis graph for this batch.";
  const first = decideNextTurn(history(prompt, []), new Map());
  expect(first).toMatchObject({ kind: "tool", name: "knowledge_next_frontier" });
  const steps = [
    {
      name: "knowledge_next_frontier",
      args: {},
      result: {
        kind: "structured",
        data: {
          batchId: "b",
          done: false,
          items: [
            {
              id: "source:fixture",
              depth: 0,
              inputFingerprint: "fp",
              inputVersions: { "source:fixture": "v1" },
              source: {
                id: "fixture",
                title: "Neutral reference",
                content: "A fictional reference paragraph.",
                contentHash: "v1",
              },
            },
          ],
        },
      },
    },
  ];
  expect(decideNextTurn(history(prompt, steps), new Map())).toMatchObject({
    kind: "tool",
    name: "fetch_many",
    args: { documents: [{ documentId: "fixture" }] },
  });
  expect(
    decideNextTurn(
      history(prompt, [
        ...steps,
        {
          name: "fetch_many",
          args: { documents: [{ documentId: "fixture" }] },
          result: { kind: "structured", data: {} },
        },
      ]),
      new Map(),
    ),
  ).toMatchObject({
    kind: "tool",
    name: "knowledge_discovery_complete",
    args: { id: "source:fixture", inputFingerprint: "fp" },
  });
});

test("maintenance selects updated behavior from the actual folded source body", () => {
  const prompt =
    "Loop agent run run_revision (kind: synthesis, attempt 1).\nMaintain the evidence-backed synthesis graph for this batch.";
  const title = "Fictional observatory reference";
  const behaviors = new Map<string, ArcDocBehavior>([
    [
      title,
      {
        onCreated: { kind: "ignore" },
        onUpdated: {
          kind: "inform",
          marker: "OBS-REFERENCE",
          observation: "Observatory reference revised",
        },
        updatedContents: [
          "First revision adds an inventory.",
          "Final revision adds inventory and access instructions.",
        ],
      },
    ],
  ]);
  const next = (content: string) =>
    decideNextTurn(
      history(prompt, [
        {
          name: "knowledge_next_frontier",
          args: {},
          result: {
            kind: "structured",
            data: {
              batchId: "b",
              done: false,
              items: [
                {
                  id: "source:revision",
                  depth: 0,
                  inputFingerprint: "current-fingerprint",
                  inputVersions: { "source:revision": "current-version" },
                  source: { id: "revision", title, content, contentHash: "current-version" },
                },
              ],
            },
          },
        },
        {
          name: "fetch_many",
          args: { documents: [{ documentId: "revision" }] },
          result: fetchResult(title),
        },
      ]),
      behaviors,
    );
  expect(next("Initial overview.")).toMatchObject({
    kind: "tool",
    name: "knowledge_discovery_complete",
  });
  expect(next("First revision adds an inventory.")).toMatchObject({
    kind: "tool",
    name: "observation_list",
  });
  expect(next("Final revision adds inventory and access instructions.")).toMatchObject({
    kind: "tool",
    name: "observation_list",
  });
});

test("stale loop maintenance reads canonical prose before retaining unchanged context", () => {
  const prompt =
    "Loop agent run run_owner (kind: synthesis, attempt 1).\nMaintain the evidence-backed synthesis graph for this batch.";
  const node = {
    id: "loop_fixture",
    ownerId: "loop_fixture",
    kind: "loop",
    title: "Review the studio inventory",
    markdown:
      '<claim id="legacy" refs="source:fixture">Tracked from the triggering document.</claim>',
    revision: 3,
    validity: "stale",
    metadata: {},
    claims: [
      {
        id: "legacy",
        supportLogic: "all",
        validFrom: null,
        validUntil: null,
      },
    ],
    readOnly: { claims: [{ id: "legacy", refs: ["source:fixture"] }] },
  };
  const frontier = {
    name: "knowledge_next_frontier",
    args: {},
    result: {
      kind: "structured",
      data: {
        batchId: "b",
        done: false,
        items: [
          {
            id: node.id,
            depth: 1,
            node,
            pendingClaimIds: ["legacy"],
            inputFingerprint: "fp",
            inputVersions: { "source:fixture": "v1" },
          },
        ],
      },
    },
  };
  expect(decideNextTurn(history(prompt, [frontier]), new Map())).toMatchObject({
    kind: "tool",
    name: "open_loop_fetch",
    args: { id: node.id },
  });
  const fetched = (description: string) => ({
    name: "open_loop_fetch",
    args: { id: node.id },
    result: { kind: "structured", data: { id: node.id, title: node.title, description } },
  });
  expect(
    decideNextTurn(
      history(prompt, [frontier, fetched("Tracked from the triggering document.")]),
      new Map(),
    ),
  ).toMatchObject({
    kind: "tool",
    name: "knowledge_save",
    args: {
      inputFingerprint: "fp",
      reviewedClaimIds: ["legacy"],
      node: { expectedRevision: 3, markdown: node.markdown },
    },
  });
  expect(
    decideNextTurn(history(prompt, [frontier, fetched("Canonical prose was revised.")]), new Map()),
  ).toMatchObject({ kind: "final" });
});

test("maintenance adopts duplicate evidence through an owner read and source routing, without ledger churn", () => {
  const prompt =
    "Loop agent run run_duplicate (kind: synthesis, attempt 1).\nMaintain the evidence-backed synthesis graph for this batch.";
  const action = {
    kind: "commit" as const,
    marker: "observatory",
    searchQuery: "observatory",
    loopTitle: "Confirm observatory access",
    observation: "Confirm observatory access",
  };
  const b = behaviors("Observatory access", { onCreated: action });
  const steps = [
    {
      name: "knowledge_next_frontier",
      args: {},
      result: {
        kind: "structured",
        data: {
          batchId: "batch",
          done: false,
          items: [
            {
              id: "source:fixture",
              depth: 0,
              inputFingerprint: "fp",
              inputVersions: { "source:fixture": "v1" },
              source: {
                id: "fixture",
                title: "Observatory access",
                content: "Please confirm access.",
                contentHash: "v1",
              },
            },
          ],
        },
      },
    },
    {
      name: "fetch_many",
      args: { documents: [{ documentId: "fixture" }] },
      result: { kind: "structured", data: {} },
    },
    {
      name: "open_loop_search",
      args: { query: "observatory" },
      result: searchResult([
        {
          id: "winner",
          title: "Confirm observatory access",
          state: "open",
          attachedObservations: [],
        },
      ]),
    },
  ];
  expect(decideNextTurn(history(prompt, steps), b)).toMatchObject({
    kind: "tool",
    name: "open_loop_fetch",
    args: { id: "winner" },
  });
  expect(
    decideNextTurn(
      history(prompt, [
        ...steps,
        {
          name: "open_loop_fetch",
          args: { id: "winner" },
          result: {
            kind: "structured",
            data: { id: "winner", title: "Confirm observatory access" },
          },
        },
      ]),
      b,
    ),
  ).toMatchObject({
    kind: "tool",
    name: "knowledge_discovery_complete",
    args: { id: "source:fixture", inputFingerprint: "fp", targets: ["winner"] },
  });
});

test.each([
  ["live", "observations", "Weather update", DOC_ID, "final"],
  ["held", "observations", "Weather update", DOC_ID, "final"],
  ["shipped", "recentlyShipped", "Weather update", DOC_ID, "final"],
  ["dropped", "observations", "Weather update", DOC_ID, "tool"],
  ["dropped", "recentlyShipped", "Weather update", DOC_ID, "tool"],
  ["live", "observations", "Weather update", "other-document", "tool"],
  ["live", "observations", "Different update", DOC_ID, "tool"],
] as const)(
  "inform reoffer respects %s in %s with summary %s and citation %s",
  (state, bucket, summary, citation, expected) => {
    const title = "Weather bulletin";
    const turn = decideNextTurn(
      history(dataPrompt("created"), [
        {
          name: "fetch_many",
          args: { documents: [{ documentId: DOC_ID }] },
          result: fetchResult(title),
        },
        {
          name: "observation_list",
          args: {},
          result: {
            kind: "structured",
            resultType: "observation.list",
            data: {
              observations: [],
              recentlyShipped: [],
              [bucket]: [{ id: "prior", state, summary, citations: [citation] }],
            },
          },
        },
      ]),
      behaviors(title, {
        onCreated: { kind: "inform", marker: "weather-bulletin", observation: "Weather update" },
      }),
    );
    expect(turn.kind, JSON.stringify(turn)).toBe(expected);
    if (expected === "tool")
      expect(turn).toMatchObject({
        name: "observation_note",
        args: { summary: "Weather update", citations: [DOC_ID] },
      });
  },
);
