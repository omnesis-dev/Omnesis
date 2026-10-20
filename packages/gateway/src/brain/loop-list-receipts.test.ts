// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../db.js";
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
    if (change === "privacy")
      db.exec(
        "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','a','deleted',1)",
      );
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
