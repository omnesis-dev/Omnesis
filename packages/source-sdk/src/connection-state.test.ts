// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The states a credential can be in, and what each one asks of the operator.
 *
 * Most of what is worth asserting here is not arithmetic but judgement that has
 * been wrong before: which states stop a source, which are transient, and which
 * two share a remedy while staying separate.
 */

import { describe, expect, test } from "vitest";
import {
  blocksSync,
  connectionRemedy,
  readConnectionState,
  isExpiringWithin,
  stateFromStoredCredential,
  type ConnectionState,
} from "./connection-state.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-07T12:00:00.000Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

test("an unreadable credential remains unknown without exposing exception content", async () => {
  const state = await readConnectionState(() => {
    throw new Error("fictional-secret-from-parser");
  });
  expect(state).toMatchObject({ status: "unknown" });
  expect(JSON.stringify(state)).not.toContain("fictional-secret-from-parser");
  expect(blocksSync(state)).toBe(false);
  expect(connectionRemedy(state)).toBe("wait");
  await expect(readConnectionState(async () => ({ status: "unlinked" }))).resolves.toEqual({
    status: "unlinked",
  });
});

describe("what a state asks of the operator", () => {
  const cases: Array<[ConnectionState, string]> = [
    [{ status: "connected" }, "none"],
    [{ status: "never-connected" }, "connect"],
    [{ status: "expired" }, "authenticate-again"],
    [{ status: "revoked" }, "authenticate-again"],
    [{ status: "scope-insufficient", missing: ["calendar.read"] }, "grant-more"],
    [{ status: "unlinked" }, "pair-again"],
    [{ status: "unknown", because: "keyring locked" }, "wait"],
  ];

  test.each(cases)("%o asks for %s", (state, remedy) => {
    expect(connectionRemedy(state)).toBe(remedy);
  });

  test("a lapsed grant and a withdrawn one share a remedy but stay separate", () => {
    // The action is identical; the sentence an operator should read is not, and
    // collapsing them would make one of the two impossible to word correctly.
    expect(connectionRemedy({ status: "expired" })).toBe(connectionRemedy({ status: "revoked" }));
    expect(blocksSync({ status: "expired" })).toBe(blocksSync({ status: "revoked" }));
  });
});

describe("which states stop a source", () => {
  test("a credential that is not usable stops it", () => {
    for (const state of [
      { status: "never-connected" },
      { status: "expired" },
      { status: "revoked" },
      { status: "unlinked" },
    ] as ConnectionState[]) {
      expect(blocksSync(state), state.status).toBe(true);
    }
  });

  test("an unreadable credential does not stop it", () => {
    // The distinction the boolean could not make. A locked keyring is a failure
    // to read the answer, not the answer; refusing to sync on it turns a
    // transient local condition into an outage and prompts the operator to
    // re-authenticate something that is fine.
    expect(blocksSync({ status: "unknown", because: "keyring locked" })).toBe(false);
  });

  test("a grant that is merely too narrow does not stop it", () => {
    // Whatever the source can still reach, it should keep reaching. Stopping
    // would cost the data that is covered in order to signal the data that is
    // not.
    expect(blocksSync({ status: "scope-insufficient", missing: ["drive.read"] })).toBe(false);
  });
});

describe("warning before a deadline rather than after", () => {
  const connected = (expiresAt: string): ConnectionState => ({ status: "connected", expiresAt });

  test("a deadline inside the lead time is worth saying", () => {
    expect(isExpiringWithin(connected(inDays(3)), 14 * DAY, NOW)).toBe(true);
  });

  test("a deadline beyond it is not", () => {
    expect(isExpiringWithin(connected(inDays(30)), 14 * DAY, NOW)).toBe(false);
  });

  test("a deadline already past is not 'expiring'", () => {
    // It is expired. Showing a countdown that has already run out is worse
    // than showing nothing.
    expect(isExpiringWithin(connected(inDays(-1)), 14 * DAY, NOW)).toBe(false);
  });

  test("a credential with no deadline never expires", () => {
    expect(isExpiringWithin({ status: "connected" }, 14 * DAY, NOW)).toBe(false);
  });

  test("only a good credential can be expiring", () => {
    expect(isExpiringWithin({ status: "revoked" }, 14 * DAY, NOW)).toBe(false);
  });

  test("an unparseable deadline is not a warning", () => {
    expect(isExpiringWithin(connected("whenever"), 14 * DAY, NOW)).toBe(false);
  });
});

describe("reading a state from what is stored", () => {
  test("no credential means never connected", () => {
    expect(stateFromStoredCredential(false)).toEqual({ status: "never-connected" });
  });

  test("a credential with no deadline is simply connected", () => {
    expect(stateFromStoredCredential(true)).toEqual({ status: "connected" });
  });

  test("a deadline in the future is carried, not consumed", () => {
    // The host decides whether a deadline is close enough to mention. A source
    // that decided for it would have to know how hard re-authenticating is.
    const at = inDays(9);
    expect(stateFromStoredCredential(true, { expiresAt: at, now: NOW })).toEqual({
      status: "connected",
      expiresAt: at,
    });
  });

  test("a deadline in the past is expiry, and says when", () => {
    const at = inDays(-2);
    expect(stateFromStoredCredential(true, { expiresAt: at, now: NOW })).toEqual({
      status: "expired",
      at,
    });
  });

  test("a malformed deadline keeps the credential and drops the deadline", () => {
    // Discarding a working credential because its metadata is unreadable is
    // the more expensive mistake; a genuine failure still surfaces from the
    // sync path, with evidence. But a deadline nothing can compare against is
    // not a deadline: kept, it renders as a countdown that never moves and
    // warns nobody, ever.
    expect(stateFromStoredCredential(true, { expiresAt: "soon", now: NOW })).toEqual({
      status: "connected",
    });
  });

  test("a deadline exactly now has passed", () => {
    const at = NOW.toISOString();
    expect(stateFromStoredCredential(true, { expiresAt: at, now: NOW }).status).toBe("expired");
  });
});

describe("adding a state is a decision the compiler makes you take", () => {
  test("every state answers both questions", () => {
    // The pair that must be decided together. A list of the blocking arms
    // would compile unchanged when a state is added and classify it as
    // non-blocking — a source ticking against a credential nobody can use,
    // showing an idle pill rather than a prompt.
    const all: ConnectionState[] = [
      { status: "connected" },
      { status: "never-connected" },
      { status: "expired" },
      { status: "revoked" },
      { status: "scope-insufficient", missing: [] },
      { status: "unlinked" },
      { status: "unknown", because: "" },
    ];
    for (const state of all) {
      expect(typeof blocksSync(state), state.status).toBe("boolean");
      expect(connectionRemedy(state), state.status).not.toBe(undefined);
    }
  });

  test("only a state with nothing to do neither blocks nor asks", () => {
    expect(blocksSync({ status: "connected" })).toBe(false);
    expect(connectionRemedy({ status: "connected" })).toBe("none");
  });

  test("a state can ask for something without stopping the source", () => {
    // Both of these prompt and keep syncing, for different reasons: one is
    // partially usable, the other is unreadable rather than unusable.
    for (const state of [
      { status: "scope-insufficient", missing: ["x"] },
      { status: "unknown", because: "keyring locked" },
    ] as ConnectionState[]) {
      expect(blocksSync(state), state.status).toBe(false);
    }
  });
});
