// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { CliError, EXIT_CANCELLED, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import {
  runCodexUpdate,
  runCodexAgentSetup,
  waitForCodexLogin,
  type CodexLoginWaitDeps,
  type CodexUpdateFlowDeps,
} from "./codex.js";
import type { CodexBackendStatus, CodexLoginFlow, CodexRuntimeUpdateSnapshot } from "@omnesis/core";

const plan: CodexRuntimeUpdateSnapshot["plan"] = {
  state: "update-available",
  action: "update",
  currentVersion: "0.150.0",
  targetVersion: "0.151.0",
  canUpdate: true,
  preservesLogin: true,
  preservesAssignments: true,
  requiresGatewayRestart: false,
};

const snapshot = (
  state?: NonNullable<CodexRuntimeUpdateSnapshot["operation"]>["state"],
): CodexRuntimeUpdateSnapshot => ({
  plan,
  operation: state
    ? {
        id: "codex-update-fictional-1",
        state,
        fromVersion: "0.150.0",
        toVersion: "0.151.0",
        activeTurns: state === "waiting-for-turns" ? 1 : 0,
        startedAt: "2026-09-03T08:00:00.000Z",
        ...(state === "complete"
          ? { finishedAt: "2026-09-03T08:01:00.000Z", newModels: ["gpt-fictional-new"] }
          : {}),
      }
    : null,
});

function depsFor(responses: CodexRuntimeUpdateSnapshot[]): {
  deps: CodexUpdateFlowDeps;
  request: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  const confirm = vi.fn(async () => {});
  const wait = vi.fn(async () => {});
  const write = vi.fn();
  return {
    deps: {
      request: request as CodexUpdateFlowDeps["request"],
      confirm,
      wait,
      write,
    },
    request,
    confirm,
    wait,
    write,
  };
}

describe("codex update gateway flow", () => {
  test("--check is read-only and reports the gateway's plan", async () => {
    const fx = depsFor([snapshot()]);
    await runCodexUpdate({ check: true, dryRun: false, yes: false }, fx.deps);

    expect(fx.request).toHaveBeenCalledWith("/admin/inference/codex/runtime/update");
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.confirm).not.toHaveBeenCalled();
    expect(fx.write).toHaveBeenCalledWith(expect.objectContaining({ plan }), "check");
  });

  test("--dry-run asks the gateway to plan without starting an operation", async () => {
    const fx = depsFor([snapshot()]);
    await runCodexUpdate({ check: false, dryRun: true, yes: false }, fx.deps);

    expect(fx.request).toHaveBeenCalledWith("/admin/inference/codex/runtime/update", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    expect(fx.confirm).not.toHaveBeenCalled();
    expect(fx.wait).not.toHaveBeenCalled();
    expect(fx.write).toHaveBeenCalledWith(expect.anything(), "dry-run");
  });

  test("confirms, starts on the gateway, and polls until complete", async () => {
    const fx = depsFor([
      snapshot(),
      snapshot("checking"),
      snapshot("waiting-for-turns"),
      snapshot("complete"),
    ]);
    await runCodexUpdate({ check: false, dryRun: false, yes: false }, fx.deps);

    expect(fx.confirm).toHaveBeenCalledWith(
      "Update the gateway's Codex runtime 0.150.0 → 0.151.0?",
    );
    expect(fx.request).toHaveBeenNthCalledWith(2, "/admin/inference/codex/runtime/update", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(fx.request).toHaveBeenNthCalledWith(3, "/admin/inference/codex/runtime/update");
    expect(fx.request).toHaveBeenNthCalledWith(4, "/admin/inference/codex/runtime/update");
    expect(fx.wait).toHaveBeenCalledTimes(2);
    expect(fx.write).toHaveBeenCalledWith(
      expect.objectContaining({ operation: expect.objectContaining({ state: "complete" }) }),
      "result",
    );
  });

  test("--yes skips confirmation and terminal rollback exits as failure", async () => {
    const fx = depsFor([snapshot(), snapshot("rolled-back")]);
    await expect(
      runCodexUpdate({ check: false, dryRun: false, yes: true }, fx.deps),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE } satisfies Partial<CliError>);
    expect(fx.confirm).not.toHaveBeenCalled();
  });

  test("does not start when the gateway says the runtime is externally managed", async () => {
    const external: CodexRuntimeUpdateSnapshot = {
      plan: {
        state: "externally-managed",
        action: "external",
        currentVersion: "0.151.0",
        canUpdate: false,
        preservesLogin: true,
        preservesAssignments: true,
        requiresGatewayRestart: false,
        reason: "OMNESIS_CODEX_COMMAND controls this runtime.",
      },
      operation: null,
    };
    const fx = depsFor([external]);
    await runCodexUpdate({ check: false, dryRun: false, yes: false }, fx.deps);
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.confirm).not.toHaveBeenCalled();
    expect(fx.write).toHaveBeenCalledWith(external, "check");
  });

  test("rejects mutually exclusive read-only modes before contacting the gateway", async () => {
    const fx = depsFor([]);
    await expect(
      runCodexUpdate({ check: true, dryRun: true, yes: false }, fx.deps),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR } satisfies Partial<CliError>);
    expect(fx.request).not.toHaveBeenCalled();
  });
});

const loginFlow = (
  status: CodexLoginFlow["status"] = "pending",
  overrides: Partial<CodexLoginFlow> = {},
): CodexLoginFlow => ({
  id: "codex-login-fictional-1",
  status,
  expiresAt: "2026-09-16T18:15:00.000Z",
  ...overrides,
});

const readyStatus: CodexBackendStatus = {
  type: "codex",
  configured: true,
  status: "ok",
  loggedIn: true,
  models: ["gpt-5.6-luna"],
};

function loginDeps(responses: Array<unknown | Error>): {
  deps: CodexLoginWaitDeps;
  request: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("unexpected request");
    return next;
  });
  const wait = vi.fn(async () => {});
  return {
    deps: {
      request: request as CodexLoginWaitDeps["request"],
      wait,
      now: () => Date.parse("2026-09-16T18:00:00.000Z"),
    },
    request,
    wait,
  };
}

describe("codex login wait flow", () => {
  test("polls one flow id and refreshes the catalog after completion", async () => {
    const fx = loginDeps([{ flow: loginFlow() }, { flow: loginFlow("complete") }, readyStatus]);

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).resolves.toEqual(readyStatus);
    expect(fx.request).toHaveBeenLastCalledWith("/admin/inference/codex/refresh", {
      method: "POST",
    });
    expect(fx.wait).toHaveBeenCalledTimes(2);
  });

  test("retries a transient poll failure within the device-flow deadline", async () => {
    const fx = loginDeps([
      new Error("gateway restarting"),
      { flow: loginFlow("complete") },
      readyStatus,
    ]);

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).resolves.toEqual(readyStatus);
    expect(fx.wait).toHaveBeenCalledTimes(2);
  });

  test("fails after a bounded run of transport errors instead of hanging until expiry", async () => {
    const fx = loginDeps(Array.from({ length: 5 }, () => new Error("gateway unavailable")));

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
    } satisfies Partial<CliError>);
    expect(fx.wait).toHaveBeenCalledTimes(5);
  });

  test("does not retry an authoritative gateway error", async () => {
    const fx = loginDeps([new CliError("Gateway 401", EXIT_USER_ERROR)]);

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).rejects.toMatchObject({
      message: "Gateway 401",
    });
    expect(fx.wait).toHaveBeenCalledTimes(1);
  });

  test("accepts a completed login whose in-memory flow was lost after credentials landed", async () => {
    const fx = loginDeps([{ flow: null }, readyStatus]);

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).resolves.toEqual(readyStatus);
  });

  test("refuses to follow a replacement login flow", async () => {
    const fx = loginDeps([{ flow: loginFlow("pending", { id: "codex-login-fictional-2" }) }]);

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
    } satisfies Partial<CliError>);
  });

  test("maps failed and canceled terminal states to nonzero exits", async () => {
    await expect(
      waitForCodexLogin(
        loginFlow("failed", { reason: "Device code expired." }),
        loginDeps([]).deps,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE } satisfies Partial<CliError>);
    await expect(
      waitForCodexLogin(loginFlow("canceled"), loginDeps([]).deps),
    ).rejects.toMatchObject({ exitCode: EXIT_CANCELLED } satisfies Partial<CliError>);
  });

  test("does not report success until refresh proves login and a nonempty catalog", async () => {
    const unusable = { ...readyStatus, status: "unreachable" as const, models: [] };
    const fx = loginDeps([unusable]);

    await expect(waitForCodexLogin(loginFlow("complete"), fx.deps)).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
    } satisfies Partial<CliError>);
  });

  test("stops at the server-provided expiry instead of polling forever", async () => {
    const fx = loginDeps([]);
    fx.deps.now = () => Date.parse("2026-09-16T18:16:00.000Z");

    await expect(waitForCodexLogin(loginFlow(), fx.deps)).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
    } satisfies Partial<CliError>);
    expect(fx.request).not.toHaveBeenCalled();
  });
});

test("Codex agent setup posts the selected live model to the atomic endpoint", async () => {
  const request = vi.fn(async () => ({ assignment: "codex/gpt-example-live" }));

  await expect(
    runCodexAgentSetup("gpt-example-live", request as CodexLoginWaitDeps["request"]),
  ).resolves.toEqual({ assignment: "codex/gpt-example-live" });
  expect(request).toHaveBeenCalledWith("/admin/inference/codex/agent", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-example-live" }),
  });
});
