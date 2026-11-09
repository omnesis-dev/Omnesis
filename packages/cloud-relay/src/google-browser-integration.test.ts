// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { googleBrowserFixture } from "../test/google-browser-fixture.js";
import { listen } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions, accountId } from "./identity.js";
import { createCloudRelay } from "./server.js";
import { ManagedGoogleBrowser } from "./google-browser-client.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { googlePairingNonce } from "./google-pairing.js";
import type { GoogleBrowserPurpose } from "./google-browser-contract.js";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "google-browser-integration-"));
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  await rm(directory, { recursive: true, force: true });
});

test.each(["owner-link", "device-enrollment"] as GoogleBrowserPurpose[])(
  "managed %s completes through the real relay and default gateway-key session path",
  async (purpose) => {
    const f = await googleBrowserFixture(directory);
    const accounts = new RelayAccounts(join(directory, "relay.sqlite"));
    const relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      googleBrowser: f.configuration,
      gatewayIdentity: f.issuer("fixture-owner-client"),
      allowLoopbackEnrollment: true,
      hostnameProof: () => Promise.resolve(true),
    });
    const origin = await listen(relay.server);
    cleanup.push(async () => {
      await relay.close();
      accounts.close();
    });
    const ownerFile = join(directory, "owner.key"),
      sessionFile = join(directory, "session.json");
    await writeFile(ownerFile, f.ownerKeys.privateKey, { mode: 0o600 });
    const requests: { path: string; body: unknown; authorization: string | null }[] = [];
    const transport: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe(origin);
      requests.push({
        path: target.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return fetch(url, init);
    };
    const gateway = new ManagedGoogleBrowser({
      env: () => ({
        OMNESIS_CLOUD_RELAY_URL: origin,
        OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "fixture-owner-client",
        OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "fixture-device-client",
        OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "fixture-ios-client",
        OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "fixture-android-client",
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: f.registration.gatewayId,
        OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: f.registration.publicOrigin,
        OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerFile,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
        OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
        OMNESIS_ACME_CERT_FILE: f.files.certFile,
        OMNESIS_ACME_KEY_FILE: f.files.keyFile,
      }),
      fetch: transport,
      identity: f.issuer,
      callbackOrigins: () => ({ origins: ["https://direct.example.test"] }),
    });
    const callbackUrl = await gateway.callbackUrl("https://direct.example.test", purpose);
    const fields = {
      requestId: randomUUID(),
      kind: "portal" as const,
      name: "Fictional browser",
      secret: randomBytes(32).toString("hex"),
    };
    const nonce =
      purpose === "owner-link" ? gatewayBindingNonce(f.registration) : googlePairingNonce(fields);
    const browserState = randomBytes(32).toString("base64url");
    const pending = await gateway.begin({ purpose, nonce, browserState, callbackUrl });
    expect(accounts.gatewayBinding(f.account)).toMatchObject({
      gatewayId: f.registration.gatewayId,
      publicOrigin: f.registration.publicOrigin,
    });
    const cached = JSON.parse(await readFile(sessionFile, "utf8"));
    expect(cached.accountId).toBe(f.account);
    expect(requests.map((value) => value.path)).toEqual(
      expect.arrayContaining([
        "/_relay/v2/key/challenge",
        "/_relay/v2/key/complete",
        "/_relay/v2/google/browser/start",
      ]),
    );
    const signed = requests.find((value) => value.path.endsWith("/browser/start"))!;
    expect(signed.authorization).toBe(`Bearer ${cached.token}`);
    expect(JSON.stringify(signed.body)).not.toContain(pending.redemptionSecret);
    expect(JSON.stringify(signed.body)).not.toContain(fields.secret);
    expect(signed.body).toHaveProperty("ownerSignature");
    const launched = await fetch(pending.authorizeUrl, { redirect: "manual" });
    expect(launched.status).toBe(303);
    const centralCookie = launched.headers.get("set-cookie")!;
    expect(centralCookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
    const authorization = new URL(launched.headers.get("location")!);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("nonce")).toBe(nonce);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${origin}/_relay/v2/google/browser/callback`,
    );
    expect(
      (await fetch(pending.authorizeUrl, { redirect: "manual" })).status,
    ).toBeGreaterThanOrEqual(400);
    const provider = f.providerCallback(authorization.href);
    const centralCallback = origin + provider.pathname + provider.search;
    const noCookie = await fetch(centralCallback, { redirect: "manual" });
    expect(noCookie.status).toBe(403);
    expect(f.exchange).not.toHaveBeenCalled();
    const completed = await fetch(centralCallback, {
      redirect: "manual",
      headers: { cookie: centralCookie.split(";")[0]! },
    });
    expect(completed.status).toBe(303);
    const application = new URL(completed.headers.get("location")!);
    expect(application.origin + application.pathname).toBe(callbackUrl);
    expect([...application.searchParams.keys()].sort()).toEqual(["brokerResult", "state"]);
    expect(application.searchParams.get("state")).toBe(browserState);
    for (const secret of [
      pending.redemptionSecret,
      fields.secret,
      provider.searchParams.get("code")!,
      cached.token,
    ])
      expect(application.href).not.toContain(secret);
    expect(completed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.exchange).toHaveBeenCalledOnce();
    const exchanged = f.exchange.mock.calls[0]![1]!.body as URLSearchParams;
    expect(exchanged.get("client_id")).toBe(pending.clientId);
    expect(exchanged.get("code_verifier")).toHaveLength(64);
    const proof = await gateway.redeem(pending, application.searchParams.get("brokerResult")!);
    expect(proof.identity).toMatchObject({
      issuer: "https://accounts.google.com",
      subject: "synthetic-google-account",
    });
    expect(await f.issuer(pending.clientId).verify(proof.idToken, nonce)).toEqual(proof.identity);
    await expect(f.issuer(pending.clientId).verify(proof.idToken, "wrong-nonce")).rejects.toThrow();
    await expect(f.issuer("wrong-purpose-client").verify(proof.idToken, nonce)).rejects.toThrow();
    await expect(
      gateway.redeem(pending, application.searchParams.get("brokerResult")!),
    ).rejects.toThrow("refused");
    expect(
      (
        await fetch(centralCallback, {
          redirect: "manual",
          headers: { cookie: centralCookie.split(";")[0]! },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.exchange).toHaveBeenCalledOnce();
    const googleAccount = accountId(proof.identity);
    expect(accounts.resolveAccount(googleAccount)).not.toBe(f.account);
    const link = await fetch(origin + "/_relay/v2/key/google-link", {
      method: "POST",
      headers: { authorization: `Bearer ${cached.token}`, "content-type": "application/json" },
      body: JSON.stringify({ identityToken: proof.idToken }),
    });
    expect(link.status).toBe(purpose === "owner-link" ? 204 : 400);
    expect(accounts.resolveAccount(googleAccount)).toBe(
      purpose === "owner-link" ? f.account : googleAccount,
    );
    expect(await readFile(ownerFile, "utf8")).toBe(f.ownerKeys.privateKey);
    expect(await readFile(f.files.certFile, "utf8")).toBe(f.registration.certificate);
  },
);
