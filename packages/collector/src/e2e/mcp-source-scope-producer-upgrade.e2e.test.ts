// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { GatewayWsClient } from "@omnesis/gateway-client";
import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  authorizeMcpClient,
  portalJson,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import type { DeviceCapability, ScopeRef, SourceScopeOptions } from "@omnesis/types";

let harness: SyntheticE2EHarness;
let model: ScopeScriptedAgent;
const clients: AuthorizedMcpClient[] = [];
const sockets: GatewayWsClient[] = [];
const currentSockets = new Map<string, GatewayWsClient>();
function read<T>(work: (db: SqliteDatabase.Database) => T): T {
  const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
  try {
    return work(db);
  } finally {
    db.close();
  }
}
async function connect(
  token: string,
  capabilities: DeviceCapability,
  deviceId: string,
): Promise<GatewayWsClient> {
  currentSockets.get(deviceId)?.disconnect();
  const socket = new GatewayWsClient(harness.gatewayUrl, token, { capabilities });
  sockets.push(socket);
  currentSockets.set(deviceId, socket);
  socket.connect();
  await expect.poll(() => socket.isAuthenticated(), { timeout: 10_000 }).toBe(true);
  return socket;
}
async function fetch(client: AuthorizedMcpClient, documentId: string) {
  const result = await client.client.callTool({
    name: "fetch_many",
    arguments: { documents: [{ documentId }] },
  });
  return result.structuredContent as { items: Array<{ kind: string }> };
}
/** Inspect actual tool strings as well as the enclosing JSON request envelope. */
function modelText(inputs: string[]): string {
  const text: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      text.push(value);
      try {
        const nested: unknown = JSON.parse(value);
        if (typeof nested !== "string") walk(nested);
      } catch {
        /* ordinary model text */
      }
    } else if (value && typeof value === "object")
      for (const item of Object.values(value)) walk(item);
  };
  for (const input of inputs) walk(input);
  return text.join("\n");
}
async function answer(client: AuthorizedMcpClient, question: string): Promise<string> {
  const result = await client.client.callTool({
    name: "ask_omnesis",
    arguments: {
      question,
      requestId: randomUUID(),
      workflowName: "Invented producer upgrade",
      workflowPurpose: "Read only permitted invented source records.",
    },
  });
  let value = result.structuredContent as { taskId?: string; status?: string };
  for (
    let attempt = 0;
    attempt < 120 && (value?.status === "running" || value?.status === "queued");
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await client.client.callTool({
      name: "get_answer_status",
      arguments: { taskId: value.taskId },
    });
    value = next.structuredContent as typeof value;
  }
  expect(value?.status).not.toMatch(/^(running|queued)$/);
  return JSON.stringify(value);
}
function rules(sourceId: string, capability: "direct" | "answer", ref: ScopeRef): TestGrantRule[] {
  const rule = {
    capability,
    sources: { mode: "allowlist" as const, sourceIds: [sourceId] },
    filterRevision: 0,
    scopePolicies: [
      {
        sourceId,
        audience: { accessLevel: "new", capability },
        rules: [{ match: [ref], action: "share" as const }],
        otherwise: "hide" as const,
      },
    ],
  };
  return [
    capability === "answer"
      ? { ...rule, capability, release: { mode: "unreviewed" } }
      : { ...rule, capability },
  ];
}
beforeAll(async () => {
  model = await startScopeScriptedAgent();
  harness = new SyntheticE2EHarness({
    gatewayMode: "synthetic-experimental",
    universe: "e2e-minimal",
    extraInference: {
      backends: { scriptedProducer: { type: "http", url: model.url } },
      assignments: {
        agent: `scriptedProducer/${model.modelId}`,
        "privacy-reviewer": `scriptedProducer/${model.modelId}`,
      },
    },
  });
  await harness.start();
}, 180_000);
afterEach((context) => {
  if (context.task.result?.state !== "fail" || !harness) return;
  const directory = mkdtempSync(join(tmpdir(), "scope-producer-diagnostics-"));
  copyFileSync(harness.getGatewayLogPath(), join(directory, "gateway.log"));
  console.warn(`Synthetic gateway diagnostics retained: ${directory}`);
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  for (const client of clients) {
    await client.client.close();
    await client.transport.close();
  }
  await harness?.destroy();
  await model?.close();
}, 30_000);

for (const type of ["whatsapp-messages", "apple-imessage", "gmail", "google-drive"] as const)
  test(`${type}: actual fixture producer restores required native proof after an authenticated collector upgrade`, async () => {
    const sourceId = harness.getSourceIds().find((id) => id.startsWith(`${type}:`))!;
    const host = harness.getDevices().find((device) => device.sourceIds.includes(sourceId))!;
    await harness.triggerSyncAndWait(sourceId, 60_000, host);
    await expect
      .poll(
        async () => {
          await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", {
            method: "POST",
          });
          return read(
            (db) =>
              !!db
                .prepare("SELECT 1 FROM scope_fact_backfill WHERE source_id=? AND ready=1")
                .get(sourceId),
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
    const baseline = await authorizeMcpClient(harness, {
      principalName: `Invented ${type} upgrade setup`,
      grantName: "Producer baseline",
      credentialLabel: "Baseline",
      capabilities: ["direct"],
    });
    clients.push(baseline);
    const docs = read((db) =>
      db
        .prepare<[string], { id: string; content: string }>(
          "SELECT id,content FROM documents WHERE source_id=? AND json_extract(metadata,'$.documentType') IS NOT 'attachment' ORDER BY id",
        )
        .all(sourceId),
    );
    expect(docs.length).toBeGreaterThan(1);
    const kind = type === "gmail" ? "label" : type === "google-drive" ? "folder" : "participant";
    const options = await portalJson<SourceScopeOptions>(
      harness.gatewayUrl,
      baseline.portal,
      `/admin/access/source-filters/${encodeURIComponent(sourceId)}/options?kind=${kind}`,
    );
    const candidates = [...options.items];
    let chosen = candidates.find((item) => item.count > 0 && item.count < docs.length);
    const visited = new Set<string>();
    for (let depth = 0; !chosen && depth < 20; depth++) {
      const branch = candidates.find(
        (item) => item.hasChildren && item.ref.kind !== "participant" && !visited.has(item.ref.id),
      );
      if (!branch || branch.ref.kind === "participant") break;
      const parentId = branch.ref.id;
      visited.add(parentId);
      const children = await portalJson<SourceScopeOptions>(
        harness.gatewayUrl,
        baseline.portal,
        `/admin/access/source-filters/${encodeURIComponent(sourceId)}/options?kind=${kind}&parentId=${encodeURIComponent(parentId)}`,
      );
      candidates.push(...children.items);
      chosen = candidates.find((item) => item.count > 0 && item.count < docs.length);
    }
    expect(chosen, JSON.stringify(candidates)).toBeTruthy();
    const direct = await authorizeMcpClient(harness, {
      principalName: `Invented ${type} upgrade direct`,
      grantName: "Producer direct",
      credentialLabel: "Direct",
      capabilities: ["direct"],
      rules: rules(sourceId, "direct", chosen!.ref),
    });
    clients.push(direct);
    const delegated = await authorizeMcpClient(harness, {
      principalName: `Invented ${type} upgrade answer`,
      grantName: "Producer answer",
      credentialLabel: "Answer",
      capabilities: ["answer"],
      rules: rules(sourceId, "answer", chosen!.ref),
    });
    clients.push(delegated);
    let allowed: (typeof docs)[number] | undefined;
    let hidden: (typeof docs)[number] | undefined;
    for (const doc of docs) {
      const result = await fetch(direct, doc.id);
      if (result.items[0]?.kind === "document") allowed ??= doc;
      else hidden ??= doc;
    }
    expect(allowed).toBeTruthy();
    expect(hidden).toBeTruthy();
    const before = read((db) =>
      db
        .prepare<[string], { id: string; content_hash: string }>(
          "SELECT id,content_hash FROM documents WHERE source_id=? ORDER BY id",
        )
        .all(sourceId),
    );
    const capabilities = read(
      (db) =>
        JSON.parse(
          db
            .prepare<[string], { capabilities: string }>(
              "SELECT capabilities FROM devices WHERE id=?",
            )
            .get(host.deviceId)!.capabilities,
        ) as DeviceCapability,
    );
    const { sourceScopes: _scopes, ...legacy } = capabilities;
    host.ws?.disconnect();
    const old = await connect(host.token, legacy, host.deviceId);
    await expect
      .poll(
        () =>
          read(
            (db) =>
              db
                .prepare<[string, string], { active: number }>(
                  "SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind=?",
                )
                .get(sourceId, kind)?.active,
          ),
        { timeout: 10_000 },
      )
      .toBe(1);
    expect((await fetch(direct, allowed!.id)).items[0]?.kind).toBe("error");
    const fenced = model.register({
      sourceId,
      documentIds: [allowed!.id, hidden!.id],
      query: "invented",
    });
    const fencedReply = modelText([await answer(delegated, fenced.question)]);
    expect(fencedReply).not.toContain(allowed!.content);
    expect(modelText(fenced.observed.modelInputs)).not.toContain(allowed!.content);
    old.disconnect();
    await connect(host.token, capabilities, host.deviceId);
    await harness.triggerSyncAndWait(sourceId, 60_000, host);
    await harness.refreshSearchSnapshot();
    await expect
      .poll(
        async () => {
          // Folder omission pruning and its deferred release use the real bounded worker.
          await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", {
            method: "POST",
          });
          return read(
            (db) =>
              db
                .prepare<[string, string], { active: number }>(
                  "SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind=?",
                )
                .get(sourceId, kind)?.active,
          );
        },
        { timeout: 20_000 },
      )
      .toBe(0);
    const proof = read((db) => {
      const requirement = db
        .prepare<[string, string], { epoch: string; request_id: string }>(
          "SELECT epoch,request_id FROM source_scope_refresh_requirements WHERE source_id=? AND kind=?",
        )
        .get(sourceId, kind)!;
      const count = db
        .prepare<[string, string, string, string], { n: number }>(
          `SELECT COUNT(*) AS n FROM scope_native_refresh_witnesses w WHERE w.kind=? AND w.epoch=? AND w.document_id IN (SELECT id FROM documents WHERE source_id=? UNION SELECT subject_document_id FROM scope_conversations WHERE source_id=?)`,
        )
        .get(kind, requirement.epoch, sourceId, sourceId)!.n;
      return { requirement, count };
    });
    expect(proof.requirement.request_id).toEqual(expect.any(String));
    expect(proof.count).toBeGreaterThan(0);
    expect((await fetch(direct, allowed!.id)).items[0]?.kind).toBe("document");
    expect((await fetch(direct, hidden!.id)).items[0]?.kind).toBe("error");
    const restored = model.register({
      sourceId,
      documentIds: [allowed!.id, hidden!.id],
      query: "invented",
    });
    const restoredReply = modelText([await answer(delegated, restored.question)]);
    expect(modelText(restored.observed.modelInputs)).toContain(allowed!.content);
    expect(restoredReply).toContain(allowed!.content);
    expect(restoredReply).not.toContain(hidden!.content);
    expect(modelText(restored.observed.modelInputs)).not.toContain(hidden!.content);
    const after = read((db) =>
      db
        .prepare<[string], { id: string; content_hash: string }>(
          "SELECT id,content_hash FROM documents WHERE source_id=? ORDER BY id",
        )
        .all(sourceId),
    );
    expect(after).toEqual(before);
  }, 120_000);
