// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterAll, describe, expect, test } from "vitest";
import { CAPABILITY_ROLES } from "@omnesis/core";
import { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";
import { waitForCondition } from "./multi-collector-harness.js";
import { startOpenAiServer, type OpenAiServerHandle } from "./brain-bench/openai-server.js";
import {
  addRestoreMaildirSource,
  applyRestoreArchive,
  downloadRestoreArchive,
  prepareRestoreProof,
  tamperRestoreArchive,
  proofAuthority,
} from "./desktop-restore-fixture.js";

/** Actual source-distribution crypto/services/daemon/HTTP; native macOS EX and Keychain ACL proof is separate. */
describe.skipIf(process.platform !== "linux")(
  "encrypted desktop backup restore composition",
  () => {
    let source: DesktopRuntimeFixture | undefined;
    let target: DesktopRuntimeFixture | undefined;
    let model: OpenAiServerHandle | undefined;
    let modelCalls = 0;
    afterAll(async () => {
      try {
        await target?.close();
      } finally {
        try {
          await source?.close();
        } finally {
          await model?.close();
        }
      }
    }, 180_000);

    test("actual archive import preserves target authority and completes only after explicit protected reconnect without model calls", async () => {
      model = await startOpenAiServer({
        modelId: "restore-fixture",
        respond: () => {
          modelCalls++;
          return { kind: "text", text: "No model call is expected during restore." };
        },
      });
      source = await DesktopRuntimeFixture.create();
      target = await DesktopRuntimeFixture.create({ scriptedAgent: model });
      expect(await source.command("connect")).toMatchObject({ encrypted: true });
      expect(await target.command("connect")).toMatchObject({ encrypted: true });
      const originalIdentity = await target.request("/whoami");
      const originalConfig = (await target.request("/admin/config")) as {
        config: { inference: { assignments: { agent?: string | null } } };
      };
      expect(originalConfig.config.inference.assignments.agent).toBe("scripted/restore-fixture");
      await source.request("/notes", {
        method: "POST",
        body: { text: "Fictional archive recovery comet marker.", surface: "cli" },
      });
      await waitForCondition(
        async () => {
          const status = (await source!.request("/status")) as { documents: { total: number } };
          return status.documents.total > 0;
        },
        60_000,
        "the source note enters its real encrypted store",
      );
      const sourceId = await addRestoreMaildirSource(source);
      const enabledSources = (await source.request("/admin/sources")) as {
        items: Array<{ id: string; enabled: boolean }>;
      };
      expect(enabledSources.items.find((source) => source.id === sourceId)).toMatchObject({
        enabled: true,
      });
      const proof = await prepareRestoreProof(source);
      // The exact saved credential must authorize its own source before target rejection means anything.
      expect(await proofAuthority(source, proof)).toEqual({ status: 200 });
      await source.request("/admin/backup", { method: "POST", body: { includeIndex: false } });
      await waitForCondition(
        async () => {
          const status = (await source!.request("/admin/backup/status")) as {
            running: boolean;
            lastResult?: { ok: boolean };
          };
          if (!status.running && status.lastResult?.ok === false)
            throw new Error("The real source backup failed");
          return !status.running && status.lastResult?.ok === true;
        },
        90_000,
        "the actual encrypted backup completes",
      );
      const catalog = (await source.request("/admin/artifacts?kind=backup")) as {
        items: Array<{ id: string; encrypted: boolean }>;
      };
      expect(catalog.items).toHaveLength(1);
      expect(catalog.items[0]?.encrypted).toBe(true);
      const archive = await downloadRestoreArchive(source, catalog.items[0]!.id);
      const tampered = await tamperRestoreArchive(source, archive);
      expect(await source.command("stop")).toMatchObject({ phase: "waiting" });
      expect(await applyRestoreArchive(target, tampered, proof, { tampered: true })).toEqual({
        tamperRefused: true,
      });
      expect(await target.request("/whoami")).toEqual(originalIdentity);
      expect(await proofAuthority(target, proof)).toEqual({ status: 401 });
      expect(modelCalls).toBe(0);
      expect(await applyRestoreArchive(target, archive, proof)).toMatchObject({
        status: "committed",
        phase: "committed",
        runtimeStopped: true,
        modelRolesPaused: true,
        automaticDeletionPaused: true,
      });
      const pending = await target.command("restoreStatus");
      expect(pending).toMatchObject({ status: "pending" });
      // This literal production connect must perform real health/identity/schema/data checks.
      expect(await target.command("connect")).toMatchObject({ encrypted: true });
      expect(await target.command("restoreStatus")).toMatchObject({ status: "complete" });
      expect(await target.request("/health")).toMatchObject({
        status: "ok",
        storageProtection: { version: 1, atRest: "encrypted" },
      });
      expect(await target.request("/whoami")).toEqual(originalIdentity);
      expect(await proofAuthority(target, proof)).toEqual({ status: 401 });
      const config = (await target.request("/admin/config")) as {
        config: {
          inference: { assignments: Record<string, unknown>; backends: Record<string, unknown> };
          gateway?: { storage?: { retention?: unknown[] } };
          activityRetention?: { maxAge?: string };
        };
      };
      for (const role of CAPABILITY_ROLES)
        expect(config.config.inference.assignments[role]).toBeNull();
      expect(config.config.inference.backends.scripted).toBeDefined();
      // These defaults prove post-restore readiness invariants; populated-rule transitions have unit coverage.
      expect(config.config.gateway?.storage?.retention ?? []).toEqual([]);
      expect(config.config.activityRetention?.maxAge).toBeUndefined();
      const sources = (await target.request("/admin/sources")) as {
        items: Array<{ id: string; enabled: boolean }>;
      };
      expect(sources.items.find((source) => source.id === sourceId)).toMatchObject({
        enabled: false,
      });
      expect(sources.items.every((source) => source.enabled === false)).toBe(true);
      expect(await target.request("/status")).toMatchObject({
        lab: { brain: false, tasks: false, watches: false },
      });
      const notes = await target.request("/notes");
      expect(JSON.stringify(notes)).toContain("Fictional archive recovery comet marker.");
      expect(modelCalls).toBe(0);
      expect(await target.command("stop")).toMatchObject({ phase: "waiting" });
      expect(await target.plaintextFiles("Fictional archive recovery comet marker.")).toEqual([]);
    }, 360_000);
  },
);
