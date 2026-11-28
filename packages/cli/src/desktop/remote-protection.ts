// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ownedProcessCleanupReceipt, readSecretTextFile } from "@omnesis/core";
import { readPairedDeviceFile } from "@omnesis/cloud-relay";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { publishDesktopHint } from "./publication.js";
import type { DesktopSessionTransport } from "./coordinator-runtime.js";
import type { DesktopPairing } from "./enrollment.js";

export type DesktopRemoteProtection = "encrypted" | "unprotected" | "unavailable";
const protectionSchema = z.object({
  storageProtection: z.object({
    version: z.literal(1),
    atRest: z.enum(["encrypted", "unprotected", "unavailable"]),
  }),
});
/** The authenticated request stays on the independently approved, TLS-pinned paired transport. */
export async function readDesktopRemoteProtection(
  transport: DesktopSessionTransport,
  pairing: DesktopPairing,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DesktopRemoteProtection> {
  signal.throwIfAborted();
  const base = pairedBase(transport);
  try {
    const result = protectionSchema.safeParse(
      await requestPairedHealth(base, pairing, signal, fetcher),
    );
    return result.success ? result.data.storageProtection.atRest : "unavailable";
  } catch (error) {
    if (signal.aborted || ownedProcessCleanupReceipt(error) !== undefined) throw error;
    return "unavailable";
  }
}

function pairedBase(transport: DesktopSessionTransport): URL {
  const base = new URL(transport.url);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password)
    throw new Error("Invalid protected paired transport");
  return base;
}
async function requestPairedHealth(
  base: URL,
  pairing: DesktopPairing,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetcher(new URL("/health", base), {
    redirect: "error",
    headers: { authorization: `Bearer ${pairing.token}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The protected home library is unavailable");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) throw new Error("The home protection response is too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Update compatibility is observed over the same authenticated pinned collector transport. */
export async function probeDesktopRemoteHealth(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<unknown> {
  const connection = await openCollectorProtection(profile, signal);
  if (!connection)
    throw new Error("Connect this Mac to its protected home library before updating");
  try {
    return await requestPairedHealth(pairedBase(connection.transport), connection.pairing, signal);
  } finally {
    await connection.transport.close();
  }
}

/** Collector admission uses its own least-authority credential, not the interactive grant. */
export async function probeDesktopRemoteProtection(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<DesktopRemoteProtection> {
  const connection = await openCollectorProtection(profile, signal);
  if (!connection) return "unavailable";
  try {
    return await readDesktopRemoteProtection(connection.transport, connection.pairing, signal);
  } finally {
    await connection.transport.close();
  }
}

/** A lost proof stops collection; reconnect admission must obtain fresh evidence before another child starts. */
export async function watchDesktopRemoteProtection(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<void> {
  const connection = await openCollectorProtection(profile, signal);
  if (!connection) return;
  try {
    while (!signal.aborted) {
      await delay(5_000, undefined, { signal });
      if (
        (await readDesktopRemoteProtection(connection.transport, connection.pairing, signal)) !==
        "encrypted"
      )
        return;
    }
  } finally {
    await connection.transport.close();
  }
}

async function openCollectorProtection(profile: DesktopProfile, signal: AbortSignal) {
  signal.throwIfAborted();
  const options = {
    configDir: profile.configDir,
    service: profile.secretService,
    backend: "macos-keychain" as const,
  };
  const pairing = await readPairedDeviceFile(
    join(profile.configDir, "cloud-relay", "collector-device.json"),
    options,
  );
  const token = await readSecretTextFile(join(profile.configDir, "collector-token"), options);
  if (pairing.kind !== "collector" || token?.trim() !== pairing.token) return undefined;
  const { runRelayCommand, saveDirectCandidates } = await import("@omnesis/cloud-relay/runtime");
  const transport = await runRelayCommand(
    "client",
    {
      ...desktopEnvironment(profile),
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: join(
        profile.configDir,
        "cloud-relay",
        "collector-device.json",
      ),
      OMNESIS_CLOUD_RELAY_DEVICE_KIND: "collector",
      OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
      OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1",
    },
    {
      persistDirectCandidates: (...args) =>
        publishDesktopHint(profile, () => saveDirectCandidates(...args)),
    },
  );
  if (!transport?.gatewayUrl) {
    await transport?.close();
    return undefined;
  }
  return { transport, pairing };
}
