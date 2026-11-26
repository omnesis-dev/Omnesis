// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadManifest, type GgufCatalogEntry } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "@omnesis/gateway/src/db.js";
import { createDevice } from "@omnesis/gateway/src/data/repositories/DeviceRepository.js";
import { createToken } from "@omnesis/gateway/src/data/repositories/TokenRepository.js";
import { ConfigStore } from "@omnesis/gateway/src/config-store.js";
import { InferenceRegistry } from "@omnesis/gateway/src/inference/registry.js";
import { ModelManager, type ProgressBroadcast } from "@omnesis/gateway/src/models/manager.js";
import { createServer as createGatewayServer } from "@omnesis/gateway/src/server.js";
import {
  resolveStoragePolicy,
  StoragePressureManager,
} from "@omnesis/gateway/src/storage/pressure.js";
import { assertStorageVolumeGrowth } from "@omnesis/gateway/src/storage/volumes.js";
import { desktopSearchModel } from "./search-model.js";
import { desktopProfile, desktopJournalPath, recommendDesktopResources } from "./profile.js";

// This composes configured-home download policy, not bootstrap or native inference.
const bytes = Buffer.alloc(32 * 1024, "Invented artifact bytes; not model weights. ");
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const firstHalfReceived = (event: ProgressBroadcast) =>
  event.kind === "progress" && event.progress.downloadedBytes === bytes.length / 2;
let certificates: string;
let certificate: Buffer;
let privateKey: Buffer;

beforeAll(async () => {
  certificates = await realpath(await mkdtemp(join(tmpdir(), "omnesis-search-model-tls-")));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(certificates, "key.pem"),
      "-out",
      join(certificates, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  certificate = await readFile(join(certificates, "cert.pem"));
  privateKey = await readFile(join(certificates, "key.pem"));
});

afterAll(async () => {
  if (certificates) await rm(certificates, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned model fixture did not settle")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-search-model-composed-")));
  const constructionCleanup: Array<() => void | Promise<void>> = [
    () => rm(root, { recursive: true, force: true }),
  ];
  try {
    const profile = desktopProfile(root);
    await mkdir(join(profile.configDir, "tls"), { recursive: true, mode: 0o700 });
    const modelsDir = join(profile.configDir, "models");
    await mkdir(modelsDir, { mode: 0o700 });
    const sentinel = join(profile.configDir, "existing-information.txt");
    await writeFile(sentinel, "Invented previously indexed information", { mode: 0o600 });
    const recommendation = recommendDesktopResources(8 * 1024 ** 3);
    await writeFile(
      desktopJournalPath(profile),
      JSON.stringify({
        version: 1,
        owner: "omnesis-desktop",
        mode: "home",
        phase: "configured",
        instance: profile.instance,
        secretService: profile.secretService,
        embedder: recommendation.embedder.id,
        memoryLimitMb: recommendation.memoryLimitMb,
      }),
      { mode: 0o600 },
    );
    const configStore = new ConfigStore({ filePath: join(profile.configDir, "omnesis.json") });
    constructionCleanup.push(() => configStore.stop());
    await configStore.load();
    const configured = await configStore.put({
      inference: { assignments: { embedder: recommendation.embedder.id } },
      gateway: {
        memoryLimitMb: recommendation.memoryLimitMb,
        storage: { maxBytes: 64 * 1024 ** 2 },
      },
    });
    expect(configured.ok).toBe(true);
    const originalConfig = await readFile(join(profile.configDir, "omnesis.json"), "utf8");
    const events: ProgressBroadcast[] = [];
    const notifications = new Set<() => void>();
    const waitEvent = async (after: number, predicate: (event: ProgressBroadcast) => boolean) => {
      const match = () => events.slice(after).find(predicate);
      if (match()) return match()!;
      let notify!: () => void;
      const promise = new Promise<ProgressBroadcast>((resolve) => {
        notify = () => {
          const found = match();
          if (found) resolve(found);
        };
        notifications.add(notify);
        notify();
      });
      try {
        return await bounded(promise);
      } finally {
        notifications.delete(notify);
      }
    };
    let corrupt = false;
    const attempts: Array<{
      release: () => void;
      closed: Promise<void>;
      response: ServerResponse;
    }> = [];
    const artifactRequests: Array<{ url: string; userAgent: string | undefined }> = [];
    const artifact = createHttpServer((request, response) => {
      artifactRequests.push({ url: request.url ?? "", userAgent: request.headers["user-agent"] });
      if (request.url !== "/fixture.gguf" || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      const gate = deferred(),
        closed = deferred();
      response.once("close", closed.resolve);
      attempts.push({ release: gate.resolve, closed: closed.promise, response });
      const served = corrupt ? Buffer.alloc(bytes.length, 0) : bytes;
      response.writeHead(200, {
        "content-length": served.length,
        "content-type": "application/octet-stream",
      });
      response.write(served.subarray(0, bytes.length / 2));
      void gate.promise.then(() => {
        if (!response.destroyed) response.end(served.subarray(bytes.length / 2));
      });
    });
    await new Promise<void>((resolve) => artifact.listen(0, "127.0.0.1", resolve));
    constructionCleanup.push(async () => {
      artifact.closeAllConnections();
      await new Promise<void>((resolve) => artifact.close(() => resolve()));
    });
    const artifactAddress = artifact.address();
    if (!artifactAddress || typeof artifactAddress === "string")
      throw new Error("Missing artifact listener");
    const entry: GgufCatalogEntry = {
      ...recommendation.embedder,
      downloadUrl: `http://127.0.0.1:${artifactAddress.port}/fixture.gguf`,
      sizeBytes: bytes.length,
      sha256: digest(bytes),
    };
    // Only OS observations are synthetic; both production capacity calculations run.
    let availableBytes = 512 * 1024 ** 2;
    let usageBytes = 0;
    const policy = resolveStoragePolicy(configStore.get().gateway?.storage, 1);
    const pressure = new StoragePressureManager({
      getPolicy: () => policy,
      measure: async () => ({
        usageBytes,
        measuredAt: Date.now(),
        volumes: [{ id: "invented-volume", totalBytes: 1024 ** 3, availableBytes }],
      }),
    });
    await pressure.refresh();
    const manager = new ModelManager({
      modelsDir,
      catalog: () => [entry],
      assertStorageCanGrow: (additional) => {
        assertStorageVolumeGrowth(modelsDir, policy, additional, () => ({
          blocks: 1024 ** 3,
          bavail: availableBytes,
          bsize: 1,
        }));
        pressure.assertCanGrow(additional);
      },
      onBroadcast: (event) => {
        events.push(event);
        notifications.forEach((notify) => notify());
      },
    });
    const registry = new InferenceRegistry({
      modelsDir,
      configDir: profile.configDir,
      manifest: () => loadManifest(join(modelsDir, "manifest.json")).manifest,
      hasAnthropicApiKey: () => false,
      getCatalogEntry: (id) => (id === entry.id ? entry : undefined),
    });
    constructionCleanup.push(() => registry.dispose());
    const db = createDatabase(join(root, "route-fixture.db"));
    constructionCleanup.push(() => {
      db.close();
    });
    const device = createDevice(db, { name: "Invented setup client", kind: "cli" });
    const { token } = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]);
    const gateway = createGatewayServer(db, undefined, {
      configDir: profile.configDir,
      configStore,
      modelManager: manager,
      getSystemInfo: () => ({
        platform: "darwin",
        arch: "arm64",
        cpuModel: "Invented processor",
        cpuCount: 4,
        totalRamGb: 8,
        freeRamGb: 4,
        metalSupported: true,
        cudaSupported: false,
        modelsDir,
        modelsDirFreeGb: availableBytes / 1024 ** 3,
      }),
      getInferenceOverview: () => {
        registry.loadConfig(configStore.get());
        return registry.getOverview();
      },
      probeBackend: async () => {
        throw new Error("Download policy must not probe inference");
      },
      verifyModel: async () => {
        throw new Error("Download policy must not invoke inference");
      },
    });
    constructionCleanup.push(() => gateway.close());
    const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
    const bridgeFailures: unknown[] = [];
    // A small test-only HTTPS/Fetch adapter; all endpoint behavior is the real gateway.
    const tls = createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
      });
      void (async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk as Uint8Array);
          length += buffer.length;
          if (length > 8192) throw new Error("Unexpected large fixture request");
          chunks.push(buffer);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(",") : value);
        }
        const body = Buffer.concat(chunks);
        const result = await gateway.fetch(
          new Request(`https://localhost${request.url}`, {
            method: request.method,
            headers,
            ...(body.length ? { body: new Uint8Array(body) } : {}),
          }),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      })().catch((error: unknown) => {
        bridgeFailures.push(error);
        response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    constructionCleanup.push(async () => {
      tls.closeAllConnections();
      await new Promise<void>((resolve) => tls.close(() => resolve()));
    });
    const address = tls.address();
    if (!address || typeof address === "string") throw new Error("Missing TLS listener");
    await writeFile(
      join(profile.configDir, "runtime.json"),
      JSON.stringify({ version: 1, port: address.port }),
      { mode: 0o600 },
    );
    await writeFile(join(profile.configDir, "tls", "cert.pem"), certificate, { mode: 0o600 });
    await writeFile(join(profile.configDir, "token"), token, { mode: 0o600 });
    const signal = new AbortController();
    return {
      entry,
      manager,
      events,
      attempts,
      artifactRequests,
      requests,
      waitEvent,
      setCorrupt: (value: boolean) => {
        corrupt = value;
      },
      capacity: async (value: number) => {
        availableBytes = value;
        await pressure.refresh();
      },
      usage: async (value: number) => {
        usageBytes = value;
        await pressure.refresh();
      },
      release: () => attempts.forEach((attempt) => attempt.release()),
      state: (start = false) => desktopSearchModel(profile, { start, signal: signal.signal }),
      async unchanged() {
        expect(configStore.get().inference?.assignments?.embedder).toBe(entry.id);
        expect(await readFile(join(profile.configDir, "omnesis.json"), "utf8")).toBe(
          originalConfig,
        );
        expect(await readFile(sentinel, "utf8")).toBe("Invented previously indexed information");
        expect(bridgeFailures).toEqual([]);
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
        expect(
          requests.every(
            (request) =>
              (request.method === "GET" &&
                ["/admin/config", "/admin/models"].includes(request.path)) ||
              (request.method === "POST" && request.path === "/admin/models/install"),
          ),
        ).toBe(true);
        expect(
          artifactRequests.every(
            (request) =>
              request.url === "/fixture.gguf" &&
              request.userAgent === "omnesis-gateway/model-downloader",
          ),
        ).toBe(true);
      },
      async absent() {
        expect(manager.isInstalled(entry.id)).toBe(false);
        expect(manager.isDownloading(entry.id)).toBe(false);
        expect(loadManifest(join(modelsDir, "manifest.json")).manifest.models).toEqual([]);
        for (const suffix of ["", ".partial"])
          await expect(readFile(join(modelsDir, entry.filename + suffix))).rejects.toMatchObject({
            code: "ENOENT",
          });
      },
      async installed() {
        expect(await readFile(join(modelsDir, entry.filename))).toEqual(bytes);
        expect(loadManifest(join(modelsDir, "manifest.json")).manifest.models).toEqual([
          expect.objectContaining({
            id: entry.id,
            filename: entry.filename,
            sizeBytes: bytes.length,
            sha256: digest(bytes),
            downloadedFrom: entry.downloadUrl,
          }),
        ]);
        await expect(readFile(join(modelsDir, entry.filename + ".partial"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await desktopSearchModel(profile)).toEqual({ state: "ready" });
      },
      async close() {
        signal.abort();
        try {
          if (manager.isDownloading(entry.id)) {
            const after = events.length;
            manager.cancel(entry.id);
            attempts.forEach((attempt) => attempt.release());
            await waitEvent(after, (event) =>
              ["cancelled", "failed", "completed"].includes(event.kind),
            );
          }
        } finally {
          attempts.forEach((attempt) => {
            attempt.release();
            attempt.response.destroy();
          });
          await Promise.all(attempts.map((attempt) => bounded(attempt.closed)));
          tls.closeAllConnections();
          artifact.closeAllConnections();
          await Promise.all([
            new Promise<void>((resolve, reject) =>
              tls.close((error) => (error ? reject(error) : resolve())),
            ),
            new Promise<void>((resolve, reject) =>
              artifact.close((error) => (error ? reject(error) : resolve())),
            ),
          ]);
          await gateway.close();
          configStore.stop();
          await registry.dispose();
          db.close();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    for (const cleanup of constructionCleanup.reverse()) {
      try {
        await cleanup();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], "Owned model fixture setup cleanup failed", {
        cause: error,
      });
    throw error;
  }
}

test("configured-home policy reports actual streamed progress, avoids duplicate installs, and becomes ready only after verified publication", async () => {
  const f = await fixture();
  try {
    expect(await f.state()).toEqual({ state: "needs-download" });
    expect(await f.state(true)).toMatchObject({ state: "downloading" });
    await f.waitEvent(0, firstHalfReceived);
    expect(await f.state(true)).toEqual({
      state: "downloading",
      downloadedBytes: bytes.length / 2,
      totalBytes: bytes.length,
    });
    expect(
      f.requests.filter((request) => request.method === "POST").map((request) => request.path),
    ).toEqual(["/admin/models/install"]);
    expect(f.artifactRequests).toHaveLength(1);
    expect(f.manager.isInstalled(f.entry.id)).toBe(false);
    f.release();
    await f.waitEvent(0, (event) => event.kind === "completed");
    await f.installed();
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    await f.unchanged();
  } finally {
    await f.close();
  }
});

test("bad hash leaves no ready artifact and requires an explicit retry with the original pin", async () => {
  const f = await fixture();
  try {
    f.setCorrupt(true);
    await f.state(true);
    await f.waitEvent(0, firstHalfReceived);
    f.release();
    expect(await f.waitEvent(0, (event) => event.kind === "failed")).toMatchObject({
      code: "sha_mismatch",
    });
    await f.absent();
    expect(await f.state()).toEqual({ state: "needs-download" });
    expect(await f.state()).toEqual({ state: "needs-download" });
    expect(f.artifactRequests).toHaveLength(1);
    const after = f.events.length;
    f.setCorrupt(false);
    await f.state(true);
    await f.waitEvent(after, firstHalfReceived);
    expect(f.artifactRequests).toHaveLength(2);
    f.release();
    await f.waitEvent(after, (event) => event.kind === "completed");
    await f.installed();
    const started = f.events.filter((event) => event.kind === "started");
    expect(started).toHaveLength(2);
    expect(new Set(started.map((event) => event.downloadId)).size).toBe(2);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(2);
    await f.unchanged();
  } finally {
    await f.close();
  }
});

test("real capacity admission blocks preflight and midstream reserve loss without publishing or changing existing information", async () => {
  const f = await fixture();
  try {
    // Healthy volume, but the planned bytes would cross the configured quota.
    await f.usage(64 * 1024 ** 2 - bytes.length / 2);
    await expect(f.state(true)).rejects.toThrow("The local gateway refused the request");
    expect(f.artifactRequests).toHaveLength(0);
    expect(f.events).toEqual([]);
    await f.absent();
    await f.usage(0);
    // Independently exercise the fresh per-volume reserve calculation.
    await f.capacity(512);
    await expect(f.state(true)).rejects.toThrow("The local gateway refused the request");
    expect(f.artifactRequests).toHaveLength(0);
    expect(f.events).toEqual([]);
    await f.absent();
    expect(await f.state()).toEqual({ state: "needs-download" });
    await f.capacity(512 * 1024 ** 2);
    await f.state(true);
    await f.waitEvent(0, firstHalfReceived);
    await f.capacity(512);
    f.release();
    expect(await f.waitEvent(0, (event) => event.kind === "failed")).toMatchObject({
      code: "storage_capacity",
    });
    await f.absent();
    await f.unchanged();
    expect(await f.state()).toEqual({ state: "needs-download" });
    expect(f.artifactRequests).toHaveLength(1);
    await f.capacity(512 * 1024 ** 2);
    const after = f.events.length;
    await f.state(true);
    await f.waitEvent(after, firstHalfReceived);
    f.release();
    await f.waitEvent(after, (event) => event.kind === "completed");
    await f.installed();
    expect(f.artifactRequests).toHaveLength(2);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(4);
    await f.unchanged();
  } finally {
    await f.close();
  }
});
