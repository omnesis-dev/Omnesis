// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { type Readable } from "node:stream";
import {
  managedDesktopBackgroundRequired,
  verifyManagedDesktopBackgroundRetirement,
} from "@omnesis/core";
import { retireDesktopApplication } from "./application-retirement.js";
import type { DesktopProfile } from "./environment.js";

interface Operations {
  required: typeof managedDesktopBackgroundRequired;
  verify: typeof verifyManagedDesktopBackgroundRetirement;
  retire: typeof retireDesktopApplication;
  input: Readable;
}

/** Native ownership admits only the existing keep-data retirement policy, never data authority. */
export async function runDesktopRetirementEntry(
  profile: DesktopProfile,
  options: { backgroundOwner: boolean; signal: AbortSignal },
  dependencies: Partial<Operations> = {},
): Promise<void> {
  const ops: Operations = {
    required: managedDesktopBackgroundRequired,
    verify: verifyManagedDesktopBackgroundRetirement,
    retire: retireDesktopApplication,
    input: process.stdin,
    ...dependencies,
  };
  const native = options.backgroundOwner || ops.required(import.meta.url);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  if (native) {
    ops.input.once("end", abort);
    ops.input.once("close", abort);
    ops.input.once("error", abort);
    ops.input.on("data", abort);
    ops.input.resume();
    if (ops.input.readableEnded || ops.input.destroyed) abort();
  }
  try {
    signal.throwIfAborted();
    if (native) ops.verify(profile);
    signal.throwIfAborted();
    await ops.retire(profile, signal);
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
