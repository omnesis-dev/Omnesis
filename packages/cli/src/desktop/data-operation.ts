#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readDesktopDataFrame } from "./data-operation-frame.js";
import { desktopEnvironment } from "./environment.js";
import { DesktopRestoreFailure } from "./restore-errors.js";

// Native runtime-exec chooses this fixed entry and installs the verified FD7
// authority before evaluation. Never print request data or caught exceptions.
process.umask(0o077);
const controller = new AbortController();
let finished = false;
const cancel = () => {
  if (!finished) controller.abort();
};
process.once("SIGTERM", cancel);
process.stdin.once("end", cancel);
process.stdin.once("error", cancel);
process.stdin.once("close", cancel);
try {
  const input = await readDesktopDataFrame(process.stdin, controller.signal);
  process.stdin.on("data", cancel);
  process.stdin.resume();
  if (
    !input ||
    typeof input !== "object" ||
    !("profile" in input) ||
    !input.profile ||
    typeof input.profile !== "object" ||
    !("configDir" in input.profile) ||
    typeof input.profile.configDir !== "string" ||
    !("instance" in input.profile) ||
    typeof input.profile.instance !== "string" ||
    !("secretService" in input.profile) ||
    typeof input.profile.secretService !== "string"
  )
    throw new Error("Invalid operation");
  if (
    !("purpose" in input) ||
    !["erase", "restore", "rollback", "update-snapshot", "update-rollback"].includes(
      String(input.purpose),
    ) ||
    !("operationId" in input) ||
    typeof input.operationId !== "string"
  )
    throw new Error("Invalid operation");
  const profile = {
    configDir: input.profile.configDir,
    instance: input.profile.instance,
    secretService: input.profile.secretService,
  };
  const { assertManagedDesktopDataAuthority } = await import("@omnesis/core");
  // The native environment remains authoritative until its exact private request
  // has been bound to the captured descriptor and operation tuple.
  if (
    input.purpose === "erase" ||
    input.purpose === "restore" ||
    input.purpose === "rollback" ||
    input.purpose === "update-snapshot" ||
    input.purpose === "update-rollback"
  )
    assertManagedDesktopDataAuthority(profile, input.purpose, input.operationId);
  else throw new Error("Invalid operation");
  const isolated = desktopEnvironment({
    configDir: input.profile.configDir,
    instance: input.profile.instance,
    secretService: input.profile.secretService,
  });
  for (const key of Object.keys(process.env)) if (!(key in isolated)) delete process.env[key];
  Object.assign(process.env, isolated);
  const { handleDesktopDataOperation } = await import("./data-operation-handler.js");
  const result = await handleDesktopDataOperation(input, controller.signal);
  controller.signal.throwIfAborted();
  const reply = JSON.stringify({ version: 1, ok: true, result });
  if (Buffer.byteLength(reply) > 64 * 1024) throw new Error("Invalid result");
  finished = true;
  process.stdout.write(reply, () => process.exit(0));
} catch (error) {
  finished = true;
  process.stdout.write(
    JSON.stringify(
      error instanceof DesktopRestoreFailure
        ? { version: 1, ok: false, error: { code: error.code } }
        : { version: 1, ok: false, code: "DATA_OPERATION_REFUSED" },
    ),
    () => process.exit(70),
  );
}
