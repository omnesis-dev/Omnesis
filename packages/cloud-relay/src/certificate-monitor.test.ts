// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { tlsFiles, malformedDateCertificate } from "../test/support.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { CertificateIssuanceMonitor } from "./certificate-monitor.js";
import {
  CertificateMonitorFailure,
  type CertificateObservationPage,
} from "./certificate-monitor-certspotter.js";
let root: string,
  directory: string,
  good: Buffer,
  other: Buffer,
  wrongHost: Buffer,
  wildcard: Buffer,
  key: string,
  certificate: string,
  now: number;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-monitor-"));
  for (const name of ["good", "other", "wrong", "wildcard"]) await mkdir(join(root, name));
  const files = tlsFiles(join(root, "good"), "gateway.example.test");
  certificate = await readFile(files.certFile, "utf8");
  key = files.keyFile;
  good = new X509Certificate(certificate).raw;
  other = new X509Certificate(
    await readFile(tlsFiles(join(root, "other"), "gateway.example.test").certFile),
  ).raw;
  wrongHost = new X509Certificate(
    await readFile(tlsFiles(join(root, "wrong"), "other.example.test").certFile),
  ).raw;
  wildcard = new X509Certificate(
    await readFile(tlsFiles(join(root, "wildcard"), "*.example.test").certFile),
  ).raw;
});
afterAll(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ct-journal-"));
  now = Date.now();
});
afterEach(() => rm(directory, { recursive: true, force: true }));
const empty = (): CertificateObservationPage => ({
  entries: [],
  complete: true,
  invalidEntries: 0,
});
const page = (cert = good, id = "1"): CertificateObservationPage => ({
  entries: [{ entryId: id, certificateDer: cert }],
  lastId: id,
  complete: false,
  invalidEntries: 0,
});
function fixture(baseline: () => string | undefined = () => tlsSpkiFingerprint(certificate)) {
  const provider = {
    page: vi
      .fn<
        (
          _host: string,
          _after: string | undefined,
          _signal: AbortSignal,
        ) => Promise<CertificateObservationPage>
      >()
      .mockResolvedValue(empty()),
  };
  const options = {
    hostname: "gateway.example.test",
    expectedSpkiFingerprint: baseline,
    journalFile: join(directory, "journal.json"),
    provider,
    now: () => now,
  };
  return { provider, options, open: () => CertificateIssuanceMonitor.open(options) };
}
test("unknown local key sends no hostname query; completed observations are limited and become stale with age", async () => {
  let baseline: string | undefined = undefined;
  const f = fixture(() => baseline),
    monitor = await f.open();
  expect(monitor.status().state).toBe("pending");
  await monitor.check();
  expect(f.provider.page).not.toHaveBeenCalled();
  baseline = tlsSpkiFingerprint(certificate);
  await monitor.check();
  expect(monitor.status()).toMatchObject({
    state: "observing",
    incidents: [],
    lastCompletedAt: new Date(now).toISOString(),
  });
  now += 7200001;
  expect(monitor.status().state).toBe("stale");
});
test("same-key renewal is accepted; independent DER key comparison ignores provider claims and journals unexpected keys durably", async () => {
  const f = fixture(),
    monitor = await f.open();
  const renewed = new X509Certificate(
    execFileSync(
      "openssl",
      [
        "x509",
        "-in",
        join(root, "good/tls-cert.pem"),
        "-signkey",
        key,
        "-set_serial",
        "2",
        "-days",
        "1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    ),
  ).raw;
  f.provider.page
    .mockResolvedValueOnce(page(renewed))
    .mockResolvedValueOnce(page(other, "2"))
    .mockResolvedValueOnce(empty());
  await monitor.check();
  const status = monitor.status();
  expect(status.state).toBe("incident");
  expect(status.incidents).toHaveLength(1);
  expect(status.incidents[0]).toMatchObject({
    hostname: "gateway.example.test",
    spkiFingerprint: tlsSpkiFingerprint(new X509Certificate(other).toString()),
    providerEntryId: "2",
  });
  expect(status.incidents[0].serial).toBeTruthy();
  const restored = await f.open();
  expect(restored.status().incidents).toEqual(status.incidents);
  f.provider.page.mockResolvedValueOnce(page(other, "3")).mockResolvedValueOnce(empty());
  await restored.check();
  expect(restored.status().incidents).toHaveLength(1);
  const exposed = restored.status();
  exposed.incidents.length = 0;
  expect(restored.status().incidents).toHaveLength(1);
  expect(await readFile(f.options.journalFile, "utf8")).not.toContain(key);
});
test("incomplete bounded pagination progresses its durable cursor without claiming a completed scan", async () => {
  const f = fixture(),
    monitor = await f.open();
  for (let index = 1; index <= 5; index++)
    f.provider.page.mockResolvedValueOnce(page(good, String(index)));
  await monitor.check();
  expect(f.provider.page).toHaveBeenCalledTimes(5);
  expect(monitor.status()).toMatchObject({
    state: "stale",
    lastError: "ct-scan-incomplete",
    lastCompletedAt: undefined,
  });
  await monitor.check();
  expect(f.provider.page.mock.calls[5][1]).toBe("5");
  expect(monitor.status().state).toBe("observing");
});
test("invalid DER, trailing bytes, wrong SAN and malformed dates cannot clear a scan; valid incidents remain visible", async () => {
  for (const invalid of [
    Buffer.from("invalid"),
    Buffer.concat([good, Buffer.from([0])]),
    wrongHost,
    new X509Certificate(malformedDateCertificate(certificate, "to")).raw,
  ]) {
    const f = fixture(),
      monitor = await f.open();
    f.provider.page.mockResolvedValueOnce({
      ...page(other),
      entries: [
        { entryId: "valid", certificateDer: other },
        { entryId: "invalid", certificateDer: invalid },
      ],
    });
    await monitor.check();
    expect(monitor.status()).toMatchObject({
      state: "unavailable",
      lastError: "ct-provider-invalid",
      lastCompletedAt: undefined,
    });
    expect(monitor.status().incidents).toHaveLength(1);
  }
});
test("malformed rows and non-progressing pagination produce actionable unknown coverage", async () => {
  for (const result of [
    { ...page(), invalidEntries: 1 },
    { ...page(), lastId: undefined },
    { ...page(), lastId: "x".repeat(129) },
    { ...empty(), entries: page().entries },
  ]) {
    const f = fixture(),
      monitor = await f.open();
    f.provider.page.mockResolvedValueOnce(result);
    await monitor.check();
    expect(monitor.status().lastError).toBe("ct-provider-invalid");
  }
  const f = fixture(),
    monitor = await f.open();
  f.provider.page.mockResolvedValue(page());
  await monitor.check();
  expect(f.provider.page).toHaveBeenCalledTimes(2);
  expect(monitor.status().lastError).toBe("ct-provider-invalid");
});
test("provider errors and Retry-After are distinct from clear and retain prior incident evidence", async () => {
  const f = fixture(),
    monitor = await f.open();
  f.provider.page.mockResolvedValueOnce(page(other)).mockResolvedValueOnce(empty());
  await monitor.check();
  f.provider.page.mockRejectedValueOnce(
    new CertificateMonitorFailure("ct-provider-unavailable", 60000),
  );
  await monitor.check();
  expect(monitor.status()).toMatchObject({
    state: "unavailable",
    nextCheckAt: new Date(now + 60000).toISOString(),
  });
  expect(monitor.status().incidents).toHaveLength(1);
  const calls = f.provider.page.mock.calls.length;
  await monitor.check();
  expect(f.provider.page).toHaveBeenCalledTimes(calls);
  now += 60000;
  await monitor.check();
  expect(monitor.status().state).toBe("incident");
});
test("invalid journals are not overwritten or treated as evidence of successful monitoring", async () => {
  for (const data of [
    "{",
    JSON.stringify({ version: 1, hostname: "other.example.test", incidents: [] }),
    JSON.stringify({
      version: 1,
      hostname: "gateway.example.test",
      incidents: [],
      lastCompletedAt: now + 1,
    }),
    JSON.stringify({
      version: 1,
      hostname: "gateway.example.test",
      incidents: [{ hostname: "other.example.test" }],
    }),
  ]) {
    const f = fixture();
    await writeFile(f.options.journalFile, data);
    const monitor = await f.open();
    await monitor.check();
    expect(monitor.status()).toMatchObject({
      state: "unavailable",
      lastError: "ct-journal-invalid",
    });
    expect(f.provider.page).not.toHaveBeenCalled();
    expect(await readFile(f.options.journalFile, "utf8")).toBe(data);
  }
});
test("journal write failures retain in-memory incidents and never advance the committed cursor", async () => {
  const f = fixture();
  f.options.journalFile = join(directory, "blocked/state.json");
  const monitor = await f.open();
  await writeFile(join(directory, "blocked"), "fixture obstruction");
  f.provider.page.mockResolvedValueOnce(page(other));
  await monitor.check();
  expect(monitor.status()).toMatchObject({
    state: "unavailable",
    lastError: "ct-journal-write-failed",
  });
  expect(monitor.status().incidents).toHaveLength(1);
  await rm(join(directory, "blocked"));
  f.provider.page.mockResolvedValueOnce(page(other)).mockResolvedValueOnce(empty());
  await monitor.check();
  expect(f.provider.page.mock.calls[1][1]).toBeUndefined();
  expect(monitor.status().state).toBe("incident");
});
test("concurrent checks are single-flight and cancelled late responses cannot mark coverage complete", async () => {
  const f = fixture(),
    monitor = await f.open(),
    controller = new AbortController();
  let release!: (value: CertificateObservationPage) => void;
  f.provider.page.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
  const first = monitor.check(controller.signal),
    second = monitor.check();
  expect(first).toBe(second);
  controller.abort();
  release(page(other));
  await first;
  expect(monitor.status()).toMatchObject({
    state: "unavailable",
    lastError: "ct-provider-unavailable",
    lastCompletedAt: undefined,
    incidents: [],
  });
  expect(f.provider.page).toHaveBeenCalledOnce();
  const stopped = new AbortController();
  stopped.abort();
  await monitor.check(stopped.signal);
  expect(f.provider.page).toHaveBeenCalledOnce();
});
test("only the newest bounded distinct incidents persist and replays do not duplicate an issuance", async () => {
  const f = fixture(() => "0".repeat(64)),
    monitor = await f.open();
  const entries = [];
  for (let index = 1; index <= 34; index++) {
    const cert = new X509Certificate(
      execFileSync(
        "openssl",
        [
          "x509",
          "-in",
          join(root, "good/tls-cert.pem"),
          "-signkey",
          key,
          "-set_serial",
          String(index),
          "-days",
          "1",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      ),
    ).raw;
    entries.push({ entryId: String(index), certificateDer: cert });
  }
  f.provider.page
    .mockResolvedValueOnce({ entries, lastId: "34", complete: false, invalidEntries: 0 })
    .mockResolvedValueOnce(empty());
  await monitor.check();
  expect(monitor.status().incidents).toHaveLength(32);
  expect(monitor.status().incidents[0].providerEntryId).toBe("3");
  expect((await f.open()).status().incidents).toHaveLength(32);
});
test("invalid configuration and local baseline do not send network requests", async () => {
  const f = fixture(() => "bad-pin");
  for (const hostname of ["127.0.0.1", "a.".repeat(128) + "test"])
    await expect(CertificateIssuanceMonitor.open({ ...f.options, hostname })).rejects.toThrow();
  const monitor = await f.open();
  await monitor.check();
  expect(monitor.status().state).toBe("unavailable");
  expect(f.provider.page).not.toHaveBeenCalled();
});

test("default clock starts with pending coverage and successful provider retry windows bound repeated queries", async () => {
  const f = fixture();
  const monitor = await CertificateIssuanceMonitor.open({ ...f.options, now: undefined });
  expect(monitor.status()).toMatchObject({
    state: "pending",
    lastAttemptAt: undefined,
    lastCompletedAt: undefined,
    nextCheckAt: undefined,
  });
  f.provider.page.mockResolvedValueOnce({ ...empty(), retryAfterMs: 60000 });
  await monitor.check();
  expect(monitor.status().state).toBe("observing");
  expect(monitor.status().nextCheckAt).toBeTruthy();
  await monitor.check();
  expect(f.provider.page).toHaveBeenCalledOnce();
});
test("a valid-looking journal for another host cannot smuggle unrelated incident history", async () => {
  const f = fixture(),
    monitor = await f.open();
  f.provider.page.mockResolvedValueOnce(page(other)).mockResolvedValueOnce(empty());
  await monitor.check();
  const stored = JSON.parse(await readFile(f.options.journalFile, "utf8"));
  stored.incidents[0].hostname = "other.example.test";
  await writeFile(f.options.journalFile, JSON.stringify(stored));
  const restored = await f.open();
  await restored.check();
  expect(restored.status().lastError).toBe("ct-journal-invalid");
});

test("matching wildcard SAN certificates are observed but a CN-only claim cannot replace a SAN match", async () => {
  const f = fixture(),
    monitor = await f.open();
  f.provider.page.mockResolvedValueOnce(page(wildcard)).mockResolvedValueOnce(empty());
  await monitor.check();
  expect(monitor.status().state).toBe("incident");
  const cnOnly = new X509Certificate(
    execFileSync(
      "openssl",
      ["req", "-new", "-x509", "-key", key, "-subj", "/CN=gateway.example.test", "-days", "1"],
      { stdio: ["ignore", "pipe", "ignore"] },
    ),
  ).raw;
  f.provider.page.mockResolvedValueOnce(page(cnOnly, "2"));
  await monitor.check();
  expect(monitor.status()).toMatchObject({
    state: "unavailable",
    lastError: "ct-provider-invalid",
  });
  expect(monitor.status().incidents).toHaveLength(1);
});

test("escaped issuer evidence has a serialized byte budget that survives restart after an almost-full restored journal", async () => {
  const f = fixture(() => "0".repeat(64));
  const escaped = new X509Certificate(
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        key,
        "-subj",
        "/CN=gateway.example.test" + ("/OU=" + "\\\\".repeat(60)).repeat(4),
        "-addext",
        "subjectAltName=DNS:gateway.example.test",
        "-days",
        "1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    ),
  ).raw;
  const records = Array.from({ length: 32 }, (_, index) => ({
    hostname: f.options.hostname,
    certificateFingerprint: index.toString(16).padStart(64, "0"),
    spkiFingerprint: "1".repeat(64),
    issuer: index === 0 ? "small" : "\u0001".repeat(256),
    serial: index === 0 ? "1" : "A".repeat(256),
    validFrom: new Date(now).toISOString(),
    validTo: new Date(now + 86400000).toISOString(),
    observedAt: new Date(now).toISOString(),
    providerEntryId: String(index),
  }));
  const journal = { version: 1, hostname: f.options.hostname, incidents: records };
  while (Buffer.byteLength(JSON.stringify(journal)) > 65450) {
    const record = [...records].reverse().find((value) => value.issuer.length > 0)!;
    record.issuer = record.issuer.slice(0, -1);
  }
  expect(Buffer.byteLength(JSON.stringify(journal))).toBeGreaterThan(64000);
  await writeFile(f.options.journalFile, JSON.stringify(journal));
  const monitor = await f.open();
  f.provider.page.mockResolvedValueOnce(page(escaped, "fresh")).mockResolvedValueOnce(empty());
  await monitor.check();
  expect(monitor.status().state).toBe("incident");
  expect(Buffer.byteLength(await readFile(f.options.journalFile))).toBeLessThanOrEqual(65536);
  expect(monitor.status().incidents.some((item) => item.providerEntryId === "fresh")).toBe(true);
  expect((await f.open()).status().state).toBe("incident");
});
