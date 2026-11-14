// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolveCaa: vi.fn(), cancel: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveCaa = mocks.resolveCaa;
    cancel = mocks.cancel;
  },
}));
import { caaBinding, caaObservationDigest, lookupCaa } from "./acme-caa.js";

const ACCOUNT = "https://ca.example.test/acct/7";
const signal = () => new AbortController().signal;

beforeEach(() => {
  mocks.resolveCaa.mockReset();
  mocks.cancel.mockReset();
});

test("an account-bound CAA record names this account, another, or none", () => {
  expect(caaBinding([], ACCOUNT)).toBe("unbound");
  expect(
    caaBinding(["letsencrypt.org", "letsencrypt.org; validationmethods=dns-01"], ACCOUNT),
  ).toBe("unbound");
  expect(caaBinding([`letsencrypt.org; accounturi=${ACCOUNT}`], ACCOUNT)).toBe("bound");
  expect(
    caaBinding(
      [`letsencrypt.org;validationmethods=http-01, dns-01 ; AccountURI = ${ACCOUNT}`],
      ACCOUNT,
    ),
  ).toBe("bound");
  expect(
    caaBinding([`letsencrypt.org; validationmethods=http-01; accounturi=${ACCOUNT}`], ACCOUNT),
  ).toBe("other-account");
  expect(caaBinding(["letsencrypt.org; accounturi=https://ca.example.test/acct/8"], ACCOUNT)).toBe(
    "other-account",
  );
  expect(
    caaBinding(
      ["letsencrypt.org; accounturi=https://ca.example.test/acct/8", `x; accounturi=${ACCOUNT}`],
      ACCOUNT,
    ),
  ).toBe("bound");
  expect(caaBinding(["letsencrypt.org; flag"], ACCOUNT)).toBe("unbound");
});

test("the observation digest names the records, in any order", () => {
  expect(caaObservationDigest("g.example.test", ["a", "b"])).toBe(
    caaObservationDigest("g.example.test", ["b", "a"]),
  );
  expect(caaObservationDigest("g.example.test", [])).not.toBe(
    caaObservationDigest("h.example.test", []),
  );
  expect(caaObservationDigest("g.example.test", [])).toMatch(/^[a-f0-9]{64}$/);
});

test("lookups answer the issue values, nothing for an absent record, and undefined when DNS fails", async () => {
  mocks.resolveCaa.mockResolvedValueOnce([
    { critical: 0, issue: "letsencrypt.org" },
    { critical: 0, issuewild: ";" },
    { critical: 0, iodef: "mailto:ops@example.test" },
  ]);
  expect(await lookupCaa("g.example.test", signal())).toEqual(["letsencrypt.org"]);
  for (const code of ["ENODATA", "ENOTFOUND"]) {
    mocks.resolveCaa.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    expect(await lookupCaa("g.example.test", signal())).toEqual([]);
  }
  mocks.resolveCaa.mockRejectedValueOnce(
    Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }),
  );
  expect(await lookupCaa("g.example.test", signal())).toBeUndefined();
  mocks.resolveCaa.mockRejectedValueOnce("unexpected");
  expect(await lookupCaa("g.example.test", signal())).toBeUndefined();
});

test("a lookup stops with its caller", async () => {
  const controller = new AbortController();
  mocks.resolveCaa.mockImplementationOnce(() => {
    controller.abort();
    return Promise.reject(new Error("cancelled"));
  });
  await expect(lookupCaa("g.example.test", controller.signal)).rejects.toThrow();
  expect(mocks.cancel).toHaveBeenCalledOnce();
  await expect(lookupCaa("g.example.test", controller.signal)).rejects.toThrow();
});
