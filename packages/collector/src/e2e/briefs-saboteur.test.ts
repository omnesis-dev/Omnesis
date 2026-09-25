// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the saboteur behavior table: the swaps are exactly the
 * planted defects (everything else identical to the correct table), the
 * machine-readable manifest is consistent with the table, and the
 * `forceCreate` escape hatch really bypasses reconcile adoption in the
 * scripted model's decision function.
 */

import { describe, expect, test } from "vitest";
import { arcById, generateArcSet, FROZEN_ARC_SEED } from "./briefs-arcs.js";
import { saboteurBehaviors, SABOTEUR_DEFECTS } from "./briefs-saboteur.js";
import { decideNextTurn } from "./fake-loop-model.js";

const SET = generateArcSet(FROZEN_ARC_SEED);

describe("saboteurBehaviors", () => {
  test("swaps exactly the planted-defect steps and leaves every other behavior untouched", () => {
    const saboteur = saboteurBehaviors(SET);
    expect(saboteur.size).toBe(SET.behaviors.size);

    const swappedTitles = new Set(
      [
        arcById(SET, "invoice").steps[1]!,
        arcById(SET, "request").steps[1]!,
        arcById(SET, "concurrent").steps[0]!,
        arcById(SET, "concurrent").steps[1]!,
        arcById(SET, "distractor-boring").steps[0]!,
        arcById(SET, "restatement").steps[1]!,
        arcById(SET, "out-of-order").steps[1]!,
        arcById(SET, "out-of-order-2").steps[1]!,
        arcById(SET, "long-horizon").steps[1]!,
        arcById(SET, "decision-thread").steps[2]!,
        arcById(SET, "obligation-quote").steps[0]!,
        arcById(SET, "errand-key").steps[0]!,
        arcById(SET, "mistaken-commit").steps[1]!,
        arcById(SET, "nudge").steps[1]!,
      ].map((s) => s.doc.title),
    );
    for (const [title, behavior] of SET.behaviors) {
      if (swappedTitles.has(title)) {
        expect(saboteur.get(title), title).not.toEqual(behavior);
      } else {
        expect(saboteur.get(title), title).toEqual(behavior);
      }
    }
    // The arc set itself was not mutated.
    expect(arcById(SET, "invoice").steps[1]!.doc.behavior.onCreated.kind).toBe("resolve");
  });

  test("the defect manifest matches what the table plants", () => {
    const saboteur = saboteurBehaviors(SET);
    let forceCreates = 0;
    for (const behavior of saboteur.values()) {
      if (behavior.onCreated.kind === "commit" && behavior.onCreated.forceCreate) {
        forceCreates += 1;
      }
    }
    // Both racing copies force creation, but one is the legitimate baseline
    // loop. The remaining forced creations are the planted duplicates.
    expect(forceCreates - arcById(SET, "concurrent").gold.loopsWithMarker).toBe(
      SABOTEUR_DEFECTS.duplicateMints,
    );

    // The silent closure: the ambiguous lease fulfilment resolved as
    // unambiguous. Exactly one such downgrade exists.
    const leaseTitle = arcById(SET, "request").steps[1]!.doc.title;
    const swapped = saboteur.get(leaseTitle)!.onCreated;
    expect(swapped.kind).toBe("resolve");
    expect(swapped.kind === "resolve" && swapped.ambiguous).toBe(false);

    // The unjustified loop: the boring email escalated into a commit.
    const boringTitle = arcById(SET, "distractor-boring").steps[0]!.doc.title;
    expect(saboteur.get(boringTitle)!.onCreated.kind).toBe("commit");

    // The unresolved out-of-order obligations: both late requests treated
    // as fresh open commits instead of already-settled ones.
    const oooTitle = arcById(SET, "out-of-order").steps[1]!.doc.title;
    expect(saboteur.get(oooTitle)!.onCreated.kind).toBe("commit");
    const ooo2Title = arcById(SET, "out-of-order-2").steps[1]!.doc.title;
    expect(saboteur.get(ooo2Title)!.onCreated.kind).toBe("commit");

    // The long-horizon chaser: a force-created duplicate at resolution time.
    const longHorizonTitle = arcById(SET, "long-horizon").steps[1]!.doc.title;
    const longHorizonSwap = saboteur.get(longHorizonTitle)!.onCreated;
    expect(longHorizonSwap.kind).toBe("commit");
    expect(longHorizonSwap.kind === "commit" && longHorizonSwap.forceCreate).toBe(true);

    // The ignored update: one decision-thread note dropped on the floor.
    const ignoredNotes = arcById(SET, "decision-thread").steps.filter(
      (s) => saboteur.get(s.doc.title)!.onCreated.kind === "ignore",
    );
    expect(ignoredNotes).toHaveLength(SABOTEUR_DEFECTS.ignoredUpdates);

    // The wrong merges: the quote grafted onto the invoice loop, and the
    // hall-key errand onto the tile-cutter loop — each a note keyed to the
    // OTHER arc's marker, so the bait's own loop is never tracked.
    const quoteTitle = arcById(SET, "obligation-quote").steps[0]!.doc.title;
    const quoteSwap = saboteur.get(quoteTitle)!.onCreated;
    expect(quoteSwap.kind).toBe("note");
    expect(quoteSwap.kind === "note" && quoteSwap.marker).toBe(
      arcById(SET, "obligation-invoice").marker,
    );
    const keyTitle = arcById(SET, "errand-key").steps[0]!.doc.title;
    const keySwap = saboteur.get(keyTitle)!.onCreated;
    expect(keySwap.kind).toBe("note");
    expect(keySwap.kind === "note" && keySwap.marker).toBe(arcById(SET, "errand-cutter").marker);
    const wrongMergeNotes = [quoteSwap, keySwap].filter((s) => s.kind === "note");
    expect(wrongMergeNotes).toHaveLength(SABOTEUR_DEFECTS.wrongMerges);
  });

  test.each([0, 1])(
    "concurrent step %i still plants a duplicate when its sibling finishes first",
    (index) => {
      const arc = arcById(SET, "concurrent");
      const doc = arc.steps[index]!.doc;
      const docId = `doc-concurrent-${index}`;
      const toolReply = (name: string, result: unknown) => [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: name,
              type: "function",
              function: { name, arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: JSON.stringify(result), tool_call_id: name },
      ];
      const messages = [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content: `Loop agent run run_concurrent_${index} (kind: data, attempt 1).\n\nA new document arrived: ${docId}. Fetch its content with fetch_many.`,
        },
        ...toolReply("fetch_many", {
          kind: "document.batch",
          items: [{ kind: "document", document: { id: docId, title: doc.title } }],
        }),
        ...toolReply("open_loop_search", {
          kind: "structured",
          data: {
            loops: [
              {
                id: "loop-from-sibling",
                title: `Deposit ${arc.marker}`,
                state: "open",
                attachedBriefs: [],
              },
            ],
          },
        }),
      ];
      // Exercise both possible race winners with the other's persisted loop
      // visible. A saboteur creates the second loop; a correct run adopts it.
      expect(decideNextTurn(messages, saboteurBehaviors(SET))).toMatchObject({
        kind: "tool",
        name: "open_loop_create",
      });
      expect(decideNextTurn(messages, SET.behaviors)).toMatchObject({
        kind: "tool",
        name: "open_loop_ledger_append",
      });
    },
  );

  test("forceCreate bypasses adoption: a matching search hit still yields open_loop_create", () => {
    const saboteur = saboteurBehaviors(SET);
    const resolutionDoc = arcById(SET, "invoice").steps[1]!.doc;
    const marker = arcById(SET, "invoice").marker!;
    const docId = "doc-force-1";

    const prompt = [
      `Loop agent run run_sab_1 (kind: data, attempt 1).`,
      "",
      `A new document arrived: ${docId}. Fetch its content with fetch_many.`,
    ].join("\n");
    const mkCall = (i: number, name: string, args: unknown, result: unknown) => [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      { role: "tool", content: JSON.stringify(result), tool_call_id: `call_${i}` },
    ];
    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: prompt },
      ...mkCall(
        1,
        "fetch_many",
        { documents: [{ documentId: docId }] },
        {
          kind: "document.batch",
          items: [{ kind: "document", document: { id: docId, title: resolutionDoc.title } }],
        },
      ),
      ...mkCall(
        2,
        "open_loop_search",
        { query: `invoice ${marker}` },
        {
          kind: "structured",
          data: {
            loops: [
              {
                id: "loop-tracked",
                title: `Pay invoice ${marker}`,
                state: "open",
                attachedBriefs: [],
              },
            ],
          },
        },
      ),
    ];

    const turn = decideNextTurn(messages, saboteur);
    expect(turn).toMatchObject({ kind: "tool", name: "open_loop_create" });

    // The CORRECT table, same history: adoption-by-close, never a create.
    const correctTurn = decideNextTurn(messages, SET.behaviors);
    expect(correctTurn).toMatchObject({ kind: "tool", name: "open_loop_update" });
  });
});
