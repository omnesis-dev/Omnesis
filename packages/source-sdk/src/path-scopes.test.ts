// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  MAX_PATH_SCOPE_DEPTH,
  normalizeDirectoryPath,
  pathScopeFolders,
  pathScopeLayoutKey,
  sharedWorkingDirectory,
} from "./path-scopes.js";
import type { PathScopeLayout } from "./path-scopes.js";

const HOME: PathScopeLayout = { home: "/home/maya", caseSensitive: true };
const labels = (directory: unknown, layout: PathScopeLayout = HOME) =>
  pathScopeFolders(directory, layout)?.map((folder) => folder.label) ?? null;
const ids = (directory: unknown, layout: PathScopeLayout = HOME) =>
  pathScopeFolders(directory, layout)?.map((folder) => folder.id) ?? null;

describe("normalizeDirectoryPath", () => {
  test("reads one spelling out of trailing slashes, repeated slashes and dot segments", () => {
    for (const spelling of [
      "/home/maya/work/atlas-api",
      "/home/maya/work/atlas-api/",
      "/home/maya//work/./atlas-api",
      "/home/maya/personal/../work/atlas-api/.",
      "//home/maya/work/atlas-api///",
    ])
      expect(normalizeDirectoryPath(spelling)).toBe("/home/maya/work/atlas-api");
    expect(normalizeDirectoryPath("/")).toBe("/");
    expect(normalizeDirectoryPath("/..")).toBe("/");
    expect(normalizeDirectoryPath("/work/../..")).toBe("/");
  });

  test("composes a name written with combining marks", () => {
    expect(normalizeDirectoryPath("/srv/cafe\u0301")).toBe("/srv/caf\u00e9");
  });

  test("refuses anything that is not an absolute POSIX path", () => {
    for (const value of [
      "",
      "work/atlas-api",
      "./work",
      "~/work",
      "C:\\Users\\maya\\work",
      "\\\\server\\share",
      "/srv/a\0b",
      `/${"a".repeat(5000)}`,
      undefined,
      null,
      42,
      ["/srv"],
    ])
      expect(normalizeDirectoryPath(value)).toBeNull();
  });
});

describe("pathScopeFolders without configured roots", () => {
  test("a directory inside the home directory is itself and each ancestor up to ~", () => {
    expect(labels("/home/maya/work/atlas-api")).toEqual(["~/work/atlas-api", "~/work", "~"]);
    const folders = pathScopeFolders("/home/maya/work/atlas-api", HOME)!;
    expect(folders[0]!.parentId).toBe(folders[1]!.id);
    expect(folders[1]!.parentId).toBe(folders[2]!.id);
    expect(folders[2]!.parentId).toBeUndefined();
  });

  test("the home directory is the top folder, and nothing above it is named", () => {
    expect(labels("/home/maya")).toEqual(["~"]);
    expect(labels("/home/maya/")).toEqual(["~"]);
  });

  test("a directory outside the home directory hangs from its first segment, never from /", () => {
    expect(labels("/srv/work/atlas-api")).toEqual(["/srv/work/atlas-api", "/srv/work", "/srv"]);
    expect(labels("/home/jamie/work")).toEqual(["/home/jamie/work", "/home/jamie", "/home"]);
    expect(labels("/home")).toEqual(["/home"]);
    expect(labels("/")).toEqual(["/"]);
  });

  test("a sibling whose name only starts with the home directory's is not inside it", () => {
    expect(labels("/home/maya-archive/work")).toEqual([
      "/home/maya-archive/work",
      "/home/maya-archive",
      "/home",
    ]);
  });

  test("/work is not an ancestor of /workshop", () => {
    const work = ids("/srv/work")!;
    const workshop = ids("/srv/workshop/bench")!;
    expect(workshop).not.toContain(work[0]);
    expect(ids("/srv/work/atlas-api")).toContain(work[0]);
    expect(ids("/home/maya/workshop")).not.toContain(ids("/home/maya/work")![0]);
  });

  test("every spelling of a directory has the same folders", () => {
    const expected = pathScopeFolders("/home/maya/work/atlas-api", HOME);
    for (const spelling of [
      "/home/maya/work/atlas-api/",
      "/home/maya/./work//atlas-api",
      "/home/maya/personal/../work/atlas-api",
    ])
      expect(pathScopeFolders(spelling, HOME)).toEqual(expected);
  });

  test("ids are stable, opaque and distinct for distinct folders", () => {
    const first = ids("/home/maya/work/atlas-api")!;
    expect(ids("/home/maya/work/atlas-api")).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    for (const id of first) {
      expect(id).toMatch(/^dir:[A-Za-z0-9_-]{43}$/);
      expect(id).not.toContain("maya");
    }
    // A segment boundary is part of the identity: a/b + c is not a + b/c.
    expect(ids("/srv/a/b")![0]).not.toBe(ids("/srv/a,b")![0]);
    expect(ids('/srv/a","b')![0]).not.toBe(ids("/srv/a/b")![0]);
  });

  test("two homes in different places name one folder, so one filter covers both devices", () => {
    const laptop = pathScopeFolders("/Users/maya/work/atlas-api", {
      home: "/Users/maya",
      caseSensitive: true,
    });
    expect(laptop).toEqual(pathScopeFolders("/home/maya/work/atlas-api", HOME));
  });

  test("another account's home, read from this device, is not this device's ~", () => {
    const here = ids("/home/maya/work")!;
    const there = ids("/home/maya/work", { home: "/root", caseSensitive: true })!;
    expect(labels("/home/maya/work", { home: "/root" })).toEqual([
      "/home/maya/work",
      "/home/maya",
      "/home",
    ]);
    expect(there).not.toContain(here[0]);
  });

  test("a home of / or no home at all names every directory by its absolute path", () => {
    expect(labels("/srv/work", { home: "/" })).toEqual(["/srv/work", "/srv"]);
    expect(labels("/home/maya/work", {})).toEqual(["/home/maya/work", "/home/maya", "/home"]);
  });

  test("names differing only by case are one folder where the platform says so, two otherwise", () => {
    const folded: PathScopeLayout = { home: "/Users/maya", caseSensitive: false };
    const exact: PathScopeLayout = { home: "/Users/maya", caseSensitive: true };
    expect(ids("/Users/maya/Work/Atlas", folded)).toEqual(ids("/users/MAYA/work/atlas", folded));
    expect(labels("/Users/maya/Work/Atlas", folded)).toEqual(["~/Work/Atlas", "~/Work", "~"]);
    expect(ids("/Users/maya/Work", exact)![0]).not.toBe(ids("/Users/maya/work", exact)![0]);
    // Under exact case a differently cased home is some other directory.
    expect(labels("/users/maya/work", exact)).toEqual([
      "/users/maya/work",
      "/users/maya",
      "/users",
    ]);
    // A folded name on one device is the same folder as its lower-case
    // spelling on a device that keeps case.
    expect(ids("/Users/maya/Work", folded)![0]).toBe(ids("/Users/maya/work", exact)![0]);
  });

  test("a directory deeper than the gateway follows has no folder", () => {
    const deep = (levels: number) =>
      `/srv/${Array.from({ length: levels }, (_, index) => `d${index}`).join("/")}`;
    expect(pathScopeFolders(deep(MAX_PATH_SCOPE_DEPTH - 1), HOME)).toHaveLength(
      MAX_PATH_SCOPE_DEPTH,
    );
    expect(pathScopeFolders(deep(MAX_PATH_SCOPE_DEPTH), HOME)).toBeNull();
  });

  test("a path too long for a label keeps its end, and its identity", () => {
    const long = `/srv/${"n".repeat(300)}/${"m".repeat(300)}`;
    const [folder] = pathScopeFolders(long, HOME)!;
    expect(folder!.label).toHaveLength(512);
    expect(folder!.label.startsWith("…")).toBe(true);
    expect(folder!.label.endsWith("m".repeat(300))).toBe(true);
    expect(folder!.id).not.toBe(pathScopeFolders(`${long}x`, HOME)![0]!.id);
  });

  test("what is not an absolute path has no folder", () => {
    for (const value of ["", "work", "~/work", "C:\\work", undefined, null])
      expect(pathScopeFolders(value, HOME)).toBeNull();
  });
});

describe("pathScopeFolders under configured roots", () => {
  const layout: PathScopeLayout = {
    home: "/home/maya",
    roots: ["/home/maya/Documents", "/srv/share"],
    caseSensitive: true,
  };

  test("a directory is itself and each ancestor up to the root that holds it", () => {
    expect(labels("/home/maya/Documents/work/atlas", layout)).toEqual([
      "~/Documents/work/atlas",
      "~/Documents/work",
      "~/Documents",
    ]);
    expect(labels("/srv/share/personal", layout)).toEqual(["/srv/share/personal", "/srv/share"]);
  });

  test("the root is the top folder: a file directly in it is in the root alone", () => {
    const folders = pathScopeFolders("/home/maya/Documents/", layout)!;
    expect(folders.map((folder) => folder.label)).toEqual(["~/Documents"]);
    expect(folders[0]!.parentId).toBeUndefined();
  });

  test("a directory outside every root has no folder", () => {
    expect(pathScopeFolders("/home/maya/Downloads", layout)).toBeNull();
    expect(pathScopeFolders("/home/maya", layout)).toBeNull();
    expect(pathScopeFolders("/home/maya/Documents-old/work", layout)).toBeNull();
    expect(pathScopeFolders("/srv/shared", layout)).toBeNull();
  });

  test("a root nested in another is a folder of the outer one, whatever order they are listed in", () => {
    const nested = (roots: string[]) =>
      pathScopeFolders("/home/maya/Documents/work/atlas", { ...layout, roots });
    const outerFirst = nested(["/home/maya/Documents", "/home/maya/Documents/work"]);
    expect(outerFirst!.map((folder) => folder.label)).toEqual([
      "~/Documents/work/atlas",
      "~/Documents/work",
      "~/Documents",
    ]);
    expect(nested(["/home/maya/Documents/work", "/home/maya/Documents"])).toEqual(outerFirst);
    expect(outerFirst).toEqual(nested(["/home/maya/Documents"]));
  });

  test("a folder keeps its id when the roots change, and only its place in the tree moves", () => {
    const underDocuments = pathScopeFolders("/home/maya/Documents/work", layout)!;
    const asRoot = pathScopeFolders("/home/maya/Documents/work", {
      ...layout,
      roots: ["/home/maya/Documents/work"],
    })!;
    expect(asRoot.map((folder) => folder.label)).toEqual(["~/Documents/work"]);
    expect(asRoot[0]!.id).toBe(underDocuments[0]!.id);
    expect(asRoot[0]!.parentId).toBeUndefined();
    expect(underDocuments[0]!.parentId).toBe(underDocuments[1]!.id);
    // A root added above the old one: the old root and everything in it keep
    // their ids, so a filter saved on any of them still names it.
    const underHome = pathScopeFolders("/home/maya/Documents/work", {
      ...layout,
      roots: ["/home/maya", "/home/maya/Documents"],
    })!;
    expect(underHome.map((folder) => folder.label)).toEqual([
      "~/Documents/work",
      "~/Documents",
      "~",
    ]);
    expect(underHome.slice(0, 2).map((folder) => folder.id)).toEqual(
      underDocuments.map((folder) => folder.id),
    );
    expect(underHome[1]!.parentId).toBe(underHome[2]!.id);
    // With no roots at all the same directory is the same folder again.
    expect(pathScopeFolders("/home/maya/Documents/work", { home: layout.home })![0]!.id).toBe(
      underDocuments[0]!.id,
    );
  });

  test("the same root under two homes is one tree", () => {
    expect(
      pathScopeFolders("/Users/maya/Documents/work", {
        home: "/Users/maya",
        roots: ["/Users/maya/Documents/"],
        caseSensitive: true,
      }),
    ).toEqual(pathScopeFolders("/home/maya/Documents/work", layout));
  });

  test("a root of / names its folders by their absolute path", () => {
    expect(labels("/srv/work", { roots: ["/"] })).toEqual(["/srv/work", "/srv", "/"]);
  });

  test("a root that is not an absolute path holds nothing", () => {
    expect(pathScopeFolders("/srv/work", { roots: ["srv", ""] })).toBeNull();
  });

  test("with no roots configured nothing has a folder", () => {
    expect(pathScopeFolders("/srv/work", { roots: [] })).toBeNull();
  });
});

describe("pathScopeLayoutKey", () => {
  test("is the same for the same layout however it is spelled", () => {
    expect(
      pathScopeLayoutKey({ home: "/home/maya/", roots: ["/b", "/a/"], caseSensitive: true }),
    ).toBe(
      pathScopeLayoutKey({ home: "/home/maya", roots: ["/a", "/b", "/a"], caseSensitive: true }),
    );
  });

  test("changes with anything that renames or re-parents a folder", () => {
    const base: PathScopeLayout = { home: "/home/maya", roots: ["/a"], caseSensitive: true };
    const key = pathScopeLayoutKey(base);
    expect(pathScopeLayoutKey({ ...base, home: "/home/jamie" })).not.toBe(key);
    expect(pathScopeLayoutKey({ ...base, roots: ["/a", "/b"] })).not.toBe(key);
    expect(pathScopeLayoutKey({ ...base, roots: undefined })).not.toBe(key);
    expect(pathScopeLayoutKey({ ...base, caseSensitive: false })).not.toBe(key);
  });
});

describe("sharedWorkingDirectory", () => {
  test("one directory is that directory, however often and however it is spelled", () => {
    expect(sharedWorkingDirectory(["/home/maya/work/atlas-api"])).toBe("/home/maya/work/atlas-api");
    expect(
      sharedWorkingDirectory([
        "/home/maya/work/atlas-api",
        "/home/maya/work/atlas-api/",
        "/home/maya/work/./atlas-api",
      ]),
    ).toBe("/home/maya/work/atlas-api");
  });

  test("stepping into subdirectories keeps the work where it started", () => {
    expect(
      sharedWorkingDirectory([
        "/home/maya/work/atlas-api",
        "/home/maya/work/atlas-api/packages/core",
        "/home/maya/work/atlas-api/docs",
      ]),
    ).toBe("/home/maya/work/atlas-api");
  });

  test("stepping up files the work under the parent it reached", () => {
    expect(
      sharedWorkingDirectory(["/home/maya/work/atlas-api/docs", "/home/maya/work/atlas-api"]),
    ).toBe("/home/maya/work/atlas-api");
  });

  test("two unrelated directories have no single one, even with a common parent nobody worked in", () => {
    expect(
      sharedWorkingDirectory(["/home/maya/work/atlas-api", "/home/maya/personal/garden-notes"]),
    ).toBeNull();
    expect(sharedWorkingDirectory(["/srv/work", "/srv/workshop"])).toBeNull();
    expect(sharedWorkingDirectory(["/srv/a", "/tmp/b"])).toBeNull();
  });

  test("the common parent counts once work was done in it", () => {
    expect(
      sharedWorkingDirectory([
        "/home/maya/work/atlas-api",
        "/home/maya/work/billing",
        "/home/maya/work",
      ]),
    ).toBe("/home/maya/work");
    expect(sharedWorkingDirectory(["/srv/a", "/tmp/b", "/"])).toBe("/");
  });

  test("nothing recorded, or anything that is not an absolute path, is unknown", () => {
    expect(sharedWorkingDirectory([])).toBeNull();
    expect(sharedWorkingDirectory(["work/atlas-api"])).toBeNull();
    expect(sharedWorkingDirectory(["/home/maya/work", "C:\\work"])).toBeNull();
    expect(sharedWorkingDirectory(["/home/maya/work", undefined])).toBeNull();
  });
});
