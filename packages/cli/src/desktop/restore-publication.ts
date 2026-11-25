// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { omnesisConfigSchema } from "@omnesis/config";
import {
  atomicWriteFile,
  backupScopeEntryFor,
  BACKUP_STORE_NAMES,
  STORE_COMPANION_SUFFIXES,
  DERIVED_INDEX_FILE_PATTERN,
  GATEWAY_STORE_FILE,
  GATEWAY_INDEX_STORE_FILE,
  GATEWAY_ANALYTICS_STORE_FILE,
  WATCH_JOURNAL_FILENAME,
  isEncryptedSecretFile,
  secretFileScope,
  readStorageKey,
  readSecretTextFile,
  decodeSecretTextFileValue,
  type StorageKeyName,
} from "@omnesis/core";
import { inspectDesktopRestoredDatabase } from "@omnesis/gateway/restore";
import { pauseDesktopRestoreProcessing, DESKTOP_RESTORE_REVIEW_FILE } from "./restore-review.js";
import { readDesktopRestoreFile } from "./restore-files.js";
import { DesktopRestoreProtection } from "./restore-protection.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopBackupArchive } from "./restore-archive.js";
import type { DesktopRestoreEntries } from "./restore-entries.js";
import type { DesktopRestoreStoreKeys } from "./restore-store-keys.js";
import type { DesktopRestorePublication } from "./restore-transaction.js";

/** Fresh target authority and its model configuration are read only after quiescence. */
export async function buildDesktopRestorePublication(options: {
  profile: DesktopProfile;
  archive: DesktopBackupArchive;
  entries: DesktopRestoreEntries;
  keys: DesktopRestoreStoreKeys;
  directory: string;
  signal: AbortSignal;
}): Promise<DesktopRestorePublication> {
  const { profile, archive, entries, keys, directory, signal } = options;
  const stage = join(directory, "publication");
  await mkdir(stage, { mode: 0o700 });
  const place: Array<{ rel: string; from: string }> = [],
    retainedKeys = new Set<StorageKeyName>();
  const logical = new Map<string, string>();
  for (const name of archive.files.keys()) {
    const base = name.replace(/\.enc$/, "");
    if (logical.has(base)) throw new Error("The backup contains ambiguous logical entries");
    logical.set(base, name);
  }
  const main = logical.get(GATEWAY_STORE_FILE);
  if (main !== "omnesis.db" && main !== "omnesis.db.enc")
    throw new Error("The backup main database is unavailable");
  const destinationKey = (name: StorageKeyName): Buffer => {
    const key = keys.source(name) ?? keys.target(name);
    if (!key)
      throw new Error("A required encrypted store key is missing; no replacement key was created");
    if (keys.source(name)) retainedKeys.add(name);
    return key;
  };
  const mainKey = destinationKey("main-db"),
    mainPath = join(stage, GATEWAY_STORE_FILE);
  const result = await entries.prepareMain(main, {
    sourceKey: keys.source("main-db"),
    sourceCipherPath: join(directory, "main-source.enc"),
    targetPath: join(profile.configDir, GATEWAY_STORE_FILE),
    targetKey: keys.target("main-db")!,
    destinationPath: mainPath,
    destinationKey: mainKey,
  });
  place.push({ rel: GATEWAY_STORE_FILE, from: mainPath });
  let watchesPaused = 0;
  for (const spec of [
    { name: WATCH_JOURNAL_FILENAME, key: "watch2-db", kind: "watch" },
    { name: GATEWAY_ANALYTICS_STORE_FILE, key: "analytics-db", kind: "analytics" },
  ] as const) {
    signal.throwIfAborted();
    const name = logical.get(spec.name);
    if (!name) continue;
    const restored = await entries.prepareAuxiliary(name, {
      kind: spec.kind,
      sourceKey: keys.source(spec.key),
      sourceCipherPath: join(directory, `${spec.kind}-source.enc`),
      destinationPath: join(stage, spec.name),
      destinationKey: destinationKey(spec.key),
    });
    watchesPaused += restored.watchesPaused;
    place.push({ rel: spec.name, from: join(stage, spec.name) });
  }
  for (const name of retainedKeys) {
    const wrapped = keys.wrapped(name);
    if (!wrapped) throw new Error("A restored store has no sealed key record");
    place.push({ rel: wrapped.logical, from: wrapped.path });
  }
  const current = await readDesktopRestoreFile(
    join(profile.configDir, "omnesis.json"),
    1024 * 1024,
  );
  let config;
  try {
    config = omnesisConfigSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current)),
    );
  } finally {
    current.fill(0);
  }
  const incomingConfig = logical.get("omnesis.json");
  if (incomingConfig) {
    const raw = await entries.read(incomingConfig, 1024 * 1024);
    try {
      const incoming = omnesisConfigSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      );
      config = { ...config, sources: incoming.sources ?? {} };
    } finally {
      raw.fill(0);
    }
  } else config = { ...config, sources: {} };
  const paused = pauseDesktopRestoreProcessing(config);
  config = paused.config;
  const reviewPath = join(stage, DESKTOP_RESTORE_REVIEW_FILE);
  await atomicWriteFile(
    reviewPath,
    await entries.sealTarget(
      JSON.stringify(paused.review),
      secretFileScope(join(profile.configDir, DESKTOP_RESTORE_REVIEW_FILE), profile.configDir),
    ),
    { mode: 0o600 },
  );
  place.push({ rel: DESKTOP_RESTORE_REVIEW_FILE, from: reviewPath });
  const configPath = join(stage, "omnesis.json");
  await atomicWriteFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  place.push({ rel: "omnesis.json", from: configPath });
  const secrets: string[] = [DESKTOP_RESTORE_REVIEW_FILE];
  for (const [base, name] of logical) {
    signal.throwIfAborted();
    const scope = backupScopeEntryFor(base);
    if (
      /^[^/]+\/[^/]+\/credentials\.json$/u.test(base) &&
      new Set([
        "keyring",
        "tls",
        "cloud-relay",
        "config-secrets",
        "models",
        "logs",
        "backups",
        "exports",
        "sweeps",
        "conversations",
      ]).has(base.split("/")[0]!)
    )
      throw new Error("The backup credential path collides with managed installation state");
    const selected =
      base === "OMNESIS.md" ||
      (base.startsWith("sweeps/") && /^sweeps\/[^/]+\.md$/u.test(base)) ||
      (scope?.kind === "config" &&
        scope.name === base &&
        /(?:^|\/)credentials\.json$|-credentials\.json$/u.test(base));
    if (!selected && base.startsWith("sweeps/"))
      throw new Error("The backup contains unsupported sweep files; no prose was omitted");
    if (!selected) continue;
    const from = join(stage, base);
    await mkdir(dirname(from), { recursive: true, mode: 0o700 });
    await entries.prepareSecret(name, from);
    secrets.push(base);
    place.push({ rel: base, from });
  }
  const conversationFiles = [...logical].filter(([name]) => name.startsWith("conversations/"));
  if (conversationFiles.length && !archive.manifest.includesConversationHistory)
    throw new Error("The backup has conversation files without an authoritative history manifest");
  if (archive.manifest.includesConversationHistory) {
    await mkdir(join(stage, "conversations"), { mode: 0o700 });
    for (const [base, name] of conversationFiles) {
      signal.throwIfAborted();
      if (!/^conversations\/[A-Za-z0-9_-]{1,128}\.json$/u.test(base))
        throw new Error("The conversation identity is not portable");
      await entries.prepareConversation(name, join(stage, base));
      secrets.push(base);
    }
    place.push({ rel: "conversations", from: join(stage, "conversations") });
  }
  const incoming = new Set(place.map((item) => item.rel));
  const remove = await obsoleteData(profile, incoming, signal);
  const inspected = await inspectDesktopRestoredDatabase(
    { sourcePath: mainPath, sourceKey: mainKey },
    signal,
    profile,
  );
  const token = await readSecretTextFile(join(profile.configDir, "token"), {
    backend: "macos-keychain",
    service: profile.secretService,
    configDir: profile.configDir,
  });
  if (!token?.trim()) throw new Error("The target machine identity is unavailable");
  const tokenDigest = createHash("sha256").update(token.trim()).digest("hex");
  const protection = await DesktopRestoreProtection.capture(profile, signal);
  const identity = protection.identity();
  protection.close();
  return {
    review: {
      sourcesPaused: result.sourcesPaused,
      watchesPaused,
      previousLabChoices: result.targetLabs,
    },
    verification: {
      schemaVersion: inspected.schemaVersion,
      sources: inspected.sources,
      documents: inspected.documents,
      tokenDigest,
      configDigest: createHash("sha256")
        .update(await readDesktopRestoreFile(configPath, 1024 * 1024))
        .digest("hex"),
    },
    place,
    remove,
    sourcesPaused: result.sourcesPaused,
    watchesPaused,
    verify: async () => {
      const protectedNow = await DesktopRestoreProtection.capture(
        profile,
        new AbortController().signal,
      );
      try {
        if (!protectedNow.matchesProtection(identity))
          throw new Error("The target library protection changed");
      } finally {
        protectedNow.close();
      }
      const verified = await inspectDesktopRestoredDatabase(
        { sourcePath: join(profile.configDir, GATEWAY_STORE_FILE), sourceKey: mainKey },
        new AbortController().signal,
      );
      if (verified.sources !== result.sourcesPaused)
        throw new Error("The restored source inventory changed");
      for (const name of retainedKeys) {
        const actual = await readStorageKey(name, {
          backend: "macos-keychain",
          service: profile.secretService,
          configDir: profile.configDir,
        });
        try {
          if (!actual?.equals(keys.source(name)!)) throw new Error("A restored store key changed");
        } finally {
          actual?.fill(0);
        }
      }
      for (const rel of secrets) {
        const data = await readDesktopRestoreFile(join(profile.configDir, rel), 24 * 1024 * 1024);
        try {
          const raw = data.toString("utf8");
          if (!isEncryptedSecretFile(raw)) throw new Error("A restored secret is unprotected");
          await decodeSecretTextFileValue(join(profile.configDir, rel), raw, {
            backend: "macos-keychain",
            service: profile.secretService,
            configDir: profile.configDir,
          });
        } finally {
          data.fill(0);
        }
      }
    },
  };
}

async function obsoleteData(
  profile: DesktopProfile,
  incoming: Set<string>,
  signal: AbortSignal,
): Promise<string[]> {
  const remove: string[] = [];
  let count = 0;
  const candidates = new Set<string>([
    "OMNESIS.md",
    ...BACKUP_STORE_NAMES.flatMap((name) => [
      name,
      ...STORE_COMPANION_SUFFIXES.map((suffix) => `${name}${suffix}`),
    ]),
  ]);
  const skip = new Set([
    "keyring",
    "tls",
    "config-secrets",
    "models",
    "logs",
    "backups",
    "exports",
    "cloud-relay",
    "sweeps",
    "runtime-owner",
    "gateway-owner",
    "collector-owner",
  ]);
  const entries = await opendir(profile.configDir);
  for await (const entry of entries) {
    signal.throwIfAborted();
    if (++count > 16384) throw new Error("The target library contains too many restore entries");
    if (
      entry.isFile() &&
      (DERIVED_INDEX_FILE_PATTERN.test(entry.name) || /^[^/]+-credentials\.json$/u.test(entry.name))
    )
      candidates.add(entry.name);
    if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith(".")) continue;
    const accounts = await opendir(join(profile.configDir, entry.name));
    for await (const account of accounts) {
      if (++count > 16384) throw new Error("The target library contains too many restore entries");
      if (account.isDirectory()) candidates.add(`${entry.name}/${account.name}/credentials.json`);
    }
  }
  try {
    const sweeps = await opendir(join(profile.configDir, "sweeps"));
    for await (const entry of sweeps) {
      if (++count > 16384) throw new Error("The target library contains too many restore entries");
      if (entry.isFile() && /^[^/]+\.md$/u.test(entry.name)) candidates.add(`sweeps/${entry.name}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const rel of candidates) {
    if (incoming.has(rel)) continue;
    try {
      await lstat(join(profile.configDir, rel));
      remove.push(rel);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  // The incoming index is derived and its key never replaces this Mac's index key.
  if (incoming.has(GATEWAY_INDEX_STORE_FILE))
    throw new Error("A derived index cannot replace the target index");
  return remove;
}
