// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Security properties of sign-in enrollment (docs/device-enrollment.md),
 * end to end against a real relay daemon, real gateways, the real CLI and the
 * Node pairing client. Each block boots its own world.
 */

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeAccountDesktop,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  pairAccountDevice,
  passkeyProofChallenge,
  signDeviceTranscript,
  tlsSpkiFingerprint,
} from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  RELAY_HOST,
  REPO_ROOT,
  browserSuiteAvailable,
  clickFirst,
  connectGatewayBySignIn,
  devicePinnedJson,
  freePort,
  launchedUrls,
  printedConnectCode,
  signInForDevice,
  signInOnThisMachine,
  signedInAccount,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { registerSubprocessGroup } from "./subprocess-reaper.js";

// ── Section 1: desktop sign-in proves the same machine (loopback) ───────────
// ── Section 3: passkey pins come from the relay's credential list ───────────
// Both run in one world: a gateway linked to one passkey account, policy automatic by default.

const browserReady = browserSuiteAvailable("account-enrollment-security.e2e");

/** A P-256 passkey nobody registered: any key makes an assertion that verifies under itself. */
function selfMadePasskey(relayOrigin: string) {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  // COSE: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  const id = randomBytes(16).toString("base64url");
  return {
    id,
    publicKey: cose.toString("base64url"),
    assert(challenge: string) {
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin: relayOrigin,
          crossOrigin: false,
        }),
      );
      // The relay's RP ID, user present and verified, counter 0.
      const authData = Buffer.concat([
        createHash("sha256").update(RELAY_HOST).digest(),
        Buffer.from([0x05, 0, 0, 0, 0]),
      ]);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
        pair.privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key" as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: "dXNlcg",
        },
      };
    },
  };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

describe.skipIf(!browserReady)(
  "a desktop sign-in joins on its own only from the machine it finished on",
  () => {
    let directory: string;
    let world: EnrollmentWorld;
    let browser: PasskeyBrowser;
    let gateway: EnrollmentGateway;
    /** The owner's browser, holding the passkey the gateway pinned when it was linked. */
    let owner: PasskeySession;
    const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
    const priorEnabled = process.env.OMNESIS_CLOUD_RELAY_ENABLED;

    /** Starts the real Node pairing client. `launchUrl` is what it would open in a browser. */
    async function startPairing(options: {
      name: string;
      listen?: NonNullable<Parameters<typeof authorizeAccountDesktop>[1]>["listen"];
    }) {
      await gateway.pace(2);
      const comparisons: string[] = [];
      let launched!: (url: string) => void;
      let printed!: (value: { connectUrl: string; code: string }) => void;
      const launchUrl = new Promise<string>((resolve) => (launched = resolve));
      const code = new Promise<{ connectUrl: string; code: string }>(
        (resolve) => (printed = resolve),
      );
      const result = pairAccountDevice(
        {
          kind: "cli",
          name: options.name,
          relayUrl: world.relayOrigin,
          deviceKeyFile: join(directory, randomUUID(), "device.key"),
          signal: AbortSignal.timeout(150_000),
          selectGateway: async () => {
            throw new Error("One linked gateway needs no chooser");
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
              ...(options.listen ? { listen: options.listen } : {}),
            }),
        },
      );
      result.catch(() => undefined);
      return { result, comparisons, launchUrl, code };
    }

    async function heldRequest(name: string, timeoutMs = 60_000) {
      return waitFor(
        async () =>
          (await gateway.pendingRequests()).find(
            (request) => request.name === name && request.status === "pending",
          ),
        `a held request from ${name}`,
        timeoutMs,
      );
    }

    async function joinedRow(deviceId: string) {
      return (await gateway.devices()).find((device) => device.id === deviceId);
    }

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-security-"));
      world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
      process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
      // The pairing client runs in this process.
      process.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
      browser = await PasskeyBrowser.launch(world);
      gateway = await EnrollmentGateway.start(world, "security");
      owner = await browser.session();
      const linked = await connectGatewayBySignIn(gateway, owner, "create");
      if (linked.connect?.state !== "done" || !linked.account.linked)
        throw new Error(`Gateway did not link: ${JSON.stringify(linked.connect)}`);
      // Nothing is chosen here: the policy is the automatic default throughout. A sign-in made on
      // the relay's page is held whatever the setting; each test checks what else holds.
      if (linked.deviceEnrollment.policy !== "automatic")
        throw new Error(`Expected the automatic default: ${linked.deviceEnrollment.policy}`);
    }, gatewayBootBudgetMs() + 120_000);

    afterAll(async () => {
      try {
        await browser?.close();
        await gateway?.close();
        await world?.close();
      } finally {
        if (priorCaFile === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
        else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCaFile;
        if (priorEnabled === undefined) delete process.env.OMNESIS_CLOUD_RELAY_ENABLED;
        else process.env.OMNESIS_CLOUD_RELAY_ENABLED = priorEnabled;
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);

    test("TM-01: on the machine where the sign-in finished, the browser hands the CLI its completion over loopback, but a sign-in made on the relay's page is held, never joined on its own", async () => {
      // The link pinned the owner's passkey from the relay's page, and says so: a suggestion.
      expect((await gateway.status()).deviceEnrollment.trustedSignIns).toEqual([
        expect.objectContaining({ type: "passkey", source: "link-page", confirmed: false }),
      ]);
      const name = "Fictional local CLI";
      const pairing = await startPairing({ name });
      await signInOnThisMachine(owner, await pairing.launchUrl);
      expect(owner.page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/omnesis\/callback\?/);
      // The completion released the proof, so the request names the passkey sign-in...
      const held = await heldRequest(name);
      expect(held).toMatchObject({ signIn: "passkey", canTrustSignIn: false });
      await waitFor(() => pairing.comparisons.length === 1, "the comparison code");
      expect(pairing.comparisons).toEqual([held.verificationCode]);
      // ...and only the owner's approval lets it in.
      await gateway.decide(held.requestId, true);
      const joined = await pairing.result;
      expect((await joinedRow(joined.deviceId))?.enrollment).toMatchObject({
        method: "approved",
        signIn: "passkey",
      });
    }, 180_000);

    test("a phished link: the owner completes an attacker's sign-in on their own machine, and the attacker's device is only held", async () => {
      // The attacker's listener is on the attacker's machine: on the owner's, nothing answers.
      const unreachable = await freePort();
      const name = "Fictional attacker CLI";
      const attacker = await startPairing({
        name,
        listen: async () => ({
          port: unreachable,
          completion: () => undefined,
          expect: () => {},
          close: () => {},
        }),
      });
      const before = (await gateway.devices()).length;
      // The attacker sends the owner the sign-in link; the owner signs in and confirms.
      const handoff = owner.page.waitForRequest((request) =>
        request.url().startsWith(`http://127.0.0.1:${unreachable}/omnesis/callback?`),
      );
      await owner.page.goto(await attacker.launchUrl);
      await clickFirst(owner.page, ["Sign in with Passkey", "Verify with Passkey"]);
      await clickFirst(owner.page, ["Continue on this device"]);
      await handoff;
      // Without the completion the relay releases no proof, so the trusted passkey can't vouch.
      const held = await heldRequest(name);
      expect(held).toMatchObject({ canTrustSignIn: false });
      expect(held.signIn).toBeUndefined();
      await gateway.decide(held.requestId, false);
      await expect(attacker.result).rejects.toThrow("denied");
      expect((await gateway.devices()).length).toBe(before);
      expect((await gateway.devices()).some((device) => device.name === name)).toBe(false);
    }, 180_000);

    test("a connect code: signing in on another device holds the request until the owner approves, then it joins", async () => {
      const name = "Fictional code CLI";
      const pairing = await startPairing({ name });
      await signInForDevice(owner, await pairing.code);
      expect(await owner.page.textContent("body")).toContain("approve it on your phone");
      const held = await heldRequest(name);
      expect(held).toMatchObject({ canTrustSignIn: false });
      expect(held.signIn).toBeUndefined();
      await waitFor(() => pairing.comparisons.length === 1, "the comparison code");
      expect(pairing.comparisons[0]).toBe(held.verificationCode);
      await gateway.decide(held.requestId, true);
      const joined = await pairing.result;
      expect((await joinedRow(joined.deviceId))?.enrollment).toMatchObject({ method: "approved" });
    }, 180_000);

    test("over SSH the real CLI says approval is needed, prints the comparison code, waits, and joins once approved", async () => {
      const configDir = join(directory, "ssh-cli");
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await gateway.pace(2);
      const cli = e2eTsxCommand("packages/cli/src/index.ts");
      const name = "Fictional remote terminal";
      const command = [cli.command, ...cli.args, "cloud", "pair", "--kind", "cli", "--name", name]
        .map(shellQuote)
        .join(" ");
      const launchesBefore = (await launchedUrls(world)).length;
      // `script` gives the CLI a terminal, as an SSH session does; no desktop browser opens.
      const proc = spawn("script", ["-qfec", command, "/dev/null"], {
        cwd: REPO_ROOT,
        env: {
          ...e2eGatewayEnv(),
          ...world.clientEnv(),
          PATH: `${world.noBrowserBin}:${process.env.PATH ?? ""}`,
          OMNESIS_LOG_LEVEL: "error",
          OMNESIS_GATEWAY_URL: undefined,
          OMNESIS_TOKEN: undefined,
          OMNESIS_CONFIG_DIR: configDir,
          OMNESIS_CLOUD_RELAY_ENABLED: "1",
          OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
          OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE: world.pki.caCertFile,
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      registerSubprocessGroup(proc);
      let output = "",
        closed = false;
      proc.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
      proc.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const exit = new Promise<number | null>((resolve) =>
        proc.once("close", (code) => {
          closed = true;
          resolve(code);
        }),
      );
      try {
        const printed = await printedConnectCode({
          proc,
          stdout: () => output,
          stderr: () => output,
          exit,
          closed: () => closed,
        });
        expect(output).toContain(
          "Signing in on another device needs your approval on your phone or another paired device",
        );
        // Printing the connect code precedes the asynchronous browser launch.
        // Wait for this CLI's launcher write, independently of its terminal output.
        const launch = await waitFor(
          async () => (await launchedUrls(world))[launchesBefore],
          "the SSH CLI's browser-launch attempt after printing its connect code",
        );
        expect(new URL(launch).origin).toBe(world.relayOrigin);
        expect(new URL(launch).pathname).toBe("/_relay/v3/desktop/begin");
        await signInForDevice(owner, printed);
        const held = await heldRequest(name);
        const shown = await waitFor(
          () => /Check that it shows this code: ([0-9]{3} [0-9]{3})/.exec(output)?.[1],
          "the CLI to print its comparison code",
        );
        expect(shown).toBe(held.verificationCode);
        await waitFor(() => output.includes("Waiting for approval…"), "the CLI to say it waits");
        // Nothing is typed: the CLI is still running, and the approval alone lets it finish.
        expect(closed).toBe(false);
        expect(output).not.toContain("Code shown on the trusted device");
        await gateway.decide(held.requestId, true);
        expect(await exit).toBe(0);
      } catch (error) {
        throw new Error(`CLI pairing over a terminal failed:\n${output}`, { cause: error });
      } finally {
        if (!closed) proc.kill();
      }
      const row = (await gateway.devices()).find((device) => device.name === name);
      expect(row).toMatchObject({ kind: "cli", enrollment: { method: "approved" } });
    }, 180_000);

    test("a passkey assertion made with a self-made key is held, and approving it can't make the gateway trust that key", async () => {
      const account = await signedInAccount(world, owner);
      const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const devicePublicKey = key.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url");
      const request = {
        requestId: randomUUID(),
        kind: "cli" as const,
        name: "Fictional self-made passkey CLI",
        secret: randomBytes(32).toString("hex"),
      };
      const nonce = enrollmentNonce({ ...request, devicePublicKey });
      // Anything that can get an attestation for the owner's account admits a held request.
      const identityToken = await (
        await world.accountAuthority()
      ).issue({
        accountId: account.accountId,
        gatewayId: gateway.gatewayId,
        ownerAccountId: await gateway.ownerAccountId(),
        nonce,
      });
      const forged = selfMadePasskey(world.relayOrigin);
      const salt = randomBytes(32).toString("base64url"),
        issuedAt = String(Math.floor(Date.now() / 1000));
      const target = { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert };
      await gateway.pace(2);
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
              gatewaySpkiFingerprint: tlsSpkiFingerprint(gateway.leaf.cert),
              challenge,
              devicePublicKey,
            }),
          ),
        },
        proof: {
          type: "passkey",
          salt,
          issuedAt,
          credentialPublicKey: forged.publicKey,
          credential: forged.assert(passkeyProofChallenge(salt, issuedAt, nonce)),
        },
      })) as { status: string; pairingCode?: string };
      // The assertion verifies under the key it brought, so it names a passkey sign-in...
      expect(reply.status).toBe("pending");
      expect(reply.pairingCode).toBeUndefined();
      const held = await heldRequest(request.name);
      // ...but the relay lists no such credential for the account, so it can't be trusted.
      expect(held).toMatchObject({ signIn: "passkey", canTrustSignIn: false });
      const pinned = (await gateway.status()).deviceEnrollment.trustedSignIns;
      await gateway.decide(held.requestId, true, true);
      const after = (await gateway.status()).deviceEnrollment;
      expect(after.trustedSignIns).toEqual(pinned);
      expect(after.trustedSignIns.some((pin) => pin.id === forged.id)).toBe(false);
      expect(after.confirmedSignIns).toEqual([]);
    }, 120_000);
  },
);

// ── Section 4: per-client rate limits through the relay ─────────────────────

/**
 * One HTTPS request from a chosen loopback source address. Linux treats all
 * of 127/8 as loopback, so 127.0.0.2 and 127.0.0.3 stand in for two people.
 */
async function requestFrom(
  source: string,
  port: number,
  hostname: string,
  path: string,
  body: unknown,
): Promise<number> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        localAddress: source,
        servername: hostname,
        path,
        method: "POST",
        rejectUnauthorized: false,
        agent: false,
        headers: {
          host: `${hostname}:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        signal: AbortSignal.timeout(15_000),
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

/** Requests from `source` until one is refused for its rate, returning how many got through. */
async function exhaust(send: () => Promise<number>, most: number): Promise<number> {
  for (let admitted = 0; admitted < most; admitted++) if ((await send()) === 429) return admitted;
  throw new Error(`No request was refused for its rate after ${most}`);
}

describe("one client cannot use up the rate limits of another", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let gateway: EnrollmentGateway;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-rates-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "invitation" });
    gateway = await EnrollmentGateway.start(world, "rates");
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    try {
      await gateway?.close();
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("the gateway counts each relayed client apart: one exhausting its pairing calls leaves another's alone", async () => {
    const challenge = (source: string) =>
      requestFrom(source, world.dataPort, gateway.hostname, "/devices/account/challenge", {});
    // Every relayed request reaches the gateway from its own tunnel over loopback,
    // so without the relay's word for the client they would all share one bucket.
    const admitted = await exhaust(() => challenge("127.0.0.2"), 30);
    expect(admitted).toBeGreaterThanOrEqual(10);
    expect(await challenge("127.0.0.2")).toBe(429);
    // This gateway has no linked account, so a request the limiter admits is then
    // refused as unavailable; only the limiter answers 429.
    expect(await challenge("127.0.0.3")).not.toBe(429);
    expect(await challenge("127.0.0.4")).not.toBe(429);
  }, 120_000);

  test("the relay counts sign-in starts per client: one exhausting its own leaves another's alone", async () => {
    await world.stopRelay();
    await world.startRelay({
      extraEnv: { OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE_PER_CLIENT: "4" },
    });
    try {
      const start = (source: string) =>
        requestFrom(source, world.relayPort, RELAY_HOST, "/_relay/v3/desktop/start", {
          nonce: randomBytes(32).toString("base64url"),
          challenge: randomBytes(32).toString("base64url"),
          kind: "collector",
          name: "Fictional rate probe",
        });
      expect(await exhaust(() => start("127.0.0.5"), 10)).toBe(4);
      expect(await start("127.0.0.5")).toBe(429);
      expect(await start("127.0.0.6")).not.toBe(429);
    } finally {
      await world.stopRelay();
      await world.startRelay({ extraEnv: {} });
    }
  }, 120_000);
});
