#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Keep the phase-two import graph builtin-only. Phase one dynamically loads readiness
// and lock helpers before native takes its publication reservation.
import { desktopEnvironment } from "./environment.js";
import { readDesktopDataFrame } from "./data-operation-frame.js";
import { DesktopSnapshotRetentionFailure } from "./snapshot-retention-errors.js";
process.umask(0o077);
const controller = new AbortController();
let finished = false;
const cancel = () => {
  if (!finished) controller.abort();
};
process.once("SIGTERM", cancel);
process.stdin.once("end", cancel);
process.stdin.once("close", cancel);
process.stdin.once("error", cancel);
function profile() {
  const configDir = process.env.OMNESIS_CONFIG_DIR,
    instance = process.env.OMNESIS_SERVICE_INSTANCE,
    secretService = process.env.OMNESIS_SECRET_SERVICE;
  if (
    !configDir ||
    !instance ||
    !secretService ||
    !/^desktop-[a-f0-9]{16}$/u.test(instance) ||
    !/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(secretService)
  )
    throw new Error("Invalid managed scope");
  return { configDir, instance, secretService };
}
try {
  const [phase, operationId, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !operationId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(operationId)
  )
    throw new Error("Invalid cleanup operation");
  const scope = profile();
  if (phase === "--prepare") {
    const request = await readDesktopDataFrame(process.stdin, controller.signal, 64 * 1024);
    process.stdin.on("data", cancel);
    process.stdin.resume();
    const { desktopSnapshotGcRequestSchema } = await import("./snapshot-retention-request.js");
    const input = desktopSnapshotGcRequestSchema.parse(request);
    if (
      input.profile.configDir !== scope.configDir ||
      input.profile.instance !== scope.instance ||
      input.profile.secretService !== scope.secretService
    )
      throw new Error("The cleanup scope changed");
    const isolated = desktopEnvironment(scope);
    for (const key of Object.keys(process.env)) if (!(key in isolated)) delete process.env[key];
    Object.assign(process.env, isolated);
    const { runDesktopSnapshotGcPhaseOne } = await import("./snapshot-retention-phase-one.js");
    await runDesktopSnapshotGcPhaseOne(operationId, input, controller.signal);
    throw new Error("The native transition unexpectedly returned");
  }
  if (phase !== "--perform") throw new Error("Invalid cleanup phase");
  process.stdin.on("data", cancel);
  process.stdin.resume();
  const { assertManagedDesktopSnapshotGcAuthority } = await import("@omnesis/core/node-command");
  assertManagedDesktopSnapshotGcAuthority(scope, operationId);
  const { finishDesktopSnapshotCleanup } = await import("./snapshot-retention-delete.js");
  const result = await finishDesktopSnapshotCleanup(scope, operationId, controller.signal, {
    assert: (expected, receipt) =>
      assertManagedDesktopSnapshotGcAuthority(expected, receipt.operationId),
  });
  finished = true;
  process.stdout.write(JSON.stringify({ version: 1, ok: true, result }), () => process.exit(0));
} catch (error) {
  finished = true;
  process.stdout.write(
    JSON.stringify({
      version: 1,
      ok: false,
      error: {
        code:
          error instanceof DesktopSnapshotRetentionFailure
            ? error.code
            : "RECOVERY_CLEANUP_REFUSED",
      },
    }),
    () => process.exit(70),
  );
}
