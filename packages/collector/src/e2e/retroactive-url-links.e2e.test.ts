// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * URL-target ownership across source arrival orders.
 *
 * Boots a real isolated gateway with paired synthetic sources, writes through
 * the production `/documents` path, and deterministically runs the real
 * link-backfill and link-reconcile jobs. Each scenario uses an invented GitHub
 * URL so the normal known-source keep gate preserves a transcript link before
 * its target exists.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import {
  isCollectorOnline,
  MultiCollectorHarness,
  type PairedCollector,
  waitForCondition,
} from "./multi-collector-harness.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const TRANSCRIPTS = "synth-transcripts:local";
const OWNER = "synth-github:local";
const BOOKMARKS = "synth-bookmarks:local";
const GITHUB_PATTERNS = [{ regex: "github\\.com/[^/]+/[^/]+/pull/(\\d+)" }];
const SCENARIO_PULL_NUMBER: Record<string, number> = {
  "transcript-capture-owner": 101,
  "transcript-owner-capture": 102,
  "capture-transcript-owner": 103,
  "bookmark-transcript-owner": 104,
  "transcript-bookmark-only": 105,
  "owner-bookmark-transcript": 106,
  "capture-owner-transcript": 107,
  "offline-roster-resume": 108,
};

interface LinkState {
  linkCount: number;
  targetSourceId: string | null;
  sameResourceCount: number;
}

describe("retroactive URL links across synthetic source arrival orders", () => {
  let harness: MultiCollectorHarness;
  let collector: PairedCollector;
  let traversalCollector: PairedCollector;
  let offlineCollector: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
    });
    await harness.start();
    collector = await harness.addCollector({
      name: "url-role-collector",
      hostableSourceTypes: ["synth-transcripts", "synth-github", "synth-bookmarks"],
      descriptors: [
        descriptor("synth-transcripts"),
        descriptor("synth-github"),
        { ...descriptor("synth-bookmarks"), urlHub: true, urlTargetRole: "reference" },
      ],
    });
    traversalCollector = await harness.addCollector({
      name: "traversal-role-collector",
      hostableSourceTypes: ["synth-browser-history"],
      descriptors: [{ ...descriptor("synth-browser-history"), urlHub: true }],
    });
    offlineCollector = await harness.addCollector({
      name: "paired-but-offline-collector",
      hostableSourceTypes: ["synth-retired-host"],
    });
    offlineCollector.ws.disconnect();
    await waitForCondition(
      async () => !(await isCollectorOnline(harness, offlineCollector.deviceId)),
      10_000,
      "paired synthetic collector to disconnect",
    );
    // Both active pseudo-collectors publish one complete generation before
    // link work becomes ready; partial legacy field pushes cannot form a
    // mixed bundle. The harness bootstrap credential is an admin token, not a
    // collector declaration authority, so it deliberately does not publish.
    await postDeclarations(collector.token, {
      traversalHubPrefixes: ["synth-bookmarks"],
      fallbackRepresentationPrefixes: ["web"],
      referenceOnlyPrefixes: ["synth-bookmarks"],
      patterns: GITHUB_PATTERNS,
    });
    await postDeclarations(traversalCollector.token, {
      traversalHubPrefixes: ["synth-browser-history"],
      fallbackRepresentationPrefixes: [],
      referenceOnlyPrefixes: [],
      patterns: GITHUB_PATTERNS,
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  test("transcript → capture → owner retargets and retains the capture", async () => {
    const scenario = "transcript-capture-owner";
    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: null, sameResourceCount: 0 });

    await pushCapture(scenario);
    await expectState(scenario, { targetSourceId: "web", sameResourceCount: 0 });

    await pushOwner(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 1 });
  });

  test("transcript → owner → capture keeps the owner and adds identity context", async () => {
    const scenario = "transcript-owner-capture";
    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: null, sameResourceCount: 0 });

    await pushOwner(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 0 });

    await pushCapture(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 1 });
  });

  test("capture → transcript → owner first uses fallback, then heals to owner", async () => {
    const scenario = "capture-transcript-owner";
    await pushCapture(scenario);
    await runLinkJobs();

    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: "web", sameResourceCount: 0 });

    await pushOwner(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 1 });
  });

  test("bookmark → transcript → owner never lets the bookmark claim the URL", async () => {
    const scenario = "bookmark-transcript-owner";
    await pushBookmark(scenario);
    await runLinkJobs();

    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: null, sameResourceCount: 0 });

    await pushOwner(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 0 });
  });

  test("transcript → bookmark without an owner remains unresolved", async () => {
    const scenario = "transcript-bookmark-only";
    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: null, sameResourceCount: 0 });

    await pushBookmark(scenario);
    await expectState(scenario, { targetSourceId: null, sameResourceCount: 0 });
  });

  test("owner → bookmark → transcript resolves directly to the owner", async () => {
    const scenario = "owner-bookmark-transcript";
    await pushOwner(scenario);
    await pushBookmark(scenario);
    await runLinkJobs();

    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 0 });
  });

  test("capture → owner creates identity context before a transcript arrives", async () => {
    const scenario = "capture-owner-transcript";
    await pushCapture(scenario);
    await pushOwner(scenario);

    let state: LinkState | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runLinkJobs();
      state = readState(scenario);
      if (state.linkCount === 0 && state.sameResourceCount === 1) break;
    }
    expect(state, JSON.stringify(readDiagnostics(scenario))).toEqual({
      linkCount: 0,
      targetSourceId: null,
      sameResourceCount: 1,
    });

    await pushTranscript(scenario);
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 1 });
  });

  test("rejects incomplete or contradictory URL-role declarations", async () => {
    const incomplete = await fetch(`${harness.gatewayUrl}/admin/url-graph-roles`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ traversalHubPrefixes: ["synth-bookmarks"] }),
    });
    expect(incomplete.status).toBe(400);

    const overlap = await fetch(`${harness.gatewayUrl}/admin/url-graph-roles`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        traversalHubPrefixes: [],
        fallbackRepresentationPrefixes: ["synth-bookmarks"],
        referenceOnlyPrefixes: ["synth-bookmarks"],
      }),
    });
    expect(overlap.status).toBe(400);
  });

  test("merges modern collectors and stays unready during a legacy-device transition", async () => {
    const response = await fetch(`${harness.gatewayUrl}/admin/url-graph-roles`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      traversalHubPrefixes: string[];
      fallbackRepresentationPrefixes: string[];
      referenceOnlyPrefixes: string[];
      ready: boolean;
    };
    expect(body.traversalHubPrefixes).toEqual(
      expect.arrayContaining(["web", "synth-bookmarks", "synth-browser-history"]),
    );
    expect(body.fallbackRepresentationPrefixes).toContain("web");
    expect(body.referenceOnlyPrefixes).toContain("synth-bookmarks");
    expect(body.ready).toBe(true);

    const legacy = await fetch(`${harness.gatewayUrl}/admin/url-hub-sources`, {
      method: "POST",
      headers: headers(traversalCollector.token),
      body: JSON.stringify({ prefixes: ["synth-browser-history"] }),
    });
    expect(legacy.status).toBe(200);
    const mixed = (await (
      await fetch(`${harness.gatewayUrl}/admin/url-graph-roles`, { headers: headers() })
    ).json()) as { ready: boolean };
    expect(mixed.ready).toBe(false);

    await postDeclarations(traversalCollector.token, {
      traversalHubPrefixes: ["synth-browser-history"],
      fallbackRepresentationPrefixes: [],
      referenceOnlyPrefixes: [],
      patterns: GITHUB_PATTERNS,
    });
    const upgraded = (await (
      await fetch(`${harness.gatewayUrl}/admin/url-graph-roles`, { headers: headers() })
    ).json()) as { ready: boolean };
    expect(upgraded.ready).toBe(true);
  });

  test("ignores an offline paired collector, pauses on reconnect, and resumes on disconnect", async () => {
    const offlineDeclaration = await fetch(`${harness.gatewayUrl}/admin/link-declarations`, {
      method: "POST",
      headers: headers(offlineCollector.token),
      body: JSON.stringify({
        canonicalizers: [],
        traversalHubPrefixes: [],
        fallbackRepresentationPrefixes: [],
        referenceOnlyPrefixes: [],
        patterns: [],
      }),
    });
    expect(offlineDeclaration.status).toBe(403);

    await harness.reconnectCollector(offlineCollector);

    const scenario = "offline-roster-resume";
    await pushOwner(scenario);
    await pushTranscript(scenario);
    await runLinkJobs();
    expect(readState(scenario)).toEqual({
      linkCount: 0,
      targetSourceId: null,
      sameResourceCount: 0,
    });

    offlineCollector.ws.disconnect();
    await waitForCondition(
      async () => !(await isCollectorOnline(harness, offlineCollector.deviceId)),
      10_000,
      "paired synthetic collector to disconnect again",
    );
    await expectState(scenario, { targetSourceId: OWNER, sameResourceCount: 0 });
  });

  test("recanonicalizes through the real reader-worker boundary using data-only rules", async () => {
    const rawUrl = "https://review.example.com/u/0/item/transport-check";
    const canonicalUrl = "https://review.example.com/item/transport-check";
    await harness.pushDocuments(
      collector,
      [
        {
          sourceId: OWNER,
          externalId: "canonicalizer-worker-transport",
          title: "Synthetic canonicalizer transport check",
          content: "Invented document used to exercise reader-worker transport.",
          metadata: { documentType: "pull-request", sourceUrl: rawUrl },
        },
      ],
      { token: harness.bootstrapToken },
    );

    const declarations = await fetch(`${harness.gatewayUrl}/admin/link-declarations`, {
      method: "POST",
      headers: headers(collector.token),
      body: JSON.stringify({
        canonicalizers: [
          {
            hosts: ["review.example.com"],
            rules: [
              {
                match: "^https://review\\.example\\.com/u/\\d+/(.*)$",
                replacement: "https://review.example.com/$1",
              },
            ],
          },
        ],
        traversalHubPrefixes: ["synth-bookmarks"],
        fallbackRepresentationPrefixes: ["web"],
        referenceOnlyPrefixes: ["synth-bookmarks"],
        patterns: GITHUB_PATTERNS,
      }),
    });
    expect(declarations.status).toBe(200);

    const recompute = await fetch(
      `${harness.gatewayUrl}/admin/url-canonicalizers/recompute-source-urls`,
      { method: "POST", headers: headers(), body: "{}" },
    );
    expect(recompute.status, await recompute.text()).toBe(200);

    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const row = db
        .prepare<
          [string],
          { source_url: string }
        >("SELECT source_url FROM documents WHERE external_id = ?")
        .get("canonicalizer-worker-transport");
      expect(row?.source_url).toBe(canonicalUrl);
    } finally {
      db.close();
    }
  });

  function descriptor(id: string): Record<string, unknown> {
    return {
      id,
      name: `Synthetic ${id}`,
      description: `invented ${id} source`,
      provider: { id: `${id}-provider`, name: `Synthetic ${id} Provider` },
      params: [],
      hasAuthFlow: false,
      hasDiscover: false,
      authType: "local",
      pushBased: true,
      singleInstance: true,
    };
  }

  function scenarioUrl(scenario: string): string {
    return `https://github.com/northstar-labs/example-repo/pull/${SCENARIO_PULL_NUMBER[scenario]}`;
  }

  function headers(token = harness.bootstrapToken): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  async function postDeclarations(
    token: string,
    body: {
      traversalHubPrefixes: string[];
      fallbackRepresentationPrefixes: string[];
      referenceOnlyPrefixes: string[];
      patterns: Array<{ regex: string }>;
    },
  ): Promise<void> {
    const response = await fetch(`${harness.gatewayUrl}/admin/link-declarations`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ canonicalizers: [], ...body }),
    });
    expect(response.status).toBe(200);
  }

  async function pushTranscript(scenario: string): Promise<void> {
    await harness.pushDocuments(
      collector,
      [
        {
          sourceId: TRANSCRIPTS,
          externalId: `transcript-${scenario}`,
          title: `Synthetic session ${scenario}`,
          content: `Review ${scenarioUrl(scenario)}`,
          metadata: { documentType: "conversation" },
        },
      ],
      { token: harness.bootstrapToken },
    );
  }

  async function pushOwner(scenario: string): Promise<void> {
    await harness.pushDocuments(
      collector,
      [
        {
          sourceId: OWNER,
          externalId: `owner-${scenario}`,
          title: `Synthetic pull request ${scenario}`,
          content: `Structured change request for ${scenario}.`,
          metadata: { documentType: "pull-request", sourceUrl: scenarioUrl(scenario) },
        },
      ],
      { token: harness.bootstrapToken },
    );
  }

  async function pushCapture(scenario: string): Promise<void> {
    await harness.pushDocuments(
      collector,
      [
        {
          sourceId: "web",
          externalId: `capture-${scenario}`,
          title: `Captured pull request ${scenario}`,
          content: `Rendered browser capture for ${scenario}.`,
          metadata: { documentType: "webpage", sourceUrl: scenarioUrl(scenario) },
        },
      ],
      { token: harness.bootstrapToken },
    );
  }

  async function pushBookmark(scenario: string): Promise<void> {
    await harness.pushDocuments(
      collector,
      [
        {
          sourceId: BOOKMARKS,
          externalId: `bookmark-${scenario}`,
          title: `Saved pull request ${scenario}`,
          content: `Saved pointer for ${scenario}.`,
          metadata: { documentType: "bookmark", sourceUrl: scenarioUrl(scenario) },
        },
      ],
      { token: harness.bootstrapToken },
    );
  }

  async function runTask(taskName: string): Promise<void> {
    try {
      await harness.json(`/admin/background/run/${taskName}?timeoutMs=120000`, {
        method: "POST",
      });
    } catch (error) {
      const body = (error as { body?: unknown }).body;
      throw new Error(
        `failed to run ${taskName}: ${body === undefined ? String(error) : JSON.stringify(body)}\n${harness.getGatewayOutput()}`,
        { cause: error },
      );
    }
  }

  async function runLinkJobs(): Promise<void> {
    await runTask("backfill.linkBatch");
    await runTask("backfill.linkReconcile");
  }

  async function expectState(
    scenario: string,
    expected: Omit<LinkState, "linkCount">,
  ): Promise<void> {
    let last: LinkState | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      await runLinkJobs();
      last = readState(scenario);
      if (
        last.linkCount === 1 &&
        last.targetSourceId === expected.targetSourceId &&
        last.sameResourceCount === expected.sameResourceCount
      ) {
        return;
      }
    }
    expect(last, JSON.stringify({ state: last, diagnostics: readDiagnostics(scenario) })).toEqual({
      linkCount: 1,
      ...expected,
    });
  }

  function readDiagnostics(scenario: string): unknown {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return {
        documents: db
          .prepare(
            "SELECT external_id, source_id, source_url FROM documents WHERE external_id LIKE ? OR external_id LIKE ? ORDER BY external_id",
          )
          .all(`%-${scenario}`, `%${scenario}%`),
        links: db
          .prepare(
            `SELECT dl.id, dl.link_type, dl.normalized_target, dl.target_doc_id
               FROM document_links dl
               JOIN documents source ON source.id = dl.source_doc_id
              WHERE source.external_id LIKE ?
              ORDER BY dl.id`,
          )
          .all(`%${scenario}%`),
        reconcileState: db.prepare("SELECT * FROM link_reconcile_state WHERE id = 1").get(),
        devices: db.prepare("SELECT id, revoked_at FROM devices ORDER BY id").all(),
        transcript: db
          .prepare(
            "SELECT external_id, links_extracted_at, content FROM documents WHERE external_id = ?",
          )
          .get(`transcript-${scenario}`),
        pending: db
          .prepare("SELECT COUNT(*) AS count FROM documents WHERE links_extracted_at IS NULL")
          .get(),
      };
    } finally {
      db.close();
    }
  }

  function readState(scenario: string): LinkState {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const link = db
        .prepare<[string], { link_count: number; target_source_id: string | null }>(
          `SELECT COUNT(*) AS link_count, target.source_id AS target_source_id
             FROM document_links dl
             JOIN documents source ON source.id = dl.source_doc_id
             LEFT JOIN documents target ON target.id = dl.target_doc_id
            WHERE source.external_id = ? AND dl.link_type = 'url'`,
        )
        .get(`transcript-${scenario}`);
      const sameResource = db
        .prepare<[string], { count: number }>(
          `SELECT COUNT(*) AS count
             FROM document_links dl
             JOIN documents source ON source.id = dl.source_doc_id
            WHERE source.external_id = ? AND dl.link_type = 'same-resource'`,
        )
        .get(`capture-${scenario}`);
      return {
        linkCount: link?.link_count ?? 0,
        targetSourceId: link?.target_source_id ?? null,
        sameResourceCount: sameResource?.count ?? 0,
      };
    } finally {
      db.close();
    }
  }
});
