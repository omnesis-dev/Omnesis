// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { CliError, EXIT_USER_ERROR } from "../utils.js";
import {
  CLAUDE_CODE_INSTALL_URL,
  claudeCodeCommand,
  claudeCodeNextStep,
  runClaudeCodeAgentSetup,
} from "./claude-code.js";
import type { ClaudeCodeBackendStatus } from "@omnesis/core";

type Request = Parameters<typeof runClaudeCodeAgentSetup>[1];

const readyStatus: ClaudeCodeBackendStatus = {
  type: "claude-code",
  installed: true,
  status: "ok",
  loggedIn: true,
  account: { authMethod: "claude.ai", subscriptionType: "max" },
  runtime: { command: "claude", version: "2.1.300", supported: true },
  models: ["sonnet", "opus", "haiku"],
};

describe("claude-code next step", () => {
  test("a missing CLI points at the install page, never at a login", () => {
    const hint = claudeCodeNextStep({
      ...readyStatus,
      installed: false,
      loggedIn: false,
      status: "unreachable",
      models: [],
    });
    expect(hint).toMatch(/^Install /u);
    expect(hint).toContain(CLAUDE_CODE_INSTALL_URL);
    expect(hint).not.toContain("auth login");
  });

  test("an unsupported CLI asks for an update before a sign-in", () => {
    const hint = claudeCodeNextStep({
      ...readyStatus,
      loggedIn: false,
      status: "unreachable",
      runtime: { command: "claude", version: "0.1.0", supported: false },
    });
    expect(hint).toMatch(/^Update /u);
    expect(hint).toMatch(/gateway host: claude update$/u);
  });

  test("a signed-out CLI names the operator's own login command", () => {
    const hint = claudeCodeNextStep({ ...readyStatus, loggedIn: false, status: "unreachable" });
    expect(hint).toBe("On the gateway host, run: claude auth login");
  });

  test("a ready backend needs nothing", () => {
    expect(claudeCodeNextStep(readyStatus)).toBeUndefined();
  });

  test("a signed-in CLI with no catalog asks for a refresh", () => {
    const hint = claudeCodeNextStep({
      ...readyStatus,
      status: "unreachable",
      models: [],
      reason: "The model catalog could not be read.",
    });
    expect(hint).toContain("omnesis claude-code refresh");
  });
});

test("agent setup posts the selected model to the atomic endpoint", async () => {
  const request = vi.fn(() => Promise.resolve({ assignment: "claude-code/sonnet" }));

  await expect(runClaudeCodeAgentSetup("sonnet", request as Request)).resolves.toEqual({
    assignment: "claude-code/sonnet",
  });
  expect(request).toHaveBeenCalledWith("/admin/inference/claude-code/agent", {
    method: "POST",
    body: JSON.stringify({ model: "sonnet" }),
  });
});

test("agent setup surfaces the gateway's refusal unchanged", async () => {
  const refusal = new CliError(
    "Gateway 409 /admin/inference/claude-code/agent: agent assigned",
    EXIT_USER_ERROR,
  );
  const request = vi.fn(() => Promise.reject(refusal));

  await expect(runClaudeCodeAgentSetup("sonnet", request as Request)).rejects.toBe(refusal);
});

test("the command group offers no login or runtime update", () => {
  // Omnesis never installs the `claude` CLI or signs it in; the operator does
  // both on the gateway host.
  expect(Object.keys(claudeCodeCommand.subCommands ?? {})).toEqual([
    "status",
    "refresh",
    "setup-agent",
  ]);
});
