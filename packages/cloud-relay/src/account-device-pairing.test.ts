// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as desktop from "./account-desktop-client.js";
import * as network from "./network.js";
import * as publicCertificate from "./public-certificate.js";
import { pairAccountDevice } from "./account-device-pairing.js";
import { gatewayBindingSchema, certificateFingerprint } from "./gateway-binding.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import {
  enrollmentNonce,
  enrollmentSignatureTranscript,
  pairingCodeCommitment,
  pairingComparisonCode,
  verifyDeviceSignature,
  type DeviceKeyEvidence,
} from "./device-enrollment.js";
import { googlePairingNonce } from "./google-pairing.js";
import type { authorizeAccountDesktop } from "./account-desktop-client.js";
import type { pinnedGatewayJson } from "./device-pairing.js";
const vectors = JSON.parse(
  await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
);
const candidate = gatewayBindingSchema.parse(vectors.gateway),
  accountId = "b".repeat(64);
let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "account-device-key-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  vi.useFakeTimers({ toFake: ["Date"], now: vectors.clock * 1000 });
  const identity = {
    status: "approved" as const,
    discoveryToken: "discovery-only",
    accountId,
    expiresAt: vectors.clock + 300,
  };
  let nonce = "",
    code = "",
    approved = false,
    immediate = false;
  // The stand-in gateway's nonce, and the challenge that commits to it.
  const codeNonce = randomBytes(32).toString("base64url");
  const challenge = pairingCodeCommitment(codeNonce);
  const requests: Record<string, unknown>[] = [];
  const authorize = vi.fn<typeof authorizeAccountDesktop>(async (options) => {
    nonce = options.nonce;
    return identity;
  });
  const selected = {
    binding: candidate,
    accountId,
    identityToken: "gateway-scoped-proof",
    expiresAt: identity.expiresAt,
  };
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.headers).toEqual({ authorization: "Bearer discovery-only" });
    return Response.json(
      new URL(String(url)).pathname.endsWith("/gateways")
        ? {
            gateways: [
              {
                gatewayId: candidate.gatewayId,
                publicOrigin: candidate.publicOrigin,
                displayName: "Fictional home",
              },
            ],
          }
        : selected,
    );
  });
  const gatewayJson = vi.fn<typeof pinnedGatewayJson>(async (binding, path, body) => {
    expect(binding).toEqual(candidate);
    if (path === "/devices/account/challenge") {
      expect(body).toEqual({});
      return { challenge, expiresAt: Date.now() + 120_000 };
    } else if (path === "/devices/account/request") {
      const value = body as {
        requestId: string;
        secret: string;
        kind: "cli";
        name: string;
        identityToken: string;
        deviceKey: DeviceKeyEvidence;
      };
      requests.push(body as Record<string, unknown>);
      expect(value.identityToken).toBe(selected.identityToken);
      expect(googlePairingNonce(value)).not.toBe(nonce);
      expect(enrollmentNonce({ ...value, devicePublicKey: value.deviceKey.publicKey })).toBe(nonce);
      expect(value.deviceKey.challenge).toBe(challenge);
      expect(
        verifyDeviceSignature(
          value.deviceKey.publicKey,
          enrollmentSignatureTranscript({
            ...value,
            gatewaySpkiFingerprint: tlsSpkiFingerprint(candidate.certificate),
            challenge,
            devicePublicKey: value.deviceKey.publicKey,
          }),
          value.deviceKey.signature,
        ),
      ).toBe(true);
      // A device key names the challenge; it is not repeated beside it.
      expect(value).not.toHaveProperty("challenge");
      code = pairingComparisonCode({
        ...value,
        gatewayFingerprint: certificateFingerprint(candidate.certificate),
        codeNonce,
      });
      if (immediate) approved = true;
    } else if (path === "/devices/account/poll") approved = true;
    else if (path === "/devices/pair") {
      expect(approved).toBe(true);
      return {
        token: "stable-device-credential",
        device: { id: randomUUID(), kind: "cli" },
        scopes: ["read:all"],
      };
    } else if (path === "/devices/direct-candidates") return { version: 1, candidates: [] };
    else throw new Error("Unexpected endpoint");
    return {
      status: approved ? "approved" : "pending",
      verificationCode: code,
      codeNonce,
      expiresAt: Date.now() + 60_000,
      ...(approved ? { pairingCode: "approved-only-code" } : {}),
    };
  });
  const selectGateway = vi.fn(async () => candidate.gatewayId),
    confirm = vi.fn(async () => true),
    wait = vi.fn(async () => {}),
    publiclyLogged = vi.fn(async () => true),
    deviceKeyFile = join(directory, "device.json.key");
  return {
    requests,
    publiclyLogged,
    deviceKeyFile,
    approveImmediately() {
      immediate = true;
    },
    identity,
    selected,
    authorize,
    transport,
    gatewayJson,
    selectGateway,
    confirm,
    run: () =>
      pairAccountDevice(
        {
          relayUrl: "https://relay.example.test",
          kind: "cli",
          name: "Fictional terminal",
          deviceKeyFile,
          confirm,
          selectGateway,
        },
        { authorize, fetch: transport, gatewayJson, wait, publiclyLogged },
      ),
  };
}
test("account sign-in takes a single gateway without asking and preserves trusted approval plus strict TLS pairing", async () => {
  const f = setup();
  const result = await f.run();
  expect(f.selectGateway).not.toHaveBeenCalled();
  // This caller gives no way to wait for approval, so a held request falls back to the comparison.
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.requests[0]).not.toHaveProperty("requireApproval");
  expect(f.requests[0]).not.toHaveProperty("proof");
  expect(f.publiclyLogged).toHaveBeenCalledWith(candidate, expect.any(AbortSignal));
  expect((await stat(f.deviceKeyFile)).mode & 0o777).toBe(0o600);
  expect(result).toMatchObject({
    token: "stable-device-credential",
    kind: "cli",
    gatewayUrl: candidate.publicOrigin,
    tlsSpkiFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(f.gatewayJson.mock.calls.map(([, path]) => path)).toEqual([
    "/devices/account/challenge",
    "/devices/account/request",
    "/devices/account/poll",
    "/devices/pair",
    "/devices/direct-candidates",
  ]);
});
test("changed account, lifetime, gateway identity or origin is refused before provisional gateway traffic", async () => {
  for (const change of [
    { accountId: "c".repeat(64) },
    { expiresAt: vectors.clock + 301 },
    { expiresAt: vectors.clock - 1 },
    { binding: { ...candidate, gatewayId: randomUUID() } },
    { binding: { ...candidate, publicOrigin: "https://other.example.test" } },
  ]) {
    const f = setup();
    Object.assign(f.selected, change);
    await expect(f.run()).rejects.toThrow();
    expect(f.gatewayJson).not.toHaveBeenCalled();
  }
});
test("empty directories, unlisted choices, denied comparison and missing approval never issue data credentials", async () => {
  const empty = setup();
  empty.transport.mockResolvedValue(Response.json({ gateways: [] }));
  await expect(empty.run()).rejects.toThrow("No gateways");
  expect(empty.gatewayJson).not.toHaveBeenCalled();
  const unlisted = setup();
  unlisted.transport.mockImplementation(async (url) =>
    Response.json(
      new URL(String(url)).pathname.endsWith("/gateways")
        ? {
            gateways: [
              { gatewayId: candidate.gatewayId, publicOrigin: candidate.publicOrigin },
              { gatewayId: randomUUID(), publicOrigin: "https://other.example.test" },
            ],
          }
        : unlisted.selected,
    ),
  );
  unlisted.selectGateway.mockResolvedValue(randomUUID());
  await expect(unlisted.run()).rejects.toThrow("Choose one");
  expect(unlisted.selectGateway).toHaveBeenCalledOnce();
  expect(unlisted.gatewayJson).not.toHaveBeenCalled();
  const denied = setup();
  denied.confirm.mockResolvedValue(false);
  await expect(denied.run()).rejects.toThrow("cancelled");
  expect(denied.gatewayJson.mock.calls.map(([, path]) => path)).toEqual([
    "/devices/account/challenge",
    "/devices/account/request",
  ]);
});

test("installed account pairing defaults use the native browser client and pinned transport", async () => {
  const f = setup();
  vi.spyOn(desktop, "authorizeAccountDesktop").mockImplementation(f.authorize);
  const logged = vi
    .spyOn(publicCertificate, "certificateIsPubliclyLogged")
    .mockImplementation(f.publiclyLogged);

  vi.stubGlobal("fetch", f.transport);
  const result = await pairAccountDevice(
    {
      relayUrl: "https://relay.example.test",
      kind: "cli",
      name: "Fictional terminal",
      deviceKeyFile: f.deviceKeyFile,
      confirm: f.confirm,
      selectGateway: f.selectGateway,
    },
    { gatewayJson: f.gatewayJson, wait: async () => {} },
  );
  expect(result.token).toBe("stable-device-credential");
  expect(logged).toHaveBeenCalledOnce();
  vi.spyOn(network, "connectOrigin").mockRejectedValue(new Error("Synthetic TLS peer unavailable"));
  await expect(
    pairAccountDevice({
      relayUrl: "https://relay.example.test",
      kind: "cli",
      name: "Fictional terminal",
      deviceKeyFile: f.deviceKeyFile,
      confirm: f.confirm,
      selectGateway: f.selectGateway,
    }),
  ).rejects.toThrow("Synthetic TLS peer unavailable");
});

test("a gateway that admits the signed-in device at once skips the code comparison and forwards the sign-in proof", async () => {
  const f = setup();
  const proof = {
    type: "google" as const,
    idToken: "header.payload.signature",
    salt: randomBytes(32).toString("base64url"),
  };
  const onConnectCode = vi.fn();
  const original = f.authorize.getMockImplementation()!;
  f.authorize.mockImplementation(async (options, dependencies) => {
    expect(options.onConnectCode).toBe(onConnectCode);
    return { ...(await original(options, dependencies)), signInProof: proof };
  });
  f.approveImmediately();
  const result = await pairAccountDevice(
    {
      relayUrl: "https://relay.example.test",
      kind: "cli",
      name: "Fictional terminal",
      deviceKeyFile: f.deviceKeyFile,
      confirm: f.confirm,
      selectGateway: f.selectGateway,
      onConnectCode,
    },
    {
      authorize: f.authorize,
      fetch: f.transport,
      gatewayJson: f.gatewayJson,
      wait: async () => {},
      publiclyLogged: f.publiclyLogged,
    },
  );
  expect(result.token).toBe("stable-device-credential");
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.requests[0]).toMatchObject({ proof });
  expect(f.gatewayJson.mock.calls.map(([, path]) => path)).toEqual([
    "/devices/account/challenge",
    "/devices/account/request",
    "/devices/pair",
    "/devices/direct-candidates",
  ]);
});

test("a held request to a publicly logged gateway shows the code once and joins by itself once approved", async () => {
  const f = setup();
  const awaitApproval = vi.fn();
  const options = {
    relayUrl: "https://relay.example.test",
    kind: "cli" as const,
    name: "Fictional terminal",
    deviceKeyFile: f.deviceKeyFile,
    confirm: f.confirm,
    selectGateway: f.selectGateway,
    awaitApproval,
  };
  const dependencies = {
    authorize: f.authorize,
    fetch: f.transport,
    gatewayJson: f.gatewayJson,
    wait: async () => {},
    publiclyLogged: f.publiclyLogged,
  };
  const result = await pairAccountDevice(options, dependencies);
  expect(result.token).toBe("stable-device-credential");
  expect(f.confirm).not.toHaveBeenCalled();
  expect(awaitApproval).toHaveBeenCalledExactlyOnceWith({
    gatewayUrl: candidate.publicOrigin,
    verificationCode: expect.stringMatching(/^[0-9]{3} [0-9]{3}$/),
  });
  expect(f.gatewayJson.mock.calls.map(([, path]) => path)).toEqual([
    "/devices/account/challenge",
    "/devices/account/request",
    "/devices/account/poll",
    "/devices/pair",
    "/devices/direct-candidates",
  ]);

  // The owner refuses on the phone: the wait ends without a credential.
  const denied = setup();
  const original = denied.gatewayJson.getMockImplementation()!;
  denied.gatewayJson.mockImplementation(async (binding, path, ...rest) => {
    const reply = await original(binding, path, ...rest);
    return path === "/devices/account/poll"
      ? { ...(reply as object), status: "denied", pairingCode: undefined }
      : reply;
  });
  await expect(
    pairAccountDevice(
      { ...options, deviceKeyFile: denied.deviceKeyFile, confirm: denied.confirm },
      { ...dependencies, authorize: denied.authorize, gatewayJson: denied.gatewayJson },
    ),
  ).rejects.toThrow("denied the pairing request");
  expect(denied.confirm).not.toHaveBeenCalled();
  expect(denied.gatewayJson.mock.calls.map(([, path]) => path)).not.toContain("/devices/pair");

  // Admitted at once: there is nothing to wait for, so nothing is announced.
  const immediate = setup();
  immediate.approveImmediately();
  awaitApproval.mockClear();
  await pairAccountDevice(
    { ...options, deviceKeyFile: immediate.deviceKeyFile, confirm: immediate.confirm },
    { ...dependencies, authorize: immediate.authorize, gatewayJson: immediate.gatewayJson },
  );
  expect(awaitApproval).not.toHaveBeenCalled();
  expect(immediate.confirm).not.toHaveBeenCalled();
});

test("a certificate that is not publicly logged keeps the typed comparison even when the terminal could wait", async () => {
  const f = setup();
  f.publiclyLogged.mockResolvedValue(false);
  const awaitApproval = vi.fn();
  await pairAccountDevice(
    {
      relayUrl: "https://relay.example.test",
      kind: "cli",
      name: "Fictional terminal",
      deviceKeyFile: f.deviceKeyFile,
      confirm: f.confirm,
      selectGateway: f.selectGateway,
      awaitApproval,
    },
    {
      authorize: f.authorize,
      fetch: f.transport,
      gatewayJson: f.gatewayJson,
      wait: async () => {},
      publiclyLogged: f.publiclyLogged,
    },
  );
  expect(f.requests[0]).toMatchObject({ requireApproval: true });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(awaitApproval).not.toHaveBeenCalled();
});

test("a certificate that is not publicly logged asks the gateway to hold the request for comparison", async () => {
  const f = setup();
  f.publiclyLogged.mockResolvedValue(false);
  await f.run();
  expect(f.requests[0]).toMatchObject({ requireApproval: true });
  expect(f.confirm).toHaveBeenCalledOnce();
  // A gateway that answers "approved" anyway may be a substitute, so the comparison still runs.
  const substitute = setup();
  substitute.publiclyLogged.mockResolvedValue(false);
  substitute.approveImmediately();
  substitute.confirm.mockResolvedValue(false);
  await expect(substitute.run()).rejects.toThrow("cancelled");
  expect(substitute.gatewayJson.mock.calls.map(([, path]) => path)).not.toContain("/devices/pair");
});

test("the device key file is created once, private, and reused; an unreadable one stops pairing", async () => {
  const first = setup();
  await first.run();
  const saved = await readFile(first.deviceKeyFile, "utf8");
  const firstKey = (first.requests[0]!.deviceKey as DeviceKeyEvidence).publicKey;
  const second = setup();
  await second.run();
  expect(await readFile(second.deviceKeyFile, "utf8")).toBe(saved);
  expect((second.requests[0]!.deviceKey as DeviceKeyEvidence).publicKey).toBe(firstKey);
  await writeFile(second.deviceKeyFile, "not a key");
  const broken = setup();
  await expect(broken.run()).rejects.toThrow("device key could not be read");
  expect(broken.authorize).not.toHaveBeenCalled();
});

test("a malformed challenge reply refuses to send the enrollment request", async () => {
  const f = setup();
  f.gatewayJson.mockImplementationOnce(async () => ({ challenge: "short", expiresAt: 1 }));
  await expect(f.run()).rejects.toThrow();
  expect(f.requests).toEqual([]);
});
