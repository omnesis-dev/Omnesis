// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { CodexAppServerRuntime } from "./codex-app-server-backend.js";
import { resolveManagedCodexNativeCommand } from "./codex-managed-native-command.js";
import { managedCodexArgs, assertManagedCodexPolicy } from "./codex-managed-auth.js";
import { assertManagedCodexEffectiveFeatures } from "./codex-managed-process.js";
import {
  prepareManagedCodexModelCatalog,
  assertManagedCodexStaticCatalog,
} from "./codex-managed-model-discovery.js";
import type { NodeCommandInvocation, AgentEvent } from "@omnesis/core";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid scripted RPC shape");
  return value as Json;
};

/** Actual pinned SDK metadata discovery and scripted responses; no model inference or login. */
test.each([null, "code_mode_only"])(
  "vendor-discovered native-capable metadata %s is isolated before a static worker receives a turn",
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-catalog-runtime-fixture-")));
    const scope = {
      configDir: join(root, "library"),
      instance: "desktop-" + "a".repeat(16),
      secretService: "dev.omnesis.desktop." + "b".repeat(64),
    };
    const home = join(scope.configDir, "codex-home", scope.instance),
      state = join(root, "worker"),
      workspace = join(root, "workspace");
    for (const path of [home, state, workspace])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const sentinels = {
      prompt: "FICTIONAL_CATALOG_PROMPT_9d4a",
      system: "FICTIONAL_CATALOG_SYSTEM_9d4a",
      argument: "FICTIONAL_CATALOG_ARGUMENT_9d4a",
      result: "FICTIONAL_CATALOG_RESULT_9d4a",
      answer: "FICTIONAL_CATALOG_ANSWER_9d4a",
    };
    const marker = join(root, "forbidden-exec");
    for (const profile of [
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".zshenv",
      ".zprofile",
      ".zshrc",
    ])
      await writeFile(join(root, profile), `printf forbidden > '${marker}'\n`, { mode: 0o600 });
    const model = {
      slug: "fictional-native-capable",
      display_name: "Fictional catalog fixture",
      description: null,
      supported_reasoning_levels: [],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      upgrade: null,
      model_messages: { instructions_template: "Use the fictional fixture tools." },
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "bytes", limit: 10000 },
      experimental_supported_tools: [],
      tool_mode: mode,
      multi_agent_tools_in_code_mode: true,
      context_window: 123456,
    };
    const requests: Json[] = [],
      toolsCalled: unknown[] = [];
    let modelRequests = 0,
      unexpected = 0,
      refuseProvider = false;
    const server = createServer(async (request, response) => {
      let bytes = "";
      for await (const chunk of request) {
        bytes += chunk;
        if (bytes.length > 1024 * 1024) {
          response.writeHead(413);
          response.end();
          return;
        }
      }
      if (
        !request.url?.startsWith("/") ||
        request.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`
      ) {
        unexpected++;
        response.writeHead(403).end();
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/models")) {
        modelRequests++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ models: [model] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        unexpected++;
        response.writeHead(403);
        response.end();
        return;
      }
      requests.push(record(JSON.parse(bytes)));
      if (refuseProvider) {
        response.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            error: { type: "invalid_request_error", message: Object.values(sentinels).join(" ") },
          }),
        );
        return;
      }
      const call = ((requests.length - 1) % 3) + 1;
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      const item =
        call === 1
          ? {
              type: "function_call",
              id: "fc_unsupported",
              call_id: "unsupported",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: `printf forbidden > '${marker}'` }),
              status: "completed",
            }
          : call === 2
            ? {
                type: "function_call",
                id: "fc_fixture",
                call_id: "fixture",
                name: "fictional_probe",
                arguments: JSON.stringify({ value: sentinels.argument }),
                status: "completed",
              }
            : {
                type: "message",
                id: "msg_fixture",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: sentinels.answer, annotations: [] }],
              };
      emit({
        type: "response.created",
        response: { id: `response_${call}`, status: "in_progress", output: [] },
      });
      emit({ type: "response.output_item.added", output_index: 0, item });
      if (item.type === "message") {
        emit({
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        emit({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: sentinels.answer,
        });
        emit({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: sentinels.answer,
        });
      }
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({
        type: "response.completed",
        response: {
          id: `response_${call}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind loopback");
    const url = `http://127.0.0.1:${address.port}`;
    const require = createRequire(import.meta.url),
      codex = join(dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js");
    const native = await resolveManagedCodexNativeCommand({
      source: "managed",
      command: codex,
      packageName: "@openai/codex",
      packageVersion: "0.171.0",
    });
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      CODEX_HOME: home,
      TMPDIR: root,
      RUST_LOG: "off",
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ALL_PROXY: url,
      NO_PROXY: "127.0.0.1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: workspace,
    };
    const args = managedCodexArgs(
      { OMNESIS_DESKTOP_MANAGED: "1" },
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'model_provider="fictional"',
        "-c",
        'model_providers.fictional.name="Fictional provider"',
        "-c",
        `model_providers.fictional.base_url=${JSON.stringify(url)}`,
        "-c",
        'model_providers.fictional.wire_api="responses"',
        "-c",
        "model_providers.fictional.requires_openai_auth=false",
        "-c",
        "model_providers.fictional.supports_websockets=false",
        "-c",
        `model_providers.fictional.model_catalog_url=${JSON.stringify(url + "/models")}`,
        "-c",
        "features.api_key_model_discovery=true",
        "-c",
        'model_providers.fictional.experimental_bearer_token="invented-not-a-credential"',
      ],
      state,
    );
    const clients: FixtureRPC[] = [];
    let discoveryDisposed = false,
      previous: string | null = null;
    try {
      const descriptor = await prepareManagedCodexModelCatalog({
        scope,
        codexHome: home,
        stateHome: state,
        command: native.command,
        args,
        version: "0.171.0",
        timeoutMs: 10000,
        // Source-host fixture seam; kernel EX/witness behavior has its own admitted macOS tests.
        platform: {
          invocation: (command, args) => ({ command, args: [...args] }),
          previousSha256: async () => {
            expect(discoveryDisposed).toBe(true);
            return previous;
          },
        },
        open: async (invocation) => {
          try {
            previous = createHash("sha256")
              .update(await readFile(join(home, "models_cache.json")))
              .digest("hex");
          } catch (error) {
            if (
              !error ||
              typeof error !== "object" ||
              !("code" in error) ||
              error.code !== "ENOENT"
            )
              throw error;
          }
          const client = await FixtureRPC.open(invocation, env);
          clients.push(client);
          return {
            request: client.request.bind(client),
            dispose: async () => {
              await client.dispose();
              discoveryDisposed = true;
            },
          };
        },
      });
      expect(modelRequests).toBeGreaterThan(0);
      expect(requests).toHaveLength(0);
      await expect(readFile(join(home, "models_cache.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const catalog = record(JSON.parse(await readFile(descriptor.path, "utf8")));
      expect(Object.keys(catalog)).toEqual(["models"]);
      expect((catalog.models as Json[])[0]).toMatchObject({
        slug: model.slug,
        context_window: 123456,
        apply_patch_tool_type: null,
        shell_type: "disabled",
        tool_mode: "direct",
        multi_agent_tools_in_code_mode: false,
      });
      const worker = await FixtureRPC.open(
        {
          command: native.command,
          args: [...args, "-c", `model_catalog_json=${JSON.stringify(descriptor.path)}`],
        },
        env,
      );
      clients.push(worker);
      const config = await worker.request("config/read", { includeLayers: true });
      assertManagedCodexPolicy(config);
      await assertManagedCodexStaticCatalog(descriptor, config, model.slug);
      await assertManagedCodexEffectiveFeatures(
        (params) => worker.request("experimentalFeature/list", params),
        undefined,
        "0.171.0",
      );
      const finished = worker.completed();
      worker.tool = async (params) => {
        toolsCalled.push(params);
        return { contentItems: [{ type: "inputText", text: sentinels.result }], success: true };
      };
      const thread = record(
        record(
          await worker.request("thread/start", {
            model: model.slug,
            cwd: workspace,
            ephemeral: true,
            approvalPolicy: "never",
            sandbox: "read-only",
            developerInstructions: sentinels.system,
            dynamicTools: [
              {
                name: "fictional_probe",
                description: "An invented fixture tool",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
          }),
        ).thread,
      );
      await worker.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: sentinels.prompt }],
      });
      await finished;
      expect(requests).toHaveLength(3);
      for (const request of requests)
        expect((request.tools as Json[]).map((tool) => tool.name ?? tool.type)).toEqual([
          "fictional_probe",
        ]);
      expect(JSON.stringify(requests[1]?.input)).toMatch(/unsupported|not found|not supported/iu);
      expect(toolsCalled).toHaveLength(1);
      expect(JSON.stringify(toolsCalled[0])).toContain(sentinels.argument);
      await worker.dispose();
      // Exercise the production runtime's complete discovery/static-startup adapter too.
      const witnesses = new Map<string, string | null>();
      const runtime = new CodexAppServerRuntime({
        codexHome: home,
        stateHome: join(root, "backend-state"),
        workspaceDir: workspace,
        commandInfo: native,
        args,
        env: {
          ...env,
          OMNESIS_DESKTOP_MANAGED: "1",
          OMNESIS_CONFIG_DIR: scope.configDir,
          OMNESIS_SERVICE_INSTANCE: scope.instance,
          OMNESIS_SECRET_SERVICE: scope.secretService,
        },
        resolveManagedCommand: async (info) => info,
        managedCatalogPlatform: {
          invocation(command, argv, nonce) {
            let previous: string | null = null;
            try {
              previous = createHash("sha256")
                .update(readFileSync(join(home, "models_cache.json")))
                .digest("hex");
            } catch (error) {
              if (
                !error ||
                typeof error !== "object" ||
                !("code" in error) ||
                error.code !== "ENOENT"
              )
                throw error;
            }
            witnesses.set(nonce, previous);
            return {
              command: "/bin/sh",
              args: ["-c", 'umask 077; exec "$@"', "omnesis-catalog-fixture", command, ...argv],
            };
          },
          previousSha256: async (_scope, nonce) => {
            if (!witnesses.has(nonce)) throw new Error("Missing fixture OS witness");
            return witnesses.get(nonce)!;
          },
        },
      });
      try {
        expect(await runtime.listModels()).toEqual(
          expect.arrayContaining([expect.objectContaining({ model: model.slug })]),
        );
        await expect(readFile(join(home, "models_cache.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(requests).toHaveLength(3);
        const invoke = vi.fn(async () => ({
          kind: "structured" as const,
          resultType: "fixture",
          data: { result: sentinels.result },
        }));
        const turn = (selectedModel: string) =>
          runtime.runTurn({
            model: selectedModel,
            toolTimeoutMs: 1000,
            maxToolIterations: 4,
            signal: AbortSignal.timeout(15000),
            input: {
              sessionId: "fixture-session",
              messageId: "fixture-message",
              history: [],
              userMessage: sentinels.prompt,
              systemPrompt: sentinels.system,
              tools: [
                {
                  name: "fictional_probe",
                  description: "An invented fixture tool",
                  schema: z.object({ value: z.string() }),
                  invoke,
                },
              ],
            },
          });
        const unknown: AgentEvent[] = [];
        for await (const event of turn("unlisted-fictional-model")) unknown.push(event);
        expect(unknown.some((event) => event.type === "agent.error")).toBe(true);
        expect(requests).toHaveLength(3);
        const events: AgentEvent[] = [];
        for await (const event of turn(model.slug)) events.push(event);
        expect(
          events.some((event) => event.type === "agent.error"),
          JSON.stringify(events),
        ).toBe(false);
        expect(JSON.stringify(events)).toContain(sentinels.answer);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(6);
        for (const request of requests)
          expect((request.tools as Json[]).map((tool) => tool.name ?? tool.type)).toEqual([
            "fictional_probe",
          ]);
        expect(JSON.stringify(requests[4]?.input)).toMatch(/unsupported|not found|not supported/iu);
        refuseProvider = true;
        const failure: AgentEvent[] = [];
        for await (const event of turn(model.slug)) failure.push(event);
        expect(failure.some((event) => event.type === "agent.error")).toBe(true);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(7);
      } finally {
        await runtime.dispose();
      }
      const probe = new CodexAppServerRuntime({
        purpose: "compatibility-probe",
        codexHome: join(root, ".omnesis-compat-probe", "home"),
        workspaceDir: join(root, ".omnesis-compat-probe", "workspace"),
        commandInfo: native,
        resolveManagedCommand: async (info) => info,
        args,
        env: {
          ...env,
          OMNESIS_DESKTOP_MANAGED: "1",
          OMNESIS_CONFIG_DIR: scope.configDir,
          OMNESIS_SERVICE_INSTANCE: scope.instance,
          OMNESIS_SECRET_SERVICE: scope.secretService,
        },
      });
      try {
        await probe.probeProtocolModels();
        await expect(probe.listModels()).rejects.toThrow(/cannot supply selectable models/u);
        const rejected: AgentEvent[] = [];
        for await (const event of probe.runTurn({
          model: model.slug,
          toolTimeoutMs: 1000,
          maxToolIterations: 1,
          input: {
            sessionId: "probe-session",
            messageId: "probe-message",
            history: [],
            userMessage: sentinels.prompt,
            systemPrompt: sentinels.system,
            tools: [],
          },
        }))
          rejected.push(event);
        expect(rejected.some((event) => event.type === "agent.error")).toBe(true);
        expect(requests).toHaveLength(7);
        await expect(readFile(join(home, "models_cache.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await probe.dispose();
      }
      expect(unexpected).toBe(0);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(join(home, "shell_snapshots"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await readdir(join(state, "sqlite"))).some((name) => /^state_\d+\.sqlite$/u.test(name)),
      ).toBe(true);
      expect(
        (await readdir(join(state, "log"))).some((name) => /^logs_\d+\.sqlite$/u.test(name)),
      ).toBe(true);
      const files = await allFiles(root);
      for (const path of files) {
        const bytes = await readFile(path);
        for (const value of Object.values(sentinels))
          expect(
            bytes.includes(value),
            `Scripted content persisted in ${path.slice(root.length)}`,
          ).toBe(false);
      }
    } finally {
      for (const client of clients) await client.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

async function allFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) paths.push(...(await allFiles(path)));
    else if (item.isFile()) paths.push(path);
  }
  return paths;
}

class FixtureRPC {
  private id = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private child;
  private closed: Promise<void>;
  private ended = false;
  private completion?: () => void;
  tool?: (params: unknown) => Promise<unknown>;
  private constructor(invocation: NodeCommandInvocation, env: NodeJS.ProcessEnv) {
    this.child = spawn(
      "/bin/sh",
      [
        "-c",
        'umask 077; exec "$@"',
        "omnesis-catalog-fixture",
        invocation.command,
        ...invocation.args,
      ],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr.on("data", () => {});
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => {
        this.ended = true;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("The owned fixture RPC process exited"));
        }
        this.pending.clear();
        resolve();
      }),
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = record(JSON.parse(line));
      const id = message.id;
      if (typeof id === "number" && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error("The owned fixture RPC refused a request"));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "item/tool/call" && this.tool) {
        void this.tool(message.params).then((result) => this.write({ id, result }));
      }
      if (message.method === "turn/completed") this.completion?.();
    });
  }
  static async open(
    invocation: NodeCommandInvocation,
    env: NodeJS.ProcessEnv,
  ): Promise<FixtureRPC> {
    const client = new FixtureRPC(invocation, env);
    try {
      await client.request("initialize", {
        clientInfo: { name: "omnesis-fixture", version: "1" },
        capabilities: { experimentalApi: true },
      });
      client.write({ method: "initialized", params: {} });
      assertManagedCodexPolicy(await client.request("config/read", { includeLayers: true }));
      await assertManagedCodexEffectiveFeatures(
        (params) => client.request("experimentalFeature/list", params),
        undefined,
        "0.171.0",
      );
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }
  private write(message: unknown) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The owned fixture RPC exceeded its bound"));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  completed(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The scripted turn did not finish")), 10000);
      this.completion = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  async dispose(): Promise<void> {
    if (this.ended) return;
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.child.kill("SIGKILL");
            reject(new Error("The owned SDK did not drain within its shutdown bound"));
          }, 3000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
