// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRuntime } from "@omnesis/agent";
import { z } from "zod";
import { CODEX_SUPPORTED_ROLES, type AgentEvent } from "@omnesis/core";
import { ConfigStore } from "../config-store.js";
import { CodexAgentSetupUnavailableError } from "./codex-agent-setup.js";
import { CodexRuntimeLifecycleConflictError } from "./codex-runtime-lifecycle.js";
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
      releaseList();
      await staleRefresh;
      await expect(setup).rejects.toBeInstanceOf(CodexAgentSetupUnavailableError);
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
          version: "0.151.0",
          stagingDir: join(dir, "staging"),
        };
      },
      commit: async () => {
        env.OMNESIS_FAKE_CODEX_VERSION = "0.151.0";
        env.OMNESIS_FAKE_CODEX_SCENARIO = "no-tool";
        return managed("0.151.0");
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
        targetVersion: "0.151.0",
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
