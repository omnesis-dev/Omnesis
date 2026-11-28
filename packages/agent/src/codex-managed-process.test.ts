// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { buildCodexEnv } from "./codex-app-server-backend.js";
import {
  MANAGED_CODEX_PROCESS_FEATURES,
  assertManagedCodexEffectiveFeatures,
  assertManagedCodexProcessPolicy,
  managedCodexProcessArgs,
  managedCodexThreadConfig,
  assertManagedCodexWorkspace,
} from "./codex-managed-process.js";

const config = () => ({
  layers: [
    {
      name: { type: "sessionFlags" },
      config: {
        tools: {
          experimental_request_user_input: { enabled: false },
          update_plan: { enabled: false },
        },
      },
    },
  ],
  config: {
    features: { ...MANAGED_CODEX_PROCESS_FEATURES },
    mcp_servers: {},
    notify: [],
    allow_login_shell: false,
    project_doc_max_bytes: 0,
    web_search: "disabled",
    tools: { experimental_request_user_input: { enabled: false }, update_plan: { enabled: false } },
  },
});
test("only the inspected pinned runtime may normalize the executor beneath the disabled shell gate", async () => {
  const data = features().map((feature) =>
    feature.name === "unified_exec" ? { ...feature, enabled: true } : feature,
  );
  await expect(
    assertManagedCodexEffectiveFeatures(async () => ({ data }), undefined, "0.171.0"),
  ).resolves.toBeUndefined();
  for (const version of [undefined, "0.168.0", "0.169.0", "0.170.0", "0.172.0"])
    await expect(
      assertManagedCodexEffectiveFeatures(async () => ({ data }), undefined, version),
    ).rejects.toThrow(/process policy/u);
  const shellEnabled = data.map((feature) =>
    feature.name === "shell_tool" ? { ...feature, enabled: true } : feature,
  );
  await expect(
    assertManagedCodexEffectiveFeatures(async () => ({ data: shellEnabled }), undefined, "0.171.0"),
  ).rejects.toThrow(/process policy/u);
});
test("managed Git metadata ignores inherited global execution hooks and workspace config", async () => {
  const env = buildCodexEnv(
    {
      OMNESIS_DESKTOP_MANAGED: "1",
      HOME: "/example/home",
      GIT_CONFIG_GLOBAL: "/example/untrusted",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "fixture-program",
      CODEX_ROLLOUT_TRACE_ROOT: "/example/untrusted-trace",
      OPENAI_IDENTITY_TOKEN_SOURCE: "spiffe",
      OPENAI_SPIFFE_AUDIENCE: "fictional-audience",
      OPENAI_SPIFFE_ID: "fictional-identity",
      SPIFFE_ENDPOINT_SOCKET: "/example/untrusted-identity-socket",
    },
    "/example/codex",
    "darwin",
    "/example/workspace",
  );
  expect(env).toMatchObject({
    HOME: "/example/home",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: "/example/workspace",
  });
  expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
  for (const name of [
    "CODEX_ROLLOUT_TRACE_ROOT",
    "OPENAI_IDENTITY_TOKEN_SOURCE",
    "OPENAI_SPIFFE_AUDIENCE",
    "OPENAI_SPIFFE_ID",
    "SPIFFE_ENDPOINT_SOCKET",
  ])
    expect(env[name]).toBeUndefined();
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-sdk-workspace-")));
  try {
    await expect(assertManagedCodexWorkspace(root)).resolves.toBeUndefined();
    await mkdir(join(root, ".codex"), { mode: 0o700 });
    await writeFile(join(root, ".codex", "config.toml"), "fixture=true", { mode: 0o600 });
    await expect(assertManagedCodexWorkspace(root)).rejects.toThrow(/process policy/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const features = () =>
  Object.entries(MANAGED_CODEX_PROCESS_FEATURES).map(([name, enabled]) => ({
    name,
    enabled,
    stage: "stable",
  }));
test("native process flags override prior caller settings and thread config preserves only declared policy", () => {
  const args = managedCodexProcessArgs(["app-server", "-c", "features.shell_snapshot=true"]);
  expect(args.indexOf("features.shell_snapshot=false")).toBeGreaterThan(
    args.indexOf("features.shell_snapshot=true"),
  );
  for (const flag of [
    "notify=[]",
    "mcp_servers={}",
    "allow_login_shell=false",
    "project_doc_max_bytes=0",
  ])
    expect(args).toContain(flag);
  const original = { features: { shell_tool: false }, model: "fixture" };
  expect(() => managedCodexThreadConfig(original)).toThrow(/model tool metadata/u);
  expect(original).toEqual({ features: { shell_tool: false }, model: "fixture" });
});
test("raw config refuses deep-merged MCP, notification commands and ignored shell policy", () => {
  expect(() => assertManagedCodexProcessPolicy(config())).not.toThrow();
  for (const extra of [
    { mcp_servers: { fixture: { command: "fixture-program" } } },
    { notify: ["fixture-program"] },
    { allow_login_shell: true },
    { project_doc_max_bytes: 1024 },
    { web_search: "live" },
    { features: { ...MANAGED_CODEX_PROCESS_FEATURES, shell_snapshot: true } },
  ])
    expect(() =>
      assertManagedCodexProcessPolicy({ ...config(), config: { ...config().config, ...extra } }),
    ).toThrow(/process policy/u);
});
test("tool controls require one explicit session-flags layer rather than omitted effective fields", () => {
  for (const layers of [
    undefined,
    [],
    [...config().layers, ...config().layers],
    [{ name: { type: "user" }, config: config().layers[0]!.config }],
    [
      {
        name: { type: "sessionFlags" },
        config: {
          tools: {
            experimental_request_user_input: { enabled: true },
            update_plan: { enabled: false },
          },
        },
      },
    ],
  ])
    expect(() => assertManagedCodexProcessPolicy({ ...config(), layers })).toThrow(
      /process policy/u,
    );
});
test("effective catalog independently recognizes every required flag across bounded pages", async () => {
  const data = features();
  const request = vi.fn(async (params: { cursor?: string }) =>
    params.cursor
      ? { data: data.slice(5), nextCursor: null }
      : { data: data.slice(0, 5), nextCursor: "fixture-next" },
  );
  await assertManagedCodexEffectiveFeatures(request, "fixture-thread", "0.171.0");
  expect(request).toHaveBeenLastCalledWith({
    cursor: "fixture-next",
    limit: 128,
    threadId: "fixture-thread",
  });
});
test("an unsupported echoed flag, enabled flag, removed implementation or repeated cursor always refuses", async () => {
  for (const data of [
    features().filter(({ name }) => name !== "shell_snapshot"),
    features().map((feature) =>
      feature.name === "shell_snapshot" ? { ...feature, enabled: true } : feature,
    ),
    features().map((feature) =>
      feature.name === "hooks" ? { ...feature, stage: "removed" } : feature,
    ),
  ])
    await expect(
      assertManagedCodexEffectiveFeatures(
        async () => ({ data, nextCursor: null }),
        undefined,
        "0.171.0",
      ),
    ).rejects.toThrow(/process policy/u);
  await expect(
    assertManagedCodexEffectiveFeatures(
      async () => ({ data: [], nextCursor: "fixture-repeat" }),
      undefined,
      "0.171.0",
    ),
  ).rejects.toThrow(/process policy/u);
});
