// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { reducer, initialState, researchPanels } from "./agent-reducer.js";
// @ts-expect-error — plain JS
import { renderPart } from "../components/agent/parts.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The portal arm of the cross-client Deep Research cassette test.
 *
 * Drives the CANONICAL synthetic conversation — the exact `japan-trip-spend.jsonl`
 * the demo gateway plays and the iOS/Android twins assert against — through the
 * REAL reducer, then asserts the terminal state the user actually sees. The point
 * is to test the whole decode→reduce→render contract against the real wire, not a
 * hand-built in-memory event stream: that gap is precisely why manual testing,
 * not CI, surfaced the panels-show-0-docs / cards-linger-after-report bugs. A
 * drift in any client's pipeline now fails here.
 */
const CASSETTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../evals/universes/japan-trip/agent-demos/japan-trip-spend.jsonl",
);

/** Load the cassette, resolve its placeholders to stable test ids. */
function loadCassetteEvents(): Array<{ type: string; payload: Record<string, unknown> }> {
  const raw = readFileSync(CASSETTE, "utf8")
    .replaceAll("$SESSION", "sess-test")
    .replaceAll("$MSG", "msg-test")
    .replaceAll("$DOC_", "doc-");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => JSON.parse(l).event);
}

function driveCassette(): { state: ReturnType<typeof initialState>; assistant: any } {
  let state = { ...initialState(), sessionId: "sess-test" } as ReturnType<typeof initialState>;
  for (const ev of loadCassetteEvents()) {
    state = (reducer as (s: unknown, a: unknown) => ReturnType<typeof initialState>)(state, {
      kind: ev.type,
      payload: ev.payload,
    });
  }
  const assistant = [...(state.turns as any[])].reverse().find((t) => t.role === "assistant");
  return { state, assistant };
}

describe("Deep Research cassette — portal terminal state", () => {
  const { state, assistant } = driveCassette();

  it("reduces the full run into three researcher panels, each carrying its documents (issue A)", () => {
    const panels = researchPanels(state) as any[];
    expect(panels.map((p) => p.specialist)).toEqual(["history-sweep", "source-digest", "history-sweep"]);
    // The reported bug: panels rendered 0 documents. Each must carry its search hits.
    expect(panels.map((p) => p.docs.length)).toEqual([7, 3, 5]);
    expect(panels[0].docs.some((d: any) => /Tokyo Riverside Hotel/.test(d.title ?? ""))).toBe(true);
  });

  it("streams the reconciled spend report", () => {
    const text = assistant.parts
      .filter((p: any) => p.kind === "text")
      .map((p: any) => p.text)
      .join("");
    expect(text).toContain("Studio Northstar");
    expect(text).toContain("3,700");
    expect(text).toContain("168,000");
  });

  it("keeps normal citations without adding a completion card", () => {
    expect(assistant.reportArtifact).toBeUndefined();
    expect((state.citations as unknown[] | undefined)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("hides the inline researcher cards once the turn is done, shows them while live (issue D)", () => {
    expect(assistant.done).toBe(true);
    const card = assistant.parts.find((p: any) => p.kind === "subagent");
    expect(card).toBeTruthy();
    const noop = () => {};
    const shownWhileLive = renderPart(card, "k", [], noop, {}, false, true, false);
    const hiddenWhenDone = renderPart(card, "k", [], noop, {}, false, true, true);
    expect(shownWhileLive).not.toBeNull();
    expect(hiddenWhenDone).toBeNull();
  });
});
