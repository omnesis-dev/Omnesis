// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as fileOps from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { GatewayAcmeRenewal, validateAcmeCertificate, relayDnsPresenter } from "./acme-gateway.js";

const systemTrust = vi.hoisted(() => ({ certificates: [] as string[] }));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  rootCertificates: systemTrust.certificates,
}));
vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, link: vi.fn(module.link), readFile: vi.fn(module.readFile) };
});
const actualFiles = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let directory: string,
  leaf: string,
  root: string,
  bootstrap: string,
  key: string,
  otherRoot: string;
let files: ReturnType<typeof tlsFiles>;
const hostname = "gateway.example.test";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-validation-"));
  files = tlsFiles(directory, hostname);
  bootstrap = await readFile(files.certFile, "utf8");
  key = await readFile(files.keyFile, "utf8");
  const caDir = join(directory, "authority"),
    otherDir = join(directory, "other");
  await mkdir(caDir);
  await mkdir(otherDir);
  const authority = tlsFiles(caDir),
    other = tlsFiles(otherDir);
  execFileSync(
    "openssl",
    [
      "x509",
      "-in",
      authority.certFile,
      "-signkey",
      authority.keyFile,
      "-days",
      "365",
      "-out",
      join(caDir, "long-root.crt"),
    ],
    { stdio: "ignore" },
  );
  await writeFile(authority.certFile, await readFile(join(caDir, "long-root.crt")));
  root = await readFile(authority.certFile, "utf8");
  systemTrust.certificates.push(root);
  otherRoot = await readFile(other.certFile, "utf8");
  const csr = join(directory, "request.csr"),
    extensions = join(directory, "extensions"),
    output = join(directory, "signed.crt");
  await writeFile(
    extensions,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-key",
      files.keyFile,
      "-out",
      csr,
      "-subj",
      `/CN=${hostname}`,
      "-addext",
      `subjectAltName=DNS:${hostname}`,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      authority.certFile,
      "-CAkey",
      authority.keyFile,
      "-CAcreateserial",
      "-out",
      output,
      "-days",
      "90",
      "-copy_extensions",
      "copy",
      "-extfile",
      extensions,
    ],
    { stdio: "ignore" },
  );
  leaf = await readFile(output, "utf8");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(fileOps.link).mockReset().mockImplementation(actualFiles.link);
  vi.mocked(fileOps.readFile).mockReset().mockImplementation(actualFiles.readFile);
});
afterAll(async () => rm(directory, { recursive: true, force: true }));
function mutatedSignature(pem: string) {
  const raw = Buffer.from(new X509Certificate(pem).raw);
  raw[raw.length - 1] = raw.at(-1)! ^ 1;
  return `-----BEGIN CERTIFICATE-----\n${raw
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END CERTIFICATE-----\n`;
}
test("only a complete matching server leaf/chain with a trusted root is accepted", () => {
  expect(validateAcmeCertificate(leaf + root, key, hostname, [leaf, root]).fingerprint256).toBe(
    new X509Certificate(leaf).fingerprint256,
  );
  expect(validateAcmeCertificate(leaf, key, hostname, [root]).fingerprint256).toBe(
    new X509Certificate(leaf).fingerprint256,
  );
  for (const chain of [
    "invalid",
    `${leaf}private-material`,
    leaf.repeat(9),
    leaf + leaf,
    leaf + otherRoot,
    mutatedSignature(leaf) + root,
  ])
    expect(() => validateAcmeCertificate(chain, key, hostname, [root])).toThrow();
  expect(() => validateAcmeCertificate(bootstrap, key, hostname, [bootstrap])).toThrow("match");
  expect(() => validateAcmeCertificate(leaf, key, "other.example.test", [root])).toThrow("match");
  const wrongKey = execFileSync(
    "openssl",
    ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"],
    { stdio: ["ignore", "pipe", "ignore"] },
  ).toString();
  expect(() => validateAcmeCertificate(leaf, wrongKey, hostname, [root])).toThrow("match");
  expect(() => validateAcmeCertificate(leaf, key, hostname, [otherRoot])).toThrow("trusted");
  expect(() => validateAcmeCertificate(leaf, key, hostname, [])).toThrow("trusted");
});
test("failed issuance/activation, file races and cancellation preserve previously usable files", async () => {
  const certPath = join(directory, "managed.crt"),
    keyPath = join(directory, "managed.key"),
    accountPath = join(directory, "account-key");
  await writeFile(certPath, bootstrap);
  await writeFile(keyPath, key);
  const activate = vi.fn(async () => {}),
    issuer = vi.fn(async () => leaf + root);
  const controller = () =>
    new GatewayAcmeRenewal({
      directoryUrl: "https://ca.example.test/directory",
      publicOrigin: `https://${hostname}`,
      certificateFile: certPath,
      privateKeyFile: keyPath,
      accountKeyFile: accountPath,
      trustedRoots: [root],
      issuer,
      presenter: {
        async create() {
          return { id: "unused" };
        },
        async remove() {},
      },
      activate,
    });
  issuer.mockRejectedValueOnce(new Error("issuer unavailable"));
  await expect(controller().renew(new AbortController().signal)).rejects.toThrow("unavailable");
  expect(await readFile(certPath, "utf8")).toBe(bootstrap);
  activate.mockRejectedValueOnce(new Error("activation failed"));
  await expect(controller().renew(new AbortController().signal)).rejects.toThrow(
    "activation failed",
  );
  expect(activate).toHaveBeenCalledTimes(2);
  expect(await readFile(certPath, "utf8")).toBe(bootstrap);
  issuer.mockImplementationOnce(async () => {
    await writeFile(certPath, leaf);
    return leaf + root;
  });
  await expect(controller().renew(new AbortController().signal)).rejects.toThrow("changed");
  await writeFile(certPath, bootstrap);
  issuer.mockImplementationOnce(async () => {
    await writeFile(keyPath, "changed-private-key");
    return leaf + root;
  });
  await expect(controller().renew(new AbortController().signal)).rejects.toThrow("changed");
  await writeFile(keyPath, key);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(controller().renew(abort.signal)).rejects.toThrow("cancelled");
});
test("fresh current material is skipped only if hostname/key/dates/trust match; failed renewal must extend its lifetime", async () => {
  const certPath = join(directory, "fresh.crt"),
    keyPath = join(directory, "fresh.key");
  await writeFile(certPath, leaf + root);
  await writeFile(keyPath, key);
  const issuer = vi.fn(async () => leaf + root);
  const options = {
    directoryUrl: "https://ca.example.test/directory",
    publicOrigin: `https://${hostname}`,
    certificateFile: certPath,
    privateKeyFile: keyPath,
    accountKeyFile: join(directory, "fresh-account"),
    trustedRoots: [root],
    issuer,
    presenter: {
      async create() {
        return { id: "unused" };
      },
      async remove() {},
    },
    activate: async () => {},
  };
  expect(await new GatewayAcmeRenewal(options).renew(new AbortController().signal)).toBe(false);
  expect(issuer).not.toHaveBeenCalled();
  const expires = Date.parse(new X509Certificate(leaf).validTo);
  vi.useFakeTimers({ toFake: ["Date"], now: expires - 86400_000 });
  await expect(new GatewayAcmeRenewal(options).renew(new AbortController().signal)).rejects.toThrow(
    "extend",
  );
  expect(issuer).toHaveBeenCalledOnce();
  vi.useRealTimers();
  await expect(
    new GatewayAcmeRenewal({ ...options, publicOrigin: "https://other.example.test" }).renew(
      new AbortController().signal,
    ),
  ).rejects.toThrow("match");
  expect(issuer).toHaveBeenCalledTimes(2);
});
test("relay DNS presenter authenticates control requests, bounds replies and never follows redirects", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    session = vi.fn(async () => "owner-routing-token");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ id }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const presenter = relayDnsPresenter({ relayUrl: "https://relay.example.test", session, fetch }),
    signal = new AbortController().signal;
  expect(await presenter.create("a".repeat(43), signal)).toEqual({ id });
  await presenter.remove(id, signal);
  expect(fetch).toHaveBeenCalledWith(
    new URL("https://relay.example.test/_relay/v2/acme/challenge"),
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      signal,
      headers: { authorization: "Bearer owner-routing-token", "content-type": "application/json" },
    }),
  );
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(presenter.create("a".repeat(43), signal)).rejects.toThrow("refused");
});

test("account key publication is exclusive, I/O failures stay contained, and configured system trust is used by default", async () => {
  const certPath = join(directory, "account-managed.crt"),
    keyPath = join(directory, "account-managed.key");
  await writeFile(certPath, bootstrap);
  await writeFile(keyPath, key);
  const options = (accountKeyFile: string) => ({
    directoryUrl: "https://ca.example.test/directory",
    publicOrigin: `https://${hostname}`,
    certificateFile: certPath,
    privateKeyFile: keyPath,
    accountKeyFile,
    issuer: async () => leaf + root,
    presenter: {
      async create() {
        return { id: "unused" };
      },
      async remove() {},
    },
    activate: async () => {},
  });
  await expect(
    new GatewayAcmeRenewal(options(directory)).renew(new AbortController().signal),
  ).rejects.toThrow();
  for (const error of [
    null,
    "error",
    {},
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  ]) {
    vi.mocked(fileOps.link).mockRejectedValueOnce(error);
    await expect(
      new GatewayAcmeRenewal(options(join(directory, "account-new"))).renew(
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
  }
  vi.mocked(fileOps.link).mockImplementationOnce(async (source, target) => {
    await actualFiles.writeFile(target, await actualFiles.readFile(source), {
      flag: "wx",
      mode: 0o600,
    });
    throw Object.assign(new Error("concurrent account creation"), { code: "EEXIST" });
  });
  expect(
    await new GatewayAcmeRenewal(options(join(directory, "account-winner"))).renew(
      new AbortController().signal,
    ),
  ).toBe(true);
  expect(validateAcmeCertificate(leaf, key, hostname).fingerprint256).toBe(
    new X509Certificate(leaf).fingerprint256,
  );
});

test("account read failures preserve existing material without treating arbitrary errors as a missing key", async () => {
  const certPath = join(directory, "read-failure.crt"),
    keyPath = join(directory, "read-failure.key"),
    accountPath = join(directory, "unreadable-account");
  await writeFile(certPath, bootstrap);
  await writeFile(keyPath, key);
  for (const error of [null, "read-error", {}]) {
    vi.mocked(fileOps.readFile).mockImplementation((async (path, encoding) => {
      if (String(path) === accountPath) throw error;
      return actualFiles.readFile(path, encoding);
    }) as typeof fileOps.readFile);
    const renewal = new GatewayAcmeRenewal({
      directoryUrl: "https://ca.example.test",
      publicOrigin: `https://${hostname}`,
      certificateFile: certPath,
      privateKeyFile: keyPath,
      accountKeyFile: accountPath,
      issuer: async () => leaf + root,
      trustedRoots: [root],
      presenter: {
        async create() {
          return { id: "unused" };
        },
        async remove() {},
      },
      activate: async () => {},
    });
    await expect(renewal.renew(new AbortController().signal)).rejects.toBe(error);
  }
});

test("default relay presenter transport keeps only owner control authentication in the broker request", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id }));
  vi.stubGlobal("fetch", fetch);
  const presenter = relayDnsPresenter({
    relayUrl: "https://relay.example.test",
    session: async () => "raw-owner",
  });
  expect(await presenter.create("a".repeat(43), new AbortController().signal)).toEqual({ id });
  expect(fetch).toHaveBeenCalledWith(
    new URL("https://relay.example.test/_relay/v2/acme/challenge"),
    expect.objectContaining({ redirect: "error" }),
  );
});

test("relay DNS retries once only after a cancelled 401 body and fresh owner session", async () => {
  let tokens = 0;
  const id = "00000000-0000-4000-8000-000000000001",
    order: string[] = [],
    session = vi.fn(async () => {
      order.push("session");
      tokens++;
      return tokens === 1 ? "old-owner-token" : "new-owner-token";
    }),
    invalidateSession = vi.fn(() => {
      order.push("invalidate");
    });
  const refused = new Response(
      new ReadableStream({
        cancel() {
          order.push("cancel");
        },
      }),
      { status: 401 },
    ),
    transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(Response.json({ id })),
    presenter = relayDnsPresenter({
      relayUrl: "https://relay.example.test",
      session,
      invalidateSession,
      fetch: transport,
    });
  expect(await presenter.create("a".repeat(43), new AbortController().signal)).toEqual({ id });
  expect(order).toEqual(["session", "cancel", "invalidate", "session"]);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1][1]!.headers).toMatchObject({
    authorization: "Bearer new-owner-token",
  });
  expect(invalidateSession).toHaveBeenCalledOnce();
});
test("relay DNS never replays ambiguous network failures, 403, or a second 401", async () => {
  for (const failure of [
    new Error("fixture network reset"),
    new Response(null, { status: 403 }),
    new Response("refused", { status: 403 }),
    new Response("unavailable", { status: 503 }),
    new Response(null, { status: 401 }),
  ]) {
    const invalidateSession = vi.fn(),
      session = vi.fn(async () => "owner-token"),
      transport = vi.fn<typeof fetch>();
    if (failure instanceof Error) transport.mockRejectedValue(failure);
    else transport.mockResolvedValue(failure);
    const presenter = relayDnsPresenter({
      relayUrl: "https://relay.example.test",
      session,
      invalidateSession,
      fetch: transport,
    });
    await expect(presenter.create("a".repeat(43), new AbortController().signal)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(
      failure instanceof Response && failure.status === 401 ? 2 : 1,
    );
    expect(invalidateSession).toHaveBeenCalledTimes(
      failure instanceof Response && failure.status === 401 ? 1 : 0,
    );
  }
  const noInvalidation = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  await expect(
    relayDnsPresenter({
      relayUrl: "https://relay.example.test",
      session: async () => "owner",
      fetch: noInvalidation,
    }).create("a".repeat(43), new AbortController().signal),
  ).rejects.toThrow("refused");
  expect(noInvalidation).toHaveBeenCalledOnce();
});
test("aborting while cancelling a refused DNS response prevents invalidation and a retry", async () => {
  const controller = new AbortController(),
    invalidateSession = vi.fn(),
    transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            controller.abort();
          },
        }),
        { status: 401 },
      ),
    );
  const presenter = relayDnsPresenter({
    relayUrl: "https://relay.example.test",
    session: async () => "owner",
    invalidateSession,
    fetch: transport,
  });
  await expect(presenter.create("a".repeat(43), controller.signal)).rejects.toThrow();
  expect(transport).toHaveBeenCalledOnce();
  expect(invalidateSession).not.toHaveBeenCalled();
});
