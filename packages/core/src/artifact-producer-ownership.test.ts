// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { mkdtemp, readdir, rename, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  linkSync: vi.fn((await original<typeof import("node:fs")>()).linkSync),
}));
import { ensureInstallRootKey } from "./secret-store.js";
import { produceEncryptedArtifact } from "./artifact-producer.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-producer-owner-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const options = () => ({
  configDir: dir,
  backend: "file" as const,
  scope: "restore:ownership-fixture",
});
test("refuses a replaced ciphertext scratch and retains the replacement", async () => {
  await ensureInstallRootKey(options());
  const path = join(dir, "output.enc");
  let scratch!: string;
  await expect(
    produceEncryptedArtifact(path, options(), async (body) => {
      body.write("invented-private-content");
      scratch = join(
        dir,
        (await readdir(dir)).find((name) => name.startsWith("output.enc.tmp-"))!,
      );
      await rename(scratch, join(dir, "old-owned-ciphertext"));
      await writeFile(scratch, "unrelated replacement", { mode: 0o600 });
    }),
  ).rejects.toThrow("ownership changed");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(scratch, "utf8")).toBe("unrelated replacement");
});
test("detects a pathname swap during hardlink publication and removes only the link it created", async () => {
  if (process.platform === "win32") return;
  await ensureInstallRootKey(options());
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let scratch!: string;
  vi.mocked(fs.linkSync).mockImplementationOnce((source, target) => {
    scratch = String(source);
    actual.renameSync(source, join(dir, "owned-ciphertext-before-swap"));
    actual.writeFileSync(source, "different file", { mode: 0o600 });
    actual.linkSync(source, target);
  });
  const path = join(dir, "output.enc");
  await expect(
    produceEncryptedArtifact(path, options(), async (body) => {
      body.write("invented-private-content");
    }),
  ).rejects.toThrow("publication ownership changed");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(scratch, "utf8")).toBe("different file");
});
