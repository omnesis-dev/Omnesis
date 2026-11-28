// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Standalone QA services, never an app/runtime-exec entry or a production install command.
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function within(root, target) {
  const local = relative(root, target);
  return local === "" || (local !== ".." && !local.startsWith("../") && !isAbsolute(local));
}
function cleanupUnconfirmed(error) {
  const seen = new Set();
  for (let depth = 0; depth < 16 && error && typeof error === "object"; depth++) {
    if (seen.has(error)) return false;
    seen.add(error);
    if (Object.hasOwn(error, "cleanupFailure")) return true;
    error = error.cause;
  }
  return false;
}
// Shared producer/consumer limit for the complete, inventory-bearing QA manifest.
export const QA_SERVICE_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

export async function readServiceMetadata(path, bound, openFile = open) {
  if (!Number.isSafeInteger(bound) || bound < 0 || bound > QA_SERVICE_MANIFEST_MAX_BYTES)
    throw new Error("Invalid QA metadata bound");
  const handle = await openFile(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > bound)
      throw new Error("Invalid QA metadata");
    const buffer = Buffer.alloc(Math.min(bound + 1, before.size + 1));
    let used = 0;
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > bound) throw new Error("QA metadata exceeds read bound");
    const value = buffer.subarray(0, used),
      after = await handle.stat(),
      published = await lstat(path);
    if (
      value.length !== before.size ||
      after.size !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      published.dev !== before.dev ||
      published.ino !== before.ino
    )
      throw new Error("QA metadata changed");
    return value;
  } finally {
    await handle.close();
  }
}
const bytes = readServiceMetadata;
async function hashFile(path, signal) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path, {
    signal,
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  }))
    hash.update(part);
  return hash.digest("hex");
}
async function verifyArtifact(root, manifest, signal) {
  if (
    manifest.format !== 1 ||
    manifest.kind !== "unsigned-native-qa-services" ||
    manifest.architecture !== process.arch ||
    manifest.nodeVersion !== process.versions.node ||
    manifest.entry !== "service/macos/Tests/Composition/desktop-service-entry.mjs" ||
    !Array.isArray(manifest.inventory) ||
    manifest.inventory.length > 100000
  )
    throw new Error("Unsupported QA service artifact");
  if ((await realpath(process.execPath)) !== join(root, "runtime/node"))
    throw new Error("QA services require their exact packaged Node");
  const expected = new Map();
  for (const record of manifest.inventory) {
    if (
      typeof record.path !== "string" ||
      record.path.includes("\\") ||
      record.path.split("/").some((part) => !part || part === "." || part === "..") ||
      isAbsolute(record.path) ||
      expected.has(record.path)
    )
      throw new Error("Invalid QA inventory path");
    expected.set(record.path, record);
  }
  let count = 0;
  async function visit(directory) {
    for (const item of await readdir(directory)) {
      signal.throwIfAborted();
      const path = join(directory, item),
        local = relative(root, path);
      if (local === "qa-services.json") continue;
      const info = await lstat(path);
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (++count > 100000) throw new Error("QA inventory exceeds its bound");
      const record = expected.get(local);
      if (!record) throw new Error("Unlisted QA service file");
      expected.delete(local);
      if (info.isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link) || record.symlink !== link || !within(root, await realpath(path)))
          throw new Error("QA service link escapes its artifact");
      } else if (
        !info.isFile() ||
        record.symlink !== undefined ||
        record.bytes !== info.size ||
        record.executable !== Boolean(info.mode & 0o111) ||
        record.sha256 !== (await hashFile(path, signal))
      )
        throw new Error("QA service artifact changed");
    }
  }
  await visit(root);
  if (expected.size) throw new Error("QA service inventory is incomplete");
}
async function privateDirectory(path, uid, mode = 0o700) {
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    info.mode & 0o022 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("Unsafe QA service data directory");
}

export async function runNativeCompositionServiceEntry() {
  if (
    process.argv.slice(2).join() !== "start" ||
    process.platform !== "darwin" ||
    typeof process.getuid !== "function" ||
    process.geteuid() !== process.getuid()
  )
    throw new Error("QA services require the macOS start entry and ordinary user ownership");
  if (
    process.execArgv.some((arg) => arg !== "--use-system-ca") ||
    Object.entries(process.env).some(
      ([name, value]) =>
        value &&
        (/^(?:OMNESIS_|NODE_|DYLD_|LD_|OPENSSL_|BASH_FUNC_)/u.test(name) ||
          ["ENV", "BASH_ENV"].includes(name) ||
          name.endsWith("_API_KEY")),
    )
  )
    throw new Error("QA services refuse inherited loader, credential or authority configuration");
  const home = userInfo().homedir;
  if (homedir() !== home || (process.env.HOME && process.env.HOME !== home))
    throw new Error("QA services require the actual OS user's home");
  // Only this standalone QA tool's ordinary child command search is fixed to system tools.
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  if ((await realpath(root)) !== root) throw new Error("QA service artifact is aliased");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid() || rootInfo.mode & 0o077)
    throw new Error("QA service artifact must be private and owned");
  const controller = new AbortController(),
    abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let world, run, atomicWriteFile, ownedProcessCleanupReceipt;
  let failure;
  try {
    const manifestBytes = await bytes(
      join(root, "qa-services.json"),
      QA_SERVICE_MANIFEST_MAX_BYTES,
    );
    const manifest = JSON.parse(manifestBytes);
    await verifyArtifact(root, manifest, controller.signal);
    ({ atomicWriteFile, ownedProcessCleanupReceipt } = await import("@omnesis/core"));
    const { runFixtureOpenSsl } = await import("../../../scripts/desktop/fixture-openssl.mjs");
    const systemTool = "/usr/bin/openssl";
    if ((await realpath(systemTool)) !== systemTool || !(await lstat(systemTool)).isFile())
      throw new Error("QA system crypto executable is not canonical");
    const toolHash = await hashFile(systemTool, controller.signal);
    async function inspect(args) {
      let text = "",
        owner;
      try {
        await runFixtureOpenSsl(args, { signal: controller.signal, timeoutMs: 5000 }, (current) => {
          owner = current;
          const collect = (part) => {
            text += part.toString();
            if (text.length > 8192) text = text.slice(0, 8193);
          };
          current.child.stdout?.on("data", collect);
          current.child.stderr?.on("data", collect);
        });
      } catch (error) {
        if (
          !owner?.joinedConfirmed ||
          args[1] !== "-help" ||
          owner.child.exitCode !== 1 ||
          error?.message !== "Fixture crypto failed; child joined" ||
          controller.signal.aborted ||
          ownedProcessCleanupReceipt(error)
        )
          throw error;
      }
      if (text.length > 8192) throw new Error("QA crypto metadata exceeds its bound");
      return text;
    }
    const version = (await inspect(["version"])).trim();
    const req = await inspect(["req", "-help"]),
      x509 = await inspect(["x509", "-help"]);
    if (
      !/^(?:LibreSSL|OpenSSL) [^\r\n]{1,100}$/u.test(version) ||
      !req.includes("-addext") ||
      !x509.includes("-extfile") ||
      toolHash !== (await hashFile(systemTool, controller.signal))
    )
      throw new Error("QA system crypto capabilities are unsupported or changed");
    controller.signal.throwIfAborted();
    const qaRoot = join(home, "Library/Application Support/OmnesisNativeQA");
    for (const path of [
      home,
      join(home, "Library"),
      join(home, "Library/Application Support"),
      qaRoot,
    ])
      await privateDirectory(path, process.getuid());
    if ((await lstat(qaRoot)).mode & 0o077) throw new Error("QA service namespace must be private");
    run = await mkdtemp(join(qaRoot, "run-"));
    await atomicWriteFile(join(run, "state.json"), JSON.stringify({ state: "starting" }), {
      mode: 0o600,
    });
    const data = join(run, "services");
    await mkdir(data, { mode: 0o700 });
    const { createNativeCompositionWorld } =
      await import("../../../scripts/desktop/native-composition-world.js");
    world = await createNativeCompositionWorld(data, controller.signal);
    controller.signal.throwIfAborted();
    const receipt = {
      format: 1,
      kind: "native-qa-services-ready",
      artifactSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      resource: world.resource,
      ca: world.trust.acmeCa,
      relayCa: world.trust.relayCa,
      systemOpenSsl: {
        executable: systemTool,
        sha256: toolHash,
        version,
        reqAddext: true,
        x509Extfile: true,
      },
    };
    await atomicWriteFile(join(run, "public-ready.json"), JSON.stringify(receipt), { mode: 0o600 });
    controller.signal.throwIfAborted();
    process.stdout.write(JSON.stringify(receipt) + "\n");
    await new Promise((done) => {
      if (controller.signal.aborted) done();
      else controller.signal.addEventListener("abort", done, { once: true });
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await world?.close();
    } catch (error) {
      failure = Object.assign(
        new AggregateError([failure, error], "QA service shutdown is unconfirmed", {
          cause: error,
        }),
        { cleanupFailure: ownedProcessCleanupReceipt?.(error)?.failure ?? "qa-services" },
      );
    }
    try {
      if (run && atomicWriteFile)
        await atomicWriteFile(
          join(run, "state.json"),
          JSON.stringify({
            state: cleanupUnconfirmed(failure)
              ? "cleanup-unconfirmed"
              : failure
                ? "failed"
                : "closed",
          }),
          { mode: 0o600 },
        );
    } catch (writeError) {
      const previous = failure;
      failure = new AggregateError(
        [previous, writeError],
        "QA shutdown receipt could not be saved",
        { cause: previous ?? writeError },
      );
      if (cleanupUnconfirmed(previous))
        Object.assign(failure, {
          cleanupFailure: ownedProcessCleanupReceipt?.(previous)?.failure ?? "qa-services",
        });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  if (failure) throw failure;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runNativeCompositionServiceEntry().catch((error) => {
    process.stderr.write(
      JSON.stringify({ state: "refused", cleanupUnconfirmed: cleanupUnconfirmed(error) }) + "\n",
    );
    process.exitCode = 1;
  });
