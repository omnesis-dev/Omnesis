// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  classifySecureMarker,
  defaultSecretCommandRunner,
  inspectInstallRootKey,
  openRecoveryEnvelopeAsync,
  parseRecoveryEnvelope,
  readInstallRootKey,
  readMarkerKeyringState,
  restoreInstallRootKeyIfAbsent,
  secureMarkerPath,
  setMarkerKeyringState,
  type SecureMarkerKind,
} from "@omnesis/core";
import { readDesktopInstall } from "./bootstrap.js";
import { withDesktopKeyRecoveryAdmission } from "./recovery-import-admission.js";
import { desktopRootIdentity, sameDesktopRoot } from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRecoveryImportOutcome {
  kind: "desktopRecoveryImport";
  status: "restored" | "already-available";
}
interface ImportDependencies {
  inspect: typeof inspectInstallRootKey;
  read: typeof readInstallRootKey;
  insert: typeof restoreInstallRootKeyIfAbsent;
  mirror: typeof setMarkerKeyringState;
  readMirror: typeof readMarkerKeyringState;
}
const defaults: ImportDependencies = {
  inspect: inspectInstallRootKey,
  read: readInstallRootKey,
  insert: restoreInstallRootKeyIfAbsent,
  mirror: setMarkerKeyringState,
  readMirror: readMarkerKeyringState,
};
const markerKinds: readonly SecureMarkerKind[] = ["storage-encryption", "secret-files"];

/** Import never creates key material or replaces an existing Keychain item. */
export class DesktopRecoveryImportService {
  private readonly deps: ImportDependencies;
  constructor(
    private readonly profile: DesktopProfile,
    dependencies: Partial<ImportDependencies> = {},
  ) {
    this.deps = { ...defaults, ...dependencies };
  }

  async restore(
    rawEnvelope: unknown,
    recoveryCode: string,
    signal: AbortSignal,
  ): Promise<DesktopRecoveryImportOutcome> {
    if (
      recoveryCode.length === 0 ||
      recoveryCode.length > 512 ||
      Buffer.byteLength(JSON.stringify(rawEnvelope) ?? "") > 16_384
    )
      throw new Error("Choose a recovery file and enter its recovery code.");
    const envelope = parseRecoveryEnvelope(rawEnvelope);
    if (!envelope) throw new Error("This is not a supported Omnesis recovery file.");
    signal.throwIfAborted();
    return withDesktopKeyRecoveryAdmission(this.profile, signal, async (admission) => {
      const install = await readDesktopInstall(this.profile);
      if (!install || install.phase !== "configured" || install.mode !== "home")
        throw new Error("Restore recovery protection on the Mac that owns this library.");
      const root = await desktopRootIdentity(this.profile);
      if (!root) throw new Error("The managed library is unavailable.");
      const candidate = await openRecoveryEnvelopeAsync(envelope, recoveryCode);
      signal.throwIfAborted();
      const markers = await this.markers(candidate);
      admission.assertKey(candidate);
      const assertMutation = async () => {
        await admission.assertCurrent();
        const current = await this.markers(candidate);
        if (current.some((value, index) => value !== markers[index]))
          throw new Error("The library protection changed. Start recovery again.");
      };
      const options = {
        backend: "macos-keychain" as const,
        configDir: this.profile.configDir,
        service: this.profile.secretService,
        runCommand: async (...args: Parameters<typeof defaultSecretCommandRunner>) => {
          if (args[1][0] === "add-generic-password") await assertMutation();
          return defaultSecretCommandRunner(args[0], args[1], {
            ...args[2],
            keyRecovery: admission.context,
          });
        },
      };
      const state = await this.deps.inspect(options);
      if (!state.store.available || !state.store.secure || state.store.backend !== "macos-keychain")
        throw new Error("Unlock the macOS Keychain and try recovery again.");
      const existing = await this.deps.read(options);
      if (state.present && !state.valid)
        throw new Error(
          "An existing Keychain entry cannot be read. Unlock your Mac; recovery will not replace it.",
        );
      if (existing !== null && existing !== candidate)
        throw new Error(
          "This Mac already has a different library key. Recovery will not replace it.",
        );
      const currentRoot = await desktopRootIdentity(this.profile);
      if (!currentRoot || !sameDesktopRoot(root, currentRoot))
        throw new Error("The managed library changed. Start recovery again.");
      const currentMarkers = await this.markers(candidate);
      if (markers.some((value, index) => value !== currentMarkers[index]))
        throw new Error("The library protection changed. Start recovery again.");
      signal.throwIfAborted();
      if (existing === null) {
        await assertMutation();
        await this.deps.insert(candidate, options);
      }
      // Insertion is the commit point. Finish the required-encryption mirrors
      // even if cancellation arrives afterward; never roll back a recovered key.
      if ((await this.deps.read(options)) !== candidate)
        throw new Error("The recovered Keychain entry could not be confirmed.");
      await this.markers(candidate);
      for (const kind of markerKinds) {
        await assertMutation();
        await this.deps.mirror(kind, options);
        if ((await this.deps.readMirror(kind, options)) !== "required")
          throw new Error("Recovery needs another check. Keep your recovery file and retry.");
      }
      await assertMutation();
      return {
        kind: "desktopRecoveryImport",
        status: existing === null ? "restored" : "already-available",
      };
    });
  }

  private async markers(key: string): Promise<string[]> {
    const result: string[] = [];
    for (const kind of markerKinds) {
      const path = secureMarkerPath(kind, this.profile.configDir);
      const parent = await lstat(dirname(path));
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (parent.mode & 0o077) !== 0 ||
        (process.getuid && parent.uid !== process.getuid()) ||
        (await realpath(dirname(path))) !== resolve(dirname(path))
      )
        throw new Error(
          "Restore the library's original protection files before recovering its key.",
        );
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 4096 ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error("The library protection file is unsafe.");
        const data = await file.read(Buffer.alloc(4097), 0, 4097, 0);
        if (data.bytesRead > 4096) throw new Error("The library protection file is too large.");
        const raw = data.buffer.subarray(0, data.bytesRead).toString("utf8");
        if (classifySecureMarker(kind, raw, key) !== "valid")
          throw new Error(
            "This recovery file does not match this library's protection. Keep the existing files and choose the matching recovery file.",
          );
        result.push(raw);
      } finally {
        await file.close();
      }
    }
    return result;
  }
}
