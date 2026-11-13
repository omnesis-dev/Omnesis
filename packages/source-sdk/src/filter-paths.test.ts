// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { collectFilterList } from "./filter-lists.js";
import { directoryFilterId, directoryFilterList, normalizeDirectoryPath } from "./filter-paths.js";

const signal = new AbortController().signal;

/** The list as `id → [label, parent]`, after the checks every published list goes through. */
async function tree(
  directories: unknown[],
  layout: Parameters<typeof directoryFilterList>[1],
): Promise<Record<string, [string, string | null]>> {
  const items = await collectFilterList(() => directoryFilterList(directories, layout), { signal });
  return Object.fromEntries(items.map((item) => [item.id, [item.label, item.parentId ?? null]]));
}

describe("normalizeDirectoryPath", () => {
  test.each([
    ["/home/maya/work/atlas-api", "/home/maya/work/atlas-api"],
    ["/home/maya/work/atlas-api/", "/home/maya/work/atlas-api"],
    ["/home/maya//work/./atlas-api/../atlas-api", "/home/maya/work/atlas-api"],
    ["/", "/"],
    ["//srv///builds/", "/srv/builds"],
    // macOS hands back decomposed names; both spellings are one directory.
    ["/home/maya/cafe\u0301", "/home/maya/caf\u00e9"],
    ["C:\\Users\\maya\\work\\atlas-api", "C:/Users/maya/work/atlas-api"],
    ["c:\\Users\\maya\\work\\", "C:/Users/maya/work"],
    ["C:/Users/maya/../maya/work", "C:/Users/maya/work"],
    ["C:\\", "C:/"],
  ])("spells %s as %s", (path, normal) => {
    expect(normalizeDirectoryPath(path)).toBe(normal);
  });

  test.each([
    ["a relative path", "work/atlas-api"],
    ["a home-relative path", "~/work/atlas-api"],
    ["an empty string", ""],
    ["a network share", "\\\\fileserver\\share\\work"],
    ["a drive with no directory", "C:"],
    ["a path holding a NUL", "/home/maya/\0work"],
    ["a path too long to be an id", `/${"a".repeat(600)}`],
    ["a missing value", undefined],
    ["a null", null],
    ["a number", 42],
  ])("names no directory for %s", (_what, path) => {
    expect(normalizeDirectoryPath(path)).toBeNull();
    expect(directoryFilterId(path)).toBeNull();
  });
});

describe("directoryFilterId", () => {
  test("keeps case where the file system tells two cases apart", () => {
    expect(directoryFilterId("/home/maya/Work", { caseSensitive: true })).toBe("/home/maya/Work");
  });

  test("is one id for two spellings where the file system does not", () => {
    expect(directoryFilterId("/Users/maya/Work/", { caseSensitive: false })).toBe(
      directoryFilterId("/users/maya/work", { caseSensitive: false }),
    );
  });

  test("never tells two cases apart on a drive path", () => {
    expect(directoryFilterId("C:\\Users\\Maya", { caseSensitive: true })).toBe("c:/users/maya");
  });
});

describe("directoryFilterList without configured roots", () => {
  const layout = { home: "/home/maya", caseSensitive: true };

  test("a directory inside the home directory hangs from the home directory", async () => {
    expect(await tree(["/home/maya/work/atlas-api"], layout)).toEqual({
      "/home/maya": ["~", null],
      "/home/maya/work": ["~/work", "/home/maya"],
      "/home/maya/work/atlas-api": ["~/work/atlas-api", "/home/maya/work"],
    });
  });

  test("a directory outside it hangs from its first path segment", async () => {
    expect(await tree(["/srv/builds/atlas"], layout)).toEqual({
      "/srv": ["/srv", null],
      "/srv/builds": ["/srv/builds", "/srv"],
      "/srv/builds/atlas": ["/srv/builds/atlas", "/srv/builds"],
    });
  });

  test("the home directory itself and the top of the file system are single entries", async () => {
    expect(await tree(["/home/maya"], layout)).toEqual({ "/home/maya": ["~", null] });
    expect(await tree(["/"], layout)).toEqual({ "/": ["/", null] });
  });

  test("a sibling whose name starts the same is not inside", async () => {
    const listed = await tree(["/srv/work/atlas-api", "/srv/workshop/bench"], layout);
    expect(listed["/srv/workshop"]).toEqual(["/srv/workshop", "/srv"]);
    expect(listed["/srv/workshop/bench"]).toEqual(["/srv/workshop/bench", "/srv/workshop"]);
    // Nothing under /srv/work is an ancestor of anything under /srv/workshop.
    const ancestors = (id: string): string[] => {
      const parent = listed[id]?.[1];
      return parent ? [parent, ...ancestors(parent)] : [];
    };
    expect(ancestors("/srv/workshop/bench")).toEqual(["/srv/workshop", "/srv"]);
  });

  test("a listed directory above the home directory is above it in the tree too", async () => {
    // A session started in /home: everything under it by path sits under it
    // in the tree, the home directory included.
    expect(await tree(["/home/maya/work", "/home"], layout)).toEqual({
      "/home": ["/home", null],
      "/home/maya": ["~", "/home"],
      "/home/maya/work": ["~/work", "/home/maya"],
    });
    expect(await tree(["/srv/builds", "/home/maya/work", "/"], layout)).toEqual({
      "/": ["/", null],
      "/srv": ["/srv", "/"],
      "/srv/builds": ["/srv/builds", "/srv"],
      "/home": ["/home", "/"],
      "/home/maya": ["~", "/home"],
      "/home/maya/work": ["~/work", "/home/maya"],
    });
  });

  test("lists each directory once, whatever spelling and order it arrives in", async () => {
    const forwards = await tree(["/srv/work/", "/srv//work", "/srv/work/api"], layout);
    const backwards = await tree(["/srv/work/api", "/srv//work", "/srv/work/"], layout);
    expect(forwards).toEqual(backwards);
    expect(Object.keys(forwards).sort()).toEqual(["/srv", "/srv/work", "/srv/work/api"]);
  });

  test("leaves out what names no directory", async () => {
    expect(await tree(["work", undefined, "", "~/work"], layout)).toEqual({});
  });

  test("on a file system that ignores case, two spellings are one folder", async () => {
    const listed = await tree(["/Users/maya/Work/Atlas", "/Users/maya/work/atlas"], {
      home: "/Users/maya",
      caseSensitive: false,
    });
    expect(listed).toEqual({
      "/users/maya": ["~", null],
      "/users/maya/work": ["~/Work", "/users/maya"],
      "/users/maya/work/atlas": ["~/Work/Atlas", "/users/maya/work"],
    });
  });

  test("drive paths hang from the first folder of their drive", async () => {
    expect(
      await tree(["C:\\Users\\maya\\work", "D:\\builds"], { home: "C:\\Users\\maya" }),
    ).toEqual({
      "c:/users/maya": ["~", null],
      "c:/users/maya/work": ["~/work", "c:/users/maya"],
      "d:/builds": ["D:/builds", null],
    });
  });

  test("costs one entry per directory and level, however many are given twice", async () => {
    const directories = Array.from({ length: 5000 }, (_, index) => `/srv/work/p${index % 50}`);
    expect(Object.keys(await tree(directories, layout))).toHaveLength(52);
  });
});

describe("directoryFilterList under configured roots", () => {
  const layout = {
    home: "/home/maya",
    roots: ["/home/maya/Documents", "/mnt/archive"],
    caseSensitive: true,
  };

  test("lists every root, even with nothing known inside it", async () => {
    expect(await tree([], layout)).toEqual({
      "/home/maya/Documents": ["~/Documents", null],
      "/mnt/archive": ["/mnt/archive", null],
    });
  });

  test("a directory hangs from the root that holds it, and no higher", async () => {
    expect(
      await tree(["/home/maya/Documents/work/atlas-api", "/mnt/archive/2024"], layout),
    ).toEqual({
      "/home/maya/Documents": ["~/Documents", null],
      "/home/maya/Documents/work": ["~/Documents/work", "/home/maya/Documents"],
      "/home/maya/Documents/work/atlas-api": [
        "~/Documents/work/atlas-api",
        "/home/maya/Documents/work",
      ],
      "/mnt/archive": ["/mnt/archive", null],
      "/mnt/archive/2024": ["/mnt/archive/2024", "/mnt/archive"],
    });
  });

  test("a root inside another root sits under it", async () => {
    expect(
      await tree([], { ...layout, roots: ["/home/maya/Documents", "/home/maya/Documents/a/b"] }),
    ).toEqual({
      "/home/maya/Documents": ["~/Documents", null],
      "/home/maya/Documents/a": ["~/Documents/a", "/home/maya/Documents"],
      "/home/maya/Documents/a/b": ["~/Documents/a/b", "/home/maya/Documents/a"],
    });
  });

  test("a directory outside every root stands alone", async () => {
    expect(await tree(["/opt/elsewhere/deep"], layout)).toMatchObject({
      "/opt/elsewhere/deep": ["/opt/elsewhere/deep", null],
    });
  });
});
