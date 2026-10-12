// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildBuiltinTools, CitationReads } from "@omnesis/agent";
import { createDatabase } from "../db.js";
import {
  createAnswerGroundingFinalizer,
  GROUNDING_UNKNOWN,
  GROUNDING_CHANGED,
} from "../agent/answer-grounding.js";
import { createGatewayLoopReadPort } from "./interactive-loop-port.js";
import { createOpenLoop, updateOpenLoop } from "./storage/open-loops.js";
import { convertKnowledgeOwner } from "./knowledge/owner-adapters.js";
import { reconcileKnowledgeOwner } from "./knowledge/owner-sync.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let directory: string;
const now = Date.parse("2026-02-03T12:00:00Z");
const identity = { sessionId: "session", messageId: "turn" };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "loop-observation-"));
  db = createDatabase(join(directory, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function loop(id: string, importance = 0.5, docs: string[] = []) {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "fixture",
      title: `Inspect ${id}`,
      description: "Recorded inspection candidate",
      importance,
      confidence: 0.8,
      docs,
    },
    now,
  );
}
function source() {
  db.prepare(
    "INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at) VALUES('source','test','test','source','Observation','A prism needs inspection.','v1','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
  ).run();
}
const options = { ...identity, mode: "snapshot" as const };

it("captures exact as-of scope and stable tied ordering in an atomic real store read", async () => {
  loop("a");
  loop("b");
  updateOpenLoop(db, "a", { description: "More recent stored note" }, now + 100);
  const port = createGatewayLoopReadPort(db, () => now);
  const result = await port.list(1, undefined, options);
  expect(result.loops.map((row) => row.loopId)).toEqual(["b"]);
  expect(result.truncated).toBe(true);
  expect(result.observation).toMatchObject({
    mode: "snapshot",
    observedAt: new Date(now).toISOString(),
    readScope: {
      limit: 1,
      states: ["open", "snoozed"],
      population: "accessible_stored_records",
      order: "importance_desc_id_desc",
    },
  });
  loop("c", 0.99);
  expect(await port.validateList!(result, identity)).toBe(true);
  updateOpenLoop(db, "b", { state: "done", importance: 0.1 }, now + 200);
  expect(await port.validateList!(result, identity)).toBe(true);
  expect(result.loops[0]?.state).toBe("open");
});

it("preserves a complete zero-row observation without reading new collection members", async () => {
  const port = createGatewayLoopReadPort(db, () => now);
  const result = await port.list(10, undefined, options);
  expect(result.loops).toEqual([]);
  expect(result.truncated).toBe(false);
  loop("new");
  expect(await port.validateList!(result, identity)).toBe(true);
});

it("binds exact data to the original turn and refuses forged handles or changed scope", async () => {
  loop("a");
  const port = createGatewayLoopReadPort(db, () => now);
  const result = await port.list(10, undefined, options);
  expect(
    await port.validateList!(
      {
        loops: result.loops,
        truncated: result.truncated,
        observation: result.observation,
        durationMs: result.durationMs,
      },
      identity,
    ),
  ).toBe(true);
  expect(await port.validateList!(result, { ...identity, messageId: "other" })).toBe(false);
  expect(await port.validateList!({ ...result, truncated: true }, identity)).toBe(false);
  expect(
    await port.validateList!(
      { ...result, observation: { ...result.observation!, receiptId: "invented" } },
      identity,
    ),
  ).toBe(false);
  const altered = structuredClone(result);
  altered.observation!.readScope.limit = 100;
  expect(await port.validateList!(altered, identity)).toBe(false);
});

it("expires bounded observation capabilities without reviving an old turn", async () => {
  const port = createGatewayLoopReadPort(db, () => now);
  const oldest = await port.list(10, undefined, options);
  for (let i = 0; i < 32; i++) await port.list(10, undefined, options);
  expect(await port.validateList!(oldest, identity)).toBe(false);
});

it.each(["navigation", "snapshot"] as const)(
  "retains original source privacy in %s mode even after an association is removed",
  async (mode) => {
    source();
    loop("a", 0.5, ["source"]);
    const port = createGatewayLoopReadPort(db, () => now);
    const result = await port.list(10, undefined, { ...identity, mode });
    updateOpenLoop(db, "a", { docs: [] }, now + 1);
    db.prepare("DELETE FROM documents WHERE id='source'").run();
    expect(await port.validateList!(result, identity)).toBe(false);
  },
);

it("fences snapshot source generation ABA and proof changes without changing historical prose", async () => {
  source();
  loop("a", 0.5, ["source"]);
  convertKnowledgeOwner(db, "loop", "a", now);
  reconcileKnowledgeOwner(db, "loop", "a", now + 1);
  const port = createGatewayLoopReadPort(db, () => now);
  const result = await port.list(10, undefined, options);
  expect(await port.validateList!(result, identity)).toBe(true);
  db.prepare(
    "UPDATE knowledge_source_revisions SET generation=generation+2 WHERE document_id='source'",
  ).run();
  expect(await port.validateList!(result, identity)).toBe(false);
  const next = await port.list(10, undefined, options);
  db.prepare("UPDATE knowledge_claims SET verification='unverified' WHERE node_id='a'").run();
  // Use an actual semantic proof change even when a converted claim was already unverified.
  db.prepare("UPDATE knowledge_claims SET modality='intention' WHERE node_id='a'").run();
  expect(await port.validateList!(next, identity)).toBe(false);
});

async function turn(
  mode: "navigation" | "snapshot",
  verdict: "entailment" | "neutral" = "entailment",
) {
  const port = createGatewayLoopReadPort(db, () => now);
  const document = { fetch: vi.fn().mockResolvedValue(null) };
  const reads = new CitationReads();
  const registry = buildBuiltinTools({
    experimental: true,
    citationReads: reads,
    ports: { document, search: { search: vi.fn() }, loopRead: port },
  });
  const listed = await registry
    .find((tool) => tool.name === "list_loops")!
    .invoke({ mode }, identity);
  const verify = vi.fn().mockResolvedValue({ label: verdict });
  const diagnostic = vi.fn();
  const repair = vi.fn().mockResolvedValue("The records do not establish a current obligation.");
  const finalizer = createAnswerGroundingFinalizer({
    reads,
    document,
    loops: port,
    getVerifier: async () => ({ verify, dispose() {} }),
    repair,
    diagnostic,
  })({ ...identity, question: "What is recorded?" });
  finalizer.observe({
    type: "agent.tool.result",
    payload: { ...identity, toolCallId: "list", durationMs: 0, result: listed },
  });
  return { port, registry, verify, repair, finalizer, diagnostic, listed };
}
const finalInput = {
  draft: "At the recorded observation time, no active candidates were stored.",
  overflow: false,
  signal: new AbortController().signal,
};
it("never passes navigation-only factual prose through unchecked, including empty results", async () => {
  const t = await turn("navigation");
  expect(await t.finalizer.finalize(finalInput)).toBe(GROUNDING_UNKNOWN);
  expect(t.verify).not.toHaveBeenCalled();
  expect(t.diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ status: "unknown", reason: "navigation_requires_support" }),
  );
});
it("grounds a complete empty snapshot with visible historical framing despite new records", async () => {
  const t = await turn("snapshot");
  loop("new");
  const answer = await t.finalizer.finalize(finalInput);
  expect(answer).toContain(new Date(now).toISOString());
  expect(answer).toContain(finalInput.draft);
  expect(t.verify).toHaveBeenCalledTimes(1);
  const frames = (JSON.parse(t.verify.mock.calls[0]![0].evidence).evidenceParts as string[]).map(
    (part) => JSON.parse(part) as { sources: Array<{ title: string; text: string }> },
  );
  const snapshot = frames
    .flatMap((frame) => frame.sources)
    .find((source) => source.title.startsWith("Recorded tracking snapshots"))!;
  expect(JSON.parse(snapshot.text)).toMatchObject([
    { returnedCount: 0, truncated: false, loops: [] },
  ]);
  expect(t.verify.mock.calls[0]![0].context).toContain("as-of recorded-state");
});
it("does not label rejected current-world or completeness claims as historical proof", async () => {
  const t = await turn("snapshot", "neutral");
  expect(
    await t.finalizer.finalize({ ...finalInput, draft: "You have no obligations anywhere." }),
  ).toBe(GROUNDING_UNKNOWN);
  expect(t.verify).toHaveBeenCalledTimes(2);
});
it("does not invalidate a fetched-detail answer when navigation gains an unrelated member", async () => {
  loop("a");
  const t = await turn("navigation");
  const fetched = await t.registry
    .find((tool) => tool.name === "fetch_loop")!
    .invoke({ loopId: "a" }, identity);
  t.finalizer.observe({
    type: "agent.tool.result",
    payload: { ...identity, toolCallId: "fetch", durationMs: 0, result: fetched },
  });
  loop("new", 0.99);
  expect(
    await t.finalizer.finalize({
      ...finalInput,
      draft: "The system records an inspection candidate.",
    }),
  ).toBe("The system records an inspection candidate.");
  expect(t.verify.mock.calls[0]![0].evidence).not.toContain("Recorded tracking snapshots");
});
it("refuses original-member deletion during the awaited snapshot assessment", async () => {
  loop("a");
  const t = await turn("snapshot");
  t.verify.mockImplementation(async () => {
    db.prepare("DELETE FROM open_loops WHERE id='a'").run();
    return { label: "entailment" };
  });
  expect(await t.finalizer.finalize(finalInput)).toBe(GROUNDING_CHANGED);
});
it("rejects an unknown requested mode rather than falling back to navigation", async () => {
  const t = await turn("navigation");
  expect(
    await t.registry
      .find((tool) => tool.name === "list_loops")!
      .invoke({ mode: "guess" }, identity),
  ).toMatchObject({ kind: "error", code: "invalid_args" });
});

it("classifies capability refusals without changing validation or exposing identifiers", async () => {
  loop("a");
  const port = createGatewayLoopReadPort(db, () => now);
  const result = await port.list(10, undefined, options);
  const refused = vi.fn();
  expect(
    await port.validateList!({ ...result, observation: undefined }, identity, undefined, refused),
  ).toBe(false);
  expect(refused).toHaveBeenLastCalledWith("missing_observation");
  expect(
    await port.validateList!(result, { ...identity, messageId: "other" }, undefined, refused),
  ).toBe(false);
  expect(refused).toHaveBeenLastCalledWith("identity_mismatch");
  expect(
    await port.validateList!({ ...result, truncated: true }, identity, undefined, refused),
  ).toBe(false);
  expect(refused).toHaveBeenLastCalledWith("payload_mismatch");
  for (let i = 0; i < 32; i++) await port.list(10, undefined, options);
  expect(await port.validateList!(result, identity, undefined, refused)).toBe(false);
  expect(refused).toHaveBeenLastCalledWith("missing_receipt");
});

it.each(["source", "proof", "association", "owner", "privacy"] as const)(
  "classifies %s authority changes while preserving refusal",
  async (change) => {
    source();
    loop("a", 0.5, ["source"]);
    convertKnowledgeOwner(db, "loop", "a", now);
    reconcileKnowledgeOwner(db, "loop", "a", now + 1);
    const port = createGatewayLoopReadPort(db, () => now);
    const result = await port.list(10, undefined, options);
    if (change === "source")
      db.exec(
        "UPDATE knowledge_source_revisions SET generation=generation+1 WHERE document_id='source'",
      );
    if (change === "proof")
      db.exec("UPDATE knowledge_claims SET modality='intention' WHERE node_id='a'");
    if (change === "association") updateOpenLoop(db, "a", { docs: [] }, now + 2);
    if (change === "owner") db.exec("UPDATE open_loops SET created_at=created_at+1 WHERE id='a'");
    if (change === "privacy") db.exec("DELETE FROM documents WHERE id='source'");
    const refused = vi.fn();
    expect(await port.validateList!(result, identity, undefined, refused)).toBe(false);
    expect(refused).toHaveBeenCalledWith(
      {
        source: "source_changed",
        proof: "proof_changed",
        association: "association_changed",
        owner: "owner_identity_changed",
        privacy: "owner_privacy",
      }[change],
    );
  },
);

it("reports inventory subreason internally without changing the public fallback", async () => {
  loop("a");
  const t = await turn("snapshot");
  db.exec("UPDATE open_loops SET created_at=created_at+1 WHERE id='a'");
  expect(await t.finalizer.finalize(finalInput)).toBe(GROUNDING_CHANGED);
  expect(t.verify).not.toHaveBeenCalled();
  expect(t.diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "evidence_changed",
      freshnessFailure: "inventory_authority",
      inventoryFailure: "owner_identity_changed",
    }),
  );
});

it("classifies changed source membership as association rather than source generation", async () => {
  source();
  loop("a", 0.5, ["source"]);
  const port = createGatewayLoopReadPort(db, () => now);
  const result = await port.list(10, undefined, options);
  updateOpenLoop(db, "a", { docs: [] }, now + 1);
  const refused = vi.fn();
  expect(await port.validateList!(result, identity, undefined, refused)).toBe(false);
  expect(refused).toHaveBeenCalledWith("association_changed");
});

it.each(["proof", "association"] as const)(
  "permits discarding %s authority only with the original snapshot capability",
  async (change) => {
    source();
    loop("a", 0.5, ["source"]);
    convertKnowledgeOwner(db, "loop", "a", now);
    reconcileKnowledgeOwner(db, "loop", "a", now + 1);
    const port = createGatewayLoopReadPort(db, () => now);
    const result = await port.list(10, undefined, options);
    if (change === "proof")
      db.exec("UPDATE knowledge_claims SET modality='intention' WHERE node_id='a'");
    else updateOpenLoop(db, "a", { docs: [] }, now + 2);
    expect(await port.validateList!(result, identity)).toBe(false);
    expect(await port.validateListAsNavigation!(result, identity)).toBe(true);
    expect(await port.validateListAsNavigation!({ ...result, truncated: true }, identity)).toBe(
      false,
    );
    expect(await port.validateListAsNavigation!(result, { ...identity, messageId: "other" })).toBe(
      false,
    );
    expect(result.observation?.mode).toBe("snapshot");
  },
);

it.each(["source", "deleted", "identity", "ancestor"] as const)(
  "does not let earlier association drift mask a later original %s failure",
  async (change) => {
    source();
    loop("z", 0.9, ["source"]);
    loop("a", 0.5, ["source"]);
    convertKnowledgeOwner(db, "loop", "a", now);
    reconcileKnowledgeOwner(db, "loop", "a", now + 1);
    const port = createGatewayLoopReadPort(db, () => now);
    const result = await port.list(10, undefined, options);
    updateOpenLoop(db, "z", { docs: [] }, now + 2);
    if (change === "source")
      db.exec(
        "UPDATE knowledge_source_revisions SET generation=generation+2 WHERE document_id='source'",
      );
    if (change === "deleted") db.exec("DELETE FROM documents WHERE id='source'");
    if (change === "identity")
      db.exec("UPDATE open_loops SET created_at=created_at+1 WHERE id='a'");
    if (change === "ancestor") db.exec("DELETE FROM knowledge_nodes WHERE id='a'");
    expect(await port.validateListAsNavigation!(result, identity)).toBe(false);
  },
);

async function observeDetail(t: Awaited<ReturnType<typeof turn>>, id: string) {
  const result = await t.registry
    .find((tool) => tool.name === "fetch_loop")!
    .invoke({ loopId: id }, identity);
  t.finalizer.observe({
    type: "agent.tool.result",
    payload: { ...identity, toolCallId: "detail", durationMs: 0, result },
  });
}

it("discards every snapshot frame and spends one repair on independently fetched detail", async () => {
  source();
  loop("chosen");
  loop("unread", 0.5, ["source"]);
  const t = await turn("snapshot");
  await observeDetail(t, "chosen");
  updateOpenLoop(db, "unread", { docs: [] }, now + 1);
  t.repair.mockResolvedValue("The system records Inspect chosen.");
  expect(
    await t.finalizer.finalize({
      ...finalInput,
      draft: "There are two records; Inspect unread is a priority.",
    }),
  ).toBe("The system records Inspect chosen.");
  expect(t.repair).toHaveBeenCalledTimes(1);
  expect(t.verify).toHaveBeenCalledTimes(1);
  const evidence = t.verify.mock.calls[0]![0].evidence as string;
  expect(evidence).toContain("Inspect chosen");
  expect(evidence).not.toContain("Inspect unread");
  expect(evidence).not.toContain("Recorded tracking snapshots");
  expect(evidence).not.toContain("returnedCount");
  expect(t.repair.mock.calls[0]![0]).toContain("removed completely");
  expect(t.diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "supported_after_inventory_discard",
      attempts: 1,
      repairTrigger: "inventory",
    }),
  );
});

it("cannot recover changed snapshot-only answers or approve a repeated unsupported count", async () => {
  source();
  loop("unread", 0.5, ["source"]);
  const only = await turn("snapshot");
  updateOpenLoop(db, "unread", { docs: [] }, now + 1);
  expect(await only.finalizer.finalize(finalInput)).toBe(GROUNDING_CHANGED);
  expect(only.repair).not.toHaveBeenCalled();
  expect(only.verify).not.toHaveBeenCalled();
  loop("chosen");
  updateOpenLoop(db, "unread", { docs: ["source"] }, now + 2);
  const mixed = await turn("snapshot", "neutral");
  await observeDetail(mixed, "chosen");
  updateOpenLoop(db, "unread", { docs: [] }, now + 3);
  mixed.repair.mockResolvedValue("There are exactly two records.");
  expect(await mixed.finalizer.finalize(finalInput)).toBe(GROUNDING_UNKNOWN);
  expect(mixed.repair).toHaveBeenCalledTimes(1);
  expect(mixed.verify).toHaveBeenCalledTimes(1);
  expect(mixed.verify.mock.calls[0]![0].evidence).not.toContain("returnedCount");
});

it("rechecks original snapshot source generations after the powerless repair", async () => {
  source();
  loop("chosen");
  loop("unread", 0.5, ["source"]);
  convertKnowledgeOwner(db, "loop", "unread", now);
  reconcileKnowledgeOwner(db, "loop", "unread", now + 1);
  const t = await turn("snapshot");
  await observeDetail(t, "chosen");
  updateOpenLoop(db, "unread", { docs: [] }, now + 2);
  t.repair.mockImplementation(async () => {
    db.exec(
      "UPDATE knowledge_source_revisions SET generation=generation+1 WHERE document_id='source'",
    );
    return "The system records Inspect chosen.";
  });
  expect(await t.finalizer.finalize(finalInput)).toBe(GROUNDING_CHANGED);
  expect(t.repair).toHaveBeenCalledTimes(1);
  expect(t.verify).not.toHaveBeenCalled();
});

it("uses no extra verification allowance when snapshot authority changes during the first check", async () => {
  source();
  loop("chosen");
  loop("unread", 0.5, ["source"]);
  const t = await turn("snapshot");
  await observeDetail(t, "chosen");
  t.verify.mockImplementationOnce(async () => {
    updateOpenLoop(db, "unread", { docs: [] }, now + 1);
    return { label: "entailment" };
  });
  t.repair.mockResolvedValue("The system records Inspect chosen.");
  expect(await t.finalizer.finalize(finalInput)).toBe("The system records Inspect chosen.");
  expect(t.verify).toHaveBeenCalledTimes(2);
  expect(t.repair).toHaveBeenCalledTimes(1);
  expect(t.verify.mock.calls[0]![0].evidence).toContain("Recorded tracking snapshots");
  expect(t.verify.mock.calls[1]![0].evidence).not.toContain("Recorded tracking snapshots");
});

it("does not spend a second repair when a selected detail changes after inventory discard", async () => {
  source();
  loop("chosen");
  loop("unread", 0.5, ["source"]);
  const t = await turn("snapshot");
  await observeDetail(t, "chosen");
  updateOpenLoop(db, "unread", { docs: [] }, now + 1);
  t.repair.mockImplementation(async () => {
    updateOpenLoop(db, "chosen", { description: "A newly recorded stage" }, now + 2);
    return "The system records Inspect chosen.";
  });
  expect(await t.finalizer.finalize(finalInput)).toBe(GROUNDING_CHANGED);
  expect(t.repair).toHaveBeenCalledTimes(1);
  expect(t.verify).not.toHaveBeenCalled();
});
