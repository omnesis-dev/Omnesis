// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export function telemetryForcedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(off|false|0|no)$/i.test(env.OMNESIS_TELEMETRY?.trim() ?? "");
}

export function telemetryTestRuntime(env: NodeJS.ProcessEnv): boolean {
  const nonproduction = (value: string | undefined) =>
    /^(1|true|yes|on|all|\*)$/i.test(value?.trim() ?? "");
  return (
    Boolean(env.CI || env.VITEST || env.VITEST_WORKER_ID || env.NODE_TEST_CONTEXT) ||
    /^(test|development)$/i.test(env.NODE_ENV ?? "") ||
    nonproduction(env.OMNESIS_SYNTHETIC) ||
    nonproduction(env.OMNESIS_TEST_INSTANCE) ||
    nonproduction(env.OMNESIS_DEMO) ||
    Object.keys(env).some((key) => key.startsWith("OMNESIS_E2E_") && env[key] !== "0")
  );
}

/** Production is an explicit launch capability, never inferred from config defaults. */
export function telemetryRuntimeAllowed({
  env = process.env,
  entryPath = process.argv[1] ?? "",
}: { env?: NodeJS.ProcessEnv; entryPath?: string } = {}): boolean {
  if (env.OMNESIS_RUNTIME_MODE !== "production") return false;
  if (telemetryTestRuntime(env)) return false;
  return !/(?:^|[/\\])(?:evals|benchmarks?|__tests__|e2e)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]s$/i.test(
    entryPath,
  );
}
