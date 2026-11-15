// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openSqliteSnapshot, SqliteSnapshotChangedError } from "./sqlite-snapshot.js";
import { ensurePrivateDirSync } from "./security-files.js";
import { copyWindowsPrivateFileSync } from "./windows-private-file.js";

vi.mock("./security-files.js", async (original) => {
  const actual = await original<typeof import("./security-files.js")>();
  return { ...actual, ensurePrivateDirSync: vi.fn(actual.ensurePrivateDirSync) };
});
vi.mock("./windows-private-file.js", async (original) => {
  const actual = await original<typeof import("./windows-private-file.js")>();
  return { ...actual, copyWindowsPrivateFileSync: vi.fn(actual.copyWindowsPrivateFileSync) };
});

const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", nativePlatform);
  vi.mocked(ensurePrivateDirSync).mockReset();
  vi.mocked(copyWindowsPrivateFileSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([false, true])(
  "native changed-source failures retry the complete snapshot (persistent=%s)",
  (persistent) => {
    const root = mkdtempSync(join(tmpdir(), "snapshot-native-retry-"));
    roots.push(root);
    const source = join(root, "History");
    writeFileSync(source, "invented source bytes");
    Object.defineProperty(process, "platform", { ...nativePlatform, value: "win32" });
    // Only native protection/copy boundaries are substituted; real file
    // fingerprints, owned scratch lifetime and retry control remain in use.
    vi.mocked(ensurePrivateDirSync).mockImplementation(() => {});
    let attempts = 0;
    const copy = vi.mocked(copyWindowsPrivateFileSync).mockImplementation((from, to) => {
      attempts++;
      if (persistent || attempts < 3)
        throw Object.assign(new Error("source changed"), {
          code: "EPRIVATE",
          stage: "copy-source-changed",
        });
      copyFileSync(from, to);
    });
    if (persistent) expect(() => openSqliteSnapshot(source)).toThrow(SqliteSnapshotChangedError);
    else {
      const snapshot = openSqliteSnapshot(source);
      try {
        expect(readFileSync(snapshot.path, "utf8")).toBe("invented source bytes");
      } finally {
        snapshot.cleanup();
      }
    }
    expect(copy).toHaveBeenCalledTimes(3);
    expect(readFileSync(source, "utf8")).toBe("invented source bytes");
  },
);

test.each(
  ["ENOENT", "copy-source-changed"].flatMap((reason) =>
    [false, true].flatMap((nested) =>
      [undefined, new Error("Invented copy join failure")].map((cleanupFailure) => ({
        reason,
        nested,
        cleanupFailure,
      })),
    ),
  ),
)("an unjoined $reason copy retains scratch and forbids retry ($nested)", (shape) => {
  const root = mkdtempSync(join(tmpdir(), "snapshot-native-uncertain-"));
  roots.push(root);
  const source = join(root, "History");
  writeFileSync(source, "invented source bytes");
  Object.defineProperty(process, "platform", { ...nativePlatform, value: "win32" });
  vi.mocked(ensurePrivateDirSync).mockImplementation(() => {});
  const marker = { cleanupFailure: shape.cleanupFailure };
  const failure = Object.assign(
    new Error("Invented copy refusal", shape.nested ? { cause: marker } : undefined),
    {
      ...(shape.reason === "ENOENT"
        ? { code: "ENOENT" }
        : { code: "EPRIVATE", stage: shape.reason }),
      ...(shape.nested ? {} : marker),
    },
  );
  let destination = "";
  const copy = vi.mocked(copyWindowsPrivateFileSync).mockImplementation((_from, to) => {
    destination = to;
    roots.push(dirname(to));
    writeFileSync(to, "invented unpublished copy");
    throw failure;
  });
  let observed: unknown;
  try {
    openSqliteSnapshot(source);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect(copy).toHaveBeenCalledOnce();
  expect(existsSync(destination)).toBe(true);
  expect(readFileSync(destination, "utf8")).toBe("invented unpublished copy");
  expect(readFileSync(source, "utf8")).toBe("invented source bytes");
});
