// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phonePairingLines, showPhonePairing } from "./phone-pairing.js";
import type { PairingAddressPlan } from "@omnesis/core";

vi.mock("qrcode-terminal", () => ({ default: { generate: vi.fn() } }));

const local = {
  gatewayUrl: "https://192.168.1.20:7600",
  host: "192.168.1.20",
  label: "Local network",
  usable: true as const,
  reach: "local-network" as const,
  systemTrust: false,
  summary:
    "Works only while the phone is on the same network as the gateway, such as your home Wi-Fi.",
};
const trustedName = {
  gatewayUrl: "https://studio.tail-example.ts.net:7600",
  host: "studio.tail-example.ts.net",
  label: "Tailscale name",
  usable: true as const,
  reach: "tailnet" as const,
  systemTrust: true,
  summary: "Works at home and away, as long as Tailscale is connected on the phone.",
};
const refusedIp = {
  gatewayUrl: "https://100.101.102.103:7600",
  host: "100.101.102.103",
  label: "Tailscale IP",
  usable: false as const,
  reason: "iPhones refuse the gateway's own certificate at a Tailscale IP address.",
};

// Colors are ANSI escapes in a terminal; strip them to read the words.
// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/gu, "");

describe("phonePairingLines", () => {
  it("says where the chosen address works, then the alternatives and the refusals", () => {
    const text = plain(
      phonePairingLines(
        {
          platform: "ios",
          addresses: [trustedName, local, refusedIp],
          recommendedUrl: trustedName.gatewayUrl,
          awayFromHome: null,
        },
        trustedName.gatewayUrl,
        "iPhone",
      ),
    );
    expect(text).toContain(`● ${trustedName.summary}`);
    expect(text).toContain("Address: Tailscale name · studio.tail-example.ts.net");
    expect(text).toContain("Other addresses this iPhone can use");
    expect(text).toContain(`--gateway-url ${local.gatewayUrl}`);
    expect(text).not.toContain(`--gateway-url ${trustedName.gatewayUrl}`);
    expect(text).toContain("Not offered for an iPhone:");
    expect(text).toContain(refusedIp.reason);
    expect(text).not.toContain("away from home:");
  });

  it("gives an iPhone limited to the local network the certificate step", () => {
    const text = plain(
      phonePairingLines(
        {
          platform: "ios",
          addresses: [local, refusedIp],
          recommendedUrl: local.gatewayUrl,
          awayFromHome: { onTailnet: true, tailscaleName: "studio.tail-example.ts.net" },
        },
        local.gatewayUrl,
        "iPhone",
      ),
    );
    expect(text).toContain("To use this iPhone away from home:");
    expect(text).toContain(
      "1. Turn on HTTPS certificates for your tailnet, then run `omnesis tls provision`",
    );
    expect(text).toContain("for studio.tail-example.ts.net");
    expect(text).toContain("2. Create a new pairing code and scan it.");
    expect(text).not.toMatch(/install tailscale/i);
  });

  it("tells an Android phone off a tailnet to install Tailscale and nothing about certificates", () => {
    const text = plain(
      phonePairingLines(
        {
          platform: "android",
          addresses: [local],
          recommendedUrl: local.gatewayUrl,
          awayFromHome: { onTailnet: false, tailscaleName: null },
        },
        local.gatewayUrl,
        "Android phone",
      ),
    );
    expect(text).toMatch(/1\. install tailscale on the gateway computer and on the android phone/i);
    expect(text).not.toContain("tls provision");
  });
});

describe("showPhonePairing", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.join(" "));
    });
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    vi.stubEnv("OMNESIS_IOS_GATEWAY_URL", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function gateway(plan: PairingAddressPlan | null, qr: Response) {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        plan ? Response.json(plan) : Response.json({ error: "no such route" }, { status: 404 }),
      )
      .mockResolvedValueOnce(qr);
    vi.stubGlobal("fetch", request);
    return request;
  }

  const body = (request: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse((request.mock.calls[call]?.[1] as { body: string }).body) as Record<string, unknown>;

  it("encodes the gateway's recommendation when no address is given", async () => {
    const request = gateway(
      {
        platform: "ios",
        addresses: [trustedName, local],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      },
      Response.json({ qrPayload: "fictional-payload" }),
    );
    await expect(showPhonePairing({ platform: "ios", pairingCode: "ABCDEF0123" })).resolves.toBe(
      trustedName.gatewayUrl,
    );
    expect(body(request, 1)).toEqual({
      pairingCode: "ABCDEF0123",
      gatewayUrl: trustedName.gatewayUrl,
      trustMode: "auto",
    });
    expect(plain(output)).toContain("Scan this QR with the Omnesis app on your iPhone:");
    expect(plain(output)).toContain(trustedName.summary);
  });

  it("refuses a --gateway-url the plan rules out, with the reason, alternatives and next steps", async () => {
    const request = gateway(
      {
        platform: "ios",
        addresses: [local, refusedIp],
        recommendedUrl: local.gatewayUrl,
        awayFromHome: { onTailnet: true, tailscaleName: "studio.tail-example.ts.net" },
      },
      Response.json({ qrPayload: "unused" }),
    );
    await expect(
      showPhonePairing({
        platform: "ios",
        pairingCode: "ABCDEF0123",
        gatewayUrlFlag: `${refusedIp.gatewayUrl}/`,
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(request).toHaveBeenCalledTimes(1);
    const text = plain(output);
    expect(text).toContain(`No QR code for ${refusedIp.gatewayUrl}: ${refusedIp.reason}`);
    expect(text.split(refusedIp.reason)).toHaveLength(2);
    expect(text).toContain(`Local network · 192.168.1.20 (recommended)`);
    expect(text).toContain(`--gateway-url ${local.gatewayUrl}`);
    expect(text).toContain("To use this iPhone away from home:");
    expect(text).toContain("This pairing code won't be used");
    expect(text).not.toContain("Scan this QR");
  });

  it("shows the gateway's refusal of an address the plan does not list", async () => {
    gateway(
      {
        platform: "ios",
        addresses: [local],
        recommendedUrl: local.gatewayUrl,
        awayFromHome: null,
      },
      Response.json(
        {
          error:
            "iPhones accept 203.0.113.7 only if the gateway's certificate for it is trusted by Apple devices.",
          code: "BAD_REQUEST",
        },
        { status: 400 },
      ),
    );
    await expect(
      showPhonePairing({
        platform: "ios",
        pairingCode: "ABCDEF0123",
        gatewayUrlFlag: "https://203.0.113.7:7600",
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(plain(output)).toContain(
      "No QR code for https://203.0.113.7:7600: iPhones accept 203.0.113.7",
    );
  });

  it("uses OMNESIS_IOS_GATEWAY_URL when no --gateway-url is given", async () => {
    vi.stubEnv("OMNESIS_IOS_GATEWAY_URL", `${local.gatewayUrl}/`);
    const request = gateway(
      {
        platform: "android",
        addresses: [trustedName, local],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      },
      Response.json({ qrPayload: "fictional-payload" }),
    );
    await expect(
      showPhonePairing({ platform: "android", pairingCode: "ABCDEF0123" }),
    ).resolves.toBe(local.gatewayUrl);
    expect(body(request, 1)).toMatchObject({ gatewayUrl: local.gatewayUrl });
    expect(plain(output)).toContain("Tailscale name · studio.tail-example.ts.net (recommended)");
  });

  it("maps a gateway failure to its exit code instead of a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 })),
    );
    await expect(
      showPhonePairing({ platform: "ios", pairingCode: "ABCDEF0123" }),
    ).rejects.toMatchObject({ exitCode: 77 });
  });

  it("prints no QR code when the phone can use none of the addresses", async () => {
    const request = gateway(
      {
        platform: "ios",
        addresses: [refusedIp],
        recommendedUrl: null,
        awayFromHome: { onTailnet: false, tailscaleName: null },
      },
      Response.json({ qrPayload: "unused" }),
    );
    await expect(showPhonePairing({ platform: "ios", pairingCode: "ABCDEF0123" })).rejects.toThrow(
      /None of this gateway's addresses can be used by an iPhone/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(plain(output)).toContain(refusedIp.reason);
    expect(plain(output)).toContain("To use this iPhone away from home:");
  });

  it("keeps the explicit address on a gateway that predates address judgement", async () => {
    const request = gateway(null, Response.json({ qrPayload: "legacy-payload" }));
    await expect(
      showPhonePairing({
        platform: "android",
        pairingCode: "ABCDEF0123",
        gatewayUrlFlag: local.gatewayUrl,
      }),
    ).resolves.toBe(local.gatewayUrl);
    expect(body(request, 1)).toMatchObject({ gatewayUrl: local.gatewayUrl, trustMode: "auto" });
    expect(plain(output)).toContain("legacy-payload");
  });
});
