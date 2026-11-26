// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Copied into a reviewed DEBUG QA payload only. Never imported by the production CLI.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = /^[a-f0-9]{64}$/u;
const intentName = "qa-composition-intent.json";
const markerName = "qa-composition.json";
export const ORIGINAL_ENTRY = "qa-production-index.js";

function requirePosixOwnership() {
  if (typeof process.getuid !== "function")
    throw new Error("QA fixtures require POSIX ownership checks");
}
function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new Error("Invalid QA metadata fields");
}
function endpoint(value, kind) {
  if (typeof value !== "string" || value.length > 512 || /[\r\n\s]/u.test(value))
    throw new Error("Invalid QA endpoint");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.port ||
    Number(url.port) < 1024
  )
    throw new Error("Invalid QA endpoint");
  if (kind === "model") {
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/")
      throw new Error("The scripted model must be owned loopback HTTP");
  } else if (kind === "acme") {
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/directory" ||
      value !== `${url.origin}/directory`
    )
      throw new Error("QA ACME requires the owned loopback directory");
  } else {
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".example.test") ||
      url.pathname !== "/"
    )
      throw new Error("QA relay requires named fixture HTTPS");
  }
  if (kind !== "acme" && value !== url.origin) throw new Error("QA origin must be canonical");
  return value;
}
export function parseCompositionResource(value) {
  exactKeys(value, [
    "format",
    "kind",
    "runId",
    "relayOrigin",
    "acmeDirectoryUrl",
    "caSha256",
    "modelOrigin",
    "modelId",
  ]);
  if (
    value.format !== 1 ||
    value.kind !== "omnesis-native-composition" ||
    !uuid.test(value.runId) ||
    !hash.test(value.caSha256) ||
    value.modelId !== "fictional-native-model"
  )
    throw new Error("Invalid QA resource");
  endpoint(value.relayOrigin, "relay");
  endpoint(value.acmeDirectoryUrl, "acme");
  endpoint(value.modelOrigin, "model");
  return Object.freeze({ ...value });
}
export async function readPrivate(path, limit = 16384) {
  requirePosixOwnership();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.uid !== process.getuid() ||
      before.size > limit
    )
      throw new Error("QA file is not private and owned");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat(),
      published = await lstat(path);
    if (
      bytesRead !== before.size ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      published.ino !== before.ino ||
      published.dev !== before.dev ||
      (await realpath(path)) !== resolve(path)
    )
      throw new Error("QA file changed while reading");
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
async function optionalPrivate(path, limit) {
  try {
    return await readPrivate(path, limit);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function privateDirectory(path) {
  requirePosixOwnership();
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("QA directory is not private and canonical");
}
function binding(profile, resource, epoch) {
  if (
    !hash.test(epoch) ||
    !/^desktop-[a-f0-9]{16}$/u.test(profile.instance) ||
    !/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(profile.secretService)
  )
    throw new Error("Invalid QA profile binding");
  return {
    format: 1,
    owner: "omnesis-native-composition",
    runId: resource.runId,
    configIdentity: digest(resolve(profile.configDir)),
    instance: profile.instance,
    secretService: profile.secretService,
    codeEpoch: epoch,
    resourceDigest: digest(JSON.stringify(resource)),
  };
}
function sameRecord(value, expected) {
  return (
    JSON.stringify(value, Object.keys(value).sort()) ===
    JSON.stringify(expected, Object.keys(expected).sort())
  );
}
/** Builtins-only refusal before a retained profile's dotenv can be loaded. */
export async function preflightCompositionProfile(profile, resource, runtime) {
  requirePosixOwnership();
  const expected = binding(profile, resource, basename(runtime));
  try {
    await privateDirectory(profile.configDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const { readdir } = await import("node:fs/promises");
  if (!(await readdir(profile.configDir)).length) return;
  const intent = await readPrivate(join(profile.configDir + ".bootstrap", intentName));
  if (!sameRecord(JSON.parse(intent), expected))
    throw new Error("QA cannot adopt an existing profile");
  const journal = JSON.parse(await readPrivate(join(profile.configDir, "desktop-install.json")));
  if (
    journal.owner !== "omnesis-desktop" ||
    journal.instance !== profile.instance ||
    journal.secretService !== profile.secretService ||
    journal.processAuthorityVersion !== 3 ||
    !["claimed", "protected", "configured"].includes(journal.phase)
  )
    throw new Error("QA profile journal changed");
  const env = await optionalPrivate(join(profile.configDir, ".env"));
  if (env && String(env) !== dotenv(resource, runtime))
    throw new Error("QA dotenv left its closed boundary");
  if (journal.phase === "configured") {
    const marker = JSON.parse(await readPrivate(join(profile.configDir, markerName)));
    const { configSha256, dotenvSha256, ...owner } = marker;
    if (
      !sameRecord(owner, expected) ||
      !hash.test(configSha256) ||
      dotenvSha256 !== digest(dotenv(resource, runtime)) ||
      !env
    )
      throw new Error("QA configured marker changed");
    validateRetainedConfig(
      await readPrivate(join(profile.configDir, "omnesis.json"), 1024 * 1024),
      resource,
      (value) => value,
    );
  }
}

/** Reserve outside the data root so the real bootstrap must still claim an empty directory. */
export async function reserveCompositionIntent(profile, resource, epoch, dependencies) {
  requirePosixOwnership();
  const expected = binding(profile, resource, epoch);
  await dependencies.withLease(profile, dependencies.signal, async () => {
    const directory = profile.configDir + ".bootstrap";
    await privateDirectory(directory);
    const existing = await optionalPrivate(join(directory, intentName));
    if (existing) {
      if (!sameRecord(JSON.parse(existing), expected))
        throw new Error("Another QA run owns this profile");
      return;
    }
    try {
      await privateDirectory(profile.configDir);
      const { readdir } = await import("node:fs/promises");
      if ((await readdir(profile.configDir)).length)
        throw new Error("QA cannot adopt an existing profile");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await dependencies.atomicWriteFile(join(directory, intentName), JSON.stringify(expected), {
      mode: 0o600,
    });
  });
}
function expectedConfig(journal, resource, parseConfig) {
  return parseConfig({
    gateway: { memoryLimitMb: journal.memoryLimitMb, localMcp: { enabled: false } },
    inference: {
      allowRemoteInference: true,
      backends: { scripted: { type: "http", url: resource.modelOrigin, apiPathPrefix: "/v1" } },
      assignments: {
        agent: `scripted/${resource.modelId}`,
        embedder: null,
        transcriber: null,
        "background-agent": null,
      },
      recordings: { speakers: "off" },
    },
  });
}
function dotenv(resource, runtime) {
  if (/[\r\n]/u.test(runtime)) throw new Error("Invalid QA runtime path");
  // Fixed fixture configuration, never inherited authority, keys, terms acceptance or loaders.
  return (
    [
      ["OMNESIS_RUNTIME_MODE", "test"],
      ["OMNESIS_TELEMETRY", "0"],
      ["OMNESIS_CLOUD_RELAY_URL", resource.relayOrigin],
      ["OMNESIS_ACME_DIRECTORY_URL", resource.acmeDirectoryUrl],
      ["OMNESIS_ACME_CA_FILE", join(runtime, "qa-ca.pem")],
      ["OMNESIS_E2E_DISABLE_DEFAULT_RELAY", "1"],
      ["OMNESIS_E2E_DISABLE_RELEASE_CHECK", "1"],
      ["OMNESIS_E2E_DISABLE_ICON_FETCH", "1"],
      ["OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED", "0"],
    ]
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}
function validateRetainedConfig(raw, resource, parseConfig) {
  const config = parseConfig(JSON.parse(raw));
  const inference = config.inference;
  if (
    Object.keys(inference.backends ?? {}).join() !== "scripted" ||
    inference.backends.scripted.type !== "http" ||
    inference.backends.scripted.url !== resource.modelOrigin ||
    inference.backends.scripted.apiKey !== undefined ||
    inference.backends.scripted.apiKeySecret !== undefined ||
    inference.backends.scripted.apiPathPrefix !== "/v1" ||
    ![null, `scripted/${resource.modelId}`].includes(inference.assignments.agent) ||
    inference.assignments.embedder !== null ||
    inference.assignments.transcriber !== null ||
    inference.assignments["background-agent"] !== null ||
    inference.recordings.speakers !== "off"
  )
    throw new Error("QA configuration left its scripted boundary");
  return config;
}
/** Called only within the REAL prepareDesktopInstall install lease, after genuine protection. */
export function compositionProtections(profile, resource, runtime, dependencies) {
  requirePosixOwnership();
  const { core, signal, readInstall, parseConfig, checkpoint = async () => {} } = dependencies;
  const epoch = basename(runtime),
    expected = binding(profile, resource, epoch);
  return {
    ensureInstallRootKey: core.ensureInstallRootKey,
    inspectInstallRootKey: core.inspectInstallRootKey,
    markSecretFileEncryptionRequired: core.markSecretFileEncryptionRequired,
    markStorageEncryptionRequired: async (directory, options) => {
      signal.throwIfAborted();
      if (
        directory !== profile.configDir ||
        options.service !== profile.secretService ||
        options.backend !== "macos-keychain"
      )
        throw new Error("QA protection scope changed");
      const intent = JSON.parse(
        await readPrivate(join(profile.configDir + ".bootstrap", intentName)),
      );
      if (!sameRecord(intent, expected)) throw new Error("QA intent changed");
      await core.markStorageEncryptionRequired(directory, options);
      await checkpoint("storage");
      signal.throwIfAborted();
      const journal = await readInstall(profile);
      if (
        !journal ||
        journal.instance !== profile.instance ||
        journal.secretService !== profile.secretService ||
        journal.processAuthorityVersion !== 3
      )
        throw new Error("QA bootstrap authority changed");
      await privateDirectory(profile.configDir);
      const configPath = join(directory, "omnesis.json"),
        envPath = join(directory, ".env");
      const configBytes = JSON.stringify(expectedConfig(journal, resource, parseConfig));
      const envBytes = dotenv(resource, runtime);
      const marker = {
        ...expected,
        configSha256: digest(configBytes),
        dotenvSha256: digest(envBytes),
      };
      const existingMarker = await optionalPrivate(join(directory, markerName));
      if (journal.phase === "configured") {
        if (!existingMarker || !sameRecord(JSON.parse(existingMarker), marker))
          throw new Error("QA cannot adopt a configured profile");
        validateRetainedConfig(await readPrivate(configPath, 1024 * 1024), resource, parseConfig);
        if (String(await readPrivate(envPath)) !== envBytes)
          throw new Error("QA endpoints changed");
        return;
      }
      if (existingMarker && !sameRecord(JSON.parse(existingMarker), marker))
        throw new Error("QA marker changed");
      for (const [path, bytes, stage] of [
        [configPath, configBytes, "config"],
        [envPath, envBytes, "environment"],
        [join(directory, markerName), JSON.stringify(marker), "marker"],
      ]) {
        signal.throwIfAborted();
        const current = await optionalPrivate(path, path === configPath ? 1024 * 1024 : 16384);
        if (current && String(current) !== bytes)
          throw new Error("QA refuses unrelated bootstrap contents");
        if (!current) await core.atomicWriteFile(path, bytes, { mode: 0o600 });
        if (String(await readPrivate(path, path === configPath ? 1024 * 1024 : 16384)) !== bytes)
          throw new Error("QA publication changed");
        await checkpoint(stage);
      }
      signal.throwIfAborted();
    },
  };
}

/** No authority or lifecycle mode is intercepted except the exact reviewed JSON bridge. */
export function isCompositionBridge(argv) {
  return argv.length === 2 && argv[0] === "desktop" && argv[1] === "bridge";
}
export async function runCompositionEntry() {
  const directory = dirname(fileURLToPath(import.meta.url));
  if (!isCompositionBridge(process.argv.slice(2))) {
    await import(pathToFileURL(join(directory, ORIGINAL_ENTRY)).href);
    return;
  }
  requirePosixOwnership();
  const runtime = resolve(directory, "../../..");
  const resource = parseCompositionResource(
    JSON.parse(await readFile(join(runtime, "qa-resource.json"), "utf8")),
  );
  if (digest(await readFile(join(runtime, "qa-ca.pem"))) !== resource.caSha256)
    throw new Error("QA certificate resource changed");
  const { initializeDesktopEnvironment } = await import(
    pathToFileURL(join(directory, "desktop/environment.js")).href
  );
  const profile = initializeDesktopEnvironment();
  await preflightCompositionProfile(profile, resource, runtime);
  await import(pathToFileURL(join(directory, "load-env.js")).href);
  const core = await import("@omnesis/core"),
    { omnesisConfigSchema } = await import("@omnesis/config");
  const bootstrap = await import(pathToFileURL(join(directory, "desktop/bootstrap.js")).href);
  const { DesktopCoordinator } = await import(
    pathToFileURL(join(directory, "desktop/coordinator.js")).href
  );
  const { runDesktopProtocol } = await import(
    pathToFileURL(join(directory, "desktop/protocol.js")).href
  );
  const controller = new AbortController(),
    abort = () => controller.abort();
  await reserveCompositionIntent(profile, resource, basename(runtime), {
    withLease: bootstrap.withDesktopInstallLease,
    atomicWriteFile: core.atomicWriteFile,
    signal: controller.signal,
  });
  const coordinator = new DesktopCoordinator(profile, {
    relayUrl: () => resource.relayOrigin,
    prepareInstall: (current, options) =>
      bootstrap.prepareDesktopInstall(
        current,
        options,
        compositionProtections(current, resource, runtime, {
          core,
          signal: options.signal,
          readInstall: bootstrap.readDesktopInstall,
          parseConfig: (value) => omnesisConfigSchema.parse(value),
        }),
      ),
  });
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runDesktopProtocol({
      input: process.stdin,
      output: process.stdout,
      signal: controller.signal,
      handle: (request, context) => coordinator.handle(request, context),
    });
  } finally {
    await coordinator.close();
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runCompositionEntry();
