// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  canDenyFixtureReads,
  canDenyFixtureDirectoryWrites,
  probeFixtureDirectoryWriteDenial,
  probeFixtureReadDenial,
  setFixtureMode,
  setFixtureDirectoryWritable,
} from "./file-permissions.js";

test.skipIf(!canDenyFixtureReads)(
  "owned fixtures stage actual file and directory read denial and restore it",
  () => {
    const root = mkdtempSync(join(tmpdir(), "owned-permission-fixture-"));
    const file = join(root, "note.txt");
    const directory = join(root, "folder");
    mkdirSync(directory);
    writeFileSync(file, "Invented private fixture");
    try {
      setFixtureMode(file, 0o000);
      expect(() => readFileSync(file)).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM)$/u) }),
      );
      setFixtureMode(file, 0o600);
      expect(readFileSync(file, "utf8")).toBe("Invented private fixture");
      setFixtureMode(directory, 0o000);
      expect(() => readdirSync(directory)).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM)$/u) }),
      );
      setFixtureMode(directory, 0o700);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      setFixtureMode(file, 0o600);
      setFixtureMode(directory, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["EACCES", "EPERM"])(
  "capability probe recognizes %s and restores its owned file",
  (code) => {
    let ownedFile = "";
    const modes: number[] = [];
    expect(
      probeFixtureReadDenial(
        () => {
          throw Object.assign(new Error("Owned denial"), { code });
        },
        (path, mode) => {
          ownedFile = path;
          modes.push(mode);
        },
      ),
    ).toBe(true);
    expect(modes).toEqual([0o000, 0o600]);
    expect(existsSync(ownedFile)).toBe(false);
  },
);

test("capability probe reports a successful read and removes the restored fixture", () => {
  let ownedFile = "";
  expect(
    probeFixtureReadDenial(readFileSync, (path) => {
      ownedFile = path;
    }),
  ).toBe(false);
  expect(existsSync(ownedFile)).toBe(false);
});

test.each(["setup", "read", "restore"])(
  "capability probe surfaces unexpected %s failures and cleans up",
  (stage) => {
    let ownedFile = "";
    const failure = new Error(`Invented ${stage} failure`);
    const modes: number[] = [];
    expect(() =>
      probeFixtureReadDenial(
        () => {
          if (stage === "read") throw failure;
        },
        (path, mode) => {
          ownedFile = path;
          modes.push(mode);
          if ((stage === "setup" && mode === 0o000) || (stage === "restore" && mode === 0o600))
            throw failure;
        },
      ),
    ).toThrow(failure);
    expect(modes).toEqual([0o000, 0o600]);
    expect(existsSync(ownedFile)).toBe(false);
  },
);

test.skipIf(!canDenyFixtureDirectoryWrites())(
  "owned directories deny new children while retaining reads and recover publication",
  () => {
    const root = mkdtempSync(join(tmpdir(), "owned-write-denial-"));
    const original = join(root, "original.txt");
    const candidate = join(root, "candidate.txt");
    try {
      writeFileSync(original, "Invented retained fixture");
      setFixtureDirectoryWritable(root, false);
      expect(readFileSync(original, "utf8")).toBe("Invented retained fixture");
      expect(readdirSync(root)).toEqual(["original.txt"]);
      expect(() => writeFileSync(candidate, "New fixture", { flag: "wx" })).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM)$/u) }),
      );
      expect(existsSync(candidate)).toBe(false);
      setFixtureDirectoryWritable(root, true);
      writeFileSync(candidate, "New fixture", { flag: "wx" });
      expect(readFileSync(candidate, "utf8")).toBe("New fixture");
    } finally {
      setFixtureDirectoryWritable(root, true);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["EACCES", "EPERM"])(
  "directory capability probe recognizes %s, restores and removes its owned directory",
  (code) => {
    let root = "";
    const states: boolean[] = [];
    expect(
      probeFixtureDirectoryWriteDenial(
        () => {
          throw Object.assign(new Error("Invented directory denial"), { code });
        },
        (path, writable) => {
          root = path;
          states.push(writable);
        },
      ),
    ).toBe(true);
    expect(states).toEqual([false, true]);
    expect(existsSync(root)).toBe(false);
  },
);

test("directory capability probe reports a privileged successful write and restores its directory", () => {
  let root = "";
  const states: boolean[] = [];
  expect(
    probeFixtureDirectoryWriteDenial(
      (path) => writeFileSync(path, "Invented privileged write", { flag: "wx" }),
      (path, writable) => {
        root = path;
        states.push(writable);
      },
    ),
  ).toBe(false);
  expect(states).toEqual([false, true]);
  expect(existsSync(root)).toBe(false);
});

test.each(["setup", "write", "restore"])(
  "directory capability probe surfaces unexpected %s errors after restoring its directory",
  (stage) => {
    let root = "";
    const states: boolean[] = [];
    const failure = new Error(`Invented ${stage} failure`);
    expect(() =>
      probeFixtureDirectoryWriteDenial(
        () => {
          if (stage === "write") throw failure;
        },
        (path, writable) => {
          root = path;
          states.push(writable);
          if ((stage === "setup" && !writable) || (stage === "restore" && writable)) throw failure;
        },
      ),
    ).toThrow(failure);
    expect(states).toEqual([false, true]);
    expect(existsSync(root)).toBe(false);
  },
);
