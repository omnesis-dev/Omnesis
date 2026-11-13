// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { isDefaultGatewayTrustExempt, bootstrapCliGatewayTransport } from "./trust-preflight.js";

describe("default gateway trust preflight", () => {
  it("lets connect establish trust against its selected target instead", () => {
    expect(
      isDefaultGatewayTrustExempt([
        "connect",
        "openclaw",
        "--gateway-url",
        "https://gateway.example.org:7600",
      ]),
    ).toBe(true);
  });

  it("lets model catalog answer from the bundled catalog with no gateway", () => {
    expect(isDefaultGatewayTrustExempt(["model", "catalog", "--role", "embed"])).toBe(true);
  });

  it("lets a redeem trust the gateway it names rather than the default one", () => {
    // A collector host has nothing at the default URL, and what it does have
    // there is not the gateway being paired with either way.
    expect(
      isDefaultGatewayTrustExempt([
        "pair",
        "35168AE493",
        "--gateway-url",
        "https://gateway.example.org:7600",
      ]),
    ).toBe(true);
    expect(isDefaultGatewayTrustExempt(["devices", "redeem", "35168AE493"])).toBe(true);
  });

  it("lets LAN discovery run without dialling a gateway first", () => {
    expect(isDefaultGatewayTrustExempt(["devices", "discover", "--json"])).toBe(true);
    // Every other `devices` subcommand still talks to the default gateway.
    expect(isDefaultGatewayTrustExempt(["devices", "list"])).toBe(false);
  });

  it("lets the tls commands that mint or replace trust run before the preflight, and no other", () => {
    expect(isDefaultGatewayTrustExempt(["tls"])).toBe(true);
    expect(isDefaultGatewayTrustExempt(["tls", "--mkcert"])).toBe(true);
    expect(isDefaultGatewayTrustExempt(["tls", "provision", "--force"])).toBe(true);
    expect(isDefaultGatewayTrustExempt(["tls", "refresh"])).toBe(true);
    expect(isDefaultGatewayTrustExempt(["tls", "trust", "--fingerprint", "ab"])).toBe(true);
    // These read from or act on the running gateway, so they trust it first.
    expect(isDefaultGatewayTrustExempt(["tls", "status"])).toBe(false);
    expect(isDefaultGatewayTrustExempt(["tls", "renew", "--force"])).toBe(false);
    expect(isDefaultGatewayTrustExempt(["tls", "reload"])).toBe(false);
  });

  it("keeps ordinary gateway commands on the default preflight", () => {
    expect(isDefaultGatewayTrustExempt(["search", "project notes"])).toBe(false);
    expect(isDefaultGatewayTrustExempt(["answer", "What changed?"])).toBe(false);
    expect(isDefaultGatewayTrustExempt(["model", "list"])).toBe(false);
    expect(isDefaultGatewayTrustExempt(["model"])).toBe(false);
  });

  it("does not require the deliberately restarting gateway before the portal runner starts", () => {
    expect(
      isDefaultGatewayTrustExempt([
        "_portal-fleet-update-run",
        "--operation-id=7d444840-9dc0-11d1-b245-5ffdce74fad2",
        "--config-dir=/srv/omnesis",
      ]),
    ).toBe(true);
  });
});

it("broken saved cloud transport cannot block offline maintenance or explicit new gateway pairing", async () => {
  const broken = vi.fn().mockRejectedValue(new Error("saved device pin is invalid"));
  for (const args of [
    [],
    ["service", "status"],
    ["gateway"],
    ["uninstall"],
    ["update"],
    ["restore"],
    ["keyring"],
    ["secure"],
    ["agent"],
    ["connect", "--gateway-url", "https://new.example"],
    ["pair", "SYNTHETIC"],
    ["devices", "redeem", "SYNTHETIC"],
    ["devices", "discover"],
    ["tls"],
    ["tls", "trust"],
    ["tls", "provision"],
    ["tls", "refresh"],
    ["cloud", "pair"],
    ["cloud", "login"],
    ["cloud", "register-key"],
    ["--version"],
    ["-V"],
    ["--help"],
    ["status", "--help"],
    ["help"],
  ])
    await bootstrapCliGatewayTransport(args, broken);
  expect(broken).not.toHaveBeenCalled();
  for (const args of [
    ["search", "help"],
    ["search", "--", "--help"],
    ["status"],
    ["doctor"],
    ["cloud", "requests"],
    ["devices", "list"],
    ["collector"],
  ])
    await expect(bootstrapCliGatewayTransport(args, broken)).rejects.toThrow("saved device pin");
  expect(broken).toHaveBeenCalledTimes(7);
});

it("offline recovery operations do not bootstrap a broken or unavailable gateway transport", async () => {
  const start = vi.fn(async () => {
    throw new Error("gateway unavailable");
  });
  for (const operation of [
    "recovery-create-authority",
    "recovery-sign-receipt",
    "recovery-sign-policy",
    "recovery-policy-digest",
    "recovery-rotate-session-key",
    "recovery-request",
  ]) {
    expect(isDefaultGatewayTrustExempt(["cloud", operation])).toBe(true);
    await bootstrapCliGatewayTransport(["cloud", operation], start);
  }
  expect(start).not.toHaveBeenCalled();
});
