// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regression guard for `omnesis dev-annotations`: the subcommands are wired
 * and their named flags (`list --all --type`, `resolve --note`) parse rather
 * than falling through to citty defaults.
 */
import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";
import { clientMetaBits, devAnnotationsCommand } from "./dev-annotations.js";

async function argsDefFor(name: string) {
  const sub = await devAnnotationsCommand.subCommands!;
  const cmd = (sub as Record<string, { args?: unknown }>)[name];
  const a = cmd.args;
  return typeof a === "function" ? await (a as () => unknown)() : await a;
}

describe("dev-annotations command wiring", () => {
  it("exposes list / resolve / rm subcommands", async () => {
    const sub = await devAnnotationsCommand.subCommands!;
    expect(Object.keys(sub as object).sort()).toEqual(["list", "resolve", "rm"]);
  });

  it("list surfaces --all and --type flags", async () => {
    const def = await argsDefFor("list");
    const parsed = parseArgs(["--all", "--type=document"], def as Parameters<typeof parseArgs>[1]);
    expect(parsed.all).toBe(true);
    expect(parsed.type).toBe("document");
  });

  it("resolve surfaces the id positional and --note flag", async () => {
    const def = await argsDefFor("resolve");
    const parsed = parseArgs(["note-1", "--note=fixed it"], def as Parameters<typeof parseArgs>[1]);
    expect(parsed.id).toBe("note-1");
    expect(parsed.note).toBe("fixed it");
  });
});

describe("clientMetaBits", () => {
  it("shows an android client with its app version and build", () => {
    expect(
      clientMetaBits({
        client: "android",
        context: { platform: "android", appVersion: "0.4.6", appBuild: "1" },
      }),
    ).toEqual(["via android", "app 0.4.6 (1)"]);
  });

  it("shows an ios client with a partial version", () => {
    expect(clientMetaBits({ client: "ios", context: { appVersion: "1.2.3" } })).toEqual([
      "via ios",
      "app 1.2.3 (?)",
    ]);
  });

  it("shows the portal user agent", () => {
    expect(
      clientMetaBits({ client: "portal", context: { platform: "portal", userAgent: "UA" } }),
    ).toEqual(["via portal", "UA"]);
  });

  it("falls back to the context platform when no client was recorded", () => {
    expect(clientMetaBits({ client: null, context: { platform: "portal" } })).toEqual([
      "via portal",
    ]);
  });

  it("emits nothing extra for a legacy row without a context snapshot", () => {
    expect(clientMetaBits({ client: "ios", context: null })).toEqual(["via ios"]);
  });
});
