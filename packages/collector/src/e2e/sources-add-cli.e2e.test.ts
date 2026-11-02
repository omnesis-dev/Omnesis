// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis sources add` without a terminal, through the real CLI binary.
 *
 * A real gateway, a real collector (source manager, sync engine and command
 * channel) hosting the real Obsidian source, and a vault on disk. The CLI is
 * exec'd with pipes for stdin and stdout — what automation, an agent or `ssh`
 * without a tty gives it — so nothing may be prompted: settings come from
 * `--set`, `sources describe` says which keys there are, and every refusal
 * exits non-zero naming the flag that fixes it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import obsidianDefinition from "@omnesis/provider-obsidian";
import { SourceType } from "@omnesis/types";
import { extractDescriptors } from "../source-descriptors.js";
import { SourceManager } from "../source-manager.js";
import { createSourceWsHandlers } from "../source-ws-handlers.js";
import { SyncEngine } from "../sync-engine.js";
import { createCommandDispatch } from "../ws-command-dispatch.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { CollectorInternalConfig } from "../internal-config.js";

const SOURCE_TYPE = "obsidian-notes";
const DEVICE_NAME = "notes-host";
/** `EXIT_USER_ERROR` from `@omnesis/cli-shared`, which this package does not depend on. */
const EXIT_USER_ERROR = 2;
const CLI_TIMEOUT_MS = 60_000;

const CAPABILITIES = {
  hostname: "notes-host.example.com",
  platform: "linux",
  hostableSourceTypes: [SourceType(SOURCE_TYPE)],
  memberScopedParams: Object.fromEntries(
    extractDescriptors(obsidianDefinition).map((d) => [d.id, d.memberScopedParamNames ?? []]),
  ),
};

describe("sources add with no terminal, through the CLI binary", () => {
  let harness: MultiCollectorHarness;
  let scratch: string;
  let vault: string;
  let plainFolder: string;
  let ws: GatewayWsClient;
  let engine: SyncEngine;

  const cli = (args: string[]) => harness.runCli(args, { timeoutMs: CLI_TIMEOUT_MS });
  const registered = () => engine.getStatuses().map((s) => s.sourceId);

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-add-cli-e2e-"));
    vault = join(scratch, "field-notes-vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(
      join(vault, "Marathon plan.md"),
      "# Marathon plan\n\nFictional training notes.\n",
    );
    plainFolder = join(scratch, "plain-folder");
    mkdirSync(plainFolder);

    harness = new MultiCollectorHarness();
    await harness.start();
    const paired = await harness.json<{ device: { id: string }; token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: DEVICE_NAME,
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: CAPABILITIES,
      }),
    });

    const gateway = new HttpGatewayClient(harness.gatewayUrl, paired.token);
    engine = new SyncEngine(gateway);
    const manager = new SourceManager(
      engine,
      gateway,
      { sources: {}, defaultSyncInterval: "999999s" } satisfies CollectorInternalConfig,
      {
        definitions: [obsidianDefinition],
        descriptors: extractDescriptors(obsidianDefinition),
        configDir: join(scratch, "collector-config"),
      },
    );
    ws = new GatewayWsClient(harness.gatewayUrl, paired.token, { capabilities: CAPABILITIES });
    const sourceHandlers = createSourceWsHandlers({
      sourceManager: manager,
      gateway,
      emitEvent: (type, payload) => ws.emitEvent(type, payload),
    });
    const commands = createCommandDispatch();
    commands.register("sources.snapshot", async ({ sources }) => {
      await manager.applySourcesSnapshot(sources);
      return { ok: true, applied: sources.length };
    });
    commands.register("source.added", async ({ source }) => {
      if (source) await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: Boolean(source) };
    });
    commands.register("source.updated", async ({ source }) => {
      if (source) await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: Boolean(source) };
    });
    commands.register("source.sync", () => ({
      ok: true,
      triggered: 0,
      skipped: 0,
      disabled: 0,
      restarting: 0,
    }));
    ws.onCommand(async (command) => {
      const handled = sourceHandlers.handle(command);
      if (handled !== undefined) return handled;
      const byEngine = commands.handle(command);
      if (byEngine !== undefined) return byEngine;
      throw new Error(`Unhandled collector command ${command.type}`);
    });
    ws.connect();
    await waitForCondition(
      () => Promise.resolve(ws.isAuthenticated()),
      10_000,
      "collector connected",
    );
  }, 120_000);

  afterAll(async () => {
    ws?.disconnect();
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  test("`sources describe` names the keys an add takes, as JSON for a program", async () => {
    const r = await cli(["sources", "describe", SOURCE_TYPE, "--device", DEVICE_NAME, "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const described = JSON.parse(r.stdout) as {
      id: string;
      keys: Array<{ key: string; kind: string; required: boolean; type: string }>;
      example: string;
    };
    expect(described.id).toBe(SOURCE_TYPE);
    expect(described.keys).toContainEqual(
      expect.objectContaining({ key: "vaultPath", kind: "setting", required: true, type: "path" }),
    );
    expect(described.example).toContain("--set vaultPath=");
  });

  test("a setting nobody gave fails non-zero naming --set, and registers nothing", async () => {
    const r = await cli(["sources", "add", SOURCE_TYPE, "--device", DEVICE_NAME]);
    expect(r.exitCode).toBe(EXIT_USER_ERROR);
    expect(r.stderr).toContain("no terminal");
    expect(r.stderr).toContain("--set vaultPath=");
    expect(r.stdout).not.toContain("Vault path");
    expect(registered()).toEqual([]);
  });

  test("a folder the source refuses fails non-zero with the collector's reason", async () => {
    const r = await cli([
      "sources",
      "add",
      SOURCE_TYPE,
      "--device",
      DEVICE_NAME,
      "--set",
      `vaultPath=${plainFolder}`,
    ]);
    expect(r.exitCode).toBe(EXIT_USER_ERROR);
    expect(r.stderr).toContain("Not an Obsidian vault");
    expect(registered()).toEqual([]);
  });

  test("an unknown key is refused before the collector is asked", async () => {
    const r = await cli(["sources", "add", SOURCE_TYPE, "--set", `vault=${vault}`]);
    expect(r.exitCode).toBe(EXIT_USER_ERROR);
    expect(r.stderr).toContain('has no setting named "vault"');
    expect(r.stderr).toContain("vaultPath");
  });

  test("`--set` adds it unattended — named by provider, the only collector chosen for it", async () => {
    const r = await cli(["sources", "add", "obsidian", "--set", `vaultPath=${vault}`]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("added successfully");
    await waitForCondition(
      () => Promise.resolve(registered().some((id) => id.startsWith(`${SOURCE_TYPE}:`))),
      15_000,
      "the collector registered the vault",
    );
    const listed = await harness.json<{ items: Array<{ id: string; type: string }> }>(
      "/admin/sources",
    );
    expect(listed.items.filter((s) => s.type === SOURCE_TYPE)).toHaveLength(1);
  });
});
