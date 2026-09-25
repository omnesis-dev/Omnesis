// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { isStateEnvelope, withVersionedState } from "@omnesis/source-sdk";
import definition from "@omnesis/provider-obsidian";
import { SyncEngine } from "../sync-engine.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { RegisteredSource } from "../sync-engine-types.js";

describe("real filesystem lifecycle through the collector", () => {
  const sourceId = SourceId("obsidian-notes:fixture");
  const providerId = ProviderId("obsidian:fixture");
  let harness: MultiCollectorHarness;
  let gateway: HttpGatewayClient;
  let engine: SyncEngine;
  let source: RegisteredSource;
  let scratch: string;
  let vault: string;

  const note = (name: string, id: string, title: string) =>
    writeFileSync(
      join(vault, name),
      `---\nid: ${id}\ntitle: ${title}\n---\n# ${title}\nFictional test content.\n`,
    );
  const documents = async () =>
    (await gateway.listDocuments({ limit: 100 })).documents.filter((d) => d.sourceId === sourceId);
  const sync = async () => {
    await engine.syncSource(source);
    expect(engine.getStatuses().find((status) => status.sourceId === sourceId)?.state).toBe("idle");
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-filesystem-e2e-"));
    vault = join(scratch, "Vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    harness = new MultiCollectorHarness();
    await harness.start();
    const collector = await harness.addCollector({
      name: "filesystem-fixture",
      hostableSourceTypes: ["obsidian-notes"],
    });
    gateway = new HttpGatewayClient(harness.gatewayUrl, collector.token);
    const registration = await gateway.bulkUpsertSources([
      { type: SourceType("obsidian-notes"), accountId: AccountId("fixture"), enabled: true },
    ]);
    expect(registration.errors).toEqual([]);
    const instance = await definition.create!({
      accountId: "fixture",
      sourceId,
      providerId,
      config: { vaultPath: vault, exclude: [] },
    });
    source = {
      id: sourceId,
      providerId,
      name: "Fixture vault",
      family: { name: "Obsidian" },
      instance: withVersionedState(instance, definition.contract!.state!, { sourceId }),
    };
    engine = new SyncEngine(gateway);
    engine.registerProvider({
      id: providerId,
      name: "Fixture vault",
      renewableCredential: false,
      credentialState: async () => ({ status: "connected" }),
      sources: [source],
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 20_000);

  test("legacy upgrade, updates and moves preserve IDs; unreadable files do not block sibling deletions", async () => {
    note("held.md", "held", "Retained note");
    note("moving.md", "moving", "Original title");
    note("deleted.md", "deleted", "Deleted note");
    await sync();
    expect(await documents()).toHaveLength(3);

    // Restore the bare cursor an older collector stored, then upgrade in place.
    const installed = await gateway.getSyncState(sourceId);
    expect(isStateEnvelope(installed!.cursor)).toBe(true);
    if (!isStateEnvelope(installed!.cursor)) throw new Error("Missing state envelope");
    await gateway.setSyncState(sourceId, installed!.cursor.state);
    await sync();
    expect(isStateEnvelope((await gateway.getSyncState(sourceId))!.cursor)).toBe(true);
    expect(await documents()).toHaveLength(3);

    const beforeMove = (await documents()).find((d) => d.title === "moving")!;
    renameSync(join(vault, "moving.md"), join(vault, "moved.md"));
    note("moved.md", "moving", "Updated title");
    renameSync(join(vault, "held.md"), join(scratch, "held.md"));
    symlinkSync(join(scratch, "absent-target"), join(vault, "held.md"));
    rmSync(join(vault, "deleted.md"));
    for (let cycle = 0; cycle < 3; cycle++) {
      await sync();
      const current = await documents();
      expect(current.map((d) => d.title).sort()).toEqual(["held", "moved"]);
      expect(current.find((d) => d.title === "moved")!.id).toBe(beforeMove.id);
      const updated = await harness.json<{ content: string }>(`/documents/${beforeMove.id}`);
      expect(updated.content).toContain("Updated title");
    }

    note("new.md", "new", "New note");
    await sync();
    expect(await documents()).toHaveLength(3);
    rmSync(join(vault, "new.md"));
    await sync();
    expect(await documents()).toHaveLength(2);

    rmSync(join(vault, "held.md"));
    renameSync(join(scratch, "held.md"), join(vault, "held.md"));
    await sync();
    expect(await documents()).toHaveLength(2);
    rmSync(join(vault, "held.md"));
    await sync();
    expect((await documents()).map((d) => d.title)).toEqual(["moved"]);
  }, 60_000);
});
