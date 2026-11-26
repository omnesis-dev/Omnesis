// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  acquireGatewayLock,
  atomicWriteFile,
  fsyncDir,
  managedDesktopCatalogDiscoveryInvocation,
  ownedProcessCleanupReceipt,
  type ManagedDesktopDataScope,
  type NodeCommandInvocation,
} from "@omnesis/core";
import { MANAGED_CODEX_QUALIFIED_VERSION } from "./codex-managed-policy-version.js";
import {
  managedCodexCatalogFromCache,
  readManagedCodexCatalogFile,
  type ManagedCodexCatalogFile,
} from "./codex-managed-model-catalog.js";

const refused = () =>
  new Error(
    "Codex model discovery could not be isolated. Refresh the model list or use an API-key backend.",
  );
type Scope = Omit<ManagedDesktopDataScope, "format">;
export interface PreparedManagedCodexCatalog {
  readonly path: string;
  readonly sha256: string;
  readonly slugs: readonly string[];
}
const prepared = new WeakSet<PreparedManagedCodexCatalog>();

export interface ManagedCatalogDiscoveryClient {
  request(
    method: "model/list",
    params: { cursor?: string; limit: number; includeHidden: boolean },
    timeoutMs: number,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}
export interface ManagedCatalogPlatform {
  invocation(command: string, args: readonly string[], nonce: string): NodeCommandInvocation;
  previousSha256(scope: Scope, nonce: string): Promise<string | null>;
}

const platform: ManagedCatalogPlatform = {
  invocation: managedDesktopCatalogDiscoveryInvocation,
  async previousSha256(scope, nonce) {
    const file = await readManagedCodexCatalogFile(
      join(`${scope.configDir}.bootstrap`, `.catalog-${scope.secretService.slice(-64)}.lock`),
    );
    if (file.bytes.length > 4096) throw refused();
    let value: unknown;
    try {
      value = JSON.parse(file.bytes.toString("utf8"));
    } catch {
      throw refused();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw refused();
    const receipt = value as Record<string, unknown>;
    if (
      Object.keys(receipt).sort().join(",") !== "nonce,previousSha256,version" ||
      receipt.version !== 1 ||
      receipt.nonce !== nonce ||
      (receipt.previousSha256 !== null &&
        (typeof receipt.previousSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(receipt.previousSha256)))
    )
      throw refused();
    return receipt.previousSha256 as string | null;
  },
};

async function privateDirectory(path: string): Promise<void> {
  const file = await lstat(path);
  if (
    (await realpath(path)) !== resolve(path) ||
    !file.isDirectory() ||
    file.isSymbolicLink() ||
    (file.mode & 0o077) !== 0 ||
    (process.getuid && file.uid !== process.getuid())
  )
    throw refused();
}

async function removeOwnedCache(path: string, owned: ManagedCodexCatalogFile): Promise<void> {
  const current = await readManagedCodexCatalogFile(path);
  if (
    current.device !== owned.device ||
    current.inode !== owned.inode ||
    current.sha256 !== owned.sha256
  )
    throw refused();
  await unlink(path);
  await fsyncDir(dirname(path));
}

/** All discovery runtimes share this lease; every returned runtime uses a static catalog. */
export async function prepareManagedCodexModelCatalog(options: {
  scope: Scope;
  codexHome: string;
  stateHome: string;
  command: string;
  args: readonly string[];
  version: string;
  timeoutMs: number;
  signal?: AbortSignal;
  open(invocation: NodeCommandInvocation): Promise<ManagedCatalogDiscoveryClient>;
  /** Explicit OS seam for source fixtures; production always uses the native adapter. */
  platform?: ManagedCatalogPlatform;
}): Promise<PreparedManagedCodexCatalog> {
  const home = join(options.scope.configDir, "codex-home", options.scope.instance);
  if (
    options.version !== MANAGED_CODEX_QUALIFIED_VERSION ||
    options.args.some((arg) => /\bmodel_catalog_json\b/u.test(arg)) ||
    resolve(options.codexHome) !== home ||
    !/^desktop-[a-f0-9]{16}$/u.test(options.scope.instance) ||
    !/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(options.scope.secretService)
  )
    throw refused();
  await privateDirectory(home);
  await privateDirectory(options.stateHome);
  const lockRoot = join(home, ".omnesis-model-discovery");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await privateDirectory(lockRoot);
  const lock = await acquireGatewayLock(lockRoot, {
    signal: options.signal,
    waitMs: options.timeoutMs,
  });
  const os = options.platform ?? platform;
  let cleanupConfirmed = true;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      options.signal?.throwIfAborted();
      const nonce = randomUUID();
      let client: ManagedCatalogDiscoveryClient | undefined;
      const slugs = new Set<string>();
      let failed = false,
        discoveryFailure: unknown;
      try {
        client = await options.open(os.invocation(options.command, options.args, nonce));
        let cursor: string | undefined;
        for (let page = 0; page < 16; page++) {
          options.signal?.throwIfAborted();
          const result = await client.request(
            "model/list",
            { cursor, limit: 100, includeHidden: true },
            options.timeoutMs,
          );
          if (!result || typeof result !== "object" || Array.isArray(result)) throw refused();
          const record = result as Record<string, unknown>;
          if (!Array.isArray(record.data) || record.data.length > 100) throw refused();
          for (const item of record.data) {
            if (
              !item ||
              typeof item !== "object" ||
              Array.isArray(item) ||
              !("model" in item) ||
              typeof item.model !== "string" ||
              slugs.has(item.model)
            )
              throw refused();
            slugs.add(item.model);
          }
          if (record.nextCursor == null) break;
          if (
            typeof record.nextCursor !== "string" ||
            !record.nextCursor ||
            record.nextCursor.length > 4096 ||
            cursor === record.nextCursor ||
            page === 15
          )
            throw refused();
          cursor = record.nextCursor;
        }
      } catch (error) {
        failed = true;
        discoveryFailure = error;
      }
      if (client) {
        try {
          await client.dispose();
        } catch {
          cleanupConfirmed = false;
          throw Object.assign(refused(), {
            cleanupFailure: "managed-model-discovery",
            cleanupPending: true,
          });
        }
      }
      if (failed) throw discoveryFailure;
      // No model metadata, cleanup or publication is trusted before the real SDK has exited.
      const previous = await os.previousSha256(options.scope, nonce);
      const cachePath = join(home, "models_cache.json");
      const file = await readManagedCodexCatalogFile(cachePath);
      if (file.sha256 === previous) {
        await removeOwnedCache(cachePath, file);
        if (attempt === 0) continue;
        throw refused();
      }
      const catalog = managedCodexCatalogFromCache(
        file.bytes,
        [...slugs],
        previous,
        options.version,
      );
      const bytes = Buffer.from(JSON.stringify(catalog));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const directory = join(options.stateHome, "model-catalogs");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await privateDirectory(directory);
      const path = join(directory, `${sha256}.json`);
      let exists = true;
      try {
        await lstat(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        exists = false;
      }
      if (!exists) await atomicWriteFile(path, bytes, { mode: 0o400 });
      if ((await readManagedCodexCatalogFile(path)).sha256 !== sha256) throw refused();
      await removeOwnedCache(cachePath, file);
      const descriptor = Object.freeze({
        path,
        sha256,
        slugs: Object.freeze(catalog.models.map((model) => model.slug as string)),
      });
      prepared.add(descriptor);
      return descriptor;
    }
    throw refused();
  } catch (error) {
    if (ownedProcessCleanupReceipt(error) !== undefined) cleanupConfirmed = false;
    if (!cleanupConfirmed)
      throw Object.assign(refused(), {
        cleanupFailure: "managed-model-discovery",
        cleanupPending: true,
      });
    // SDK/provider errors can contain private metadata; expose only the fixed remediation.

    throw refused();
  } finally {
    if (cleanupConfirmed) lock.release();
  }
}

/** The fixed CLI override is read back before a static SDK may receive any thread. */
export async function assertManagedCodexStaticCatalog(
  descriptor: PreparedManagedCodexCatalog,
  configResponse: unknown,
  selectedModel?: string,
): Promise<void> {
  if (
    !prepared.has(descriptor) ||
    (selectedModel !== undefined && !descriptor.slugs.includes(selectedModel))
  )
    throw refused();
  if ((await readManagedCodexCatalogFile(descriptor.path)).sha256 !== descriptor.sha256)
    throw refused();
  if (
    !configResponse ||
    typeof configResponse !== "object" ||
    Array.isArray(configResponse) ||
    !("layers" in configResponse) ||
    !Array.isArray(configResponse.layers) ||
    configResponse.layers.length > 64
  )
    throw refused();
  const layers: unknown[] = configResponse.layers;
  const flags = layers.filter((item) => {
    if (!item || typeof item !== "object" || !("name" in item)) return false;
    const name = item.name;
    return !!name && typeof name === "object" && "type" in name && name.type === "sessionFlags";
  });
  const layer = flags[0];
  if (flags.length !== 1 || !layer || typeof layer !== "object" || !("config" in layer))
    throw refused();
  const config = layer.config;
  if (
    !config ||
    typeof config !== "object" ||
    !("model_catalog_json" in config) ||
    config.model_catalog_json !== descriptor.path
  )
    throw refused();
}

/** Only descriptors published after joined discovery can authorize model-selected threads. */
export function assertPreparedManagedCodexModel(
  descriptor: PreparedManagedCodexCatalog | undefined,
  selectedModel: string,
): asserts descriptor is PreparedManagedCodexCatalog {
  if (!descriptor || !prepared.has(descriptor) || !descriptor.slugs.includes(selectedModel))
    throw refused();
}
