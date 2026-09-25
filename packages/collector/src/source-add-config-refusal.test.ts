// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Settings offered for a new source are checked before the gateway hears of
 * it. Checked only at setup, a refused add left the gateway holding a source
 * that never started and reported an error on every tick.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WsInvalidInputError } from "@omnesis/core";
import { config as configSchema, defineSource } from "@omnesis/source-sdk";
import { ProviderType, SourceType } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import { SourceManager } from "./source-manager.js";
import type { GatewayClient, SourceDescriptor } from "@omnesis/source-sdk";

const TYPE = "shelf-notes";

const source = defineSource({
  id: TYPE,
  name: "Shelf notes",
  description: "Invented notes read from a folder",
  authType: "local",
  config: configSchema.object({
    folder: configSchema.path({ label: "Folder", required: true, mustExist: "directory" }),
  }),
  create: async () => ({
    sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  }),
});

const descriptor: SourceDescriptor = {
  id: SourceType(TYPE),
  name: "Shelf notes",
  description: "Invented notes read from a folder",
  provider: { id: ProviderType(TYPE), name: "Shelf notes" },
  authType: "local",
};

describe("settings for a new source are checked before the gateway hears of it", () => {
  let tmpDir: string;
  let upserted: string[];
  let manager: SourceManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-config-refusal-"));
    upserted = [];
    const gateway = {
      async bulkUpsertSources(sources: Array<{ type: string; accountId: string; id?: string }>) {
        const ids = sources.map((s) => s.id ?? `${s.type}:${s.accountId}`);
        upserted.push(...ids);
        return {
          count: ids.length,
          sources: ids.map((id) => ({ id, updated: false })),
          errors: [],
        };
      },
      async setKnownUrlPatterns() {},
      async setWidgetRenderers() {},
      async setDocumentEventProfiles() {},
      async setLinkDeclarations() {},
      async setSourcePriorDefaults() {},
      async setUrlGraphRoles() {},
      async declareSelfIdentitySources() {},
      async setAnalyticsSchema() {},
      async updateSourceMeta() {},
    } as unknown as GatewayClient;
    manager = new SourceManager(
      new SyncEngine(gateway),
      gateway,
      {},
      {
        definitions: [source],
        descriptors: [descriptor],
        configPath: join(tmpDir, "collector.json"),
        configDir: tmpDir,
      },
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const add = (params: Record<string, string>) =>
    manager.addSources({ descriptorId: TYPE, accountIds: ["shelf"], params });

  test.each([
    ["a missing required setting", {}, /Folder/],
    [
      "a folder that does not exist",
      { folder: "/nowhere/shelf" },
      /does not exist: \/nowhere\/shelf/,
    ],
    [
      "a setting the source does not declare",
      { folder: "/tmp", colour: "blue" },
      /unknown setting "colour"/,
    ],
  ])(
    "%s is refused as invalid input, and nothing is registered",
    async (_label, params, message) => {
      const refusal = add(params);
      await expect(refusal).rejects.toBeInstanceOf(WsInvalidInputError);
      await expect(refusal).rejects.toThrow(message);
      expect(upserted).toEqual([]);
    },
  );

  test("valid settings are registered", async () => {
    const folder = join(tmpDir, "shelf");
    mkdirSync(folder);
    await add({ folder });
    expect(upserted).toEqual([`${TYPE}:shelf`]);
  });
});
