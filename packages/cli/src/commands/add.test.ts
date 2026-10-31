// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, test, expect } from "vitest";
import {
  containerFolderOutcome,
  experimentalLabelSuffix,
  extraPositionalArg,
  memberConfigForDescriptor,
  pathValueForCollector,
  waitForDeviceOnline,
} from "./add.js";
import type { DockerFolders } from "../docker-folders.js";

describe("extraPositionalArg", () => {
  test("skips citty's duplicate named positional", () => {
    expect(extraPositionalArg("pi", ["pi", "/sessions"])).toBe("/sessions");
    expect(extraPositionalArg("pi", ["/sessions"])).toBe("/sessions");
  });
});

describe("pathValueForCollector", () => {
  test("leaves a remote collector's filesystem syntax for that collector to resolve", () => {
    expect(pathValueForCollector("  ~/sessions  ", "remote.example")).toBe("~/sessions");
  });

  test("retains local path normalization when the collector shares this host", () => {
    expect(pathValueForCollector("~/sessions", hostname(), { HOME: "/home/fixture" })).toBe(
      join(homedir(), "/sessions"),
    );
  });

  test("in a Docker install's container, ~ and a relative path are the host's", () => {
    // The CLI runs in a container whose own home is nobody's; the launcher
    // passes in where the operator is on the machine that runs Docker.
    const env = { OMNESIS_HOST_HOME: "/Users/maya", OMNESIS_HOST_CWD: "/Users/maya/Documents" };
    expect(pathValueForCollector("~/Documents/field-notes", hostname(), env)).toBe(
      "/Users/maya/Documents/field-notes",
    );
    expect(pathValueForCollector("field-notes", hostname(), env)).toBe(
      "/Users/maya/Documents/field-notes",
    );
    expect(pathValueForCollector("/Volumes/Archive", hostname(), env)).toBe("/Volumes/Archive");
    // A remote collector still resolves its own.
    expect(pathValueForCollector("~/notes", "remote.example", env)).toBe("~/notes");
  });
});

describe("containerFolderOutcome: a host folder the collector's container cannot see", () => {
  const folders = (over: Partial<DockerFolders> = {}): DockerFolders => ({
    projectDir: "/Users/maya/.config/omnesis",
    shared: ["/Users/maya/shared-vaults"],
    canRequest: true,
    ...over,
  });
  const resume = ["sources", "add", "obsidian-notes", "/Users/maya/Notes", "--device", "dev-1"];
  const error = "Vault path does not exist: /Users/maya/Notes";

  test("asks the launcher to offer the share, with the command that resumes the add", () => {
    const requests: Array<{ path: string; resume: readonly string[] }> = [];
    const outcome = containerFolderOutcome({
      value: "/Users/maya/Notes",
      error,
      collectorIsLocal: true,
      folders: folders(),
      resume,
      writeRequest: (_f, path, words) => {
        requests.push({ path, resume: words });
        return true;
      },
    });
    expect(outcome.kind).toBe("requested");
    expect(requests).toEqual([{ path: "/Users/maya/Notes", resume }]);
  });

  test("without a launcher that can offer it, names the exact command", () => {
    const outcome = containerFolderOutcome({
      value: "/Users/maya/Jamie's Notes",
      error,
      collectorIsLocal: true,
      folders: folders({ canRequest: false }),
      resume,
      writeRequest: () => {
        throw new Error("must not be written");
      },
    });
    expect(outcome.kind).toBe("explain");
    const text = stripVTControlCharacters(outcome.kind === "explain" ? outcome.message : "");
    expect(text).toContain(error);
    expect(text).toContain("runs in a Docker container");
    expect(text).toContain(`omnesis folders share '/Users/maya/Jamie'\\''s Notes'`);
  });

  test("does not repeat the command when the collector's error already names it", () => {
    const named = `${error}. ... share it with the collector there: omnesis folders share '/Users/maya/Notes'`;
    const outcome = containerFolderOutcome({
      value: "/Users/maya/Notes",
      error: named,
      collectorIsLocal: true,
      folders: folders({ canRequest: false }),
      resume,
    });
    expect(outcome.kind === "explain" && stripVTControlCharacters(outcome.message)).toBe(named);
  });

  test.each([
    ["a remote collector's path", { collectorIsLocal: false }],
    ["an install that is not Docker", { folders: null }],
    ["a folder already shared", { value: "/Users/maya/shared-vaults/Research" }],
    ["a path inside the config directory", { value: "/Users/maya/.config/omnesis/import" }],
    ["a path the collector resolves itself", { value: "~/Notes" }],
  ])("leaves %s to the collector's own error", (_label, over) => {
    const outcome = containerFolderOutcome({
      value: "/Users/maya/Notes",
      error,
      collectorIsLocal: true,
      folders: folders(),
      resume,
      writeRequest: () => {
        throw new Error("must not be written");
      },
      ...over,
    });
    expect(outcome).toEqual({ kind: "none" });
  });
});

describe("waitForDeviceOnline", () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
    };
  }

  test("waits through a restarting gateway until the collector is back", async () => {
    const answers: Array<() => unknown[]> = [
      () => {
        throw new Error("connect ECONNREFUSED");
      },
      () => [{ id: "dev-1", name: "studio-northstar", kind: "collector", online: false }],
      () => [{ id: "dev-1", name: "studio-northstar", kind: "collector", online: true }],
    ];
    let calls = 0;
    const online = await waitForDeviceOnline("dev-1", 60_000, {
      ...clock(),
      listDevices: () => Promise.resolve().then(() => answers[calls++]!() as never),
    });
    expect(online).toBe(true);
    expect(calls).toBe(3);
  });

  test("gives up at the deadline and lets the add report what is wrong", async () => {
    let calls = 0;
    const online = await waitForDeviceOnline("studio-northstar", 10_000, {
      ...clock(),
      listDevices: () => {
        calls += 1;
        return Promise.resolve([]);
      },
    });
    expect(online).toBe(false);
    expect(calls).toBe(6);
  });
});

describe("experimentalLabelSuffix", () => {
  test("flags an experimental descriptor with a dim (experimental) tag", () => {
    const suffix = experimentalLabelSuffix(true);
    expect(suffix).toContain("(experimental)");
    // Rendered as a suffix — leads with a space so it appends cleanly.
    expect(suffix.startsWith(" ")).toBe(true);
  });

  test("returns an empty string for non-experimental descriptors", () => {
    expect(experimentalLabelSuffix(false)).toBe("");
    expect(experimentalLabelSuffix(undefined)).toBe("");
  });

  test("only the strict boolean true opts in (UnionDescriptor carries unknown)", () => {
    // Guards against a truthy-but-not-true value (e.g. a stray string) being
    // treated as experimental when the union descriptor's field is unknown.
    expect(experimentalLabelSuffix("true")).toBe("");
    expect(experimentalLabelSuffix(1)).toBe("");
    expect(experimentalLabelSuffix(null)).toBe("");
  });
});

describe("memberConfigForDescriptor", () => {
  /** A form field, named and scoped — the rest is what a form needs to render it. */
  const param = (name: string, scope: "source" | "member") =>
    ({ name, scope, label: name, type: "string" }) as const;

  test("routes a host-local value into member config and leaves the shared one alone", () => {
    expect(
      memberConfigForDescriptor(
        {
          params: [param("label", "source"), param("vaultPath", "member")],
          memberScopedParamNames: ["vaultPath"],
        },
        { label: "research", vaultPath: "/srv/vault" },
      ),
    ).toEqual({ params: { vaultPath: "/srv/vault" } });
  });

  test("an advanced host-local setting still reaches member config", () => {
    // The form's parameter list omits advanced settings, so it cannot be the
    // key: a value for one would otherwise land in the shared config, which
    // the gateway then refuses to store.
    expect(
      memberConfigForDescriptor(
        {
          params: [param("label", "source")],
          memberScopedParamNames: ["overrideDir"],
        },
        { label: "research", overrideDir: "/srv/override" },
      ),
    ).toEqual({ params: { overrideDir: "/srv/override" } });
  });

  test("a descriptor from an older gateway falls back to what its form declares", () => {
    expect(
      memberConfigForDescriptor(
        { params: [param("vaultPath", "member")] },
        { vaultPath: "/srv/vault" },
      ),
    ).toEqual({ params: { vaultPath: "/srv/vault" } });
  });

  test("no host-local value supplied means no member config at all", () => {
    expect(
      memberConfigForDescriptor(
        {
          params: [param("label", "source")],
          memberScopedParamNames: ["vaultPath"],
        },
        { label: "research" },
      ),
    ).toBeUndefined();
  });
});
