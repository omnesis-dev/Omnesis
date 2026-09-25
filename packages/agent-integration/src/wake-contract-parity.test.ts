// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wake contract is written twice, in two languages, and the copies have to
 * agree.
 *
 * The adapter written in Python ships as a standalone Hermes plugin and
 * deliberately imports nothing of Omnesis, so it restates the version range,
 * field bounds and status vocabulary by hand. Nothing at runtime would notice
 * them drifting: the gateway would build a wake one half calls valid and the
 * other refuses, and the firing would fail on a machine nobody is watching.
 * The two neighbouring guards over the same file work the same way.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
} from "./protocol.js";

const ADAPTER = fileURLToPath(new URL("../hermes/adapter.py", import.meta.url));

function pythonInt(source: string, name: string): number {
  const found = new RegExp(`^${name} = (\\d+)$`, "m").exec(source);
  if (!found) throw new Error(`${name} is not declared in the Hermes adapter`);
  return Number(found[1]);
}

describe("the wake contract as both runtimes state it", () => {
  const source = readFileSync(ADAPTER, "utf8");

  test("the negotiable version range is the same on both sides", () => {
    expect(pythonInt(source, "DELIVERY_PROTOCOL_MIN_VERSION")).toBe(
      AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
    );
    expect(pythonInt(source, "DELIVERY_PROTOCOL_VERSION")).toBe(AGENT_INTEGRATION_PROTOCOL_VERSION);
  });

  test("both sides bound a referent the same way", () => {
    expect(pythonInt(source, "_MAX_BINDINGS")).toBe(32);
    expect(pythonInt(source, "_MAX_BINDING_KEY")).toBe(64);
    expect(pythonInt(source, "_MAX_BINDING_VALUE")).toBe(512);
  });

  test("the version that carries referents and a receipt is the same on both sides", () => {
    // "has the newer fields", not "is the newest version" — the two diverge
    // the moment the range grows again, and a wake at the older-but-still-new
    // version would then be checked against the wrong field set.
    expect(pythonInt(source, "_OUTCOME_AND_BINDINGS_VERSION")).toBe(
      AGENT_INTEGRATION_PROTOCOL_VERSION,
    );
  });
});

/**
 * `device.update` is written twice for the same reason the wake contract is:
 * this package runs on a machine with no Omnesis checkout, so it restates the
 * command's shape rather than importing the registry that defines it.
 *
 * Only the version's pattern is compared, because that is the half with teeth
 * — the string becomes an argument to a command the machine runs on itself,
 * and a copy that drifts wider is a copy that accepts something the gateway's
 * own boundary would have refused.
 */
describe("the update command as both packages state it", () => {
  /** The version pattern a file states, as its source literal. */
  const patternIn = (url: string): string => {
    const source = readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
    const found = /(\/\^\(0\|\[1-9\]\\d\*\)[^\n]*?\/u)/.exec(source);
    if (!found) throw new Error(`no version pattern is stated in ${url}`);
    return found[1]!;
  };

  test("the accepted version pattern is the same on both sides", () => {
    // Compared as source literals rather than through zod: what matters is
    // that the two files say the same thing, and a copy that drifts wider is
    // one that accepts a string the gateway's own boundary would refuse.
    expect(patternIn("./protocol.ts")).toBe(patternIn("../../core/src/ws-messages.ts"));
  });

  test("the Hermes adapter accepts the same versions", () => {
    // Python states the pattern as a raw string rather than a `/…/u` literal;
    // the adapter compiles it with `re.ASCII` and matches it in full, which is
    // what gives `\d`, `\w` and `$` their JavaScript meaning.
    const source = readFileSync(ADAPTER, "utf8");
    const found = /^_RELEASE_VERSION_PATTERN = r"([^"\n]+)"$/m.exec(source);
    if (!found) throw new Error("_RELEASE_VERSION_PATTERN is not declared in the Hermes adapter");
    expect(`/${found[1]}/u`).toBe(patternIn("./protocol.ts"));
  });

  test("all three runtimes require the same full lowercase source commit", () => {
    for (const url of ["./protocol.ts", "../../core/src/ws-messages.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
      expect(source).toContain("/^[0-9a-f]{40}$/u");
    }
    expect(readFileSync(ADAPTER, "utf8")).toContain('r"^[0-9a-f]{40}$"');
  });

  test("the longest result detail the gateway accepts is the same on both sides", () => {
    // A copy that drifts higher lets the plugin send a detail the gateway's
    // schema drops, and the device row then never leaves "dispatched".
    const limitIn = (url: string): string => {
      const source = readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
      const found = /export const DEVICE_UPDATE_DETAIL_MAX_CHARS = ([\d_]+);/.exec(source);
      if (!found) throw new Error(`no detail limit is stated in ${url}`);
      return found[1]!;
    };
    expect(limitIn("./protocol.ts")).toBe(limitIn("../../core/src/ws-messages.ts"));
  });
});
