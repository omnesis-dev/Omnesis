// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock multicast-dns so the advertiser never touches a real socket. The mock
// captures respond/destroy calls and the constructor opts (interface bind).
const respondMock = vi.fn((_res: unknown, cb?: () => void) => cb?.());
const destroyMock = vi.fn((cb?: () => void) => cb?.());
const onMock = vi.fn();
let constructOpts: unknown;
let constructed = 0;

vi.mock("multicast-dns", () => ({
  default: (opts?: unknown) => {
    constructOpts = opts;
    constructed += 1;
    return { respond: respondMock, destroy: destroyMock, on: onMock };
  },
}));

// realLanIpv4s + networkInterfacesUsable are mocked per-test so we control the
// host's advertised addresses and the interface-enumeration probe without
// depending on the test host's actual interfaces.
const realLanIpv4sMock = vi.fn<() => string[]>(() => ["192.168.1.50"]);
const networkInterfacesUsableMock = vi.fn<() => boolean>(() => true);
vi.mock("@omnesis/core", async (orig) => ({
  ...(await orig<typeof import("@omnesis/core")>()),
  realLanIpv4s: () => realLanIpv4sMock(),
  networkInterfacesUsable: () => networkInterfacesUsableMock(),
}));

import { MdnsAdvertiser, type BonjourRegistration } from "./mdns-advertiser.js";

const FP = "ab".repeat(32);
const OPTS = {
  port: 7600,
  hostname: "omnesis.local",
  serviceName: "test-host",
  fingerprintSha256: FP,
};

beforeEach(() => {
  respondMock.mockClear();
  destroyMock.mockClear();
  onMock.mockClear();
  constructOpts = undefined;
  constructed = 0;
  realLanIpv4sMock.mockReset().mockReturnValue(["192.168.1.50"]);
  networkInterfacesUsableMock.mockReset().mockReturnValue(true);
});

/** Pull the flat answer record list out of the first respond() call. */
function advertisedAnswers(): Array<{ name: string; type: string; ttl?: number; data?: unknown }> {
  const call = respondMock.mock.calls[0]?.[0] as { answers: unknown[] } | undefined;
  return (call?.answers ?? []) as Array<{ name: string; type: string; data?: unknown }>;
}

/** An advertiser that publishes with its own multicast responder. */
function multicastAdvertiser(): MdnsAdvertiser {
  return new MdnsAdvertiser({ platform: "linux" });
}

describe("MdnsAdvertiser with its own multicast responder", () => {
  test("setFingerprint re-announces the same records with the rotated fingerprint, and is inert before start", () => {
    const adv = multicastAdvertiser();
    adv.setFingerprint("cd".repeat(32));
    expect(respondMock).not.toHaveBeenCalled();

    adv.start(OPTS);
    const before = advertisedAnswers();
    respondMock.mockClear();
    adv.setFingerprint("cd".repeat(32));
    expect(respondMock).toHaveBeenCalledTimes(1);
    const after = advertisedAnswers();
    expect(after.find((a) => a.type === "TXT")?.data).toEqual([
      "v=1",
      "scheme=https",
      `fp=${"cd".repeat(32)}`,
    ]);
    expect(after.filter((a) => a.type !== "TXT")).toEqual(before.filter((a) => a.type !== "TXT"));
  });

  test("advertises PTR/SRV/TXT plus an A record for the real LAN IP only", () => {
    realLanIpv4sMock.mockReturnValue(["192.168.1.50"]); // NOT 172.17.0.1 (docker)
    const adv = multicastAdvertiser();
    adv.start(OPTS);

    const answers = advertisedAnswers();
    const byType = (t: string) => answers.filter((a) => a.type === t);

    expect(byType("PTR")[0]).toMatchObject({
      name: "_omnesis._tcp.local",
      data: "test-host._omnesis._tcp.local",
    });
    expect(byType("SRV")[0]).toMatchObject({
      name: "test-host._omnesis._tcp.local",
      data: { port: 7600, target: "omnesis.local" },
    });
    expect(byType("TXT")[0]?.data).toEqual(["v=1", "scheme=https", `fp=${FP}`]);

    // Exactly one A record, for the real LAN IP, named omnesis.local.
    const aRecords = byType("A");
    expect(aRecords).toHaveLength(1);
    expect(aRecords[0]).toMatchObject({ name: "omnesis.local", data: "192.168.1.50" });

    // Bound the responder to the real LAN interface.
    expect(constructOpts).toEqual({ interface: "192.168.1.50", bind: "0.0.0.0" });
  });

  test("advertises an A record per real LAN IP on a multi-homed host", () => {
    realLanIpv4sMock.mockReturnValue(["192.168.1.50", "10.0.0.9"]);
    const adv = multicastAdvertiser();
    adv.start(OPTS);
    const aRecords = advertisedAnswers().filter((a) => a.type === "A");
    expect(aRecords.map((a) => a.data)).toEqual(["192.168.1.50", "10.0.0.9"]);
  });

  test("with no real LAN IP: advertises the service but no host A record (no crash)", () => {
    realLanIpv4sMock.mockReturnValue([]);
    const adv = multicastAdvertiser();
    adv.start(OPTS);
    const answers = advertisedAnswers();
    expect(answers.filter((a) => a.type === "A")).toHaveLength(0);
    expect(answers.some((a) => a.type === "SRV")).toBe(true); // service still advertised
    expect(constructOpts).toBeUndefined(); // no interface bind when no LAN IP
  });

  test("advertisedHost names the .local host only while it is published with a LAN address", async () => {
    const adv = multicastAdvertiser();
    expect(adv.advertisedHost()).toBeNull();
    adv.start(OPTS);
    expect(adv.advertisedHost()).toBe("omnesis.local");
    await adv.stop();
    expect(adv.advertisedHost()).toBeNull();

    realLanIpv4sMock.mockReturnValue([]);
    const withoutLan = multicastAdvertiser();
    withoutLan.start(OPTS);
    expect(withoutLan.advertisedHost()).toBeNull();
  });

  test("advertisedHost is null once the responder fails", () => {
    const adv = multicastAdvertiser();
    adv.start(OPTS);
    const onError = onMock.mock.calls.find(([event]) => event === "error")?.[1] as (
      err: Error,
    ) => void;
    onError(new Error("bind EADDRINUSE 192.168.1.50:5353"));
    expect(adv.advertisedHost()).toBeNull();
  });

  test("stop() sends a goodbye (ttl 0) then destroys", async () => {
    const adv = multicastAdvertiser();
    adv.start(OPTS);
    respondMock.mockClear();
    await adv.stop();
    const goodbye = respondMock.mock.calls[0]?.[0] as { answers: Array<{ ttl?: number }> };
    expect(goodbye.answers.every((a) => a.ttl === 0)).toBe(true);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("a socket error after start (a refused bind) disables advertising instead of crashing", async () => {
    const adv = multicastAdvertiser();
    adv.start(OPTS);

    // The responder reports a refused bind asynchronously, as an `error` event.
    const onError = onMock.mock.calls.find(([event]) => event === "error")?.[1] as
      | ((err: Error) => void)
      | undefined;
    expect(onError).toBeTypeOf("function");
    expect(() => onError?.(new Error("bind EADDRINUSE 192.168.1.50:5353"))).not.toThrow();
    expect(destroyMock).toHaveBeenCalledTimes(1);

    // Inert afterwards: nothing is re-announced, and stop() has nothing to release.
    respondMock.mockClear();
    adv.setFingerprint("cd".repeat(32));
    expect(respondMock).not.toHaveBeenCalled();
    await adv.stop();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("a construct/multicast failure is swallowed (start does not throw)", () => {
    realLanIpv4sMock.mockImplementation(() => {
      throw new Error("no interfaces");
    });
    const adv = multicastAdvertiser();
    expect(() => adv.start(OPTS)).not.toThrow();
  });

  test("skips mDNS entirely when the host cannot enumerate interfaces (no responder started)", () => {
    // On a host where os.networkInterfaces() throws, starting multicast-dns
    // would crash the process from an async socket callback we can't catch, so
    // the advertiser must not start it at all.
    networkInterfacesUsableMock.mockReturnValue(false);
    const adv = multicastAdvertiser();
    expect(() => adv.start(OPTS)).not.toThrow();
    // No responder constructed, nothing advertised.
    expect(constructOpts).toBeUndefined();
    expect(respondMock).not.toHaveBeenCalled();
    // realLanIpv4s is never reached — we bail before touching interfaces.
    expect(realLanIpv4sMock).not.toHaveBeenCalled();
  });
});

class FakeRegistration extends EventEmitter implements BonjourRegistration {
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    setImmediate(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  });
}

/** An advertiser on macOS whose `dns-sd` registrations are recorded, not run. */
function bonjourAdvertiser(available = true) {
  const registrations: Array<{ args: string[]; process: FakeRegistration }> = [];
  const adv = new MdnsAdvertiser({
    platform: "darwin",
    bonjourAvailable: () => available,
    spawnRegistration: (args) => {
      const process = new FakeRegistration();
      registrations.push({ args, process });
      return process;
    },
  });
  return { adv, registrations };
}

describe("MdnsAdvertiser on macOS (system Bonjour responder)", () => {
  test("registers the service, host address and fingerprint with dns-sd -P and opens no socket", () => {
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);

    expect(registrations.map((r) => r.args)).toEqual([
      [
        "-P",
        "test-host",
        "_omnesis._tcp",
        "local",
        "7600",
        "omnesis.local",
        "192.168.1.50",
        "v=1",
        "scheme=https",
        `fp=${FP}`,
      ],
    ]);
    expect(constructed).toBe(0);
    expect(respondMock).not.toHaveBeenCalled();
  });

  test("advertisedHost follows the dns-sd registration", () => {
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);
    expect(adv.advertisedHost()).toBe("omnesis.local");
    registrations[0]?.process.emit("exit", 1, null);
    expect(adv.advertisedHost()).toBeNull();
  });

  test("publishes the first real LAN IPv4 on a multi-homed host", () => {
    realLanIpv4sMock.mockReturnValue(["192.168.1.50", "10.0.0.9"]);
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);
    expect(registrations[0]?.args.slice(5, 7)).toEqual(["omnesis.local", "192.168.1.50"]);
  });

  test("without a real LAN IPv4, registers the service alone with dns-sd -R", () => {
    realLanIpv4sMock.mockReturnValue([]);
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);
    expect(registrations[0]?.args).toEqual([
      "-R",
      "test-host",
      "_omnesis._tcp",
      "local",
      "7600",
      "v=1",
      "scheme=https",
      `fp=${FP}`,
    ]);
  });

  test("setFingerprint replaces the registration with the rotated fingerprint", async () => {
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);
    adv.setFingerprint("cd".repeat(32));

    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(registrations[1]?.args.at(-1)).toBe(`fp=${"cd".repeat(32)}`);

    // The replaced process exiting does not disable the new registration.
    await new Promise((resolve) => setImmediate(resolve));
    adv.setFingerprint("ef".repeat(32));
    expect(registrations).toHaveLength(3);
  });

  test("stop() ends the dns-sd process and resolves", async () => {
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);
    await adv.stop();
    expect(registrations[0]?.process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("a registration that fails or exits on its own disables advertising without throwing", async () => {
    const { adv, registrations } = bonjourAdvertiser();
    adv.start(OPTS);
    expect(() => registrations[0]?.process.emit("exit", 1, null)).not.toThrow();

    adv.setFingerprint("cd".repeat(32));
    expect(registrations).toHaveLength(1);
    await expect(adv.stop()).resolves.toBeUndefined();

    const second = bonjourAdvertiser();
    second.adv.start(OPTS);
    expect(() =>
      second.registrations[0]?.process.emit("error", new Error("spawn ENOENT")),
    ).not.toThrow();
    second.adv.setFingerprint("cd".repeat(32));
    expect(second.registrations).toHaveLength(1);
  });

  test("falls back to its own multicast responder when dns-sd is not installed", () => {
    const { adv, registrations } = bonjourAdvertiser(false);
    adv.start(OPTS);
    expect(registrations).toHaveLength(0);
    expect(constructed).toBe(1);
    expect(constructOpts).toEqual({ interface: "192.168.1.50", bind: "0.0.0.0" });
  });
});
