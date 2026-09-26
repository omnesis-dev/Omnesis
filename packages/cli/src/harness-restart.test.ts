// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  harnessRestartQuestion,
  readHarnessSkillState,
  reloadConnectedHarness,
  restartHarness,
  spawnHarnessCommand,
  type HarnessCommandResult,
  type HarnessRestartDeps,
} from "./harness-restart.js";
import type { CommandSpec } from "./update/detect.js";

interface Call {
  spec: CommandSpec;
  mode: "inherit" | "capture";
}

/** Deps whose restart and skill report answer as told, recording every command. */
function fakeDeps(
  over: {
    approve?: boolean;
    restart?: HarnessCommandResult;
    report?: HarnessCommandResult;
  } = {},
): HarnessRestartDeps & { calls: Call[]; asked: string[] } {
  const calls: Call[] = [];
  const asked: string[] = [];
  return {
    calls,
    asked,
    approve: async (message) => {
      asked.push(message);
      return over.approve ?? true;
    },
    run: async (spec, mode) => {
      calls.push({ spec, mode });
      if (mode === "inherit") return over.restart ?? { code: 0, stdout: "" };
      return over.report ?? { code: 0, stdout: '{"eligible":["omnesis"]}' };
    },
  } satisfies HarnessRestartDeps & { calls: Call[]; asked: string[] };
}

const line = (call: Call | undefined) => call && [call.spec.command, ...call.spec.args].join(" ");

let logged: string[];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());
const output = () => logged.join("\n");

describe("restartHarness", () => {
  test("asks first, then runs the harness's own restart through its resolved executable", async () => {
    const deps = fakeDeps();
    const outcome = await restartHarness(
      "openclaw",
      {
        binary: "/opt/example/bin/openclaw",
        env: { OPENCLAW_STATE_DIR: "/home/example/.openclaw" },
      },
      deps,
    );
    expect(deps.asked).toEqual([harnessRestartQuestion("openclaw")]);
    expect(harnessRestartQuestion("openclaw")).toContain(
      "This interrupts any run it is in the middle of.",
    );
    expect(outcome).toEqual({
      kind: "restarted",
      command: "/opt/example/bin/openclaw gateway restart",
    });
    const [restart] = deps.calls;
    expect(restart?.mode).toBe("inherit");
    expect(restart?.spec.env?.OPENCLAW_STATE_DIR).toBe("/home/example/.openclaw");
    // The executable's own directory leads PATH, so a service-manager PATH still finds node.
    expect(restart?.spec.env?.PATH?.split(":")[0]).toBe("/opt/example/bin");
  });

  test("a declined restart runs nothing and names the command", async () => {
    const deps = fakeDeps({ approve: false });
    const outcome = await restartHarness("hermes", { binary: null }, deps);
    expect(outcome.kind).toBe("declined");
    expect(deps.calls).toEqual([]);
    expect(output()).toContain(
      "Restart hermes to load the refreshed plugin (it reads its config and plugins at startup): hermes gateway restart",
    );
  });

  test("a missing executable is said, with the command to run once it is on PATH", async () => {
    const deps = fakeDeps({ restart: { code: 127, stdout: "" } });
    const outcome = await restartHarness("openclaw", { binary: null }, deps);
    expect(outcome).toEqual({ kind: "failed", command: "openclaw gateway restart", code: 127 });
    expect(line(deps.calls[0])).toBe("openclaw gateway restart");
    expect(output()).toContain("Could not restart openclaw. No `openclaw` executable was found");
    expect(output()).toContain("openclaw gateway restart");
  });

  test("a restart the harness refuses is reported as owed, not as an error", async () => {
    const deps = fakeDeps({ restart: { code: 2, stdout: "" } });
    const outcome = await restartHarness("hermes", { binary: "/opt/example/bin/hermes" }, deps);
    expect(outcome).toMatchObject({ kind: "failed", code: 2 });
    expect(output()).toContain("Could not restart hermes.");
    expect(output()).not.toContain("No `hermes` executable");
  });
});

describe("readHarnessSkillState", () => {
  const openclawCheck = { command: "openclaw", args: ["skills", "check", "--json"] };
  const hermesList = { command: "hermes", args: ["skills", "list", "--source", "local"] };
  const openclaw = (stdout: string) =>
    readHarnessSkillState("openclaw", openclawCheck, { code: 0, stdout });
  const hermes = (stdout: string) =>
    readHarnessSkillState("hermes", hermesList, { code: 0, stdout });

  test("OpenClaw: eligible is ready, tolerating output around the JSON", () => {
    expect(openclaw('warning: something\n{"eligible":["other","omnesis"]}\n')).toEqual({
      kind: "ready",
    });
  });

  test.each([
    ['{"eligible":[],"disabled":["omnesis"]}', "it is disabled in OpenClaw's config"],
    ['{"eligible":[],"blocked":["omnesis"]}', "OpenClaw's skill allowlist blocks it"],
    [
      '{"eligible":["omnesis"],"agentFiltered":["omnesis"]}',
      "the agent's skill allowlist excludes it",
    ],
    [
      '{"eligible":["omnesis"],"notInjected":[{"name":"omnesis","reason":"disable-model-invocation"}]}',
      "it is hidden from the model's prompt",
    ],
    [
      '{"eligible":[],"missingRequirements":[{"name":"omnesis","missing":{"bins":["omnesis"],"env":[]}}]}',
      "it is missing bins omnesis",
    ],
    ['{"eligible":["other"]}', "OpenClaw does not list it"],
  ])("OpenClaw: %s is not ready because %s", (stdout, reason) => {
    expect(openclaw(stdout)).toEqual({
      kind: "not-ready",
      reason,
      next: "openclaw skills info omnesis",
    });
  });

  test("OpenClaw: a report that is not JSON is unchecked, not a verdict", () => {
    expect(openclaw("skills status check\n")).toMatchObject({ kind: "unchecked" });
  });

  test("Hermes: an enabled row is ready; a disabled or absent one is not", () => {
    const table = (status: string) =>
      [
        "            installed skills            ",
        "┏━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━┓",
        "┃ Name    ┃ Category     ┃ Status┃",
        "┡━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━┩",
        `│ omnesis │ productivity │ ${status} │`,
        "└─────────┴──────────────┴───────┘",
      ].join("\n");
    expect(hermes(table("enabled"))).toEqual({ kind: "ready" });
    expect(hermes(table("disabled"))).toEqual({
      kind: "not-ready",
      reason: "it is disabled in Hermes's config",
      next: "hermes skills list",
    });
    expect(hermes("│ omnesis-extra │ productivity │ enabled │")).toMatchObject({
      kind: "not-ready",
      reason: "Hermes does not list it",
    });
  });

  test("a report command that fails is unchecked and names what to run", () => {
    expect(readHarnessSkillState("hermes", hermesList, { code: 2, stdout: "" })).toEqual({
      kind: "unchecked",
      reason: "`hermes skills list --source local` exited 2",
      next: "hermes skills list",
    });
  });
});

describe("reloadConnectedHarness", () => {
  test("restarts a changed plugin, then reports the skill ready and the new session", async () => {
    const deps = fakeDeps();
    const result = await reloadConnectedHarness(
      "openclaw",
      { pluginChanged: true },
      { binary: null },
      deps,
    );
    expect(result.restart?.kind).toBe("restarted");
    expect(result.skill).toEqual({ kind: "ready" });
    expect(deps.calls.map(line)).toEqual([
      "openclaw gateway restart",
      "openclaw skills check --json",
    ]);
    expect(output()).toContain("Restarted OpenClaw with the new plugin.");
    expect(output()).toContain("OpenClaw reports the omnesis skill ready.");
    expect(output()).toContain("new session");
  });

  test("an unchanged plugin is not restarted and not asked about", async () => {
    const deps = fakeDeps();
    const result = await reloadConnectedHarness(
      "hermes",
      { pluginChanged: false },
      { binary: null },
      deps,
    );
    expect(result.restart).toBeNull();
    expect(deps.asked).toEqual([]);
    expect(deps.calls.map(line)).toEqual(["hermes skills list --source local"]);
  });

  test("a skill that is not ready names the reason and the next command", async () => {
    const deps = fakeDeps({ report: { code: 0, stdout: '{"eligible":[],"blocked":["omnesis"]}' } });
    const result = await reloadConnectedHarness(
      "openclaw",
      { pluginChanged: true },
      { binary: null },
      deps,
    );
    expect(result.skill.kind).toBe("not-ready");
    expect(output()).toContain("OpenClaw does not report the omnesis skill ready");
    expect(output()).toContain("openclaw skills info omnesis");
    expect(output()).not.toContain("new session");
  });

  test("a harness that cannot answer is said to be unchecked, not unready", async () => {
    const deps = fakeDeps({ approve: false, report: { code: 127, stdout: "" } });
    const result = await reloadConnectedHarness(
      "hermes",
      { pluginChanged: true },
      { binary: null },
      deps,
    );
    expect(result.restart?.kind).toBe("declined");
    expect(result.skill.kind).toBe("unchecked");
    expect(output()).toContain("Could not ask Hermes whether the omnesis skill is ready");
  });
});

describe("spawnHarnessCommand", () => {
  test("captures stdout and the exit code", async () => {
    await expect(
      spawnHarnessCommand({ command: "sh", args: ["-c", "echo ready; exit 3"] }, "capture"),
    ).resolves.toEqual({ code: 3, stdout: "ready\n" });
  });

  test("an executable that does not exist resolves as 127 rather than throwing", async () => {
    await expect(
      spawnHarnessCommand({ command: "/nonexistent/omnesis-test-harness", args: [] }, "capture"),
    ).resolves.toMatchObject({ code: 127 });
  });

  test("the spec's environment reaches the command", async () => {
    const result = await spawnHarnessCommand(
      { command: "sh", args: ["-c", 'printf %s "$HERMES_HOME"'], env: { HERMES_HOME: "/h" } },
      "capture",
    );
    expect(result.stdout).toBe("/h");
  });
});
