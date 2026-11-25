// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { hostname, totalmem } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  inspectInstallRootKey,
  readCollectorPairingState,
  tokenFingerprint,
  readSecretTextFile,
  writeSecretTextFile,
  resolveSubprocessEntry,
  secretFileEncryptionRequired,
  storageEncryptionRequired,
} from "@omnesis/core";
import {
  installationRelayUrl,
  readPairedDeviceFile,
  savePairedDeviceFile,
} from "@omnesis/cloud-relay";
import { prepareDesktopInstall, readDesktopInstall } from "./bootstrap.js";
import { desktopSearchModel } from "./search-model.js";
import { previewDesktopRemoval, removeDesktopInstall, resumeRetiredDesktop } from "./removal.js";
import { readDesktopRetirement } from "./retirement.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { prepareDesktopRuntime } from "./runtime-state.js";
import { readDesktopConnection, requestDesktopGateway } from "./gateway-access.js";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { discoverDesktopHomes } from "./discovery.js";
import { enrollDesktopRole, type DesktopPairing } from "./enrollment.js";
import { connectDesktopAccount } from "./account-connect.js";
import { withDesktopPublication, publishDesktopHint } from "./publication.js";

export interface DesktopSessionTransport {
  url: string;
  gatewayUrl?: string;
  close(): Promise<void>;
}
export interface CoordinatorDependencies {
  publish: typeof withDesktopPublication;
  readInstall: typeof readDesktopInstall;
  prepareInstall: typeof prepareDesktopInstall;
  prepareRuntime: typeof prepareDesktopRuntime;
  connection: typeof readDesktopConnection;
  request: typeof requestDesktopGateway;
  discover: typeof discoverDesktopHomes;
  enroll: typeof enrollDesktopRole;
  connectAccount: typeof connectDesktopAccount;
  searchModel: typeof desktopSearchModel;
  readPair: typeof readPairedDeviceFile;
  savePair: typeof savePairedDeviceFile;
  readToken: typeof readSecretTextFile;
  saveToken: typeof writeSecretTextFile;
  protected(profile: DesktopProfile): Promise<boolean>;
  localCollectorDeviceId(profile: DesktopProfile): Promise<string | undefined>;
  startDaemon(profile: DesktopProfile): Promise<void>;
  stopDaemon: typeof stopDesktopDaemon;
  readRetirement: typeof readDesktopRetirement;
  resumeRetirement: typeof resumeRetiredDesktop;
  removalPreview: typeof previewDesktopRemoval;
  removeInstall: typeof removeDesktopInstall;
  startTransport(profile: DesktopProfile): Promise<DesktopSessionTransport>;
  verifyTransport(
    transport: DesktopSessionTransport,
    pairing: DesktopPairing,
    signal: AbortSignal,
  ): Promise<void>;
  relayUrl(): string | undefined;
  memoryBytes(): number;
  name(): string;
  sleep(signal: AbortSignal): Promise<void>;
}
export const desktopCoordinatorDefaults: CoordinatorDependencies = {
  publish: withDesktopPublication,
  readInstall: readDesktopInstall,
  prepareInstall: prepareDesktopInstall,
  prepareRuntime: prepareDesktopRuntime,
  connection: readDesktopConnection,
  request: requestDesktopGateway,
  discover: discoverDesktopHomes,
  enroll: enrollDesktopRole,
  connectAccount: connectDesktopAccount,
  searchModel: desktopSearchModel,
  readPair: readPairedDeviceFile,
  savePair: savePairedDeviceFile,
  readToken: readSecretTextFile,
  saveToken: writeSecretTextFile,
  protected: async (profile) => {
    if (
      !secretFileEncryptionRequired(profile.configDir) ||
      !storageEncryptionRequired(profile.configDir)
    )
      return false;
    const key = await inspectInstallRootKey({
      configDir: profile.configDir,
      service: profile.secretService,
      backend: "macos-keychain",
    });
    return key.valid && key.store.secure && key.store.backend === "macos-keychain";
  },
  localCollectorDeviceId: async (profile) => {
    const state = readCollectorPairingState(profile.configDir);
    const token = await readSecretTextFile(join(profile.configDir, "collector-token"), {
      configDir: profile.configDir,
      service: profile.secretService,
      backend: "macos-keychain",
    });
    if (
      !state ||
      state.state !== "paired" ||
      !token ||
      state.tokenFingerprint !== tokenFingerprint(token.trim())
    )
      return undefined;
    return z.string().uuid().safeParse(state.deviceId).success ? state.deviceId : undefined;
  },
  stopDaemon: stopDesktopDaemon,
  readRetirement: readDesktopRetirement,
  resumeRetirement: resumeRetiredDesktop,
  removalPreview: previewDesktopRemoval,
  removeInstall: removeDesktopInstall,
  startDaemon: async (profile) => {
    const entry = resolveSubprocessEntry("../index.ts", import.meta.url);
    const env = desktopEnvironment(profile);
    env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
    const child = spawn(entry.command, [...entry.args, "desktop", "daemon"], {
      env,
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  },
  startTransport: async (profile) => {
    const { runRelayCommand } = await import("@omnesis/cloud-relay/runtime");
    const transport = await runRelayCommand(
      "client",
      {
        ...desktopEnvironment(profile),
        OMNESIS_CLOUD_RELAY_DEVICE_FILE: join(profile.configDir, "cloud-relay", "cli-device.json"),
        OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
        OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1",
      },
      {
        persistDirectCandidates: async (...args) => {
          const { saveDirectCandidates } = await import("@omnesis/cloud-relay/runtime");
          await publishDesktopHint(profile, () => saveDirectCandidates(...args));
        },
      },
    );
    if (!transport?.gatewayUrl) {
      await transport?.close();
      throw new Error("The paired connection is unavailable");
    }
    return { ...transport, gatewayUrl: transport.gatewayUrl };
  },
  verifyTransport: async (transport, pairing, signal) => {
    const base = new URL(transport.url);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      base.username ||
      base.password
    )
      throw new Error("Invalid paired connection");
    const response = await fetch(new URL("/whoami", base), {
      headers: { authorization: `Bearer ${pairing.token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("The paired device is no longer authorized");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!response.body) throw new Error("Invalid paired identity");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 65_536) throw new Error("Invalid paired identity");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const identity = z.object({ deviceId: z.string() }).parse(JSON.parse(body));
    if (identity.deviceId !== pairing.deviceId)
      throw new Error("The paired device identity changed");
  },
  relayUrl: () => installationRelayUrl(process.env),
  memoryBytes: totalmem,
  name: hostname,
  sleep: async (signal) => {
    await delay(1000, undefined, { signal });
  },
};
