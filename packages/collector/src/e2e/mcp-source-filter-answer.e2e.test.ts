// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Filters against what changes around a read: a ranking limit, a second
 * capability on the same level, a merge of two people, and a record that
 * leaves a filter while an answer built from it is in flight or held for
 * approval. Through real MCP Direct and Answer connections, a scripted agent
 * and privacy reviewer, and a spawned gateway.
 *
 * The `label-filters` universe's Gmail account runs the real label code over
 * an invented mailbox; a label is taken off a message between syncs the way
 * Gmail does, and the next sync sends that message again. Asserted:
 *   - a filtered search applies the filter before its result limit, so a
 *     withheld record that ranks first cannot crowd out a shared one;
 *   - Direct and Answer on one level keep their own filters on one account;
 *   - merging two people never widens a saved person entry: it matches the
 *     addresses it was saved with, not the merged person's others;
 *   - a record that leaves a share-only filter while an answer reads it is
 *     not released in that answer, nor in an answer already released when
 *     it is read again, and the next reads are refused;
 *   - an answer held for review cannot be approved once its evidence has
 *     left the filter.
 *
 * The double is reached through a dynamic import: a static one would load the
 * synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  accessOverview,
  authorizeMcpClient,
  type AuthorizedMcpClient,
} from "./mcp-oauth-helper.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  askFiltered,
  callDirect,
  closeConnection,
  directSearchKeys,
  filterPolicy,
  openFilterConnection,
  readFilterCorpus,
  saveFilters,
  startFilterHarness,
  typedPerson,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";
import type { FilterRef } from "@omnesis/types";

const GMAIL = "gmail:maya.reeves@example.org";
const LABELS = "extra.labelIds";
const label = (id: string): FilterRef => ({ capability: "tree", field: LABELS, id });

/** The messages each label holds, as the universe starts. */
const HOLDS: Record<string, string[]> = {
  Label_work: ["atlas", "billing", "both"],
  Label_personal: ["garden", "both"],
  INBOX: ["atlas", "garden", "plain"],
};

describe("filters against ranking, merges and records that leave a filter mid-read", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let mail: FilterCorpus;
  let baseline: AuthorizedMcpClient;
  let reader: AuthorizedMcpClient;
  const failures: string[] = [];

  const body = (key: string) => mail.records.get(key)!.body;
  const id = (key: string) => mail.records.get(key)!.id;
  async function reads(client: AuthorizedMcpClient, key: string): Promise<boolean> {
    const response = await callDirect(client, "fetch_many", {
      documents: [{ documentId: id(key) }],
    });
    const items = (response.structuredContent as { items: Array<{ kind: string }> }).items;
    return items[0]!.kind === "document";
  }
  async function mailbox() {
    const mod = await import("@omnesis/provider-google-synth");
    const live = mod.getGmailTwin(GMAIL);
    if (!live) throw new Error("The Gmail double is not registered");
    return live;
  }
  /** Take a label off a message, as Gmail would, and sync the change. */
  async function unlabel(message: string, labelId: string): Promise<void> {
    (await mailbox()).removeLabel(`lf-gmail-${message}`, labelId);
    await harness.triggerSyncAndWait(GMAIL, 60_000);
    expect(failures).toEqual([]);
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("label-filters", model);
    await harness.start();
    harness.onStatusChange((change) => {
      if (change.event === "sync.error")
        failures.push(`${change.sourceId}: ${change.status.lastError ?? "unknown error"}`);
    });
    await harness.triggerSyncAndWait(GMAIL, 60_000);
    mail = readFilterCorpus(harness, GMAIL);
    baseline = await openFilterConnection(harness, ["direct"]);
    reader = await openFilterConnection(harness, ["direct", "answer"]);
  }, 300_000);

  afterAll(async () => {
    await closeConnection(reader);
    await closeConnection(baseline);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("a filtered search applies the filter before its result limit", async () => {
    const unfiltered = await directSearchKeys(baseline, mail, 1);
    expect(unfiltered.keys).toHaveLength(1);
    const winner = unfiltered.keys[0]!;
    const [labelId, shared] = Object.entries(HOLDS).find(([, keys]) => !keys.includes(winner))!;
    await saveFilters(harness, reader, [
      { access: "direct", policies: [filterPolicy(GMAIL, "direct", "share", [label(labelId)])] },
    ]);
    let limited: string[] = [];
    for (let attempt = 0; attempt < 40 && limited.length === 0; attempt++) {
      limited = (await directSearchKeys(reader, mail, 1)).keys;
      if (limited.length === 0) {
        await harness.refreshSearchSnapshot();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(limited).toHaveLength(1);
    expect(shared).toContain(limited[0]);
  });

  test("Direct and Answer on one level keep their own filters on one account", async () => {
    await saveFilters(harness, reader, [
      {
        access: "direct",
        policies: [filterPolicy(GMAIL, "direct", "share", [label("Label_work")])],
      },
      {
        access: "answer",
        policies: [filterPolicy(GMAIL, "answer", "hide", [label("Label_work")])],
      },
    ]);
    for (const key of mail.records.keys())
      expect(await reads(reader, key), key).toBe(HOLDS.Label_work!.includes(key));
    const probe = model.register({
      sourceId: GMAIL,
      documentIds: [...mail.records.values()].map((record) => record.id),
      query: mail.query,
    });
    const answer = await askFiltered(reader, probe.question);
    for (const key of mail.records.keys())
      if (HOLDS.Label_work!.includes(key)) expect(answer.answer).not.toContain(body(key));
      else expect(answer.answer).toContain(body(key));
  });

  test("merging two people never widens a saved person entry", async () => {
    const jamie = await typedPerson(harness, reader.portal, "Jamie Lopez", [
      ["email", "jamie.lopez@example.org"],
    ]);
    await saveFilters(harness, reader, [
      { access: "direct", policies: [filterPolicy(GMAIL, "direct", "share", [jamie])] },
      { access: "answer", policies: [filterPolicy(GMAIL, "answer", "share", [jamie])] },
    ]);
    const db = new Database(harness.getDbPath(), { readonly: true });
    let people: string[];
    try {
      people = ["jamie.lopez@example.org", "david.lin@example.org"].map(
        (alias) =>
          db
            .prepare<[string], { person_id: string }>(
              "SELECT person_id FROM person_aliases WHERE alias = ? LIMIT 1",
            )
            .get(alias)!.person_id,
      );
    } finally {
      db.close();
    }
    expect(new Set(people).size).toBe(2);
    await harness.gatewayJson(
      `/people/${encodeURIComponent(people[0]!)}/merge/${encodeURIComponent(people[1]!)}`,
      { method: "POST" },
    );
    const sentByJamie = ["atlas", "billing", "both"];
    for (const key of mail.records.keys())
      expect(await reads(reader, key), key).toBe(sentByJamie.includes(key));
    const probe = model.register({
      sourceId: GMAIL,
      documentIds: [...mail.records.values()].map((record) => record.id),
      query: mail.query,
    });
    const answer = await askFiltered(reader, probe.question);
    for (const key of mail.records.keys())
      if (sentByJamie.includes(key)) expect(answer.answer).toContain(body(key));
      else expect(answer.answer).not.toContain(body(key));
  });

  test("a record that leaves a share-only filter while an answer reads it is not released, then or later", async () => {
    await saveFilters(harness, reader, [
      {
        access: "direct",
        policies: [filterPolicy(GMAIL, "direct", "share", [label("Label_work")])],
      },
      {
        access: "answer",
        policies: [filterPolicy(GMAIL, "answer", "share", [label("Label_work")])],
      },
    ]);
    const work = HOLDS.Label_work!;
    const earlier = model.register({
      sourceId: GMAIL,
      documentIds: work.map(id),
      query: mail.query,
    });
    const released = await askFiltered(reader, earlier.question);
    expect(released.answer).toContain(body("billing"));

    const probe = model.register({ sourceId: GMAIL, documentIds: work.map(id), query: mail.query });
    const gate = probe.parkFinal();
    const pending = reader.client.callTool({
      name: "ask_omnesis",
      arguments: { question: probe.question, requestId: `filter-race-${randomUUID()}` },
    });
    try {
      await gate.entered;
      expect(JSON.stringify(probe.observed.fetched)).toContain(body("billing"));
      await unlabel("billing", "Label_work");
    } finally {
      gate.release();
    }
    const response = await pending;
    expect(JSON.stringify(response)).not.toContain(body("billing"));

    expect(await reads(reader, "billing")).toBe(false);
    expect(await reads(reader, "atlas")).toBe(true);
    const again = await reader.client.callTool({
      name: "get_answer_status",
      arguments: { taskId: released.taskId },
    });
    expect(JSON.stringify(again)).not.toContain(body("billing"));
    const fresh = model.register({
      sourceId: GMAIL,
      documentIds: [...mail.records.values()].map((record) => record.id),
      query: mail.query,
    });
    const answer = await askFiltered(reader, fresh.question);
    expect(answer.answer).not.toContain(body("billing"));
    expect(fresh.observed.modelInputs.join("\n")).not.toContain(body("billing"));
    expect(answer.answer).toContain(body("atlas"));
  }, 60_000);

  test("an answer held for review cannot be approved once its evidence has left the filter", async () => {
    const overview = await accessOverview(harness.gatewayUrl, baseline.portal);
    const reviewed = await authorizeMcpClient(harness, {
      principalName: "Invented reviewed reader",
      grantName: "Reviewed answers on personal mail",
      credentialLabel: "Held approval check",
      capabilities: ["answer"],
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          scopePolicies: [filterPolicy(GMAIL, "answer", "share", [label("Label_personal")])],
          release: { mode: "reviewed", policyFamilyId: overview.defaultPolicyFamilyId! },
        },
      ],
    });
    try {
      const probe = model.register({
        sourceId: GMAIL,
        documentIds: [id("garden")],
        query: mail.query,
      });
      const held = await reviewed.client.callTool({
        name: "ask_omnesis",
        arguments: { question: probe.question, requestId: `filter-held-${randomUUID()}` },
      });
      expect(held.isError).not.toBe(true);
      expect(held.structuredContent).toMatchObject({ status: "approval_required" });
      expect(JSON.stringify(held)).not.toContain(body("garden"));
      const approval = held.structuredContent as { approvalId: string; taskId: string };

      await unlabel("garden", "Label_personal");
      await expect(
        harness.gatewayJson(
          `/admin/privacy/approvals/${encodeURIComponent(approval.approvalId)}/approve`,
          { method: "POST" },
        ),
      ).rejects.toMatchObject({ status: 409 });
      const polled = await reviewed.client.callTool({
        name: "get_answer_status",
        arguments: { taskId: approval.taskId },
      });
      expect(JSON.stringify(polled)).not.toContain(body("garden"));
      expect(await reads(baseline, "garden")).toBe(true);
    } finally {
      await closeConnection(reviewed);
    }
  }, 60_000);
});
