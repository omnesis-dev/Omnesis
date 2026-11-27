// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hostedGatewayHostname } from "@omnesis/cloud-relay";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import {
  EnrollmentWorld,
  EnrollmentGateway,
  connectGatewayBySignIn,
  PasskeyBrowser,
  RELAY_HOST,
  SCT_EXTENSION_LINE,
  createUnlinkedAccount,
  signInOnThisMachine,
  clickFirst,
  connectThisGateway,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { closeEnrollmentFixture } from "./enrollment-fixture-cleanup.js";
import { readDesktopStartupObservations } from "./desktop-node-adapter.js";
import { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";
import {
  installDesktopAccountBridge,
  readDesktopPrepareProgress,
} from "./desktop-account-bridge.js";
import { startDesktopAccountDns } from "./desktop-account-dns.js";
import {
  desktopAccountFailureCode,
  desktopAccountProgress,
  joinedRequest,
  protectedSourceGateway,
} from "./desktop-account-mixed-fixture.js";
import { addRestoreMaildirSource } from "./desktop-restore-fixture.js";
import { waitForCondition } from "./multi-collector-harness.js";

const execute = promisify(execFile);
const nonce = process.env.OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE;
/** Dedicated container lane: its source runtime uses the packaged fixed system trust policy. */
describe.skipIf(!nonce)("actual desktop account onboarding and owned collection", () => {
  let directory: string, previousResolver: string | undefined;
  let world: EnrollmentWorld, browser: PasskeyBrowser, owner: PasskeySession;
  let home: DesktopRuntimeFixture;
  let joined: DesktopRuntimeFixture | undefined;
  let sourceGateway: EnrollmentGateway | undefined;
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
      startupObservation: true,
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
        () => joined?.close(),
        () => sourceGateway?.close(),
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
    expect(
      await home.command("prepare", { mode: "home" }).catch(async (error: unknown) => {
        // Capture only finite observations before afterAll retires the owned fixture.
        try {
          process.stderr.write(
            `Desktop prepare observations: ${JSON.stringify(await readDesktopPrepareProgress(home.root))}\n`,
          );
          process.stderr.write(
            `Desktop startup observations: ${JSON.stringify(await readDesktopStartupObservations(join(home.root, "node-runtime")))}\n`,
          );
        } catch {
          // Diagnostic availability never replaces the original command failure.
        }
        throw error;
      }),
    ).toMatchObject({
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
        // Desktop opens the real direct authorize URL, not the printed-code entry page.
        const destination = String(interaction.url);
        expect(new URL(destination).origin).toBe(world.relayOrigin);
        try {
          await owner.page.goto(destination);
        } catch {
          throw new Error("The owned account browser destination could not be opened");
        }
        await clickFirst(owner.page, ["Sign in with Passkey", "Verify with Passkey"]);
        await connectThisGateway(owner.page);
        return "continue";
      },
    );
    if (linked.phase !== "ready") {
      let progress: unknown = "unavailable";
      try {
        const text = await readFile(join(home.root, "account-progress.json"), "utf8");
        if (text.length > 4096) throw new Error("The safe fixture progress exceeded its bound");
        const recorded = JSON.parse(text) as Record<string, unknown>;
        // Revalidate the persisted finite projection before including it in a test failure.
        const error = (value: unknown) => (value === "none" ? undefined : value);
        progress = desktopAccountProgress({
          account: { linked: recorded.linked },
          connect: {
            state: recorded.connect,
            step: recorded.step,
            error: error(recorded.connectError),
          },
          enrollment: { state: recorded.enrollment, error: error(recorded.enrollmentError) },
          tunnel: { state: recorded.tunnel, lastError: error(recorded.tunnelError) },
          certificate: { state: recorded.certificate, lastError: error(recorded.certificateError) },
        });
      } catch {
        /* Never print a raw filesystem or JSON error. */
      }
      throw new Error(
        `Account fixture refused: ${JSON.stringify({ failure: desktopAccountFailureCode(linked.message), progress })}`,
      );
    }
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

  test("an ordinary Linux source collector pairs by code and syncs directly to the managed home", async () => {
    if (!linkedReady) throw new Error("The real account home was not linked");
    const sourceId = await addRestoreMaildirSource(home, { pairing: "code" });
    const sources = (await home.request("/admin/sources")) as {
      items: Array<{ id: string; deviceId: string; enabled: boolean }>;
    };
    const source = sources.items.find((row) => row.id === sourceId);
    expect(source?.enabled).toBe(true);
    expect(source?.deviceId).not.toBe(await home.collectorDeviceId());
    const devices = (await home.request("/admin/devices")) as {
      items: Array<{ id: string; kind: string; capabilities?: { platform?: string } }>;
    };
    expect(devices.items.find((row) => row.id === source?.deviceId)).toMatchObject({
      kind: "collector",
      capabilities: { platform: "linux" },
    });
    const found = (await home.request(
      "/documents/search?q=Invented%20mail%20content&limit=10",
    )) as { results: Array<{ source_id: string }> };
    expect(found.results.some((row) => row.source_id === sourceId)).toBe(true);
    const homeState = await home.command("status");
    expect({
      phase: homeState.phase,
      mode: homeState.mode,
      encrypted: homeState.encrypted,
    }).toEqual({
      phase: "ready",
      mode: "home",
      encrypted: true,
    });
  }, 180_000);

  test("a Desktop joined collector enrolls and collects directly into an ordinary protected Linux source gateway", async () => {
    if (!linkedReady) throw new Error("The real fixture account was not established");
    sourceGateway = await EnrollmentGateway.start(
      world,
      "source-linux",
      protectedSourceGateway(home),
    );
    expect(await sourceGateway.json("/health")).toMatchObject({
      storageProtection: { version: 1, atRest: "encrypted" },
    });
    expect(await connectGatewayBySignIn(sourceGateway, owner, "existing")).toMatchObject({
      account: { linked: true },
    });
    joined = await DesktopRuntimeFixture.create({
      prepareInstall: false,
      systemTrustRuntime: true,
      relayUrl: world.relayOrigin,
    });
    await installDesktopAccountBridge(joined, {});
    const gateway = sourceGateway;
    let comparisons = 0;
    const state = await joined.interactiveCommand("connect", undefined, async (interaction) => {
      if (interaction.kind === "openBrowser") {
        expect(new URL(String(interaction.url)).origin).toBe(world.relayOrigin);
        await signInOnThisMachine(owner, String(interaction.url));
        return "continue";
      }
      if (interaction.kind === "chooseGateway") {
        expect(interaction.choices).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: gateway.gatewayId })]),
        );
        return gateway.gatewayId;
      }
      if (interaction.kind === "compareCode") {
        let requestId: string | undefined;
        await waitForCondition(
          async () => {
            requestId = (await gateway.pendingRequests()).find(
              (request) =>
                request.status === "pending" && request.verificationCode === interaction.code,
            )?.requestId;
            return requestId !== undefined;
          },
          20_000,
          "the exact joined role's code comparison",
        );
        await gateway.decide(requestId!, true);
        comparisons++;
        return "approve";
      }
      throw new Error("Unexpected mixed-install enrollment interaction");
    });
    expect({ phase: state.phase, mode: state.mode, encrypted: state.encrypted }).toEqual({
      phase: "ready",
      mode: "joined",
      encrypted: true,
    });
    expect(comparisons).toBe(2);
    const connection = state.connection as { deviceId: string; collectorDeviceId: string };
    expect(connection.collectorDeviceId).not.toBe(connection.deviceId);
    expect(await joinedRequest(joined, "/whoami")).toMatchObject({ deviceId: connection.deviceId });
    const vault = join(joined.root, "mixed-source-vault");
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await writeFile(
      join(vault, "Interoperability.md"),
      "# Interoperability\n\nfictional-mixed-install-content\n",
    );
    await waitForCondition(
      async () =>
        (await gateway.devices()).some(
          (device) => device.id === connection.collectorDeviceId && device.online,
        ),
      30_000,
      "the joined collector's real authenticated connection",
    );
    const resolved = (await joinedRequest(joined, "/admin/sources/resolve-account", {
      method: "POST",
      body: {
        deviceId: connection.collectorDeviceId,
        descriptorId: "obsidian-notes",
        params: { vaultPath: vault },
      },
    })) as { accountId: string };
    expect(typeof resolved.accountId).toBe("string");
    const added = (await joinedRequest(joined, "/admin/sources/add", {
      method: "POST",
      body: {
        deviceId: connection.collectorDeviceId,
        descriptorId: "obsidian-notes",
        accountIds: [resolved.accountId],
        params: { vaultPath: vault },
      },
    })) as { sourceIds: string[] };
    expect(added.sourceIds).toEqual([`obsidian-notes:${resolved.accountId}`]);
    const query = "/documents/search?q=fictional-mixed-install-content&limit=10";
    await waitForCondition(
      async () => {
        const result = (await joinedRequest(joined!, query)) as { results: Array<{ id: string }> };
        return result.results.length === 1;
      },
      30_000,
      "the joined real reader's document in the central source gateway",
    );
    expect(
      await lstat(join(joined.profile.configDir, "omnesis.db")).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    ).toBeNull();
    expect(
      JSON.parse(await readFile(join(joined.profile.configDir, "desktop-install.json"), "utf8")),
    ).toMatchObject({ mode: "joined" });
    expect(await joined.command("stop")).toMatchObject({ phase: "waiting", mode: "joined" });
    expect(await gateway.json("/health")).toMatchObject({
      status: "ok",
      storageProtection: { atRest: "encrypted" },
    });
    const originalHome = await home.command("status");
    expect({ phase: originalHome.phase, mode: originalHome.mode }).toEqual({
      phase: "ready",
      mode: "home",
    });
  }, 300_000);
});
