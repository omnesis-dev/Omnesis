// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { GatewayDirectory } from "./gateway-directory.js";
import { RelayError } from "./tunnels.js";
import type { GatewayBinding } from "./gateway-binding.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const binding = (value: number): GatewayBinding => ({
  gatewayId: id(value),
  publicOrigin: `https://g-${value}.example.test`,
  certificate: "fixture-public-certificate",
  identityToken: "fixture-public-identity",
});
const query = (value = "") => new URLSearchParams(value);

test("directory selects only the signed-in account's gateway and refuses ambiguous legacy requests", () => {
  const directory = new GatewayDirectory({
    accounts: (identity) => (identity === "google" ? ["2", "1"] : []),
    binding: (owner) => binding(Number(owner)),
    name: (owner) => (owner === "1" ? "Fictional home" : undefined),
  });
  expect(directory.list("google", query())).toEqual({
    gateways: [
      { gatewayId: id(1), publicOrigin: binding(1).publicOrigin, displayName: "Fictional home" },
      { gatewayId: id(2), publicOrigin: binding(2).publicOrigin },
    ],
  });
  expect(() => directory.select("google", query())).toThrow("Select a gateway");
  expect(directory.select("google", query(`gatewayId=${id(2)}`))).toEqual(binding(2));
  expect(() => directory.select("other", query(`gatewayId=${id(2)}`))).toThrow("not registered");
  expect(() => directory.select("google", query(`gatewayId=${id(3)}`))).toThrow("not registered");
  expect(() => directory.select("other", query())).toThrow("not registered");
  expect(directory.list("other", query())).toEqual({ gateways: [] });
  expect(directory.choices("google")).toHaveLength(2);
});

test("pagination is bounded, stable and refuses stale or malformed cursors and selectors", () => {
  const directory = new GatewayDirectory({
    accounts: () => Array.from({ length: 51 }, (_, n) => String(n + 1)),
    binding: (owner) => binding(Number(owner)),
    name: () => undefined,
  });
  const first = directory.list("google", query());
  expect(first.gateways).toHaveLength(50);
  expect(first.nextCursor).toBe(id(50));
  expect(directory.list("google", query(`after=${first.nextCursor}`))).toEqual({
    gateways: [{ gatewayId: id(51), publicOrigin: binding(51).publicOrigin }],
  });
  expect(directory.list("google", query(`after=${id(51)}`))).toEqual({ gateways: [] });
  expect(() => directory.list("google", query(`after=${id(52)}`))).toThrow("changed");
  for (const invalid of ["after=bad", "after=", `after=${id(1)}&after=${id(2)}`, "unknown=1"])
    expect(() => directory.list("google", query(invalid))).toThrow();
  for (const invalid of [
    "gatewayId=bad",
    "gatewayId=",
    `gatewayId=${id(1)}&gatewayId=${id(2)}`,
    "unknown=1",
  ])
    expect(() => directory.select("google", query(invalid))).toThrow();
});

test("revoked or absent entries do not hide a healthy gateway while internal failures remain visible", () => {
  const directory = new GatewayDirectory({
    accounts: () => ["revoked", "missing", "healthy"],
    binding: (owner) => {
      if (owner === "revoked") throw new RelayError(403, "Revoked fixture");
      return owner === "healthy" ? binding(1) : undefined;
    },
    name: () => undefined,
  });
  expect(directory.select("google", query())).toEqual(binding(1));
  for (const error of [new Error("database unavailable"), new RelayError(503, "unavailable")]) {
    const failed = new GatewayDirectory({
      accounts: () => ["owner"],
      binding: () => {
        throw error;
      },
      name: () => undefined,
    });
    expect(() => failed.list("google", query())).toThrow(error);
  }
});

test("hosted selection bounds the rendered directory", () => {
  const directory = new GatewayDirectory({
    accounts: () => Array.from({ length: 1001 }, (_, n) => String(n + 1)),
    binding: (owner) => binding(Number(owner)),
    name: () => undefined,
  });
  expect(() => directory.choices("google")).toThrow("Too many gateways");
});
