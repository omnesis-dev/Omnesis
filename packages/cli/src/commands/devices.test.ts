// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regression guard: `omnesis devices pair` accepts --kind / --scopes as named
 * flags. Without an `args` declaration on the command, citty drops
 * those flags on the floor and `pair` falls through to its interactive
 * prompts regardless of what the operator typed — which is what users hit
 * before this test landed (`devices pair --kind=ios` still asking for kind).
 *
 * We can't exercise the prompts themselves headlessly, but parsing-time
 * argument capture is enough to lock the contract: if the args block is
 * removed again, parseArgs() stops surfacing the flags and these assertions
 * fail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEmail, normalizePhone } from "@omnesis/core";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
} from "@omnesis/agent-integration";
import {
  DEVICE_HOSTED_SOURCE_TYPES,
  SCOPE_ADMIN,
  SCOPE_READ,
  defaultScopesForDeviceKind,
  scopeSatisfies,
  writeScope,
} from "@omnesis/types";
import {
  CHROME_WEB_STORE_URL,
  answerLevelNames,
  deviceAccessLevelLine,
  deviceUpdateNoticeLine,
  devicesCommand,
  deviceCorpusCredentialImpact,
  deviceCorpusCredentialLabel,
  deviceLiveLabel,
  discoveryJson,
  deviceRevokePath,
  deviceRevocationConfirmationMessage,
  deviceRevocationNeedsConfirmation,
  deviceStatusLabel,
  deviceVersionLabel,
  deviceVersionStateCell,
  pairingTlsFailure,
  revokedCollectorReRegisters,
  getOrCreateInstallId,
  pairCommand,
  parsePairingScopes,
  parseRedeemedAgentIntegrationPairing,
  parseRedeemedPairing,
  parseSelfInfoField,
  pairInstructionLines,
  repairInstructionLines,
  redeemAgentIntegrationPairingCode,
  redeemPairingCode,
} from "./devices.js";
import { buildPairQrPayload } from "./phone-pairing.js";

describe("device list connection labels", () => {
  it("describes WebSocket presence without declaring devices online or offline", () => {
    expect(deviceLiveLabel(true)).toBe("yes");
    expect(deviceLiveLabel(false)).toBe("no");
  });
});

describe("device list version cells", () => {
  it("shows what the device reported, and an em dash when it reported nothing", () => {
    expect(deviceVersionLabel({ version: "1.4.0" })).toBe("1.4.0");
    expect(deviceVersionLabel({ version: null })).toBe("—");
    expect(deviceVersionLabel({})).toBe("—");
  });

  it("names each state, and keeps the visible text separate from its colouring", () => {
    for (const state of ["current", "behind", "unsupported", "unknown"] as const) {
      const cell = deviceVersionStateCell({ versionState: state });
      expect(cell.text).toBe(state);
      // `text` is what the column aligns on and `colored` is what is printed;
      // the two must always agree on the visible characters, whether or not
      // this terminal renders colour at all.
      expect(cell.colored).toContain(cell.text);
    }
  });

  it("reads an absent state as unknown, so an older gateway degrades cleanly", () => {
    expect(deviceVersionStateCell({}).text).toBe("unknown");
  });

  it("reports no state for a revoked device, whose last reading means nothing", () => {
    // Its version is still on the row; the verdict is not, because nothing
    // runs on that device any more.
    expect(deviceVersionStateCell({ revokedAt: 1_000, versionState: "unsupported" }).text).toBe(
      "—",
    );
  });
});

const VALID_REDEEMED_PAIRING = {
  device: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Agent harness",
    kind: "cli",
  },
  tokenId: "22222222-2222-4222-8222-222222222222",
  token: `omn_${"a".repeat(32)}`,
  scopes: ["answer"],
};

const VALID_AGENT_INTEGRATION_PAIRING = {
  device: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Fictional agent",
    kind: "agent",
  },
  credentials: {
    delivery: {
      tokenId: "22222222-2222-4222-8222-222222222222",
      token: `omn_${"a".repeat(32)}`,
      scopes: ["subscriptions:receive"],
    },
    ingestion: {
      tokenId: "33333333-3333-4333-8333-333333333333",
      token: `omn_${"b".repeat(32)}`,
      scopes: ["write:openclaw"],
    },
    management: {
      tokenId: "44444444-4444-4444-8444-444444444444",
      token: `omn_${"c".repeat(32)}`,
      scopes: ["subscriptions:manage"],
    },
  },
};

describe("pairing response validation", () => {
  it("accepts the gateway pairing contract", () => {
    expect(parseRedeemedPairing(VALID_REDEEMED_PAIRING)).toMatchObject(VALID_REDEEMED_PAIRING);
  });

  it.each([
    { ...VALID_REDEEMED_PAIRING, token: `omn_${"a".repeat(31)}\nOMNESIS_TOKEN=forged` },
    { ...VALID_REDEEMED_PAIRING, scopes: ["answer", "not-a-scope"] },
    {
      ...VALID_REDEEMED_PAIRING,
      device: { ...VALID_REDEEMED_PAIRING.device, name: "Agent\nOMNESIS_TOKEN=forged" },
    },
    {
      ...VALID_REDEEMED_PAIRING,
      device: { ...VALID_REDEEMED_PAIRING.device, name: "Agent\u001b[31m" },
    },
    {
      ...VALID_REDEEMED_PAIRING,
      device: { ...VALID_REDEEMED_PAIRING.device, name: "A".repeat(257) },
    },
    { ...VALID_REDEEMED_PAIRING, tokenId: "not-a-uuid" },
  ])("rejects malformed or injectable response fields", (value) => {
    expect(() => parseRedeemedPairing(value)).toThrowError(/malformed pairing response/);
  });

  it("names the gateway it dialled when the connection is refused", async () => {
    // The runner's fallback hint is built once from this machine's own
    // GATEWAY_REQUEST_URL, which during a join is exactly the address that is
    // not being dialled — a two-machine run reported "Cannot reach gateway at
    // https://localhost:7600" while pairing with the gateway's own LAN address,
    // sending the operator to debug the wrong host.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:7600"), {
            code: "ECONNREFUSED",
          }),
        }),
      ),
    );
    await expect(redeemPairingCode("https://192.0.2.10:7600", "PAIR-CODE")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("192.0.2.10:7600") &&
        !error.message.includes("localhost") &&
        !error.message.includes("127.0.0.1"),
    );
  });

  it("names the gateway it dialled when a pinned join dies during the handshake", async () => {
    // A pinned join verifies the certificate FIRST, over a raw TLS socket
    // (`fetchPeerCert`), and that call sits above the redeem's own try/catch.
    // A gateway behind a closed port answers the TCP connect and then dies
    // mid-handshake, so the error escaped this command entirely and reached the
    // runner, whose hint names GATEWAY_REQUEST_URL — this machine's own
    // gateway. The unpinned path does not show this: its trust probe swallows
    // non-certificate errors and carries on into the redeem.
    const { createServer } = await import("node:net");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    const configDir = mkdtempSync(joinPath(tmpdir(), "omnesis-pair-"));
    try {
      await expect(
        redeemPairingCode(
          `https://127.0.0.1:${port}`,
          "PAIR-CODE",
          configDir,
          `sha256:${"a".repeat(64)}`,
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`127.0.0.1:${port}`) &&
          /cannot reach the gateway/i.test(error.message),
      );
    } finally {
      server.close();
    }
  });

  it("does not reflect an untrusted gateway error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("\u001b[31mforged gateway detail", { status: 500 })),
    );
    await expect(redeemPairingCode("http://127.0.0.1:7600", "PAIR-CODE")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("gateway status 500") &&
        !error.message.includes("forged gateway detail"),
    );
  });

  it("accepts only the exact separated agent-integration credential scopes", () => {
    const bundle = VALID_AGENT_INTEGRATION_PAIRING;
    expect(parseRedeemedAgentIntegrationPairing(bundle, "openclaw")).toMatchObject(bundle);
    expect(() =>
      parseRedeemedAgentIntegrationPairing(
        {
          ...bundle,
          credentials: {
            ...bundle.credentials,
            delivery: {
              ...bundle.credentials.delivery,
              scopes: ["subscriptions:receive", "admin"],
            },
          },
        },
        "openclaw",
      ),
    ).toThrow(/malformed pairing response/);
    expect(() => parseRedeemedAgentIntegrationPairing(bundle, "hermes")).toThrow(
      /malformed pairing response/,
    );
    expect(() =>
      parseRedeemedAgentIntegrationPairing(
        {
          ...bundle,
          credentials: {
            ...bundle.credentials,
            management: { ...bundle.credentials.management, scopes: ["answer"] },
          },
        },
        "openclaw",
      ),
    ).toThrow(/malformed pairing response/);
  });

  it("redeems an agent code with the exact versioned capability contract", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID_AGENT_INTEGRATION_PAIRING), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", request);

    await redeemAgentIntegrationPairingCode("http://127.0.0.1:7600", "PAIR-CODE", "openclaw", {
      maxConcurrentRuns: 3,
      suggestedName: "omnesis-openclaw-a1b2c3d4e5f6",
    });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7600/devices/pair");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      pairingCode: "PAIR-CODE",
      agentIntegration: { harness: "openclaw" },
      capabilities: {
        suggestedName: "omnesis-openclaw-a1b2c3d4e5f6",
        agentIntegration: {
          harness: "openclaw",
          // The range the plugin this pairing installs actually speaks. A
          // pairing that claims a version the gateway cannot meet succeeds and
          // then fails every wake, on a retry nobody is watching.
          deliveryProtocolMin: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
          deliveryProtocolMax: AGENT_INTEGRATION_PROTOCOL_VERSION,
          maxConcurrentRuns: 3,
          watchPrivacyPolicyVersion: 1,
        },
      },
    });
  });

  it("directs a name collision into an explicitly bound repair ceremony", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 409 })));
    await expect(
      redeemAgentIntegrationPairingCode("http://127.0.0.1:7600", "PAIR-CODE", "openclaw", {
        suggestedName: "omnesis-openclaw-a1b2c3d4e5f6",
      }),
    ).rejects.toThrow(/--repair-device <device-id>/);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function subArgsDef(name: string) {
  const sub = await devicesCommand.subCommands!;
  const command = (sub as Record<string, { args?: unknown }>)[name];
  const a = command.args;
  return typeof a === "function" ? await (a as () => unknown)() : await a;
}

const pairArgsDef = () => subArgsDef("pair");

describe("parsePairingScopes — the --scopes list", () => {
  it("returns the validated scopes", () => {
    expect(parsePairingScopes(" read , write:gmail ")).toEqual(["read", "write:gmail"]);
  });

  it("rejects a typo and an empty list as user errors", () => {
    expect(() => parsePairingScopes("read,bogus")).toThrow(/Invalid scope: bogus/);
    expect(() => parsePairingScopes("")).toThrow(/at least one scope/);
  });
});

describe("devices pair — the pairing request", () => {
  const pending = { pairingCode: "35168AE493", scopes: ["admin"], expiresAt: Date.now() + 60_000 };

  async function runPair(args: Record<string, string>): Promise<Record<string, unknown>> {
    const request = vi.fn().mockResolvedValue(Response.json(pending));
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const sub = (await devicesCommand.subCommands!) as Record<
        string,
        { run: (ctx: unknown) => Promise<void> }
      >;
      await sub.pair.run({ args, rawArgs: [], cmd: sub.pair });
    } finally {
      log.mockRestore();
    }
    const init = request.mock.calls[0]?.[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("omits scopes so the gateway grants the kind's canonical set", async () => {
    const body = await runPair({ kind: "cli" });
    expect(body).toEqual({ kind: "cli" });
  });

  it("carries an explicit --scopes list", async () => {
    const body = await runPair({ kind: "cli", scopes: "read" });
    expect(body).toEqual({ kind: "cli", scopes: ["read"] });
  });

  it("names an integration with --name", async () => {
    const body = await runPair({ kind: "integration", name: "Kitchen display" });
    expect(body).toEqual({ kind: "integration", name: "Kitchen display" });
  });

  // Without a terminal the name prompt has nothing to read, so the command
  // says which flag to pass instead of waiting on a prompt no one can answer.
  it("refuses an unnamed integration without a terminal, before asking the gateway", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const stdinTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const sub = (await devicesCommand.subCommands!) as Record<
        string,
        { run: (ctx: unknown) => Promise<void> }
      >;
      await expect(
        sub.pair.run({ args: { kind: "integration" }, rawArgs: [], cmd: sub.pair }),
      ).rejects.toThrow(/--name/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("asks the gateway to choose stable QR trust for a phone", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(pending))
      .mockResolvedValueOnce(
        Response.json({
          platform: "ios",
          addresses: [],
          recommendedUrl: null,
          awayFromHome: null,
        }),
      )
      .mockResolvedValueOnce(Response.json({ qrPayload: "{}" }));
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const sub = (await devicesCommand.subCommands!) as Record<
        string,
        { run: (ctx: unknown) => Promise<void> }
      >;
      await sub.pair.run({
        args: { kind: "ios", "gateway-url": "https://gateway.example.com:7600" },
        rawArgs: [],
        cmd: sub.pair,
      });
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse((request.mock.calls[1]?.[1] as { body: string }).body)).toEqual({
      pairingCode: pending.pairingCode,
    });
    const printed = lines.join("\n");
    // A phone takes the code from its QR, so it is not printed on its own.
    expect(printed).not.toContain("Pairing code:");
    expect(printed).toMatch(/Expires in \d+s/);
    expect(JSON.parse((request.mock.calls[2]?.[1] as { body: string }).body)).toEqual({
      pairingCode: pending.pairingCode,
      gatewayUrl: "https://gateway.example.com:7600",
      trustMode: "auto",
    });
  });
});

describe("devices repair for a phone", () => {
  it("prints the phone's QR for the gateway's recommended address", async () => {
    const phone = {
      id: "00000000-0000-4000-8000-000000000042",
      name: "Maya's iPhone",
      kind: "ios",
      online: false,
    };
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/admin/devices") return Response.json({ items: [phone] });
      if (path === "/admin/devices/pair") {
        expect(JSON.parse(String(init?.body))).toEqual({ kind: "ios", repairDeviceId: phone.id });
        return Response.json({
          pairingCode: "35168AE493",
          scopes: ["admin"],
          expiresAt: Date.now() + 60_000,
        });
      }
      if (path === "/admin/devices/pair-addresses") {
        return Response.json({
          platform: "ios",
          addresses: [
            {
              gatewayUrl: "https://studio.tail-example.ts.net:7600",
              host: "studio.tail-example.ts.net",
              label: "Tailscale name",
              usable: true,
              reach: "tailnet",
              systemTrust: true,
              summary: "Works at home and away, as long as Tailscale is connected on the phone.",
            },
          ],
          recommendedUrl: "https://studio.tail-example.ts.net:7600",
          awayFromHome: null,
        });
      }
      if (path === "/admin/devices/pair-qr")
        return Response.json({ qrPayload: "fictional-payload" });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const sub = (await devicesCommand.subCommands!) as Record<
        string,
        { run: (ctx: unknown) => Promise<void> }
      >;
      await sub.repair.run({ args: { target: phone.name }, rawArgs: [], cmd: sub.repair });
    } finally {
      log.mockRestore();
    }
    const qrCall = request.mock.calls.find(([url]) => url.endsWith("/admin/devices/pair-qr"));
    expect(JSON.parse(String(qrCall?.[1]?.body))).toMatchObject({
      pairingCode: "35168AE493",
      gatewayUrl: "https://studio.tail-example.ts.net:7600",
    });
    expect(lines.join("\n")).toContain("Works at home and away");
    // The phone takes the code from its QR, so it is not printed on its own.
    expect(lines.join("\n")).not.toContain("Repair code:");
    expect(lines.join("\n")).toMatch(/Expires in \d+s/);
  });
});

describe("pairing QR compatibility", () => {
  it("retries without auto only when an older gateway rejects trustMode", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "Validation failed",
            code: "VALIDATION_ERROR",
            detail: [{ path: "/trustMode", message: "Invalid option" }],
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ qrPayload: "legacy" }));
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);

    await expect(
      buildPairQrPayload("35168AE493", "https://gateway.example.com:7600"),
    ).resolves.toBe("legacy");
    expect(JSON.parse((request.mock.calls[0]?.[1] as { body: string }).body).trustMode).toBe(
      "auto",
    );
    expect(JSON.parse((request.mock.calls[1]?.[1] as { body: string }).body)).toEqual({
      pairingCode: "35168AE493",
      gatewayUrl: "https://gateway.example.com:7600",
    });
  });

  it("does not retry an unrelated validation failure", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "bad code", code: "VALIDATION_ERROR" }, { status: 400 }),
      );
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);

    await expect(
      buildPairQrPayload("35168AE493", "https://gateway.example.com:7600"),
    ).rejects.toThrow(/bad code/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("devices discover — the machine contract", () => {
  // The installer's --collector role reads these keys by name out of --json.
  const FP = `${"3a7f"}${"0".repeat(60)}`;

  it("carries the url, the name and a sha256-prefixed fingerprint", () => {
    expect(
      discoveryJson({ url: "https://198.51.100.7:7600", name: "gateway-host", fingerprint: FP }),
    ).toEqual({
      found: true,
      url: "https://198.51.100.7:7600",
      name: "gateway-host",
      fingerprint: `sha256:${FP}`,
    });
  });

  it("omits what the advertisement did not carry", () => {
    expect(discoveryJson({ url: "https://omnesis.local:7600" })).toEqual({
      found: true,
      url: "https://omnesis.local:7600",
    });
  });

  it("says so when nothing answered, rather than failing", () => {
    expect(discoveryJson(null)).toEqual({ found: false });
  });
});

describe("devices redeem — the certificate pin", () => {
  const redeemArgsDef = () => subArgsDef("redeem");

  it("surfaces --trust-fingerprint as a named flag", async () => {
    const def = await redeemArgsDef();
    const parsed = parseArgs(
      ["35168AE493", `--trust-fingerprint=sha256:${"a".repeat(64)}`],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed["trust-fingerprint"]).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("refuses a malformed pin before the code is spent", async () => {
    // A pairing code is single-use: a typo in the pin must not cost one, so
    // the shape is checked before any network call.
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const sub = (await devicesCommand.subCommands!) as Record<
      string,
      { run: (ctx: unknown) => Promise<void> }
    >;
    await expect(
      sub.redeem.run({
        args: { code: "35168AE493", "trust-fingerprint": "sha256:beef" },
        rawArgs: [],
        cmd: sub.redeem,
      }),
    ).rejects.toThrow(/not a SHA-256 certificate fingerprint/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("devices pair — named flag parsing", () => {
  it("surfaces --kind as args.kind", async () => {
    const def = await pairArgsDef();
    const parsed = parseArgs(["--kind=ios"], def as Parameters<typeof parseArgs>[1]);
    expect(parsed.kind).toBe("ios");
  });

  it("surfaces --scopes alongside --kind", async () => {
    const def = await pairArgsDef();
    const parsed = parseArgs(
      ["--kind=ios", "--scopes=admin,read"],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed.kind).toBe("ios");
    expect(parsed.scopes).toBe("admin,read");
  });

  it("surfaces an explicit agent repair target", async () => {
    const def = await pairArgsDef();
    const parsed = parseArgs(
      [
        "--repair-device=11111111-1111-4111-8111-111111111111",
        "--kind=agent",
        "--scopes=subscriptions:receive",
      ],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed["repair-device"]).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("surfaces --gateway-url for iOS QR-payload override", async () => {
    const def = await pairArgsDef();
    const parsed = parseArgs(
      ["--kind=ios", "--gateway-url=http://10.0.0.42:7600"],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed["gateway-url"]).toBe("http://10.0.0.42:7600");
  });

  // The --self-email / --self-phone flags are declared on the command
  // so they're surfaced (not dropped on the floor). At runtime citty collects
  // repeats into an array, which `collectSelfInfo` handles via `flagList`.
  it("surfaces --self-email / --self-phone", async () => {
    const def = await pairArgsDef();
    const parsed = parseArgs(
      ["--kind=cli", "--self-email=you@example.com", "--self-phone=+12025550123"],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed["self-email"]).toBe("you@example.com");
    expect(parsed["self-phone"]).toBe("+12025550123");
  });

  it("leaves self-info flags undefined when omitted (skip path)", async () => {
    const def = await pairArgsDef();
    const parsed = parseArgs(["--kind=cli"], def as Parameters<typeof parseArgs>[1]);
    expect(parsed["self-email"]).toBeUndefined();
    expect(parsed["self-phone"]).toBeUndefined();
  });
});

describe("parseSelfInfoField — self-info collection", () => {
  const validateEmail = (v: string): string | null =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? normalizeEmail(v) : null;
  const validatePhone = (v: string): string | null => normalizePhone(v);

  it("splits, trims, and normalizes a comma-separated email list", () => {
    const r = parseSelfInfoField("You@Example.COM, you@work.example.org", validateEmail);
    expect(r).toEqual({ values: ["you@example.com", "you@work.example.org"] });
  });

  it("normalizes phones to E.164", () => {
    const r = parseSelfInfoField("+1 202 555 0123", validatePhone);
    expect(r).toEqual({ values: ["+12025550123"] });
  });

  it("treats an empty / all-blank input as a skip (empty list, no error)", () => {
    expect(parseSelfInfoField("", validateEmail)).toEqual({ values: [] });
    expect(parseSelfInfoField("  ,  ", validateEmail)).toEqual({ values: [] });
  });

  it("returns the first invalid entry as an error", () => {
    expect(parseSelfInfoField("you@example.com, not-an-email", validateEmail)).toEqual({
      error: "not-an-email",
    });
    expect(parseSelfInfoField("not-a-phone", validatePhone)).toEqual({ error: "not-a-phone" });
  });

  it("dedupes after normalization", () => {
    const r = parseSelfInfoField("You@Example.com, you@example.com", validateEmail);
    expect(r).toEqual({ values: ["you@example.com"] });
  });
});

describe("defaultScopesForDeviceKind — per-device-kind default grants", () => {
  it("grants the Android device kind write scopes for every source it hosts", () => {
    expect(defaultScopesForDeviceKind("android")).toEqual([
      "admin",
      "read",
      "push:claim",
      "write:health-connect",
      "write:android-call-log",
      "write:android-app-usage",
      "write:android-activity-segments",
      "write:photos",
    ]);
  });

  it("grants the iOS device kind write scopes for every source it hosts", () => {
    expect(defaultScopesForDeviceKind("ios")).toEqual([
      "admin",
      "read",
      "push:claim",
      "write:apple-health",
      "write:activity-segments",
      "write:photos",
      "write:core-location-visits",
    ]);
  });

  // A phone-hosted source whose write scope is missing from the grant gets a
  // 403 on every push, and because the phone's offline buffer drains strictly
  // FIFO, that one source stalls every other source's batches behind it.
  // Deriving the grant from DEVICE_HOSTED_SOURCE_TYPES keeps the two aligned.
  it.each(["ios", "android", "browser"] as const)(
    "covers every source type %s hosts with a matching write scope",
    (kind) => {
      const granted = new Set(defaultScopesForDeviceKind(kind));
      for (const type of DEVICE_HOSTED_SOURCE_TYPES[kind]) {
        expect(granted.has(writeScope(type))).toBe(true);
      }
    },
  );

  it("keeps read-only kinds without a write scope", () => {
    expect(defaultScopesForDeviceKind("portal")).toEqual(["admin", "read"]);
    expect(defaultScopesForDeviceKind("cli")).toEqual(["admin", "read"]);
  });

  it("gives the CLI the read scope its own commands need", () => {
    // `admin` does not imply `read`, so a cli device without it takes a 403 on
    // /status, /search and /documents/stats -- every read route the CLI drives.
    const granted = defaultScopesForDeviceKind("cli");
    expect(scopeSatisfies(granted, SCOPE_READ)).toBe(true);
    expect(scopeSatisfies(granted, SCOPE_ADMIN)).toBe(true);
  });

  it("admin alone still does not satisfy read, for any kind", () => {
    // The guard comment used to claim it did. If this ever passes with
    // ["admin"], the fix moved into scopeSatisfies and silently widened every
    // scope.read() route for every admin-holding token.
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_READ)).toBe(false);
  });

  it("grants the collector read alongside write:* so it can fetch config", () => {
    expect(defaultScopesForDeviceKind("collector")).toEqual(["read", "write:*"]);
  });

  it("grants the browser device kind write:web only — never read/admin", () => {
    // Minimal trust: the browser extension feeds the unified `web` source, so
    // its token is scoped to `write:web` — it can contribute captured web
    // pages and nothing more.
    // No read, no admin, no write:* — exactly one scope.
    expect(defaultScopesForDeviceKind("browser")).toEqual(["write:web"]);
  });
});

describe("pairInstructionLines — per-kind redeem guidance", () => {
  const CODE = "35168AE493";
  const URL = "https://127.0.0.1:17650";
  const joined = (kind: Parameters<typeof pairInstructionLines>[0]) =>
    pairInstructionLines(kind, CODE, URL).join("\n");

  it("tells a portal to paste the code into the login screen — never `omnesis pair` or curl", () => {
    // A portal code is redeemed by the browser itself (AuthService.login only
    // consumes `kind=portal` codes into a cookie session). Showing the CLI /
    // curl redeem here is the bug this test guards against: those commands
    // don't apply and just confuse the operator.
    const out = joined("portal");
    expect(out).toMatch(/paste this code into its login screen/i);
    expect(out).not.toMatch(/omnesis pair/);
    expect(out).not.toMatch(/curl/);
  });

  it("still shows the CLI + curl fallback for a terminal (cli) device", () => {
    const out = joined("cli");
    expect(out).toContain(`omnesis pair ${CODE} --gateway-url ${URL}`);
    expect(out).toContain(`curl -X POST ${URL}/devices/pair`);
    expect(out).toContain(`"pairingCode":"${CODE}"`);
  });

  it("points the browser extension at its Options page, not a terminal command", () => {
    const out = joined("browser");
    expect(out).toMatch(/open Options/i);
    expect(out).toContain(URL);
    expect(out).not.toMatch(/curl/);
  });

  it("names the store listing and the browser-trust requirement for a browser code", () => {
    const out = joined("browser");
    expect(out).toContain(CHROME_WEB_STORE_URL);
    expect(out).toContain("browser-trusted HTTPS gateway");
    expect(joined("cli")).not.toContain(CHROME_WEB_STORE_URL);
    // A repair addresses an extension that is already installed and once trusted the gateway.
    expect(
      repairInstructionLines("browser", { name: "Maya's browser" }, CODE, URL).join("\n"),
    ).not.toContain(CHROME_WEB_STORE_URL);
  });

  it("links the same store listing the portal does", () => {
    const portal = readFileSync(
      join(import.meta.dirname, "../../../gateway/portal/js/lib/extension-links.js"),
      "utf8",
    );
    expect(portal).toContain(`"${CHROME_WEB_STORE_URL}"`);
  });

  it("directs agent codes to connect and collector codes to a saved token file", () => {
    expect(joined("agent")).toContain("omnesis connect openclaw");
    expect(joined("collector")).toContain("--save ~/.config/omnesis/collector-token");
  });

  it("opens every kind with a blank spacer line", () => {
    for (const kind of ["portal", "cli", "browser", "agent", "collector"] as const) {
      expect(pairInstructionLines(kind, CODE, URL)[0]).toBe("");
    }
  });
});

describe("devices redeem — argument parsing", () => {
  it("surfaces the positional code plus --gateway-url / --save / --json", async () => {
    const def = await subArgsDef("redeem");
    const parsed = parseArgs(
      [
        "ABCD-1234",
        "--gateway-url=https://gateway.example.com:7600",
        "--save=/tmp/device-token",
        "--json",
      ],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed.code).toBe("ABCD-1234");
    expect(parsed["gateway-url"]).toBe("https://gateway.example.com:7600");
    expect(parsed.save).toBe("/tmp/device-token");
    expect(parsed.json).toBe(true);
  });

  it("flags default to off when only the code is given", async () => {
    const def = await subArgsDef("redeem");
    const parsed = parseArgs(["ABCD-1234"], def as Parameters<typeof parseArgs>[1]);
    expect(parsed.code).toBe("ABCD-1234");
    expect(parsed["gateway-url"]).toBeUndefined();
    expect(parsed.save).toBeUndefined();
    expect(parsed.json).toBeFalsy();
  });
});

describe("omnesis pair — top-level alias of devices redeem", () => {
  it("reuses the redeem command's args and handler verbatim", async () => {
    const sub = await devicesCommand.subCommands!;
    const redeem = (sub as Record<string, { args?: unknown; run?: unknown }>).redeem;
    // The alias must be the SAME contract, not a drifting copy: a future change
    // to redeem's flags or behavior should flow through `omnesis pair` for free.
    expect(pairCommand.args).toBe(redeem.args);
    expect(pairCommand.run).toBe(redeem.run);
  });

  it("parses the positional code plus --gateway-url / --save / --json", () => {
    const parsed = parseArgs(
      ["ABCD-1234", "--gateway-url=https://gateway.example.com:7600", "--save=/tmp/tok", "--json"],
      pairCommand.args as Parameters<typeof parseArgs>[1],
    );
    expect(parsed.code).toBe("ABCD-1234");
    expect(parsed["gateway-url"]).toBe("https://gateway.example.com:7600");
    expect(parsed.save).toBe("/tmp/tok");
    expect(parsed.json).toBe(true);
  });
});

describe("repairInstructionLines — per-kind repair guidance", () => {
  const CODE = "35168AE493";
  const URL = "https://127.0.0.1:17650";
  const device = { name: "workstation-collector" };
  const joined = (kind: Parameters<typeof repairInstructionLines>[0]) =>
    repairInstructionLines(kind, device, CODE, URL).join("\n");

  it("tells an integration to redeem into the token file it reads, on the level it kept", () => {
    const out = joined("integration").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("on the access level it kept");
    expect(out).not.toMatch(/sources, memberships and cursors/i);
    expect(out).toContain(
      `omnesis devices redeem ${CODE} --gateway-url ${URL} --save ~/.config/omnesis/integration.token`,
    );
    expect(out).toContain(`"pairingCode":"${CODE}","kind":"integration"`);
    expect(out).not.toMatch(/omnesis pair /);
    expect(out).toMatch(/replace .* with an address/i);
  });

  it("says what a repair preserves, on every kind", () => {
    for (const kind of ["collector", "cli", "ios", "agent"] as const) {
      const out = joined(kind);
      expect(out).toContain(device.name);
      expect(out).toMatch(/sources, memberships and cursors/i);
    }
  });

  it("sends a collector's token to the file the collector reads, then restarts it", () => {
    const out = joined("collector");
    expect(out).toContain(`omnesis pair ${CODE} --gateway-url ${URL}`);
    expect(out).toContain("--save ~/.config/omnesis/collector-token");
    expect(out).toContain("omnesis service start collector");
  });

  it("points a phone at the app and an agent host at connect — never a token file", () => {
    expect(joined("ios")).toMatch(/manual-entry sheet|scan the QR/i);
    expect(joined("ios")).not.toMatch(/--save/);
    expect(joined("agent")).toContain("omnesis connect openclaw");
  });

  // The extension redeems from its Options page and never reads a terminal,
  // so `omnesis pair` there would burn the code for a token it cannot use.
  it("sends a browser extension to its Options page, not to a terminal", () => {
    const out = joined("browser");
    expect(out).toMatch(/open Options/i);
    expect(out).not.toMatch(/omnesis pair/);
    expect(out).not.toMatch(/curl/);
  });

  // The device being repaired is somewhere else, so a printed gateway URL is
  // only useful with the caveat that it has to be reachable from there.
  it("flags the gateway URL as one the far end has to be able to reach", () => {
    for (const kind of ["collector", "cli"] as const) {
      expect(joined(kind)).toMatch(/replace .* with an address/i);
    }
  });
});

describe("devices revoke helpers", () => {
  it("requires confirmation only when a revoke removes a corpus credential", () => {
    expect(
      deviceRevocationNeedsConfirmation({
        forget: false,
        yes: false,
        corpusCredentialCount: 1,
        corpusImpactComplete: true,
      }),
    ).toBe(true);
    expect(
      deviceRevocationNeedsConfirmation({
        forget: false,
        yes: true,
        corpusCredentialCount: 1,
        corpusImpactComplete: true,
      }),
    ).toBe(false);
    expect(
      deviceRevocationNeedsConfirmation({
        forget: false,
        yes: false,
        corpusCredentialCount: 0,
        corpusImpactComplete: true,
      }),
    ).toBe(false);
    expect(
      deviceRevocationNeedsConfirmation({
        forget: true,
        yes: false,
        corpusCredentialCount: 1,
        corpusImpactComplete: true,
      }),
    ).toBe(false);
    expect(
      deviceRevocationNeedsConfirmation({
        forget: false,
        yes: false,
        corpusCredentialCount: 0,
        corpusImpactComplete: false,
      }),
    ).toBe(true);
  });

  it("names an agent's delegated authority in the confirmation", () => {
    const impact = deviceCorpusCredentialImpact({
      kind: "agent",
      revocationImpact: {
        fingerprint: "a".repeat(64),
        corpusCredentials: [
          {
            credentialLabel: "Lab runtime",
            principalName: "Fictional assistant",
            grantName: "Reviewed research",
          },
        ],
        corpusAccess: [],
      },
    });

    const message = deviceRevocationConfirmationMessage("Lab agent", impact);
    expect(message).toContain("its sign-in on the connection Fictional assistant (Lab runtime)?");
    expect(message).not.toContain("Reviewed research");
  });

  it("pluralises sign-ins when a revoke ends several connections' access", () => {
    const message = deviceRevocationConfirmationMessage("Lab agent", {
      credentials: [
        { principalName: "Fictional assistant", grantName: "Reviewed research" },
        { principalName: "Night reviewer", grantName: "Reviewed research" },
      ],
      complete: true,
    });
    expect(message).toContain(
      "and its sign-ins on the connections Fictional assistant, Night reviewer?",
    );
  });

  it("names a connection once when its sign-in carries the connection's own name", () => {
    expect(
      deviceCorpusCredentialLabel({
        credentialLabel: "Fictional assistant",
        principalName: "Fictional assistant",
        grantName: "Fictional assistant access",
      }),
    ).toBe("Fictional assistant");
    expect(
      deviceCorpusCredentialLabel({
        principalName: "Fictional assistant",
        grantName: "Fictional assistant access",
      }),
    ).toBe("Fictional assistant");
  });

  it("never attributes delegated corpus authority to a collector", () => {
    expect(
      deviceCorpusCredentialImpact({
        kind: "collector",
        revocationImpact: {
          corpusCredentials: [
            { principalName: "Fictional assistant", grantName: "Reviewed research" },
          ],
        },
      }),
    ).toEqual({ credentials: [], complete: true });
  });

  it("fails closed when an older gateway cannot report bound credentials", () => {
    const impact = deviceCorpusCredentialImpact({
      kind: "agent",
      revocationImpact: { corpusAccess: [] },
    });
    expect(impact).toEqual({ credentials: [], complete: false });
    expect(deviceRevocationConfirmationMessage("Lab agent", impact)).toContain(
      "cannot report every connection sign-in this revoke may remove",
    );
  });

  it("removes terminal controls from stored labels before rendering them", () => {
    const message = deviceRevocationConfirmationMessage("Lab\u001b[31m\nagent", {
      credentials: [
        {
          principalName: "Fictional\u001b[31m\nassistant",
          grantName: "Reviewed\u007fresearch",
        },
      ],
      complete: true,
    });
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it("labels a device by whether its access is revoked", () => {
    expect(deviceStatusLabel({ revokedAt: null })).toBe("paired");
    expect(deviceStatusLabel({})).toBe("paired");
    expect(deviceStatusLabel({ revokedAt: 1_000 })).toBe("revoked");
  });

  // One status column, three values — the ledger's version state is a
  // separate column and this must not grow into a second one.
  it("separates a revoked device still hosting sources from a retired one", () => {
    expect(deviceStatusLabel({ revokedAt: 1_000, needsPairing: true })).toBe("needs-pairing");
    expect(deviceStatusLabel({ revokedAt: 1_000, needsPairing: false })).toBe("revoked");
    // The flag only means something on a revoked row.
    expect(deviceStatusLabel({ revokedAt: null, needsPairing: true })).toBe("paired");
  });

  // Revoking the collector that sits beside the gateway does not keep it
  // down: it re-registers from the admin token in the same config directory
  // and reclaims its own row. The command has to say so, or the operator
  // finds out by watching the device come back.
  it("warns only for the collector that shares the gateway's config directory", () => {
    const base = {
      kind: "collector" as const,
      deviceHostname: "gateway-host",
      localHostname: "gateway-host",
      hasLocalAdminToken: true,
    };
    expect(revokedCollectorReRegisters(base)).toBe(true);
    // A collector on another machine has no admin token of its own to
    // re-register with, and revoking from a laptop cannot see the gateway
    // host's config directory either — say nothing rather than guess.
    expect(revokedCollectorReRegisters({ ...base, deviceHostname: "other-host" })).toBe(false);
    expect(revokedCollectorReRegisters({ ...base, hasLocalAdminToken: false })).toBe(false);
    expect(revokedCollectorReRegisters({ ...base, deviceHostname: undefined })).toBe(false);
  });

  it("never warns for a kind that does not register itself", () => {
    for (const kind of ["cli", "ios", "android", "portal", "browser", "agent"] as const) {
      expect(
        revokedCollectorReRegisters({
          kind,
          deviceHostname: "gateway-host",
          localHostname: "gateway-host",
          hasLocalAdminToken: true,
        }),
      ).toBe(false);
    }
  });

  it("targets the revoke route by default and the forget query on --forget", () => {
    expect(deviceRevokePath("dev-1", false)).toBe("/admin/devices/dev-1");
    expect(deviceRevokePath("dev-1", true)).toBe("/admin/devices/dev-1?forget=true");
    expect(deviceRevokePath("dev-1", false, "a".repeat(64))).toBe(
      `/admin/devices/dev-1?impactFingerprint=${"a".repeat(64)}`,
    );
  });
});

describe("devices revoke — scripted summary", () => {
  async function runRevoke(device: Record<string, unknown>): Promise<{
    output: string;
    request: ReturnType<typeof vi.fn>;
  }> {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [device] }))
      .mockResolvedValueOnce(Response.json({ ok: true, revoked: true }));
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });
    try {
      const sub = (await devicesCommand.subCommands!) as Record<
        string,
        { run: (ctx: unknown) => Promise<void> }
      >;
      await sub.revoke.run({
        args: { target: device.id, yes: true },
        rawArgs: [],
        cmd: sub.revoke,
      });
    } finally {
      log.mockRestore();
    }
    expect(request).toHaveBeenCalledTimes(2);
    return { output: lines.join("\n"), request };
  }

  it.each([
    { label: "live", corpusAccess: true },
    { label: "lapsed", corpusAccess: false },
  ])("records the named credential for a $label agent revoke", async ({ corpusAccess }) => {
    const credential = {
      credentialLabel: "Lab runtime",
      principalName: "Fictional assistant",
      grantName: "Reviewed research",
    };
    const { output, request } = await runRevoke({
      id: "device-agent",
      name: "Lab agent",
      kind: "agent",
      capabilities: {},
      revocationImpact: {
        fingerprint: "a".repeat(64),
        corpusCredentials: [credential],
        corpusAccess: corpusAccess ? [credential] : [],
      },
    });

    expect(output).toContain("Connection sign-ins revoked for this device");
    expect(output).toContain("  Fictional assistant (Lab runtime)");
    expect(output).not.toContain("Reviewed research");
    expect(String(request.mock.calls[1]?.[0])).toContain(`impactFingerprint=${"a".repeat(64)}`);
  });

  it("records no corpus credential for a credential-free agent", async () => {
    const { output } = await runRevoke({
      id: "device-agent-empty",
      name: "Empty lab agent",
      kind: "agent",
      capabilities: {},
      revocationImpact: {
        fingerprint: "b".repeat(64),
        corpusCredentials: [],
        corpusAccess: [],
      },
    });
    expect(output).not.toContain("sign-ins revoked");
    expect(output).not.toContain("could not report every connection sign-in");
  });

  it("warns when a legacy gateway cannot enumerate bound credentials", async () => {
    const { output } = await runRevoke({
      id: "device-agent-legacy",
      name: "Legacy lab agent",
      kind: "agent",
      capabilities: {},
      revocationImpact: { corpusAccess: [] },
    });
    expect(output).toContain("could not report every connection sign-in");
  });

  it("removes terminal controls from stored device names in scripted output", async () => {
    const { output } = await runRevoke({
      id: "device-agent-controls",
      name: "Lab; printf forged\u001b[31m\nagent\u202e",
      kind: "agent",
      capabilities: {},
      revocationImpact: {
        fingerprint: "c".repeat(64),
        corpusCredentials: [],
        corpusAccess: [],
      },
    });
    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("\u202e");
    expect(output).toContain("Lab; printf forged [31m agent ");
    expect(output).toContain("omnesis devices repair device-agent-controls");
    expect(output).not.toContain("omnesis devices repair Lab;");
  });

  it("does not claim that a collector revokes delegated corpus authority", async () => {
    const { output } = await runRevoke({
      id: "device-collector",
      name: "Studio collector",
      kind: "collector",
      capabilities: {},
      // Even malformed response data must not change a collector's consequence.
      revocationImpact: {
        corpusCredentials: [
          { principalName: "Fictional assistant", grantName: "Reviewed research" },
        ],
        corpusAccess: [],
      },
    });

    expect(output).not.toContain("sign-ins revoked");
    expect(output).not.toContain("Fictional assistant");
    expect(output).not.toContain("Reviewed research");
  });
});

describe("devices repair — argument parsing", () => {
  it("takes the device positionally plus an optional --gateway-url", async () => {
    const def = await subArgsDef("repair");
    const parsed = parseArgs(
      ["workstation-collector", "--gateway-url=https://gw.example.com"],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed.target).toBe("workstation-collector");
    expect(parsed["gateway-url"]).toBe("https://gw.example.com");
  });
});

describe("getOrCreateInstallId", () => {
  it("mints once per config dir and returns the same value afterwards", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omnesis-install-id-"));
    try {
      const first = getOrCreateInstallId(dir);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(getOrCreateInstallId(dir)).toBe(first);
      // A fresh dir is a fresh identity.
      const other = mkdtempSync(join(tmpdir(), "omnesis-install-id-"));
      try {
        expect(getOrCreateInstallId(other)).not.toBe(first);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deviceUpdateNoticeLine", () => {
  it("names a failed update with what runs, what was asked, and the harness's own fix", () => {
    const line = deviceUpdateNoticeLine({
      version: "0.4.7",
      desiredVersion: "0.4.8",
      updateState: "failed",
      updateDetail: "Plugin refresh failed on its host",
      capabilities: { agentIntegration: { harness: "openclaw" } },
    });
    expect(line).toContain("still runs 0.4.7 instead of 0.4.8");
    expect(line).toContain("Plugin refresh failed on its host");
    expect(line).toContain("omnesis connect openclaw --refresh");
  });

  it("sends a collector to its own updater", () => {
    expect(
      deviceUpdateNoticeLine({ version: "0.4.7", desiredVersion: "0.4.8", updateState: "failed" }),
    ).toContain("omnesis update");
  });

  it("says a restart is owed and carries the detail that names the command", () => {
    const line = deviceUpdateNoticeLine({
      version: "0.4.7",
      desiredVersion: "0.4.8",
      updateState: "restart-pending",
      updateDetail: "Plugin 0.4.8 installed; restart owed: hermes gateway restart",
    });
    expect(line).toContain("runs 0.4.7 with 0.4.8 installed");
    expect(line).toContain("hermes gateway restart");
  });

  it("keeps a device-written detail from steering the terminal", () => {
    const line = deviceUpdateNoticeLine({
      version: "0.4.7",
      updateState: "failed",
      updateDetail: "bad\u001b[31mred\u0007bell",
    });
    expect(line).toContain("bad[31mredbell");
    expect(line).not.toContain("\u001b");
  });

  it("says a build that cannot take the command must be updated on its machine", () => {
    const agent = deviceUpdateNoticeLine({
      version: "0.4.7",
      desiredVersion: "0.4.9",
      updateState: "unsupported",
      updateDetail: "This build does not accept update commands.",
      capabilities: { agentIntegration: { harness: "hermes" } },
    });
    expect(agent).toContain("cannot be updated remotely");
    expect(agent).toContain("0.4.7");
    expect(agent).not.toContain("failed");
    expect(agent).toContain(
      "omnesis update, then omnesis connect hermes --refresh, then hermes gateway restart",
    );

    const collector = deviceUpdateNoticeLine({ version: "0.4.7", updateState: "unsupported" });
    expect(collector).toMatch(/Update it on that machine: omnesis update$/);
  });

  it("is silent while an update is in flight or nothing is owed", () => {
    expect(deviceUpdateNoticeLine({ version: "0.4.8", updateState: "dispatched" })).toBeNull();
    expect(deviceUpdateNoticeLine({ version: "0.4.8", updateState: "installed" })).toBeNull();
    expect(deviceUpdateNoticeLine({ version: "0.4.8", updateState: null })).toBeNull();
  });
});

describe("pairingTlsFailure", () => {
  const tlsError = (code: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(code), { code }),
    });

  // Pairing by an address the gateway's certificate does not cover (a LAN IP
  // missing from it, a host name it never named) fails the host check even
  // with the right fingerprint; "not trusted … pass --trust-fingerprint" sent
  // operators after a remedy that changes nothing.
  it("names the uncovered host when the certificate does not name the address", () => {
    const message = pairingTlsFailure(
      "https://192.0.2.44:7600",
      tlsError("ERR_TLS_CERT_ALTNAME_INVALID"),
      "pass --trust-fingerprint and retry.",
    );
    expect(message).toContain("does not name 192.0.2.44");
    expect(message).toContain("omnesis tls status");
    expect(message).not.toContain("not trusted");
    expect(message).not.toContain("--trust-fingerprint");
  });

  it("keeps the trust remedy for a certificate this machine does not trust", () => {
    expect(
      pairingTlsFailure(
        "https://gateway.example.org:7600",
        tlsError("SELF_SIGNED_CERT_IN_CHAIN"),
        "pass --trust-fingerprint and retry.",
      ),
    ).toBe(
      "TLS certificate of https://gateway.example.org:7600 is not trusted on this machine. pass --trust-fingerprint and retry.",
    );
  });
});

describe("device access levels in the list", () => {
  const levels = new Map([["level-voice", "Voice answers"]]);
  const integration = (accessLevelId: string | null) => ({ kind: "integration", accessLevelId });

  it("says nothing for the operator's own devices", () => {
    expect(deviceAccessLevelLine({ kind: "cli", accessLevelId: null }, levels)).toBeNull();
  });

  it("names the level an integration answers under", () => {
    expect(deviceAccessLevelLine(integration("level-voice"), levels)).toEqual({
      text: "answers under access level “Voice answers”",
      refused: false,
    });
  });

  it("says an integration on no level has its questions refused, and where to choose one", () => {
    const line = deviceAccessLevelLine(integration(null), levels);
    expect(line?.refused).toBe(true);
    expect(line?.text).toContain("no access level — questions refused");
    expect(line?.text).toContain("portal's Devices page");
  });

  it("says an integration on a level that cannot answer has its questions refused", () => {
    const line = deviceAccessLevelLine(integration("level-gone"), levels);
    expect(line?.refused).toBe(true);
    expect(line?.text).toContain("questions refused");
  });

  // A revoked integration answers nothing and cannot be put on a level, so
  // its line never claims it answers or asks for a level to be chosen.
  it("names only the level a revoked integration keeps for its repair", () => {
    const revoked = (accessLevelId: string | null) => ({
      ...integration(accessLevelId),
      revokedAt: 5,
    });
    expect(deviceAccessLevelLine(revoked(null), levels)).toBeNull();
    expect(deviceAccessLevelLine(revoked("level-voice"), levels)).toEqual({
      text: "a repair restores it on access level “Voice answers”",
      refused: false,
    });
    expect(deviceAccessLevelLine(revoked("level-gone"), levels)).toEqual({
      text: "its access level is no longer available",
      refused: false,
    });
  });

  it("names only the level id, without a verdict, when the levels could not be read", () => {
    expect(deviceAccessLevelLine(integration("level-voice"), null)).toEqual({
      text: "on access level level-voice",
      refused: false,
    });
  });

  it("tells an integration paired from the CLI where its access level is chosen", () => {
    const lines = pairInstructionLines(
      "integration",
      "ABCDEF1234",
      "https://gateway.example.org:7600",
    )
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(lines).toContain("omnesis devices redeem ABCDEF1234");
    expect(lines).toContain("Its questions are refused until you choose its access level");
    expect(lines).toContain("https://gateway.example.org:7600/portal/settings/devices");
  });

  it("counts a level as answering only while its Answer's policy exists", () => {
    const answer = (policyFamilyId: string) => ({
      capability: "answer",
      release: { mode: "reviewed", policyFamilyId },
    });
    expect(
      answerLevelNames({
        policyFamilies: [{ id: "policy-open" }],
        levels: [
          { id: "level-voice", name: "Voice answers", rules: [answer("policy-open")] },
          { id: "level-gone", name: "Gone policy", rules: [answer("policy-archived")] },
          {
            id: "level-raw",
            name: "Raw",
            rules: [{ capability: "answer", release: { mode: "unreviewed" } }],
          },
          { id: "level-read", name: "Reading", rules: [{ capability: "direct" }] },
        ],
      }),
    ).toEqual(
      new Map([
        ["level-voice", "Voice answers"],
        ["level-raw", "Raw"],
      ]),
    );
  });
});

describe("devices list", () => {
  const device = (accessLevelId: string | null) => ({
    id: "device-voice",
    name: "Studio voice",
    kind: "integration",
    capabilities: {},
    pairedAt: 1,
    lastSeenAt: null,
    revokedAt: null,
    online: false,
    accessLevelId,
  });

  async function runList(responses: Response[]) {
    const request = vi.fn();
    for (const response of responses) request.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });
    try {
      const sub = (await devicesCommand.subCommands!) as Record<
        string,
        { run: (ctx: unknown) => Promise<void> }
      >;
      await sub.list.run({ args: {}, rawArgs: [], cmd: sub.list });
    } finally {
      log.mockRestore();
    }
    return { output: lines.join("\n"), request };
  }

  it("reads the access levels only when an integration is on one", async () => {
    const { request, output } = await runList([Response.json({ items: [device(null)] })]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(output).toContain("no access level — questions refused");
  });

  it("names a device's level under its row", async () => {
    const { request, output } = await runList([
      Response.json({ items: [device("level-voice")] }),
      Response.json({
        policyFamilies: [],
        levels: [
          {
            id: "level-voice",
            name: "Voice answers",
            rules: [{ capability: "answer", release: { mode: "unreviewed" } }],
          },
        ],
      }),
    ]);
    expect(String(request.mock.calls[1]?.[0])).toContain("/admin/access");
    expect(output).toContain("answers under access level “Voice answers”");
  });

  it("still lists every device when the access levels cannot be read", async () => {
    const { output } = await runList([
      Response.json({ items: [device("level-voice")] }),
      new Response("unavailable", { status: 500 }),
    ]);
    expect(output).toContain("Studio voice");
    expect(output).toContain("on access level level-voice");
    expect(output).not.toContain("questions refused");
  });
});
