// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Devices joining by sign-in (docs/device-enrollment.md), end to end: a real
 * relay daemon, a real gateway tunnelled through it, the real CLI and the
 * Node pairing client, and a headless Chromium holding the account's passkeys.
 *
 * One gateway is linked to one passkey account at the start. The scenarios
 * then run in order, each leaving the gateway in the state the next expects:
 * the automatic default and opting out of it, a second passkey the first one
 * vouched for, the same passkey once its pin is removed, "ask me first",
 * automatic mode with the CLI and a collector, a device that joined
 * automatically administering the gateway at once, which row a sign-in lands
 * on, token rotation with the device key, and the portal: its own sign-in, and
 * the account page's sign-in handed to it.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeAccountDesktop,
  createRelayClientProxy,
  certificateFingerprint,
  pairAccountDevice,
  signDeviceTranscript,
  tlsSpkiFingerprint,
  tokenRotationTranscript,
} from "@omnesis/cloud-relay";
import { HttpGatewayClient, GatewayWsClient } from "@omnesis/gateway-client";
import { AccountId, SourceId, SourceType, ProviderId } from "@omnesis/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  GatewayRefused,
  PasskeyBrowser,
  addSecondPasskey,
  browserSuiteAvailable,
  chooseAccountMenu,
  clickFirst,
  copyPasskey,
  expectPasskeySignInRefused,
  expectText,
  freshAccountSignIn,
  syncPasskey,
  connectGatewayBySignIn,
  devicePinnedJson,
  passkeyIds,
  printedConnectCode,
  runCli,
  launchedUrls,
  signInOnThisMachine,
  waitFor,
  type DeviceRow,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import { getDocumentCount } from "./helpers.js";

const browserReady = browserSuiteAvailable("account-enrollment-devices.e2e");

describe.skipIf(!browserReady)("devices join a gateway by signing in", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let gateway: EnrollmentGateway;
  /** Holds the passkey the gateway pinned when it was linked. */
  let first: PasskeySession;
  /** Holds a passkey added to the same account afterwards. */
  let second: PasskeySession;
  const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
  const priorEnabled = process.env.OMNESIS_CLOUD_RELAY_ENABLED;

  /**
   * Pairs a CLI or collector in this process with the real Node client. The
   * person signs in on `session` once the client shows its code. Returns as
   * soon as the sign-in is done; `result` settles when the client finishes.
   */
  async function pairBySignIn(
    session: PasskeySession,
    options: {
      kind: "cli" | "collector";
      name: string;
      keyFile: string;
      gatewayJson?: typeof devicePinnedJson;
    },
  ) {
    await gateway.pace(2);
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
        kind: options.kind,
        name: options.name,
        relayUrl: world.relayOrigin,
        deviceKeyFile: options.keyFile,
        signal: AbortSignal.timeout(120_000),
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
          }),
        ...(options.gatewayJson ? { gatewayJson: options.gatewayJson } : {}),
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

  /** The gateway's own link file, where an owner's enrollment choice is the only policy on record. */
  async function linkRecord(): Promise<Record<string, unknown>> {
    const { configDir } = gateway.harness as unknown as { configDir: string };
    return JSON.parse(
      await readFile(join(configDir, "cloud-relay", "account-link.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  async function deviceRow(id: string): Promise<DeviceRow | undefined> {
    return (await gateway.devices()).find((device) => device.id === id);
  }

  /**
   * The request `pairing` is waiting on. A device the gateway turned away never has one, so its
   * failure is reported with the gateway's answer instead of a wait that runs out.
   */
  async function heldRequest(name: string, pairing: { result: Promise<unknown> }) {
    return Promise.race([
      waitFor(
        async () =>
          (await gateway.pendingRequests()).find(
            (request) => request.name === name && request.status === "pending",
          ),
        `a held request from ${name}`,
      ),
      pairing.result.then(
        () => {
          throw new Error(`${name} joined without being held`);
        },
        (error: unknown) => {
          const status = (error as { status?: unknown }).status;
          throw new Error(
            `${name} stopped before its request was held` +
              (typeof status === "number" ? `: the gateway answered ${status}` : ""),
            { cause: error },
          );
        },
      ),
    ]);
  }

  async function asDevice(token: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`https://localhost:${gateway.harness.gatewayPort}${path}`, { ...init, headers });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-devices-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
    // The collector's relay client runs in this process.
    process.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
    browser = await PasskeyBrowser.launch(world);
    gateway = await EnrollmentGateway.start(world, "home");
    first = await browser.session();
    const linked = await connectGatewayBySignIn(gateway, first, "create");
    if (linked.connect?.state !== "done" || !linked.account.linked)
      throw new Error(`Gateway did not link: ${JSON.stringify(linked.connect)}`);
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

  test("the gateway starts linked with the first passkey pinned and joining automatically, with no policy written down", async () => {
    const status = await gateway.status();
    expect(status.deviceEnrollment).toMatchObject({ policy: "automatic" });
    expect(status.deviceEnrollment).not.toHaveProperty("chosen");
    expect(status.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
      await passkeyIds(first),
    );
    expect(await linkRecord()).toMatchObject({ linked: true });
    expect(await linkRecord()).not.toHaveProperty("enrollmentPolicy");
  });

  test("by default: with no policy ever chosen, the pinned sign-in joins a new device with no comparison, and after switching to ask the same sign-in is held", async () => {
    // Nobody has touched the setting since the link.
    expect(await linkRecord()).not.toHaveProperty("enrollmentPolicy");
    const joinedName = "Fictional hallway CLI";
    const one = await pairBySignIn(first, {
      kind: "cli",
      name: joinedName,
      keyFile: join(directory, "default-one", "device.key"),
    });
    const joined = await one.result;
    expect(one.comparisons).toEqual([]);
    expect(await deviceRow(joined.deviceId)).toMatchObject({
      kind: "cli",
      name: joinedName,
      enrollment: { method: "automatic", signIn: "passkey" },
    });
    // Nothing was left waiting for anyone's approval.
    expect(
      (await gateway.pendingRequests()).some(
        (request) => request.name === joinedName && request.status === "pending",
      ),
    ).toBe(false);
    // Joining did not write a policy either.
    expect(await linkRecord()).not.toHaveProperty("enrollmentPolicy");

    // The owner opts out: the same trusted sign-in now waits for approval.
    expect((await gateway.setPolicy("ask")).deviceEnrollment).toMatchObject({ policy: "ask" });
    expect(await linkRecord()).toMatchObject({ enrollmentPolicy: "ask" });
    const heldName = "Fictional pantry CLI";
    const two = await pairBySignIn(first, {
      kind: "cli",
      name: heldName,
      keyFile: join(directory, "default-two", "device.key"),
    });
    const held = await heldRequest(heldName, two);
    // Already trusted, so there is nothing to offer: only the policy holds it.
    expect(held).toMatchObject({ kind: "cli", signIn: "passkey", canTrustSignIn: false });
    await waitFor(() => two.comparisons.length === 1, "the device to show its comparison code");
    expect(two.comparisons).toEqual([held.verificationCode]);
    expect((await gateway.devices()).some((device) => device.name === heldName)).toBe(false);
    await gateway.decide(held.requestId, false);
    await expect(two.result).rejects.toThrow(/denied/);
    expect((await gateway.devices()).some((device) => device.name === heldName)).toBe(false);
  }, 240_000);

  test("added passkey: a passkey that never got its confirmation is not on the account, and one confirmed with the first passkey joins a device with no approval, trusted as endorsed", async () => {
    // Creating the passkey is only half of adding it: cancelled at the confirmation, it is not kept.
    const abandoned = await addSecondPasskey(browser, world, first, { confirm: false });
    const [unconfirmed] = await passkeyIds(abandoned);
    await abandoned.page.goto(`${world.relayOrigin}/_relay/account`);
    await chooseAccountMenu(abandoned.page, "Sign out");
    // Whether or not the browser kept the unused passkey, no account has it.
    await expectPasskeySignInRefused(abandoned);
    await abandoned.context.close();

    second = await addSecondPasskey(browser, world, first);
    const [added] = await passkeyIds(second);
    expect(added).not.toBe(unconfirmed);
    await gateway.setPolicy("automatic");
    const name = "Fictional laptop CLI";
    const pairing = await pairBySignIn(second, {
      kind: "cli",
      name,
      keyFile: join(directory, "endorsed-cli", "device.key"),
    });
    // The gateway fetches the confirmation when the passkey it has never seen signs in,
    // verifies it against the first passkey's pin, and joins the device.
    const joined = await pairing.result;
    expect(pairing.comparisons).toEqual([]);
    expect(await deviceRow(joined.deviceId)).toMatchObject({
      kind: "cli",
      name,
      enrollment: { method: "automatic", signIn: "passkey" },
    });
    expect(
      (await gateway.pendingRequests()).some(
        (request) => request.name === name && request.status === "pending",
      ),
    ).toBe(false);
    const [original] = await passkeyIds(first);
    const pins = (await gateway.status()).deviceEnrollment.trustedSignIns;
    expect(pins.map((pin) => ({ type: pin.type, id: pin.id, source: pin.source }))).toEqual([
      { type: "passkey", id: original, source: "link-page" },
      { type: "passkey", id: added, source: "endorsed" },
    ]);
    expect(pins.map((pin) => pin.id)).not.toContain(unconfirmed);
    expect(second.errors).toEqual([]);
  }, 300_000);

  test("unknown sign-in: once the owner removes the added passkey's pin, the same confirmation never trusts it again, so its request is held with the option to trust it", async () => {
    const [added] = await passkeyIds(second);
    const removed = await gateway.removeTrustedSignIn(added!);
    expect(removed.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
      await passkeyIds(first),
    );
    // The account still lists the passkey with its confirmation; a refresh must not bring the pin back.
    await gateway.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
    // Even automatic mode holds a sign-in the gateway does not have pinned.
    expect((await gateway.status()).deviceEnrollment.policy).toBe("automatic");
    const name = "Fictional porch CLI";
    const pairing = await pairBySignIn(second, {
      kind: "cli",
      name,
      keyFile: join(directory, "unknown-cli", "device.key"),
    });
    const held = await heldRequest(name, pairing);
    expect(held).toMatchObject({ kind: "cli", signIn: "passkey", canTrustSignIn: true });
    await waitFor(() => pairing.comparisons.length === 1, "the device to show its comparison code");
    expect(pairing.comparisons).toEqual([held.verificationCode]);
    await gateway.decide(held.requestId, false);
    await expect(pairing.result).rejects.toThrow(/denied/);
    expect((await gateway.devices()).some((device) => device.name === name)).toBe(false);
    expect(
      (await gateway.status()).deviceEnrollment.trustedSignIns.map((pin) => pin.id),
    ).not.toContain(added);
  }, 180_000);

  test("ask me first: the request is held with a code, approval with trust pins the sign-in, ask still holds the next one, and automatic lets the one after join", async () => {
    await gateway.setPolicy("ask");
    const [added] = await passkeyIds(second);
    const firstName = "Fictional studio CLI";
    const one = await pairBySignIn(second, {
      kind: "cli",
      name: firstName,
      keyFile: join(directory, "ask-one", "device.key"),
    });
    const held = await heldRequest(firstName, one);
    expect(held.canTrustSignIn).toBe(true);
    await waitFor(() => one.comparisons.length === 1, "the comparison code");
    expect(one.comparisons[0]).toBe(held.verificationCode);
    await gateway.decide(held.requestId, true, true);
    const joined = await one.result;
    expect((await deviceRow(joined.deviceId))?.enrollment).toMatchObject({
      method: "approved",
      signIn: "passkey",
    });
    const pins = (await gateway.status()).deviceEnrollment.trustedSignIns;
    expect(pins).toHaveLength(2);
    // Trusted by the owner's approval this time, not by the confirmation on the account page.
    expect(pins.find((pin) => pin.id === added)).toMatchObject({
      type: "passkey",
      source: "approval",
    });

    // Now trusted, but the policy is still ask.
    const secondName = "Fictional garden CLI";
    const two = await pairBySignIn(second, {
      kind: "cli",
      name: secondName,
      keyFile: join(directory, "ask-two", "device.key"),
    });
    const heldAgain = await heldRequest(secondName, two);
    expect(heldAgain.canTrustSignIn).toBe(false);
    await waitFor(() => two.comparisons.length === 1, "the comparison code");
    await gateway.decide(heldAgain.requestId, false);
    await expect(two.result).rejects.toThrow(/denied/);

    await gateway.setPolicy("automatic");
    const thirdName = "Fictional attic CLI";
    const three = await pairBySignIn(second, {
      kind: "cli",
      name: thirdName,
      keyFile: join(directory, "ask-three", "device.key"),
    });
    const automatic = await three.result;
    expect(three.comparisons).toEqual([]);
    expect((await deviceRow(automatic.deviceId))?.enrollment).toMatchObject({
      method: "automatic",
      signIn: "passkey",
    });
  }, 240_000);

  test("removing a passkey on the account page drops its pin on the gateway at the next refresh", async () => {
    const [added] = await passkeyIds(second);
    // Managing sign-in methods needs a recent sign-in.
    await freshAccountSignIn(world, first);
    const page = first.page;
    const remove = page.getByRole("button", { name: "Remove", exact: true });
    expect(await remove.count()).toBe(2);
    // Listed in creation order: the added passkey is the last one.
    await remove.last().click();
    // The relay ends the session that removed it; the account keeps one passkey.
    await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).waitFor();
    await freshAccountSignIn(world, first);
    expect(await remove.count()).toBe(1);
    await gateway.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
    await waitFor(
      async () =>
        !(await gateway.status()).deviceEnrollment.trustedSignIns.some((pin) => pin.id === added),
      "the removed passkey's pin to be dropped",
      60_000,
    );
    expect((await gateway.status()).deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
      await passkeyIds(first),
    );
  }, 120_000);

  test("the CLI joins a collector automatically: no comparison, method automatic, a device-joined notice for the admin phone, and the collector syncs a document over the relay", async () => {
    await gateway.setPolicy("automatic");
    // An admin phone that can open pairing notifications.
    const phone = await gateway.json<{ token: string; device: { id: string } }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "Fictional admin phone",
        kind: "ios",
        scopes: ["admin", "read", "push:claim"],
        capabilities: { platform: "ios", pairingNotifications: true },
      }),
    });
    const configDir = join(directory, "collector-config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const name = "Fictional basement collector";
    await gateway.pace(2);
    const launches = (await launchedUrls(world)).length;
    const run = runCli(world, ["cloud", "pair", "--kind", "collector", "--name", name], {
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
      OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE: world.pki.caCertFile,
    });
    try {
      await printedConnectCode(run);
      // The CLI's browser launch, opened on this machine, so the sign-in comes back over loopback.
      const launchUrl = await waitFor(
        async () => (await launchedUrls(world))[launches],
        "the CLI to launch its sign-in page",
      );
      await signInOnThisMachine(first, launchUrl);
      expect(await run.exit).toBe(0);
    } catch (error) {
      throw new Error(`CLI pairing failed:\n${run.stdout()}\n${run.stderr()}`, { cause: error });
    }
    // With no terminal, a comparison prompt would have failed the command.
    expect(run.stdout()).not.toMatch(/Compare/);
    expect(run.stdout()).toContain("device credential saved");
    const bundle = JSON.parse(
      await readFile(join(configDir, "cloud-relay", "collector-device.json"), "utf8"),
    ) as {
      gatewayUrl: string;
      gatewayCertificate: string;
      gatewayFingerprint: string;
      tlsSpkiFingerprint: string;
      token: string;
      deviceId: string;
    };
    expect(
      (await stat(join(configDir, "cloud-relay", "collector-device.json.key"))).mode & 0o077,
    ).toBe(0);
    expect(bundle.gatewayUrl).toBe(gateway.publicOrigin);
    const row = await deviceRow(bundle.deviceId);
    expect(row).toMatchObject({ kind: "collector", name });
    expect(row?.enrollment).toMatchObject({ method: "automatic", signIn: "passkey" });

    const notice = await waitFor(async () => {
      const response = await asDevice(phone.token, "/notifications/claim", {
        method: "POST",
        body: "{}",
        headers: { "x-omnesis-pairing-notifications": "1" },
      });
      return response.status === 200
        ? ((await response.json()) as Record<string, unknown>)
        : undefined;
    }, "the device-joined notification");
    expect(JSON.stringify(notice)).toContain("device-joined");
    expect(JSON.stringify(notice)).toContain(name);

    // The collector syncs with its saved credential, through the relay.
    const adapter = createRelayClientProxy({
      gatewayUrl: bundle.gatewayUrl,
      gatewayCa: bundle.gatewayCertificate,
      gatewayFingerprint: bundle.gatewayFingerprint,
      tlsSpkiFingerprint: bundle.tlsSpkiFingerprint,
      expectedGatewayToken: bundle.token,
    });
    adapter.server.listen(0, "127.0.0.1");
    await new Promise((resolve) => adapter.server.once("listening", resolve));
    const proxyUrl = `http://127.0.0.1:${(adapter.server.address() as import("node:net").AddressInfo).port}`;
    const sourceType = "mock-relay-notes";
    const ws = new GatewayWsClient(proxyUrl, bundle.token, {
      capabilities: {
        hostname: "fictional-basement.example.com",
        platform: "linux",
        hostableSourceTypes: [SourceType(sourceType)],
      },
    });
    try {
      ws.connect();
      await waitFor(
        async () => (await deviceRow(bundle.deviceId))?.connectionPath === "relay",
        "the collector to be online over the relay",
      );
      const client = new HttpGatewayClient(proxyUrl, bundle.token);
      const sourceId = SourceId(`${sourceType}:basement`);
      const registered = await client.bulkUpsertSources([
        { type: SourceType(sourceType), accountId: AccountId("basement") },
      ]);
      expect(registered.errors).toEqual([]);
      const now = new Date().toISOString();
      const content = "A synthetic note from a collector that joined by signing in.";
      await client.upsertDocuments([
        {
          sourceId,
          providerId: ProviderId(`${sourceType}:basement`),
          externalId: "relay-enrolled-note",
          title: "Fictional basement inventory",
          content,
          contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          metadata: {},
          sourceCreatedAt: now,
          sourceUpdatedAt: now,
        },
      ]);
      expect(
        await getDocumentCount(gateway.harness.gatewayUrl, gateway.harness.apiKey, sourceId),
      ).toBe(1);
    } finally {
      ws.disconnect();
      await adapter.close();
    }
  }, 240_000);

  test("trusted at once: an automatically joined device removes another device, changes the policy, mints a pairing code and reads the corpus right away, and an older device can still remove it", async () => {
    await gateway.setPolicy("automatic");
    const joined = await (
      await pairBySignIn(first, {
        kind: "cli",
        name: "Fictional kitchen CLI",
        keyFile: join(directory, "kitchen", "device.key"),
      })
    ).result;
    const other = await gateway.json<{ device: { id: string } }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "Fictional spare CLI", kind: "cli", scopes: ["read"] }),
    });

    const whoami = await asDevice(joined.token, "/whoami");
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).not.toHaveProperty("enrollment");
    expect((await asDevice(joined.token, "/status")).status).toBe(200);
    expect((await asDevice(joined.token, "/documents/list")).status).toBe(200);

    const removed = await asDevice(joined.token, `/admin/devices/${other.device.id}`, {
      method: "DELETE",
    });
    expect(removed.ok, await removed.text()).toBe(true);
    expect(
      (await gateway.devices()).some(
        (device) => device.id === other.device.id && !device.revokedAt,
      ),
    ).toBe(false);
    const policy = await asDevice(joined.token, "/admin/cloud-relay/enrollment", {
      method: "PUT",
      body: JSON.stringify({ policy: "ask" }),
    });
    expect(policy.ok, await policy.text()).toBe(true);
    expect((await gateway.status()).deviceEnrollment.policy).toBe("ask");
    const minted = await asDevice(joined.token, "/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "cli", name: "Fictional new CLI" }),
    });
    expect(minted.ok, await minted.text()).toBe(true);

    await gateway.json(`/admin/devices/${joined.deviceId}`, { method: "DELETE" });
    expect((await asDevice(joined.token, "/whoami")).status).toBe(401);
  }, 180_000);

  test("rows: the same device key adopts its row and replaces the token, a new key makes a new row, and naming an offline device's name, install id and id takes nothing from it", async () => {
    await gateway.setPolicy("automatic");
    const keyFile = join(directory, "reinstall", "device.key");
    const original = await (
      await pairBySignIn(first, { kind: "cli", name: "Fictional desk CLI", keyFile })
    ).result;
    const reinstalled = await (
      await pairBySignIn(first, { kind: "cli", name: "Fictional desk CLI", keyFile })
    ).result;
    expect(reinstalled.deviceId).toBe(original.deviceId);
    expect(reinstalled.token).not.toBe(original.token);
    expect((await asDevice(original.token, "/whoami")).status).toBe(401);
    expect((await asDevice(reinstalled.token, "/whoami")).status).toBe(200);

    const fresh = await (
      await pairBySignIn(first, {
        kind: "cli",
        name: "Fictional desk CLI",
        keyFile: join(directory, "new-key", "device.key"),
      })
    ).result;
    expect(fresh.deviceId).not.toBe(original.deviceId);

    const victim = await gateway.json<{ token: string; device: { id: string; name: string } }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Fictional office CLI",
          kind: "cli",
          scopes: ["admin", "read"],
          capabilities: { platform: "cli", installId: "fictional-office-install" },
        }),
      },
    );
    const impostor = await (
      await pairBySignIn(first, {
        kind: "cli",
        name: victim.device.name,
        keyFile: join(directory, "impostor", "device.key"),
        gatewayJson: (candidate, path, body, signal, connectHost, options) =>
          devicePinnedJson(
            candidate,
            path,
            path === "/devices/pair"
              ? {
                  ...(body as { capabilities: Record<string, unknown> }),
                  capabilities: {
                    ...(body as { capabilities: Record<string, unknown> }).capabilities,
                    installId: "fictional-office-install",
                    previousDeviceId: victim.device.id,
                    suggestedName: victim.device.name,
                  },
                }
              : body,
            signal,
            connectHost,
            options,
          ),
      })
    ).result;
    expect(impostor.deviceId).not.toBe(victim.device.id);
    expect((await deviceRow(impostor.deviceId))?.name).not.toBe(victim.device.name);
    expect((await asDevice(victim.token, "/whoami")).status).toBe(200);
    expect((await deviceRow(victim.device.id))?.revokedAt ?? null).toBeNull();
  }, 300_000);

  test("token rotation: the device key rotates its token, the old one keeps working in its overlap, and a token whose device has no key is refused", async () => {
    await gateway.setPolicy("automatic");
    const keyFile = join(directory, "rotating", "device.key");
    const device = await (
      await pairBySignIn(first, { kind: "cli", name: "Fictional rotating CLI", keyFile })
    ).result;
    const privateKey = createPrivateKey(await readFile(keyFile, "utf8"));
    const devicePublicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const target = { publicOrigin: gateway.publicOrigin, certificate: device.gatewayCertificate };
    const challenge = (await devicePinnedJson(
      target,
      "/devices/token/challenge",
      {},
      undefined,
      undefined,
      {
        token: device.token,
      },
    )) as { challenge: string };
    const signature = signDeviceTranscript(
      privateKey,
      tokenRotationTranscript({
        deviceId: device.deviceId,
        gatewaySpkiFingerprint: tlsSpkiFingerprint(device.gatewayCertificate),
        challenge: challenge.challenge,
        devicePublicKey,
      }),
    );
    const rotated = (await devicePinnedJson(
      target,
      "/devices/token/rotate",
      { challenge: challenge.challenge, signature },
      undefined,
      undefined,
      { token: device.token },
    )) as { token: string };
    expect(rotated.token).not.toBe(device.token);
    for (const token of [device.token, rotated.token]) {
      const whoami = await asDevice(token, "/whoami");
      expect(whoami.status).toBe(200);
      expect(((await whoami.json()) as { deviceId: string }).deviceId).toBe(device.deviceId);
    }
    // A retry of the same signed request gets the same answer, not a third token.
    const retried = (await devicePinnedJson(
      target,
      "/devices/token/rotate",
      { challenge: challenge.challenge, signature },
      undefined,
      undefined,
      { token: rotated.token },
    )) as { token: string; tokenId: string };
    expect(retried).toEqual(rotated);
    // A challenge the gateway never issued is refused, however well signed.
    const unissued = randomBytes(32).toString("base64url");
    const forged = await devicePinnedJson(
      target,
      "/devices/token/rotate",
      {
        challenge: unissued,
        signature: signDeviceTranscript(
          privateKey,
          tokenRotationTranscript({
            deviceId: device.deviceId,
            gatewaySpkiFingerprint: tlsSpkiFingerprint(device.gatewayCertificate),
            challenge: unissued,
            devicePublicKey,
          }),
        ),
      },
      undefined,
      undefined,
      { token: rotated.token },
    ).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(GatewayRefused);
    expect((forged as GatewayRefused).status).toBe(403);

    const keyless = await gateway.json<{ token: string; device: { id: string } }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({ name: "Fictional keyless CLI", kind: "cli", scopes: ["read"] }),
      },
    );
    const keylessChallenge = (await devicePinnedJson(
      target,
      "/devices/token/challenge",
      {},
      undefined,
      undefined,
      {
        token: keyless.token,
      },
    )) as { challenge: string };
    const refused = await devicePinnedJson(
      target,
      "/devices/token/rotate",
      {
        challenge: keylessChallenge.challenge,
        signature: signDeviceTranscript(
          privateKey,
          tokenRotationTranscript({
            deviceId: keyless.device.id,
            gatewaySpkiFingerprint: tlsSpkiFingerprint(device.gatewayCertificate),
            challenge: keylessChallenge.challenge,
            devicePublicKey,
          }),
        ),
      },
      undefined,
      undefined,
      { token: keyless.token },
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GatewayRefused);
    expect((refused as GatewayRefused).status).toBe(409);
    expect((refused as GatewayRefused).body).toContain("DEVICE_KEY_REQUIRED");
    expect((await asDevice(keyless.token, "/whoami")).status).toBe(200);
  }, 180_000);

  /**
   * Opens the portal on the gateway's public name, through the relay, and signs in with a passkey.
   * The sign-in is the decision: pairing goes on by itself, with no "Continue pairing" to press.
   */
  async function portalSignIn(session: PasskeySession) {
    await gateway.pace(3);
    const page = session.page;
    await page.goto(`${gateway.publicOrigin}/portal/`);
    await clickFirst(page, ["Sign in with Passkey"]);
    await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
    await waitFor(
      () => new URL(page.url()).origin === new URL(gateway.publicOrigin).origin,
      "the browser to return to the gateway",
    );
    return page;
  }

  test("portal: a browser signing in on the gateway's portal joins and lands logged in with no comparison screen", async () => {
    await gateway.setPolicy("automatic");
    const before = new Set((await gateway.devices()).map((device) => device.id));
    const page = await portalSignIn(first);
    await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
    expect(await page.getByText("Confirm this browser").count()).toBe(0);
    const added = (await gateway.devices()).filter((device) => !before.has(device.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "portal" });
    expect(added[0]!.enrollment).toMatchObject({ method: "automatic", signIn: "passkey" });
    expect(first.errors).toEqual([]);
  }, 180_000);

  test("portal: signing in on the account page and opening the gateway from its list lands in the portal logged in, with no second sign-in", async () => {
    await gateway.setPolicy("automatic");
    await gateway.pace(3);
    const before = new Set((await gateway.devices()).map((device) => device.id));
    const fresh = await browser.session();
    const copied = await copyPasskey(first, fresh);
    const page = fresh.page;
    await page.goto(`${world.relayOrigin}/_relay/account`);
    await clickFirst(page, ["Sign in with Passkey"]);
    await page.getByRole("heading", { name: "Your gateways", exact: true }).waitFor();
    await syncPasskey(fresh, first, copied);
    // From here on the passkey is gone from this profile: nothing can sign in a second time.
    await fresh.cdp.send("WebAuthn.removeCredential", {
      authenticatorId: fresh.authenticatorId,
      credentialId: copied,
    });
    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });
    await page.locator("a.gateway").click();
    await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
    expect(new URL(page.url()).origin).toBe(new URL(gateway.publicOrigin).origin);
    // The sign-in travelled in the fragment, which the portal takes out of the address bar.
    expect(page.url()).not.toContain("account-signin");
    // The browser went straight to the gateway: no relay sign-in page in between.
    expect(visited.filter((url) => new URL(url).origin === world.relayOrigin)).toEqual([]);
    expect(await page.getByText("Confirm this browser").count()).toBe(0);
    const added = (await gateway.devices()).filter((device) => !before.has(device.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "portal", name: expect.stringMatching(/^Portal /) });
    expect(added[0]!.enrollment).toMatchObject({ method: "automatic", signIn: "passkey" });
    // The portal keeps working after a reload, on the device key it was handed.
    await page.reload();
    await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
    expect(fresh.errors).toEqual([]);
    await fresh.context.close();
  }, 180_000);

  test("portal: with ask me first, the browser shows the comparison screen and waits", async () => {
    await gateway.setPolicy("ask");
    const fresh = await browser.session();
    const copied = await copyPasskey(first, fresh);
    const page = await portalSignIn(fresh);
    await syncPasskey(fresh, first, copied);
    await expectText(page, "Confirm this browser", 30_000);
    const shown = (await page.locator("code.cloud-pairing-code").textContent())?.trim();
    const held = await waitFor(
      async () =>
        (await gateway.pendingRequests()).find(
          (request) => request.kind === "portal" && request.status === "pending",
        ),
      "the portal's held request",
    );
    expect(shown).toBe(held.verificationCode);
    expect(await page.locator("nav.sidebar-nav").count()).toBe(0);
    await gateway.decide(held.requestId, false);
    await expectText(page, "Your gateway denied this request.", 30_000);
  }, 180_000);
});

void randomUUID;
void certificateFingerprint;
