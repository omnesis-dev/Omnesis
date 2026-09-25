// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  CodexGenerationSupervisor,
  type CodexRuntimeGeneration,
} from "./codex-generation-supervisor.js";
import { CodexRuntimeUpdater } from "./codex-runtime-updater.js";
import type { CodexAppServerRuntime, CodexRuntimeCommandInfo } from "@omnesis/agent";
import type { CodexBackendStatus } from "@omnesis/core";

import type { CodexRuntimeInstaller } from "./codex-runtime-installer.js";

function commandInfo(version: string): CodexRuntimeCommandInfo {
  return {
    source: "managed",
    command: "/synthetic/codex",
    packageName: "@openai/codex",
    packageVersion: version,
  };
}

function generation(version: string): CodexRuntimeGeneration {
  return {
    runtime: {
      resolveCommandInfo: async () => commandInfo(version),
      probeRuntime: async () => ({ version }),
      listModels: async () => [{ id: "gpt-example" }],
      dispose: async () => {},
    } as unknown as CodexAppServerRuntime,
    interactivePool: null,
  };
}

describe("CodexRuntimeUpdater", () => {
  it("rolls back a published generation that fails real-home validation after restart", async () => {
    let rollbackCalls = 0;
    let replacementDisposed = false;
    const replacement = generation("0.151.0");
    replacement.runtime.dispose = async () => {
      replacementDisposed = true;
    };
    const installer = {
      readActive: async () => ({
        ...commandInfo("0.151.0"),
        source: "managed" as const,
        version: "0.151.0",
        installDir: "/synthetic/new",
      }),
      rollbackActivation: async () => {
        rollbackCalls += 1;
      },
    } as unknown as CodexRuntimeInstaller;
    const original = generation("0.142.4");
    const supervisor = new CodexGenerationSupervisor(original);
    const unavailable: CodexBackendStatus = {
      type: "codex",
      configured: false,
      status: "unreachable",
      loggedIn: false,
      models: [],
    };
    const updater = new CodexRuntimeUpdater({
      installer,
      supervisor,
      refreshTimeoutMs: 100,
      createGeneration: () => replacement,
      validateGeneration: async () => {
        throw new Error("Synthetic shared-home incompatibility.");
      },
      describeRuntime: async () => undefined,
      refresh: async () => unavailable,
      status: () => unavailable,
      loginBusy: () => false,
    });

    await updater.ensureSelectedRuntime();

    expect(supervisor.current).toBe(original);
    expect(replacementDisposed).toBe(true);
    expect(rollbackCalls).toBe(1);
    expect((await updater.get()).plan).toMatchObject({
      state: "repair-needed",
      reason: "Synthetic shared-home incompatibility.",
    });
    await updater.dispose();
    await supervisor.dispose();
  });

  it("joins a startup selection that is still reading the managed pointer on disposal", async () => {
    let releaseRead!: () => void;
    let readStarted = false;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const installer = {
      readActive: async () => {
        readStarted = true;
        await readGate;
        return null;
      },
    } as unknown as CodexRuntimeInstaller;
    const supervisor = new CodexGenerationSupervisor(generation("0.142.4"));
    const unavailable: CodexBackendStatus = {
      type: "codex",
      configured: false,
      status: "unreachable",
      loggedIn: false,
      models: [],
    };
    const updater = new CodexRuntimeUpdater({
      installer,
      supervisor,
      refreshTimeoutMs: 100,
      createGeneration: (info) => generation(info?.packageVersion ?? "0.142.4"),
      validateGeneration: async () => {},
      describeRuntime: async () => undefined,
      refresh: async () => unavailable,
      status: () => unavailable,
      loginBusy: () => false,
    });

    const selection = updater.ensureSelectedRuntime();
    while (!readStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    let disposed = false;
    const disposal = updater.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    releaseRead();
    await Promise.all([selection, disposal]);
    expect(disposed).toBe(true);
    await supervisor.dispose();
  });

  it.each(["construction", "validation"] as const)(
    "durably rolls back when replacement %s fails after pointer activation",
    async (failure) => {
      let selected = "old";
      let rollbackCalls = 0;
      const installer = {
        readActive: async () => null,
        prepare: async (
          _signal?: AbortSignal,
          onPhase?: (phase: "downloading" | "verifying") => void,
        ) => {
          onPhase?.("downloading");
          onPhase?.("verifying");
          return { id: "update-1", version: "0.151.0", stagingDir: "/synthetic/staging" };
        },
        commit: async () => {
          selected = "new";
          return {
            ...commandInfo("0.151.0"),
            source: "managed" as const,
            installDir: "/synthetic/new",
          };
        },
        rollbackActivation: async () => {
          rollbackCalls += 1;
          selected = "old";
        },
        discard: async () => {},
      } as unknown as CodexRuntimeInstaller;
      const supervisor = new CodexGenerationSupervisor(generation("0.142.4"));
      const unavailable: CodexBackendStatus = {
        type: "codex",
        configured: false,
        status: "unreachable",
        loggedIn: false,
        models: [],
      };
      const updater = new CodexRuntimeUpdater({
        installer,
        supervisor,
        refreshTimeoutMs: 100,
        createGeneration: (info) => {
          if (info?.packageVersion === "0.151.0" && failure === "construction") {
            throw new Error("Synthetic generation construction failure.");
          }
          return generation(info?.packageVersion ?? "0.142.4");
        },
        validateGeneration: async () => {
          if (failure === "validation") throw new Error("Synthetic real-home probe failure.");
        },
        describeRuntime: async () => undefined,
        refresh: async () => unavailable,
        status: () => unavailable,
        loginBusy: () => false,
      });

      await updater.start({ dryRun: false });
      let snapshot = await updater.get();
      while (snapshot.operation && !["rolled-back", "failed"].includes(snapshot.operation.state)) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        snapshot = await updater.get();
      }

      expect(snapshot.operation?.state).toBe("rolled-back");
      expect(selected).toBe("old");
      expect(rollbackCalls).toBe(1);
      await updater.dispose();
      await supervisor.dispose();
    },
  );
});
