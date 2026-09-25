#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const version = process.env.OMNESIS_FAKE_CODEX_VERSION ?? "0.142.4";
const cliArgs = process.argv.slice(2);

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

if (cliArgs[0] === "login" && cliArgs[1] === "status") {
  if (process.env.OMNESIS_FAKE_CODEX_LOGIN_STATUS === "fail") {
    process.stderr.write("not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in with a synthetic ChatGPT account\n");
  process.exit(0);
}

if (cliArgs[0] === "login" && cliArgs.includes("--device-auth")) {
  if (process.env.OMNESIS_FAKE_CODEX_IGNORE_TERM === "1") {
    process.on("SIGTERM", () => {});
  }
  const loginMinutes = process.env.OMNESIS_FAKE_CODEX_LOGIN_MINUTES ?? "15";
  process.stdout.write(
    `Open https://auth.openai.com/codex/device and enter ABCD-12345. This code expires in ${loginMinutes} minutes.\n`,
  );
  if (process.env.OMNESIS_FAKE_CODEX_LOGIN_AUTO_COMPLETE === "1") {
    setTimeout(() => {
      const codexHome = process.env.CODEX_HOME;
      if (!codexHome) process.exit(1);
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
      process.exit(0);
    }, 25);
  }
  setInterval(() => {}, 1_000);
}

if (cliArgs[0] === "logout") {
  process.stdout.write("Logged out\n");
  process.exit(0);
}

if (cliArgs[0] === "debug" && cliArgs[1] === "models") {
  process.stdout.write(
    JSON.stringify({
      models: [
        {
          slug: "gpt-example-frontier",
          display_name: "fixture-coding-model",
          description: "Frontier coding model.",
          visibility: "list",
          priority: 0,
        },
      ],
    }),
  );
  process.exit(0);
}

const logPath = process.env.OMNESIS_FAKE_CODEX_LOG;
const scenario = process.env.OMNESIS_FAKE_CODEX_SCENARIO ?? "tool";
const requestedTool = process.env.OMNESIS_FAKE_CODEX_TOOL ?? "search_documents";
const requestedQuery = process.env.OMNESIS_FAKE_CODEX_QUERY ?? "synthetic budget review";
const threadId = "thread_fake_1";
const turnId = "turn_fake_1";

let nextServerId = 1;
let turnStarted = false;
let dynamicTools = [];
const pendingServerRequests = new Map();

log("startup", {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME ?? null,
  hasOpenAiApiKey: process.env.OPENAI_API_KEY !== undefined,
  hasCodexApiKey: process.env.CODEX_API_KEY !== undefined,
  hasAnthropicApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
  hasOmnesisPrivateToken: process.env.OMNESIS_PRIVATE_TOKEN !== undefined,
});

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("invalid_json", { line });
    return;
  }

  log("client_message", msg);

  if (msg.id !== undefined && !msg.method) {
    const handler = pendingServerRequests.get(msg.id);
    if (handler) {
      pendingServerRequests.delete(msg.id);
      handler(msg);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "fake-codex", version } } });
    return;
  }

  if (msg.method === "initialized") return;

  if (msg.method === "model/list") {
    send({
      id: msg.id,
      result: {
        data: [
          {
            id: "model_synthetic_frontier",
            model: "gpt-example-frontier",
            displayName: "fixture-coding-model",
            description: "Frontier coding model.",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            id: "model_synthetic_hidden",
            model: "gpt-example-hidden",
            displayName: "fixture-hidden-model",
            hidden: true,
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (msg.method === "thread/start") {
    dynamicTools = Array.isArray(msg.params?.dynamicTools) ? msg.params.dynamicTools : [];
    log("thread_start", {
      params: msg.params,
      dynamicToolNames: dynamicTools.map((tool) => tool.name),
    });
    send({ id: msg.id, result: { thread: { id: threadId } } });
    return;
  }

  if (msg.method === "turn/start") {
    log("turn_start", { params: msg.params });
    if (scenario === "pending-turn-start") return;
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    if (!turnStarted) {
      turnStarted = true;
      if (scenario === "early-events") runScenario();
      else setTimeout(runScenario, 0);
    }
    return;
  }

  if (msg.method === "turn/interrupt") {
    log("turn_interrupt", msg.params);
    notify("turn/completed", { turn: { id: turnId, status: "interrupted" } });
    send({ id: msg.id, result: {} });
    return;
  }

  send({ id: msg.id, error: { code: -32601, message: `unsupported fake method ${msg.method}` } });
});

function runScenario() {
  if (
    scenario === "completion-phases" ||
    scenario === "completion-unphased" ||
    scenario === "completion-no-final"
  ) {
    const phased = scenario !== "completion-unphased";
    const emitMessage = (id, phase, text) => {
      const item = { id, type: "agentMessage", ...(phased ? { phase } : {}), text };
      notify("item/started", { threadId, turnId, item });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: text });
      notify("item/completed", { threadId, turnId, item });
    };
    emitMessage("progress", "commentary", "I will compare ENTAILMENT and CONTRADICTION.");
    if (scenario !== "completion-no-final") emitMessage("answer", "final_answer", "NEUTRAL");
    notifyUsage();
    complete("completed");
    return;
  }

  if (scenario === "no-tool") {
    notify("item/agentMessage/delta", { threadId, turnId, delta: "Synthetic Codex response." });
    notifyUsage();
    complete("completed");
    return;
  }

  if (scenario === "native-approval") {
    serverRequest(
      "item/commandExecution/requestApproval",
      {
        threadId,
        turnId,
        item: {
          id: "cmd_fake_1",
          type: "commandExecution",
          command: "echo disabled",
        },
      },
      (response) => {
        log("native_approval_response", response);
        notify("item/agentMessage/delta", {
          threadId,
          turnId,
          delta: "Native approval declined by policy.",
        });
        notifyUsage();
        complete("completed");
      },
    );
    return;
  }

  if (scenario === "native-file-approval") {
    serverRequest(
      "item/fileChange/requestApproval",
      {
        threadId,
        turnId,
        item: {
          id: "file_fake_1",
          type: "fileChange",
          path: "/tmp/disabled.txt",
        },
      },
      (response) => finishAfterPolicyResponse("native_file_approval_response", response),
    );
    return;
  }

  if (scenario === "permissions") {
    serverRequest(
      "item/permissions/requestApproval",
      { threadId, turnId, permissions: { network: true } },
      (response) => finishAfterPolicyResponse("permissions_response", response),
    );
    return;
  }

  if (scenario === "user-input") {
    serverRequest(
      "item/tool/requestUserInput",
      { threadId, turnId, questions: [{ id: "synthetic", question: "Synthetic prompt?" }] },
      (response) => finishAfterPolicyResponse("user_input_response", response),
    );
    return;
  }

  if (scenario === "mcp-elicitation") {
    serverRequest(
      "mcpServer/elicitation/request",
      { threadId, turnId, message: "Synthetic elicitation" },
      (response) => finishAfterPolicyResponse("mcp_elicitation_response", response),
    );
    return;
  }

  if (scenario === "native-output") {
    notify("item/started", {
      threadId,
      turnId,
      item: {
        id: "cmd_fake_1",
        type: "commandExecution",
        command: "echo disabled",
        cwd: process.cwd(),
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    return;
  }

  if (scenario === "stale-native-output") {
    notify("item/started", {
      threadId,
      turnId: "turn_stale",
      item: {
        id: "cmd_stale_1",
        type: "commandExecution",
        command: "echo stale",
      },
    });
    notify("item/agentMessage/delta", { threadId, turnId, delta: "Fresh turn survived." });
    notifyUsage();
    complete("completed");
    return;
  }

  if (scenario === "hang") {
    return;
  }

  if (scenario === "quota") {
    notify("error", {
      threadId,
      turnId,
      error: {
        message: "usage limit reached in fake Codex runtime",
        codexErrorInfo: null,
        additionalDetails: null,
      },
      willRetry: false,
    });
    complete("failed", "usage limit reached in fake Codex runtime");
    return;
  }

  if (scenario === "context") {
    notify("error", {
      threadId,
      turnId,
      error: {
        message: "model context window exceeded in fake Codex runtime",
        codexErrorInfo: null,
        additionalDetails: null,
      },
      willRetry: false,
    });
    complete("failed", "model context window exceeded in fake Codex runtime");
    return;
  }

  if (scenario === "auth") {
    notify("error", {
      threadId,
      turnId,
      error: {
        message: "unauthorized fake Codex runtime",
        codexErrorInfo: null,
        additionalDetails: null,
      },
      willRetry: false,
    });
    complete("failed", "unauthorized fake Codex runtime");
    return;
  }

  serverRequest(
    "item/tool/call",
    {
      threadId,
      turnId,
      callId: "call_fake_1",
      namespace: "dynamic",
      tool: requestedTool,
      arguments: scenario === "invalid-tool-args" ? { query: 42, limit: "three" } : toolArguments(),
    },
    (response) => {
      log("tool_call_response", response);
      notify("item/agentMessage/delta", {
        threadId,
        turnId,
        delta: "Synthetic tool response received.",
      });
      notifyUsage();
      complete("completed");
    },
  );
}

function toolArguments() {
  const search = {
    query: requestedQuery,
    limit: 3,
  };
  return requestedTool === "search_many" ? { queries: [search] } : search;
}

function finishAfterPolicyResponse(event, response) {
  log(event, response);
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    delta: "Native request declined by policy.",
  });
  notifyUsage();
  complete("completed");
}

function serverRequest(method, params, onResponse) {
  const id = `srv_${nextServerId++}`;
  pendingServerRequests.set(id, onResponse);
  send({ id, method, params });
}

function notify(method, params) {
  send({ method, params });
}

function notifyUsage() {
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      last: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 2 },
    },
  });
}

function complete(status, message) {
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status,
      error: message ? { message } : null,
    },
  });
}

function send(message) {
  log("server_message", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(event, payload) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ event, payload })}\n`);
}
