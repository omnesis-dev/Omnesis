// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Omnesis-wrapped Baileys multi-file auth state.
 *
 * This mirrors Baileys' `useMultiFileAuthState` shape and filenames, but all
 * reads/writes go through `secret-file.ts` so a configured install root key
 * wraps the Signal/auth fragments instead of leaving them as plaintext JSON.
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { atomicWriteFile, readSecretTextFile, writeSecretTextFile } from "@omnesis/core";

const fileLocks = new Map<string, Promise<void>>();
const folderOperations = new Map<string, Set<Promise<void>>>();
const quiescingFolders = new Set<string>();
const AUTH_FILE_RE =
  /^(?:creds|(?:pre-key|session|sender-key|sender-key-memory|app-state-sync-key|app-state-sync-version|lid-mapping|device-list|tctoken|identity-key)-.+)\.json$/;
const LOCK_TIMEOUT_MS = 5 * 60_000;
const OWNER_GRACE_MS = 5_000;

export class WhatsAppPairingSupersededError extends Error {
  constructor() {
    super("WhatsApp pairing was superseded by a newer session");
    this.name = "WhatsAppPairingSupersededError";
  }
}

function generationPath(folder: string): string {
  return `${folder}.generation`;
}

/** A durable logout verdict; only current auth writers may change it. */
export async function isOmnesisAuthUnlinked(folder: string): Promise<boolean> {
  try {
    const verdict = (await readFile(`${folder}.unlinked`, "utf8")).trim();
    if (verdict !== "unlinked") throw new Error("Unrecognized linked-device status marker");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sealedPath(folder: string): string {
  return `${folder}.sealed`;
}

function pairingOrderPath(folder: string): string {
  return `${folder}.pairing-order`;
}

export function createWhatsAppPairingOrder(): string {
  return `${Date.now().toString().padStart(13, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}`;
}

async function readGeneration(folder: string): Promise<string | null> {
  try {
    const value = (await readFile(generationPath(folder), "utf8")).trim();
    return value || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function rotateGeneration(folder: string): Promise<string> {
  const generation = randomUUID();
  await atomicWriteFile(generationPath(folder), generation, { mode: 0o600, ensureDir: true });
  return generation;
}

async function ensureGeneration(folder: string): Promise<string> {
  return (await readGeneration(folder)) ?? rotateGeneration(folder);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function discardStaleLock(lockPath: string): Promise<boolean> {
  let stale: boolean;
  try {
    const [pidText] = (await readlink(lockPath)).split("-");
    const pid = Number(pidText);
    stale = Number.isSafeInteger(pid) && pid > 0 && !processIsAlive(pid);
  } catch {
    try {
      stale = Date.now() - (await lstat(lockPath)).mtimeMs >= OWNER_GRACE_MS;
    } catch {
      return true;
    }
  }
  if (!stale) return false;

  const discarded = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, discarded);
    await rm(discarded, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function withAuthDirectoryLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${folder}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      // Symlink creation publishes complete ownership in one atomic operation;
      // contenders never observe the ownerless lock window a directory had.
      await symlink(owner, lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await discardStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for WhatsApp auth lock", { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if ((await readlink(lockPath)) === owner) await unlink(lockPath);
    } catch {
      /* another recovery path already removed it */
    }
  }
}

function trackFolderWrite(folder: string, fn: () => Promise<void>): Promise<void> {
  if (quiescingFolders.has(folder)) return Promise.resolve();
  const operation = fn();
  const operations = folderOperations.get(folder) ?? new Set<Promise<void>>();
  operations.add(operation);
  folderOperations.set(folder, operations);
  const forget = (): void => {
    operations.delete(operation);
    if (operations.size === 0) folderOperations.delete(folder);
  };
  void operation.then(forget, forget);
  return operation;
}

/** Stop new writes from this auth-state generation, then drain every write already in flight. */
export async function quiesceOmnesisMultiFileAuthState(folder: string): Promise<void> {
  quiescingFolders.add(folder);
  await Promise.all([...(folderOperations.get(folder) ?? [])]);
  await withAuthDirectoryLock(folder, () => rotateGeneration(folder));
  await Promise.all(
    [...fileLocks.entries()]
      .filter(([path]) => dirname(path) === folder)
      .map(([, pending]) => pending),
  );
}

/** Quiesce a staging auth set and prevent every process from opening a new writer on it. */
export async function sealOmnesisMultiFileAuthState(folder: string): Promise<void> {
  quiescingFolders.add(folder);
  await Promise.all([...(folderOperations.get(folder) ?? [])]);
  await withAuthDirectoryLock(folder, async () => {
    await rotateGeneration(folder);
    await atomicWriteFile(sealedPath(folder), "sealed", { mode: 0o600, ensureDir: true });
  });
  await Promise.all(
    [...fileLocks.entries()]
      .filter(([path]) => dirname(path) === folder)
      .map(([, pending]) => pending),
  );
}

function isKeyPair(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const pair = value as { public?: unknown; private?: unknown };
  return pair.public instanceof Uint8Array && pair.private instanceof Uint8Array;
}

/**
 * Why a staged credentials file does not identify a paired account.
 *
 * Returns the failing checks rather than a boolean: a pairing that is refused
 * deletes its own directory as it unwinds, so a verdict with no reason leaves
 * nothing to diagnose from and costs the operator another scan to learn one
 * fact. The required-key sweep reads its list from the installed Baileys, so it
 * follows the library rather than restating it.
 */
function authenticationCredsProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["not an object"];
  const creds = value as Record<string, unknown>;
  const problems: string[] = [];
  const missing = Object.entries(initAuthCreds())
    .filter(([key, requiredValue]) => requiredValue !== undefined && !Object.hasOwn(creds, key))
    .map(([key]) => key);
  if (missing.length > 0) problems.push(`missing ${missing.join(", ")}`);

  const me = creds.me as { id?: unknown } | undefined;
  const signedPreKey = creds.signedPreKey as
    | { keyPair?: unknown; signature?: unknown; keyId?: unknown }
    | undefined;
  const checks: Array<[string, boolean]> = [
    ["me.id", typeof me?.id === "string" && me.id.length > 0],
    ["registrationId", typeof creds.registrationId === "number"],
    ["advSecretKey", typeof creds.advSecretKey === "string"],
    ["firstUnuploadedPreKeyId", typeof creds.firstUnuploadedPreKeyId === "number"],
    ["nextPreKeyId", typeof creds.nextPreKeyId === "number"],
    ["accountSyncCounter", typeof creds.accountSyncCounter === "number"],
    ["processedHistoryMessages", Array.isArray(creds.processedHistoryMessages)],
    [
      "accountSettings.unarchiveChats",
      isRecord(creds.accountSettings) && typeof creds.accountSettings.unarchiveChats === "boolean",
    ],
    ["noiseKey", isKeyPair(creds.noiseKey)],
    ["pairingEphemeralKeyPair", isKeyPair(creds.pairingEphemeralKeyPair)],
    ["signedIdentityKey", isKeyPair(creds.signedIdentityKey)],
    ["signedPreKey.keyPair", isKeyPair(signedPreKey?.keyPair)],
    ["signedPreKey.signature", signedPreKey?.signature instanceof Uint8Array],
    ["signedPreKey.keyId", typeof signedPreKey?.keyId === "number"],
  ];
  for (const [name, ok] of checks) if (!ok) problems.push(name);
  return problems;
}

const SIGNAL_FILE_TYPES = [
  "app-state-sync-version",
  "app-state-sync-key",
  "sender-key-memory",
  "identity-key",
  "device-list",
  "sender-key",
  "lid-mapping",
  "pre-key",
  "tctoken",
  "session",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What a rejected fragment looked like, in terms safe to put in an error.
 *
 * Names the shape and, for an object, its own property names — never a value.
 * Signal fragments are key material, so the only thing that may leave this
 * module is structure. Without it a rejection says a fragment was wrong and
 * not which one or how, which is unactionable on a machine where the auth
 * directory is deleted as the flow unwinds.
 */
function describeFragmentShape(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `Uint8Array(${value.byteLength})`;
  if (Array.isArray(value)) {
    const kinds = [...new Set(value.map((entry) => typeof entry))].sort();
    return `array(${value.length})<${kinds.join("|") || "empty"}>`;
  }
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const shown = keys.slice(0, 12);
  const types = shown.map(
    (key) => `${key}:${describeFragmentValueKind((value as Record<string, unknown>)[key])}`,
  );
  return `object{${types.join(", ")}${keys.length > shown.length ? ", …" : ""}}`;
}

function describeFragmentValueKind(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return "Uint8Array";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Whether an app-state sync key still carries usable key material.
 *
 * Alone among the fragments this is a protobuf message, not a plain object, so
 * `JSON.stringify` calls its own `toJSON` before `BufferJSON.replacer` can see
 * anything: a `bytes` field is written as a base64 string, never as a wrapped
 * Buffer. Checking the field's runtime type would therefore reject every key
 * this module has ever written.
 *
 * So the question asked is the one that matters — can the reader turn this back
 * into a key? — through the exact call the reader makes. That also stops the
 * check drifting from the format again: there is no second description of the
 * shape to keep in step.
 */
function hasRehydratableKeyData(value: Record<string, unknown>): boolean {
  try {
    const { keyData } = proto.Message.AppStateSyncKeyData.fromObject(value);
    return keyData instanceof Uint8Array && keyData.byteLength > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a staged fragment is something this module can hand back to Baileys.
 *
 * Deliberately not a per-type shape check. Exactly two fragments have a shape
 * Omnesis itself depends on: credentials, checked separately above, and an
 * app-state sync key, which this module rehydrates through protobuf before
 * returning it. Everything else is libsignal's own state — written by its
 * `serialize()`, read by its `deserialize()`, never inspected in between.
 *
 * A table describing those shapes is a second copy of a third-party format that
 * moves between releases, and it was wrong in both directions at once: it
 * demanded a `Uint8Array` for a session that libsignal serialises as
 * `{_sessions, version}`, and for key material the protobuf writes as base64.
 * Both are valid state, and refusing them fails the pairing outright. Rejecting
 * a good pairing is the one outcome this gate must never produce; an odd
 * fragment it lets through is refused later by the reader that actually needs
 * to understand it.
 *
 * Note that Baileys' own `SignalDataTypeMap` types a session as `Uint8Array`,
 * which is where the mistaken table came from. The runtime stores what
 * `SessionRecord.serialize()` returns, so the declaration cannot be trusted as
 * a description of what reaches disk.
 */
function isValidSignalFragment(filename: string, value: unknown): boolean {
  const type = SIGNAL_FILE_TYPES.find((candidate) => filename.startsWith(`${candidate}-`));
  if (type === undefined) return false;
  // A fragment that parsed to nothing carries no state; the writer deletes a
  // key rather than storing a null, so this is a corrupt file rather than one
  // whose shape simply moved.
  if (value === null || value === undefined) return false;
  if (type === "app-state-sync-key") return isRecord(value) && hasRehydratableKeyData(value);
  return true;
}

async function assertSafeAuthDirectory(folder: string, configDir: string): Promise<void> {
  const whatsappRoot = join(configDir, "whatsapp");
  const rel = relative(whatsappRoot, folder);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("WhatsApp auth directory is outside the configured provider root");
  }
  for (const path of new Set([whatsappRoot, dirname(folder), folder])) {
    const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error("WhatsApp auth path contains an unsafe filesystem entry");
    }
  }
}

/**
 * Copy a complete, readable Baileys auth set into its permanent path. Each
 * wrapped file is decrypted at the staging path and freshly encrypted at the
 * destination; wrapped files are never renamed.
 */
export async function promoteOmnesisMultiFileAuthState(
  folder: string,
  destinationFolder: string,
  configDir: string,
  pairingOrder = createWhatsAppPairingOrder(),
): Promise<void> {
  await assertSafeAuthDirectory(folder, configDir);
  await assertSafeAuthDirectory(destinationFolder, configDir);
  const entries = await readdir(folder, { withFileTypes: true });
  if (!entries.some((entry) => entry.isFile() && entry.name === "creds.json")) {
    throw new Error("WhatsApp auth state is incomplete or contains unexpected entries");
  }

  // Every entry is inspected before any verdict. A pairing that is refused
  // takes its staging directory with it, so reporting only the first problem
  // costs one whole scan — the operator rescans, and learns the next fact.
  const files: Array<{ name: string; raw: string }> = [];
  const rejections: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !AUTH_FILE_RE.test(entry.name)) {
      rejections.push(`${entry.name}: not a recognised auth file`);
      continue;
    }
    const raw = await withFileLock(join(folder, entry.name), () =>
      readSecretTextFile(join(folder, entry.name), { configDir }),
    );
    if (raw === null) {
      rejections.push(`${entry.name}: unreadable`);
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw, BufferJSON.reviver) as unknown;
    } catch {
      rejections.push(`${entry.name}: invalid JSON`);
      continue;
    }
    if (entry.name === "creds.json") {
      const problems = authenticationCredsProblems(value);
      if (problems.length > 0) rejections.push(`creds.json: ${problems.join("; ")}`);
    } else if (!isValidSignalFragment(entry.name, value)) {
      rejections.push(`${entry.name}: ${describeFragmentShape(value)}`);
    }
    files.push({ name: entry.name, raw });
  }
  if (rejections.length > 0) {
    throw new Error(`WhatsApp auth state cannot be promoted — ${rejections.join(" | ")}`);
  }

  const credentials = files.find((file) => file.name === "creds.json");
  if (!credentials) {
    throw new Error("WhatsApp auth state is incomplete or contains unexpected entries");
  }
  const fragments = files.filter((file) => file !== credentials);
  const sourceNames = new Set(files.map((file) => file.name));

  await withAuthDirectoryLock(destinationFolder, async () => {
    const committedOrder = await readFile(pairingOrderPath(destinationFolder), "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      },
    );
    if (committedOrder !== null && committedOrder.trim() > pairingOrder) {
      throw new WhatsAppPairingSupersededError();
    }

    await mkdir(destinationFolder, { recursive: true, mode: 0o700 });
    await rotateGeneration(destinationFolder);
    const destinationCredentials = join(destinationFolder, credentials.name);
    try {
      // Hide any old commit marker before changing its fragments. The QR has
      // already invalidated those credentials; leaving them visible would make
      // a partial mixed set look like a usable account after a crash.
      await unlink(destinationCredentials).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      for (const file of fragments) {
        const destination = join(destinationFolder, file.name);
        const info = await stat(destination).catch(() => null);
        if (info && !info.isFile()) await rm(destination, { recursive: true, force: true });
        await writeSecretTextFile(destination, file.raw, { configDir });
      }
      for (const entry of await readdir(destinationFolder, { withFileTypes: true })) {
        if (AUTH_FILE_RE.test(entry.name) && !sourceNames.has(entry.name)) {
          await rm(join(destinationFolder, entry.name), { recursive: true, force: true });
        }
      }
      for (const file of fragments) {
        const reopened = await readSecretTextFile(join(destinationFolder, file.name), {
          configDir,
        });
        if (reopened !== file.raw) {
          throw new Error("Promoted WhatsApp auth state failed verification");
        }
      }
      // Commit freshness before making the account visible. If the process dies
      // after this write, an older concurrent pairing cannot replace the newer
      // recoverable staging state.
      await atomicWriteFile(pairingOrderPath(destinationFolder), pairingOrder, {
        mode: 0o600,
        ensureDir: true,
      });
      // `discoverAccounts()` treats creds.json as the commit marker. Write it
      // last so a failed or interrupted promotion never advertises partial state.
      await writeSecretTextFile(destinationCredentials, credentials.raw, { configDir });
      const reopenedCredentials = await readSecretTextFile(destinationCredentials, { configDir });
      if (reopenedCredentials !== credentials.raw) {
        throw new Error("Promoted WhatsApp auth state failed verification");
      }
      await rm(`${destinationFolder}.unlinked`, { force: true });
    } catch (err) {
      await unlink(destinationCredentials).catch(() => undefined);
      throw err;
    }
  });

  const reopened = await useOmnesisMultiFileAuthState(destinationFolder, configDir);
  if (!reopened.state.creds.me?.id) {
    throw new Error("Promoted WhatsApp auth credentials could not be reopened");
  }
}

export async function useOmnesisMultiFileAuthState(
  folder: string,
  configDir: string,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  setLinkedState: (linked: boolean) => Promise<void>;
}> {
  const folderInfo = await stat(folder).catch(() => undefined);
  if (folderInfo) {
    if (!folderInfo.isDirectory()) {
      throw new Error(
        `found something that is not a directory at ${folder}, either delete it or specify a different location`,
      );
    }
  } else {
    await mkdir(folder, { recursive: true });
  }

  quiescingFolders.delete(folder);
  const generation = await withAuthDirectoryLock(folder, async () => {
    if (existsSync(sealedPath(folder))) throw new Error("WhatsApp auth state is sealed");
    return ensureGeneration(folder);
  });
  const isCurrent = async (): Promise<boolean> => (await readGeneration(folder)) === generation;

  const writeData = async (data: unknown, file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file));
    await withFileLock(filePath, () =>
      writeSecretTextFile(filePath, JSON.stringify(data, BufferJSON.replacer), {
        configDir,
      }),
    );
  };

  const readData = async <T>(file: string): Promise<T | null> => {
    const filePath = join(folder, fixFileName(file));
    try {
      return await withFileLock(filePath, async () => {
        const raw = await readSecretTextFile(filePath, { configDir });
        if (raw === null) {
          if (existsSync(filePath)) {
            throw new Error(`Encrypted WhatsApp auth file is unreadable: ${filePath}`);
          }
          return null;
        }
        return JSON.parse(raw, BufferJSON.reviver) as T;
      });
    } catch (err) {
      if (existsSync(filePath)) throw err;
      return null;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file));
    await withFileLock(filePath, async () => {
      try {
        await unlink(filePath);
      } catch {
        /* already absent */
      }
    });
  };

  const creds =
    (await withAuthDirectoryLock(folder, () =>
      readData<AuthenticationState["creds"]>("creds.json"),
    )) || initAuthCreds();
  return {
    setLinkedState: (linked) =>
      trackFolderWrite(folder, () =>
        withAuthDirectoryLock(folder, async () => {
          if (!(await isCurrent())) return;
          const path = `${folder}.unlinked`;
          if (linked) await rm(path, { force: true });
          else await atomicWriteFile(path, "unlinked", { mode: 0o600, ensureDir: true });
        }),
      ),
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> =>
          withAuthDirectoryLock(folder, async () => {
            const data: Partial<{ [id: string]: SignalDataTypeMap[T] }> = {};
            if (!(await isCurrent())) return data as { [id: string]: SignalDataTypeMap[T] };
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData<SignalDataTypeMap[T]>(`${type}-${id}.json`);
                if (type === "app-state-sync-key" && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(
                    value as Record<string, unknown>,
                  ) as unknown as SignalDataTypeMap[T];
                }
                if (value) data[id] = value;
              }),
            );
            return data as { [id: string]: SignalDataTypeMap[T] };
          }),
        set: async (data: SignalDataSet): Promise<void> =>
          trackFolderWrite(folder, () =>
            withAuthDirectoryLock(folder, async () => {
              if (!(await isCurrent())) return;
              const tasks: Promise<void>[] = [];
              for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
                const entries = data[category];
                if (!entries) continue;
                for (const id of Object.keys(entries)) {
                  const value = entries[id];
                  const file = `${category}-${id}.json`;
                  tasks.push(value ? writeData(value, file) : removeData(file));
                }
              }
              await Promise.all(tasks);
            }),
          ),
      },
    },
    saveCreds: async () =>
      trackFolderWrite(folder, () =>
        withAuthDirectoryLock(folder, async () => {
          if (await isCurrent()) await writeData(creds, "creds.json");
        }),
      ),
  };
}

function fixFileName(file: string): string {
  return file.replace(/\//g, "__").replace(/:/g, "-");
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  fileLocks.set(path, current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(path) === current) {
      fileLocks.delete(path);
    }
  }
}
