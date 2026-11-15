// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const { readKey } = vi.hoisted(() => ({ readKey: vi.fn() }));
vi.mock("@omnesis/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/core")>()),
  readStorageKeySync: readKey,
}));
import apple from "./index.js";
const probe = async (root: string) => {
  const definition = apple.sources.find((source) => source.id === "apple-imessage")!;
  const source = await definition.create(
    {
      sourceId: "apple-imessage:fixture",
      providerId: "apple:fixture",
      host: { configDir: root },
    } as never,
    { provider: { hasIMessage: false, imessageDbFilePath: join(root, "missing.db") } } as never,
  );
  try {
    return (await source.probeLocalStores!({ signal: new AbortController().signal }))[0];
  } finally {
    await source.dispose?.();
  }
};
let root: string;
beforeEach(() => {
  readKey.mockReset();
  root = mkdtempSync(join(tmpdir(), "provider-doctor-key-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each([false, true])(
  "explicit key-read cleanup uncertainty is not projected as a locked store (nested:%s)",
  async (nested) => {
    const cause = Object.assign(new Error("invented key operation"), { cleanupFailure: undefined });
    const marker = nested ? new Error("invented wrapped key operation", { cause }) : cause;
    readKey.mockImplementation(() => {
      throw marker;
    });
    await expect(probe(root)).rejects.toBe(marker);
    expect(readKey).toHaveBeenCalledOnce();
  },
);

test("ordinary joined key-read failure remains a locked-store result", async () => {
  readKey.mockImplementation(() => {
    throw Object.assign(new Error("invented unavailable key"), { code: "EACCES" });
  });
  await expect(probe(root)).resolves.toMatchObject({ state: "locked" });
  expect(readKey).toHaveBeenCalledOnce();
});
