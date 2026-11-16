// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  gatewayTarget,
  HostTailscaleService,
  NO_FREE_PORT,
  type RunCli,
} from "./host-tailscale.js";

const cli = { file: "tailscale", bundledApp: false };
const running = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "Studio.Example-Net.ts.net." },
});
const NAME = "studio.example-net.ts.net";
const GATEWAY = gatewayTarget(7600);

/** A `serve status --json` answer: web handlers by port, Funnel ports, raw TCP forwards. */
function serving(
  web: Record<number, Record<string, string>>,
  funnel: number[] = [],
  tcp: Record<number, Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    TCP: {
      ...Object.fromEntries(Object.keys(web).map((port) => [port, { HTTPS: true }])),
      ...tcp,
    },
    Web: Object.fromEntries(
      Object.entries(web).map(([port, handlers]) => [
        `${NAME}:${port}`,
        {
          Handlers: Object.fromEntries(
            Object.entries(handlers).map(([path, proxy]) => [path, { Proxy: proxy }]),
          ),
        },
      ]),
    ),
    AllowFunnel: Object.fromEntries(funnel.map((port) => [`${NAME}:${port}`, true])),
  });
}

function service(answers: Record<string, string | Error>, port = 7600) {
  const run = vi.fn<RunCli>(async (_candidate, args) => {
    const answer = answers[args.join(" ")];
    if (answer === undefined) throw Object.assign(new Error("unknown command"), { stderr: "" });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { host: new HostTailscaleService(port, [cli], run), run };
}

describe("HostTailscaleService", () => {
  test("not installed, or installed but signed out, is unavailable", async () => {
    expect(await service({}).host.status()).toEqual({
      state: "unavailable",
      reason: "Tailscale is not running on this computer.",
    });
    const loggedOut = service({ "status --json": JSON.stringify({ BackendState: "NeedsLogin" }) });
    expect((await loggedOut.host.status()).state).toBe("unavailable");
  });

  test("reports the machine's name and that nothing forwards to the gateway yet", async () => {
    const { host } = service({ "status --json": running, "serve status --json": "{}" });
    expect(await host.status()).toEqual({
      state: "available",
      dnsName: NAME,
      port: 443,
      url: `https://${NAME}`,
      servesGateway: false,
      publicGateway: false,
    });
  });

  test("sees a serve or funnel already forwarding to this gateway's port, and not to another", async () => {
    const on443 = (proxy: string, funnel: boolean) =>
      serving({ 443: { "/": proxy } }, funnel ? [443] : []);
    const tailnet = service({
      "status --json": running,
      "serve status --json": on443(gatewayTarget(7600), false),
    });
    expect(await tailnet.host.status()).toMatchObject({
      servesGateway: true,
      publicGateway: false,
    });
    const publicly = service({
      "status --json": running,
      "serve status --json": on443("https+insecure://127.0.0.1:7600", true),
    });
    expect(await publicly.host.status()).toMatchObject({
      servesGateway: true,
      publicGateway: true,
    });
    const other = service({
      "status --json": running,
      "serve status --json": on443("http://localhost:3000", true),
    });
    expect(await other.host.status()).toMatchObject({
      servesGateway: false,
      publicGateway: false,
      port: 8443,
      url: `https://${NAME}:8443`,
    });
  });

  test("publishing runs the documented command, for the tailnet or publicly", async () => {
    const { host, run } = service({
      "status --json": running,
      "serve status --json": "{}",
      [`serve --bg ${gatewayTarget(7600)}`]: "",
      [`funnel --bg ${gatewayTarget(7600)}`]: "",
    });
    expect(await host.publish(false)).toEqual({
      ok: true,
      url: "https://studio.example-net.ts.net",
    });
    expect(await host.publish(true)).toEqual({
      ok: true,
      url: "https://studio.example-net.ts.net",
    });
    expect(run.mock.calls.map(([, args]) => args.join(" "))).toContain(
      `funnel --bg ${gatewayTarget(7600)}`,
    );
  });

  test("Funnel's enable link, printed on stdout, is recognised", async () => {
    const { host } = service({
      "status --json": running,
      "serve status --json": "{}",
      [`funnel --bg ${gatewayTarget(7600)}`]: Object.assign(new Error("exit 1"), {
        stdout:
          "Funnel is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/funnel?node=abc",
        stderr: "",
      }),
    });
    expect(await host.publish(true)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not allow Funnel"),
    });
  });

  test("a refusal names why and the exact command to run instead", async () => {
    const denied = service({
      "status --json": running,
      "serve status --json": "{}",
      [`funnel --bg ${gatewayTarget(7600)}`]: Object.assign(new Error("exit 1"), {
        stderr: "Access denied: serve config denied",
      }),
    });
    expect(await denied.host.publish(true)).toEqual({
      ok: false,
      reason: expect.stringContaining("not allowed to change Tailscale"),
      command: "tailscale funnel --bg https+insecure://localhost:7600",
    });
    const noFunnel = service({
      "status --json": running,
      "serve status --json": "{}",
      [`funnel --bg ${gatewayTarget(7600)}`]: Object.assign(new Error("exit 1"), {
        stderr: "Funnel not enabled. Visit https://login.tailscale.com/f/funnel?node=abc to enable",
      }),
    });
    expect((await noFunnel.host.publish(true)).ok).toBe(false);
    expect(await noFunnel.host.publish(true)).toMatchObject({
      reason: expect.stringContaining("does not allow Funnel"),
    });
    const other = service({
      "status --json": running,
      "serve status --json": "{}",
      [`serve --bg ${gatewayTarget(7600)}`]: Object.assign(new Error("exit 1"), {
        stderr: "something else",
      }),
    });
    expect(await other.host.publish(false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("did not accept"),
    });
    expect(await service({}).host.publish(false)).toEqual({
      ok: false,
      reason: "Tailscale is not running on this computer.",
      command: "tailscale serve --bg https+insecure://localhost:7600",
    });
  });

  describe("never takes a port another app holds", () => {
    const OTHER = "http://127.0.0.1:3000";

    test("another app on 443: publishes on 8443, and says so", async () => {
      const { host, run } = service({
        "status --json": running,
        "serve status --json": serving({ 443: { "/": OTHER } }),
        [`serve --bg --https=8443 ${GATEWAY}`]: "",
      });
      expect(await host.status()).toMatchObject({
        port: 8443,
        url: `https://${NAME}:8443`,
        servesGateway: false,
      });
      expect(await host.publish(false)).toEqual({ ok: true, url: `https://${NAME}:8443` });
      const commands = run.mock.calls.map(([, args]) => args.join(" "));
      expect(commands.filter((c) => c.startsWith("serve --bg"))).toEqual([
        `serve --bg --https=8443 ${GATEWAY}`,
      ]);
    });

    test("an app on another path of 443, or a raw TCP forward, holds the port too", async () => {
      const path = service({
        "status --json": running,
        "serve status --json": serving({ 443: { "/": GATEWAY, "/files": OTHER } }),
      });
      expect(await path.host.status()).toMatchObject({ port: 8443, servesGateway: false });
      const tcp = service({
        "status --json": running,
        "serve status --json": serving({}, [], { 443: { TCPForward: "127.0.0.1:5432" } }),
      });
      expect(await tcp.host.status()).toMatchObject({ port: 8443, servesGateway: false });
    });

    test("a serve still running in a terminal holds its port", async () => {
      const { host } = service({
        "status --json": running,
        "serve status --json": JSON.stringify({
          Foreground: { session1: JSON.parse(serving({ 443: { "/": OTHER } })) },
        }),
      });
      expect(await host.status()).toMatchObject({ port: 8443 });
    });

    test("443 and 8443 taken: publishes publicly on 10000", async () => {
      const { host, run } = service({
        "status --json": running,
        "serve status --json": serving({ 443: { "/": OTHER }, 8443: { "/": OTHER } }),
        [`funnel --bg --https=10000 ${GATEWAY}`]: "",
      });
      expect(await host.publish(true)).toEqual({ ok: true, url: `https://${NAME}:10000` });
      expect(run.mock.calls.map(([, args]) => args.join(" "))).toContain(
        `funnel --bg --https=10000 ${GATEWAY}`,
      );
    });

    test("all three taken: runs nothing and says why", async () => {
      const { host, run } = service({
        "status --json": running,
        "serve status --json": serving({
          443: { "/": OTHER },
          8443: { "/": OTHER },
          10000: { "/": OTHER },
        }),
      });
      expect(await host.status()).toMatchObject({
        port: null,
        servesGateway: false,
        blocked: NO_FREE_PORT,
      });
      expect(await host.publish(true)).toEqual({ ok: false, reason: NO_FREE_PORT });
      expect(run.mock.calls.every(([, args]) => !args.includes("--bg"))).toBe(true);
    });

    test("served on 10000 already: that is its address, and going public stays there", async () => {
      const { host, run } = service({
        "status --json": running,
        "serve status --json": serving({ 443: { "/": OTHER }, 10000: { "/": GATEWAY } }),
        [`funnel --bg --https=10000 ${GATEWAY}`]: "",
      });
      expect(await host.status()).toMatchObject({
        port: 10000,
        url: `https://${NAME}:10000`,
        servesGateway: true,
        publicGateway: false,
      });
      expect(await host.publish(true)).toEqual({ ok: true, url: `https://${NAME}:10000` });
      expect(run.mock.calls.map(([, args]) => args.join(" "))).toContain(
        `funnel --bg --https=10000 ${GATEWAY}`,
      );
    });

    test("served on a port Funnel refuses: going public adds a Funnel port", async () => {
      const { host, run } = service({
        "status --json": running,
        "serve status --json": serving({ 17000: { "/": GATEWAY } }),
        [`funnel --bg ${GATEWAY}`]: "",
      });
      expect(await host.status()).toMatchObject({
        port: 17000,
        url: `https://${NAME}:17000`,
        servesGateway: true,
      });
      expect(await host.publish(true)).toEqual({ ok: true, url: `https://${NAME}` });
      expect(run.mock.calls.map(([, args]) => args.join(" "))).toContain(`funnel --bg ${GATEWAY}`);
    });

    test("a refusal on 8443 names the command with that port", async () => {
      const { host } = service({
        "status --json": running,
        "serve status --json": serving({ 443: { "/": OTHER } }),
        [`serve --bg --https=8443 ${GATEWAY}`]: Object.assign(new Error("exit 1"), {
          stderr: "Access denied: serve config denied",
        }),
      });
      expect(await host.publish(false)).toEqual({
        ok: false,
        reason: expect.stringContaining("not allowed to change Tailscale"),
        command: `tailscale serve --bg --https=8443 ${GATEWAY}`,
      });
    });

    test("when Tailscale won't say what it serves, nothing runs", async () => {
      const { host, run } = service({
        "status --json": running,
        "serve status --json": Object.assign(new Error("exit 1"), { stderr: "denied" }),
      });
      expect(await host.publish(false)).toEqual({
        ok: false,
        reason: expect.stringContaining("changed nothing"),
        command: `tailscale serve --bg ${GATEWAY}`,
      });
      expect(run.mock.calls.every(([, args]) => !args.includes("--bg"))).toBe(true);
    });
  });
});
