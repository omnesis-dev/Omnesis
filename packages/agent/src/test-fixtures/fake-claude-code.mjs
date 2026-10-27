#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A stand-in for the `claude` CLI: `--version`, `auth status --json`, and a
 * print-mode stream-json session that speaks the control protocol Omnesis
 * drives. It never contacts a model; each scenario scripts one turn.
 *
 *   OMNESIS_FAKE_CLAUDE_VERSION    version printed by --version
 *   OMNESIS_FAKE_CLAUDE_LOGGED_IN  "0" reports a signed-out CLI
 *   OMNESIS_FAKE_CLAUDE_SCENARIO   text | tool | native-tool | server-tool |
 *                                  foreign-tools | foreign-server | no-init |
 *                                  untyped-init | own-agents | own-commands |
 *                                  no-init-lists | loaded-skills | user-plugin |
 *                                  builtin-plugin | bypass-mode | api-key-helper |
 *                                  hook-event | background-task | hook-request |
 *                                  permission-request | foreign-result |
 *                                  unknown-block | stream-native-tool |
 *                                  unknown-omnesis-tool | native-then-call |
 *                                  silent | auth-error | hang | exit
 *   OMNESIS_FAKE_CLAUDE_LIST_MODELS "fail" answers list_models with an error
 *   OMNESIS_FAKE_CLAUDE_TOOL       tool the `tool` scenario calls (default: the first)
 *   OMNESIS_FAKE_CLAUDE_MESSAGE_ID every assistant message carries this API message
 *                                  id, as when one request spans several messages
 *   OMNESIS_FAKE_CLAUDE_TOOL_ARGS  JSON arguments for the `tool` scenario
 *   OMNESIS_FAKE_CLAUDE_TOOL_PROGRESS "own" reports progress on the `tool`
 *                                  scenario's call, "heartbeat" sends the
 *                                  CLI's 30-second heartbeat for it (its id
 *                                  suffixed `-heartbeat-N`), "foreign" and
 *                                  "foreign-heartbeat" do the same for a
 *                                  call Omnesis did not make
 *   OMNESIS_FAKE_CLAUDE_API_ERROR  the `text` scenario ends with the CLI's synthetic
 *                                  assistant message carrying this API error
 *                                  (`rate_limit`, `max_output_tokens`, …) and an
 *                                  error result
 *   OMNESIS_FAKE_CLAUDE_EARLIER_API_ERROR the `text` scenario opens with such a
 *                                  message, as for an error the CLI recovered from
 *   OMNESIS_FAKE_CLAUDE_RESULT_SUBTYPE subtype of the `text` scenario's result; any
 *                                  other than `success` is an error result
 *   OMNESIS_FAKE_CLAUDE_RESULT_TEXT text of the `text` scenario's result (its
 *                                  `errors` for an error subtype) and of its
 *                                  API error message
 *   OMNESIS_FAKE_CLAUDE_RECORD     file that receives one JSON line per run:
 *                                  argv, the environment keys, and the frames
 *                                  Omnesis sent; `<file>.frames` gets each
 *                                  frame as it arrives
 */

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;

if (args.includes("--version")) {
  process.stdout.write(`${env.OMNESIS_FAKE_CLAUDE_VERSION ?? "2.1.296"} (Claude Code)\n`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = env.OMNESIS_FAKE_CLAUDE_LOGGED_IN !== "0";
  process.stdout.write(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      ...(loggedIn ? { subscriptionType: "max" } : {}),
    }) + "\n",
  );
  process.exit(loggedIn ? 0 : 1);
}

if (!args.includes("-p")) {
  process.stderr.write(`fake claude: unsupported invocation ${args.join(" ")}\n`);
  process.exit(2);
}

const scenario = env.OMNESIS_FAKE_CLAUDE_SCENARIO ?? "text";
const sessionId = randomUUID();
const received = [];
let sdkServers = [];
let interrupted = false;
const pending = new Map();
let nextMcpId = 0;

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const record = () => {
  if (!env.OMNESIS_FAKE_CLAUDE_RECORD) return;
  appendFileSync(
    env.OMNESIS_FAKE_CLAUDE_RECORD,
    JSON.stringify({ args, envKeys: Object.keys(env).sort(), env: pickEnv(), received }) + "\n",
  );
};
function pickEnv() {
  const out = {};
  for (const key of [
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
    "DISABLE_AUTOUPDATER",
    "CLAUDE_CONFIG_DIR",
  ]) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

/** Ask the host's in-process MCP server something and await its reply. */
function mcp(method, params) {
  const id = nextMcpId++;
  const requestId = randomUUID();
  send({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "mcp_message",
      server_name: "omnesis",
      message: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
    },
  });
  return new Promise((resolve) => pending.set(requestId, resolve));
}

const textDelta = (text) =>
  send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    session_id: sessionId,
  });

let assistantMessages = 0;
const assistant = (content, extra = {}) =>
  send({
    type: "assistant",
    message: {
      id: env.OMNESIS_FAKE_CLAUDE_MESSAGE_ID ?? `msg_fake_${++assistantMessages}`,
      model: "claude-fake",
      role: "assistant",
      content,
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    },
    session_id: sessionId,
    ...extra,
  });

const result = (fields) =>
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 200,
      output_tokens: 30,
    },
    ...fields,
  });

async function onInitialize(frame) {
  sdkServers = frame.request.sdkMcpServers ?? [];
  if (sdkServers.includes("omnesis")) {
    await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  }
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: frame.request_id,
      response:
        scenario === "no-init-lists"
          ? {}
          : {
              commands: scenario === "own-commands" ? [{ name: "deploy", description: "x" }] : [],
              agents: scenario === "own-agents" ? [{ name: "reviewer", description: "x" }] : [],
            },
    },
  });
}

async function runTurn() {
  let tools = [];
  if (sdkServers.includes("omnesis")) {
    const listed = await mcp("tools/list");
    tools = listed.result?.tools ?? [];
  }
  const toolNames = tools.map((tool) => `mcp__omnesis__${tool.name}`);
  const servers = sdkServers.map((name) => ({ name, status: "connected", source: "sdk" }));
  if (scenario === "no-init") {
    result({ result: "Done without a session report." });
    return;
  }
  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    ...(scenario === "untyped-init"
      ? {}
      : {
          tools: scenario === "foreign-tools" ? [...toolNames, "Bash"] : toolNames,
          mcp_servers:
            scenario === "foreign-server"
              ? [...servers, { name: "files", status: "connected", source: "user" }]
              : servers,
          permissionMode: scenario === "bypass-mode" ? "bypassPermissions" : "dontAsk",
          apiKeySource: scenario === "api-key-helper" ? "apiKeyHelper" : "none",
          slash_commands: [],
          agents: [],
          skills: scenario === "loaded-skills" ? ["review"] : [],
          plugins:
            scenario === "user-plugin"
              ? [{ name: "helper", path: "/plugins/helper", source: "helper@example" }]
              : scenario === "builtin-plugin"
                ? [
                    {
                      name: "cc-plugin-example",
                      path: "builtin",
                      source: "cc-plugin-example@builtin",
                    },
                  ]
                : [],
        }),
    model: "claude-fake",
  });
  if (
    [
      "foreign-tools",
      "foreign-server",
      "untyped-init",
      "loaded-skills",
      "user-plugin",
      "bypass-mode",
      "api-key-helper",
      "silent",
    ].includes(scenario)
  ) {
    return;
  }

  if (scenario === "hook-request" || scenario === "permission-request") {
    // Control requests that Omnesis never registered for.
    send({
      type: "control_request",
      request_id: "unexpected-1",
      request:
        scenario === "hook-request"
          ? { subtype: "hook_callback", callback_id: "unknown", input: {} }
          : { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
    });
    return;
  }

  if (scenario === "hook-event" || scenario === "background-task") {
    send({
      type: "system",
      subtype: scenario === "hook-event" ? "hook_started" : "task_started",
      session_id: sessionId,
    });
    return;
  }

  if (scenario === "foreign-result") {
    send({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_elsewhere", content: "listing" }],
      },
      session_id: sessionId,
    });
    return;
  }

  if (scenario === "unknown-block") {
    assistant([{ type: "container_upload", file_id: "file_1" }]);
    return;
  }

  if (scenario === "stream-native-tool") {
    send({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} },
      },
      session_id: sessionId,
    });
    return;
  }

  if (scenario === "unknown-omnesis-tool") {
    assistant([
      { type: "tool_use", id: "toolu_x", name: "mcp__omnesis__delete_everything", input: {} },
    ]);
    return;
  }

  if (scenario === "native-then-call" && tools.length > 0) {
    assistant([{ type: "tool_use", id: "toolu_native", name: "Bash", input: { command: "ls" } }]);
    await mcp("tools/call", { name: tools[0].name, arguments: { query: "x" } });
    return;
  }

  if (scenario === "server-tool") {
    send({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
      },
      session_id: sessionId,
    });
    return;
  }

  if (scenario === "exit") process.exit(3);

  if (scenario === "hang") {
    textDelta("Thinking about it");
    return; // wait for an interrupt
  }

  if (scenario === "auth-error") {
    assistant([{ type: "text", text: "Not logged in · Please run /login" }], {
      error: "authentication_failed",
    });
    result({ is_error: true, result: "Not logged in · Please run /login" });
    return;
  }

  if (scenario === "native-tool") {
    assistant([{ type: "tool_use", id: "toolu_native", name: "Bash", input: { command: "ls" } }]);
    return;
  }

  if (scenario === "tool" && tools.length > 0) {
    const first = tools.find((tool) => tool.name === env.OMNESIS_FAKE_CLAUDE_TOOL) ?? tools[0];
    const toolUseId = "toolu_fake_1";
    assistant([
      {
        type: "tool_use",
        id: toolUseId,
        name: `mcp__omnesis__${first.name}`,
        input: JSON.parse(env.OMNESIS_FAKE_CLAUDE_TOOL_ARGS ?? "{}"),
      },
    ]);
    if (env.OMNESIS_FAKE_CLAUDE_TOOL_PROGRESS) {
      const mode = env.OMNESIS_FAKE_CLAUDE_TOOL_PROGRESS;
      const own = mode === "own" || mode === "heartbeat";
      const heartbeat = mode.endsWith("heartbeat");
      const callId = own ? toolUseId : "toolu_elsewhere";
      send({
        type: "tool_progress",
        tool_use_id: heartbeat ? `${callId}-heartbeat-0` : callId,
        tool_name: own ? `mcp__omnesis__${first.name}` : "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: heartbeat ? 30 : 5,
        ...(heartbeat && { heartbeat: true }),
        session_id: sessionId,
      });
    }
    const called = await mcp("tools/call", {
      name: first.name,
      arguments: JSON.parse(env.OMNESIS_FAKE_CLAUDE_TOOL_ARGS ?? "{}"),
      _meta: { "claudecode/toolUseId": toolUseId },
    });
    const text = called.result?.content?.[0]?.text ?? "";
    const answer = `Tool said: ${text}${called.result?.isError ? " (error)" : ""}`;
    textDelta(answer);
    assistant([{ type: "text", text: answer }]);
    result({ result: answer });
    return;
  }

  const user = received.find((frame) => frame.type === "user");
  const content = user?.message?.content ?? [];
  const images = content.filter((block) => block.type === "image").length;
  const answer = `Echo: ${content.find((block) => block.type === "text")?.text ?? ""}${images ? ` [${images} image]` : ""}`;
  if (env.OMNESIS_FAKE_CLAUDE_EARLIER_API_ERROR) {
    apiErrorMessage(env.OMNESIS_FAKE_CLAUDE_EARLIER_API_ERROR);
  }
  textDelta("Working… ");
  textDelta(answer);
  assistant([{ type: "text", text: `Working… ${answer}` }]);
  if (env.OMNESIS_FAKE_CLAUDE_API_ERROR) apiErrorMessage(env.OMNESIS_FAKE_CLAUDE_API_ERROR);
  const subtype = env.OMNESIS_FAKE_CLAUDE_RESULT_SUBTYPE ?? "success";
  const text = env.OMNESIS_FAKE_CLAUDE_RESULT_TEXT ?? answer;
  result({
    subtype,
    ...(subtype === "success" ? { result: text } : { errors: [text] }),
    ...(env.OMNESIS_FAKE_CLAUDE_API_ERROR || subtype !== "success" ? { is_error: true } : {}),
  });
}

/** The message the CLI synthesizes for a failed API request, its `error` set. */
function apiErrorMessage(error) {
  send({
    type: "assistant",
    message: {
      id: `msg_fake_${++assistantMessages}`,
      model: "<synthetic>",
      role: "assistant",
      content: [
        { type: "text", text: env.OMNESIS_FAKE_CLAUDE_RESULT_TEXT ?? `API Error: ${error}` },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    session_id: sessionId,
    error,
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  received.push(frame);
  // Written as it arrives, so a run Omnesis kills still shows what it sent.
  if (env.OMNESIS_FAKE_CLAUDE_RECORD) {
    appendFileSync(`${env.OMNESIS_FAKE_CLAUDE_RECORD}.frames`, line + "\n");
  }
  if (frame.type === "control_response") {
    const resolve = pending.get(frame.response.request_id);
    pending.delete(frame.response.request_id);
    resolve?.(frame.response.response?.mcp_response ?? {});
    return;
  }
  if (frame.type === "control_request") {
    const subtype = frame.request.subtype;
    if (subtype === "initialize") void onInitialize(frame);
    else if (subtype === "list_models" && env.OMNESIS_FAKE_CLAUDE_LIST_MODELS === "fail") {
      send({
        type: "control_response",
        response: { subtype: "error", request_id: frame.request_id, error: "catalog unavailable" },
      });
    } else if (subtype === "list_models") {
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: {
            models: [
              { value: "default", displayName: "Default (recommended)", description: "Best" },
              {
                value: "sonnet",
                resolvedModel: "claude-sonnet-fake",
                displayName: "Sonnet",
                description: "Efficient",
                supportedEffortLevels: ["low", "medium", "high"],
              },
              { value: "haiku", displayName: "Haiku", description: "Fast" },
            ],
          },
        },
      });
    } else if (subtype === "interrupt") {
      interrupted = true;
      send({
        type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: {} },
      });
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId,
        errors: ["interrupted"],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return;
  }
  if (frame.type === "user") void runTurn();
});
rl.on("close", () => {
  record();
  process.exit(interrupted ? 1 : 0);
});
