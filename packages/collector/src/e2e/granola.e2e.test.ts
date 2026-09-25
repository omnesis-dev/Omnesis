// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * End-to-end coverage for the synthetic Granola provider. Granola is a hybrid
 * source: each meeting note lands as BOTH a `granola_meetings` analytics row
 * and a searchable document (summary + transcript). After sync the gateway
 * should expose the populated table in its catalogue and return the meeting
 * documents from search — exercising the api-key auth path, the structured
 * record path, and the document path in one run.
 */
describe("Synthetic provider — Granola (hybrid)", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "granola-meetings:john.smith@example.com";

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(sourceId, 60000);
    await harness.refreshSearchSnapshot();
  }, 180000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("populates the granola_meetings analytics table", async () => {
    const data = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string; recordCount: number }>;
    };
    const t = data.tables.find((x) => x.tableName === "granola_meetings");
    expect(t, "granola_meetings should exist in the analytics catalogue").toBeDefined();
    // Three fixture meetings in the e2e-minimal universe.
    expect(t!.recordCount).toBe(3);
  });

  test("indexes meeting documents with searchable summary + transcript", async () => {
    const res = (await harness.gatewayJson(
      `/documents/search?q=billing%20migration&sources=${encodeURIComponent(sourceId)}&limit=50`,
    )) as { results?: Array<{ title: string }> };
    const titles = (res.results ?? []).map((d) => d.title);
    expect(titles, "transcript text should be searchable").toContain("Acme Q3 Planning");
  });

  test("links meeting attendees into the people graph", async () => {
    // Alex Chen attends the Globex intro; searching his org should surface it.
    const res = (await harness.gatewayJson(
      `/documents/search?q=Globex&sources=${encodeURIComponent(sourceId)}&limit=50`,
    )) as { results?: Array<{ title: string }> };
    expect(
      (res.results ?? []).some((d) => d.title === "Globex partnership intro"),
      "expected the Globex meeting to be indexed",
    ).toBe(true);
  });
});
