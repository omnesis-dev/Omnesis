// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's own Tailscale device, end to end, on a private test tailnet
 * (see tailnet-harness.ts): a real gateway with the opt-in, the real helper
 * program joining headscale as the gateway's device, and real tailscaled
 * "machines" for the owner's laptops, another person's laptop and a tagged
 * server. The owner signs the gateway in from the link the gateway shows; a
 * collector joins with `omnesis tailscale join` from the owner's laptop,
 * finding the gateway through that laptop's own Tailscale.
 *
 * The tests run in order and share one tailnet and gateway.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { tailnetCleanupError } from "./tailnet-command-processes.js";
import {
  fetchFrom,
  GATEWAY_TAILNET_ORIGIN,
  runCliOn,
  TAILNET_DOMAIN,
  TailnetGateway,
  tailnetTools,
  TestTailnet,
  waitFor,
  type TailnetMachine,
  type TailnetTools,
} from "./tailnet-harness.js";

interface State {
  enabled: boolean;
  deviceName: string;
  connection: string;
  signInUrl: string | null;
  url: string | null;
  node: { dnsName: string; name?: string; naming?: string } | null;
  owner: { login: string } | null;
  certificate: { source: string; reason?: string } | null;
  public: { wanted: boolean; state: string; reason?: string };
  joinPolicy: string;
  joinRequests: Array<{ id: string; name: string; machine: string; login: string }>;
  helper: { state: string; reason?: string };
}

const SUITE = "tailscale-embed.e2e";
const tools: TailnetTools | null = await tailnetTools(SUITE);
/** Headscale can delete devices; the portable fixture's coordinator cannot. */
const onHeadscale = !tools?.portable;

describe.skipIf(!tools)("the gateway's own Tailscale device", () => {
  let tailnet: Awaited<ReturnType<typeof TestTailnet.start>>;
  let gateway: TailnetGateway;
  let laptop: TailnetMachine;
  let desktop: TailnetMachine;
  let stranger: TailnetMachine;
  let server: TailnetMachine;
  let failed = false;

  const state = async () => (await gateway.admin<State>("GET", "/admin/tailscale")).json;
  const until = (predicate: (s: State) => boolean, label: string, timeoutMs = 60_000) =>
    waitFor(
      async () => {
        const s = await state();
        return predicate(s) ? s : false;
      },
      label,
      timeoutMs,
    );
  const fromLaptop = (path: string, init: Parameters<typeof fetchFrom>[3] = {}) =>
    fetchFrom(laptop, tailnet.pki.caCert, `${GATEWAY_TAILNET_ORIGIN}${path}`, init);

  beforeAll(async () => {
    tailnet = await TestTailnet.start(tools!);
    gateway = new TailnetGateway(tailnet);
    await gateway.start();
    [laptop, desktop, stranger, server] = await Promise.all([
      tailnet.machine("maya-laptop", { user: "owner" }),
      tailnet.machine("maya-desktop", { user: "owner" }),
      tailnet.machine("jamie-laptop", { user: "stranger" }),
      tailnet.machine("build-server", { tags: ["tag:server"] }),
    ]);
  }, 300_000);

  afterAll(async () => {
    if (failed)
      process.stderr.write(`--- gateway log\n${gateway?.log() ?? ""}\n${tailnet?.logs() ?? ""}\n`);
    const failures: unknown[] = [];
    try {
      await gateway?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await tailnet?.stop({ retainInputs: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw tailnetCleanupError(failures);
    const removed = await Promise.allSettled([gateway?.remove(), tailnet?.stop()]);
    const removalFailures = removed.filter((result) => result.status === "rejected");
    if (removalFailures.length)
      throw tailnetCleanupError(removalFailures.map((result) => result.reason as unknown));
  }, 120_000);

  const step = (name: string, fn: () => Promise<void>, timeoutMs = 180_000, run = true) =>
    test.skipIf(!run)(
      name,
      async () => {
        try {
          await fn();
          expect(gateway.helperPanicked(), "the Go helper must remain free of panics").toBe(false);
        } catch (err) {
          failed = true;
          throw err;
        }
      },
      timeoutMs,
    );

  step(
    "the owner turns the device on and signs it in from the link the gateway shows",
    async () => {
      expect(await state()).toMatchObject({ enabled: false, connection: "off" });
      await gateway.admin("POST", "/admin/tailscale/enable", { enabled: true });
      const waiting = await until(
        (s) => s.connection === "needs-sign-in" && !!s.signInUrl,
        "a sign-in link",
      );
      expect(waiting.signInUrl).toContain(tailnet.controlUrl);
      await tailnet.approveSignIn(waiting.signInUrl!, "owner");
      const connected = await until((s) => s.connection === "connected", "the device to connect");
      expect(connected).toMatchObject({
        url: GATEWAY_TAILNET_ORIGIN,
        deviceName: "omnesis",
        node: { name: "omnesis", naming: "chosen" },
        owner: { login: tailnet.ownerLogin },
        // headscale offers no Tailscale certificates, so the gateway serves its own.
        certificate: { source: "gateway", reason: "https-disabled" },
        helper: { state: "running" },
      });
    },
  );

  step("the owner's laptop reaches the whole gateway at its tailnet name", async () => {
    const health = await waitFor(async () => {
      const res = await fromLaptop("/health");
      return res.status === 200 ? res : false;
    }, "the gateway over the tailnet");
    expect(health.json).toMatchObject({ status: "ok", tailscaleEmbed: true });
    const portal = await fromLaptop("/portal/");
    expect(portal.status).toBe(200);
    expect(portal.text).toContain("<html");
    // Without a credential, the tailnet grants nothing but reachability.
    expect((await fromLaptop("/admin/tailscale")).status).toBe(401);
  });

  step(
    "a collector on the owner's laptop joins after one approval, without a pairing code",
    async () => {
      const run = runCliOn(laptop, tailnet.pki.caCertFile, [
        "tailscale",
        "join",
        "--yes",
        "--name",
        "maya-laptop",
      ]);
      const request = await waitFor(
        async () => {
          const { json } = await gateway.admin<State>("GET", "/admin/tailscale");
          return json.joinRequests[0] ?? false;
        },
        "the join request",
        90_000,
      );
      expect(request).toMatchObject({
        name: "maya-laptop",
        machine: "maya-laptop",
        login: tailnet.ownerLogin,
      });
      expect(
        (
          await gateway.admin("POST", `/admin/tailscale/join-requests/${request.id}/decision`, {
            approve: true,
          })
        ).status,
      ).toBe(200);
      const result = await run;
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Joined as");
      const tokenFile = join(laptop.dir, "omnesis", "collector-token");
      expect(existsSync(tokenFile)).toBe(true);
      const token = readFileSync(tokenFile, "utf8").trim();
      // The credential works, over the tailnet, as a collector's.
      const whoami = await fromLaptop("/whoami", { headers: { authorization: `Bearer ${token}` } });
      expect(whoami.status).toBe(200);
      expect(whoami.json).toMatchObject({
        deviceName: "maya-laptop",
        scopes: expect.arrayContaining(["read", "write:*"]),
      });
    },
  );

  step("another person's laptop and a tagged server are refused", async () => {
    for (const machine of [stranger, server]) {
      const result = await runCliOn(machine, tailnet.pki.caCertFile, [
        "tailscale",
        "join",
        "--yes",
        "--gateway",
        `omnesis.tailnet.test`,
      ]);
      expect(result.code, machine.name).not.toBe(0);
      expect(result.stderr, machine.name).toContain(
        "Only the gateway owner's own Tailscale devices",
      );
    }
    expect((await state()).joinRequests).toEqual([]);
  });

  step("with joining automatic, the owner's other machine joins at once", async () => {
    await gateway.admin("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const result = await runCliOn(desktop, tailnet.pki.caCertFile, [
      "tailscale",
      "join",
      "--yes",
      "--name",
      "maya-desktop",
    ]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const devices = await gateway.admin<{ items: Array<{ name: string; kind: string }> }>(
      "GET",
      "/admin/devices",
    );
    expect(devices.json.items.filter((d) => d.kind === "collector").map((d) => d.name)).toEqual(
      expect.arrayContaining(["maya-laptop", "maya-desktop"]),
    );
  });

  step("with joining off, even the owner's machine pairs with a code", async () => {
    await gateway.admin("PATCH", "/admin/tailscale/settings", { joinPolicy: "off" });
    const result = await runCliOn(desktop, tailnet.pki.caCertFile, [
      "tailscale",
      "join",
      "--yes",
      "--name",
      "maya-desktop-again",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("turned off");
    await gateway.admin("PATCH", "/admin/tailscale/settings", { joinPolicy: "ask" });
  });

  step("the public address stays closed on a tailnet without HTTPS certificates", async () => {
    await gateway.admin("PATCH", "/admin/tailscale/settings", { publicAccess: true });
    const s = await until(
      (x) => x.public.state === "unavailable",
      "the public address to report its state",
    );
    expect(s.public).toMatchObject({
      wanted: true,
      state: "unavailable",
      reason: "https-disabled",
    });
    await gateway.admin("PATCH", "/admin/tailscale/settings", { publicAccess: false });
    await until((x) => x.public.state === "off", "the public address to close");
  });

  step("a restarted gateway rejoins the tailnet without signing in again", async () => {
    await gateway.stop();
    await gateway.start();
    await until((s) => s.connection === "connected", "the device to reconnect");
    await waitFor(
      async () => (await fromLaptop("/health")).status === 200,
      "the gateway over the tailnet again",
    );
  });

  step("signing out takes the gateway off the tailnet until the owner signs in again", async () => {
    await gateway.admin("POST", "/admin/tailscale/sign-out");
    const waiting = await until(
      (s) => s.connection === "needs-sign-in" && !!s.signInUrl,
      "a new sign-in link",
    );
    await waitFor(
      async () => {
        try {
          return (await fromLaptop("/health")).status !== 200;
        } catch {
          return true;
        }
      },
      "the tailnet address to go away",
      60_000,
    );
    await tailnet.approveSignIn(waiting.signInUrl!, "owner");
    await until((s) => s.connection === "connected", "the device to connect again");
    await waitFor(
      async () => (await fromLaptop("/health")).status === 200,
      "the reapproved gateway to answer over the real tailnet",
    );
  });

  step(
    "a device deleted on the tailnet while the gateway was off asks for a sign-in, never showing its old address",
    async () => {
      await gateway.stop();
      // Its node state still holds the deleted device, and a network map kept on disk.
      await (tailnet as TestTailnet).deleteNode("omnesis");
      await gateway.start();
      const seen: State[] = [];
      const waiting = await until((s) => {
        seen.push(s);
        return s.connection === "needs-sign-in" && !!s.signInUrl;
      }, "a sign-in link for the deleted device");
      expect(
        seen.filter((s) => s.connection === "connected" || s.url !== null || s.node !== null),
      ).toEqual([]);
      await tailnet.approveSignIn(waiting.signInUrl!, "owner");
      expect(
        await until((s) => s.connection === "connected", "the device to join again"),
      ).toMatchObject({ url: GATEWAY_TAILNET_ORIGIN, node: { name: "omnesis", naming: "chosen" } });
      await waitFor(
        async () => (await fromLaptop("/health")).status === 200,
        "the gateway over the tailnet as its new device",
      );
    },
    180_000,
    onHeadscale,
  );

  step(
    "renaming the device gives it the new name and address",
    async () => {
      const named = (name: string) =>
        until(
          (s) => s.node?.name === name && s.node.naming === "chosen",
          `the device to be named ${name}`,
        );
      await gateway.admin("PATCH", "/admin/tailscale/settings", { deviceName: "gateway-home" });
      expect(await named("gateway-home")).toMatchObject({
        deviceName: "gateway-home",
        url: `https://gateway-home.${TAILNET_DOMAIN}`,
      });
      // A name another device has gets a number, and says so.
      await gateway.admin("PATCH", "/admin/tailscale/settings", { deviceName: "build-server" });
      const taken = await until((s) => s.node?.naming === "taken", "the suffixed name");
      expect(taken).toMatchObject({
        deviceName: "build-server",
        url: `https://build-server-1.${TAILNET_DOMAIN}`,
        node: { name: "build-server-1" },
      });
      // Once that device is gone, saving the name again takes it, although the
      // name the device asks for has not changed.
      await (tailnet as TestTailnet).deleteNode("build-server");
      await gateway.admin("PATCH", "/admin/tailscale/settings", { deviceName: "build-server" });
      expect(await named("build-server")).toMatchObject({
        url: `https://build-server.${TAILNET_DOMAIN}`,
      });
      await gateway.admin("PATCH", "/admin/tailscale/settings", { deviceName: "omnesis" });
      expect(await named("omnesis")).toMatchObject({ url: GATEWAY_TAILNET_ORIGIN });
    },
    180_000,
    onHeadscale,
  );

  step("turning it off closes the tailnet address", async () => {
    await gateway.admin("POST", "/admin/tailscale/enable", { enabled: false });
    expect(await state()).toMatchObject({ enabled: false, connection: "off", url: null });
    await waitFor(
      async () => {
        try {
          return (await fromLaptop("/health")).status !== 200;
        } catch {
          return true;
        }
      },
      "the tailnet address to close",
      60_000,
    );
  });
});
