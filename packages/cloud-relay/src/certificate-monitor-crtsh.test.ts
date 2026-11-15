// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { CertificateIssuanceMonitor } from "./certificate-monitor.js";
import {
  CertSpotterProvider,
  CertificateMonitorFailure,
} from "./certificate-monitor-certspotter.js";
import { CrtShProvider } from "./certificate-monitor-crtsh.js";

const hostname = "gateway.example.test";
let root: string,
  directory: string,
  served: string,
  rogue: X509Certificate,
  wildcard: X509Certificate;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-crtsh-"));
  for (const name of ["served", "rogue", "wildcard"]) await mkdir(join(root, name));
  served = await readFile(tlsFiles(join(root, "served"), hostname).certFile, "utf8");
  rogue = new X509Certificate(await readFile(tlsFiles(join(root, "rogue"), hostname).certFile));
  wildcard = new X509Certificate(
    await readFile(tlsFiles(join(root, "wildcard"), "*.example.test").certFile),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ct-crtsh-journal-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

/** A stand-in for crt.sh: rows per queried name, and each certificate as PEM by id. */
function crtsh(
  rows: Record<string, unknown>,
  certificates: Record<number, X509Certificate | string>,
) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://crt.sh");
    const id = url.searchParams.get("d");
    if (id !== null) {
      const certificate = certificates[Number(id)];
      if (certificate === undefined) return new Response("", { status: 404 });
      return new Response(typeof certificate === "string" ? certificate : certificate.toString());
    }
    expect(url.searchParams.get("output")).toBe("json");
    expect(url.searchParams.get("deduplicate")).toBe("Y");
    const name = url.searchParams.get("q")!;
    return typeof rows[name] === "string"
      ? new Response(rows[name] as string)
      : Response.json(rows[name] ?? []);
  });
}
const outage = vi
  .fn<typeof fetch>()
  .mockImplementation(async () =>
    Response.json(
      { code: "service_outage", message: "the free tier is temporarily unavailable" },
      { status: 503 },
    ),
  );
const snapshot = (provider: CrtShProvider) =>
  provider.snapshot(hostname, AbortSignal.timeout(5000));
async function monitor(
  fallback?: CrtShProvider,
  primary = new CertSpotterProvider({ fetch: outage }),
) {
  return CertificateIssuanceMonitor.open({
    hostname,
    expectedSpkiFingerprint: () => tlsSpkiFingerprint(served),
    journalFile: join(directory, "journal.json"),
    provider: primary,
    ...(fallback ? { fallback } : {}),
  });
}

test("F44: when the main CT service is down, crt.sh is asked and a certificate with another key holds", async () => {
  const transport = crtsh(
    { [hostname]: [{ id: 11 }, { id: 12 }], "*.example.test": [{ id: 13 }] },
    { 11: new X509Certificate(served), 12: rogue, 13: wildcard },
  );
  const ct = await monitor(new CrtShProvider({ fetch: transport }));
  const status = await ct.check();
  expect(outage).toHaveBeenCalled();
  expect(status).toMatchObject({ state: "incident", lastScanProvider: "crtsh" });
  expect(status.lastError).toBeUndefined();
  // The served certificate is no incident; the rogue one and the wildcard with another key are.
  expect(status.incidents.map((incident) => incident.providerEntryId)).toEqual([
    "crtsh-12",
    "crtsh-13",
  ]);
  expect(status.incidents[0]!.spkiFingerprint).not.toBe(tlsSpkiFingerprint(served));
  // A second scan reads no certificate again and records nothing twice.
  const fetched = transport.mock.calls.length;
  expect((await ct.check()).incidents).toHaveLength(2);
  expect(transport.mock.calls.length).toBe(fetched + 2);
});

test("F44: with both services down the check says the provider is unavailable", async () => {
  const ct = await monitor(new CrtShProvider({ fetch: outage }));
  expect(await ct.check()).toMatchObject({
    state: "unavailable",
    lastError: "ct-provider-unavailable",
    incidents: [],
  });
  // Without a fallback, an outage is the same answer as before.
  expect(await (await monitor()).check()).toMatchObject({ lastError: "ct-provider-unavailable" });
});

test("F44: the same certificate from both services is one incident", async () => {
  const both = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([{ id: "a1", cert_der: rogue.raw.toString("base64") }]));
  both.mockResolvedValueOnce(Response.json([]));
  const ct = await monitor(
    new CrtShProvider({ fetch: crtsh({ [hostname]: [{ id: 21 }] }, { 21: rogue }) }),
    new CertSpotterProvider({ fetch: both }),
  );
  expect((await ct.check()).incidents.map((incident) => incident.providerEntryId)).toEqual(["a1"]);
  both.mockImplementation(outage);
  const status = await ct.check();
  expect(status).toMatchObject({ lastScanProvider: "crtsh", state: "incident" });
  expect(status.incidents).toHaveLength(1);
});

test("F44: a malformed answer from the main CT service is not papered over by crt.sh", async () => {
  const fallback = crtsh({}, {});
  const ct = await monitor(
    new CrtShProvider({ fetch: fallback }),
    new CertSpotterProvider({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("{")) }),
  );
  expect(await ct.check()).toMatchObject({ lastError: "ct-provider-invalid" });
  expect(fallback).not.toHaveBeenCalled();
});

test("F44: crt.sh answers that are malformed, oversized or partial are refused", async () => {
  const many = Array.from({ length: 257 }, (_, index) => ({ id: index + 1 }));
  for (const [rows, certificates, code] of [
    [{ [hostname]: "not json" }, {}, "ct-provider-invalid"],
    [{ [hostname]: { id: 1 } }, {}, "ct-provider-invalid"],
    [{ [hostname]: [{ id: "1" }] }, {}, "ct-provider-invalid"],
    [{ [hostname]: [{ id: -1 }] }, {}, "ct-provider-invalid"],
    [{ [hostname]: [{}] }, {}, "ct-provider-invalid"],
    [{ [hostname]: JSON.stringify(Array(300_000).fill({ id: 1 })) }, {}, "ct-provider-invalid"],
    [{ [hostname]: many }, {}, "ct-scan-incomplete"],
    [
      { [hostname]: [{ id: 1 }] },
      { 1: "-----BEGIN CERTIFICATE-----\n!!\n-----END CERTIFICATE-----\n" },
      "ct-provider-invalid",
    ],
    [
      { [hostname]: [{ id: 1 }] },
      { 1: rogue.toString() + rogue.toString() },
      "ct-provider-invalid",
    ],
    [{ [hostname]: [{ id: 1 }] }, { 1: "x".repeat(70_000) }, "ct-provider-invalid"],
    [{ [hostname]: [{ id: 1 }] }, {}, "ct-provider-unavailable"],
  ] as const)
    await expect(
      snapshot(new CrtShProvider({ fetch: crtsh(rows, certificates) })),
      JSON.stringify(rows).slice(0, 60),
    ).rejects.toMatchObject({ code });
  // More certificates than one scan reads: incomplete now, and done once the rest are read.
  const ids = Array.from({ length: 40 }, (_, index) => index + 1);
  const provider = new CrtShProvider({
    fetch: crtsh(
      { [hostname]: ids.map((id) => ({ id })) },
      Object.fromEntries(ids.map((id) => [id, rogue])),
    ),
  });
  await expect(snapshot(provider)).rejects.toMatchObject({ code: "ct-scan-incomplete" });
  expect(await snapshot(provider)).toHaveLength(40);
  // A certificate that isn't for this name makes the monitor refuse the scan.
  const ct = await monitor(
    new CrtShProvider({ fetch: crtsh({ [hostname]: [{ id: 5 }] }, { 5: wildcard }) }),
  );
  await expect(
    new CrtShProvider({
      fetch: crtsh({ [hostname]: [{ id: 5 }] }, { 5: new X509Certificate(served) }),
    }).snapshot("not a name", AbortSignal.timeout(5000)),
  ).rejects.toBeInstanceOf(CertificateMonitorFailure);
  expect((await ct.check()).state).toBe("incident");
});

test("F44: crt.sh transport failures read as unavailable and say nothing about the cause", async () => {
  for (const transport of [
    vi.fn<typeof fetch>().mockRejectedValue(new Error("private-cause")),
    vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 502 })),
    vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 429 })),
  ]) {
    const failure = await snapshot(new CrtShProvider({ fetch: transport })).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "ct-provider-unavailable" });
    expect(String(failure)).not.toContain("private-cause");
  }
});

test("a crt.sh that refuses the request is told apart from one that is down", async () => {
  await expect(
    snapshot(
      new CrtShProvider({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 })),
      }),
    ),
  ).rejects.toMatchObject({ code: "ct-provider-refused" });
});
