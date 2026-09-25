// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { defineCommand, runCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  ENCRYPTED_ARTIFACT_SUFFIX,
  SECRET_STORE_BACKENDS,
  atomicWriteFileSync,
  clearConfigSecretRefSync,
  createRecoveryEnvelope,
  decryptArtifactFileToFile,
  ensureInstallRootKey,
  ensurePrivateDirSync,
  generateRecoveryCode,
  inferenceBackendApiKeySecretName,
  openRecoveryEnvelope,
  readInstallRootKey,
  writeInstallRootKey,
  detectStorageKeyHosts,
  ensureStorageKey,
  inspectInstallRootKey,
  inspectStorageKey,
  isEncryptedArtifactFile,
  markSecretFileEncryptionRequired,
  markStorageEncryptionRequired,
  migrateSecretTextFile,
  parseConfigSecretRef,
  parseSecretStoreBackend,
  recoveryEnvelopePath,
  storageEncryptionRequired,
  storageKeyNamesForHosts,
  writeConfigSecretSync,
  type RecoveryEnvelopeV1,
  type SecretStoreBackend,
  type StorageKeyHost,
} from "@omnesis/core";
import { validateConfig } from "@omnesis/config";
import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR, isJSON } from "../utils.js";

function configDir(): string {
  return process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

function backendFromArg(raw: unknown): SecretStoreBackend {
  if (raw == null || raw === false || raw === "") {
    return parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE);
  }
  if (typeof raw !== "string") {
    throw new CliError("Invalid --backend value", EXIT_USER_ERROR);
  }
  try {
    return parseSecretStoreBackend(raw);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT_USER_ERROR);
  }
}

function backendArgs() {
  return {
    backend: {
      type: "string",
      description: `Secret-store backend (${SECRET_STORE_BACKENDS.join(", ")})`,
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  } as const;
}

function storageHostArgs() {
  return {
    ...backendArgs(),
    host: {
      type: "string",
      description:
        "Which process's live-storage keys: gateway, collector, or all (default: the processes this config directory serves; both when it serves none yet)",
    },
  } as const;
}

/**
 * The live-storage keys a storage subcommand works on. A gateway host owns
 * its databases' keys and a collector host owns its provider stores'; a
 * command run on a host that serves both, or on a fresh directory that
 * serves neither yet, covers both sets.
 */
function storageHostsFromArg(raw: unknown, dir: string): StorageKeyHost[] {
  if (raw == null || raw === false || raw === "") return detectStorageKeyHosts(dir);
  if (raw === "all") return ["gateway", "collector"];
  if (raw === "gateway" || raw === "collector") return [raw];
  throw new CliError(
    `Invalid --host: ${String(raw)} (expected gateway, collector, or all)`,
    EXIT_USER_ERROR,
  );
}

function restartHint(hosts: readonly StorageKeyHost[]): string {
  const names = hosts.map((host) => (host === "gateway" ? "the gateway" : "the collector"));
  return `Restart ${names.join(" and ")} to migrate live stores into encrypted files.`;
}

const keyringStatusCommand = defineCommand({
  meta: { name: "status", description: "Show OS keyring and Omnesis root-key status" },
  args: backendArgs(),
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    const state = await inspectInstallRootKey({ backend, configDir: configDir() });
    if (isJSON) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    console.log(`\n${c.bold}Omnesis keyring${c.reset}\n`);
    console.log(`  backend:  ${formatBackend(state.store.backend)}`);
    console.log(
      `  status:   ${state.store.available ? `${c.green}available${c.reset}` : `${c.yellow}unavailable${c.reset}`}`,
    );
    console.log(
      `  security: ${
        state.store.secure ? `${c.green}OS-backed${c.reset}` : `${c.yellow}not OS-backed${c.reset}`
      }`,
    );
    console.log(
      `  root key: ${
        state.valid
          ? `${c.green}initialized${c.reset}`
          : state.present
            ? `${c.yellow}present but invalid${c.reset}`
            : `${c.yellow}missing${c.reset}`
      }`,
    );
    console.log();
    console.log(`${c.dim}${state.store.detail}${c.reset}`);
    if (!state.valid) {
      console.log();
      console.log(`${c.dim}Run \`omnesis keyring init\` to create the install root key.${c.reset}`);
    }
  },
});

const keyringInitCommand = defineCommand({
  meta: { name: "init", description: "Create the Omnesis install root key in the keyring" },
  args: backendArgs(),
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    let result: Awaited<ReturnType<typeof ensureInstallRootKey>>;
    try {
      result = await ensureInstallRootKey({ backend, configDir: configDir() });
      await markSecretFileEncryptionRequired(configDir(), { backend });
      // Arm live-storage encryption immediately: once a root key exists the
      // gateway encrypts on next boot anyway, and the marker makes that
      // fail-closed from the start (a wrong or missing keyring passphrase at
      // boot must never quietly create a plaintext corpus beside a sealed key).
      await markStorageEncryptionRequired(configDir(), { backend });
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err), EXIT_FAILURE);
    }

    if (isJSON) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const action = result.created ? "Created" : "Found existing";
    const color = result.store.secure ? c.green : c.yellow;
    console.log(
      `${color}${action} Omnesis install root key${c.reset} ${c.dim}(${formatBackend(result.store.backend)})${c.reset}`,
    );
    if (!result.store.secure) {
      console.log(
        `${c.yellow}Warning:${c.reset} ${result.store.detail} Use this only as an explicit fallback.`,
      );
    }
  },
});

const keyringMigrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Encrypt existing Omnesis credential, token, auth-state, and config-secret files",
  },
  args: backendArgs(),
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    const dir = configDir();
    const state = await inspectInstallRootKey({ backend, configDir: dir });
    if (!state.valid) {
      throw new CliError(
        "Omnesis install root key is not initialized. Run `omnesis keyring init` first.",
        EXIT_USER_ERROR,
      );
    }

    await markSecretFileEncryptionRequired(dir, { backend });
    const candidates = collectSecretFileCandidates(dir);
    let present = 0;
    let encrypted = 0;
    let changed = 0;
    for (const path of candidates) {
      const result = await migrateSecretTextFile(path, { backend, configDir: dir });
      if (!result.present) continue;
      present += 1;
      if (result.encrypted) encrypted += 1;
      if (result.changed) changed += 1;
    }
    let inlineConfigKeys: InlineConfigApiKeyMigrationResult;
    try {
      inlineConfigKeys = migrateInlineConfigApiKeys(dir, { backend });
    } catch (err) {
      throw new CliError(
        `Failed to migrate inline config API keys: ${err instanceof Error ? err.message : String(err)}`,
        EXIT_FAILURE,
      );
    }

    const summary = {
      candidates: candidates.length,
      present,
      encrypted,
      changed,
      plaintextRemaining: present - encrypted,
      inlineConfigApiKeysMigrated: inlineConfigKeys.createdSecrets,
      inlineConfigApiKeysRemoved: inlineConfigKeys.removedInlineKeys,
    };
    if (isJSON) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(`\n${c.bold}Omnesis keyring migration${c.reset}\n`);
    console.log(`  scanned:             ${summary.candidates}`);
    console.log(`  existing secret files:${String(summary.present).padStart(2)}`);
    console.log(`  encrypted now:       ${summary.changed}`);
    console.log(`  encrypted total:     ${summary.encrypted}`);
    console.log(`  inline config keys:  ${summary.inlineConfigApiKeysRemoved} removed`);
    if (summary.plaintextRemaining > 0) {
      console.log(`  plaintext remaining: ${c.yellow}${summary.plaintextRemaining}${c.reset}`);
    } else {
      console.log(`  plaintext remaining: ${c.green}0${c.reset}`);
    }
    if (summary.changed > 0) {
      console.log();
      console.log(
        `${c.dim}Encrypted token files are no longer readable with cat; use \`omnesis devices pair\` or \`omnesis tokens create\` from this host when you need a fresh login token.${c.reset}`,
      );
    }
  },
});

const keyringDecryptArtifactCommand = defineCommand({
  meta: {
    name: "decrypt-artifact",
    description: "Decrypt Omnesis encrypted backup/export artifact files on this host",
  },
  args: {
    path: {
      type: "positional",
      description: "Encrypted artifact file or directory to decrypt",
      required: true,
    },
    output: {
      type: "string",
      description: "Output path for a single encrypted file",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing plaintext output files",
    },
    ...backendArgs(),
  },
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    const path = String(ctx.args.path ?? "");
    if (!path) throw new CliError("Missing artifact path", EXIT_USER_ERROR);

    let summary: ArtifactDecryptSummary;
    try {
      summary = await decryptArtifactPath(path, {
        backend,
        configDir: configDir(),
        outputPath: typeof ctx.args.output === "string" ? ctx.args.output : undefined,
        force: ctx.args.force === true,
      });
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err), EXIT_FAILURE);
    }

    if (isJSON) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`\n${c.bold}Omnesis artifact decrypt${c.reset}\n`);
    console.log(`  scanned:   ${summary.scanned}`);
    console.log(`  decrypted: ${summary.decrypted}`);
    console.log(`  skipped:   ${summary.skipped}`);
    for (const output of summary.outputs.slice(0, 20)) {
      console.log(`  ${c.dim}->${c.reset} ${output}`);
    }
    if (summary.outputs.length > 20) {
      console.log(`  ${c.dim}... ${summary.outputs.length - 20} more${c.reset}`);
    }
  },
});

const keyringStorageStatusCommand = defineCommand({
  meta: { name: "storage-status", description: "Show Omnesis live-storage key status" },
  args: storageHostArgs(),
  async run(ctx) {
    const dir = configDir();
    const hosts = storageHostsFromArg(ctx.args.host, dir);
    const state = {
      required: storageEncryptionRequired(dir),
      hosts,
      keyring: await inspectInstallRootKey({
        backend: backendFromArg(ctx.args.backend),
        configDir: dir,
      }),
      stores: await Promise.all(
        storageKeyNamesForHosts(hosts).map((keyName) =>
          inspectStorageKey(keyName, { configDir: dir }),
        ),
      ),
    };
    if (isJSON) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    console.log(`\n${c.bold}Omnesis live storage${c.reset}\n`);
    console.log(
      `  required: ${state.required ? `${c.green}yes${c.reset}` : `${c.yellow}no${c.reset}`}`,
    );
    console.log(
      `  root key: ${state.keyring.valid ? `${c.green}available${c.reset}` : `${c.yellow}unavailable${c.reset}`}`,
    );
    for (const store of state.stores) {
      const label =
        store.present && store.valid && store.encrypted
          ? `${c.green}wrapped${c.reset}`
          : store.present
            ? `${c.yellow}invalid${c.reset}`
            : `${c.yellow}missing${c.reset}`;
      console.log(`  ${store.keyName.padEnd(20)} ${label}`);
    }
  },
});

const keyringStorageInitCommand = defineCommand({
  meta: { name: "storage-init", description: "Create wrapped live-storage keys" },
  args: storageHostArgs(),
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    const dir = configDir();
    const hosts = storageHostsFromArg(ctx.args.host, dir);
    await ensureInstallRootKey({ backend, configDir: dir });
    const stores = [];
    for (const keyName of storageKeyNamesForHosts(hosts)) {
      stores.push(await ensureStorageKey(keyName, { backend, configDir: dir }));
    }
    // Converge the fail-closed marker to the current root key. `ensureStorageKey`
    // only arms it while creating a key, so this is what re-arms a marker that
    // was corrupted or lost after the keys already existed — the operator's
    // repair path for a boot that refused on a failed marker integrity check.
    await markStorageEncryptionRequired(dir, { backend });
    const summary = { required: storageEncryptionRequired(dir), hosts, stores };
    if (isJSON) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`\n${c.bold}Omnesis live storage keys${c.reset}\n`);
    for (const store of stores) {
      console.log(
        `  ${store.keyName.padEnd(20)} ${store.created ? `${c.green}created${c.reset}` : `${c.green}exists${c.reset}`}`,
      );
    }
    console.log();
    console.log(`${c.dim}${restartHint(hosts)}${c.reset}`);
  },
});

/**
 * Resolve the recovery code from --code or stdin. A piped code on stdin is
 * preferred so the secret does not sit in argv (visible to `ps`); --code is a
 * convenience for non-interactive callers. Shared with `omnesis restore`.
 */
export function resolveRecoveryCode(codeArg: unknown): string {
  if (typeof codeArg === "string" && codeArg.trim()) return codeArg.trim();
  if (process.stdin.isTTY) {
    throw new CliError(
      "Provide the recovery code with --code, or pipe it on stdin.",
      EXIT_USER_ERROR,
    );
  }
  try {
    const piped = readFileSync(0, "utf8").trim();
    if (piped) return piped;
  } catch {
    // no readable stdin
  }
  throw new CliError(
    "No recovery code provided (use --code or pipe it on stdin).",
    EXIT_USER_ERROR,
  );
}

const keyringExportRecoveryCommand = defineCommand({
  meta: {
    name: "export-recovery",
    description: "Generate a printable recovery code + envelope that can restore the root key",
  },
  args: {
    ...backendArgs(),
    out: {
      type: "string",
      description:
        "Path to write the recovery envelope (default: <config>/keyring/recovery-envelope.json)",
    },
    force: { type: "boolean", description: "Overwrite an existing recovery envelope" },
  },
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    const dir = configDir();
    const rootKey = await readInstallRootKey({ backend, configDir: dir });
    if (!rootKey) {
      throw new CliError(
        "No install root key found. Run `omnesis keyring init` first.",
        EXIT_USER_ERROR,
      );
    }
    const outPath =
      typeof ctx.args.out === "string" && ctx.args.out ? ctx.args.out : recoveryEnvelopePath(dir);
    if (existsSync(outPath) && ctx.args.force !== true) {
      throw new CliError(
        `A recovery envelope already exists at ${outPath}. Pass --force to replace it (which invalidates the previous recovery code).`,
        EXIT_USER_ERROR,
      );
    }
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(rootKey, code);
    ensurePrivateDirSync(join(dir, "keyring"));
    atomicWriteFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);

    if (isJSON) {
      console.log(JSON.stringify({ recoveryCode: code, envelopePath: outPath }, null, 2));
      return;
    }
    console.log(`\n${c.bold}Omnesis recovery code${c.reset}\n`);
    console.log(`    ${c.green}${code}${c.reset}\n`);
    console.log(
      `${c.yellow}Write this down and keep it offline — it is shown only once.${c.reset}`,
    );
    console.log("It is the only way to recover your encrypted data if you lose the OS keyring");
    console.log("(reinstall, dead disk, or a forgotten login password).");
    console.log(
      `${c.dim}Recovery envelope written to ${outPath} — safe to keep with your backups.${c.reset}`,
    );
  },
});

const keyringImportRecoveryCommand = defineCommand({
  meta: {
    name: "import-recovery",
    description: "Restore the install root key from a recovery envelope + recovery code",
  },
  args: {
    ...backendArgs(),
    file: {
      type: "string",
      description:
        "Path to the recovery envelope (default: <config>/keyring/recovery-envelope.json)",
    },
    code: { type: "string", description: "The recovery code (else read from stdin)" },
    force: { type: "boolean", description: "Replace an existing root key" },
  },
  async run(ctx) {
    const backend = backendFromArg(ctx.args.backend);
    const dir = configDir();
    const filePath =
      typeof ctx.args.file === "string" && ctx.args.file
        ? ctx.args.file
        : recoveryEnvelopePath(dir);
    if (!existsSync(filePath)) {
      throw new CliError(
        `No recovery envelope at ${filePath}. Pass --file to point at one.`,
        EXIT_USER_ERROR,
      );
    }
    let envelope: RecoveryEnvelopeV1;
    try {
      envelope = JSON.parse(readFileSync(filePath, "utf8")) as RecoveryEnvelopeV1;
    } catch {
      throw new CliError(`Could not parse recovery envelope at ${filePath}.`, EXIT_USER_ERROR);
    }
    const code = resolveRecoveryCode(ctx.args.code);
    let rootKey: string;
    try {
      rootKey = openRecoveryEnvelope(envelope, code);
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err), EXIT_USER_ERROR);
    }
    try {
      await writeInstallRootKey(rootKey, {
        backend,
        configDir: dir,
        overwrite: ctx.args.force === true,
      });
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err), EXIT_FAILURE);
    }
    console.log(
      `${c.green}Restored the Omnesis install root key from the recovery envelope.${c.reset}`,
    );
    console.log(
      `${c.dim}Encrypted stores and backups made under this key can now be opened.${c.reset}`,
    );
  },
});

export const keyringCommand = defineCommand({
  meta: {
    name: "keyring",
    description: "Manage Omnesis OS keyring material",
  },
  subCommands: {
    status: keyringStatusCommand,
    init: keyringInitCommand,
    migrate: keyringMigrateCommand,
    "storage-status": keyringStorageStatusCommand,
    "storage-init": keyringStorageInitCommand,
    "decrypt-artifact": keyringDecryptArtifactCommand,
    "export-recovery": keyringExportRecoveryCommand,
    "import-recovery": keyringImportRecoveryCommand,
  },
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      await runCommand(keyringStatusCommand, { rawArgs: ctx.rawArgs });
    }
  },
});

interface ArtifactDecryptSummary {
  scanned: number;
  decrypted: number;
  skipped: number;
  outputs: string[];
}

async function decryptArtifactPath(
  path: string,
  opts: {
    backend: SecretStoreBackend;
    configDir: string;
    outputPath?: string;
    force: boolean;
  },
): Promise<ArtifactDecryptSummary> {
  const st = statSync(path);
  const outputs: string[] = [];
  let scanned = 0;
  let decrypted = 0;
  let skipped = 0;

  const decryptOne = async (filePath: string, outputPath?: string): Promise<void> => {
    scanned += 1;
    if (!isEncryptedArtifactFile(filePath)) {
      skipped += 1;
      return;
    }
    const out = outputPath ?? defaultArtifactOutputPath(filePath);
    const result = await decryptArtifactFileToFile(filePath, out, {
      backend: opts.backend,
      configDir: opts.configDir,
      force: opts.force,
    });
    decrypted += result.decrypted ? 1 : 0;
    outputs.push(result.path);
  };

  if (st.isFile()) {
    await decryptOne(path, opts.outputPath);
  } else if (st.isDirectory()) {
    if (opts.outputPath) {
      throw new Error("--output is only supported when decrypting a single file");
    }
    for (const rel of listFilesRelative(path)) {
      await decryptOne(join(path, rel));
    }
  } else {
    throw new Error(`Artifact path is neither a regular file nor a directory: ${path}`);
  }

  return { scanned, decrypted, skipped, outputs };
}

function defaultArtifactOutputPath(path: string): string {
  return path.endsWith(ENCRYPTED_ARTIFACT_SUFFIX)
    ? path.slice(0, -ENCRYPTED_ARTIFACT_SUFFIX.length)
    : `${path}.decrypted`;
}

function listFilesRelative(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readDir(join(root, prefix))) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRelative(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export function collectSecretFileCandidates(configDir: string): string[] {
  const out = new Set<string>();
  const add = (path: string): void => {
    out.add(path);
  };

  add(join(configDir, "token"));
  add(join(configDir, "collector-token"));

  for (const entry of readDir(configDir)) {
    if (entry.isFile() && entry.name.endsWith("-credentials.json")) {
      add(join(configDir, entry.name));
    }
  }

  for (const entry of readDir(join(configDir, "config-secrets"))) {
    if (entry.isFile() && entry.name.endsWith(".secret")) {
      add(join(configDir, "config-secrets", entry.name));
    }
  }

  // Per-account pasted credentials, matched by shape rather than by provider
  // name: a provider this list forgot would be reported as secured while its
  // key stayed in plaintext for good.
  for (const provider of readDir(configDir)) {
    if (!provider.isDirectory()) continue;
    for (const account of readDir(join(configDir, provider.name))) {
      if (!account.isDirectory()) continue;
      const candidate = join(configDir, provider.name, account.name, "credentials.json");
      // Discovered by shape, so only a file that is actually there counts —
      // unlike the known-layout entries below, which are fixed paths.
      if (existsSync(candidate)) add(candidate);
    }
  }

  for (const provider of ["google", "strava", "notion", "outlook"]) {
    for (const account of readDir(join(configDir, provider))) {
      if (account.isDirectory()) add(join(configDir, provider, account.name, "tokens.json"));
    }
  }

  for (const item of readDir(join(configDir, "plaid"))) {
    if (item.isDirectory()) add(join(configDir, "plaid", item.name, "item.json"));
  }

  for (const account of readDir(join(configDir, "enable-banking"))) {
    if (account.isDirectory()) add(join(configDir, "enable-banking", account.name, "session.json"));
  }

  for (const account of readDir(join(configDir, "whatsapp"))) {
    if (!account.isDirectory()) continue;
    for (const file of readDir(join(configDir, "whatsapp", account.name, "auth"))) {
      if (file.isFile() && file.name.endsWith(".json")) {
        add(join(configDir, "whatsapp", account.name, "auth", file.name));
      }
    }
  }

  return [...out].sort();
}

export interface InlineConfigApiKeyMigrationResult {
  configPresent: boolean;
  createdSecrets: number;
  removedInlineKeys: number;
}

export function migrateInlineConfigApiKeys(
  configDir: string,
  opts: { backend?: SecretStoreBackend } = {},
): InlineConfigApiKeyMigrationResult {
  const configPath = join(configDir, "omnesis.json");
  if (!existsSync(configPath)) {
    return { configPresent: false, createdSecrets: 0, removedInlineKeys: 0 };
  }

  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`omnesis.json is not valid JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  if (!isRecord(parsed)) {
    return { configPresent: true, createdSecrets: 0, removedInlineKeys: 0 };
  }

  const candidate = structuredClone(parsed);
  if (!isRecord(candidate)) {
    return { configPresent: true, createdSecrets: 0, removedInlineKeys: 0 };
  }
  const inference = candidate.inference;
  if (!isRecord(inference) || !isRecord(inference.backends)) {
    return { configPresent: true, createdSecrets: 0, removedInlineKeys: 0 };
  }

  const newRefs: string[] = [];
  let createdSecrets = 0;
  let removedInlineKeys = 0;
  try {
    for (const [backendKey, value] of Object.entries(inference.backends)) {
      if (!isRecord(value) || typeof value.apiKey !== "string") continue;
      const existingRef =
        typeof value.apiKeySecret === "string" && parseConfigSecretRef(value.apiKeySecret)
          ? value.apiKeySecret
          : null;
      if (!existingRef) {
        const ref = writeConfigSecretSync(
          inferenceBackendApiKeySecretName(backendKey),
          value.apiKey,
          {
            backend: opts.backend,
            configDir,
          },
        );
        value.apiKeySecret = ref;
        newRefs.push(ref);
        createdSecrets += 1;
      }
      delete value.apiKey;
      removedInlineKeys += 1;
    }

    if (removedInlineKeys === 0) {
      return { configPresent: true, createdSecrets: 0, removedInlineKeys: 0 };
    }
    const validation = validateConfig(candidate, { stripUnknownKeys: true });
    if (!validation.ok) {
      const detail = validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      throw new Error(`rewritten omnesis.json failed validation: ${detail}`);
    }
    atomicWriteFileSync(configPath, JSON.stringify(validation.config, null, 2) + "\n", {
      mode: 0o600,
    });
    return { configPresent: true, createdSecrets, removedInlineKeys };
  } catch (err) {
    for (const ref of newRefs) clearConfigSecretRefSync(ref, configDir);
    throw err;
  }
}

function readDir(path: string): Dirent[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBackend(backend: string): string {
  switch (backend) {
    case "macos-keychain":
      return "macOS Keychain";
    case "secret-service":
      return "Linux Secret Service";
    case "passphrase":
      return "passphrase-sealed keyring";
    case "file":
      return "owner-only file fallback";
    case "unavailable":
      return "unavailable";
    default:
      return backend;
  }
}
