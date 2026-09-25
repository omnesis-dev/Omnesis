// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addressedGatewayHosts,
  currentTlsMaterialPaths,
  partitionAddressedHosts,
} from "./addressing.js";

describe("addressedGatewayHosts", () => {
  test("takes the host of every URL, normalized and deduplicated, skipping what is not a URL", () => {
    expect(
      addressedGatewayHosts([
        "https://gw.tail.example:7600",
        "https://GW.tail.example",
        "https://[::1]:7600/portal",
        "https://192.0.2.60:7600",
        undefined,
        null,
        "",
        "not a url",
      ]),
    ).toEqual(["gw.tail.example", "::1", "192.0.2.60"]);
  });
});

describe("partitionAddressedHosts", () => {
  const input = {
    gatewayUrl: "https://localhost:7600",
    publicBaseUrl: "https://omnesis.example.com",
    trustOrigins: ["https://omnesis.example.com", "https://gw.tail.example:7600"],
  };

  test("without a trusted proxy every addressed name is the gateway's own to cover", () => {
    expect(partitionAddressedHosts({ ...input, proxyTrusted: false })).toEqual({
      required: ["localhost", "omnesis.example.com", "gw.tail.example"],
      proxied: [],
    });
  });

  test("with one, the public base URL and the pairing origins are the proxy's", () => {
    expect(partitionAddressedHosts({ ...input, proxyTrusted: true })).toEqual({
      required: ["localhost"],
      proxied: ["omnesis.example.com", "gw.tail.example"],
    });
  });

  test("a name is matched after normalization, whatever its case or port", () => {
    expect(
      partitionAddressedHosts({
        gatewayUrl: "https://Omnesis.example.com:443",
        publicBaseUrl: "https://omnesis.example.com",
        trustOrigins: ["https://OMNESIS.example.com:7600"],
        proxyTrusted: true,
      }),
    ).toEqual({ required: [], proxied: ["omnesis.example.com"] });
  });

  test("a gateway URL that names the proxied host is proxied too; nothing else is", () => {
    expect(
      partitionAddressedHosts({
        gatewayUrl: "https://omnesis.example.com",
        publicBaseUrl: "https://omnesis.example.com",
        trustOrigins: [],
        proxyTrusted: true,
      }),
    ).toEqual({ required: [], proxied: ["omnesis.example.com"] });
    expect(
      partitionAddressedHosts({
        gatewayUrl: "https://studio.local:7600",
        publicBaseUrl: undefined,
        trustOrigins: [],
        proxyTrusted: true,
      }),
    ).toEqual({ required: ["studio.local"], proxied: [] });
  });
});

describe("currentTlsMaterialPaths", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("the config directory's .env wins over what the process was started with", () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-paths-"));
    dirs.push(configDir);
    const env = { OMNESIS_TLS_CERT: "/boot/cert.pem", OMNESIS_TLS_KEY: "/boot/key.pem" };
    expect(currentTlsMaterialPaths(configDir, env)).toEqual({
      certPath: "/boot/cert.pem",
      keyPath: "/boot/key.pem",
    });
    writeFileSync(
      join(configDir, ".env"),
      'OMNESIS_TLS_CERT="/srv/tls/tailscale.crt"\nOMNESIS_TLS_KEY=/srv/tls/tailscale.key\n',
    );
    expect(currentTlsMaterialPaths(configDir, env)).toEqual({
      certPath: "/srv/tls/tailscale.crt",
      keyPath: "/srv/tls/tailscale.key",
    });
  });

  test("a key .env supplied at boot and has since dropped reads as unset; one from the real environment stands", () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-paths-"));
    dirs.push(configDir);
    writeFileSync(join(configDir, ".env"), "OMNESIS_LOG_LEVEL=info\n");
    const env = {
      OMNESIS_TLS_CERT: "/srv/tls/tailscale.crt",
      OMNESIS_TLS_KEY: "/srv/tls/tailscale.key",
    };
    expect(
      currentTlsMaterialPaths(configDir, env, new Set(["OMNESIS_TLS_CERT", "OMNESIS_TLS_KEY"])),
    ).toEqual({});
    expect(currentTlsMaterialPaths(configDir, env, new Set())).toEqual({
      certPath: "/srv/tls/tailscale.crt",
      keyPath: "/srv/tls/tailscale.key",
    });
  });

  test("nothing set anywhere means the gateway's own pair", () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-paths-"));
    dirs.push(configDir);
    expect(currentTlsMaterialPaths(configDir, {})).toEqual({});
  });
});
