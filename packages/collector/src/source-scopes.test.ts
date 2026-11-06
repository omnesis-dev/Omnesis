// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { allDefinitions } from "./source-descriptors.js";
import { collectSourceScopes, SourceManager } from "./source-manager.js";
import type { GatewayClient } from "@omnesis/source-sdk";
import type { SyncEngine } from "./sync-engine.js";

const declarations = collectSourceScopes(allDefinitions);
describe("collector source scope declarations", () => {
  it("publishes the provider-owned declarations for all four V1 sources before accounts are added", () => {
    expect(declarations.map((entry) => entry.sourceType)).toEqual([
      "apple-imessage",
      "gmail",
      "google-drive",
      "whatsapp-messages",
    ]);
    const byType = new Map(declarations.map((entry) => [entry.sourceType, entry.scopes]));
    expect(byType.get("google-drive")?.items.map((item) => item.kind)).toEqual(["folder"]);
    expect(byType.get("gmail")?.items.map((item) => item.kind)).toEqual(["participant", "label"]);
    for (const type of ["apple-imessage", "whatsapp-messages"]) {
      expect(byType.get(type)?.items.map((item) => item.kind)).toEqual([
        "conversation",
        "participant",
      ]);
    }
  });
  it("publishes through the optional gateway seam without configuring source accounts", async () => {
    const setSourceScopes = vi.fn(async () => {});
    const manager = new SourceManager(
      {} as SyncEngine,
      { setSourceScopes } as unknown as GatewayClient,
      {},
    );
    await manager.pushSourceScopes();
    expect(setSourceScopes).toHaveBeenCalledWith(declarations);
  });
  it("tolerates legacy gateway implementations and failed metadata publication", async () => {
    const legacy = new SourceManager({} as SyncEngine, {} as GatewayClient, {});
    await expect(legacy.pushSourceScopes()).resolves.toBeUndefined();
    const failing = new SourceManager(
      {} as SyncEngine,
      {
        setSourceScopes: vi.fn(async () => {
          throw new Error("offline");
        }),
      } as unknown as GatewayClient,
      {},
    );
    await expect(failing.pushSourceScopes()).resolves.toBeUndefined();
  });
});
