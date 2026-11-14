// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

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
  it.each(["resolve", "probe"] as const)(
    "never offers repair after the current runtime's %s cleanup is unconfirmed",
    async (phase) => {
      const failure = Object.assign(new Error("Synthetic probe completion unknown"), {
        cleanupFailure: undefined,
      });
      const original = generation("0.142.4");
      const failed = vi.fn(() => Promise.reject(failure));
      if (phase === "resolve") original.runtime.resolveCommandInfo = failed;
      else original.runtime.probeRuntime = failed;
      const prepare = vi.fn(() => Promise.resolve());
      const create = vi.fn(() => generation("0.151.0"));
      const supervisor = new CodexGenerationSupervisor(original);
      const unavailable: CodexBackendStatus = {
        type: "codex",
        configured: false,
        status: "unreachable",
        loggedIn: false,
        models: [],
      };
      const updater = new CodexRuntimeUpdater({
        installer: {
          readActive: () => Promise.resolve(null),
          prepare,
        } as unknown as CodexRuntimeInstaller,
        supervisor,
        refreshTimeoutMs: 100,
        createGeneration: create,
        validateGeneration: () => Promise.resolve(),
        describeRuntime: () => Promise.resolve(undefined),
        refresh: () => Promise.resolve(unavailable),
        status: () => unavailable,
        loginBusy: () => false,
      });
      expect((await updater.get()).plan).toMatchObject({
        state: "repair-needed",
        action: "none",
        canUpdate: false,
      });
      await updater.start({ dryRun: false });
      expect(failed).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      await expect(supervisor.use(() => Promise.resolve())).rejects.toBe(supervisor.cleanupError);
      await updater.dispose();
      await expect(supervisor.dispose()).rejects.toBe(supervisor.cleanupError);
    },
  );

  it.each(["startup", "commit"] as const)(
    "retires an unpublished candidate when supervisor shutdown refuses %s replacement",
    async (phase) => {
      const installed = {
        ...commandInfo("0.151.0"),
        source: "managed" as const,
        version: "0.151.0",
        installDir: "/synthetic/new",
      };
      const candidate = generation("0.151.0");
      let joined!: () => void;
      const candidateJoined = new Promise<void>((resolve) => {
        joined = resolve;
      });
      const disposal = vi.fn(() => {
        joined();
        return Promise.resolve();
      });
      candidate.runtime.dispose = disposal;
      const create = vi.fn(() => candidate);
      const rollback = vi.fn(() => Promise.resolve());
      const supervisor = new CodexGenerationSupervisor(generation("0.142.4"));
      const installer = {
        readActive: () => Promise.resolve(phase === "startup" ? installed : null),
        prepare: () =>
          Promise.resolve({
            id: "synthetic-update",
            version: "0.151.0",
            stagingDir: "/synthetic/staging",
          }),
        commit: async () => {
          await supervisor.dispose();
          return installed;
        },
        rollbackActivation: rollback,
        discard: () => Promise.resolve(),
      } as unknown as CodexRuntimeInstaller;
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
        createGeneration: create,
        validateGeneration: () => (phase === "startup" ? supervisor.dispose() : Promise.resolve()),
        describeRuntime: () => Promise.resolve(undefined),
        refresh: () => Promise.resolve(unavailable),
        status: () => unavailable,
        loginBusy: () => false,
      });
      if (phase === "startup") await updater.ensureSelectedRuntime();
      else await updater.start({ dryRun: false });
      await candidateJoined;
      await updater.dispose();
      expect(disposal).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(rollback).not.toHaveBeenCalled();
      expect(supervisor.cleanupError).toBeNull();
      await supervisor.dispose();
    },
  );

  it.each([
    "startup-validation",
    "validation",
    "commit",
    "rollback",
    "discard",
    "undefined-publication",
  ] as const)(
    "holds before rollback or recreation on a plain cleanup marker from %s",
    async (phase) => {
      const failure = Object.assign(new Error("Synthetic completion unknown"), {
        cleanupFailure:
          phase === "undefined-publication" ? undefined : new Error("Synthetic unjoined child"),
      });
      const installed = {
        ...commandInfo("0.151.0"),
        source: "managed" as const,
        version: "0.151.0",
        installDir: "/synthetic/new",
      };
      const replacement = generation("0.151.0");
      const create = vi.fn(() => replacement);
      const rollback = vi.fn(() =>
        phase === "rollback" ? Promise.reject(failure) : Promise.resolve(),
      );
      const prepare = vi.fn(() =>
        Promise.resolve({
          id: "synthetic-update",
          version: "0.151.0",
          stagingDir: "/synthetic/staging",
        }),
      );
      const installer = {
        readActive: () => Promise.resolve(phase === "startup-validation" ? installed : null),
        prepare,
        commit: () =>
          phase === "commit" || phase === "undefined-publication"
            ? Promise.reject(failure)
            : Promise.resolve(installed),
        rollbackActivation: rollback,
        discard: () => (phase === "discard" ? Promise.reject(failure) : Promise.resolve()),
      } as unknown as CodexRuntimeInstaller;
      const original = generation("0.142.4");
      if (phase === "discard")
        original.runtime.resolveCommandInfo = () =>
          Promise.reject(new Error("Synthetic version probe failed"));
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
        createGeneration: create,
        validateGeneration: () =>
          Promise.reject(
            phase === "rollback" ? new Error("Synthetic model incompatibility") : failure,
          ),
        describeRuntime: () => Promise.resolve(undefined),
        refresh: () => Promise.resolve(unavailable),
        status: () => unavailable,
        loginBusy: () => false,
      });
      if (phase === "startup-validation") await updater.ensureSelectedRuntime();
      else {
        await updater.start({ dryRun: false });
        await vi.waitFor(async () =>
          expect((await updater.get()).operation?.state).toMatch(/failed|rolled-back/),
        );
      }
      expect(rollback).toHaveBeenCalledTimes(phase === "rollback" ? 1 : 0);
      expect(create).toHaveBeenCalledTimes(
        phase === "commit" || phase === "discard" || phase === "undefined-publication" ? 0 : 1,
      );
      expect(supervisor.cleanupError).toMatchObject({ cause: failure });
      expect((await updater.get()).plan.canUpdate).toBe(false);
      await updater.dispose();
      await expect(supervisor.dispose()).rejects.toBe(supervisor.cleanupError);
    },
  );

  it.each(["prepare", "read-active"] as const)(
    "blocks fresh generations after unconfirmed %s command cleanup",
    async (phase) => {
      const failure = Object.assign(new Error("Synthetic command failure"), {
        cleanupFailure: new Error("Synthetic unjoined child"),
      });
      const prepare = vi.fn(() => Promise.reject(failure));
      const create = vi.fn(() => generation("0.151.0"));
      const installer = {
        readActive: () =>
          phase === "read-active" ? Promise.reject(failure) : Promise.resolve(null),
        prepare,
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
        createGeneration: create,
        validateGeneration: () => Promise.resolve(),
        describeRuntime: () => Promise.resolve(undefined),
        refresh: () => Promise.resolve(unavailable),
        status: () => unavailable,
        loginBusy: () => false,
      });
      await updater.start({ dryRun: false });
      if (phase === "prepare")
        await vi.waitFor(async () => expect((await updater.get()).operation?.state).toBe("failed"));
      expect((await updater.get()).plan).toMatchObject({
        canUpdate: false,
        state: "repair-needed",
      });
      await updater.start({ dryRun: false });
      expect(create).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(phase === "prepare" ? 1 : 0);
      await expect(supervisor.use(() => Promise.resolve())).rejects.toBe(supervisor.cleanupError);
      await updater.dispose();
      await expect(supervisor.dispose()).rejects.toBe(supervisor.cleanupError);
    },
  );

  it.each(["previous", "replacement", "startup-previous", "startup-replacement"] as const)(
    "blocks replacement, rollback and retry when %s cleanup cannot be confirmed",
    async (failureAt) => {
      const startup = failureAt.startsWith("startup-");
      const replacementFails = failureAt.endsWith("replacement");
      const original = generation("0.142.4");
      const replacement = generation("0.151.0");
      const failure = new Error("Synthetic native join was not confirmed");
      const failedDisposal = vi.fn(() => Promise.reject(failure));
      (replacementFails ? replacement : original).runtime.dispose = failedDisposal;
      const installed = {
        ...commandInfo("0.151.0"),
        source: "managed" as const,
        version: "0.151.0",
        installDir: "/synthetic/new",
      };
      const commit = vi.fn(() => Promise.resolve(installed));
      const rollback = vi.fn(() => Promise.resolve());
      const create = vi.fn(() => replacement);
      const prepare = vi.fn(() =>
        Promise.resolve({
          id: "synthetic-update",
          version: "0.151.0",
          stagingDir: "/synthetic/staging",
        }),
      );
      const installer = {
        readActive: () => Promise.resolve(startup ? installed : null),
        prepare,
        commit,
        rollbackActivation: rollback,
        discard: () => Promise.resolve(),
      } as unknown as CodexRuntimeInstaller;
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
        createGeneration: create,
        validateGeneration: () =>
          replacementFails
            ? Promise.reject(new Error("Synthetic validation failure"))
            : Promise.resolve(),
        describeRuntime: () => Promise.resolve(undefined),
        refresh: () => Promise.resolve(unavailable),
        status: () => unavailable,
        loginBusy: () => false,
      });
      if (startup) await updater.ensureSelectedRuntime();
      else {
        await updater.start({ dryRun: false });
        await vi.waitFor(async () => expect((await updater.get()).operation?.state).toBe("failed"));
      }
      const blocked = supervisor.cleanupError;
      expect(blocked).toMatchObject({ cause: failure });
      const snapshot = await updater.get();
      expect(snapshot.plan).toMatchObject({
        state: "repair-needed",
        action: "none",
        canUpdate: false,
      });
      await updater.start({ dryRun: false });
      expect(prepare).toHaveBeenCalledTimes(startup ? 0 : 1);
      expect(commit).toHaveBeenCalledTimes(!startup && replacementFails ? 1 : 0);
      expect(create).toHaveBeenCalledTimes(startup || replacementFails ? 1 : 0);
      expect(rollback).not.toHaveBeenCalled();
      await expect(supervisor.use(() => Promise.resolve("must not run"))).rejects.toBe(blocked);
      await updater.dispose();
      await expect(supervisor.dispose()).rejects.toBe(blocked);
      expect(failedDisposal).toHaveBeenCalledTimes(1);
    },
  );

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
