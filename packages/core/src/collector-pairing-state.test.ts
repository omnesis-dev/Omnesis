// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  classifyCollectorAuth,
  COLLECTOR_PAIRING_STATE_FILE,
  credentialEverAuthenticated,
  needsPairingLogLine,
  readCollectorPairingState,
  repairCommandFor,
  tokenFingerprint,
  writeCollectorPairingState,
  type CollectorPairingState,
} from "./collector-pairing-state.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-pairing-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const paired = (over: Partial<CollectorPairingState> = {}): CollectorPairingState => ({
  state: "paired",
  deviceName: "workstation-collector",
  gatewayUrl: "https://gateway.example.com:7600",
  tokenFingerprint: tokenFingerprint("omn_token_one"),
  lastAuthenticatedAt: 1_700_000_000_000,
  unauthorizedAt: null,
  repairCommand: null,
  ...over,
});

describe("classifyCollectorAuth", () => {
  test("a credential the gateway accepts is authenticated", () => {
    expect(classifyCollectorAuth({ status: 200, everAuthenticated: false })).toBe("authenticated");
    expect(classifyCollectorAuth({ status: 204, everAuthenticated: true })).toBe("authenticated");
  });

  // The whole point of the persisted history: a 401 on a token that used to
  // work is a revoke, and no amount of retrying will change that. A 401 on a
  // token with no history is an install that was never finished.
  test("an unrecognised credential that previously worked needs re-pairing", () => {
    expect(classifyCollectorAuth({ status: 401, everAuthenticated: true })).toBe("needs-pairing");
  });

  test("an unrecognised credential with no history is treated as never wired up", () => {
    expect(classifyCollectorAuth({ status: 401, everAuthenticated: false })).toBe(
      "never-authenticated",
    );
  });

  // 403 says the gateway knows this credential and refused it on scope, so
  // the device is still paired; an authenticating proxy in front of the
  // gateway answers 403 too. Neither is a revoke.
  test("a scope refusal is never read as a revoke", () => {
    expect(classifyCollectorAuth({ status: 403, everAuthenticated: true })).toBe("unreachable");
    expect(classifyCollectorAuth({ status: 403, everAuthenticated: false })).toBe("unreachable");
  });

  test("no answer, or an answer about anything but identity, is transient", () => {
    for (const status of [null, 500, 502, 429, 404]) {
      expect(classifyCollectorAuth({ status, everAuthenticated: true })).toBe("unreachable");
    }
  });
});

describe("credentialEverAuthenticated", () => {
  test("is false without a persisted record", () => {
    expect(
      credentialEverAuthenticated(null, {
        token: "omn_token_one",
        gatewayUrl: "https://gateway.example.com:7600",
      }),
    ).toBe(false);
  });

  test("is true for the exact token and gateway the record describes", () => {
    expect(
      credentialEverAuthenticated(paired(), {
        token: "omn_token_one",
        gatewayUrl: "https://gateway.example.com:7600",
      }),
    ).toBe(true);
  });

  test("a rotated token has no history of its own", () => {
    expect(
      credentialEverAuthenticated(paired(), {
        token: "omn_token_two",
        gatewayUrl: "https://gateway.example.com:7600",
      }),
    ).toBe(false);
  });

  // Re-pointing a collector at a different gateway starts a fresh history:
  // the new gateway has never seen this credential, so its 401 is a failed
  // first pairing, not a revoke.
  test("a different gateway has no history for the credential", () => {
    expect(
      credentialEverAuthenticated(paired(), {
        token: "omn_token_one",
        gatewayUrl: "https://other.example.com:7600",
      }),
    ).toBe(false);
  });

  test("a record that never authenticated proves nothing", () => {
    expect(
      credentialEverAuthenticated(paired({ lastAuthenticatedAt: null }), {
        token: "omn_token_one",
        gatewayUrl: "https://gateway.example.com:7600",
      }),
    ).toBe(false);
  });
});

describe("pairing state file", () => {
  test("round-trips a written verdict", () => {
    const state = paired({
      state: "needs-pairing",
      unauthorizedAt: 1_700_000_100_000,
      repairCommand: repairCommandFor("workstation-collector"),
    });
    expect(writeCollectorPairingState(dir, state)).toBe(true);
    expect(readCollectorPairingState(dir)).toEqual(state);
  });

  test("never stores the token itself", () => {
    writeCollectorPairingState(dir, paired());
    const raw = readCollectorPairingState(dir);
    expect(raw?.tokenFingerprint).not.toContain("omn_token_one");
    expect(raw?.tokenFingerprint).toHaveLength(16);
  });

  test("the file is owner-only — it sits beside the token files", async () => {
    writeCollectorPairingState(dir, paired());
    const { statSync } = await import("node:fs");
    expect(statSync(join(dir, COLLECTOR_PAIRING_STATE_FILE)).mode & 0o777).toBe(0o600);
  });

  test("an absent, malformed or incomplete file reads as no record", () => {
    expect(readCollectorPairingState(dir)).toBeNull();
    const path = join(dir, COLLECTOR_PAIRING_STATE_FILE);
    writeFileSync(path, "{not json");
    expect(readCollectorPairingState(dir)).toBeNull();
    writeFileSync(path, JSON.stringify({ state: "confused", deviceName: "x" }));
    expect(readCollectorPairingState(dir)).toBeNull();
  });
});

describe("needsPairingLogLine", () => {
  // This single line is the whole recovery path for an operator reading a
  // journal weeks later, so it has to name the device, the gateway, the
  // command that mints the code, and where the new token goes.
  test("carries the device, the gateway and both halves of the repair", () => {
    const line = needsPairingLogLine({
      deviceName: "workstation-collector",
      gatewayUrl: "https://gateway.example.com:7600",
      configDir: "/etc/omnesis",
    });
    expect(line).toContain("workstation-collector");
    expect(line).toContain("https://gateway.example.com:7600");
    expect(line).toContain("omnesis devices repair workstation-collector");
    expect(line).toContain("omnesis pair <code>");
    expect(line).toContain("/etc/omnesis/collector-token");
    expect(line.split("\n")).toHaveLength(1);
  });
});
