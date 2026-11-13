// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  authorizeMcpClient,
  accessOverview,
  portalJson,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  SCOPED_SOURCE_TYPES,
  seedScopeFixture,
  prepareScopeSearch,
  pushScopeUpdates,
  hideSelectedScopeFixture,
  type ScopeFixture,
  type ScopedSourceType,
} from "./source-scope-fixtures.js";
import type { ScopeRef, SourceScopePreview, PersonMention } from "@omnesis/types";

function grant(
  source: ScopeFixture,
  capability: "direct" | "answer",
  action: "share" | "hide",
  ref = source.ref,
): Exclude<TestGrantRule, { capability: "notes" }> {
  const rule = {
    capability,
    sources: { mode: "all" as const, sourceIds: [] },
    scopePolicies: [
      {
        sourceId: source.sourceId,
        audience: { accessLevel: "new", capability },
        rules: [{ match: [ref], action }],
        otherwise: action === "share" ? ("hide" as const) : ("share" as const),
      },
    ],
  };
  return capability === "answer"
    ? { ...rule, capability, release: { mode: "unreviewed" } }
    : { ...rule, capability };
}
async function released(
  client: AuthorizedMcpClient,
  question: string,
): Promise<{ answer: string; taskId: string; status: string }> {
  const response = await client.client.callTool({
    name: "ask_omnesis",
    arguments: {
      question,
      requestId: `scope-${randomUUID()}`,
      workflowName: "Invented scope checks",
      workflowPurpose: "Read only invented records allowed by this connection.",
    },
  });
  expect(response.isError).not.toBe(true);
  let value = response.structuredContent as { answer: string; taskId: string; status: string };
  for (
    let attempt = 0;
    attempt < 120 && (value.status === "running" || value.status === "queued");
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const polled = await client.client.callTool({
      name: "get_answer_status",
      arguments: { taskId: value.taskId },
    });
    expect(polled.isError).not.toBe(true);
    value = polled.structuredContent as typeof value;
  }
  expect(value.status).toMatch(/^released/);
  return value;
}

describe.each(SCOPED_SOURCE_TYPES)(
  "%s Direct and Answer filters with a scripted synthetic agent",
  (type) => {
    let harness: SyntheticE2EHarness;
    let model: ScopeScriptedAgent;
    let baseline: AuthorizedMcpClient;
    const sources = new Map<ScopedSourceType, ScopeFixture>();
    beforeAll(async () => {
      model = await startScopeScriptedAgent();
      harness = new SyntheticE2EHarness({
        gatewayMode: "synthetic-experimental",
        universe: "e2e-minimal",
        extraInference: {
          backends: { scriptedScopes: { type: "http", url: model.url } },
          assignments: {
            agent: `scriptedScopes/${model.modelId}`,
            "privacy-reviewer": `scriptedScopes/${model.modelId}`,
          },
        },
      });
      await harness.start();
      sources.set(type, await seedScopeFixture(harness, type));
      await prepareScopeSearch(harness, [...sources.values()]);
      baseline = await authorizeMcpClient(harness, {
        principalName: "Invented existing connection",
        grantName: "Unfiltered baseline",
        credentialLabel: "Existing source permissions",
        capabilities: ["direct"],
      });
    }, 180_000);
    afterAll(async () => {
      await baseline?.client.close();
      await baseline?.transport.close();
      await harness?.destroy();
      await model?.close();
    }, 30_000);

    for (const capability of ["direct", "answer"] as const) {
      test.each(["share", "hide"] as const)(
        `${type} ${capability}: %s native IDs and inherited attachments`,
        async (action) => {
          const source = sources.get(type)!;
          const authorized = await authorizeMcpClient(harness, {
            principalName: `Invented ${type} ${capability} ${action}`,
            grantName: "Native scoped records",
            credentialLabel: "Scoped connection",
            capabilities: [capability],
            rules: [grant(source, capability, action)],
          });
          const allowed = source.samples.filter(
            (sample) => sample.kind === (action === "share" ? "selected" : "other"),
          );
          const denied = source.samples.filter((sample) => !allowed.includes(sample));
          try {
            if (capability === "direct") {
              let serialized = "";
              for (let attempt = 0; attempt < 80; attempt++) {
                await harness.refreshSearchSnapshot();
                const search = await authorized.client.callTool({
                  name: "search_many",
                  arguments: {
                    queries: [
                      {
                        query: "scopefixture",
                        filters: { sourceIds: [source.sourceId] },
                        limit: 20,
                      },
                    ],
                  },
                });
                expect(search.isError).not.toBe(true);
                serialized = JSON.stringify(search.structuredContent);
                if (allowed.every((sample) => serialized.includes(sample.id))) break;
                await new Promise((resolve) => setTimeout(resolve, 200));
              }
              for (const sample of allowed) expect(serialized).toContain(sample.id);
              for (const sample of denied) expect(serialized).not.toContain(sample.id);
              const preview = await portalJson<SourceScopePreview>(
                harness.gatewayUrl,
                authorized.portal,
                `/admin/access/source-filters/${encodeURIComponent(source.sourceId)}/preview`,
                { policy: grant(source, capability, action).scopePolicies![0] },
              );
              const reader = new Database(harness.getDbPath(), { readonly: true });
              let allIds: Array<{ id: string }>;
              try {
                allIds = reader
                  .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id=?")
                  .all(source.sourceId);
              } finally {
                reader.close();
              }
              let visible = 0;
              for (let offset = 0; offset < allIds.length; offset += 2) {
                const all = await authorized.client.callTool({
                  name: "fetch_many",
                  arguments: {
                    documents: allIds
                      .slice(offset, offset + 2)
                      .map(({ id }) => ({ documentId: id })),
                  },
                });
                expect(all.isError).not.toBe(true);
                const allResults = all.structuredContent as { items: Array<{ kind: string }> };
                visible += allResults.items.filter((item) => item.kind === "document").length;
              }
              expect(preview.visible).toBe(visible);
              expect(preview.total).toBe(allIds.length);
              expect(preview.hidden).toBe(preview.total - preview.visible);
              expect(preview.unknown).toBeGreaterThanOrEqual(1);
              for (const sample of source.samples) {
                const result = await authorized.client.callTool({
                  name: "fetch_many",
                  arguments: { documents: [{ documentId: sample.id, includeNeighbors: true }] },
                });
                expect(result.structuredContent).toMatchObject({
                  items: [{ kind: allowed.includes(sample) ? "document" : "error" }],
                });
                const raw = JSON.stringify(result.structuredContent);
                for (const hidden of denied) {
                  expect(raw).not.toContain(hidden.body);
                  expect(raw).not.toContain(hidden.id);
                }
                if (allowed.includes(sample)) expect(raw).toContain(sample.body);
                else expect(raw).not.toContain(sample.body);
                if (!sample.attachment) {
                  const lookup = await authorized.client.callTool({
                    name: "lookup_document_by_url",
                    arguments: {
                      url: `https://example.org/scoped-fixtures/${sample.externalId}`,
                    },
                  });
                  const lookupJson = JSON.stringify(lookup.structuredContent);
                  if (allowed.includes(sample)) expect(lookupJson).toContain(sample.id);
                  else expect(lookupJson).not.toContain(sample.id);
                }
                const original = await baseline.client.callTool({
                  name: "fetch_many",
                  arguments: { documents: [{ documentId: sample.id }] },
                });
                expect(original.structuredContent).toMatchObject({ items: [{ kind: "document" }] });
              }
            } else {
              const probe = model.register({
                sourceId: source.sourceId,
                documentIds: source.samples.map((sample) => sample.id),
                query: "scopefixture",
              });
              const result = await released(authorized, probe.question);
              for (const sample of allowed) expect(result.answer).toContain(sample.body);
              for (const sample of denied) {
                expect(result.answer).not.toContain(sample.body);
                expect(JSON.stringify(probe.observed.search)).not.toContain(sample.id);
                expect(JSON.stringify(probe.observed.fetched)).not.toContain(sample.body);
                expect(probe.observed.modelInputs.join("\n")).not.toContain(sample.body);
              }
              expect(probe.observed.modelInputs.length).toBeGreaterThanOrEqual(3);
              const status = await authorized.client.callTool({
                name: "get_answer_status",
                arguments: { taskId: result.taskId },
              });
              expect(status.structuredContent).toMatchObject({ answer: result.answer });
            }
          } finally {
            await authorized.client.close();
            await authorized.transport.close();
          }
        },
        60_000,
      );
    }

    if (type !== "google-drive")
      for (const capability of ["direct", "answer"] as const) {
        test.each(["share", "hide"] as const)(
          `${type} ${capability}: %s saved participant identifiers`,
          async (action) => {
            const source = sources.get(type)!;
            const ref: ScopeRef = {
              kind: "participant",
              label: "Invented selected identity",
              identifiers: [
                type === "gmail"
                  ? { type: "email", value: "selected@example.org" }
                  : { type: "phone", value: "+447700900123" },
              ],
            };
            const authorized = await authorizeMcpClient(harness, {
              principalName: `Invented participant ${type} ${capability} ${action}`,
              grantName: "Immutable identifier filter",
              credentialLabel: "Participant scoped connection",
              capabilities: [capability],
              rules: [grant(source, capability, action, ref)],
            });
            const allowed = source.samples.filter(
              (sample) => sample.kind === (action === "share" ? "selected" : "other"),
            );
            try {
              if (capability === "answer") {
                const probe = model.register({
                  sourceId: source.sourceId,
                  documentIds: source.samples.map((sample) => sample.id),
                  query: "scopefixture",
                });
                const result = await released(authorized, probe.question);
                for (const sample of source.samples)
                  if (allowed.includes(sample)) expect(result.answer).toContain(sample.body);
                  else expect(result.answer).not.toContain(sample.body);
              } else
                for (const sample of source.samples) {
                  const result = await authorized.client.callTool({
                    name: "fetch_many",
                    arguments: { documents: [{ documentId: sample.id }] },
                  });
                  expect(result.structuredContent).toMatchObject({
                    items: [{ kind: allowed.includes(sample) ? "document" : "error" }],
                  });
                }
            } finally {
              await authorized.client.close();
              await authorized.transport.close();
            }
          },
          60_000,
        );
      }
    test("filters before a one-result ranking limit can crowd out allowed records", async () => {
      const source = sources.get(type)!;
      const search = async (client: AuthorizedMcpClient) => {
        // A stale mirror intentionally hides filtered sources. Test ranking only
        // after its asynchronous replay has reached the current source generation.
        const corpus = new Database(harness.getDbPath(), { readonly: true });
        const index = new Database(join(harness.getConfigDir(), "index.db"), { readonly: true });
        try {
          await expect
            .poll(
              () => {
                const expected = corpus
                  .prepare<[string], { epoch: string; generation: number }>(
                    "SELECT c.epoch,g.generation FROM scope_source_generations g CROSS JOIN scope_generation_clock c WHERE g.source_id=? AND c.id=1",
                  )
                  .get(source.sourceId);
                const actual = index
                  .prepare<[string], { epoch: string; generation: number }>(
                    "SELECT epoch,generation FROM index_scope_generations WHERE source_id=?",
                  )
                  .get(source.sourceId);
                return {
                  expected,
                  actual,
                  ready:
                    expected !== undefined &&
                    actual?.epoch === expected.epoch &&
                    actual.generation === expected.generation,
                };
              },
              { timeout: 15_000 },
            )
            .toMatchObject({ ready: true });
        } finally {
          corpus.close();
          index.close();
        }
        await harness.refreshSearchSnapshot();
        const result = await client.client.callTool({
          name: "search_many",
          arguments: {
            queries: [
              {
                query: "scopefixture",
                filters: { sourceIds: [source.sourceId] },
                limit: 1,
              },
            ],
          },
        });
        expect(result.isError).not.toBe(true);
        const value = result.structuredContent as {
          items: Array<{ results: Array<{ documentId: string }> }>;
        };
        return value.items[0]!.results;
      };
      const original = await search(baseline);
      expect(original).toHaveLength(1);
      const winner = source.samples.find((sample) => sample.id === original[0]!.documentId)!;
      expect(winner).toBeDefined();
      const allowedKind = winner.kind === "selected" ? "other" : "selected";
      const other = source.samples.find((sample) => sample.kind === "other" && !sample.attachment)!;
      if (source.ref.kind === "participant") throw new Error("Expected a native item fixture.");
      const ref: ScopeRef =
        allowedKind === "selected" ? source.ref : { kind: source.ref.kind, id: other.externalId };
      const authorized = await authorizeMcpClient(harness, {
        principalName: "Invented ranking client",
        grantName: "One result after scope filtering",
        credentialLabel: "Ranking boundary",
        capabilities: ["direct"],
        rules: [grant(source, "direct", "share", ref)],
      });
      try {
        const limited = await search(authorized);
        expect(limited).toHaveLength(1);
        expect(source.samples.find((sample) => sample.id === limited[0]!.documentId)?.kind).toBe(
          allowedKind,
        );
        expect(limited[0]!.documentId).not.toBe(winner.id);
      } finally {
        await authorized.client.close();
        await authorized.transport.close();
      }
    }, 60_000);

    test("Direct and Answer retain independent filters on the same account", async () => {
      const source = sources.get(type)!;
      const authorized = await authorizeMcpClient(harness, {
        principalName: "Invented independent reader",
        grantName: "Different capabilities",
        credentialLabel: "Independent filters",
        capabilities: ["direct", "answer"],
        rules: [grant(source, "direct", "share"), grant(source, "answer", "hide")],
      });
      try {
        for (const sample of source.samples) {
          const value = await authorized.client.callTool({
            name: "fetch_many",
            arguments: { documents: [{ documentId: sample.id }] },
          });
          expect(value.structuredContent).toMatchObject({
            items: [{ kind: sample.kind === "selected" ? "document" : "error" }],
          });
        }
        const probe = model.register({
          sourceId: source.sourceId,
          documentIds: source.samples.map((sample) => sample.id),
          query: "scopefixture",
        });
        const answer = await released(authorized, probe.question);
        for (const sample of source.samples)
          if (sample.kind === "other") expect(answer.answer).toContain(sample.body);
          else expect(answer.answer).not.toContain(sample.body);
      } finally {
        await authorized.client.close();
        await authorized.transport.close();
      }
    }, 60_000);

    if (type !== "google-drive")
      test("a contact merge never expands saved participant identifiers", async () => {
        const source = sources.get(type)!;
        const phone = type !== "gmail";
        const chosen = phone ? "+447700900123" : "selected@example.org";
        const other = phone ? "+447700900456" : "other@example.org";
        const ref: ScopeRef = {
          kind: "participant",
          label: "Invented saved identity",
          identifiers: [
            phone ? { type: "phone", value: chosen } : { type: "email", value: chosen },
          ],
        };
        const authorized = await authorizeMcpClient(harness, {
          principalName: "Invented immutable reader",
          grantName: "Saved identifier snapshot",
          credentialLabel: "Merge check",
          capabilities: ["direct", "answer"],
          rules: [grant(source, "direct", "share", ref), grant(source, "answer", "share", ref)],
        });
        try {
          const db = new Database(harness.getDbPath(), { readonly: true });
          let people: string[];
          try {
            people = [chosen, other].map(
              (alias) =>
                db
                  .prepare<[string], { person_id: string }>(
                    "SELECT person_id FROM person_aliases WHERE alias=? LIMIT 1",
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
          for (const sample of source.samples) {
            const value = await authorized.client.callTool({
              name: "fetch_many",
              arguments: { documents: [{ documentId: sample.id }] },
            });
            expect(value.structuredContent).toMatchObject({
              items: [{ kind: sample.kind === "selected" ? "document" : "error" }],
            });
          }
          const probe = model.register({
            sourceId: source.sourceId,
            documentIds: source.samples.map((sample) => sample.id),
            query: "scopefixture",
          });
          const answer = await released(authorized, probe.question);
          for (const sample of source.samples)
            if (sample.kind === "selected") expect(answer.answer).toContain(sample.body);
            else expect(answer.answer).not.toContain(sample.body);
        } finally {
          await authorized.client.close();
          await authorized.transport.close();
        }
      }, 60_000);

    if (type === "whatsapp-messages" || type === "apple-imessage")
      test("native membership includes a silent participant on historical days and revokes a departure", async () => {
        const source = sources.get(type)!;
        const nativeState = await harness.gatewayJson<{
          scopeRefreshEpochs?: { participant?: string };
        }>(`/sync-state/${encodeURIComponent(source.sourceId)}`);
        const selected = source.samples.find(
          (sample) => sample.kind === "selected" && !sample.attachment,
        )!;
        const member: PersonMention = {
          role: "participant",
          phones: ["+447700900789"],
        };
        const speaker: PersonMention = {
          role: "participant",
          phones: ["+447700900123"],
        };
        await pushScopeUpdates(harness, source, {
          conversations: [
            {
              id: selected.externalId,
              mode: "snapshot",
              refreshEpoch: nativeState.scopeRefreshEpochs?.participant,
              observedAt: "2026-01-02T00:00:00Z",
              revision: { epoch: `invented-fixture-${type}`, sequence: 2 },
              participants: [speaker, member],
            },
          ],
        });
        const ref: ScopeRef = {
          kind: "participant",
          label: "Invented silent member",
          identifiers: [{ type: "phone", value: "+447700900789" }],
        };
        const authorized = await authorizeMcpClient(harness, {
          principalName: "Invented silent-member reader",
          grantName: "Whole conversation membership",
          credentialLabel: "Silent membership check",
          capabilities: ["direct", "answer"],
          rules: [grant(source, "direct", "share", ref), grant(source, "answer", "share", ref)],
        });
        try {
          for (const sample of source.samples) {
            const value = await authorized.client.callTool({
              name: "fetch_many",
              arguments: { documents: [{ documentId: sample.id }] },
            });
            expect(value.structuredContent).toMatchObject({
              items: [{ kind: sample.kind === "selected" ? "document" : "error" }],
            });
          }
          const probe = model.register({
            sourceId: source.sourceId,
            documentIds: source.samples.map((sample) => sample.id),
            query: "scopefixture",
          });
          const answer = await released(authorized, probe.question);
          expect(answer.answer).toContain(selected.body);
          await pushScopeUpdates(harness, source, {
            conversations: [
              {
                id: selected.externalId,
                mode: "snapshot",
                refreshEpoch: nativeState.scopeRefreshEpochs?.participant,
                observedAt: "2026-01-02T00:01:00Z",
                revision: { epoch: `invented-fixture-${type}`, sequence: 3 },
                participants: [speaker],
              },
            ],
          });
          for (const sample of source.samples) {
            const value = await authorized.client.callTool({
              name: "fetch_many",
              arguments: { documents: [{ documentId: sample.id }] },
            });
            expect(value.structuredContent).toMatchObject({ items: [{ kind: "error" }] });
          }
          const freshProbe = model.register({
            sourceId: source.sourceId,
            documentIds: source.samples.map((sample) => sample.id),
            query: "scopefixture",
          });
          const fresh = await released(authorized, freshProbe.question);
          expect(fresh.answer).not.toContain(selected.body);
        } finally {
          await authorized.client.close();
          await authorized.transport.close();
        }
      }, 60_000);

    test("native changes fence an in-flight candidate and its later status delivery", async () => {
      const source = sources.get(type)!;
      const ref: ScopeRef =
        type === "whatsapp-messages" || type === "apple-imessage"
          ? {
              kind: "participant",
              label: "Invented selected identity",
              identifiers: [{ type: "phone", value: "+447700900123" }],
            }
          : source.ref;
      const authorized = await authorizeMcpClient(harness, {
        principalName: "Invented concurrent reader",
        grantName: "Current native evidence",
        credentialLabel: "Concurrent metadata check",
        capabilities: ["direct", "answer"],
        rules: [grant(source, "direct", "share", ref), grant(source, "answer", "share", ref)],
      });
      const selected = source.samples.filter((sample) => sample.kind === "selected");
      try {
        // Catalogue renames retain native identity and permission.
        if (type === "gmail")
          await pushScopeUpdates(harness, source, {
            entities: [
              {
                kind: "label",
                id: source.ref.kind === "label" ? source.ref.id : "",
                label: "Invented renamed label",
              },
            ],
          });
        for (const sample of selected) {
          const current = await authorized.client.callTool({
            name: "fetch_many",
            arguments: { documents: [{ documentId: sample.id }] },
          });
          expect(JSON.stringify(current.structuredContent)).toContain(sample.body);
        }
        const oldProbe = model.register({
          sourceId: source.sourceId,
          documentIds: selected.map((sample) => sample.id),
          query: "scopefixture",
        });
        const oldReleased = await released(authorized, oldProbe.question);
        const probe = model.register({
          sourceId: source.sourceId,
          documentIds: selected.map((sample) => sample.id),
          query: "scopefixture",
        });
        const gate = probe.parkFinal();
        const pending = authorized.client.callTool({
          name: "ask_omnesis",
          arguments: {
            question: probe.question,
            requestId: `scope-race-${randomUUID()}`,
          },
        });
        try {
          await gate.entered;
          expect(JSON.stringify(probe.observed.fetched)).toContain(selected[0]!.body);
          await hideSelectedScopeFixture(harness, source);
        } finally {
          gate.release();
        }
        const response = await pending;
        for (const sample of selected) expect(JSON.stringify(response)).not.toContain(sample.body);
        // The very next read is denied, including the inherited attachment.
        for (const sample of selected) {
          const next = await authorized.client.callTool({
            name: "fetch_many",
            arguments: { documents: [{ documentId: sample.id }] },
          });
          expect(next.structuredContent).toMatchObject({ items: [{ kind: "error" }] });
          expect(JSON.stringify(next)).not.toContain(sample.body);
        }
        const oldStatus = await authorized.client.callTool({
          name: "get_answer_status",
          arguments: { taskId: oldReleased.taskId },
        });
        for (const sample of selected) expect(JSON.stringify(oldStatus)).not.toContain(sample.body);
        const freshProbe = model.register({
          sourceId: source.sourceId,
          documentIds: source.samples.map((sample) => sample.id),
          query: "scopefixture",
        });
        const fresh = await released(authorized, freshProbe.question);
        for (const sample of selected) {
          expect(fresh.answer).not.toContain(sample.body);
          expect(freshProbe.observed.modelInputs.join("\n")).not.toContain(sample.body);
        }
      } finally {
        await authorized.client.close();
        await authorized.transport.close();
      }
    }, 60_000);
    if (type === "gmail")
      test("a held reviewed answer cannot be approved after its native evidence leaves the filter", async () => {
        const source = sources.get(type)!;
        const other = source.samples.find(
          (sample) => sample.kind === "other" && !sample.attachment,
        )!;
        const ref: ScopeRef = { kind: "label", id: other.externalId };
        const overview = await accessOverview(harness.gatewayUrl, baseline.portal);
        const rule = grant(source, "answer", "share", ref);
        const authorized = await authorizeMcpClient(harness, {
          principalName: "Invented reviewed reader",
          grantName: "Reviewed native evidence",
          credentialLabel: "Held approval check",
          capabilities: ["answer"],
          rules: [
            {
              ...rule,
              capability: "answer",
              release: { mode: "reviewed", policyFamilyId: overview.defaultPolicyFamilyId! },
            },
          ],
        });
        try {
          const probe = model.register({
            sourceId: source.sourceId,
            documentIds: [other.id],
            query: "scopefixture",
          });
          const held = await authorized.client.callTool({
            name: "ask_omnesis",
            arguments: {
              question: probe.question,
              requestId: `scope-held-${randomUUID()}`,
            },
          });
          expect(held.isError).not.toBe(true);
          expect(held.structuredContent).toMatchObject({ status: "approval_required" });
          expect(JSON.stringify(held)).not.toContain(other.body);
          const approval = held.structuredContent as { approvalId: string; taskId: string };
          const state = await harness.gatewayJson<{ scopeRefreshEpochs?: { label?: string } }>(
            `/sync-state/${encodeURIComponent(source.sourceId)}`,
          );
          await pushScopeUpdates(harness, source, {
            documents: [
              {
                externalId: other.externalId,
                kinds: ["label"],
                facts: {
                  kinds: ["label"],
                  facts: [],
                  complete: ["label"],
                  refreshEpochs: state.scopeRefreshEpochs,
                },
              },
            ],
          });
          await expect(
            harness.gatewayJson(
              `/admin/privacy/approvals/${encodeURIComponent(approval.approvalId)}/approve`,
              {
                method: "POST",
              },
            ),
          ).rejects.toMatchObject({ status: 409 });
          const polled = await authorized.client.callTool({
            name: "get_answer_status",
            arguments: { taskId: approval.taskId },
          });
          expect(JSON.stringify(polled)).not.toContain(other.body);
          const original = await baseline.client.callTool({
            name: "fetch_many",
            arguments: { documents: [{ documentId: other.id }] },
          });
          expect(JSON.stringify(original.structuredContent)).toContain(other.body);
        } finally {
          await authorized.client.close();
          await authorized.transport.close();
        }
      }, 60_000);
  },
);
