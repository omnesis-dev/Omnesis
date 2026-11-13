// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { createServer } from "node:https";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles, listen, closeServer, malformedDateCertificate } from "../test/support.js";
import { pairGoogleDevice, pinnedGatewayJson } from "./google-device-pairing.js";
import { accountId } from "./identity.js";
import { gatewayBindingSchema, certificateFingerprint } from "./gateway-binding.js";
import { googlePairingNonce } from "./google-pairing.js";
import { pairingCodeCommitment, pairingComparisonCode } from "./device-enrollment.js";
import * as desktop from "./google-desktop.js";
import * as network from "./network.js";
import type { authorizeGoogleDesktop } from "./google-desktop.js";

const vectors = JSON.parse(
  await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
);
const candidate = gatewayBindingSchema.parse(vectors.gateway);
/** The stand-in gateway's nonce, and the challenge that commits to it. */
const CODE_NONCE = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk";
const OTHER_CODE_NONCE = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY";
const CHALLENGE = pairingCodeCommitment(CODE_NONCE);
const identity = {
  issuer: "https://accounts.google.com",
  subject: "fictional-owner",
  expiresAt: 4_000_000_000,
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-google-device-"));
  vi.useFakeTimers({ toFake: ["Date"], now: vectors.clock * 1000 });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});
function setup(variant = "success") {
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => ({
    identity,
    idToken: "fictional-id-token",
  }));
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith("/login")
      ? Response.json({
          token: "relay-session",
          accountId: accountId(identity),
          expiresAt: 4_000_000_000,
        })
      : variant === "no-gateway"
        ? new Response(null, { status: 404 })
        : Response.json(
            variant === "unsafe-route"
              ? { ...candidate, publicOrigin: "http://gateway.example.test" }
              : candidate,
          ),
  );
  let fields: { requestId: string; secret: string; kind: "cli"; name: string };
  let polls = 0;
  const gatewayJson = vi.fn<typeof pinnedGatewayJson>(async (binding, path, input) => {
    expect(binding).toEqual(candidate);
    if (path === "/devices/direct-candidates") return { version: 1, candidates: [] };
    if (path === "/devices/google/challenge") {
      expect(input).toEqual({});
      return { challenge: CHALLENGE, expiresAt: Date.now() + 120_000 };
    }
    if (path === "/devices/google/request") {
      fields = input as typeof fields;
      // The request answers the challenge it was given before the secret left this device.
      expect(input).toMatchObject({ challenge: CHALLENGE });
      expect(authorize.mock.calls[0]![0].nonce).toBe(googlePairingNonce(fields));
      expect(input).toMatchObject({ identityToken: "fictional-id-token" });
    } else if (path === "/devices/google/poll") {
      polls++;
      expect(input).toEqual({ requestId: fields.requestId, secret: fields.secret });
    } else
      return {
        token: "gateway-device-token",
        device: {
          id: "00000000-0000-4000-8000-000000000001",
          kind: variant === "wrong-kind" ? "collector" : "cli",
        },
        scopes: ["admin"],
      };
    const codeNonce =
      variant === "broken-commitment" || (variant === "changed-nonce" && polls)
        ? OTHER_CODE_NONCE
        : CODE_NONCE;
    const code = pairingComparisonCode({
      ...fields!,
      gatewayFingerprint: certificateFingerprint(candidate.certificate),
      codeNonce,
    });
    const status =
      variant === "denied"
        ? "denied"
        : polls || variant === "immediate-approval"
          ? "approved"
          : "pending";
    return {
      status,
      // A substituted code differs in its last digit, whatever this run's code is.
      verificationCode:
        variant === "substituted-code"
          ? code.replace(/.$/, (digit) => String((Number(digit) + 1) % 10))
          : code,
      codeNonce,
      expiresAt: variant === "expired" ? 1 : Date.now() + 10_000,
      ...(status === "approved" && variant !== "missing-code"
        ? { pairingCode: "OWNER-APPROVED-CODE" }
        : {}),
    };
  });
  const confirm = vi.fn<Parameters<typeof pairGoogleDevice>[0]["confirm"]>(
    async () => variant !== "cancel",
  );
  const wait = vi.fn(async () => undefined);
  const options = {
    relayUrl: "https://relay.example.test",
    sessionFile: join(dir, "session.json"),
    clientId: "fictional-desktop-client",
    kind: "cli" as const,
    name: " Fictional workstation ",
    confirm,
  };
  return {
    options,
    dependencies: { authorize, fetch, gatewayJson, wait },
    confirm,
    gatewayJson,
    wait,
  };
}

test("Google discovery establishes no credential until independent local comparison and owner approval", async () => {
  const f = setup();
  f.confirm.mockImplementation(async () => {
    expect(f.gatewayJson.mock.calls.map((c) => c[1])).toEqual([
      "/devices/google/challenge",
      "/devices/google/request",
    ]);
    return true;
  });
  const result = await pairGoogleDevice(f.options, f.dependencies);
  expect(f.confirm).toHaveBeenCalledExactlyOnceWith(
    {
      gatewayUrl: candidate.publicOrigin,
      verificationCode: expect.stringMatching(/^[0-9]{3} [0-9]{3}$/),
    },
    expect.any(AbortSignal),
  );
  expect(f.wait).toHaveBeenCalledTimes(1);
  expect(f.gatewayJson.mock.calls.map((c) => c[1])).toEqual([
    "/devices/google/challenge",
    "/devices/google/request",
    "/devices/google/poll",
    "/devices/pair",
    "/devices/direct-candidates",
  ]);
  expect(f.gatewayJson.mock.calls[3]![2]).toMatchObject({
    pairingCode: "OWNER-APPROVED-CODE",
    capabilities: { tls: { mode: "pinned-key-strict" }, suggestedName: "Fictional workstation" },
  });
  expect(result).toMatchObject({
    token: "gateway-device-token",
    kind: "cli",
    gatewayFingerprint: vectors.fingerprint,
    gatewayCertificate: candidate.certificate,
  });
  // An historical Google proof is unnecessary: local SAS confirmation is the trust anchor.
  expect(candidate.identityToken).toEqual(expect.any(String));
});

test("an immediate remote approval still requires explicit comparison before pairing", async () => {
  const f = setup("immediate-approval");
  const result = await pairGoogleDevice(f.options, f.dependencies);
  expect(result.token).toBe("gateway-device-token");
  expect(f.confirm).toHaveBeenCalledTimes(1);
  expect(f.wait).not.toHaveBeenCalled();
});

test.each([
  "cancel",
  "denied",
  "expired",
  "substituted-code",
  "broken-commitment",
  "changed-nonce",
  "missing-code",
  "wrong-kind",
  "no-gateway",
  "unsafe-route",
])("fails closed for %s", async (variant) => {
  const f = setup(variant);
  await expect(pairGoogleDevice(f.options, f.dependencies)).rejects.toThrow();
  if (!["wrong-kind"].includes(variant))
    expect(f.gatewayJson.mock.calls.map((c) => c[1])).not.toContain("/devices/pair");
  if (
    [
      "denied",
      "expired",
      "substituted-code",
      "broken-commitment",
      "no-gateway",
      "unsafe-route",
    ].includes(variant)
  )
    expect(f.confirm).not.toHaveBeenCalled();
});

test("a gateway that reveals a nonce it did not commit to is refused before any code is shown", async () => {
  // A substitute gateway that waits for this device's secret and only then picks a nonce giving
  // the code it wants has to break the commitment it sent first.
  const broken = setup("broken-commitment");
  await expect(pairGoogleDevice(broken.options, broken.dependencies)).rejects.toThrow(
    "did not keep its comparison code commitment",
  );
  expect(broken.confirm).not.toHaveBeenCalled();
  // The same holds for a nonce swapped after the person has compared.
  const changed = setup("changed-nonce");
  await expect(pairGoogleDevice(changed.options, changed.dependencies)).rejects.toThrow(
    "did not keep its comparison code commitment",
  );
  expect(changed.confirm).toHaveBeenCalledTimes(1);
  // A reply that keeps the commitment but states another code is refused as well.
  const substituted = setup("substituted-code");
  await expect(pairGoogleDevice(substituted.options, substituted.dependencies)).rejects.toThrow(
    "comparison code changed",
  );
  for (const f of [broken, changed, substituted])
    expect(f.gatewayJson.mock.calls.map((c) => c[1])).not.toContain("/devices/pair");
});

test("cancellation never redeems an approved code", async () => {
  const f = setup("immediate-approval");
  const abort = new AbortController();
  f.confirm.mockImplementation(async () => {
    abort.abort(new Error("Cancelled"));
    return true;
  });
  await expect(
    pairGoogleDevice({ ...f.options, signal: abort.signal }, f.dependencies),
  ).rejects.toThrow("Cancelled");
  expect(f.gatewayJson.mock.calls.map((c) => c[1])).not.toContain("/devices/pair");
  await expect(
    pairGoogleDevice({ ...f.options, signal: abort.signal }, f.dependencies),
  ).rejects.toThrow("Cancelled");
});

test("a cancelled relay login cannot overwrite a replacement pairing's routing session", async () => {
  const f = setup();
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let loginSignal!: AbortSignal;
  f.dependencies.fetch.mockImplementationOnce(async (_url, init) => {
    loginSignal = init!.signal!;
    entered();
    return delayed;
  });
  const cancelled = pairGoogleDevice({ ...f.options, signal: abort.signal }, f.dependencies);
  const outcome = cancelled.catch((error: unknown) => error);
  await started;
  abort.abort(new Error("Cancelled relay login"));
  expect(loginSignal.aborted).toBe(true);
  const replacementPairing = setup();
  await pairGoogleDevice(replacementPairing.options, replacementPairing.dependencies);
  const replacement = await readFile(f.options.sessionFile, "utf8");
  finish(
    Response.json({
      token: "stale-test-token",
      accountId: accountId(identity),
      expiresAt: 4_000_000_000,
    }),
  );
  expect(await outcome).toMatchObject({ message: "Cancelled relay login" });
  expect(await readFile(f.options.sessionFile, "utf8")).toBe(replacement);
  expect(f.dependencies.fetch).toHaveBeenCalledTimes(1);
  expect(f.confirm).not.toHaveBeenCalled();
  expect(replacementPairing.dependencies.fetch).toHaveBeenCalledTimes(2);
  expect(replacementPairing.confirm).toHaveBeenCalledTimes(1);
});

test("cancellation interrupts a pending comparison immediately and removes its abort listener", async () => {
  const f = setup("immediate-approval");
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let comparison!: AbortSignal;
  f.confirm.mockImplementation(async (_value, signal) => {
    comparison = signal;
    entered();
    return new Promise<boolean>(() => undefined);
  });
  const pairing = pairGoogleDevice({ ...f.options, signal: abort.signal }, f.dependencies);
  await started;
  abort.abort(new Error("Cancelled while comparing"));
  await expect(pairing).rejects.toThrow("Cancelled while comparing");
  expect(comparison.aborted).toBe(true);
  expect(getEventListeners(comparison, "abort")).toEqual([]);
  expect(f.gatewayJson.mock.calls.map((c) => c[1])).not.toContain("/devices/pair");
});

test("an approved request expiring during comparison cannot issue a credential", async () => {
  const f = setup("immediate-approval");
  f.confirm.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 10_001);
    return true;
  });
  await expect(pairGoogleDevice(f.options, f.dependencies)).rejects.toThrow("expired");
  expect(f.gatewayJson.mock.calls.map((c) => c[1])).not.toContain("/devices/pair");
});

test("a stalled comparison is cancelled at the gateway request deadline", async () => {
  const f = setup("immediate-approval");
  const original = f.gatewayJson.getMockImplementation()!;
  f.gatewayJson.mockImplementation(async (...args) => {
    const value = (await original(...args)) as Record<string, unknown>;
    return { ...value, expiresAt: Date.now() + 5 };
  });
  f.confirm.mockImplementation(async () => new Promise<boolean>(() => undefined));
  await expect(pairGoogleDevice(f.options, f.dependencies)).rejects.toThrow("expired");
  expect(f.gatewayJson.mock.calls.map((c) => c[1])).not.toContain("/devices/pair");
});

test("refuses an expired candidate certificate before contacting the proposed gateway", async () => {
  const f = setup();
  vi.useFakeTimers({ now: new Date("2040-01-01T00:00:00Z") });
  await expect(pairGoogleDevice(f.options, f.dependencies)).rejects.toThrow("validity interval");
  expect(f.gatewayJson).not.toHaveBeenCalled();
});

test("pinned pairing transport verifies TLS before sending credentials and never follows redirects", async () => {
  const files = tlsFiles(dir, "gateway.example.test");
  const certificate = await readFile(files.certFile, "utf8");
  const key = await readFile(files.keyFile, "utf8");
  let received = "";
  const server = createServer({ cert: certificate, key }, (req, res) => {
    void (async () => {
      for await (const chunk of req) received += chunk.toString();
      expect(req.headers.authorization).toBeUndefined();
      if (req.url === "/devices/google/poll") {
        res.writeHead(302, { location: "https://untrusted.example.test" }).end();
        return;
      }
      if (req.url === "/devices/pair") {
        res.end("x".repeat(65_537));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "pending" }));
    })().catch(() => res.destroy());
  });
  const local = await listen(server);
  const binding = {
    gatewayId: randomUUID(),
    publicOrigin: local.replace("http://127.0.0.1", "https://gateway.example.test"),
    certificate,
    identityToken: "historical-google-proof",
  };
  const signal = AbortSignal.timeout(5000);
  try {
    expect(
      await pinnedGatewayJson(
        binding,
        "/devices/google/request",
        { secret: "fictional-private-challenge" },
        signal,
        "127.0.0.1",
      ),
    ).toEqual({ status: "pending" });
    expect(received).toContain("fictional-private-challenge");
    await expect(
      pinnedGatewayJson(binding, "/devices/google/poll", {}, signal, "127.0.0.1"),
    ).rejects.toThrow("refused");
    await expect(
      pinnedGatewayJson(binding, "/devices/pair", {}, signal, "127.0.0.1"),
    ).rejects.toThrow("too large");
    await expect(
      pinnedGatewayJson(binding, "/admin/devices", {}, signal, "127.0.0.1"),
    ).rejects.toThrow("Unsupported");
    const before = received;
    await expect(
      pinnedGatewayJson(
        { ...binding, certificate: candidate.certificate },
        "/devices/google/request",
        { secret: "must-not-arrive" },
        signal,
        "127.0.0.1",
      ),
    ).rejects.toThrow();
    expect(received).toBe(before);
  } finally {
    await closeServer(server);
  }
});

test("default discovery, polling and pinned HTTP transport pair a real TLS endpoint after both approvals", async () => {
  vi.useRealTimers();
  const files = tlsFiles(dir, "gateway.example.test");
  const certificate = await readFile(files.certFile, "utf8"),
    key = await readFile(files.keyFile, "utf8");
  let verificationCode = "";
  let compared = false;
  let approved = false;
  const server = createServer({ cert: certificate, key }, (req, res) => {
    void (async () => {
      if (req.url === "/devices/direct-candidates") {
        expect(req.headers.authorization).toBe("Bearer approved-device");
        res.end(JSON.stringify({ version: 1, candidates: [] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === "/devices/pair") {
        expect(compared).toBe(true);
        expect(approved).toBe(true);
        res.end(
          JSON.stringify({
            token: "approved-device",
            device: { id: randomUUID(), kind: "collector" },
            scopes: ["write:all"],
          }),
        );
        return;
      }
      if (req.url === "/devices/google/challenge") {
        res.end(JSON.stringify({ challenge: CHALLENGE, expiresAt: Date.now() + 120_000 }));
        return;
      }
      if (req.url === "/devices/google/request") {
        expect(input.challenge).toBe(CHALLENGE);
        verificationCode = pairingComparisonCode({
          ...input,
          gatewayFingerprint: certificateFingerprint(certificate),
          codeNonce: CODE_NONCE,
        });
      } else approved = true;
      res.end(
        JSON.stringify({
          status: approved ? "approved" : "pending",
          verificationCode,
          codeNonce: CODE_NONCE,
          expiresAt: Date.now() + 60_000,
          ...(approved ? { pairingCode: "OWNER-CODE" } : {}),
        }),
      );
    })().catch(() => res.destroy());
  });
  const local = await listen(server);
  const binding = {
    gatewayId: randomUUID(),
    publicOrigin: local.replace("http://127.0.0.1", "https://gateway.example.test"),
    certificate,
    identityToken: "historical-proof-never-trusted-without-comparison",
  };
  const realConnect = network.connectOrigin;
  vi.spyOn(network, "connectOrigin").mockImplementation((origin, ca, signal, opaque, pin) =>
    realConnect(origin, ca, signal, opaque, pin, "127.0.0.1"),
  );
  vi.spyOn(desktop, "authorizeGoogleDesktop").mockResolvedValue({
    identity,
    idToken: "verified-Google-id-token",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/login")
        ? Response.json({
            token: "routing-only",
            accountId: accountId(identity),
            expiresAt: 4_000_000_000,
          })
        : Response.json(binding),
    ),
  );
  try {
    const result = await pairGoogleDevice({
      relayUrl: "https://relay.example.test",
      sessionFile: join(dir, "default-session.json"),
      clientId: "fixture-desktop",
      kind: "collector",
      name: "Fictional collector",
      confirm: async (value) => {
        expect(value.verificationCode).toBe(verificationCode);
        compared = true;
        return true;
      },
    });
    expect(result.token).toBe("approved-device");
    expect(result.gatewayFingerprint).toBe(certificateFingerprint(certificate));
  } finally {
    await closeServer(server);
  }
});

test("malformed candidate validity times are refused before any provisional gateway request", async () => {
  for (const which of ["from", "to"] as const) {
    const f = setup();
    const original = f.dependencies.fetch.getMockImplementation()!;
    f.dependencies.fetch.mockImplementation((url, init) =>
      String(url).endsWith("/login")
        ? original(url, init)
        : Promise.resolve(
            Response.json({
              ...candidate,
              certificate: malformedDateCertificate(candidate.certificate, which),
            }),
          ),
    );
    await expect(pairGoogleDevice(f.options, f.dependencies)).rejects.toThrow("validity interval");
    expect(f.gatewayJson).not.toHaveBeenCalled();
  }
});

test("legacy Google discovery takes a single listed gateway without asking and refuses an ambiguous singular directory", async () => {
  const f = setup(),
    original = f.dependencies.fetch.getMockImplementation()!;
  f.dependencies.fetch.mockImplementation(async (url, init) =>
    new URL(String(url)).pathname.endsWith("/gateways")
      ? Response.json({
          gateways: [{ gatewayId: candidate.gatewayId, publicOrigin: candidate.publicOrigin }],
        })
      : original(url, init),
  );
  const selectGateway = vi.fn(async () => candidate.gatewayId);
  expect((await pairGoogleDevice({ ...f.options, selectGateway }, f.dependencies)).token).toBe(
    "gateway-device-token",
  );
  expect(selectGateway).not.toHaveBeenCalled();
  const ambiguous = setup();
  const transport = ambiguous.dependencies.fetch.getMockImplementation()!;
  ambiguous.dependencies.fetch.mockImplementation(async (url, init) =>
    String(url).endsWith("/gateway") ? new Response(null, { status: 409 }) : transport(url, init),
  );
  await expect(pairGoogleDevice(ambiguous.options, ambiguous.dependencies)).rejects.toThrow(
    "Multiple gateways",
  );
  expect(ambiguous.dependencies.gatewayJson).not.toHaveBeenCalled();
});
