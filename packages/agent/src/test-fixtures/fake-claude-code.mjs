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
 *                                  untyped-init | own-agents | silent |
 *                                  hook-request | auth-error | hang | exit
 *   OMNESIS_FAKE_CLAUDE_LIST_MODELS "fail" answers list_models with an error
 *   OMNESIS_FAKE_CLAUDE_TOOL       tool the `tool` scenario calls (default: the first)
 *   OMNESIS_FAKE_CLAUDE_TOOL_ARGS  JSON arguments for the `tool` scenario
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

const assistant = (content, extra = {}) =>
  send({
    type: "assistant",
    message: {
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
      response: {
        commands: [],
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
        }),
    model: "claude-fake",
  });
  if (["foreign-tools", "foreign-server", "untyped-init", "silent"].includes(scenario)) return;

  if (scenario === "hook-request") {
    // A request Omnesis never registered for; the answer is recorded.
    send({
      type: "control_request",
      request_id: "hook-1",
      request: { subtype: "hook_callback", callback_id: "unknown", input: {} },
    });
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
  textDelta("Working… ");
  textDelta(answer);
  assistant([{ type: "text", text: `Working… ${answer}` }]);
  result({ result: answer });
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
