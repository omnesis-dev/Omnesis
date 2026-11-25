// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { desktopProfile } from "./environment.js";
import { readDesktopConnection, requestDesktopGateway } from "./gateway-access.js";
import { prepareDesktopRuntime, readDesktopRuntime } from "./runtime-state.js";

const roots: string[] = [];
const servers: Server[] = [];
let certificate: string;
let privateKey: string;
let certificateRoot: string;
beforeAll(async () => {
  certificateRoot = await realpath(await mkdtemp(join(tmpdir(), "omnesis-desktop-tls-")));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(certificateRoot, "key.pem"),
      "-out",
      join(certificateRoot, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  certificate = await readFile(join(certificateRoot, "cert.pem"), "utf8");
  privateKey = await readFile(join(certificateRoot, "key.pem"), "utf8");
});
afterAll(async () => rm(certificateRoot, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-desktop-access-")));
  roots.push(root);
  const profile = desktopProfile(root);
  await mkdir(join(profile.configDir, "tls"), { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "tls", "cert.pem"), certificate, { mode: 0o600 });
  await writeFile(join(profile.configDir, "token"), "omn_test", { mode: 0o600 });
  return profile;
}

async function serve(
  profile: Awaited<ReturnType<typeof fixture>>,
  handler: Parameters<typeof createServer>[1],
) {
  const server = createServer({ cert: certificate, key: privateKey }, handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  await writeFile(
    join(profile.configDir, "runtime.json"),
    JSON.stringify({ version: 1, port: address.port }),
    { mode: 0o600 },
  );
}

describe("private gateway access", () => {
  it("authenticates only after validating the app-owned TLS certificate", async () => {
    const profile = await fixture();
    await serve(profile, (req, response) => {
      expect(req.headers.authorization).toBe("Bearer omn_test");
      response.end(JSON.stringify({ connected: true }));
    });
    expect(await requestDesktopGateway(profile, "/status")).toEqual({ connected: true });
    expect(await readDesktopConnection(profile)).toMatchObject({
      certificatePEM: certificate,
      token: "omn_test",
    });
  });

  it("rejects a certificate that does not cover the loopback server identity", async () => {
    const profile = await fixture();
    let requests = 0;
    await serve(profile, (_req, response) => {
      requests++;
      response.end("{}");
    });
    // An unrelated trust anchor is refused before HTTP or a bearer is sent.
    await writeFile(join(profile.configDir, "tls", "cert.pem"), "invalid certificate");
    await expect(requestDesktopGateway(profile, "/status")).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it("permits health during initial token bootstrap but refuses admin requests", async () => {
    const profile = await fixture();
    await rm(join(profile.configDir, "token"));
    await serve(profile, (req, response) => {
      expect(req.headers.authorization).toBeUndefined();
      response.end(JSON.stringify({ status: "starting" }));
    });
    expect(await requestDesktopGateway(profile, "/health")).toEqual({ status: "starting" });
    await expect(requestDesktopGateway(profile, "/admin/cloud-relay")).rejects.toThrow(/starting/);
  });

  it.each([
    "https://outside.example.org",
    "//outside.example.org/status",
    "/\\outside",
    "/status\r\nInjected: true",
  ])("refuses an unsafe request target %s", async (path) => {
    const profile = await fixture();
    await expect(requestDesktopGateway(profile, path)).rejects.toThrow(/path/);
  });

  it("never follows a redirect or includes its private error response in errors", async () => {
    const profile = await fixture();
    await serve(profile, (_req, response) => {
      response.writeHead(302, { location: "https://outside.example.org" });
      response.end("a-private-response-value");
    });
    await expect(requestDesktopGateway(profile, "/status")).rejects.toThrow(
      "The local gateway refused the request",
    );
  });
});

describe("desktop runtime port", () => {
  it("preserves one selected nonprivileged port across concurrent preparations", async () => {
    const profile = await fixture();
    const results = await Promise.all([
      prepareDesktopRuntime(profile),
      prepareDesktopRuntime(profile),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.port).toBeGreaterThanOrEqual(1024);
    expect(await readDesktopRuntime(profile)).toEqual(results[0]);
  });

  it("refuses an invalid persisted listener instead of using a default live port", async () => {
    const profile = await fixture();
    await writeFile(
      join(profile.configDir, "runtime.json"),
      JSON.stringify({ version: 1, port: 443 }),
      { mode: 0o600 },
    );
    await expect(readDesktopRuntime(profile)).rejects.toThrow();
  });
});
