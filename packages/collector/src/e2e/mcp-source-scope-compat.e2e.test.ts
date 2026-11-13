// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  authorizeMcpClient,
  portalJson,
  portalRequest,
  loginPortal,
  requestRule,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import {
  seedScopeFixture,
  prepareScopeSearch,
  type ScopeFixture,
} from "./source-scope-fixtures.js";
import { filteredRule, fetched, levelFor, closeScoped } from "./source-scope-external-helpers.js";

describe("source filter editor compatibility through real OAuth and gateway restart", () => {
  let harness: SyntheticE2EHarness;
  let source: ScopeFixture;
  let excluded: ScopeFixture;
  let client: AuthorizedMcpClient;
  let second: AuthorizedMcpClient | undefined;
  let afterRestart: AuthorizedMcpClient | undefined;
  const names = {
    principalName: "Invented compatibility client",
    grantName: "Saved source policy",
    credentialLabel: "Original scope credential",
    capabilities: ["direct"] as ["direct"],
  };
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      agentBackend: "replay",
    });
    await harness.start();
    source = await seedScopeFixture(harness, "apple-imessage");
    excluded = await seedScopeFixture(harness, "whatsapp-messages");
    await prepareScopeSearch(harness, [source, excluded]);
    client = await authorizeMcpClient(harness, {
      ...names,
      rules: [filteredRule(source, "direct", { mode: "allowlist", sourceIds: [source.sourceId] })],
    });
  }, 180_000);
  afterAll(async () => {
    await closeScoped(afterRestart);
    await closeScoped(second);
    await closeScoped(client);
    await harness?.destroy();
  }, 30_000);

  test("refuses legacy saves with the current level revision and cannot attach a policy to an excluded account", async () => {
    const level = await levelFor(harness, client);
    const rejected = await portalRequest(
      harness.gatewayUrl,
      client.portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: level.revision,
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      },
    );
    expect(rejected.status).toBe(409);
    const unchanged = await levelFor(harness, client);
    expect(unchanged).toEqual(level);
    const selected = source.samples.find(
      (sample) => sample.kind === "selected" && !sample.attachment,
    )!;
    const hidden = source.samples.find((sample) => sample.kind === "other" && !sample.attachment)!;
    expect(await fetched(client, selected.id)).toContain(selected.body);
    expect(await fetched(client, hidden.id)).not.toContain(hidden.body);
    const deniedSource = excluded.samples.find(
      (sample) => sample.kind === "selected" && !sample.attachment,
    )!;
    expect(await fetched(client, deniedSource.id)).not.toContain(deniedSource.body);
    const search = await client.client.callTool({
      name: "search_many",
      arguments: {
        queries: [{ query: "scopefixture", filters: { sourceIds: [excluded.sourceId] }, limit: 1 }],
      },
    });
    expect(JSON.stringify(search.structuredContent)).not.toContain(deniedSource.id);
    const outside = filteredRule(source, "direct", {
      mode: "denylist",
      sourceIds: [source.sourceId],
    });
    const refused = await portalRequest(
      harness.gatewayUrl,
      client.portal,
      "POST",
      "/admin/access/levels",
      { name: "Invented excluded policy attempt", rules: [outside] },
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "invalid-selection" });
  });

  test("a current policy edit changes an already initialized OAuth session and agrees with a new credential", async () => {
    const level = await levelFor(harness, client);
    const direct = level.rules.find((rule) => rule.capability === "direct")!;
    if (direct.capability !== "direct" || !direct.scopePolicies?.[0])
      throw new Error("Missing saved Direct policy");
    // The served rule keeps the filtered account out of the boundary a client
    // unaware of filters would copy, and states the real one beside it.
    expect(direct.sources).toEqual({ mode: "allowlist", sourceIds: [] });
    expect(direct.scopeSources).toEqual({ mode: "allowlist", sourceIds: [source.sourceId] });
    const replacement: TestGrantRule = {
      ...requestRule(direct),
      scopePolicies: [
        {
          ...direct.scopePolicies[0],
          rules: [{ action: "hide", match: [source.ref] }],
          otherwise: "share",
        },
      ],
    };
    const response = await portalJson<{ level: { revision: number } }>(
      harness.gatewayUrl,
      client.portal,
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: level.revision,
        expectedFilterRevisions: { direct: direct.filterRevision },
        rules: [replacement],
      },
      "PATCH",
    );
    expect(response.level.revision).toBeGreaterThan(level.revision);
    const selected = source.samples.find(
      (sample) => sample.kind === "selected" && !sample.attachment,
    )!;
    const other = source.samples.find((sample) => sample.kind === "other" && !sample.attachment)!;
    expect(await fetched(client, selected.id)).not.toContain(selected.body);
    expect(await fetched(client, other.id)).toContain(other.body);
    second = await authorizeMcpClient(harness, {
      ...names,
      credentialLabel: "Fresh scope credential",
      existingGrantId: client.grantId,
    });
    expect(await fetched(second, selected.id)).not.toContain(selected.body);
    expect(await fetched(second, other.id)).toContain(other.body);
  }, 60_000);

  test("saved restrictions survive an actual authoring-gate-off restart and legacy clients cannot erase them", async () => {
    const level = await levelFor(harness, client);
    await closeScoped(second);
    second = undefined;
    await closeScoped(client);
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
    const refused = await portalRequest(
      harness.gatewayUrl,
      portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: saved.revision,
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      },
    );
    expect(refused.status).toBe(409);
    const direct = saved.rules.find((rule) => rule.capability === "direct")!;
    if (direct.capability !== "direct" || !direct.scopePolicies?.length)
      throw new Error("Missing saved policy");
    const authoring = await portalRequest(
      harness.gatewayUrl,
      portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: saved.revision,
        expectedFilterRevisions: {
          direct: direct.capability === "direct" ? direct.filterRevision : 0,
        },
        rules: [
          {
            ...requestRule(direct),
            scopePolicies: direct.scopePolicies.map((policy) => ({
              ...policy,
              rules: [{ action: "share", match: [source.ref] }],
              otherwise: "hide",
            })),
          },
        ],
      },
    );
    expect(authoring.status).toBe(409);
    afterRestart = await authorizeMcpClient(harness, {
      ...names,
      credentialLabel: "Gate-off saved connection",
      existingGrantId: client.grantId,
    });
    const selected = source.samples.find(
      (sample) => sample.kind === "selected" && !sample.attachment,
    )!;
    const other = source.samples.find((sample) => sample.kind === "other" && !sample.attachment)!;
    expect(await fetched(afterRestart, selected.id)).not.toContain(selected.body);
    expect(await fetched(afterRestart, other.id)).toContain(other.body);
  }, 90_000);
});
