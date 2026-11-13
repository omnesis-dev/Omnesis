// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { allDefinitions } from "./source-descriptors.js";
import { collectSourceScopes, SourceManager } from "./source-manager.js";
import type { GatewayClient } from "@omnesis/source-sdk";
import type { SyncEngine } from "./sync-engine.js";

const declarations = collectSourceScopes(allDefinitions);
describe("collector source scope declarations", () => {
  it("publishes the provider-owned declarations of every filterable source before accounts are added", () => {
    expect(declarations.map((entry) => entry.sourceType)).toEqual([
      "apple-imessage",
      "claude-code",
      "codex",
      "github",
      "github-commits",
      "gmail",
      "google-drive",
      "local-files",
      "pi",
      "whatsapp-messages",
    ]);
    const byType = new Map(declarations.map((entry) => [entry.sourceType, entry.scopes]));
    for (const type of ["google-drive", "claude-code", "codex", "local-files", "pi"])
      expect(byType.get(type)?.items.map((item) => item.kind)).toEqual(["folder"]);
    // A tree whose levels are different things names each of them.
    for (const type of ["github", "github-commits"]) {
      const [tree] = byType.get(type)!.items;
      expect(tree).toMatchObject({ kind: "folder", picker: "tree", link: "hierarchy" });
      expect(tree!.kind === "folder" && tree.levels?.map((level) => level.one)).toEqual([
        "owner",
        "repository",
      ]);
    }
    expect(byType.get("gmail")?.items.map((item) => item.kind)).toEqual(["participant", "label"]);
    for (const type of ["apple-imessage", "whatsapp-messages"]) {
      expect(byType.get(type)?.items.map((item) => item.kind)).toEqual([
        "conversation",
        "participant",
      ]);
    }
  });
  it("publishes every known declaration through its sync engine, without source accounts", async () => {
    const pushSourceScopes = vi.fn(async () => {});
    const manager = new SourceManager(
      { pushSourceScopes } as unknown as SyncEngine,
      {} as GatewayClient,
      {},
    );
    await manager.pushSourceScopes();
    expect(pushSourceScopes).toHaveBeenCalledWith(declarations);
  });
});
