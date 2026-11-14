// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a compromised relay can and cannot do to sign-in enrollment
 * (docs/device-enrollment.md), against a real relay daemon, real gateways and
 * the Node pairing client:
 *
 * - its own account attestation, signed with the relay's account key, only
 *   ever holds a request for a person;
 * - proposing a different valid certificate for the gateway's name makes the
 *   real gateway refuse the device's signature, and the device saves nothing;
 * - a captured request cannot be replayed into a second join;
 * - first contact needs a publicly trusted, logged certificate: a leaf without
 *   the embedded SCT extension makes the device ask for the comparison;
 * - a certificate for the gateway's name with a key the gateway doesn't hold
 *   holds every new device until the owner acknowledges it on the gateway
 *   itself; no request through the relay lifts the hold, and a restart keeps it.
 *
 * The automatic policy is on and the signing passkey is pinned throughout, so
 * every hold below is caused by the attack, not by the owner's settings.
 */

import {
  X509Certificate,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:https";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeAccountDesktop,
  certificateFingerprint,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  pairAccountDevice,
  pairingCodeCommitment,
  pairingComparisonCode,
  signDeviceTranscript,
  tlsSpkiFingerprint,
} from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  GatewayRefused,
  PasskeyBrowser,
  runCli,
  browserSuiteAvailable,
  certificateSwapProxy,
  connectGatewayBySignIn,
  devicePinnedJson,
  signInOnThisMachine,
  signedInAccount,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the certificate transparency search service the gateway's
 * monitor asks, with the same API: what it lists is what has been logged for the
 * gateway's name.
 */
async function certificateLog(world: EnrollmentWorld) {
  const leaf = await world.pki.leaf("ct-log", ["localhost", "127.0.0.1"]);
  const entries: Array<{ id: string; cert_der: string }> = [];
  const server = createServer(
    { cert: leaf.cert, key: await readFile(leaf.keyFile, "utf8") },
    (request, response) => {
      const url = new URL(request.url ?? "/", "https://localhost");
      if (url.pathname !== "/v1/issuances") {
        response.writeHead(404).end();
        return;
      }
      const after = Number(url.searchParams.get("after") ?? "0");
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(entries.filter((entry) => Number(entry.id) > after)));
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}`,
    /** A certificate now appears in the log. */
    log(certificate: string) {
      entries.push({
        id: String(entries.length + 1),
        cert_der: new X509Certificate(certificate).raw.toString("base64"),
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const browserReady = browserSuiteAvailable("account-enrollment-attacks.e2e");

describe.skipIf(!browserReady)("a relay cannot enroll devices on its own", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let session: PasskeySession;
  /** Its public leaf carries the embedded SCT extension. */
  let logged: EnrollmentGateway;
  /** Its public leaf, from the same trusted authority, does not. */
  let unlogged: EnrollmentGateway;
  const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;

  type Transport = typeof devicePinnedJson;
  async function pairBySignIn(options: {
    gateway: EnrollmentGateway;
    name: string;
    keyFile: string;
    gatewayJson?: Transport;
    fetch?: typeof fetch;
  }) {
    await options.gateway.pace(2);
    const comparisons: string[] = [];
    let printed!: (value: { connectUrl: string; code: string }) => void;
    const code = new Promise<{ connectUrl: string; code: string }>(
      (resolve) => (printed = resolve),
    );
    // Only a sign-in that finishes on this machine hands the client its proof (loopback).
    let launched!: (url: string) => void;
    const launchUrl = new Promise<string>((resolve) => (launched = resolve));
    const result = pairAccountDevice(
      {
        kind: "cli",
        name: options.name,
        relayUrl: world.relayOrigin,
        deviceKeyFile: options.keyFile,
        signal: AbortSignal.timeout(120_000),
        selectGateway: async (choices) => {
          expect(choices.map((choice) => choice.gatewayId)).toContain(options.gateway.gatewayId);
          return options.gateway.gatewayId;
        },
        onConnectCode: printed,
        confirm: async (value) => {
          comparisons.push(value.verificationCode);
          return true;
        },
      },
      {
        authorize: (input, dependencies) =>
          authorizeAccountDesktop(input, {
            ...dependencies,
            openBrowser: async (url) => launched(url),
          }),
        ...(options.gatewayJson ? { gatewayJson: options.gatewayJson } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    );
    result.catch(() => undefined);
    await Promise.race([
      code,
      result.then(() => {
        throw new Error("Paired before anyone signed in");
      }),
    ]);
    await signInOnThisMachine(session, await launchUrl);
    return { result, comparisons };
  }

  /** Records what the device sent to `/devices/account/request` and what came back. */
  function recordingTransport() {
    const requests: Array<{ body: Record<string, unknown>; reply?: Record<string, unknown> }> = [];
    const transport: Transport = async (candidate, path, body, signal, connectHost, options) => {
      const entry: { body: Record<string, unknown>; reply?: Record<string, unknown> } | undefined =
        path === "/devices/account/request"
          ? { body: structuredClone(body) as Record<string, unknown> }
          : undefined;
      if (entry) requests.push(entry);
      const reply = await devicePinnedJson(candidate, path, body, signal, connectHost, options);
      if (entry) entry.reply = reply as Record<string, unknown>;
      return reply;
    };
    return { requests, transport };
  }

  beforeAll(
    async () => {
      directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-attacks-"));
      world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
      process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
      browser = await PasskeyBrowser.launch(world);
      session = await browser.session();
      logged = await EnrollmentGateway.start(world, "logged", { sct: true });
      unlogged = await EnrollmentGateway.start(world, "unlogged", { sct: false });
      for (const [gateway, account] of [
        [logged, "create"],
        [unlogged, "existing"],
      ] as const) {
        const linked = await connectGatewayBySignIn(gateway, session, account);
        if (linked.connect?.state !== "done")
          throw new Error(`Link failed: ${JSON.stringify(linked.connect)}`);
        await gateway.setPolicy("automatic");
      }
    },
    2 * gatewayBootBudgetMs() + 180_000,
  );

  afterAll(async () => {
    try {
      await browser?.close();
      await logged?.close();
      await unlogged?.close();
      await world?.close();
    } finally {
      if (priorCaFile === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
      else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCaFile;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("first contact: a logged leaf from a trusted authority joins with no comparison", async () => {
    const { requests, transport } = recordingTransport();
    const pairing = await pairBySignIn({
      gateway: logged,
      name: "Fictional logged-path CLI",
      keyFile: join(directory, "logged", "device.key"),
      gatewayJson: transport,
    });
    const joined = await pairing.result;
    expect(pairing.comparisons).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.requireApproval).toBeUndefined();
    expect(requests[0]!.reply).toMatchObject({ status: "approved" });
    expect(
      (await logged.devices()).find((device) => device.id === joined.deviceId)?.enrollment,
    ).toMatchObject({
      method: "automatic",
    });
  }, 180_000);

  test("first contact: a leaf without the embedded SCT extension makes the device require approval, so it is held", async () => {
    const { requests, transport } = recordingTransport();
    const name = "Fictional unlogged-path CLI";
    const pairing = await pairBySignIn({
      gateway: unlogged,
      name,
      keyFile: join(directory, "unlogged", "device.key"),
      gatewayJson: transport,
    });
    const held = await waitFor(
      async () => (await unlogged.pendingRequests()).find((request) => request.name === name),
      "the held request",
    );
    expect(requests[0]!.body.requireApproval).toBe(true);
    // The gateway lists the request before the device has read its reply.
    await waitFor(() => requests[0]!.reply !== undefined, "the device to read the reply");
    expect(requests[0]!.reply).toMatchObject({ status: "pending" });
    // The sign-in itself was trusted; only the certificate check held it.
    expect(held).toMatchObject({ signIn: "passkey", canTrustSignIn: false });
    await waitFor(() => pairing.comparisons.length === 1, "the comparison code");
    expect(pairing.comparisons[0]).toBe(held.verificationCode);
    await unlogged.decide(held.requestId, true);
    const joined = await pairing.result;
    expect(
      (await unlogged.devices()).find((device) => device.id === joined.deviceId)?.enrollment,
    ).toMatchObject({
      method: "approved",
    });
  }, 180_000);

  test("a relay-signed attestation alone, with a valid device key, only yields a held request", async () => {
    const account = await signedInAccount(world, session);
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const devicePublicKey = key.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const request = {
      requestId: randomUUID(),
      kind: "cli" as const,
      name: "Fictional relay-minted CLI",
      secret: randomBytes(32).toString("hex"),
    };
    const nonce = enrollmentNonce({ ...request, devicePublicKey });
    const identityToken = await (
      await world.accountAuthority()
    ).issue({
      accountId: account.accountId,
      gatewayId: logged.gatewayId,
      ownerAccountId: await logged.ownerAccountId(),
      nonce,
    });
    const target = { publicOrigin: logged.publicOrigin, certificate: logged.leaf.cert };
    await logged.pace(2);
    const { challenge } = (await devicePinnedJson(target, "/devices/account/challenge", {})) as {
      challenge: string;
    };
    const reply = (await devicePinnedJson(target, "/devices/account/request", {
      ...request,
      identityToken,
      deviceKey: {
        publicKey: devicePublicKey,
        challenge,
        signature: signDeviceTranscript(
          key.privateKey,
          enrollmentSignatureTranscript({
            ...request,
            gatewaySpkiFingerprint: tlsSpkiFingerprint(logged.leaf.cert),
            challenge,
            devicePublicKey,
          }),
        ),
      },
    })) as { status: string; pairingCode?: string; verificationCode: string; codeNonce: string };
    expect(reply.status).toBe("pending");
    expect(reply.pairingCode).toBeUndefined();
    const held = (await logged.pendingRequests()).find(
      (value) => value.requestId === request.requestId,
    );
    expect(held).toMatchObject({ status: "pending", canTrustSignIn: false });
    expect(held?.signIn).toBeUndefined();
    // The relay could send the request, but not choose its code: the gateway committed to its
    // nonce in the challenge, before it saw the request, and the six digits follow from both.
    expect(pairingCodeCommitment(reply.codeNonce)).toBe(challenge);
    const derived = pairingComparisonCode({
      ...request,
      gatewayFingerprint: certificateFingerprint(logged.leaf.cert),
      codeNonce: reply.codeNonce,
    });
    expect(derived).toMatch(/^[0-9]{3} [0-9]{3}$/);
    expect(reply.verificationCode).toBe(derived);
    expect(held?.verificationCode).toBe(derived);
    expect(held).not.toHaveProperty("codeNonce");
    await logged.decide(request.requestId, false);
    expect((await logged.devices()).some((device) => device.name === request.name)).toBe(false);
  }, 60_000);

  test("a certificate swap: the device signs for the certificate it was shown, the real gateway refuses with 403, and the device saves nothing", async () => {
    const swapLeaf = await world.pki.leaf("swap", [logged.hostname], { sct: true });
    const proxy = await certificateSwapProxy(world, swapLeaf, logged.hostname);
    const before = (await logged.devices()).length;
    const keyFile = join(directory, "swapped", "device.key");
    try {
      // The relay's gateway directory answers with the substitute certificate.
      const swappingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (new URL(String(input)).pathname !== "/_relay/v3/gateway") return response;
        const value = (await response.json()) as { binding: { certificate: string } };
        value.binding.certificate = swapLeaf.cert;
        return Response.json(value);
      };
      const pairing = await pairBySignIn({
        gateway: logged,
        name: "Fictional swapped CLI",
        keyFile,
        fetch: swappingFetch,
        gatewayJson: (candidate, path, body, signal, connectHost, options) =>
          devicePinnedJson(candidate, path, body, signal, connectHost, {
            ...options,
            connectPort: proxy.port,
          }),
      });
      const failure = await pairing.result.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(GatewayRefused);
      expect((failure as GatewayRefused).status).toBe(403);
      expect(pairing.comparisons).toEqual([]);
    } finally {
      await proxy.close();
    }
    expect((await logged.devices()).length).toBe(before);
    expect(
      (await logged.pendingRequests()).some((value) => value.name === "Fictional swapped CLI"),
    ).toBe(false);
    // Only the install's own key file exists; no device bundle or token was written.
    expect(await readdir(join(directory, "swapped"))).toEqual(["device.key"]);
    createPrivateKey(await readFile(keyFile, "utf8"));
  }, 180_000);

  test("a captured request cannot be replayed into another join", async () => {
    const { requests, transport } = recordingTransport();
    const joined = await (
      await pairBySignIn({
        gateway: logged,
        name: "Fictional replayed CLI",
        keyFile: join(directory, "replayed", "device.key"),
        gatewayJson: transport,
      })
    ).result;
    const captured = requests[0]!;
    expect(captured.reply).toMatchObject({ status: "approved" });
    const target = { publicOrigin: logged.publicOrigin, certificate: logged.leaf.cert };
    const devices = (await logged.devices()).length;
    await logged.pace(2);

    // The same body again: its one-use challenge is spent, so at most the
    // original answer comes back, whose pairing code was already redeemed.
    const again = await devicePinnedJson(target, "/devices/account/request", captured.body).catch(
      (error: unknown) => error,
    );
    if (again instanceof GatewayRefused) expect([403, 404, 409]).toContain(again.status);
    else {
      expect(again).toMatchObject({ pairingCode: captured.reply!.pairingCode });
      const redeemed = await devicePinnedJson(target, "/devices/pair", {
        pairingCode: (again as { pairingCode: string }).pairingCode,
        capabilities: { platform: "cli" },
      }).catch((error: unknown) => error);
      expect(redeemed).toBeInstanceOf(GatewayRefused);
    }
    // Under a fresh request id the signature and the spent challenge both fail.
    const renamed = await devicePinnedJson(target, "/devices/account/request", {
      ...captured.body,
      requestId: randomUUID(),
    }).catch((error: unknown) => error);
    expect(renamed).toBeInstanceOf(GatewayRefused);
    expect([403, 409]).toContain((renamed as GatewayRefused).status);
    expect((await logged.devices()).length).toBe(devices);
    expect((await logged.devices()).filter((device) => device.id === joined.deviceId)).toHaveLength(
      1,
    );
  }, 180_000);

  test(
    "F23: a certificate for the gateway's name with another key holds every new device until the owner acknowledges it on the gateway itself; no request through the relay lifts it and a restart keeps it",
    async () => {
      const ctLog = await certificateLog(world);
      let watched: EnrollmentGateway | undefined;
      try {
        watched = await EnrollmentGateway.start(world, "watched", {
          extraEnv: {
            OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
            OMNESIS_CLOUD_RELAY_CERTSPOTTER_URL: ctLog.url,
            OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_INTERVAL_MS: "60000",
          },
        });
        const gateway = watched;
        // The gateway's own certificate is logged, as every public one is: no incident.
        ctLog.log(gateway.leaf.cert);
        const linked = await connectGatewayBySignIn(gateway, session, "existing");
        if (linked.connect?.state !== "done")
          throw new Error(`Link failed: ${JSON.stringify(linked.connect)}`);
        await gateway.setPolicy("automatic");
        const observing = await waitFor(
          async () => {
            const status = await gateway.status();
            return status.certificateMonitor?.state === "observing" ? status : undefined;
          },
          "the certificate monitor to check the log",
          60_000,
        );
        expect(observing.certificateMonitor!.incidents).toEqual([]);
        expect(observing.deviceEnrollment.policy).toBe("automatic");
        expect(observing).not.toHaveProperty("incidentHold");

        // Someone obtains a publicly trusted, logged certificate for the gateway's name
        // with a key of their own.
        const rogue = await world.pki.leaf("rogue", [gateway.hostname], { sct: true });
        const rogueFingerprint = new X509Certificate(rogue.cert).fingerprint256
          .replaceAll(":", "")
          .toLowerCase();
        ctLog.log(rogue.cert);
        const held = await waitFor(
          async () => {
            const status = await gateway.status();
            return status.incidentHold ? status : undefined;
          },
          "the gateway to hold new devices",
          150_000,
        );
        expect(held.incidentHold!.certificates).toEqual([rogueFingerprint]);
        expect(
          held.certificateMonitor!.incidents.map((incident) => incident.certificateFingerprint),
        ).toEqual([rogueFingerprint]);
        expect(held.deviceEnrollment.policy).toBe("ask");

        // A sign-in the gateway trusts, which joined with no approval before, now waits for one.
        const name = "Fictional held-by-incident CLI";
        const pairing = await pairBySignIn({
          gateway,
          name,
          keyFile: join(directory, "incident", "device.key"),
        });
        const request = await waitFor(
          async () => (await gateway.pendingRequests()).find((value) => value.name === name),
          "the held request",
        );
        expect(request).toMatchObject({ status: "pending", signIn: "passkey" });
        await waitFor(() => pairing.comparisons.length === 1, "the comparison code");
        await gateway.decide(request.requestId, false);
        await expect(pairing.result).rejects.toBeDefined();
        expect((await gateway.devices()).some((device) => device.name === name)).toBe(false);

        // Through the relay, an admin credential is enough to read the status but never to
        // lift the hold, whether or not the relay marks the request as relayed.
        const token = gateway.harness.apiKey;
        const read = await gateway.throughRelay("/admin/cloud-relay", { token });
        expect(read.status).toBe(200);
        expect(JSON.parse(read.body)).toMatchObject({ incidentHold: held.incidentHold });
        const lifted = await gateway.throughRelay("/admin/cloud-relay/incidents/ack", {
          method: "POST",
          body: "{}",
          token,
        });
        expect(lifted.status).toBe(403);
        expect(JSON.parse(lifted.body)).toMatchObject({ code: "local-request-required" });
        // Nor does choosing automatic again lift it.
        await gateway.setPolicy("automatic");
        expect((await gateway.status()).deviceEnrollment.policy).toBe("ask");

        // A restart keeps the hold.
        await gateway.restart();
        const restarted = await gateway.status();
        expect(restarted.incidentHold).toEqual(held.incidentHold);
        expect(restarted.deviceEnrollment.policy).toBe("ask");

        // The owner, on the gateway host, acknowledges it.
        const ack = runCli(world, ["cloud", "incidents", "ack"], {
          OMNESIS_CLOUD_RELAY_ENABLED: "1",
          OMNESIS_CONFIG_DIR: join(directory, "incident-cli"),
          OMNESIS_GATEWAY_URL: gateway.harness.gatewayUrl,
          OMNESIS_TOKEN: token,
        });
        expect(await ack.exit, ack.stderr()).toBe(0);
        expect(ack.stdout()).toContain("Certificate incident acknowledged.");
        const acknowledged = await gateway.status();
        expect(acknowledged).not.toHaveProperty("incidentHold");
        expect(acknowledged.deviceEnrollment.policy).toBe("automatic");
        // The incident itself stays on record, and doesn't hold again after another restart.
        expect(acknowledged.certificateMonitor!.incidents).toHaveLength(1);
        await gateway.restart();
        await waitFor(
          async () => (await gateway.status()).certificateMonitor?.incidents.length === 1,
          "the monitor to read its journal",
          60_000,
        );
        expect(await gateway.status()).not.toHaveProperty("incidentHold");
      } finally {
        await watched?.close();
        await ctLog.close();
      }
    },
    gatewayBootBudgetMs() * 3 + 420_000,
  );

  test("F5/A2: a revoked device whose key signs in again with a trusted sign-in is held for the owner, and its row stays revoked until the owner approves", async () => {
    const name = "Fictional stolen CLI";
    const keyFile = join(directory, "stolen", "device.key");
    const joined = await (await pairBySignIn({ gateway: logged, name, keyFile })).result;
    const row = async () =>
      (await logged.devices()).find((device) => device.id === joined.deviceId);
    expect((await row())?.enrollment).toMatchObject({ method: "automatic" });
    // The owner revokes the lost device.
    await logged.json(`/admin/devices/${joined.deviceId}`, { method: "DELETE" });
    const revokedAt = (await row())?.revokedAt;
    expect(revokedAt).toEqual(expect.any(Number));

    // Whoever holds it signs in again: the policy is automatic, the passkey is
    // pinned and the leaf is logged, so only the revocation can hold it.
    const { requests, transport } = recordingTransport();
    const again = await pairBySignIn({ gateway: logged, name, keyFile, gatewayJson: transport });
    // The first join's request is still listed, as approved; this one must wait.
    const held = await waitFor(
      async () =>
        (await logged.pendingRequests()).find(
          (request) => request.name === name && request.status === "pending",
        ),
      "the held request",
    );
    expect(requests[0]!.body.requireApproval).toBeUndefined();
    await waitFor(() => requests[0]!.reply !== undefined, "the device to read the reply");
    expect(requests[0]!.reply).toMatchObject({ status: "pending" });
    expect(requests[0]!.reply).not.toHaveProperty("pairingCode");
    expect(held).toMatchObject({ signIn: "passkey", revokedDevice: true });
    expect((await row())?.revokedAt).toBe(revokedAt);

    // One approval brings the same device back.
    await waitFor(() => again.comparisons.length === 1, "the comparison code");
    expect(again.comparisons[0]).toBe(held.verificationCode);
    await logged.decide(held.requestId, true);
    const restored = await again.result;
    expect(restored.deviceId).toBe(joined.deviceId);
    expect((await row())?.revokedAt ?? null).toBeNull();
    expect((await row())?.enrollment).toMatchObject({ method: "approved", signIn: "passkey" });
  }, 300_000);

  // Removes the passkey pin, so it runs last.
  test("F24/TM-10: each device records the sign-in it joined with, and removing that sign-in can revoke every device that joined with it", async () => {
    const pinned = (await logged.status()).deviceEnrollment.trustedSignIns;
    expect(pinned).toHaveLength(1);
    const signIn = pinned[0]!;
    const joined = await (
      await pairBySignIn({
        gateway: logged,
        name: "Fictional rogue CLI",
        keyFile: join(directory, "rogue", "device.key"),
      })
    ).result;
    const bystander = await logged.json<{ device: { id: string } }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "Fictional bystander CLI",
        kind: "cli",
        scopes: ["read"],
        capabilities: { platform: "cli" },
      }),
    });
    const row = async (id: string) => (await logged.devices()).find((device) => device.id === id);
    expect((await row(joined.deviceId))?.enrollment).toMatchObject({
      method: "automatic",
      signIn: "passkey",
      signInId: signIn.id,
    });

    const removed = await logged.json<{ revokedDevices?: string[] }>(
      `/admin/cloud-relay/trusted-sign-ins/${encodeURIComponent(signIn.id)}?revokeDevices=true`,
      { method: "DELETE" },
    );
    expect(removed.revokedDevices).toContain(joined.deviceId);
    expect(removed.revokedDevices).not.toContain(bystander.device.id);
    expect((await row(joined.deviceId))?.revokedAt).toEqual(expect.any(Number));
    expect((await row(bystander.device.id))?.revokedAt ?? null).toBeNull();
    expect((await logged.status()).deviceEnrollment.trustedSignIns).toEqual([]);
  }, 300_000);
});
