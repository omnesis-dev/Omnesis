// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MANAGED_CODEX_QUALIFIED_VERSION } from "../../packages/agent/src/codex-managed-policy-version.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CodexAppServerRuntime } from "../../packages/agent/src/codex-app-server-backend.js";

const config = process.env.OMNESIS_CONFIG_DIR,
  instance = process.env.OMNESIS_SERVICE_INSTANCE;
assert.ok(config && instance && process.env.OMNESIS_SECRET_SERVICE);
assert.equal(process.env.OMNESIS_DESKTOP_MANAGED, "1");
const codeRoot = new URL(".", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(codeRoot, "desktop-runtime.json"), "utf8"));
const sdkEntry = manifest.inventory.find((item) =>
  /^sdk-package\/vendor\/[^/]+\/bin\/codex$/u.test(item.path),
);
assert.ok(sdkEntry?.executable);
const command = join(codeRoot, sdkEntry.path);
const home = join(config, "codex-home", instance);
await mkdir(home, { recursive: true, mode: 0o700 });
const forbidden = join(config, "forbidden-native-execution");
const forbiddenTrace = join(config, "forbidden-trace-output");
const gitBin = join(config, "fixture-bin");
await mkdir(gitBin, { mode: 0o700 });
await writeFile(
  join(gitBin, "git"),
  `#!/bin/sh
printf forbidden > '${forbidden}'
exit 1
`,
  { mode: 0o700 },
);
const otelHelper = join(gitBin, "fixture-otel-headers");
await writeFile(
  otelHelper,
  `#!/bin/sh\nprintf forbidden > '${forbidden}'\nprintf '{}'
`,
  { mode: 0o700 },
);
process.env.PATH = `${gitBin}:/usr/bin:/bin`;

for (const rc of [".bashrc", ".bash_profile", ".profile", ".zshenv", ".zprofile", ".zshrc"])
  await writeFile(join(process.env.HOME, rc), `printf forbidden > '${forbidden}'\n`, {
    mode: 0o600,
  });

for (const mode of [null, "code_mode_only"]) {
  const marker = mode === null ? "direct" : "code";
  const sentinels = {
    system: `FICTIONAL_NATIVE_SYSTEM_${marker}`,
    prompt: `FICTIONAL_NATIVE_PROMPT_${marker}`,
    argument: `FICTIONAL_NATIVE_ARGUMENT_${marker}`,
    result: `FICTIONAL_NATIVE_RESULT_${marker}`,
    answer: `FICTIONAL_NATIVE_ANSWER_${marker}`,
  };
  const model = {
    slug: "fictional-native-capable",
    display_name: "Fictional model fixture",
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
  const requests = [];
  let modelRequests = 0,
    unexpected = 0,
    toolCalls = 0,
    refuseProvider = false;
  const server = createServer(async (request, response) => {
    let bytes = "";
    for await (const chunk of request) {
      bytes += chunk;
      if (bytes.length > 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
    }
    if (
      !request.url?.startsWith("/") ||
      request.headers.host !== `127.0.0.1:${server.address().port}`
    ) {
      unexpected++;
      response.writeHead(403).end();
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/models")) {
      modelRequests++;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ models: [model] }));
      return;
    }
    if (request.method !== "POST" || !request.url.endsWith("/responses")) {
      unexpected++;
      response.writeHead(403).end();
      return;
    }
    requests.push(JSON.parse(bytes));
    if (refuseProvider) {
      response.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: { type: "invalid_request_error", message: Object.values(sentinels).join(" ") },
        }),
      );
      return;
    }
    const call = requests.length;
    const item =
      call === 1
        ? {
            type: "function_call",
            id: "fc_unsupported",
            call_id: "unsupported",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: `printf forbidden > '${forbidden}'` }),
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
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    const emit = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = join(config, "worker-state", marker),
    workspace = join(config, "workspace", marker);
  const runtime = new CodexAppServerRuntime({
    codexHome: home,
    stateHome: state,
    workspaceDir: workspace,
    commandInfo: {
      source: "managed",
      command,
      packageName: "@openai/codex",
      packageVersion: MANAGED_CODEX_QUALIFIED_VERSION,
    },
    env: {
      ...process.env,
      CODEX_ROLLOUT_TRACE_ROOT: forbiddenTrace,
      OPENAI_IDENTITY_TOKEN_SOURCE: "spiffe",
      OPENAI_SPIFFE_AUDIENCE: "fictional-audience",
      OPENAI_SPIFFE_ID: "fictional-identity",
      SPIFFE_ENDPOINT_SOCKET: join(config, "forbidden-identity-socket"),
    },
    startupTimeoutMs: 10000,
    requestTimeoutMs: 10000,
    args: [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      `otel.headers_helper=${JSON.stringify(otelHelper)}`,
      "-c",
      'model_provider="fictional"',
      "-c",
      'model_providers.fictional.name="Fictional provider"',
      "-c",
      `model_providers.fictional.base_url=${JSON.stringify(base)}`,
      "-c",
      'model_providers.fictional.wire_api="responses"',
      "-c",
      "model_providers.fictional.requires_openai_auth=false",
      "-c",
      "model_providers.fictional.supports_websockets=false",
      "-c",
      `model_providers.fictional.model_catalog_url=${JSON.stringify(base + "/models")}`,
      "-c",
      "features.api_key_model_discovery=true",
      "-c",
      'model_providers.fictional.experimental_bearer_token="invented-not-a-credential"',
    ],
  });
  try {
    const models = await runtime.listModels();
    assert.ok(models.some((item) => item.model === model.slug));
    assert.ok(modelRequests > 0);
    await assert.rejects(readFile(join(home, "models_cache.json")), { code: "ENOENT" });
    const turn = (selected) =>
      runtime.runTurn({
        model: selected,
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
              invoke: async () => {
                toolCalls++;
                return {
                  kind: "structured",
                  resultType: "fixture",
                  data: { result: sentinels.result },
                };
              },
            },
          ],
        },
      });
    const rejected = [];
    for await (const event of turn("unlisted-fictional-model")) rejected.push(event);
    assert.ok(rejected.some((event) => event.type === "agent.error"));
    assert.equal(requests.length, 0);
    const events = [];
    for await (const event of turn(model.slug)) events.push(event);
    assert.equal(
      events.some((event) => event.type === "agent.error"),
      false,
    );
    assert.ok(JSON.stringify(events).includes(sentinels.answer));
    assert.equal(toolCalls, 1);
    assert.equal(requests.length, 3);
    for (const request of requests)
      assert.deepEqual(
        request.tools.map((tool) => tool.name ?? tool.type),
        ["fictional_probe"],
      );
    assert.match(JSON.stringify(requests[1].input), /unsupported|not found|not supported/iu);
    assert.equal(unexpected, 0);
    refuseProvider = true;
    const failed = [];
    for await (const event of turn(model.slug)) failed.push(event);
    assert.ok(failed.some((event) => event.type === "agent.error"));
    assert.equal(toolCalls, 1);
    assert.equal(requests.length, 4);
  } finally {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(readFile(forbidden), { code: "ENOENT" });
  await assert.rejects(readdir(forbiddenTrace), { code: "ENOENT" });
  await assert.rejects(readdir(join(home, "shell_snapshots")), { code: "ENOENT" });
  assert.ok(
    (await readdir(join(state, "sqlite"))).some((name) => /^state_\d+\.sqlite$/u.test(name)),
  );
  assert.ok((await readdir(join(state, "log"))).some((name) => /^logs_\d+\.sqlite$/u.test(name)));
  for (const path of await allFiles(config)) {
    assert.ok(
      !/\.(?:zst|gz|zip)$/u.test(path),
      "Unexpected compressed SDK state requires privacy review",
    );
    const bytes = await readFile(path);
    for (const sentinel of Object.values(sentinels))
      assert.equal(bytes.includes(sentinel), false, "Fixture content persisted after disposal");
  }
}
// The actual native context cannot be repurposed by caller-supplied environment or homes.
for (const foreign of [false, true]) {
  const other = join(config, foreign ? "unrelated-profile" : "unrelated-home");
  const runtime = new CodexAppServerRuntime({
    codexHome: foreign ? home : other,
    workspaceDir: join(config, "refused-workspace"),
    commandInfo: {
      source: "managed",
      command,
      packageName: "@openai/codex",
      packageVersion: MANAGED_CODEX_QUALIFIED_VERSION,
    },
    env: foreign ? { ...process.env, OMNESIS_CONFIG_DIR: other } : process.env,
  });
  try {
    await assert.rejects(
      runtime.listModels(),
      foreign ? /verified process ownership/u : /scoped home/u,
    );
    await assert.rejects(readdir(other), { code: "ENOENT" });
  } finally {
    await runtime.dispose();
  }
}
for (const field of ["workspaceDir", "stateHome"]) {
  const other = join(process.env.HOME, "refused-" + field);
  const runtime = new CodexAppServerRuntime({
    codexHome: home,
    workspaceDir: join(config, "refused-workspace"),
    [field]: other,
    commandInfo: {
      source: "managed",
      command,
      packageName: "@openai/codex",
      packageVersion: MANAGED_CODEX_QUALIFIED_VERSION,
    },
    env: process.env,
  });
  try {
    await assert.rejects(runtime.listModels(), /inside this installation/u);
    await assert.rejects(readdir(other), { code: "ENOENT" });
  } finally {
    await runtime.dispose();
  }
}
process.stdout.write("codex-production-backend:passed\n");
async function allFiles(root) {
  const files = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) files.push(...(await allFiles(path)));
    else if (item.isFile()) files.push(path);
  }
  return files;
}
