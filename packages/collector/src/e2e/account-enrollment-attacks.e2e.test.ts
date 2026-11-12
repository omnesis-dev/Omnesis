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
 *   the embedded SCT extension makes the device ask for the comparison.
 *
 * The automatic policy is on and the signing passkey is pinned throughout, so
 * every hold below is caused by the attack, not by the owner's settings.
 */

import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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
});
