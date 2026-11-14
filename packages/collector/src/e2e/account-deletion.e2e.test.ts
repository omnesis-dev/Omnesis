// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Leaving an Omnesis account, end to end: a real relay daemon, real gateways
 * that connected from nothing and obtained their certificate through the
 * relay, a device that joined by signing in (so it pinned the gateway's public
 * key), and a headless Chromium with a virtual passkey.
 *
 * Deleting the account (docs/device-enrollment.md § Deleting an account) and
 * disconnecting one gateway (§ Connecting a gateway) end the same way for the
 * gateway: no account, no registration, remote access off, nothing about it on
 * the relay, and its public address routing nowhere. Its paired device still
 * reaches it on the direct path under the same name and pinned key, and once
 * the gateway is connected to an account again that device works through the
 * relay again without pairing anew.
 */

import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authorizeAccountDesktop, pairAccountDevice } from "@omnesis/cloud-relay";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  SCT_EXTENSION_LINE,
  browserSuiteAvailable,
  chooseAccountMenu,
  clickFirst,
  connectGatewayBySignIn,
  connectThisGateway,
  createAccountWithPasskey,
  enterConnectCode,
  expectPasskeySignInRefused,
  expectText,
  passkeyIds,
  servedCertificate,
  signInOnThisMachine,
  waitFor,
  type CloudRelayStatus,
  type DeviceRow,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import { E2EHarness } from "./harness.js";

const browserReady = browserSuiteAvailable("account-deletion.e2e");

type Status = CloudRelayStatus & {
  hostname?: string;
  gatewayId?: string;
  publicOrigin?: string;
  configured: boolean;
  enabled: boolean;
  notice?: string;
};

/** Every row of every table of the relay database, as text. */
function relayRows(path: string): Map<string, string[]> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return new Map(
      tables.map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM ${name}`)
          .all()
          .map((row) => JSON.stringify(row)),
      ]),
    );
  } finally {
    db.close();
  }
}
const holding = (rows: Map<string, string[]>, value: string) =>
  [...rows]
    .filter(([, values]) => values.some((row) => row.includes(value)))
    .map(([table]) => table);
const spki = (certificate: X509Certificate) =>
  createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

/** No account, no registration, remote access off: what the portal's first-time screen is drawn from. */
const disconnected = {
  enabled: false,
  enrollment: { state: "unconfigured" },
  tunnel: { state: "disabled" },
  account: { linked: false, activated: false },
  deviceEnrollment: { policy: "ask", trustedSignIns: [] },
};

describe.skipIf(!browserReady)("leave an Omnesis account", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  const priorCa = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-account-deletion-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    browser = await PasskeyBrowser.launch(world);
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    if (priorCa === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
    else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCa;
    try {
      await browser?.close();
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * A gateway given nothing but the opt-in, the relay and a certificate directory, with what a
   * test does to it: read its Omnesis account status, connect it by signing in, and join a
   * device to it by signing in.
   */
  async function freshGateway(name: string) {
    let hostname: string | undefined;
    const acme = join(directory, `acme-${name}`);
    await mkdir(acme, { recursive: true });
    const authority = await localAcmeAuthority(
      acme,
      () => {
        if (!hostname) throw new Error("No gateway hostname yet");
        return hostname;
      },
      world.dnsRecords,
      { leafExtensions: [SCT_EXTENSION_LINE] },
    );
    const acmeRoot = join(directory, `acme-root-${name}.pem`);
    await writeFile(acmeRoot, authority.root);
    const bundle = join(directory, `gateway-trust-${name}.pem`);
    await writeFile(bundle, world.pki.caCert + authority.root);
    const gateway = new E2EHarness({
      extraGatewayEnv: {
        ...world.clientEnv({ NODE_EXTRA_CA_CERTS: bundle }),
        OMNESIS_CLOUD_RELAY_ENABLED: "1",
        OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
        OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
        OMNESIS_ACME_CA_FILE: acmeRoot,
        OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
      },
    });
    const status = () => gateway.gatewayJson<Status>("/admin/cloud-relay");
    const connect = async (person: PasskeySession, intent: "create" | "existing") => {
      const waiting = await gateway.gatewayJson<Status>("/admin/cloud-relay/connect", {
        method: "POST",
        body: JSON.stringify({ termsAccepted: true, intent }),
      });
      expect(waiting.connect).toMatchObject({ state: "waiting" });
      hostname = waiting.hostname;
      await enterConnectCode(person.page, waiting.connect!.connectUrl!, waiting.connect!.code!);
      if (intent === "create") await createAccountWithPasskey(person.page);
      else await clickFirst(person.page, ["Sign in with Passkey"]);
      await connectThisGateway(person.page);
      const done = await waitFor(
        async () => {
          const current = await status();
          return current.connect?.state === "done" || current.connect?.state === "failed"
            ? current
            : undefined;
        },
        "connect to finish",
        120_000,
      );
      expect(done.connect).toMatchObject({ state: "done" });
      expect(done).toMatchObject({
        enabled: true,
        configured: true,
        enrollment: { state: "enrolled" },
        tunnel: { state: "online" },
        account: { linked: true },
      });
      return done;
    };
    /**
     * A CLI joins by signing in, through the relay. Its sign-in is made on the relay's page, so
     * the gateway holds it and the owner approves it. Like the phone apps, it then knows the
     * gateway by its public name and holds the key of the certificate it was shown.
     */
    const joinDevice = async (person: PasskeySession, deviceName: string) => {
      process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = acmeRoot;
      let launched!: (url: string) => void;
      const launchUrl = new Promise<string>((resolve) => (launched = resolve));
      const pairing = pairAccountDevice(
        {
          kind: "cli",
          name: deviceName,
          relayUrl: world.relayOrigin,
          deviceKeyFile: join(directory, `device-${name}`, "device.key"),
          signal: AbortSignal.timeout(120_000),
          selectGateway: async () => {
            throw new Error("One linked gateway needs no chooser");
          },
          confirm: async () => true,
        },
        {
          authorize: (input, dependencies) =>
            authorizeAccountDesktop(input, {
              ...dependencies,
              openBrowser: async (url) => launched(url),
            }),
        },
      );
      pairing.catch(() => undefined);
      await signInOnThisMachine(person, await launchUrl);
      const held = await waitFor(
        async () =>
          (
            await gateway.gatewayJson<{
              items: Array<{ requestId: string; name: string; status: string }>;
            }>("/admin/cloud-pairing/requests")
          ).items.find((request) => request.name === deviceName && request.status === "pending"),
        `the held request from ${deviceName}`,
      );
      await gateway.gatewayJson("/admin/cloud-pairing/decision", {
        method: "POST",
        body: JSON.stringify({ requestId: held.requestId, approve: true }),
      });
      const paired = await pairing;
      const origin = new URL(paired.gatewayUrl),
        pin = spki(new X509Certificate(paired.gatewayCertificate));
      /**
       * The device asks its gateway who it is, at the gateway's public name, accepting only the
       * key it pinned when it joined. `port` picks the path: the relay's, or the gateway's own.
       */
      const whoami = (port: number) =>
        new Promise<{ deviceId: string }>((resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port,
              servername: origin.hostname,
              path: "/whoami",
              method: "GET",
              ca: authority.root,
              checkServerIdentity: (_host, certificate) =>
                spki(new X509Certificate(certificate.raw)) === pin
                  ? undefined
                  : new Error("Gateway key pin mismatch"),
              signal: AbortSignal.timeout(15_000),
              headers: { host: origin.host, authorization: `Bearer ${paired.token}` },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (res.statusCode === 200) resolve(JSON.parse(text) as { deviceId: string });
                else reject(new Error(`Gateway answered ${res.statusCode}: ${text.slice(0, 200)}`));
              });
              res.on("error", reject);
            },
          );
          req.on("error", reject);
          req.end();
        });
      return {
        id: paired.deviceId,
        gatewayUrl: paired.gatewayUrl,
        throughRelay: () => whoami(world.dataPort),
        atHome: () => whoami(gateway.gatewayPort),
      };
    };
    return { gateway, authority, status, connect, joinDevice };
  }

  test(
    "a connected gateway with a joined device, once its account is deleted, has no account and no relay registration, still serves its device at home under the pinned key, and serves it through the relay again once connected to a new account",
    async () => {
      const { gateway, authority, status, connect, joinDevice } = await freshGateway("first");
      try {
        await gateway.start();
        const never = await status();
        expect(never).toMatchObject({ ...disconnected, configured: false });
        expect(never.notice).toBeUndefined();

        // ── Connected, with a device that joined by signing in ──────────────
        const person = await browser.session();
        const connected = await connect(person, "create");
        const first = {
          hostname: connected.hostname!,
          gatewayId: connected.gatewayId!,
          publicOrigin: connected.publicOrigin!,
        };
        const device = await joinDevice(person, "Fictional study CLI");
        expect(device.gatewayUrl).toBe(first.publicOrigin);
        // Before the deletion the device reaches its gateway both ways.
        expect(await device.throughRelay()).toMatchObject({ deviceId: device.id });
        expect(await device.atHome()).toMatchObject({ deviceId: device.id });

        // The relay knows the account, its passkey and the gateway under several tables.
        const relayDatabase = join(directory, "relay.sqlite");
        const [passkey] = await passkeyIds(person);
        const before = relayRows(relayDatabase);
        expect(holding(before, first.gatewayId)).toEqual(
          expect.arrayContaining([
            "relay_accounts",
            "relay_gateway_bindings",
            "relay_hosted_names",
          ]),
        );
        expect(holding(before, passkey!)).toEqual(["omnesis_passkeys"]);
        expect(before.get("omnesis_accounts")).toHaveLength(1);
        const accountId = (
          JSON.parse(before.get("omnesis_accounts")![0]!) as { account_id: string }
        ).account_id;
        const owner = (
          JSON.parse(before.get("omnesis_gateway_links")![0]!) as { owner_account_id: string }
        ).owner_account_id;

        // ── The person deletes the account on the relay's account page ──────
        const page = person.page;
        await page.goto(`${world.relayOrigin}/_relay/account`);
        await expectText(page, first.hostname);
        await chooseAccountMenu(page, "Delete account");
        await expectText(page, "Delete your Omnesis account?");
        await expectText(
          page,
          "All your gateways are disconnected from this account and can no longer be reached from outside your home network.",
        );
        // Connecting and pairing may have taken longer than a sign-in stays fresh.
        const final = page.getByRole("button", { name: "Delete account permanently", exact: true });
        const confirm = page.getByRole("button", { name: "Confirm with passkey", exact: true });
        await final.or(confirm).first().waitFor({ timeout: 20_000 });
        if (await confirm.isVisible()) await confirm.click();
        await final.click();
        await expectText(page, "Your Omnesis account was deleted.");
        await expectText(page, "Sign in to your Omnesis account");

        // ── The gateway has no account and no registration, as before it connected ──
        const after = await waitFor(
          async () => {
            const current = await status();
            return current.notice === "account-deleted" ? current : undefined;
          },
          "the gateway to learn its account is gone",
          60_000,
        );
        expect(after).toMatchObject(disconnected);
        expect(after.connect).toBeUndefined();
        // It keeps its own identity: the id and address it will ask for again.
        expect(after).toMatchObject({ gatewayId: first.gatewayId, hostname: first.hostname });

        // ── The relay holds nothing about the account or the gateway ────────
        const rows = relayRows(relayDatabase);
        for (const value of [accountId, owner, first.gatewayId, passkey!])
          expect(holding(rows, value), value).toEqual([]);
        // Only the address remains, held by a digest so that no other gateway is given it.
        expect(holding(rows, first.hostname)).toEqual(["relay_hosted_names"]);
        expect(rows.get("relay_hosted_names")).toHaveLength(1);
        expect(JSON.parse(rows.get("relay_hosted_names")![0]!)).toEqual({
          hostname: first.hostname,
          gateway_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        for (const [table, values] of rows)
          if (table !== "relay_hosted_names") expect(values, table).toEqual([]);

        // ── The old address routes nowhere ──────────────────────────────────
        await expect(servedCertificate(world, first.hostname, authority.root)).rejects.toThrow();
        await expect(device.throughRelay()).rejects.toThrow();

        // ── The device that joined by signing in still works at home ────────
        // Same name, same pinned key, the gateway's own listener.
        expect(await device.atHome()).toMatchObject({ deviceId: device.id });
        const row = (
          await gateway.gatewayJson<{ items: DeviceRow[] }>("/admin/devices")
        ).items.find((item) => item.id === device.id);
        expect(row).toMatchObject({ kind: "cli", name: "Fictional study CLI" });
        // Signing in no longer joins anything: this gateway has no account to check against.
        const refused = await gateway.gatewayFetch("/devices/account/challenge", {
          method: "POST",
          body: "{}",
        });
        expect(refused.status).not.toBe(200);

        // ── The deleted sign-in finds no account ────────────────────────────
        await expectPasskeySignInRefused(person);

        // ── The same gateway connects to a brand-new account, at its address ─
        const someone = await browser.session();
        const again = await connect(someone, "create");
        expect(again.notice).toBeUndefined();
        expect(again).toMatchObject({ gatewayId: first.gatewayId, hostname: first.hostname });
        expect(again.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
          await passkeyIds(someone),
        );
        const renewed = relayRows(relayDatabase);
        expect(renewed.get("omnesis_accounts")).toHaveLength(1);
        expect(holding(renewed, accountId)).toEqual([]);
        expect(holding(renewed, passkey!)).toEqual([]);
        expect(holding(renewed, first.gatewayId)).toEqual(
          expect.arrayContaining([
            "relay_accounts",
            "relay_gateway_bindings",
            "relay_hosted_names",
          ]),
        );
        // The device from before works through the relay again, with the pin it always had.
        expect(await device.throughRelay()).toMatchObject({ deviceId: device.id });
        expect(await device.atHome()).toMatchObject({ deviceId: device.id });
        expect(person.errors).toEqual([]);
        expect(someone.errors).toEqual([]);
      } finally {
        await gateway.destroy();
        await authority.close();
      }
    },
    gatewayBootBudgetMs() + 420_000,
  );

  test(
    "disconnecting one of an account's two gateways takes that one off the relay and out of the account, leaves the other untouched, keeps its device working at home, and reconnecting restores the relay path",
    async () => {
      const { gateway, authority, status, connect, joinDevice } = await freshGateway("leaving");
      let other: EnrollmentGateway | undefined;
      try {
        await gateway.start();
        const owner = await browser.session();
        const connected = await connect(owner, "create");
        const first = { hostname: connected.hostname!, gatewayId: connected.gatewayId! };
        const device = await joinDevice(owner, "Fictional attic CLI");
        expect(await device.throughRelay()).toMatchObject({ deviceId: device.id });
        // A second gateway of the same person, in the same account.
        other = await EnrollmentGateway.start(world, "staying");
        const joined = await connectGatewayBySignIn(other, owner, "existing");
        expect(joined.connect).toMatchObject({ state: "done" });
        const relayDatabase = join(directory, "relay.sqlite");
        const before = relayRows(relayDatabase);
        const links = before.get("omnesis_gateway_links")!;
        // The relay knows a gateway by its owner key's account.
        const registration = before
          .get("relay_accounts")!
          .find((row) => row.includes(first.gatewayId))!;
        const leaving = (JSON.parse(registration) as { account_id: string }).account_id;
        const mine = links.filter((row) => row.includes(leaving));
        expect(mine).toHaveLength(1);
        const account = (JSON.parse(mine[0]!) as { account_id: string }).account_id;
        expect(links.filter((row) => row.includes(account))).toHaveLength(2);

        // ── The owner disconnects the first gateway from its settings ───────
        const after = await gateway.gatewayJson<Status>("/admin/cloud-relay/account/unlink", {
          method: "POST",
          body: "{}",
        });
        // At once, and with nothing to explain: the owner did it.
        expect(after).toMatchObject(disconnected);
        expect(after.notice).toBeUndefined();
        expect(after).toMatchObject({ gatewayId: first.gatewayId, hostname: first.hostname });
        expect(await status()).toMatchObject(disconnected);

        // ── The relay dropped its registration and kept the account ─────────
        const rows = relayRows(relayDatabase);
        // Its id remains only where the relay records which account that gateway created.
        expect(holding(rows, first.gatewayId)).toEqual(["omnesis_account_admissions"]);
        expect(holding(rows, first.hostname)).toEqual(["relay_hosted_names"]);
        expect(rows.get("omnesis_accounts")).toEqual(before.get("omnesis_accounts"));
        expect(rows.get("omnesis_passkeys")).toEqual(before.get("omnesis_passkeys"));
        expect(rows.get("omnesis_gateway_links")).toEqual(
          links.filter((row) => !mine.includes(row)),
        );
        for (const table of ["relay_accounts", "relay_gateway_bindings"])
          expect(rows.get(table), table).toHaveLength(before.get(table)!.length - 1);
        // Its address routes nowhere.
        await expect(servedCertificate(world, first.hostname, authority.root)).rejects.toThrow();
        await expect(device.throughRelay()).rejects.toThrow();
        // Its device still reaches it at home, under the same name and pinned key.
        expect(await device.atHome()).toMatchObject({ deviceId: device.id });

        // ── The other gateway and the account carry on ──────────────────────
        expect(await other.status()).toMatchObject({
          enabled: true,
          tunnel: { state: "online" },
          account: { linked: true },
        });
        const still = await servedCertificate(world, other.hostname, world.pki.caCert);
        expect(still.subjectAltName).toContain(`DNS:${other.hostname}`);
        const page = owner.page;
        await page.goto(`${world.relayOrigin}/_relay/account`);
        await expectText(page, other.hostname);
        expect(await page.locator("a.gateway").count()).toBe(1);
        expect(await page.getByText(first.hostname).count()).toBe(0);

        // ── It connects again, to the same account, and gets its address back ─
        const again = await connect(owner, "existing");
        expect(again).toMatchObject({
          gatewayId: first.gatewayId,
          hostname: first.hostname,
          account: { linked: true },
        });
        // The device was not paired again: same token, same pin, and the relay path is back.
        expect(await device.throughRelay()).toMatchObject({ deviceId: device.id });
        expect(await device.atHome()).toMatchObject({ deviceId: device.id });
        const final = relayRows(relayDatabase);
        expect(final.get("omnesis_accounts")).toEqual(before.get("omnesis_accounts"));
        expect(
          final.get("omnesis_gateway_links")!.filter((row) => row.includes(account)),
        ).toHaveLength(2);
        await page.goto(`${world.relayOrigin}/_relay/account`);
        await expectText(page, first.hostname);
        expect(await page.locator("a.gateway").count()).toBe(2);
        expect(owner.errors).toEqual([]);
      } finally {
        await other?.close().catch(() => undefined);
        await gateway.destroy();
        await authority.close();
      }
    },
    gatewayBootBudgetMs() * 2 + 420_000,
  );
});
