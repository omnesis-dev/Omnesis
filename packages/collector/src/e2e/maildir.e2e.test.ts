// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * The synthetic Maildir on a real gateway.
 *
 * The twin writes the universe's messages into a Maildir tree and runs the
 * real source over it, so this covers the real parser, local index and
 * snapshot through a spawned gateway: one document per message however many
 * folders hold it, the folders as tags, search, and people that join the
 * same identities the universe's other mail sources name.
 */
describe("Synthetic provider — Maildir", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "maildir:mail-synth-johnsmith";

  const db = () => new Database(harness.getDbPath(), { readonly: true });
  const documents = () => {
    const handle = db();
    try {
      return handle
        .prepare<
          [string],
          { id: string; external_id: string; title: string; metadata: string }
        >("SELECT id, external_id, title, metadata FROM documents WHERE source_id = ? ORDER BY title")
        .all(sourceId);
    } finally {
      handle.close();
    }
  };
  /** Person ids and roles on documents of `source`, for an email alias. */
  const appearances = (email: string) => {
    const handle = db();
    try {
      return handle
        .prepare<[string], { source_id: string; title: string; role: string; person_id: string }>(
          `SELECT d.source_id, d.title, dp.role, COALESCE(p.merged_into, p.id) AS person_id
             FROM person_aliases a
             JOIN people p ON p.id = a.person_id
             JOIN document_people dp ON dp.person_id = p.id
             JOIN documents d ON d.id = dp.document_id
            WHERE a.alias_type = 'email' AND a.alias = ?`,
        )
        .all(email);
    } finally {
      handle.close();
    }
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(sourceId, 60_000);
    await harness.triggerSyncAndWait("gmail:john.smith@example.com", 60_000);
    await harness.refreshSearchSnapshot();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("indexes one document per message, tagged with every folder holding it", () => {
    const rows = documents();
    expect(rows.map((r) => r.title)).toEqual([
      "Bike club ride on Saturday",
      "Globex workshop agenda",
      "Re: Bike club ride on Saturday",
    ]);
    const workshop = JSON.parse(
      rows.find((r) => r.title === "Globex workshop agenda")!.metadata,
    ) as {
      tags: string[];
      extra: { flagged?: boolean };
    };
    expect(workshop.tags).toEqual(["INBOX", "STARRED", "Work"]);
    expect(workshop.extra.flagged).toBe(true);
  });

  test("messages are searchable by their body", async () => {
    const res = await harness.gatewayJson<{ results?: Array<{ title: string }> }>(
      `/documents/search?q=${encodeURIComponent("river loop")}&sources=${encodeURIComponent(sourceId)}&limit=10`,
    );
    expect((res.results ?? []).map((r) => r.title)).toContain("Bike club ride on Saturday");
  });

  test("a correspondent is the same person as in the universe's Gmail", async () => {
    await vi.waitFor(
      () => {
        const carol = appearances("carol.nakamura@globex.example");
        const maildir = carol.find((a) => a.source_id === sourceId);
        const gmail = carol.find((a) => a.source_id === "gmail:john.smith@example.com");
        expect(maildir?.role).toBe("sender");
        expect(maildir?.title).toBe("Globex workshop agenda");
        expect(gmail).toBeDefined();
        expect(maildir!.person_id).toBe(gmail!.person_id);
      },
      { timeout: 30_000, interval: 250 },
    );
    const alex = appearances("alex.chen@globex.example").filter((a) => a.source_id === sourceId);
    expect(alex.map((a) => a.role)).toEqual(["recipient"]);
  });

  test("a second sync of an unchanged tree changes nothing", async () => {
    const before = documents();
    await harness.triggerSyncAndWait(sourceId, 60_000);
    expect(documents()).toEqual(before);
  });
});
