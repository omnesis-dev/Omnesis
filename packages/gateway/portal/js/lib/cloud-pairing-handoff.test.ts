// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import {
  captureAccountSignIn,
  parseAccountSignIn,
  redeemPortalHandoff,
  takeAccountSignIn,
  takeHandoffNext,
  takePortalHandoff,
  // @ts-expect-error — portal JavaScript has no sibling declarations.
} from "./cloud-pairing-handoff.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
const page = (hash?: string) => ({
  location: { hash, pathname: "/portal/", search: "?view=search" },
  history: { state: { kept: true }, replaceState: vi.fn() },
});
const valid = {
  v: 1,
  requestId: "0d9f0a4e-52a5-4b63-9d0c-5f1f5f8f6a11",
  name: "Portal 1a2b3c4d",
  secret: "c".repeat(64),
  devicePublicKey: "A".repeat(91),
  identityToken: "fictional-attestation",
  proof: { type: "google", idToken: "fictional-google-token", salt: "s".repeat(43) },
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "x".repeat(43),
    y: "y".repeat(43),
    d: "d".repeat(43),
    ext: true,
    key_ops: ["sign"],
  },
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("a handed-over sign-in leaves the address bar at once and is given out exactly once", () => {
  const { location, history } = page("#account-signin=fictional-payload");
  captureAccountSignIn(location, history);
  // Path and query stay; only the fragment goes.
  expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(
    { kept: true },
    "",
    "/portal/?view=search",
  );
  expect(takeAccountSignIn()).toBe("fictional-payload");
  expect(takeAccountSignIn()).toBeNull();
  for (const hash of [undefined, "", "#section", "#other=account-signin=x", "#Account-Signin=x"]) {
    const other = page(hash);
    captureAccountSignIn(other.location, other.history);
    expect(other.history.replaceState).not.toHaveBeenCalled();
    expect(takeAccountSignIn()).toBeNull();
  }
});

test("loading the module in a browser captures the fragment before anything else runs", async () => {
  const { location, history } = page("#account-signin=captured-on-load");
  vi.stubGlobal("window", { location, history });
  vi.resetModules();
  // @ts-expect-error — portal JavaScript has no sibling declarations.
  const loaded = await import("./cloud-pairing-handoff.js");
  expect(history.replaceState).toHaveBeenCalledOnce();
  expect(loaded.takeAccountSignIn()).toBe("captured-on-load");
});

test("only a complete, well-formed sign-in is accepted, and only its known fields are kept", () => {
  expect(parseAccountSignIn(encode({ ...valid, unexpected: "dropped" }))).toEqual({
    requestId: valid.requestId,
    name: valid.name,
    secret: valid.secret,
    devicePublicKey: valid.devicePublicKey,
    identityToken: valid.identityToken,
    proof: valid.proof,
    privateKey: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43), d: "d".repeat(43) },
  });
  const key = valid.privateKey;
  for (const altered of [
    { v: 2 },
    { v: "1" },
    { requestId: "not-a-request" },
    { requestId: [valid.requestId] },
    { name: "" },
    { name: " padded " },
    { name: "n".repeat(81) },
    { name: 7 },
    { secret: "C".repeat(64) },
    { devicePublicKey: "short" },
    { identityToken: "" },
    { identityToken: "t".repeat(16_385) },
    { proof: null },
    { proof: "google" },
    { proof: {} },
    { privateKey: undefined },
    { privateKey: { ...key, kty: "RSA" } },
    { privateKey: { ...key, crv: "P-384" } },
    { privateKey: { ...key, d: undefined } },
    { privateKey: { ...key, x: "short" } },
    { privateKey: { ...key, y: 7 } },
  ])
    expect(parseAccountSignIn(encode({ ...valid, ...altered }))).toBeNull();
  for (const encoded of [
    "",
    null,
    undefined,
    7,
    "%%%",
    encode("text"),
    encode(null),
    Buffer.from("{not json").toString("base64url"),
    "A".repeat(65_537),
  ])
    expect(parseAccountSignIn(encoded)).toBeNull();
});

const CODE = "h".repeat(43);

test("a portal handoff leaves the address bar at once, and its code and next step are each given once", () => {
  const { location, history } = page(`#portal-handoff=${CODE}&next=confirm-passkey`);
  captureAccountSignIn(location, history);
  expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(
    { kept: true },
    "",
    "/portal/?view=search",
  );
  // It's no account sign-in.
  expect(takeAccountSignIn()).toBeNull();
  expect(takePortalHandoff()).toBe(CODE);
  expect(takePortalHandoff()).toBeNull();
  expect(takeHandoffNext()).toBe("confirm-passkey");
  expect(takeHandoffNext()).toBeNull();
  // Without a next step, or with one this page doesn't know, the code alone.
  for (const hash of [`#portal-handoff=${CODE}`, `#portal-handoff=${CODE}&next=delete-everything`, `#portal-handoff=${CODE}&next=confirm-passkey&x=1`]) {
    const other = page(hash);
    captureAccountSignIn(other.location, other.history);
    expect(takePortalHandoff()).toBe(CODE);
    expect(takeHandoffNext()).toBeNull();
  }
  // A code of the wrong shape is dropped, and so is its next step.
  for (const hash of ["#portal-handoff=short&next=confirm-passkey", "#portal-handoff="]) {
    const other = page(hash);
    captureAccountSignIn(other.location, other.history);
    expect(other.history.replaceState).toHaveBeenCalledOnce();
    expect(takePortalHandoff()).toBeNull();
    expect(takeHandoffNext()).toBeNull();
  }
  expect(takePortalHandoff()).toBeNull();
});

test("redeeming a handoff posts only its code and says whether it worked, never throwing", async () => {
  const request = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  expect(await redeemPortalHandoff(CODE, request)).toBe(true);
  expect(request).toHaveBeenCalledExactlyOnceWith("/portal/api/handoff/redeem", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: CODE }),
  });
  expect(await redeemPortalHandoff(CODE, vi.fn().mockResolvedValue(new Response("{}", { status: 401 })))).toBe(false);
  expect(await redeemPortalHandoff(CODE, vi.fn().mockRejectedValue(new Error("offline")))).toBe(false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  expect(await redeemPortalHandoff(CODE)).toBe(true);
});
