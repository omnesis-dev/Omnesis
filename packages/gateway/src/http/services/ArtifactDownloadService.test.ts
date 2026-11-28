// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { extract, type Header } from "tar-stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  encryptArtifactFileInPlace,
  ensureInstallRootKey,
  createRecoveryEnvelope,
  readInstallRootKey,
  produceEncryptedArtifact,
} from "@omnesis/core";
import * as artifactFiles from "./artifact-files.js";
import {
  ArtifactDownloadService,
  type ArtifactDownloadAuthority,
} from "./ArtifactDownloadService.js";

let dir: string;
let service: ArtifactDownloadService;
const pending = new AbortController().signal;
const authority: ArtifactDownloadAuthority = {
  caller: "fixture-admin",
  stillAuthorized: () => true,
};
const encryption = { scheme: "omnesis.encrypted-artifact.v1", key: "install-root-key-v1" };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-artifact-download-"));
  await mkdir(join(dir, "backups"));
  await mkdir(join(dir, "exports"));
  service = new ArtifactDownloadService({
    readExportRootKey: () => readInstallRootKey({ backend: "file", configDir: dir }),
    backupRoot: join(dir, "backups"),
    exportRoot: join(dir, "exports"),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service.close();
  await rm(dir, { recursive: true, force: true });
});
async function backup(
  name: string,
  files: Record<string, string | Buffer>,
  encrypted = false,
): Promise<string> {
  const path = join(dir, "backups", name);
  await mkdir(path);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(path, name, ".."), { recursive: true });
    await writeFile(join(path, name), bytes);
  }
  await writeFile(
    join(path, "backup-manifest.json"),
    JSON.stringify({
      version: "0.0.0",
      startedAt: "2026-01-02T03:00:00.000Z",
      finishedAt: "2026-01-02T03:04:05.000Z",
      includeIndex: false,
      files: Object.entries(files).map(([name, bytes]) => ({
        name,
        bytes: Buffer.byteLength(bytes),
      })),
      ...(encrypted ? { encryption } : {}),
    }),
  );
  return path;
}
async function id(): Promise<string> {
  return (await service.list("backup", pending))[0]!.id;
}
async function unpack(response: Response): Promise<Map<string, { header: Header; bytes: Buffer }>> {
  const archive = extract();
  const files = new Map<string, { header: Header; bytes: Buffer }>();
  const finished = new Promise<void>((resolve, reject) => {
    archive.once("finish", resolve);
    archive.once("error", reject);
    archive.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => {
        if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      });
      stream.once("error", reject);
      stream.once("end", () => {
        files.set(header.name, { header, bytes: Buffer.concat(chunks) });
        next();
      });
      stream.resume();
    });
  });
  archive.end(Buffer.from(await response.arrayBuffer()));
  await finished;
  return files;
}
async function consume(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (!(await reader.read()).done) {
    /* Drain only this fixture's response. */
  }
}

describe("artifact downloads", () => {
  test("catalogs completed artifacts without exposing filesystem paths and streams real private-mode tar entries", async () => {
    await backup("completed", {
      "documents.enc": "a legacy plaintext artifact",
      "nested/settings.json": "fictional settings",
    });
    await mkdir(join(dir, "backups", "partial"));
    await writeFile(join(dir, "backups", "partial", "half-written.db"), "incomplete");
    const items = await service.list(undefined, pending);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain(dir);
    expect(items[0]).toMatchObject({ kind: "backup", encrypted: false, protection: "plaintext" });
    const response = await service.download(items[0]!.id, authority, pending);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Omnesis-backup-[0-9TZ.-]+\.tar"$/u,
    );
    const files = await unpack(response);
    expect([...files.keys()].some((name) => name.endsWith("/nested/settings.json"))).toBe(true);
    for (const [name, file] of files) {
      expect(name).not.toContain("..");
      expect(name.startsWith("/")).toBe(false);
      expect(file.header.type).toMatch(/^(file|directory)$/u);
      expect(file.header.mode).toBe(file.header.type === "directory" ? 0o700 : 0o600);
      expect(file.header.uname || "").toBe("");
      expect(file.header.gname || "").toBe("");
    }
  });

  test("preserves actual encrypted bytes without reminting and never trusts an enc suffix alone", async () => {
    const source = join(dir, "source.jsonl");
    await writeFile(source, "invented document payload");
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const sealed = await encryptArtifactFileInPlace(source, {
      backend: "file",
      configDir: dir,
      scope: "export:fixture",
    });
    const ciphertext = await readFile(sealed.path);
    const rootKey = await readInstallRootKey({ backend: "file", configDir: dir });
    if (!rootKey) throw new Error("Fixture root key is absent");
    const envelope = Buffer.from(
      JSON.stringify(createRecoveryEnvelope(rootKey, "fictional recovery code")),
    );
    await backup(
      "sealed",
      { "documents.enc": ciphertext, "keyring/recovery-envelope.json": envelope },
      true,
    );
    let item = (await service.list("backup", pending))[0]!;
    expect(item).toMatchObject({ encrypted: true, protection: "encrypted-payloads" });
    const entries = await unpack(await service.download(item.id, authority, pending));
    const archived = [...entries.entries()].find(([name]) => name.endsWith("/documents.enc"))![1]
      .bytes;
    expect(archived.equals(ciphertext)).toBe(true);
    const recovery = [...entries.entries()].find(([name]) =>
      name.endsWith("/keyring/recovery-envelope.json"),
    )![1].bytes;
    expect(recovery.equals(envelope)).toBe(true);
    expect(archived.toString()).not.toContain("invented document payload");
    await backup("mixed", { "ciphertext.enc": ciphertext, "plain.json": "readable" }, true);
    item = (await service.list("backup", pending)).find(
      (candidate) => candidate.protection === "mixed",
    )!;
    expect(item.encrypted).toBe(false);
  });

  test("refuses traversal, symlinks, hardlinks and undeclared files", async () => {
    const safe = await backup("safe", { payload: "safe fixture" });
    await writeFile(join(safe, "not-in-manifest"), "never archive this");
    const bad = await backup("traversal", {});
    await writeFile(
      join(bad, "backup-manifest.json"),
      JSON.stringify({
        version: "0",
        startedAt: "2026-01-02T03:00:00.000Z",
        finishedAt: "2026-01-02T03:04:05.000Z",
        includeIndex: false,
        files: [{ name: "../outside", bytes: 1 }],
      }),
    );
    const symbolic = await backup("symbolic", { payload: "replace" });
    await rm(join(symbolic, "payload"));
    await symlink(join(safe, "payload"), join(symbolic, "payload"));
    const hard = await backup("hard", {});
    await link(join(safe, "not-in-manifest"), join(hard, "payload"));
    await writeFile(
      join(hard, "backup-manifest.json"),
      JSON.stringify({
        version: "0",
        startedAt: "2026-01-02T03:00:00.000Z",
        finishedAt: "2026-01-02T03:04:05.000Z",
        includeIndex: false,
        files: [{ name: "payload", bytes: 1 }],
      }),
    );
    const items = await service.list("backup", pending);
    expect(items).toHaveLength(1);
    const entries = await unpack(await service.download(items[0]!.id, authority, pending));
    expect([...entries.keys()].some((name) => name.endsWith("not-in-manifest"))).toBe(false);
  });

  test("a replaced directory or changed file invalidates a previously offered opaque ID", async () => {
    const path = await backup("completed", { payload: "old" });
    const oldId = await id();
    await writeFile(join(path, "payload"), "new");
    await expect(service.download(oldId, authority, pending)).rejects.toMatchObject({
      status: 404,
    });
    const currentId = await id();
    await rename(path, join(dir, "removed"));
    await backup("completed", { payload: "new" });
    await expect(service.download(currentId, authority, pending)).rejects.toMatchObject({
      status: 404,
    });
  });

  test("cancellation drains its file handles and releases only its own download admission", async () => {
    await backup("large", { payload: Buffer.alloc(4 * 1024 * 1024, 0x41) });
    const artifact = await id();
    const response = await service.download(artifact, authority, pending);
    const reader = response.body!.getReader();
    await reader.read();
    await expect(service.download(artifact, authority, pending)).rejects.toMatchObject({
      status: 429,
    });
    await reader.cancel();
    const next = await service.download(artifact, authority, pending);
    await next.body!.cancel();
    expect(await readFile(join(dir, "backups", "large", "payload"))).toHaveLength(4 * 1024 * 1024);
  });

  test("simultaneous artifact cleanup fails the body instead of finishing a truncated archive", async () => {
    const path = await backup("large", { payload: Buffer.alloc(4 * 1024 * 1024, 0x42) });
    const response = await service.download(await id(), authority, pending);
    const reader = response.body!.getReader();
    await reader.read();
    await rm(path, { recursive: true, force: true });
    await expect(consume(reader)).rejects.toThrow("artifact download could not finish");
  });

  test("gateway shutdown stops even a response with a stalled consumer", async () => {
    await backup("large", { payload: Buffer.alloc(4 * 1024 * 1024, 0x43) });
    const response = await service.download(await id(), authority, pending);
    await service.close();
    await expect(response.arrayBuffer()).rejects.toThrow("artifact download could not finish");
  });

  test("request abort and operational size ceilings refuse safely", async () => {
    await backup("completed", { payload: "fixture" });
    const artifact = await id();
    const aborted = new AbortController();
    aborted.abort();
    await expect(service.download(artifact, authority, aborted.signal)).rejects.toBeDefined();
    const bounded = new ArtifactDownloadService({ backupRoot: join(dir, "backups"), maxBytes: 1 });
    try {
      await expect(bounded.download(artifact, authority, pending)).rejects.toMatchObject({
        status: 413,
      });
    } finally {
      await bounded.close();
    }
    await expect(
      service.download(artifact, { caller: "revoked", stillAuthorized: () => false }, pending),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("idle and duration bounds stop a slow consumer and release admission", async () => {
    await backup("large", { payload: Buffer.alloc(4 * 1024 * 1024, 0x44) });
    const artifact = await id();
    for (const limits of [{ idleTimeoutMs: 20 }, { maxDurationMs: 20 }]) {
      const bounded = new ArtifactDownloadService({ backupRoot: join(dir, "backups"), ...limits });
      try {
        const response = await bounded.download(artifact, authority, pending);
        const reader = response.body!.getReader();
        await reader.read();
        await new Promise((resolve) => setTimeout(resolve, 60));
        await expect(consume(reader)).rejects.toThrow("artifact download could not finish");
        const next = await bounded.download(artifact, authority, pending);
        await next.body!.cancel();
      } finally {
        await bounded.close();
      }
    }
  });

  test("an aborting HTTP request stops an active stream without deleting its artifact", async () => {
    const path = await backup("large", { payload: Buffer.alloc(4 * 1024 * 1024, 0x45) });
    const controller = new AbortController();
    const response = await service.download(await id(), authority, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(consume(reader)).rejects.toThrow("artifact download could not finish");
    expect(await readFile(join(path, "payload"))).toHaveLength(4 * 1024 * 1024);
  });
  test("preserves declared empty directories and refuses a manifest whose data is missing", async () => {
    const path = await backup("empty-directory", {});
    await mkdir(join(path, "empty"));
    await writeFile(
      join(path, "backup-manifest.json"),
      JSON.stringify({
        version: "0",
        startedAt: "2026-01-02T03:00:00.000Z",
        finishedAt: "2026-01-02T03:04:05.000Z",
        includeIndex: false,
        files: [{ name: "empty", bytes: 0 }],
      }),
    );
    const missing = await backup("missing", { payload: "removed" });
    await rm(join(missing, "payload"));
    const catalog = await service.list("backup", pending);
    expect(catalog).toHaveLength(1);
    const entries = await unpack(await service.download(catalog[0]!.id, authority, pending));
    expect([...entries].find(([name]) => name.endsWith("/empty"))?.[1].header.type).toBe(
      "directory",
    );
  });

  test("bounds simultaneous inventory work and shutdown drains pending filesystem scans", async () => {
    await backup("completed", { payload: "fixture" });
    const first = service.list("backup", pending);
    const second = service.list("backup", pending);
    await expect(service.list("backup", pending)).rejects.toMatchObject({ status: 429 });
    await Promise.all([first, second]);
    const scanning = service.list("backup", pending).catch((error: unknown) => error);
    await service.close();
    expect(await scanning).toBeInstanceOf(Error);
    await expect(service.list("backup", pending)).rejects.toMatchObject({ status: 503 });
  });
  test("shutdown waits for a file descriptor opened before stream registration", async () => {
    await backup("completed", { payload: "fixture" });
    const artifact = await id();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const actual = artifactFiles.openArtifactFile;
    let descriptor: Awaited<ReturnType<typeof actual>> | undefined;
    vi.spyOn(artifactFiles, "openArtifactFile").mockImplementationOnce(async (...args) => {
      descriptor = await actual(...args);
      entered.resolve();
      await release.promise;
      return descriptor;
    });
    const opening = service.download(artifact, authority, pending);
    void opening.catch(() => {});
    await entered.promise;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    await expect(opening).rejects.toMatchObject({ status: 503 });
    await expect(descriptor!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });
});

async function encryptedExport(
  format: "json" | "csv",
  payload?: Buffer,
): Promise<{ path: string; id: string; name: string; stored: string; exportId: string }> {
  await ensureInstallRootKey({ backend: "file", configDir: dir });
  const exportId = randomUUID();
  const path = join(dir, "exports", exportId);
  await mkdir(path, { mode: 0o700 });
  const name = format === "json" ? "documents.jsonl" : "documents.csv";
  const files =
    format === "json"
      ? { [name]: payload ?? Buffer.from('{"content":"invented readable export"}\n') }
      : {
          [name]: payload ?? Buffer.from("id,title\nfictional-id,Invented title\n"),
          activity: Buffer.from("day,value\n2026-01-01,3\n"),
        };
  const names: string[] = [];
  for (const [key, bytes] of Object.entries(files)) {
    const clear = key === "activity" ? "activity.csv" : key;
    names.push(clear + ".enc");
    await produceEncryptedArtifact(
      join(path, clear + ".enc"),
      { backend: "file", configDir: dir, scope: `export:${exportId}:${clear}` },
      async (body) => {
        body.write(bytes);
      },
    );
  }
  const manifest = {
    exportId,
    version: "1.0.0",
    startedAt: "2026-01-02T03:00:00.000Z",
    finishedAt: "2026-01-02T03:04:05.000Z",
    format,
    files: [...names, "manifest.json"],
    documentCount: 1,
    encryption,
  };
  await produceEncryptedArtifact(
    join(path, "manifest.full.json.enc"),
    { backend: "file", configDir: dir, scope: `export:${exportId}:manifest.full.json` },
    async (body) => {
      body.write(JSON.stringify(manifest));
    },
  );
  await writeFile(
    join(path, "manifest.json"),
    JSON.stringify({
      ...manifest,
      documentCount: undefined,
      files: [...names, "manifest.full.json.enc"],
      encryptedManifest: "manifest.full.json.enc",
    }),
    { mode: 0o600 },
  );
  const item = (await service.list("export", pending)).find(
    (entry) => entry.createdAt === manifest.finishedAt,
  )!;
  return { path, id: item.id, name, stored: name + ".enc", exportId };
}

describe("explicitly approved readable exports", () => {
  test("older encrypted exports lacking a sealed export identity require a new export", async () => {
    const f = await encryptedExport("json");
    const path = join(f.path, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete manifest.exportId;
    await writeFile(path, JSON.stringify(manifest));
    const item = (await service.list("export", pending))[0]!;
    await expect(service.readableExport(item.id, authority, pending)).rejects.toMatchObject({
      status: 400,
    });
    const original = await service.download(item.id, authority, pending);
    const files = await unpack(original);
    expect([...files.keys()].some((name) => name.endsWith("/documents.jsonl.enc"))).toBe(true);
  });

  test("a pinned payload changed after the authentication pass cannot complete replay", async () => {
    const f = await encryptedExport("json", Buffer.alloc(1024 * 1024, 0x73));
    const actual = artifactFiles.verifyArtifactFile;
    let verifications = 0;
    vi.spyOn(artifactFiles, "verifyArtifactFile").mockImplementation(async (handle, file) => {
      await actual(handle, file);
      if (file.name === f.stored && ++verifications === 4) {
        const path = join(f.path, f.stored);
        const bytes = await readFile(path);
        bytes[bytes.length - 1] = bytes.at(-1)! ^ 0xff;
        await writeFile(path, bytes);
      }
    });
    await expect(
      (await service.readableExport(f.id, authority, pending)).arrayBuffer(),
    ).rejects.toThrow("could not finish");
    expect(verifications).toBeGreaterThanOrEqual(4);
  });
  test.each(["json", "csv"] as const)(
    "authenticates and extracts usable %s while preserving stored encryption and root identity",
    async (format) => {
      const f = await encryptedExport(format);
      const before = await readFile(join(f.path, f.stored));
      const root = await readInstallRootKey({ backend: "file", configDir: dir });
      const response = await service.readableExport(f.id, authority, pending);
      expect(response.headers.get("content-disposition")).toContain("export-readable-");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const files = await unpack(response);
      expect([...files.keys()].some((name) => name.endsWith(".enc"))).toBe(false);
      const payload = [...files]
        .find(([name]) => name.endsWith("/" + f.name))![1]
        .bytes.toString("utf8");
      if (format === "json")
        expect(JSON.parse(payload.trim())).toEqual({ content: "invented readable export" });
      else {
        expect(payload).toBe("id,title\nfictional-id,Invented title\n");
        expect(
          [...files].find(([name]) => name.endsWith("/activity.csv"))![1].bytes.toString(),
        ).toContain("day,value");
      }
      const manifest = JSON.parse(
        [...files].find(([name]) => name.endsWith("/manifest.json"))![1].bytes.toString(),
      ) as Record<string, unknown>;
      expect(manifest.encryption).toBeUndefined();
      expect(manifest.exportId).toBe(f.exportId);
      expect(await readFile(join(f.path, f.stored))).toEqual(before);
      expect(await readInstallRootKey({ backend: "file", configDir: dir })).toBe(root);
      expect([...files.keys()].some((name) => /keyring|credential|recovery/iu.test(name))).toBe(
        false,
      );
    },
  );

  test("a bad payload tag reveals no unauthenticated payload and never finishes a valid TAR", async () => {
    const payload = Buffer.from(
      "fictional payload that must not escape failed authentication\n".repeat(1000),
    );
    const f = await encryptedExport("json", payload);
    const file = join(f.path, f.stored);
    const damaged = await readFile(file);
    damaged[damaged.length - 1] = damaged.at(-1)! ^ 0xff;
    await writeFile(file, damaged);
    const item = (await service.list("export", pending))[0]!;
    const reader = (await service.readableExport(item.id, authority, pending)).body!.getReader();
    const received: Buffer[] = [];
    await expect(
      (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          received.push(Buffer.from(chunk.value));
        }
      })(),
    ).rejects.toThrow("could not finish");
    expect(Buffer.concat(received).includes(payload.subarray(0, 60))).toBe(false);
  });

  test("scope substitution and full-manifest identity disagreement fail closed", async () => {
    const f = await encryptedExport("json");
    await rm(join(f.path, f.stored));
    await produceEncryptedArtifact(
      join(f.path, f.stored),
      { backend: "file", configDir: dir, scope: `backup:${f.exportId}:${f.name}` },
      async (body) => {
        body.write("must not decrypt backup scope");
      },
    );
    let item = (await service.list("export", pending))[0]!;
    await expect(
      (await service.readableExport(item.id, authority, pending)).arrayBuffer(),
    ).rejects.toThrow("could not finish");
    const publicPath = join(f.path, "manifest.json");
    const manifest = JSON.parse(await readFile(publicPath, "utf8")) as Record<string, unknown>;
    manifest.exportId = randomUUID();
    await writeFile(publicPath, JSON.stringify(manifest));
    item = (await service.list("export", pending))[0]!;
    await expect(
      (await service.readableExport(item.id, authority, pending)).arrayBuffer(),
    ).rejects.toThrow("could not finish");
  });

  test("readable download never accepts a backup or remints a missing key", async () => {
    await backup("completed", { payload: "fictional backup credentials" });
    await expect(service.readableExport(await id(), authority, pending)).rejects.toMatchObject({
      status: 400,
    });
    const f = await encryptedExport("json");
    const missing = new ArtifactDownloadService({
      exportRoot: join(dir, "exports"),
      readExportRootKey: async () => null,
    });
    try {
      await expect(
        (await missing.readableExport(f.id, authority, pending)).arrayBuffer(),
      ).rejects.toThrow("could not finish");
    } finally {
      await missing.close();
    }
  });

  test("cancellation drains authenticated replay and releases admission while preserving the source", async () => {
    const f = await encryptedExport("json", Buffer.alloc(8 * 1024 * 1024, 0x71));
    const reader = (await service.readableExport(f.id, authority, pending)).body!.getReader();
    await reader.read();
    await reader.cancel();
    const response = await service.download(f.id, authority, pending);
    await response.body!.cancel();
    expect((await readFile(join(f.path, f.stored))).length).toBeGreaterThan(8 * 1024 * 1024);
  });

  test("token revocation during readable replay terminates the response", async () => {
    const f = await encryptedExport("json", Buffer.alloc(8 * 1024 * 1024, 0x72));
    let authorized = true;
    const reader = (
      await service.readableExport(
        f.id,
        { caller: "revocable-readable", stillAuthorized: () => authorized },
        pending,
      )
    ).body!.getReader();
    await reader.read();
    authorized = false;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    await expect(consume(reader)).rejects.toThrow("could not finish");
  });
});
