// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The owner's filter editor and the saving of filters, through the portal's
 * routes, real OAuth connections and a spawned gateway that is restarted with
 * filter editing switched off.
 *
 * The `repository-filters` universe has two GitHub sources on one computer.
 * Issues and pull requests are read by the current build, so their
 * repository field can be filtered on. Commits are first read by a build at
 * version 1, which predates the field, then by the current build without a
 * resync. Asserted:
 *   - the editor reports each field's state with the sentence the gateway
 *     writes for it, and the two counts: records too old for the field, and
 *     records new enough that cannot be placed;
 *   - a new entry on a field that is not ready is refused with that same
 *     sentence, and the level is left as it was;
 *   - an external agent's credential, an integration's or a collector's
 *     never reaches the owner's filter routes;
 *   - a level approved with a filter serves its real source boundary beside
 *     the one an older client would copy, and enforces the filter;
 *   - a save that omits the level's filter revisions is refused instead of
 *     erasing its filters, and a filter cannot name an account the rule
 *     excludes;
 *   - after a restart with filter editing switched off, a saved filter is
 *     still enforced for a new credential, the editor still opens for the
 *     account it filters, and neither an older client nor an edit can change
 *     it.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultScopesForDeviceKind, type FilterRef } from "@omnesis/types";
import {
  authorizeMcpClient,
  loginPortal,
  portalJson,
  portalRequest,
  requestRule,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  callDirect,
  closeConnection,
  closeFilterContext,
  filterEditor,
  filterPolicy,
  levelFor,
  openFilterContext,
  readFilterCorpus,
  startFilterHarness,
  trySaveFilters,
  type FilterContext,
  type FilterCorpus,
  type FilterEditor,
} from "./source-filter-corpus.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";

const THREADS = "github:maya-reeves";
const COMMITS = "github-commits:maya-reeves";
const FIELD = "extra.repositoryIds";
const NORTHSTAR: FilterRef = { capability: "tree", field: FIELD, id: "owner:9001" };
const ATLAS: FilterRef = { capability: "tree", field: FIELD, id: "4101" };

describe("the filter editor, refused saves, owner-only routes and saved filters across a restart", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  let threads: FilterCorpus;
  let commits: FilterCorpus;
  /** A connection approved with a share-only filter on the issues account, and that account alone. */
  let approved: AuthorizedMcpClient;
  let afterRestart: AuthorizedMcpClient | undefined;
  const names = {
    principalName: "Invented approved reader",
    grantName: "Approved with a filter",
    credentialLabel: "Approved credential",
    capabilities: ["direct"] as ["direct"],
  };

  const field = (editor: FilterEditor) => editor.fields.find((entry) => entry.field === FIELD)!;
  /** Whether a Direct fetch of one record returns it. */
  async function reads(client: AuthorizedMcpClient, id: string): Promise<boolean> {
    const response = await callDirect(client, "fetch_many", { documents: [{ documentId: id }] });
    const items = (response.structuredContent as { items: Array<{ kind: string }> }).items;
    return items[0]!.kind === "document";
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("repository-filters", model);
    await harness.start();
    harness.setSourceVersion(COMMITS, 1);
    await harness.triggerSyncAndWait(THREADS, 60_000);
    await harness.triggerSyncAndWait(COMMITS, 60_000);
    threads = readFilterCorpus(harness, THREADS);
    commits = readFilterCorpus(harness, COMMITS);
    context = await openFilterContext(harness, model);
    approved = await authorizeMcpClient(harness, {
      ...names,
      rules: [
        {
          capability: "direct",
          sources: { mode: "allowlist", sourceIds: [THREADS] },
          scopePolicies: [filterPolicy(THREADS, "direct", "share", [NORTHSTAR])],
        },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await closeConnection(afterRestart);
    await closeConnection(approved);
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("a field the account can filter on is ready, and counts the records it cannot place", async () => {
    const editor = await filterEditor(harness, context.portal, THREADS);
    expect(editor).toMatchObject({ profile: "declared", profileText: null });
    expect(field(editor)).toMatchObject({
      state: { status: "ready" },
      // The issue of the repository GitHub gives no id for.
      counts: {
        status: "ready",
        tooOld: 0,
        unmatched: 1,
        tooOldText: null,
        unmatchedText: "1 record can’t be matched to a repository and stays hidden.",
      },
    });
  });

  test("a new entry on a field whose host runs an older build is refused with the editor's sentence", async () => {
    const editor = await filterEditor(harness, context.portal, COMMITS);
    const behind = field(editor);
    expect(behind.state).toEqual({
      status: "collector-behind",
      devices: [
        { id: harness.deviceForSource(COMMITS).deviceId, name: "Studio-Northstar-workstation" },
      ],
      text: "Update Omnesis on Studio-Northstar-workstation to use these filters.",
    });
    expect(behind.counts).toMatchObject({
      status: "ready",
      tooOld: commits.records.size,
      tooOldText: expect.stringMatching(/^6 older items/),
    });

    const client = context.direct[0]!;
    const before = await levelFor(harness, client);
    const refused = await trySaveFilters(harness, client, [
      { access: "direct", policies: [filterPolicy(COMMITS, "direct", "share", [NORTHSTAR])] },
    ]);
    expect(refused).toEqual({
      status: 409,
      body: { error: "invalid-selection", message: (behind.state as { text: string }).text },
    });
    expect(await levelFor(harness, client)).toEqual(before);
  });

  test("once the host is updated, the field needs a resync, and a new entry is refused with that sentence", async () => {
    harness.setSourceVersion(COMMITS, 2);
    await harness.triggerSyncAndWait(COMMITS, 60_000);
    const state = field(await filterEditor(harness, context.portal, COMMITS)).state;
    expect(state).toMatchObject({ status: "needs-resync", cost: expect.stringMatching(/GitHub/) });
    const needsResync = state as { status: "needs-resync"; cost: string; text: string };
    expect(needsResync.text).toContain(needsResync.cost);

    const refused = await trySaveFilters(harness, context.direct[1]!, [
      { access: "direct", policies: [filterPolicy(COMMITS, "direct", "hide", [ATLAS])] },
    ]);
    expect(refused).toEqual({
      status: 409,
      body: { error: "invalid-selection", message: needsResync.text },
    });
  });

  test("an external agent's credential, an integration's and a collector's never reach the owner's filter routes", async () => {
    const document = threads.records.get("atlas-issue")!.id;
    const owner = `/admin/access/source-filters/${encodeURIComponent(THREADS)}`;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", owner],
      ["GET", `${owner}/options?field=${encodeURIComponent(FIELD)}`],
      ["POST", `${owner}/preview`, { policy: filterPolicy(THREADS, "direct", "share", [ATLAS]) }],
      ["POST", "/admin/access/source-filters/identifiers", { type: "phone", value: "+1 555 0100" }],
      ["GET", `/admin/documents/${encodeURIComponent(document)}/filter-details`],
      ["GET", `/admin/documents/${encodeURIComponent(document)}/access`],
    ];
    const agentToken = context.direct[0]!.provider.savedTokens!.access_token;
    // A collector as one pairs: it reads its configuration and writes what it syncs.
    const collector = await harness.gatewayJson<{ token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "Invented second collector",
        kind: "collector",
        scopes: defaultScopesForDeviceKind("collector"),
      }),
    });
    const level = await levelFor(harness, context.answer);
    const pending = await portalJson<{ pairingCode: string }>(
      harness.gatewayUrl,
      context.portal,
      "/admin/devices/pair",
      {
        name: "Invented filtered integration",
        kind: "integration",
        scopes: ["answer"],
        accessLevelId: level.id,
      },
    );
    const integration = await harness.gatewayJson<{ token: string }>("/devices/pair", {
      method: "POST",
      body: JSON.stringify({ pairingCode: pending.pairingCode }),
    });
    for (const token of [agentToken, collector.token, integration.token])
      for (const [method, path, body] of routes) {
        const response = await fetch(`${harness.gatewayUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect([401, 403], `${method} ${path}`).toContain(response.status);
        expect(await response.text()).not.toContain("atlas-api");
      }
    for (const [method, path, body] of routes) {
      const response = await portalRequest(
        harness.gatewayUrl,
        context.portal,
        method as "GET" | "POST",
        path,
        body,
      );
      expect(response.status, `${method} ${path}`).toBe(200);
    }
  });

  test("a level approved with a filter serves its real boundary beside the one an older client copies, and enforces it", async () => {
    const level = await levelFor(harness, approved);
    const direct = level.rules.find((rule) => rule.capability === "direct")!;
    if (direct.capability !== "direct") throw new Error("unreachable");
    expect(direct.sources).toEqual({ mode: "allowlist", sourceIds: [] });
    expect(direct.scopeSources).toEqual({ mode: "allowlist", sourceIds: [THREADS] });
    expect(direct.scopePolicies).toEqual([
      {
        ...filterPolicy(THREADS, "direct", "share", [NORTHSTAR]),
        audience: { accessLevel: level.id, capability: "direct" },
      },
    ]);
    expect(await reads(approved, threads.records.get("atlas-issue")!.id)).toBe(true);
    expect(await reads(approved, threads.records.get("garden-issue")!.id)).toBe(false);
    // The other account is outside the allowlist.
    expect(await reads(approved, commits.records.get("atlas-commit")!.id)).toBe(false);
  });

  test("a save that omits the filter revisions is refused, and a filter cannot name an account its rule excludes", async () => {
    const level = await levelFor(harness, approved);
    const legacy = await portalRequest(
      harness.gatewayUrl,
      approved.portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: level.revision,
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      },
    );
    expect(legacy.status).toBe(409);
    expect(await levelFor(harness, approved)).toEqual(level);
    expect(await reads(approved, threads.records.get("garden-issue")!.id)).toBe(false);

    const excluded: TestGrantRule = {
      capability: "direct",
      sources: { mode: "denylist", sourceIds: [THREADS] },
      scopePolicies: [filterPolicy(THREADS, "direct", "share", [NORTHSTAR])],
    };
    const refused = await portalRequest(
      harness.gatewayUrl,
      approved.portal,
      "POST",
      "/admin/access/levels",
      { name: "Invented excluded filter attempt", rules: [excluded] },
    );
    expect(refused).toEqual({ status: 409, body: { error: "invalid-selection" } });
  });

  test("after a restart with filter editing off, a saved filter holds for a new credential and nothing can change it", async () => {
    const level = await levelFor(harness, approved);
    await closeConnection(approved);
    await closeFilterContext(context);
    await harness.restartGateway({ gatewayMode: "stable" });
    expect((await harness.gatewayJson<{ experimental: boolean }>("/status")).experimental).toBe(
      false,
    );
    const portal = await loginPortal(harness);
    const overview = await portalJson<{
      levels: Array<{ id: string; rules: TestGrantRule[]; revision: number }>;
    }>(harness.gatewayUrl, portal, "/admin/access");
    const saved = overview.levels.find((candidate) => candidate.id === level.id)!;
    expect(saved.rules).toEqual(level.rules);

    // The editor still opens for the account a saved filter names, and for no other.
    const editor = await portalRequest(
      harness.gatewayUrl,
      portal,
      "GET",
      `/admin/access/source-filters/${encodeURIComponent(THREADS)}`,
    );
    expect(editor.status).toBe(200);
    const closed = await portalRequest(
      harness.gatewayUrl,
      portal,
      "GET",
      `/admin/access/source-filters/${encodeURIComponent(COMMITS)}`,
    );
    expect(closed.status).toBe(404);

    const legacy = await portalRequest(
      harness.gatewayUrl,
      portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: saved.revision,
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      },
    );
    expect(legacy.status).toBe(409);
    const direct = saved.rules.find((rule) => rule.capability === "direct")!;
    if (direct.capability !== "direct" || !direct.scopePolicies?.length)
      throw new Error("Missing saved filter");
    const edit = await portalRequest(
      harness.gatewayUrl,
      portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: saved.revision,
        expectedFilterRevisions: { direct: direct.filterRevision },
        rules: [
          {
            ...requestRule(direct),
            scopePolicies: direct.scopePolicies.map((policy) => ({
              ...policy,
              rules: [{ action: "hide", match: [NORTHSTAR] }],
              otherwise: "share",
            })),
          },
        ],
      },
    );
    expect(edit.status).toBe(409);

    afterRestart = await authorizeMcpClient(harness, {
      ...names,
      credentialLabel: "Credential after the restart",
      existingGrantId: approved.grantId,
    });
    expect(await reads(afterRestart, threads.records.get("atlas-issue")!.id)).toBe(true);
    expect(await reads(afterRestart, threads.records.get("garden-issue")!.id)).toBe(false);
    expect(await reads(afterRestart, threads.records.get("sketches-issue")!.id)).toBe(false);
  }, 120_000);
});
