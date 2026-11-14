// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CODEX_RUNTIME_COMPAT, CodexAppServerRuntime } from "@omnesis/agent";
import { z } from "zod";
import { CODEX_SUPPORTED_ROLES, type AgentEvent } from "@omnesis/core";
import { ConfigStore } from "../config-store.js";
import { AgentSetupUnavailableError } from "./agent-assignment-setup.js";
import {
  CodexRuntimeLifecycle,
  CodexRuntimeLifecycleConflictError,
} from "./codex-runtime-lifecycle.js";
import { CodexRuntimeUpdater } from "./codex-runtime-updater.js";
import { CodexGenerationSupervisor } from "./codex-generation-supervisor.js";
import {
  CodexRuntimeService,
  parseCodexAppServerModels,
  parseCodexDeviceLoginOutput,
  parseCodexModelsJson,
} from "./codex-runtime-service.js";
import type { CodexRuntimeInstaller } from "./codex-runtime-installer.js";

const fakeCodexPath = fileURLToPath(
  new URL("../../../agent/src/test-fixtures/fake-codex-app-server.mjs", import.meta.url),
);

describe("Codex service disposal failures", () => {
  it.each(["version", "auth", "models"] as const)(
    "holds admission instead of starting a fallback after unjoined %s discovery",
    async (stage) => {
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-discovery-unjoined-"));
      const home = join(dir, "codex-home");
      await mkdir(home);
      await writeFile(join(home, "auth.json"), "{}");
      const agent = await import("@omnesis/agent");
      const core = await import("@omnesis/core");
      const failure = Object.assign(new Error("invented discovery failure"), {
        cleanupFailure: new Error("invented missing native join"),
      });
      vi.spyOn(agent, "ensureCodexHome").mockResolvedValue(undefined);
      vi.spyOn(CodexAppServerRuntime.prototype, "resolveCommandInfo").mockResolvedValue({
        source: "override",
        command: process.execPath,
      });
      const probe = vi.spyOn(CodexAppServerRuntime.prototype, "probeRuntime");
      if (stage === "version") probe.mockRejectedValue(failure);
      else probe.mockResolvedValue({ command: process.execPath, version: "0.167.0" });
      vi.spyOn(CodexAppServerRuntime.prototype, "listModels").mockRejectedValue(failure);
      const execute = vi.spyOn(core, "execWindowsJob");
      if (stage === "auth") execute.mockRejectedValue(failure);
      else execute.mockResolvedValue({ stdout: "invented logged-in status", stderr: "" });
      const service = new CodexRuntimeService({
        configDir: dir,
        command: process.execPath,
        interactivePoolSize: 0,
        backgroundPoolSize: 1,
        inferencePoolSize: 1,
      });
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      try {
        expect(await service.refresh()).toMatchObject({
          status: "unreachable",
          reason: expect.stringMatching(/cleanup/u),
        });
        expect(await service.refresh()).toMatchObject({ status: "unreachable" });
        await expect(service.startDeviceLogin()).rejects.toThrow(/cleanup/u);
        await expect(service.logout()).rejects.toThrow(/cleanup/u);
        expect(execute).toHaveBeenCalledTimes(stage === "version" ? 0 : 1);
        expect(await readFile(join(home, "auth.json"), "utf8")).toBe("{}");
      } finally {
        Object.defineProperty(process, "platform", platform);
        await service.dispose().catch(() => {});
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("keeps logout cleanup uncertainty fenced through lifecycle disposal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-unjoined-logout-"));
    const auth = join(dir, "auth.json");
    await writeFile(auth, "invented auth marker");
    const core = await import("@omnesis/core");
    const failure = Object.assign(new Error("invented logout timeout"), {
      code: "ETIMEDOUT",
      cleanupFailure: new Error("invented missing native join"),
    });
    const execute = vi.spyOn(core, "execWindowsJob").mockRejectedValue(failure);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const invalidateRefresh = vi.fn();
    const holdCleanup = vi.fn((error: Error) => error);
    const lifecycle = new CodexRuntimeLifecycle({
      codexHome: dir,
      cliArgsPrefix: [],
      env: process.env,
      refreshTimeoutMs: 100,
      loginStartTimeoutMs: 100,
      loginTtlMs: 100,
      supervisor: {
        holdCleanup,
        current: {
          runtime: { resolveCommandInfo: () => Promise.resolve({ command: process.execPath }) },
        },
      } as unknown as CodexGenerationSupervisor,
      ensureSelectedRuntime: () => Promise.resolve(),
      updateInProgress: () => false,
      refresh: () => Promise.reject(new Error("unexpected refresh")),
      invalidateRefresh,
      describeRuntime: () => Promise.resolve(undefined),
      setStatus: vi.fn(),
    });
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await expect(lifecycle.logout()).rejects.toBe(failure);
      expect(await readFile(auth, "utf8")).toBe("invented auth marker");
      expect(lifecycle.busy).toBe(true);
      expect(invalidateRefresh).not.toHaveBeenCalled();
      const operation = vi.fn(() => Promise.resolve("unexpected"));
      await expect(lifecycle.runAgentSetup(operation)).rejects.toThrow(/cleanup/u);
      await expect(lifecycle.startDeviceLogin()).rejects.toThrow(/cleanup/u);
      await expect(lifecycle.logout()).rejects.toThrow(/cleanup/u);
      expect(operation).not.toHaveBeenCalled();
      const disposal = lifecycle.dispose();
      await expect(disposal).rejects.toMatchObject({ cause: failure });
      expect(lifecycle.dispose()).toBe(disposal);
      await expect(lifecycle.dispose()).rejects.toBe(holdCleanup.mock.results[0]!.value);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["logout", "agent-setup", "logout-resolution"] as const)(
    "joins accepted %s work before lifecycle disposal settles",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-lifecycle-join-"));
      const core = await import("@omnesis/core");
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const execute = vi.spyOn(core, "execWindowsJob").mockImplementation(async () => {
        started();
        await gate;
        return { stdout: "", stderr: "" };
      });
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const lifecycle = new CodexRuntimeLifecycle({
        codexHome: dir,
        cliArgsPrefix: [],
        env: process.env,
        refreshTimeoutMs: 100,
        loginStartTimeoutMs: 100,
        loginTtlMs: 100,
        supervisor: {
          current: {
            runtime: {
              resolveCommandInfo: async () => {
                if (kind === "logout-resolution") {
                  started();
                  await gate;
                }
                return { command: process.execPath };
              },
            },
          },
        } as unknown as CodexGenerationSupervisor,
        ensureSelectedRuntime: () => Promise.resolve(),
        updateInProgress: () => false,
        refresh: () => Promise.reject(new Error("Unexpected refresh")),
        invalidateRefresh: vi.fn(),
        describeRuntime: () => Promise.resolve(undefined),
        setStatus: vi.fn(),
      });
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const work = kind.startsWith("logout")
        ? lifecycle.logout()
        : lifecycle.runAgentSetup(async () => {
            started();
            await gate;
            return "joined";
          });
      const workResult = work.catch((error: unknown) => error);
      let closed = false;
      let closing: Promise<void> | undefined;
      try {
        await entered;
        closing = lifecycle.dispose().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        expect(lifecycle.cleanupReceipt()).toMatchObject({ cleanupPending: true });
        release();
        const result = await workResult;
        if (kind === "logout-resolution")
          expect(result).toMatchObject({ message: "Codex runtime service disposed." });
        else expect(result).not.toBeInstanceOf(Error);
        await closing;
        expect(lifecycle.cleanupReceipt()).toBeUndefined();
        expect(execute).toHaveBeenCalledTimes(kind === "logout" ? 1 : 0);
      } finally {
        release();
        await work.catch(() => {});
        await closing?.catch(() => {});
        Object.defineProperty(process, "platform", platform);
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("closes service admission synchronously while accepted cleanup is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-closed-admission-"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(CodexRuntimeLifecycle.prototype, "dispose").mockReturnValue(held);
    vi.spyOn(CodexRuntimeUpdater.prototype, "dispose").mockResolvedValue();
    vi.spyOn(CodexAppServerRuntime.prototype, "resolveCommandInfo").mockRejectedValue(
      new Error("Unexpected admission"),
    );
    const refresh = vi.spyOn(CodexGenerationSupervisor.prototype, "use");
    const login = vi.spyOn(CodexRuntimeLifecycle.prototype, "startDeviceLogin");
    const logout = vi.spyOn(CodexRuntimeLifecycle.prototype, "logout");
    const setup = vi.spyOn(CodexRuntimeLifecycle.prototype, "runAgentSetup");
    const update = vi.spyOn(CodexRuntimeUpdater.prototype, "start");
    const service = new CodexRuntimeService({ configDir: dir, command: process.execPath });
    const backend = service.createBackend({ model: "gpt-example-frontier" });
    const closing = service.dispose();
    try {
      await expect(service.refresh()).rejects.toThrow(/disposed/);
      await expect(service.startDeviceLogin()).rejects.toThrow(/disposed/);
      await expect(service.logout()).rejects.toThrow(/disposed/);
      await expect(service.setupAgent({} as ConfigStore, "gpt-example-frontier")).rejects.toThrow(
        /disposed/,
      );
      await expect(service.getRuntimeUpdate()).rejects.toThrow(/disposed/);
      await expect(service.startRuntimeUpdate({ dryRun: false })).rejects.toThrow(/disposed/);
      await expect(service.cancelRuntimeUpdate()).rejects.toThrow(/disposed/);
      const run = async () => {
        for await (const event of backend.runTurn({
          sessionId: "invented",
          messageId: "invented",
          userMessage: "Invented input",
          systemPrompt: "",
          history: [],
          tools: [],
        }))
          void event;
      };
      await expect(run()).rejects.toThrow(/disposed/);
      expect(refresh).not.toHaveBeenCalled();
      expect(login).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      release();
      await closing;
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rechecks disposal after a turn's accepted runtime selection settles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-selection-close-"));
    let releaseSelection!: () => void, entered!: () => void, releaseCleanup!: () => void;
    const selected = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const selecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    vi.spyOn(CodexRuntimeUpdater.prototype, "ensureSelectedRuntime").mockImplementation(() => {
      entered();
      return selected;
    });
    vi.spyOn(CodexRuntimeUpdater.prototype, "dispose").mockResolvedValue();
    vi.spyOn(CodexRuntimeLifecycle.prototype, "dispose").mockReturnValue(cleanup);
    const run = vi
      .spyOn(CodexAppServerRuntime.prototype, "runTurn")
      .mockImplementation(async function* () {
        yield* [];
      });
    const service = new CodexRuntimeService({
      configDir: dir,
      command: process.execPath,
      interactivePoolSize: 0,
    });
    const turn = (async () => {
      for await (const event of service.createBackend({ model: "gpt-example-frontier" }).runTurn({
        sessionId: "invented",
        messageId: "invented",
        userMessage: "Invented input",
        systemPrompt: "",
        history: [],
        tools: [],
      }))
        void event;
    })();
    const result = turn.catch((error: unknown) => error);
    await selecting;
    const closing = service.dispose();
    try {
      releaseSelection();
      expect(await result).toMatchObject({ message: "Codex runtime service disposed." });
      expect(run).not.toHaveBeenCalled();
    } finally {
      releaseSelection();
      releaseCleanup();
      await result;
      await closing;
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("joins an accepted refresh helper before service disposal can confirm cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-refresh-join-"));
    const home = join(dir, "codex-home");
    await mkdir(home);
    await writeFile(join(home, "auth.json"), "{}");
    const agent = await import("@omnesis/agent"),
      core = await import("@omnesis/core");
    vi.spyOn(agent, "ensureCodexHome").mockResolvedValue();
    vi.spyOn(CodexAppServerRuntime.prototype, "resolveCommandInfo").mockResolvedValue({
      source: "override",
      command: process.execPath,
    });
    vi.spyOn(CodexAppServerRuntime.prototype, "probeRuntime").mockResolvedValue({
      command: process.execPath,
      version: "0.167.0",
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.spyOn(core, "execWindowsJob").mockImplementation(async () => {
      entered();
      await gate;
      return { stdout: "invented logged-in status", stderr: "" };
    });
    const models = vi.spyOn(CodexAppServerRuntime.prototype, "listModels");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const service = new CodexRuntimeService({ configDir: dir, command: process.execPath });
    const refreshing = service.refresh();
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await running;
      closing = service.dispose().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release();
      await refreshing;
      await closing;
      expect(models).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(service.cleanupFailure()).toBeUndefined();
    } finally {
      release();
      await refreshing.catch(() => {});
      await closing?.catch(() => {});
      Object.defineProperty(process, "platform", platform);
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears a pending shutdown receipt after the retained disposal positively settles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-joined-dispose-"));
    let release!: () => void;
    const update = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(CodexRuntimeUpdater.prototype, "dispose").mockReturnValue(update);
    vi.spyOn(CodexRuntimeLifecycle.prototype, "dispose").mockResolvedValue();
    vi.spyOn(CodexGenerationSupervisor.prototype, "dispose").mockResolvedValue();
    const service = new CodexRuntimeService({ configDir: dir, command: process.execPath });
    try {
      const disposal = service.dispose();
      expect(service.cleanupFailure()).toMatchObject({
        cleanupFailure: true,
        cleanupPending: true,
      });
      release();
      await disposal;
      expect(service.cleanupFailure()).toBeUndefined();
      expect(service.dispose()).toBe(disposal);
    } finally {
      release();
      await service.dispose();
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["updater", "lifecycle", "supervisor"] as const)(
    "joins all owners after %s fails and preserves repeated rejection",
    async (component) => {
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-dispose-"));
      const failure = new Error(`invented ${component} cleanup failure`);
      let releaseUpdate!: () => void, releaseRetirement!: () => void;
      const update = new Promise<void>((resolve, reject) => {
        releaseUpdate = () => (component === "updater" ? reject(failure) : resolve());
      });
      const retirement = new Promise<void>((resolve, reject) => {
        releaseRetirement = () => (component === "supervisor" ? reject(failure) : resolve());
      });
      const updater = vi.spyOn(CodexRuntimeUpdater.prototype, "dispose").mockReturnValue(update);
      const lifecycle = vi
        .spyOn(CodexRuntimeLifecycle.prototype, "dispose")
        .mockImplementation(() =>
          component === "lifecycle" ? Promise.reject(failure) : Promise.resolve(),
        );
      const supervisor = vi
        .spyOn(CodexGenerationSupervisor.prototype, "dispose")
        .mockReturnValue(retirement);
      const service = new CodexRuntimeService({
        configDir: dir,
        command: process.execPath,
        interactivePoolSize: 0,
        inferencePoolSize: 1,
        backgroundPoolSize: 1,
      });
      expect(service.cleanupFailure()).toBeUndefined();
      const disposal = service.dispose();
      const pendingReceipt = service.cleanupFailure();
      expect(pendingReceipt).toMatchObject({ cleanupFailure: true, cleanupPending: true });
      expect(service.cleanupFailure()).toBe(pendingReceipt);
      let settled = false;
      void disposal.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await Promise.resolve();
        await Promise.resolve();
        expect(supervisor).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        releaseUpdate();
        await vi.waitFor(() => expect(supervisor).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        releaseRetirement();
        await expect(disposal).rejects.toBe(failure);
        expect(service.cleanupFailure()).toMatchObject({ cleanupFailure: true, cause: failure });
        expect(service.dispose()).toBe(disposal);
        await expect(service.dispose()).rejects.toBe(failure);
        expect(updater).toHaveBeenCalledOnce();
        expect(lifecycle).toHaveBeenCalledOnce();
        expect(supervisor).toHaveBeenCalledOnce();
      } finally {
        releaseUpdate();
        releaseRetirement();
        await disposal.catch(() => {});
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("Codex JavaScript command lifecycle", () => {
  it.each([false, true])(
    "refreshes and logs out a JavaScript command (fallback=%s)",
    async (fallback) => {
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-js-service-"));
      const command = join(dir, "codex command & $().mjs");
      await copyFile(fakeCodexPath, command);
      await chmod(command, 0o700);
      const home = join(dir, "codex-home");
      await mkdir(home);
      await writeFile(join(home, "auth.json"), "{}");
      if (fallback)
        vi.spyOn(CodexAppServerRuntime.prototype, "listModels").mockRejectedValue(
          new Error("synthetic protocol unavailable"),
        );
      const service = new CodexRuntimeService({
        configDir: dir,
        command,
        interactivePoolSize: 0,
        backgroundPoolSize: 1,
        inferencePoolSize: 1,
      });
      try {
        const status = await service.refresh();
        expect(status.loggedIn).toBe(true);
        expect(status.discovery).toBe(fallback ? "debug-models" : "app-server");
        expect(status.models).toContain("gpt-example-frontier");
        const result = await service.logout();
        expect(result.ok).toBe(true);
        await expect(access(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.restoreAllMocks();
        await service.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(process.platform === "win32" ? [false, true] : [false])(
    "starts and cancels device login through a JavaScript wrapper (wrapperExits=%s)",
    async (wrapperExits) => {
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-js-login-"));
      const command = join(dir, "codex command & $().mjs");
      const pidPath = join(dir, "child.pid");
      const wrapperPidPath = join(dir, "wrapper.pid");
      await writeFile(
        command,
        `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes("--device-auth")) writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
const child = spawn(process.execPath, [${JSON.stringify(fakeCodexPath)}, ...args], { detached: ${wrapperExits}, stdio: 'inherit' });
child.once('spawn', () => { if (args.includes('--device-auth')) writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
if (${wrapperExits} && args.includes('--device-auth')) child.once('spawn', () => { child.unref(); process.exit(0); });
`,
        { mode: 0o700 },
      );
      const service = new CodexRuntimeService({
        configDir: dir,
        command,
        interactivePoolSize: 0,
        backgroundPoolSize: 1,
        inferencePoolSize: 1,
      });
      let childPid: number | undefined;
      try {
        const flow = await service.startDeviceLogin();
        expect(flow.status).toBe("pending");
        expect(flow.userCode).toBe("ABCD-12345");
        childPid = Number(await readFile(pidPath, "utf8"));
        if (wrapperExits) {
          const wrapperPid = Number(await readFile(wrapperPidPath, "utf8"));
          await vi.waitFor(() => expect(() => process.kill(wrapperPid, 0)).toThrow());
        }
        expect(service.cancelLogin().canceled).toBe(true);
        await service.dispose();
        expect(() => process.kill(childPid!, 0)).toThrow();
      } finally {
        await service.dispose();
        if (childPid !== undefined) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("CodexRuntimeService parsers", () => {
  it("parses list-visible Codex models and omits hidden or upgrade-gated entries", () => {
    const models = parseCodexModelsJson(
      JSON.stringify({
        models: [
          {
            slug: "gpt-example-frontier",
            display_name: "GPT Example Frontier",
            description: "Frontier coding model.",
            visibility: "list",
            priority: 0,
          },
          {
            slug: "gpt-example-mini",
            display_name: "GPT Example Mini",
            visibility: "list",
            priority: 2,
          },
          {
            slug: "gpt-example-hidden",
            display_name: "GPT Example Hidden",
            visibility: "hidden",
          },
          {
            slug: "gpt-example-upgrade",
            display_name: "GPT Example Upgrade",
            visibility: "list",
            upgrade: { plan: "example" },
          },
          { display_name: "Missing slug", visibility: "list" },
        ],
      }),
    );

    expect(models).toEqual([
      {
        id: "gpt-example-frontier",
        name: "GPT Example Frontier",
        description: "Frontier coding model.",
        recommended: true,
        inputModalities: ["text", "image"],
      },
      {
        id: "gpt-example-mini",
        name: "GPT Example Mini",
        description: undefined,
        recommended: false,
        inputModalities: ["text", "image"],
      },
    ]);
  });

  it("parses app-server model/list models and omits hidden or upgrade-gated entries", () => {
    expect(
      parseCodexAppServerModels([
        {
          id: "model_frontier",
          model: "gpt-example-frontier",
          displayName: "GPT Example Frontier",
          description: "Frontier coding model.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Thorough" },
          ],
        },
        {
          id: "model_hidden",
          model: "gpt-example-hidden",
          displayName: "GPT Example Hidden",
          hidden: true,
        },
        {
          id: "model_upgrade",
          model: "gpt-example-upgrade",
          displayName: "GPT Example Upgrade",
          upgradeInfo: { plan: "example" },
        },
      ]),
    ).toEqual([
      {
        id: "gpt-example-frontier",
        name: "GPT Example Frontier",
        description: "Frontier coding model.",
        recommended: true,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "high"],
      },
    ]);
  });

  it("parses Codex device-login URL, code, and expiry from CLI output", () => {
    expect(
      parseCodexDeviceLoginOutput(
        "\u001b[32mOpen https://auth.openai.com/codex/device and enter ABCD-1234. This code expires in 12 minutes.\u001b[0m",
      ),
    ).toEqual({
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresMs: 12 * 60_000,
    });
  });

  it("preserves explicit text-only modality declarations", () => {
    expect(
      parseCodexAppServerModels([{ id: "gpt-text", inputModalities: ["text"] }]),
    ).toMatchObject([{ id: "gpt-text", inputModalities: ["text"] }]);
    expect(
      parseCodexModelsJson(
        JSON.stringify({ models: [{ slug: "gpt-text", input_modalities: ["text"] }] }),
      ),
    ).toMatchObject([{ id: "gpt-text", inputModalities: ["text"] }]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid inference capacity %s",
    (inferencePoolSize) => {
      expect(
        () => new CodexRuntimeService({ configDir: "/synthetic/config", inferencePoolSize }),
      ).toThrow("inferencePoolSize must be an integer of at least 1");
    },
  );

  it.each([0, -1, 1.5, 33, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid background capacity %s",
    (backgroundPoolSize) => {
      expect(
        () => new CodexRuntimeService({ configDir: "/synthetic/config", backgroundPoolSize }),
      ).toThrow("backgroundPoolSize must be an integer from 1 to 32");
    },
  );

  it.each([0, 999, 1000.5, 3600001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid model-stream idle timeout %s",
    (turnIdleTimeoutMs) => {
      expect(
        () => new CodexRuntimeService({ configDir: "/synthetic/config", turnIdleTimeoutMs }),
      ).toThrow("turnIdleTimeoutMs must be an integer from 1000 to 3600000");
    },
  );

  it.each(["owner", "interactive", "background", "inference"] as const)(
    "propagates configured model-stream idle timeout to the %s runtime",
    async (lane) => {
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-idle-"));
      const service = new CodexRuntimeService({
        configDir: dir,
        command: process.execPath,
        args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
        versionArgs: [fakeCodexPath, "--version"],
        env: { ...process.env, OMNESIS_FAKE_CODEX_SCENARIO: "hang" },
        interactivePoolSize: lane === "owner" ? 0 : 1,
        backgroundPoolSize: 1,
        inferencePoolSize: 1,
        turnIdleTimeoutMs: 1000,
      });
      try {
        const events: AgentEvent[] = [];
        for await (const event of service
          .createBackend({
            model: "gpt-example-frontier",
            lane: lane === "owner" ? "interactive" : lane,
          })
          .runTurn(
            {
              sessionId: "idle-propagation",
              messageId: lane,
              userMessage: "Wait for scripted output.",
              systemPrompt: "",
              history: [],
              tools: [],
            },
            AbortSignal.timeout(5000),
          ))
          events.push(event);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "agent.error",
              payload: expect.objectContaining({ code: "codex_turn_idle_timeout" }),
            }),
          ]),
        );
      } finally {
        await service.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    10000,
  );

  it("defaults to four background turns with independent interactive capacity and immediate refill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-capacity-"));
    let finish!: () => void;
    let finishSecond!: () => void;
    const allDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const secondDone = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const started: string[] = [];
    const turn = vi
      .spyOn(CodexAppServerRuntime.prototype, "runTurn")
      .mockImplementation(async function* (opts) {
        const message = opts.input.userMessage;
        started.push(message);
        if (message.startsWith("background-")) {
          await (message === "background-1" ? Promise.race([allDone, secondDone]) : allDone);
        }
        yield* [];
      });
    const service = new CodexRuntimeService({ configDir: dir });
    const run = async (lane: "background" | "interactive", userMessage: string) => {
      const backend = service.createBackend({ model: "gpt-example-frontier", lane });
      for await (const event of backend.runTurn({
        sessionId: "synthetic-session",
        messageId: userMessage,
        userMessage,
        systemPrompt: "",
        history: [],
        tools: [],
      }))
        void event;
    };
    const runs = Array.from({ length: 5 }, (_, index) => run("background", `background-${index}`));
    try {
      await waitUntil(async () => started.length === 4);
      expect(started).toEqual(["background-0", "background-1", "background-2", "background-3"]);
      await run("interactive", "interactive");
      expect(started).toContain("interactive");
      finishSecond();
      await waitUntil(async () => started.includes("background-4"));
    } finally {
      finish();
      await Promise.all(runs);
      await service.dispose();
      turn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts current Codex device codes with a longer second group", () => {
    expect(
      parseCodexDeviceLoginOutput(
        "Open https://auth.openai.com/codex/device\nEnter this one-time code ABCD-12345 (expires in 15 minutes)",
      ),
    ).toMatchObject({
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    });
  });

  it("logs out by deleting the dedicated Codex auth file even if the CLI logout command fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-logout-"));
    try {
      const codexHome = join(dir, "codex-home");
      const authPath = join(codexHome, "auth.json");
      await mkdir(codexHome, { recursive: true });
      await writeFile(authPath, "{}", { mode: 0o600 });

      const service = new CodexRuntimeService({
        configDir: dir,
        command: join(dir, "missing-codex"),
        refreshTimeoutMs: 50,
      });
      const result = await service.logout();

      expect(result.status.configured).toBe(false);
      expect(result.status.loggedIn).toBe(false);
      expect(result.status.models).toEqual([]);
      expect(service.snapshot()).toEqual(result.status);
      await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports Codex as unconfigured without creating a Codex home when no auth is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-unconfigured-"));
    try {
      const codexHome = join(dir, "codex-home");
      const service = new CodexRuntimeService({
        configDir: dir,
        command: join(dir, "missing-codex"),
        refreshTimeoutMs: 50,
      });

      const status = await service.refresh();

      expect(status.configured).toBe(false);
      expect(status.loggedIn).toBe(false);
      expect(status.status).toBe("unreachable");
      expect(status.models).toEqual([]);
      expect(status.reason).toBe("Codex is not configured.");
      expect(service.snapshot()).toEqual(status);
      await expect(access(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "refreshes model roles including explicit text-only capabilities (%s)",
    async (textOnly) => {
      if (textOnly)
        vi.spyOn(CodexAppServerRuntime.prototype, "listModels").mockResolvedValue([
          { id: "gpt-example-frontier", inputModalities: ["text"] },
        ]);
      const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-refresh-"));
      try {
        const codexHome = join(dir, "codex-home");
        await mkdir(codexHome, { recursive: true });
        await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });

        const service = new CodexRuntimeService({
          configDir: dir,
          command: process.execPath,
          args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
          versionArgs: [fakeCodexPath, "--version"],
          refreshTimeoutMs: 2_000,
        });
        const status = await service.refresh();

        expect(status.status).toBe("ok");
        expect(status.loggedIn).toBe(true);
        expect(status.runtime).toMatchObject({
          source: "override",
          command: process.execPath,
          version: "0.142.4",
          supported: true,
        });
        expect(status.discovery).toBe("app-server");
        expect(status.models).toEqual(["gpt-example-frontier"]);
        expect(status.modelRoles).toEqual({
          "gpt-example-frontier": CODEX_SUPPORTED_ROLES.filter(
            (role) => !textOnly || role !== "ocr",
          ),
        });
        await service.dispose();
      } finally {
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("keeps canceled login isolated until its child exits and owns it during shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-login-shutdown-"));
    const managed = {
      source: "managed" as const,
      command: process.execPath,
      packageName: "@openai/codex",
      packageVersion: "0.142.4",
      version: "0.142.4",
      installDir: join(dir, "codex-runtimes", "versions", "0.142.4--current"),
    };
    const installer = {
      readActive: async () => managed,
    } as unknown as CodexRuntimeInstaller;
    const service = new CodexRuntimeService({
      configDir: dir,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      installer,
      env: { ...process.env, OMNESIS_FAKE_CODEX_IGNORE_TERM: "1" },
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });
    const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
    await configStore.load();

    try {
      const flow = await service.startDeviceLogin();
      expect(flow.status).toBe("pending");
      await expect(service.setupAgent(configStore, "gpt-example-frontier")).rejects.toThrow(
        ["Another", "Codex lifecycle operation"].join(" "),
      );
      expect(service.cancelLogin().flow?.status).toBe("canceled");
      await expect(service.startRuntimeUpdate({ dryRun: false })).rejects.toThrow(
        "Finish or cancel",
      );
      await expect(service.startDeviceLogin()).rejects.toThrow("previous Codex login process");
      await expect(service.dispose()).resolves.toBeUndefined();
    } finally {
      configStore.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reschedules login expiry to the lifetime advertised by Codex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-login-expiry-"));
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const service = new CodexRuntimeService({
      configDir: dir,
      command: process.execPath,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      env: { ...process.env, OMNESIS_FAKE_CODEX_LOGIN_MINUTES: "1" },
      loginTtlMs: 15 * 60_000,
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });

    try {
      const flow = await service.startDeviceLogin();
      expect(flow.expiresAt).toBeDefined();
      expect(timerSpy.mock.calls.some(([, delay]) => delay === 65_000)).toBe(true);
      service.cancelLogin();
    } finally {
      timerSpy.mockRestore();
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalidates a pre-login refresh when device authentication completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-refresh-login-"));
    let planProbeStarted = false;
    let releasePlanProbe!: () => void;
    const planProbeGate = new Promise<void>((resolve) => {
      releasePlanProbe = resolve;
    });
    const originalProbe = CodexAppServerRuntime.prototype.probeRuntime;
    let probeCalls = 0;
    vi.spyOn(CodexAppServerRuntime.prototype, "probeRuntime").mockImplementation(async function (
      this: CodexAppServerRuntime,
      timeoutMs,
    ) {
      probeCalls += 1;
      if (probeCalls === 2) {
        planProbeStarted = true;
        await planProbeGate;
      }
      return originalProbe.call(this, timeoutMs);
    });
    const service = new CodexRuntimeService({
      configDir: dir,
      command: process.execPath,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      env: { ...process.env, OMNESIS_FAKE_CODEX_LOGIN_AUTO_COMPLETE: "1" },
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });

    try {
      const staleRefresh = service.refresh();
      await waitUntil(async () => planProbeStarted);
      await service.startDeviceLogin();
      await waitUntil(async () => service.getLoginFlow()?.status === "complete");
      await waitUntil(async () => service.snapshot().status === "ok");
      releasePlanProbe();
      await staleRefresh;
      expect(service.snapshot()).toMatchObject({ configured: true, loggedIn: true, status: "ok" });
    } finally {
      releasePlanProbe();
      vi.restoreAllMocks();
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a new login while logout is canceling the pending flow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-login-logout-"));
    const service = new CodexRuntimeService({
      configDir: dir,
      command: process.execPath,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      env: { ...process.env, OMNESIS_FAKE_CODEX_IGNORE_TERM: "1" },
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });

    try {
      await service.startDeviceLogin();
      const logout = service.logout();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(service.startDeviceLogin()).rejects.toBeInstanceOf(
        CodexRuntimeLifecycleConflictError,
      );
      await logout;
    } finally {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes agent setup against logout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-agent-setup-"));
    const codexHome = join(dir, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
    await configStore.load();
    const service = new CodexRuntimeService({
      configDir: dir,
      command: process.execPath,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });
    const originalUpdate = configStore.update.bind(configStore);
    let updateEntered = false;
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(configStore, "update").mockImplementation(async (transform) => {
      updateEntered = true;
      await updateGate;
      return originalUpdate(transform);
    });

    try {
      const setup = service.setupAgent(configStore, "gpt-example-frontier");
      await waitUntil(async () => updateEntered);
      await expect(service.logout()).rejects.toThrow(
        ["Another", "Codex lifecycle operation"].join(" "),
      );
      releaseUpdate();
      await expect(setup).resolves.toMatchObject({
        assignment: "codex/gpt-example-frontier",
        allowRemoteInference: true,
      });
      await expect(access(join(codexHome, "auth.json"))).resolves.toBeUndefined();
    } finally {
      releaseUpdate();
      vi.restoreAllMocks();
      await service.dispose();
      configStore.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalidates a refresh that outlives logout before admitting agent setup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-refresh-logout-"));
    const codexHome = join(dir, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
    await configStore.load();
    let listStarted = false;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    vi.spyOn(CodexAppServerRuntime.prototype, "listModels").mockImplementationOnce(async () => {
      listStarted = true;
      await listGate;
      return [{ id: "gpt-example-frontier" }];
    });
    const service = new CodexRuntimeService({
      configDir: dir,
      command: process.execPath,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });

    try {
      const staleRefresh = service.refresh();
      await waitUntil(async () => listStarted);
      await service.logout();

      const setup = service.setupAgent(configStore, "gpt-example-frontier");
      const setupRejected = expect(setup).rejects.toBeInstanceOf(AgentSetupUnavailableError);
      releaseList();
      await Promise.all([staleRefresh, setupRejected]);
      expect(configStore.get().inference?.assignments?.agent).toBeUndefined();
      expect(service.snapshot()).toMatchObject({ configured: false, loggedIn: false });
    } finally {
      releaseList();
      vi.restoreAllMocks();
      await service.dispose();
      configStore.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("joins login preflight on shutdown and never spawns afterward", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-login-preflight-shutdown-"));
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
    const service = new CodexRuntimeService({
      configDir: dir,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      installer,
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });

    try {
      const login = service.startDeviceLogin();
      await waitUntil(async () => readStarted);
      let disposed = false;
      const disposal = service.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(false);
      releaseRead();
      await expect(login).rejects.toThrow("service disposed");
      await disposal;
      expect(service.getLoginFlow()).toBeNull();
    } finally {
      releaseRead();
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drains an active turn, blocks new admission, and switches without restarting the gateway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-live-update-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OMNESIS_FAKE_CODEX_VERSION: "0.142.4",
      OMNESIS_FAKE_CODEX_SCENARIO: "tool",
      OMNESIS_FAKE_CODEX_LOG: join(dir, "codex.jsonl"),
    };
    const managed = (version: string) => ({
      source: "managed" as const,
      command: process.execPath,
      packageName: "@openai/codex",
      packageVersion: version,
      version,
      installDir: join(dir, "codex-runtimes", "versions", version),
    });
    const installer = {
      readActive: async () => managed("0.142.4"),
      prepare: async (
        _signal?: AbortSignal,
        onPhase?: (phase: "downloading" | "verifying") => void,
      ) => {
        onPhase?.("downloading");
        onPhase?.("verifying");
        return {
          id: "update-1",
          version: CODEX_RUNTIME_COMPAT.testedVersion,
          stagingDir: join(dir, "staging"),
        };
      },
      commit: async () => {
        env.OMNESIS_FAKE_CODEX_VERSION = CODEX_RUNTIME_COMPAT.testedVersion;
        env.OMNESIS_FAKE_CODEX_SCENARIO = "no-tool";
        return managed(CODEX_RUNTIME_COMPAT.testedVersion);
      },
      discard: async () => {},
    } as unknown as CodexRuntimeInstaller;
    const service = new CodexRuntimeService({
      configDir: dir,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      env,
      installer,
      interactivePoolSize: 0,
      refreshTimeoutMs: 2_000,
    });
    const input = {
      sessionId: "session_synthetic",
      messageId: "message_synthetic",
      history: [],
      userMessage: "Summarize the fictional project notes.",
      tools: [],
      systemPrompt: "Use only Omnesis tools.",
    };
    const collect = async (events: AsyncIterable<AgentEvent>) => {
      const seen: AgentEvent[] = [];
      for await (const event of events) seen.push(event);
      return seen;
    };

    try {
      let releaseTool!: () => void;
      let toolStarted = false;
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const oldTurn = collect(
        service.createBackend({ model: "gpt-example-frontier", lane: "background" }).runTurn({
          ...input,
          tools: [
            {
              name: "search_documents",
              description: "Search fictional documents.",
              schema: z.object({ query: z.string().optional() }),
              async invoke() {
                toolStarted = true;
                await toolGate;
                const child = await collect(
                  service
                    .createBackend({ model: "gpt-example-frontier", lane: "inference" })
                    .runTurn(input),
                );
                expect(child.some((event) => event.type === "agent.message.end")).toBe(true);
                return {
                  kind: "search.results" as const,
                  query: "fictional project notes",
                  durationMs: 1,
                  results: [],
                };
              },
              summarize: () => "fictional project notes",
            },
          ],
        }),
      );
      await waitUntil(async () => toolStarted);
      expect((await service.getRuntimeUpdate()).plan).toMatchObject({
        state: "update-available",
        currentVersion: "0.142.4",
        targetVersion: CODEX_RUNTIME_COMPAT.testedVersion,
      });
      expect((await service.startRuntimeUpdate({ dryRun: false })).operation?.state).toBe(
        "checking",
      );
      await waitUntil(
        async () => (await service.getRuntimeUpdate()).operation?.state === "waiting-for-turns",
      );

      let secondFinished = false;
      const newTurn = collect(
        service.createBackend({ model: "gpt-example-frontier" }).runTurn({
          ...input,
          messageId: "message_synthetic_2",
        }),
      ).then((events) => {
        secondFinished = true;
        return events;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondFinished).toBe(false);

      releaseTool();
      await oldTurn;
      await waitUntil(
        async () => (await service.getRuntimeUpdate()).operation?.state === "complete",
      );
      expect(await newTurn).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "agent.message.end" })]),
      );
      expect((await service.getRuntimeUpdate()).plan.state).toBe("up-to-date");
    } finally {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a healthy previous runtime updateable when the download fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-update-failure-"));
    const oldRuntime = {
      source: "managed" as const,
      command: process.execPath,
      packageName: "@openai/codex",
      packageVersion: "0.142.4",
      version: "0.142.4",
      installDir: join(dir, "runtime"),
    };
    const installer = {
      readActive: async () => oldRuntime,
      prepare: async () => {
        throw new Error("Synthetic registry unavailable.");
      },
    } as unknown as CodexRuntimeInstaller;
    const service = new CodexRuntimeService({
      configDir: dir,
      args: [fakeCodexPath, "app-server", "--listen", "stdio://"],
      versionArgs: [fakeCodexPath, "--version"],
      env: { ...process.env, OMNESIS_FAKE_CODEX_VERSION: "0.142.4" },
      installer,
      interactivePoolSize: 0,
    });

    try {
      await service.startRuntimeUpdate({ dryRun: false });
      await waitUntil(async () => (await service.getRuntimeUpdate()).operation?.state === "failed");
      expect((await service.getRuntimeUpdate()).plan).toMatchObject({
        state: "update-available",
        currentVersion: "0.142.4",
      });
    } finally {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts and joins an in-progress download on cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-update-cancel-"));
    let aborted = false;
    const installer = {
      readActive: async () => ({
        source: "managed" as const,
        command: process.execPath,
        packageName: "@openai/codex",
        packageVersion: "0.142.4",
        version: "0.142.4",
        installDir: join(dir, "runtime"),
      }),
      prepare: async (
        signal?: AbortSignal,
        onPhase?: (phase: "downloading" | "verifying") => void,
      ) =>
        new Promise<never>((_resolve, reject) => {
          onPhase?.("downloading");
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    } as unknown as CodexRuntimeInstaller;
    const service = new CodexRuntimeService({
      configDir: dir,
      args: [fakeCodexPath],
      versionArgs: [fakeCodexPath, "--version"],
      env: { ...process.env, OMNESIS_FAKE_CODEX_VERSION: "0.142.4" },
      installer,
      interactivePoolSize: 0,
    });

    try {
      await service.startRuntimeUpdate({ dryRun: false });
      await waitUntil(
        async () => (await service.getRuntimeUpdate()).operation?.state === "downloading",
      );
      await service.cancelRuntimeUpdate();
      await waitUntil(
        async () => (await service.getRuntimeUpdate()).operation?.state === "canceled",
      );
      expect(aborted).toBe(true);
    } finally {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Codex runtime state.");
}
