// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal slash-command registry from
// vitest; the module is untyped browser code, so type-checking is off here.
import { describe, it, expect } from "vitest";
import {
  SLASH_COMMANDS,
  getSlashCommand,
  matchSlashCommands,
  sendOptionsForArmed,
} from "./slash-commands.js";

describe("slash-command registry", () => {
  it("is seeded with exactly the one 'Deep Research (beta)' command (extensible)", () => {
    // The registry is a general list deliberately seeded with one item; this
    // asserts the seed shape, not that it can only ever hold one.
    expect(SLASH_COMMANDS.length).toBe(1);
    const dr = SLASH_COMMANDS[0];
    expect(dr.id).toBe("deep-research");
    expect(dr.label).toBe("Deep Research (beta)");
    expect(dr.icon).toBe("telescope");
    expect(dr.send).toEqual({ deepResearch: true });
  });

  it("getSlashCommand resolves by id and returns null for unknown (graceful)", () => {
    expect(getSlashCommand("deep-research")?.id).toBe("deep-research");
    expect(getSlashCommand("nope")).toBeNull();
    expect(getSlashCommand("")).toBeNull();
    expect(getSlashCommand(undefined)).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  it("does not open for ordinary prompt text", () => {
    expect(matchSlashCommands("what did I eat").open).toBe(false);
    expect(matchSlashCommands("").open).toBe(false);
    expect(matchSlashCommands("ask about /foo").open).toBe(false);
  });

  it("opens on a bare slash and lists every command", () => {
    const m = matchSlashCommands("/");
    expect(m.open).toBe(true);
    expect(m.matches.map((c) => c.id)).toEqual(["deep-research"]);
  });

  it("offers Deep Research regardless of experimental mode", () => {
    const off = matchSlashCommands("/");
    expect(off.open).toBe(true);
    expect(off.matches.map((c) => c.id)).toEqual(["deep-research"]);
    expect(matchSlashCommands("/deep").matches[0]?.id).toBe("deep-research");
    expect(matchSlashCommands("/deep", { experimental: true }).matches[0]?.id).toBe("deep-research");
  });

  it("filters by trigger and label substring, case-insensitively", () => {
    expect(matchSlashCommands("/deep").matches[0]?.id).toBe("deep-research");
    expect(matchSlashCommands("/RESEARCH").matches[0]?.id).toBe("deep-research");
    expect(matchSlashCommands("/research").matches.length).toBe(1);
    expect(matchSlashCommands("/xyz").matches.length).toBe(0);
  });

  it("closes once the token contains whitespace (user is composing a prompt)", () => {
    // `/deep research the …` — the space means the user moved past the
    // command token into a real prompt; the menu must close.
    expect(matchSlashCommands("/deep research").open).toBe(false);
  });

  it("guards non-string input", () => {
    expect(matchSlashCommands(null).open).toBe(false);
    expect(matchSlashCommands(undefined).open).toBe(false);
    expect(matchSlashCommands(42).open).toBe(false);
  });
});

describe("sendOptionsForArmed", () => {
  it("returns the command's send options when armed", () => {
    expect(sendOptionsForArmed("deep-research")).toEqual({ deepResearch: true });
  });

  it("returns an empty object (ordinary turn) when nothing is armed", () => {
    expect(sendOptionsForArmed(null)).toEqual({});
    expect(sendOptionsForArmed(undefined)).toEqual({});
    expect(sendOptionsForArmed("unknown")).toEqual({});
  });

  it("returns a fresh copy so callers can't mutate the frozen descriptor", () => {
    const a = sendOptionsForArmed("deep-research");
    a.deepResearch = false;
    expect(sendOptionsForArmed("deep-research")).toEqual({ deepResearch: true });
  });
});
