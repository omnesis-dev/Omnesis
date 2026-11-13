// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  chmod,
  stat,
  writeFile,
  symlink,
  link,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import { loadAccountEnrollmentAuthority } from "./account-authority-key.js";

const origin = "https://relay.example.test";
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return { ...filesystem, link: vi.fn(filesystem.link), open: vi.fn(filesystem.open) };
});
test("concurrent relay starts publish one stable private account attestation key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-account-authority-")),
    path = join(directory, "private", "authority.pem");
  try {
    const authorities = await Promise.all(
      Array.from({ length: 8 }, () => loadAccountEnrollmentAuthority(origin, path)),
    );
    expect(new Set(authorities.map((authority) => authority.kid)).size).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, "private"))).toEqual(["authority.pem"]);
    const material = await readFile(path);
    expect((await loadAccountEnrollmentAuthority(origin, path)).kid).toBe(authorities[0]!.kid);
    expect(await readFile(path)).toEqual(material);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication failures clean private temporary material and files that grow after stat remain bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-account-authority-")),
    path = join(directory, "authority.pem");
  try {
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error("synthetic filesystem failure"), { code: "EIO" }),
    );
    await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow(
      "filesystem failure",
    );
    expect(await readdir(directory)).toEqual([]);
    await writeFile(path, "x".repeat(16_385), { mode: 0o600 });
    const reader = await open(path, "r");
    const beforeGrowth = await reader.stat();
    beforeGrowth.size = 0;
    vi.spyOn(reader, "stat").mockResolvedValue(beforeGrowth);
    vi.mocked(open).mockResolvedValueOnce(reader);
    await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow("too large");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsafe permissions, symlinks, oversized material and other key algorithms are rejected without replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-account-authority-")),
    path = join(directory, "authority.pem");
  try {
    await loadAccountEnrollmentAuthority(origin, path);
    const original = await readFile(path);
    await chmod(path, 0o644);
    await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow(
      "private regular file",
    );
    await chmod(path, 0o600);
    const alias = join(directory, "alias.pem");
    await symlink(path, alias);
    await expect(loadAccountEnrollmentAuthority(origin, alias)).rejects.toThrow();
    expect(await readFile(path)).toEqual(original);
    await writeFile(path, "x".repeat(16_385));
    await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow(
      "private regular file",
    );
    await writeFile(
      path,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    );
    await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow("Ed25519");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
