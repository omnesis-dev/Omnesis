// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { processStart, sameProcess } from "./update-lock-process.js";

const CLAIM_PREFIX = ".claim-";
export const DEFAULT_STALE_MS = 30_000;

interface GuardClaim {
  version: 1;
  state: "choosing" | "waiting";
  ticket: number;
  pid: number;
  processStart: string | null;
}

/** A filesystem-backed bakery lock serializes owner changes without a toolchain. */
export function claimGuard(lockDir: string): string | null {
  const name = `${CLAIM_PREFIX}${randomUUID()}`;
  const claim = join(lockDir, name);
  const identity: GuardClaim = {
    version: 1,
    state: "choosing",
    ticket: 0,
    pid: process.pid,
    processStart: processStart(process.pid),
  };
  try {
    writeFileSync(claim, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    return null;
  }

  let ticket = 1;
  try {
    const contenders = readdirSync(lockDir).filter((entry) => entry.startsWith(CLAIM_PREFIX));
    for (const entry of contenders) {
      if (entry === name) continue;
      discardStaleClaim(join(lockDir, entry));
      const other = readGuardClaim(join(lockDir, entry));
      if (other?.state === "waiting") ticket = Math.max(ticket, other.ticket + 1);
    }
    identity.state = "waiting";
    identity.ticket = ticket;
    atomicWriteFileSync(claim, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  } catch {
    releaseGuard(claim);
    return null;
  }

  for (let attempt = 0; attempt < 250; attempt += 1) {
    let contenders: string[];
    try {
      contenders = readdirSync(lockDir).filter((entry) => entry.startsWith(CLAIM_PREFIX));
      for (const entry of contenders) {
        if (entry === name) continue;
        discardStaleClaim(join(lockDir, entry));
      }
      contenders = readdirSync(lockDir).filter((entry) => entry.startsWith(CLAIM_PREFIX));
    } catch {
      releaseGuard(claim);
      return null;
    }
    if (!contenders.includes(name)) {
      releaseGuard(claim);
      return null;
    }
    let blocked = false;
    for (const entry of contenders) {
      if (entry === name) continue;
      const other = readGuardClaim(join(lockDir, entry));
      if (
        !other ||
        other.state === "choosing" ||
        other.ticket < ticket ||
        (other.ticket === ticket && entry < name)
      ) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return claim;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  releaseGuard(claim);
  return null;
}

function readGuardClaim(path: string): GuardClaim | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GuardClaim>;
    if (
      value.version !== 1 ||
      (value.state !== "choosing" && value.state !== "waiting") ||
      !Number.isSafeInteger(value.ticket) ||
      (value.ticket as number) < 0 ||
      !Number.isInteger(value.pid) ||
      (typeof value.processStart !== "string" && value.processStart !== null)
    ) {
      return null;
    }
    return value as GuardClaim;
  } catch {
    return null;
  }
}

function discardStaleClaim(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return;
    const age = Date.now() - stat.mtimeMs;
    // Future mtimes are conservatively live after a backwards clock step.
    if (age < DEFAULT_STALE_MS) return;
    let identity: { pid?: unknown; processStart?: unknown };
    try {
      identity = JSON.parse(readFileSync(path, "utf8")) as typeof identity;
    } catch {
      unlinkSync(path);
      return;
    }
    if (
      Number.isInteger(identity.pid) &&
      (typeof identity.processStart === "string" || identity.processStart === null) &&
      sameProcess(identity.pid as number, identity.processStart)
    ) {
      return;
    }
    unlinkSync(path);
  } catch {
    // A concurrent claimant retired the directory or removed this exact claim.
  }
}

export function releaseGuard(claim: string): void {
  try {
    unlinkSync(claim);
  } catch {
    // The whole lock was retired, or this exact claim was already cleaned up.
  }
}
