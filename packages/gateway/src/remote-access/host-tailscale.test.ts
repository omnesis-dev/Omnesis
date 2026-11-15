// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { gatewayTarget, HostTailscaleService, type RunCli } from "./host-tailscale.js";

const cli = { file: "tailscale", bundledApp: false };
const running = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "Studio.Example-Net.ts.net." },
});

function service(answers: Record<string, string | Error>, port = 7600, trustProxy = true) {
  const run = vi.fn<RunCli>(async (_candidate, args) => {
    const answer = answers[args.join(" ")];
    if (answer === undefined) throw Object.assign(new Error("unknown command"), { stderr: "" });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { host: new HostTailscaleService(port, [cli], run, () => trustProxy), run };
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
      dnsName: "studio.example-net.ts.net",
      url: "https://studio.example-net.ts.net",
      servesGateway: false,
      publicGateway: false,
    });
  });

  test("sees a serve or funnel already forwarding to this gateway's port, and not to another", async () => {
    const serving = (proxy: string, funnel: boolean) =>
      JSON.stringify({
        Web: { "studio.example-net.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
        AllowFunnel: funnel ? { "studio.example-net.ts.net:443": true } : {},
      });
    const tailnet = service({
      "status --json": running,
      "serve status --json": serving(gatewayTarget(7600), false),
    });
    expect(await tailnet.host.status()).toMatchObject({
      servesGateway: true,
      publicGateway: false,
    });
    const publicly = service({
      "status --json": running,
      "serve status --json": serving("https+insecure://127.0.0.1:7600", true),
    });
    expect(await publicly.host.status()).toMatchObject({
      servesGateway: true,
      publicGateway: true,
    });
    const other = service({
      "status --json": running,
      "serve status --json": serving("http://localhost:3000", true),
    });
    expect(await other.host.status()).toMatchObject({ servesGateway: false, publicGateway: false });
  });

  test("publishing runs the documented command, for the tailnet or publicly", async () => {
    const { host, run } = service({
      "status --json": running,
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

  test("a public address waits until the gateway trusts the proxy in front of it, running nothing", async () => {
    const { host, run } = service(
      { "status --json": running, [`funnel --bg ${gatewayTarget(7600)}`]: "" },
      7600,
      false,
    );
    expect(await host.publish(true)).toEqual({
      ok: false,
      reason: expect.stringContaining("OMNESIS_TRUST_PROXY=true"),
      command: `tailscale funnel --bg ${gatewayTarget(7600)}`,
    });
    expect(run).not.toHaveBeenCalled();
    // The tailnet alone needs no proxy trust.
    const tailnetOnly = service(
      { "status --json": running, [`serve --bg ${gatewayTarget(7600)}`]: "" },
      7600,
      false,
    );
    expect((await tailnetOnly.host.publish(false)).ok).toBe(true);
  });

  test("Funnel's enable link, printed on stdout, is recognised", async () => {
    const { host } = service({
      "status --json": running,
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
});
