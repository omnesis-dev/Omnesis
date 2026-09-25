// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { defineCommand } from "citty";
import { assertNever, resolveToken } from "@omnesis/core";
import {
  AnswerHttpClient,
  AnswerHttpError,
  InvalidAnswerResponseError,
} from "@omnesis/gateway-client";
import {
  c,
  CliError,
  EXIT_AUTH,
  EXIT_GATEWAY_ERROR,
  EXIT_USER_ERROR,
  isJSON,
  pickGatewayExitCode,
  withSpinner,
  GATEWAY_REQUEST_URL,
} from "../utils.js";
import {
  ANSWER_WAIT_POLL_INTERVAL_MS,
  DEFAULT_ANSWER_WAIT_TIMEOUT_S,
  MAX_ANSWER_WAIT_TIMEOUT_S,
} from "../answer-wait.js";
import type { AnswerResponse } from "@omnesis/types/privacy";

export const DEFAULT_WAIT_TIMEOUT_S = DEFAULT_ANSWER_WAIT_TIMEOUT_S;
export const WAIT_POLL_INTERVAL_MS = ANSWER_WAIT_POLL_INTERVAL_MS;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Environment marker `omnesis connect` writes into a harness state directory,
 * which the harness loads into the process every agent shell inherits.
 *
 * An agent asks through its native `omnesis_answer` tool, which waits for the
 * answer properly and hands it back into the turn. Asking through a shell
 * instead puts a minutes-long call inside a tool call the harness may not keep
 * open, so the question is refused here rather than failing obscurely later.
 * This is a guard against habit, not against a determined caller: an agent
 * shell runs as the same user as the plugin and can reach whatever it can.
 */
export function assertNotInsideAgentHarness(
  env: NodeJS.ProcessEnv = process.env,
  harness = env.OMNESIS_AGENT_HARNESS?.trim(),
): void {
  if (!harness || harness === "0") return;
  throw new CliError(
    `Omnesis Answer is not available from a shell inside ${harness}. ` +
      "Call the native `omnesis_answer` tool instead — it works in conversations, " +
      "crons and other background runs, waits for the answer, and returns it to you.",
    EXIT_USER_ERROR,
  );
}

export function parseWaitTimeout(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WAIT_TIMEOUT_S;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CliError(
      `--wait-timeout must be greater than 0 and at most ${MAX_ANSWER_WAIT_TIMEOUT_S} seconds.`,
      EXIT_USER_ERROR,
    );
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ANSWER_WAIT_TIMEOUT_S) {
    throw new CliError(
      `--wait-timeout must be greater than 0 and at most ${MAX_ANSWER_WAIT_TIMEOUT_S} seconds.`,
      EXIT_USER_ERROR,
    );
  }
  return seconds;
}

export function formatAnswer(result: AnswerResponse, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const context = `${c.dim}Workflow: ${result.workflowId}\nConversation: ${result.conversationId}\nTask: ${result.taskId}${c.reset}`;
  switch (result.status) {
    case "released":
      return `${result.answer}\n\n${context}`;
    case "released_with_reductions":
      return `${result.answer}\n\n${c.dim}Privacy: released with reductions (${result.reductions.join(", ")})${c.reset}\n${context}`;
    case "approval_required":
      return `Approval required in Omnesis. Wait with omnesis answer --task ${result.taskId} --wait.\n\n${context}\n${c.dim}Approval: ${result.approvalId}${c.reset}`;
    case "denied":
      return `Omnesis did not release an answer (${result.reason}).\n\n${context}`;
    default:
      return assertNever(result);
  }
}

function createAnswerClient(): AnswerHttpClient {
  const token = resolveToken();
  if (!token) throw new CliError("No Omnesis token configured.", EXIT_AUTH);
  return new AnswerHttpClient({ baseUrl: GATEWAY_REQUEST_URL, token });
}

function mapAnswerClientError(error: unknown): CliError {
  if (error instanceof InvalidAnswerResponseError) {
    return new CliError(error.message, EXIT_GATEWAY_ERROR);
  }
  if (!(error instanceof AnswerHttpError)) {
    if (error instanceof CliError) return error;
    throw error;
  }
  return new CliError(error.message, pickGatewayExitCode(error.status));
}

export const answerCommand = defineCommand({
  meta: {
    name: "answer",
    description: "Ask the read-only Omnesis agent",
  },
  args: {
    question: {
      type: "positional",
      description: "question for the Omnesis agent",
      required: false,
    },
    conversation: {
      type: "string",
      description: "Continue one follow-up thread inside a workflow",
    },
    workflow: { type: "string", description: "Continue a stable external-agent workflow" },
    "workflow-name": { type: "string", description: "Name for a new workflow" },
    purpose: { type: "string", description: "Purpose supplied to the privacy reviewer" },
    "request-id": { type: "string", description: "Idempotency key for a retryable turn" },
    "no-approval": {
      type: "boolean",
      description: "Explicitly use the default non-interactive privacy mode",
    },
    "allow-approval": {
      type: "boolean",
      description: "Allow an approval request for this non-interactive call",
    },
    task: { type: "string", description: "Poll a previously returned answer task" },
    wait: {
      type: "boolean",
      description: "With --task: wait for the approval to resolve, up to a bounded timeout",
    },
    "wait-timeout": {
      type: "string",
      description: `Seconds to wait with --wait (default: ${DEFAULT_WAIT_TIMEOUT_S})`,
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run({ args }) {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    const taskId = typeof args.task === "string" ? args.task.trim() : undefined;
    // Only asking is redirected. Reading an existing task back is a plain
    // lookup with none of the properties that make asking from a shell wrong.
    if (question) assertNotInsideAgentHarness();
    const wait = args.wait === true;
    const noApproval = args["no-approval"] === true || args.approval === false;
    const allowApproval = args["allow-approval"] === true;
    const hasWaitTimeout = args["wait-timeout"] !== undefined;
    if (taskId === "") throw new CliError("--task must not be blank.", EXIT_USER_ERROR);
    if (wait && !taskId) throw new CliError("--wait requires --task.", EXIT_USER_ERROR);
    if (hasWaitTimeout && !wait) {
      throw new CliError("--wait-timeout requires --wait.", EXIT_USER_ERROR);
    }
    if (taskId && question) {
      throw new CliError("Pass either a question or --task, not both.", EXIT_USER_ERROR);
    }
    if (taskId && noApproval)
      throw new CliError("--no-approval requires a question.", EXIT_USER_ERROR);
    if (taskId && allowApproval)
      throw new CliError("--allow-approval requires a question.", EXIT_USER_ERROR);
    if (noApproval && allowApproval) {
      throw new CliError(
        "Pass at most one of --no-approval and --allow-approval.",
        EXIT_USER_ERROR,
      );
    }
    if (!taskId && !question) {
      throw new CliError("Provide a question or --task.", EXIT_USER_ERROR);
    }

    if (taskId) {
      const client = createAnswerClient();
      const timeoutS = wait ? parseWaitTimeout(args["wait-timeout"]) : 0;
      const deadline = Date.now() + timeoutS * 1_000;
      const fetchTask = async (budgetMs?: number): Promise<AnswerResponse | null> => {
        const signal =
          budgetMs === undefined
            ? undefined
            : AbortSignal.timeout(Math.max(1, Math.ceil(budgetMs)));
        try {
          return await client.getTask(taskId, signal ? { signal } : {});
        } catch (err) {
          if (signal?.aborted) return null;
          throw mapAnswerClientError(err);
        }
      };

      const initialBudgetMs = wait ? Math.max(1, deadline - Date.now()) : undefined;
      const initialResult = await withSpinner("Checking Omnesis", () => fetchTask(initialBudgetMs));
      if (initialResult === null) {
        throw new CliError("Timed out checking the Omnesis answer task.", EXIT_GATEWAY_ERROR);
      }
      let result = initialResult;
      while (wait && result.status === "approval_required") {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remainingMs));
        const pollBudgetMs = deadline - Date.now();
        if (pollBudgetMs <= 0) break;
        const next = await fetchTask(pollBudgetMs);
        if (next === null) break;
        result = next;
      }
      console.log(formatAnswer(result, isJSON || args.json === true));
      return;
    }

    const conversationId =
      typeof args.conversation === "string" ? args.conversation.trim() : undefined;
    if (conversationId === "") {
      throw new CliError("--conversation must not be blank.", EXIT_USER_ERROR);
    }
    const workflowId = typeof args.workflow === "string" ? args.workflow.trim() : undefined;
    const workflowName =
      typeof args["workflow-name"] === "string" ? args["workflow-name"].trim() : undefined;
    const workflowPurpose = typeof args.purpose === "string" ? args.purpose.trim() : undefined;
    const clientRequestId =
      typeof args["request-id"] === "string" ? args["request-id"].trim() : `cli_${randomUUID()}`;
    for (const [flag, value] of [
      ["--workflow", workflowId],
      ["--workflow-name", workflowName],
      ["--purpose", workflowPurpose],
      ["--request-id", clientRequestId],
    ] as const) {
      if (value === "") throw new CliError(`${flag} must not be blank.`, EXIT_USER_ERROR);
    }

    const client = createAnswerClient();
    let result: AnswerResponse;
    try {
      result = await withSpinner("Asking Omnesis", () =>
        client.submit({
          question,
          clientRequestId,
          ...(workflowId ? { workflowId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(workflowName ? { workflowName } : {}),
          ...(workflowPurpose ? { workflowPurpose } : {}),
          ...(noApproval ? { approval: "never" as const } : {}),
          ...(allowApproval ? { approval: "allow" as const } : {}),
        }),
      );
    } catch (error) {
      throw mapAnswerClientError(error);
    }
    console.log(formatAnswer(result, isJSON || args.json === true));
  },
});
