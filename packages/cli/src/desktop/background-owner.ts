// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertManagedDesktopBackgroundOwner,
  managedDesktopBackgroundRequired,
  verifyManagedDesktopBackgroundOwner,
} from "@omnesis/core";
import { runDesktopDaemon } from "./daemon.js";
import type { Readable, Writable } from "node:stream";
import type { DesktopProfile } from "./environment.js";
import type { DesktopRestoreActivation } from "./restore-start-arguments.js";

interface Operations {
  required: typeof managedDesktopBackgroundRequired;
  verify: typeof verifyManagedDesktopBackgroundOwner;
  assert: typeof assertManagedDesktopBackgroundOwner;
  run: typeof runDesktopDaemon;
  input: Readable;
  output: Writable;
}
/** The selector is never authority. Native signed-parent verification precedes all daemon admission. */
export async function runDesktopDaemonEntry(
  profile: DesktopProfile,
  options: {
    backgroundOwner: boolean;
    restoreActivation?: DesktopRestoreActivation;
    signal?: AbortSignal;
  },
  dependencies: Partial<Operations> = {},
): Promise<void> {
  const ops: Operations = {
    required: managedDesktopBackgroundRequired,
    verify: verifyManagedDesktopBackgroundOwner,
    assert: assertManagedDesktopBackgroundOwner,
    run: runDesktopDaemon,
    input: process.stdin,
    output: process.stdout,
    ...dependencies,
  };
  const native = options.backgroundOwner || ops.required(import.meta.url);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  if (native) {
    ops.input.once("end", abort);
    ops.input.once("close", abort);
    ops.input.once("error", abort);
    ops.input.on("data", abort); // Lifetime only: no commands or input data are accepted.
    ops.input.resume();
    if (ops.input.readableEnded || ops.input.destroyed) abort();
  }
  try {
    signal.throwIfAborted();
    const owner = native ? ops.verify(profile) : undefined;
    signal.throwIfAborted();
    let announced = false;
    await ops.run(profile, {
      signal,
      restoreActivation: options.restoreActivation,
      ...(owner
        ? {
            onOwned: async () => {
              signal.throwIfAborted();
              if (announced) throw new Error("Background ownership was already announced");
              const current = ops.assert(profile);
              if (JSON.stringify(current) !== JSON.stringify(owner))
                throw new Error("Background ownership changed before admission");
              const frame =
                JSON.stringify({
                  version: 1,
                  kind: "desktop-daemon-ready",
                  nonce: owner.nonce,
                  pid: process.pid,
                  epoch: owner.epoch,
                  scope: owner.scope,
                }) + "\n";
              if (Buffer.byteLength(frame) > 4096)
                throw new Error("The background ownership frame is too large");
              announced = true;
              await new Promise<void>((resolve, reject) =>
                ops.output.write(frame, (error) =>
                  error
                    ? reject(new Error("Background ownership could not be announced"))
                    : resolve(),
                ),
              );
              signal.throwIfAborted();
            },
          }
        : {}),
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    if (native) {
      ops.input.off("end", abort);
      ops.input.off("close", abort);
      ops.input.off("error", abort);
      ops.input.off("data", abort);
      ops.input.pause();
    }
  }
}
