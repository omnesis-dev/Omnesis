// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Step-up (docs/device-enrollment.md, "Step-up"), end to end: a real relay daemon, a real gateway
 * tunnelled through it on its hosted name, and a headless Chromium holding the account's passkey,
 * which the owner confirmed on the gateway's own page. From then on an administrative action that
 * loosens the gateway, asked through the relay or by a device that joined on its own, waits for
 * that passkey on the gateway's own page: an admin credential alone, as a compromised relay
 * session or a stolen portal cookie would carry, mints no pairing code, makes no token, approves
 * no device and switches nothing to automatic.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gatewayPasskeyChallenge, hostedGatewayHostname } from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  RELAY_HOST,
  assertionOn,
  browserSuiteAvailable,
  confirmPasskeyHere,
  connectGatewayBySignIn,
  gatewayPasskeyJoin,
  sha256Hex,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

const browserReady = browserSuiteAvailable("account-enrollment-step-up.e2e");

describe.skipIf(!browserReady)(
  "step-up before an administrative action that loosens the gateway",
  () => {
    let directory: string;
    let world: EnrollmentWorld;
    let browser: PasskeyBrowser;
    let gateway: EnrollmentGateway;
    /** Holds the passkey of the account the gateway is linked to, confirmed on its page. */
    let owner: PasskeySession;
    const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
    const priorEnabled = process.env.OMNESIS_CLOUD_RELAY_ENABLED;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-step-up-"));
      world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
      process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
      process.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
      browser = await PasskeyBrowser.launch(world);
      gateway = await EnrollmentGateway.start(world, "home");
      owner = await browser.session();
      const linked = await connectGatewayBySignIn(gateway, owner, "create");
      if (linked.connect?.state !== "done" || !linked.account.linked)
        throw new Error(`Gateway did not link: ${JSON.stringify(linked.connect)}`);
      // The first confirmation needs no step-up: there is no confirmed passkey to step up with.
      await confirmPasskeyHere(gateway, owner);
      await gateway.setPolicy("ask");
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

    /** An admin request through the relay, as the portal or an app on the internet sends it. */
    async function relayed(
      path: string,
      init: { method?: string; body?: string; stepUp?: string; token?: string } = {},
    ) {
      const response = await gateway.throughRelay(path, {
        method: init.method ?? "POST",
        ...(init.body === undefined ? {} : { body: init.body }),
        token: init.token ?? gateway.harness.apiKey,
        ...(init.stepUp ? { headers: { "x-omnesis-step-up": init.stepUp } } : {}),
      });
      return {
        status: response.status,
        json: (response.body ? JSON.parse(response.body) : undefined) as Record<string, any>,
      };
    }

    /** The same, over the gateway's own address with `token`. */
    async function local(
      path: string,
      init: { method?: string; body?: string; stepUp?: string; token: string },
    ) {
      const response = await fetch(`https://localhost:${gateway.harness.gatewayPort}${path}`, {
        method: init.method ?? "POST",
        headers: {
          authorization: `Bearer ${init.token}`,
          "content-type": "application/json",
          ...(init.stepUp ? { "x-omnesis-step-up": init.stepUp } : {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      const text = await response.text();
      return {
        status: response.status,
        json: (text ? JSON.parse(text) : undefined) as Record<string, any>,
      };
    }

    /**
     * The owner steps up for exactly one request with the passkey on `from` (the gateway's own page
     * unless a test says otherwise). `send` carries the step-up calls the same way the action goes.
     */
    async function stepUp(
      request: { method: string; path: string; body: string },
      options: { from?: string; send?: typeof relayed } = {},
    ) {
      const send = options.send ?? relayed;
      const from = options.from ?? gateway.publicOrigin;
      const target = {
        method: request.method,
        path: request.path,
        bodySha256: sha256Hex(request.body),
      };
      const ceremony = await send("/admin/step-up/options", { body: JSON.stringify(target) });
      expect(ceremony.status).toBe(200);
      expect(ceremony.json).toMatchObject({
        purpose: "step-up",
        rpId: RELAY_HOST,
        origin: gateway.publicOrigin,
      });
      const credential = await assertionOn(
        owner,
        from,
        from === gateway.publicOrigin
          ? ceremony.json.webauthnChallenge
          : gatewayPasskeyChallenge(
              "step-up",
              from,
              ceremony.json.challenge,
              ceremony.json.binding,
            ),
      );
      return send("/admin/step-up", {
        body: JSON.stringify({
          ...target,
          proof: { type: "gateway-passkey", challenge: ceremony.json.challenge, credential },
        }),
      });
    }

    /** A device that signs in with the owner's passkey and waits, since the gateway asks first. */
    async function heldRequest(name: string) {
      const held = await gatewayPasskeyJoin(gateway, owner, { kind: "cli", name });
      expect(held.reply.status).toBe("pending");
      return held.requestId;
    }

    const requestStatus = async (requestId: string) =>
      (await gateway.pendingRequests()).find((request) => request.requestId === requestId)?.status;

    test("F21: a relayed admin session without the owner's passkey cannot mint a pairing code, make a device or a token, approve a device or trust its sign-in, switch to automatic, confirm a passkey or move a device's access level", async () => {
      const requestId = await heldRequest("Fictional held CLI");
      const devicesBefore = await gateway.devices();
      const tokensBefore = (await gateway.json<{ items: unknown[] }>("/admin/tokens")).items.length;
      const attempts: Array<[string, string, unknown]> = [
        ["POST", "/admin/devices/pair", { kind: "cli", name: "Fictional relayed CLI" }],
        [
          "POST",
          "/admin/devices",
          { name: "Fictional relayed CLI", kind: "cli", scopes: ["admin"] },
        ],
        ["POST", "/admin/tokens", { deviceId: devicesBefore[0]!.id, scopes: ["admin"] }],
        ["POST", "/admin/cloud-pairing/decision", { requestId, approve: true }],
        ["POST", "/admin/cloud-pairing/decision", { requestId, approve: true, trustSignIn: true }],
        ["PUT", "/admin/cloud-relay/enrollment", { policy: "automatic" }],
      ];
      for (const [method, path, value] of attempts) {
        const body = JSON.stringify(value);
        const refused = await relayed(path, { method, body });
        expect(refused.status, `${method} ${path} ${body}`).toBe(428);
        expect(refused.json).toMatchObject({
          code: "STEP_UP_REQUIRED",
          detail: { method, path, bodySha256: sha256Hex(body), options: "/admin/step-up/options" },
        });
      }
      // Confirming a passkey on the gateway's page through the relay needs a step-up too, now that
      // one is confirmed: a relay could list a passkey of its own for an admin session to confirm.
      const ceremony = await relayed("/admin/cloud-relay/passkeys/confirm/options", { body: "{}" });
      expect(ceremony.status).toBe(200);
      const confirm = await relayed("/admin/cloud-relay/passkeys/confirm", {
        body: JSON.stringify({
          proof: {
            type: "gateway-passkey",
            challenge: ceremony.json.challenge,
            credential: await assertionOn(
              owner,
              gateway.publicOrigin,
              ceremony.json.webauthnChallenge,
            ),
          },
        }),
      });
      expect(confirm.status).toBe(428);
      // A portal session through the relay can't move a device to another access level either.
      const page = owner.page;
      await page.goto(
        `${gateway.publicOrigin}/portal/?token=${encodeURIComponent(gateway.harness.apiKey)}`,
      );
      await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
      const level = await page.evaluate(async (deviceId) => {
        const session = await (await fetch("/portal/api/session")).json();
        const response = await fetch(`/admin/access/devices/${deviceId}/level`, {
          method: "PUT",
          headers: { "content-type": "application/json", "X-Omnesis-CSRF": session.csrfToken },
          body: JSON.stringify({ levelId: null }),
        });
        return { status: response.status, body: await response.json() };
      }, devicesBefore[0]!.id);
      expect(level).toMatchObject({ status: 428, body: { code: "STEP_UP_REQUIRED" } });

      // Nothing changed.
      expect((await gateway.devices()).map((device) => device.id)).toEqual(
        devicesBefore.map((device) => device.id),
      );
      expect((await gateway.json<{ items: unknown[] }>("/admin/tokens")).items).toHaveLength(
        tokensBefore,
      );
      expect(await requestStatus(requestId)).toBe("pending");
      const status = await gateway.status();
      expect(status.deviceEnrollment.policy).toBe("ask");
      expect(status.deviceEnrollment.confirmedSignIns).toHaveLength(1);
      await gateway.decide(requestId, false);
    }, 240_000);

    test("the owner's passkey on the gateway's page steps up one relayed action, once", async () => {
      const pair = {
        method: "POST",
        path: "/admin/devices/pair",
        body: JSON.stringify({ kind: "cli", name: "Fictional stepped-up CLI" }),
      };
      const issued = await stepUp(pair);
      expect(issued.status).toBe(200);
      expect(issued.json).toEqual({ stepUpId: expect.any(String), expiresAt: expect.any(Number) });
      expect(issued.json.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
      const minted = await relayed(pair.path, { body: pair.body, stepUp: issued.json.stepUpId });
      expect(minted.status).toBe(200);
      expect(minted.json).toMatchObject({ pairingCode: expect.any(String) });
      // Used twice: refused.
      const replayed = await relayed(pair.path, { body: pair.body, stepUp: issued.json.stepUpId });
      expect(replayed.status).toBe(428);

      // Approving a held device, and choosing automatic, each with their own step-up.
      const requestId = await heldRequest("Fictional approved CLI");
      const approve = {
        method: "POST",
        path: "/admin/cloud-pairing/decision",
        body: JSON.stringify({ requestId, approve: true }),
      };
      const approved = await relayed(approve.path, {
        body: approve.body,
        stepUp: (await stepUp(approve)).json.stepUpId,
      });
      expect(approved.status).toBe(200);
      expect(await requestStatus(requestId)).toBe("approved");
      const automatic = {
        method: "PUT",
        path: "/admin/cloud-relay/enrollment",
        body: JSON.stringify({ policy: "automatic" }),
      };
      const switched = await relayed(automatic.path, {
        method: "PUT",
        body: automatic.body,
        stepUp: (await stepUp(automatic)).json.stepUpId,
      });
      expect(switched.status).toBe(200);
      expect((await gateway.status()).deviceEnrollment.policy).toBe("automatic");
      // Going back to "ask me first" makes the gateway stricter: no step-up.
      const ask = await relayed(automatic.path, {
        method: "PUT",
        body: JSON.stringify({ policy: "ask" }),
      });
      expect(ask.status).toBe(200);
      expect((await gateway.status()).deviceEnrollment.policy).toBe("ask");
    }, 240_000);

    test("a step-up for one action can't be used for another", async () => {
      const pair = {
        method: "POST",
        path: "/admin/devices/pair",
        body: JSON.stringify({ kind: "cli", name: "Fictional bound CLI" }),
      };
      // The same route with another body.
      const forOther = (await stepUp(pair)).json.stepUpId;
      const otherBody = await relayed(pair.path, {
        body: JSON.stringify({ kind: "cli", name: "Fictional other CLI", scopes: ["admin"] }),
        stepUp: forOther,
      });
      expect(otherBody.status).toBe(428);
      // Spent by that attempt: its own request can't use it now.
      expect((await relayed(pair.path, { body: pair.body, stepUp: forOther })).status).toBe(428);
      // Another route with the same body.
      const forToken = (await stepUp(pair)).json.stepUpId;
      const devices = await gateway.devices();
      const token = await relayed("/admin/tokens", {
        body: JSON.stringify({ deviceId: devices[0]!.id, scopes: ["admin"] }),
        stepUp: forToken,
      });
      expect(token.status).toBe(428);
      // Made up.
      expect(
        (await relayed(pair.path, { body: pair.body, stepUp: "Zm9yZ2VkLXN0ZXAtdXAtaWQ" })).status,
      ).toBe(428);
    }, 240_000);

    test("TM-01 (step-up): an assertion made on a relay page or a sibling gateway's page steps up nothing", async () => {
      const pair = {
        method: "POST",
        path: "/admin/devices/pair",
        body: JSON.stringify({ kind: "cli", name: "Fictional steered CLI" }),
      };
      for (const from of [
        world.relayOrigin,
        `https://${hostedGatewayHostname(randomUUID(), RELAY_HOST)}:${world.dataPort}`,
      ]) {
        const refused = await stepUp(pair, { from });
        expect(refused.status, from).toBe(403);
        expect(refused.json).toMatchObject({ code: "STEP_UP_REFUSED" });
      }
    }, 240_000);

    test("actions that make the gateway stricter need no step-up through the relay: deny, ask me first, revoke a device", async () => {
      const requestId = await heldRequest("Fictional denied CLI");
      const denied = await relayed("/admin/cloud-pairing/decision", {
        body: JSON.stringify({ requestId, approve: false }),
      });
      expect(denied.status).toBe(200);
      expect(await requestStatus(requestId)).not.toBe("pending");
      expect(
        (
          await relayed("/admin/cloud-relay/enrollment", {
            method: "PUT",
            body: JSON.stringify({ policy: "ask" }),
          })
        ).status,
      ).toBe(200);
      const spare = await gateway.json<{ device: { id: string } }>("/admin/devices", {
        method: "POST",
        body: JSON.stringify({ name: "Fictional spare CLI", kind: "cli", scopes: ["read"] }),
      });
      const revoked = await relayed(`/admin/devices/${spare.device.id}`, { method: "DELETE" });
      expect(revoked.status).toBe(200);
      expect(revoked.json).toMatchObject({ revoked: true });
    }, 240_000);

    test("a device that joined on its own steps up even on the gateway's own address; the gateway's host and a device paired by code don't", async () => {
      await gateway.setPolicy("automatic");
      const joined = await gatewayPasskeyJoin(gateway, owner, {
        kind: "cli",
        name: "Fictional automatic CLI",
      });
      expect(joined.joined).toBeDefined();
      const token = joined.joined!.token;
      const send: typeof relayed = (path, init = {}) => local(path, { ...init, token });
      const pair = {
        method: "POST",
        path: "/admin/devices/pair",
        body: JSON.stringify({ kind: "cli", name: "Fictional local CLI" }),
      };
      const refused = await local(pair.path, { body: pair.body, token });
      expect(refused.status).toBe(428);
      const issued = await stepUp(pair, { send });
      expect(issued.status).toBe(200);
      const minted = await local(pair.path, {
        body: pair.body,
        token,
        stepUp: issued.json.stepUpId,
      });
      expect(minted.status).toBe(200);
      // The gateway's own host, with the admin credential it was set up with, needs none.
      expect(
        (await local(pair.path, { body: pair.body, token: gateway.harness.apiKey })).status,
      ).toBe(200);
      await gateway.setPolicy("ask");
    }, 240_000);

    test("the portal through the relay approves a held device after one passkey prompt on the gateway's page", async () => {
      const name = "Fictional portal-approved CLI";
      const requestId = await heldRequest(name);
      const page = owner.page;
      await page.goto(
        `${gateway.publicOrigin}/portal/?token=${encodeURIComponent(gateway.harness.apiKey)}`,
      );
      await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
      await page.goto(`${gateway.publicOrigin}/portal/settings/devices`);
      const card = page.getByRole("article", { name: `Pair ${name}` });
      await card.waitFor({ timeout: 30_000 });
      await card.getByRole("button", { name: "Approve", exact: true }).click();
      await waitFor(
        async () => (await requestStatus(requestId)) === "approved",
        "the request to be approved",
      );
      expect(owner.errors).toEqual([]);
    }, 240_000);
  },
);
