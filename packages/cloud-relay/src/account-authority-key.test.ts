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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readWindowsPrivateFile, createWindowsPrivateFile } from "@omnesis/core";
import { loadAccountEnrollmentAuthority } from "./account-authority-key.js";

const origin = "https://relay.example.test";
vi.mock("@omnesis/core", async (original) => {
  const core = await original<typeof import("@omnesis/core")>();
  return {
    ...core,
    readWindowsPrivateFile: vi.fn(core.readWindowsPrivateFile),
    createWindowsPrivateFile: vi.fn(core.createWindowsPrivateFile),
  };
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
async function onPlatform<T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

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
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
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
    if (process.platform === "win32") {
      await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow(
        "private regular file",
      );
      return;
    }
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
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow(
        "private regular file",
      );
      await chmod(path, 0o600);
    }
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

test("Windows creation and reread use the protected boundary, while unsafe existing material never triggers creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-authority-boundary-")),
    path = join(directory, "authority.pem");
  const reader = vi.mocked(readWindowsPrivateFile),
    writer = vi.mocked(createWindowsPrivateFile);
  try {
    await onPlatform("win32", async () => {
      // Only the OS trust boundary is substituted; actual key generation,
      // no-clobber hard-link publication and subsequent key parsing execute.
      await reader.withImplementation(
        (path) => readFile(path),
        async () => {
          await writer.withImplementation(
            async (path, bytes) => {
              await writeFile(path, bytes, { mode: 0o600 });
            },
            async () => {
              const authority = await loadAccountEnrollmentAuthority(origin, path);
              expect(authority.kid).toBeTruthy();
              expect(writer).toHaveBeenCalledOnce();
              expect(await readdir(directory)).toEqual(["authority.pem"]);
              const before = await readFile(path);
              const failure = Object.assign(new Error("private access refused"), {
                code: "EPRIVATE",
              });
              reader.mockRejectedValueOnce(failure);
              await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toBe(failure);
              expect(writer).toHaveBeenCalledOnce();
              expect(await readFile(path)).toEqual(before);
            },
          );
        },
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([null, "invented read failure", {}, { code: "EACCES" }])(
  "non-missing read failures preserve existing authority material (%#)",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-authority-failure-")),
      path = join(directory, "authority.pem");
    try {
      await writeFile(path, "invented preserved bytes", { mode: 0o600 });
      await onPlatform("linux", async () => {
        vi.mocked(open).mockRejectedValueOnce(failure);
        await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toBe(failure);
      });
      expect(await readFile(path, "utf8")).toBe("invented preserved bytes");
      expect(await readdir(directory)).toEqual(["authority.pem"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["not-regular", "wrong-owner", "no-getuid"] as const)(
  "POSIX held reads enforce metadata and always close the descriptor (%s)",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-authority-metadata-")),
      path = join(directory, "authority.pem");
    const material = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    await writeFile(path, material, { mode: 0o600 });
    const reader = await open(path, "r"),
      metadata = await reader.stat();
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      metadata.mode = 0o100600;
      metadata.uid = 42;
      if (scenario === "not-regular") vi.spyOn(metadata, "isFile").mockReturnValue(false);
      Object.defineProperty(process, "getuid", {
        configurable: true,
        value: scenario === "no-getuid" ? undefined : () => 43,
      });
      vi.spyOn(reader, "stat").mockResolvedValue(metadata);
      vi.mocked(open).mockResolvedValueOnce(reader);
      await onPlatform("linux", async () => {
        if (scenario === "no-getuid")
          expect((await loadAccountEnrollmentAuthority(origin, path)).kid).toBeTruthy();
        else
          await expect(loadAccountEnrollmentAuthority(origin, path)).rejects.toThrow(
            "private regular file",
          );
      });
      await expect(reader.read(Buffer.alloc(1), 0, 1, 0)).rejects.toMatchObject({ code: "EBADF" });
      expect(await readFile(path, "utf8")).toBe(material);
    } finally {
      if (getuid) Object.defineProperty(process, "getuid", getuid);
      else Reflect.deleteProperty(process, "getuid");
      vi.mocked(reader.stat).mockRestore();
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
