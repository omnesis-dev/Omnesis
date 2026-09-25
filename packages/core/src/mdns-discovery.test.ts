// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi, beforeEach } from "vitest";

// `findOne(opts, timeout, cb)` — the mock drives `cb` (or not) to simulate
// a hit, a timeout (cb never called), or an init error.
type FindOneImpl = (opts: unknown, timeout: number, cb: (service: unknown) => void) => void;

let findOneImpl: FindOneImpl = () => {
  /* default: never call back (timeout) */
};
const destroyMock = vi.fn();
let constructThrows = false;
let constructCount = 0;

vi.mock("bonjour-service", () => ({
  // bonjour-service's class is the default export (CommonJS `export =`).
  default: class MockBonjour {
    constructor() {
      constructCount++;
      if (constructThrows) throw new Error("no multicast interface");
    }
    findOne(opts: unknown, timeout: number, cb: (service: unknown) => void) {
      findOneImpl(opts, timeout, cb);
    }
    destroy = destroyMock;
  },
}));

// Interface-enumeration probe is mocked so we can exercise the host-quirk skip
// without depending on the test host's actual syscall behavior.
let interfacesUsable = true;
vi.mock("./network-discovery.js", async (orig) => ({
  ...(await orig<typeof import("./network-discovery.js")>()),
  networkInterfacesUsable: () => interfacesUsable,
}));

import { discoverGatewayViaMdns } from "./mdns-discovery.js";

beforeEach(() => {
  findOneImpl = () => {};
  destroyMock.mockReset();
  constructThrows = false;
  constructCount = 0;
  interfacesUsable = true;
});

describe("discoverGatewayViaMdns", () => {
  test("returns {url,fingerprint,name} on a hit — prefers IPv4 and honors TXT scheme/fp", async () => {
    findOneImpl = (_opts, _timeout, cb) => {
      cb({
        addresses: ["fe80::1", "192.168.1.20"],
        host: "omnesis.local",
        name: "gateway-host",
        port: 7600,
        txt: {
          scheme: "https",
          fp: "3a7f000000000000000000000000000000000000000000000000000000000000",
          v: "1",
        },
      });
    };

    const result = await discoverGatewayViaMdns({ timeoutMs: 50 });
    expect(result).toEqual({
      url: "https://192.168.1.20:7600",
      fingerprint: "3a7f000000000000000000000000000000000000000000000000000000000000",
      name: "gateway-host",
    });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to the advertised host when no IPv4 address is present", async () => {
    findOneImpl = (_opts, _timeout, cb) => {
      cb({ addresses: [], host: "omnesis.local", port: 7600, txt: { scheme: "https" } });
    };

    const result = await discoverGatewayViaMdns({ timeoutMs: 50 });
    expect(result).toEqual({ url: "https://omnesis.local:7600" });
  });

  test("coerces Buffer-valued TXT fields to strings", async () => {
    findOneImpl = (_opts, _timeout, cb) => {
      cb({
        addresses: ["192.168.1.20"],
        port: 7600,
        txt: {
          scheme: Buffer.from("http"),
          fp: Buffer.from("C0FFEE1111111111111111111111111111111111111111111111111111111111"),
        },
      });
    };

    const result = await discoverGatewayViaMdns({ timeoutMs: 50 });
    expect(result).toEqual({
      url: "http://192.168.1.20:7600",
      fingerprint: "c0ffee1111111111111111111111111111111111111111111111111111111111",
    });
  });

  test("returns null on timeout (findOne never calls back)", async () => {
    findOneImpl = () => {
      /* simulate no advertiser on the LAN */
    };

    const result = await discoverGatewayViaMdns({ timeoutMs: 30 });
    expect(result).toBeNull();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("returns null when the Bonjour instance can't be constructed", async () => {
    constructThrows = true;

    const result = await discoverGatewayViaMdns({ timeoutMs: 30 });
    expect(result).toBeNull();
  });

  test("returns null on a hit with no port (unusable record)", async () => {
    findOneImpl = (_opts, _timeout, cb) => {
      cb({ addresses: ["192.168.1.20"], host: "omnesis.local", txt: {} });
    };

    const result = await discoverGatewayViaMdns({ timeoutMs: 50 });
    expect(result).toBeNull();
  });

  // Every field in a service record was published by whoever is on the LAN.
  // The result is printed to a terminal, offered to an operator to confirm,
  // and turned into a URL a collector dials, so each field is held to the
  // shape it is supposed to have rather than passed through.
  describe("untrusted record fields", () => {
    const hit = (service: Record<string, unknown>) => {
      findOneImpl = (_opts, _timeout, cb) => cb(service);
      return discoverGatewayViaMdns({ timeoutMs: 50 });
    };

    test("drops a name carrying terminal control sequences", async () => {
      await expect(
        hit({ addresses: ["192.168.1.20"], port: 7600, name: "\u001b[2Jgateway\u0007" }),
      ).resolves.toEqual({ url: "https://192.168.1.20:7600", name: "[2Jgateway" });
    });

    test("refuses a host that is not a hostname or an address", async () => {
      // A host carrying a path or a colon would let the record decide more of
      // the URL than the name and the port.
      await expect(hit({ host: "gateway.example.org/path", port: 7600 })).resolves.toBeNull();
      await expect(hit({ host: "host:9999", port: 7600 })).resolves.toBeNull();
      await expect(hit({ host: "", port: 7600 })).resolves.toBeNull();
    });

    test("refuses a scheme that is not http or https", async () => {
      await expect(
        hit({ host: "omnesis.local", port: 7600, txt: { scheme: "file" } }),
      ).resolves.toBeNull();
    });

    test("refuses a port outside the valid range", async () => {
      await expect(hit({ host: "omnesis.local", port: 70_000 })).resolves.toBeNull();
      await expect(hit({ host: "omnesis.local", port: 7600.5 })).resolves.toBeNull();
    });

    test("drops a fingerprint that is not a hex SHA-256", async () => {
      // Dropped rather than refused: a record with no usable fingerprint is
      // still a gateway the operator can confirm by hand.
      await expect(
        hit({ host: "omnesis.local", port: 7600, txt: { fp: "deadbeef" } }),
      ).resolves.toEqual({ url: "https://omnesis.local:7600" });
    });
  });

  test("skips discovery without constructing Bonjour when interfaces can't be enumerated", async () => {
    // On a host where os.networkInterfaces() throws, constructing Bonjour would
    // crash the process from an uncatchable multicast-dns socket callback — so
    // discovery must bail to null before touching it.
    interfacesUsable = false;
    findOneImpl = () => {
      throw new Error("findOne must never be reached");
    };
    const result = await discoverGatewayViaMdns({ timeoutMs: 50 });
    expect(result).toBeNull();
    expect(constructCount).toBe(0);
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
