// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Services-only qualification; never invokes the strict guest or native application entry.
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { request } from "node:https";
import { createRequire } from "node:module";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryScript } from "../lib/is-entry-script.mjs";

async function boundedResponse(response) {
  const parts = [];
  let size = 0;
  for await (const part of response) {
    size += part.length;
    if (size > 65536) throw new Error("Services-only response exceeds bound");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts).toString();
}
function health(world, signal) {
  return new Promise((done, reject) => {
    const client = request(
      new URL("/healthz", world.resource.relayOrigin),
      {
        ca: world.trust.relayCa,
        signal,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      },
      async (response) => {
        try {
          await boundedResponse(response);
          if (response.statusCode !== 200) throw new Error("Services-only relay health refused");
          done();
        } catch (error) {
          reject(error);
        }
      },
    );
    client.once("error", reject);
    client.end();
  });
}

/** Shared probe body: production entry supplies only artifact-resolved real services. */
export async function probeCompositionServices(world, issueCertificate, signal) {
  await health(world, signal);
  const models = await fetch(world.resource.modelOrigin + "/v1/models", { signal });
  const modelList = JSON.parse(await boundedResponse(models.body));
  if (!models.ok || modelList.data?.[0]?.id !== world.resource.modelId)
    throw new Error("Services-only model catalogue differs");
  const turn = await fetch(world.resource.modelOrigin + "/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: world.resource.modelId,
      messages: [{ role: "user", content: "Fixture check" }],
      stream: true,
    }),
  });
  if (!turn.ok || !(await boundedResponse(turn.body)).includes("data: [DONE]"))
    throw new Error("Services-only scripted turn incomplete");
  const hostname = "g-abcdefgh.relay.example.test";
  world.expectGatewayHostname(hostname);
  const pem = () =>
    String(
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    );
  const records = `${world.services.dnsApiOrigin}/client/v4/zones/${"a".repeat(32)}/dns_records`;
  const headers = {
    authorization: `Bearer ${world.services.dnsToken}`,
    "content-type": "application/json",
  };
  const certificate = await issueCertificate({
    directoryUrl: world.resource.acmeDirectoryUrl,
    hostname,
    accountKey: pem(),
    tlsKey: pem(),
    signal,
    presenter: {
      async create(value) {
        const response = await fetch(records, {
          method: "POST",
          signal,
          headers,
          body: JSON.stringify({
            type: "TXT",
            name: `_acme-challenge.${hostname}`,
            content: value,
          }),
        });
        if (!response.ok) throw new Error("Services-only DNS challenge refused");
        return { id: JSON.parse(await boundedResponse(response.body)).result.id };
      },
      async remove(id) {
        const response = await fetch(records + "/" + encodeURIComponent(id), {
          method: "DELETE",
          signal,
          headers,
        });
        if (!response.ok) throw new Error("Services-only DNS cleanup refused");
        await boundedResponse(response.body);
      },
    },
    async lookup(name, value) {
      const response = await fetch(
        world.services.dnsApiOrigin + "/txt?name=" + encodeURIComponent(`_acme-challenge.${name}`),
        { signal },
      );
      if (!response.ok) throw new Error("Services-only DNS lookup refused");
      return JSON.parse(await boundedResponse(response.body)).some(
        (parts) => parts.join("") === value,
      );
    },
    caaLookup: async () => undefined,
  });
  const leaf = new X509Certificate(certificate);
  if (
    !leaf.verify(new X509Certificate(world.trust.acmeCa).publicKey) ||
    leaf.checkHost(hostname) !== hostname ||
    world.evidence.scriptedRequests() !== 1 ||
    world.evidence.productionDnsQueries.size
  )
    throw new Error("Services-only composition evidence differs");
  return {
    format: 1,
    scope: "services-only",
    relayTls: "passed",
    scriptedModel: "passed",
    acmeDnsCertificate: "passed",
  };
}

/** No factory/environment override: all imports are fixed inside the portable artifact. */
export async function smokeNativeCompositionServices(artifact, work) {
  if (typeof process.getuid !== "function")
    throw new Error("Services-only smoke requires POSIX ownership");
  artifact = await realpath(artifact);
  if ((await realpath(process.execPath)) !== join(artifact, "runtime/node"))
    throw new Error("Services-only smoke requires the copied runtime Node");
  const { createNativeCompositionWorld } = await import(
    pathToFileURL(join(artifact, "service/scripts/desktop/native-composition-world.js"))
  );
  const { issueAcmeCertificate } = await import(
    pathToFileURL(join(artifact, "runtime/packages/cloud-relay/dist/acme-client.js"))
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let world;
  try {
    world = await createNativeCompositionWorld(work, controller.signal);
    const receipt = await probeCompositionServices(world, issueAcmeCertificate, controller.signal);
    await world.close();
    return { ...receipt, closure: "joined" };
  } finally {
    controller.abort();
    try {
      await world?.close();
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGINT", abort);
    }
  }
}

/** Parent retains the exact copied-runtime process until physical exit/close. */
export async function qualifyNativeCompositionServices({
  runtime,
  artifact,
  architecture,
  version,
  work,
  env,
}) {
  if (typeof process.getuid !== "function")
    throw new Error("Services-only smoke requires POSIX ownership");
  const { prepareNativeCompositionServices, compositionInputFailureMetadata } =
    await import("./prepare-native-composition-services.mjs");
  let prepared;
  try {
    await mkdir(work, { mode: 0o700 });
    prepared = await prepareNativeCompositionServices({
      runtime,
      output: artifact,
      architecture,
      version,
    });
  } catch (error) {
    try {
      await writeFile(
        join(dirname(artifact), "services-smoke-failure.json"),
        JSON.stringify({
          format: 1,
          scope: "services-only",
          phase: "preparation",
          servicesStarted: false,
          reason: "preparation-failure",
          validation: compositionInputFailureMetadata(error),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (receiptError) {
      throw Object.assign(
        new AggregateError([error, receiptError], "Services-only preparation receipt unavailable", {
          cause: error,
        }),
        { cleanupFailure: "qa-service-evidence" },
      );
    }
    throw error;
  }
  const require = createRequire(join(artifact, "runtime/package.json"));
  const { spawnOwnedChildProcess } = await import(pathToFileURL(require.resolve("@omnesis/core")));
  const owner = spawnOwnedChildProcess(
    join(artifact, "runtime/node"),
    [fileURLToPath(import.meta.url), "--artifact", artifact, "--work", work],
    { env: { ...env, PATH: `${join(artifact, "runtime/bin")}:/usr/bin:/bin:/usr/sbin:/sbin` } },
  );
  await joinCompositionSmokeProcess(owner, join(dirname(artifact), "services-smoke-failure.json"));
  return prepared;
}

/** Root join after forced stop is not proof that services completed their normal shutdown. */
export async function joinCompositionSmokeProcess(owner, receipt, timeoutMs = 120000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    await owner.stop();
    throw new Error("Invalid services-only process deadline");
  }
  let stopping;
  let reason;
  const stop = (why) => {
    reason ??= why;
    stopping ??= owner.stop();
    void stopping.catch(() => {});
  };
  const timer = setTimeout(() => stop("deadline"), timeoutMs);
  let outputBytes = 0;
  const count = (part) => {
    outputBytes = Math.min(65537, outputBytes + part.length);
    if (outputBytes > 65536) stop("output");
  };
  for (const stream of [owner.child.stdout, owner.child.stderr]) stream?.on("data", count);
  owner.child.stdin?.on("error", () => {});
  owner.child.stdin?.end();
  try {
    await owner.ready;
    await owner.joined;
    await stopping;
    if (!owner.joinedConfirmed || stopping || owner.child.exitCode !== 0 || owner.child.signalCode)
      throw new Error("Services-only smoke refused");
  } catch (error) {
    let failure = error;
    try {
      await owner.stop();
    } catch (joinError) {
      failure = joinError;
    }
    if (reason)
      failure = Object.assign(
        new Error("Services-only forced stop; normal service closure unverified", {
          cause: failure,
        }),
        { cleanupFailure: "qa-service-forced-stop" },
      );
    try {
      await writeFile(
        receipt,
        JSON.stringify({
          format: 1,
          scope: "services-only",
          phase: "process",
          reason: reason ?? "process-failure",
          rootJoined: owner.joinedConfirmed,
          exitCode: owner.child.exitCode,
          signal: owner.child.signalCode,
          outputBytes,
          normalServiceClosure: "unverified",
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (receiptError) {
      throw Object.assign(
        new AggregateError([failure, receiptError], "Services-only failure receipt unavailable", {
          cause: failure,
        }),
        { cleanupFailure: "qa-service-evidence" },
      );
    }
    throw failure;
  } finally {
    clearTimeout(timer);
    for (const stream of [owner.child.stdout, owner.child.stderr]) stream?.off("data", count);
  }
}

if (isEntryScript(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== "--artifact" || process.argv[4] !== "--work")
    throw new Error("Invalid services-only smoke arguments");
  await smokeNativeCompositionServices(resolve(process.argv[3]), resolve(process.argv[5]));
}
