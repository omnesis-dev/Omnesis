// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hostedGatewayHostname } from "@omnesis/cloud-relay";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import {
  EnrollmentWorld,
  PasskeyBrowser,
  RELAY_HOST,
  SCT_EXTENSION_LINE,
  createUnlinkedAccount,
  signInOnThisMachine,
  enterConnectCode,
  clickFirst,
  connectThisGateway,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { closeEnrollmentFixture } from "./enrollment-fixture-cleanup.js";
import { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";
import { installDesktopAccountBridge } from "./desktop-account-bridge.js";
import { startDesktopAccountDns } from "./desktop-account-dns.js";
import { waitForCondition } from "./multi-collector-harness.js";

const execute = promisify(execFile);
const nonce = process.env.OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE;
/** Dedicated container lane: its source runtime uses the packaged fixed system trust policy. */
describe.skipIf(!nonce)("actual desktop account onboarding and owned collection", () => {
  let directory: string, previousResolver: string | undefined;
  let world: EnrollmentWorld, browser: PasskeyBrowser, owner: PasskeySession;
  let home: DesktopRuntimeFixture;
  let dns: Awaited<ReturnType<typeof startDesktopAccountDns>>;
  let authority: Awaited<ReturnType<typeof localAcmeAuthority>>;
  let gatewayHostname: string | undefined;
  let linkedReady = false;
  const trustFiles = [
    "/usr/local/share/ca-certificates/omnesis-desktop-relay.crt",
    "/usr/local/share/ca-certificates/omnesis-desktop-acme.crt",
  ];
  let isolated = false;

  beforeAll(async () => {
    // Never modify a host resolver or trust store: only the runner's exact private mount authorizes this container.
    const receipt = JSON.parse(await readFile("/run/desktop-account-container.json", "utf8"));
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      receipt.format !== 1 ||
      receipt.owner !== "omnesis-desktop-account-e2e" ||
      receipt.nonce !== nonce ||
      receipt.hostname !== hostname() ||
      hostname() !== `omnesis-desktop-e2e-${nonce}`
    )
      throw new Error("The account fixture requires its dedicated disposable container");
    isolated = true;
    directory = await mkdtemp("/tmp/omnesis-desktop-account-");
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    await mkdir(join(directory, "acme"));
    authority = await localAcmeAuthority(
      join(directory, "acme"),
      () => {
        if (!gatewayHostname) throw new Error("The gateway has not claimed its fixture hostname");
        return gatewayHostname;
      },
      world.dnsRecords,
      { leafExtensions: [SCT_EXTENSION_LINE] },
    );
    await writeFile(trustFiles[0]!, world.pki.caCert);
    await writeFile(trustFiles[1]!, authority.root);
    await execute("/usr/sbin/update-ca-certificates", []);
    dns = await startDesktopAccountDns(world.dnsApiUrl().replace(/\/client\/v4$/u, ""), 53);
    previousResolver = await readFile("/etc/resolv.conf", "utf8");
    await writeFile(
      "/etc/resolv.conf",
      "nameserver 127.0.0.1\noptions ndots:0 timeout:1 attempts:1\n",
    );
    browser = await PasskeyBrowser.launch(world);
    owner = await browser.session();
    await createUnlinkedAccount(world, owner);
    const acmeRoot = join(directory, "private-acme-root.pem");
    await writeFile(acmeRoot, authority.root, { mode: 0o600 });
    home = await DesktopRuntimeFixture.create({
      prepareInstall: false,
      systemTrustRuntime: true,
      relayUrl: world.relayOrigin,
    });
    await installDesktopAccountBridge(home, {
      OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
      OMNESIS_ACME_CA_FILE: acmeRoot,
      OMNESIS_ACME_TERMS_ACCEPTED: "1",
    });
  }, 180_000);

  afterAll(async () => {
    try {
      await closeEnrollmentFixture(directory, [
        () => home?.close(),
        () => browser?.close(),
        () => authority?.close(),
        () => world?.close(),
      ]);
    } finally {
      await dns?.close();
      if (isolated) {
        if (previousResolver !== undefined) await writeFile("/etc/resolv.conf", previousResolver);
        for (const path of trustFiles) await rm(path, { force: true });
        await execute("/usr/sbin/update-ca-certificates", []);
      }
    }
    expect(dns?.productionQueries.size ?? 0).toBe(0);
  }, 180_000);

  test("a fresh app discovers no home, claims its own encrypted library and links the real account", async () => {
    expect(
      await home.interactiveCommand("connect", undefined, async (interaction) => {
        expect(interaction.kind).toBe("openBrowser");
        expect(new URL(String(interaction.url)).origin).toBe(world.relayOrigin);
        await signInOnThisMachine(owner, String(interaction.url));
        return "continue";
      }),
    ).toMatchObject({ phase: "chooseHome" });
    expect(await home.command("prepare", { mode: "home" })).toMatchObject({
      phase: "accountRequired",
      mode: "home",
      encrypted: true,
    });
    const linked = await home.interactiveCommand(
      "connect",
      { intent: "existing", termsAccepted: true },
      async (interaction) => {
        expect(interaction.kind).toBe("openBrowser");
        const pending = (await home.request("/admin/cloud-relay")) as { gatewayId: string };
        gatewayHostname = hostedGatewayHostname(pending.gatewayId, RELAY_HOST);
        await enterConnectCode(owner.page, String(interaction.url), String(interaction.code));
        await clickFirst(owner.page, ["Sign in with Passkey", "Verify with Passkey"]);
        await connectThisGateway(owner.page);
        return "continue";
      },
    );
    expect(linked).toMatchObject({ phase: "ready", mode: "home", encrypted: true });
    expect(await home.request("/health")).toMatchObject({
      status: "ok",
      storageProtection: { version: 1, atRest: "encrypted" },
    });
    expect(await home.request("/admin/cloud-relay")).toMatchObject({ account: { linked: true } });
    linkedReady = true;
  }, 300_000);

  test("the account-gated owned collector ingests a real source and survives actual daemon restart", async () => {
    if (!linkedReady) throw new Error("The account setup did not complete");
    const vault = join(home.root, "invented-vault");
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await writeFile(join(vault, "Fixture.md"), "# Fixture\n\ninvented-desktop-source-marker\n");
    let deviceId: string | null = null;
    await waitForCondition(
      async () => {
        deviceId = await home.collectorDeviceId();
        return deviceId !== null;
      },
      90_000,
      "the actual owned collector pairs",
    );
    let accountId: string | undefined;
    await waitForCondition(
      async () => {
        try {
          const resolved = (await home.request("/admin/sources/resolve-account", {
            method: "POST",
            body: { deviceId, descriptorId: "obsidian-notes", params: { vaultPath: vault } },
          })) as { accountId: string };
          accountId = resolved.accountId;
          return typeof accountId === "string";
        } catch {
          return false;
        }
      },
      90_000,
      "the owned collector resolves its selected source",
    );
    await home.request("/admin/sources/add", {
      method: "POST",
      body: {
        deviceId,
        descriptorId: "obsidian-notes",
        accountIds: [accountId],
        params: { vaultPath: vault },
      },
    });
    const path = "/documents/search?q=invented-desktop-source-marker&limit=10";
    let documentId: string | undefined;
    await waitForCondition(
      async () => {
        const result = (await home.request(path)) as { results: Array<{ id: string }> };
        documentId = result.results[0]?.id;
        return typeof documentId === "string";
      },
      90_000,
      "the real source commits its document",
    );
    expect(await home.command("stop")).toMatchObject({ phase: "waiting" });
    expect(await home.plaintextFiles("invented-desktop-source-marker")).toEqual([]);
    for (const marker of [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "),
      ["-----BEGIN EC", "PRIVATE KEY-----"].join(" "),
    ])
      expect(await home.plaintextFiles(marker)).toEqual([]);
    expect(await home.command("connect")).toMatchObject({ phase: "ready", encrypted: true });
    expect(
      ((await home.request(path)) as { results: Array<{ id: string }> }).results.map(
        ({ id }) => id,
      ),
    ).toContain(documentId);
    expect(await home.collectorDeviceId()).toBe(deviceId);
  }, 240_000);
});
