// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { startGatewayCloudTunnel } from "./gateway-integration.js";
import { GatewayTunnel } from "./tunnel-client.js";
import * as credentials from "./google-credentials.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("gateway routing refresh is optional and requires its dedicated Google audience", () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_URL", "");
  expect(startGatewayCloudTunnel("https://localhost:1")).toBeUndefined();
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/session.json",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/synthetic/google.json",
  };
  expect(() => startGatewayCloudTunnel("https://localhost:1", env)).toThrow(
    "gateway OAuth client ID",
  );
  const session = vi.fn(async () => "synthetic-relay-session");
  const source = vi.spyOn(credentials, "googleRelaySessionSource").mockReturnValue(session);
  const start = vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  const configured = {
    ...env,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-desktop-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: "/synthetic/desktop-secret.json",
  };
  const tunnel = startGatewayCloudTunnel("https://localhost:1", configured);
  expect(tunnel).toBeInstanceOf(GatewayTunnel);
  expect(source).toHaveBeenCalledExactlyOnceWith({
    relayUrl: env.OMNESIS_CLOUD_RELAY_URL,
    sessionFile: env.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    credentialsFile: env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE,
    clientId: configured.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID,
    clientSecretFile: configured.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE,
  });
  expect(start).toHaveBeenCalledOnce();
  tunnel!.stop();
});

test("key-owned routing stays independent of Google sessions and cannot downgrade after its persisted marker is observed", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  const key = Object.assign(
    vi.fn(async () => "key-session"),
    { invalidate: vi.fn() },
  );
  const keyModule = await import("./gateway-key-client.js");
  const source = vi.spyOn(keyModule, "gatewayKeySessionSource").mockReturnValue(key);
  const google = vi.fn(async () => {
    throw new Error("Google unavailable");
  });
  vi.spyOn(credentials, "googleRelaySessionSource").mockReturnValue(google);
  const stored = vi
    .spyOn(credentials, "readPrivateJson")
    .mockResolvedValue({ authentication: "gateway-key-v2" });
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/key-session",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
    OMNESIS_TLS_CERT: "/synthetic/cert",
    OMNESIS_TLS_KEY: "/synthetic/key",
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/synthetic/google.json",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fixture-desktop",
  };
  function session(tunnel: GatewayTunnel) {
    return (tunnel as unknown as { options: { session: () => Promise<string> } }).options.session();
  }
  const tunnel = startGatewayCloudTunnel("https://localhost:1", env)!;
  expect(await session(tunnel)).toBe("key-session");
  stored.mockResolvedValue({ token: "legacy-google-session" });
  expect(await session(tunnel)).toBe("key-session");
  expect(google).not.toHaveBeenCalled();
  expect(source).toHaveBeenCalledWith(
    expect.objectContaining({
      certificateFile: env.OMNESIS_TLS_CERT,
      privateKeyFile: env.OMNESIS_TLS_KEY,
    }),
  );
  key.mockRejectedValueOnce(new Error("lost owner identity"));
  await expect(session(tunnel)).rejects.toThrow("lost owner identity");
  expect(google).not.toHaveBeenCalled();
  tunnel.stop();
  stored.mockResolvedValue({ authentication: "gateway-key-v2" });
  const missing = startGatewayCloudTunnel("https://localhost:1", {
    ...env,
    OMNESIS_TLS_KEY: undefined,
  })!;
  await expect(session(missing)).rejects.toThrow("Owner-key routing requires");
  missing.stop();
  stored.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const fresh = startGatewayCloudTunnel("https://localhost:1", {
    ...env,
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: undefined,
  })!;
  expect(await session(fresh)).toBe("key-session");
  fresh.stop();
  const explicit = startGatewayCloudTunnel("https://localhost:1", {
    ...env,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: "/synthetic/owner",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: undefined,
  })!;
  expect(await session(explicit)).toBe("key-session");
  explicit.stop();
  stored.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const legacy = startGatewayCloudTunnel("https://localhost:1", env)!;
  await expect(session(legacy)).rejects.toThrow("Google unavailable");
  legacy.stop();
  expect(google).toHaveBeenCalledOnce();
  stored.mockRejectedValue(new Error("invalid private JSON"));
  const corrupt = startGatewayCloudTunnel("https://localhost:1", env)!;
  await expect(session(corrupt)).rejects.toThrow("invalid private JSON");
  corrupt.stop();
});

test("disabled experimental transport ignores relay configuration without session sources, file reads or sockets", () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  const start = vi.spyOn(GatewayTunnel.prototype, "start");
  const source = vi.spyOn(credentials, "googleRelaySessionSource");
  const read = vi.spyOn(credentials, "readPrivateJson");
  expect(
    startGatewayCloudTunnel("https://localhost:1", {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: "/must-not-read",
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "invalid",
      OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/must-not-read",
    }),
  ).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(source).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test("public ACME routing selects its independent key/origin while incomplete configuration cannot fall back to direct TLS", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  const module = await import("./gateway-key-client.js"),
    source = vi
      .spyOn(module, "gatewayKeySessionSource")
      .mockReturnValue(Object.assign(async () => "owner-token", { invalidate: vi.fn() }));
  vi.spyOn(credentials, "readPrivateJson").mockResolvedValue({ authentication: "gateway-key-v2" });
  const base = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/session",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_CERT_FILE: "/synthetic/public.crt",
    OMNESIS_TLS_CERT: "/synthetic/direct.crt",
    OMNESIS_TLS_KEY: "/synthetic/direct.key",
    OMNESIS_PUBLIC_BASE_URL: "https://direct.example.test",
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://public.example.test",
  };
  const first = startGatewayCloudTunnel("https://localhost:1", base)!;
  expect(source).toHaveBeenLastCalledWith(
    expect.objectContaining({
      certificateFile: base.OMNESIS_ACME_CERT_FILE,
      privateKeyFile: `${base.OMNESIS_ACME_CERT_FILE}.key`,
      publicOrigin: base.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN,
    }),
  );
  first.stop();
  const explicit = startGatewayCloudTunnel("https://localhost:1", {
    ...base,
    OMNESIS_ACME_KEY_FILE: "/synthetic/stable-public.key",
  })!;
  expect(source).toHaveBeenLastCalledWith(
    expect.objectContaining({ privateKeyFile: "/synthetic/stable-public.key" }),
  );
  explicit.stop();
  const missing = startGatewayCloudTunnel("https://localhost:1", {
    ...base,
    OMNESIS_ACME_CERT_FILE: undefined,
  })!;
  await expect(
    (missing as unknown as { options: { session: () => Promise<string> } }).options.session(),
  ).rejects.toThrow("Owner-key routing requires");
  missing.stop();
});

test("tunnel401 invalidation is wired only to key-owned authority, preserving legacy identity sources", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  const module = await import("./gateway-key-client.js");
  const key = Object.assign(
    vi.fn(async () => "owner-token"),
    { invalidate: vi.fn() },
  );
  const source = vi.spyOn(module, "gatewayKeySessionSource").mockReturnValue(key);
  const read = vi
    .spyOn(credentials, "readPrivateJson")
    .mockResolvedValue({ authentication: "gateway-key-v2" });
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/session",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
    OMNESIS_TLS_CERT: "/synthetic/public.crt",
    OMNESIS_TLS_KEY: "/synthetic/stable.key",
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE: "/synthetic/recovery.json",
  };
  const tunnel = startGatewayCloudTunnel("https://localhost:1", env)!;
  const configured = (
    tunnel as unknown as {
      options: {
        session: (signal?: AbortSignal) => Promise<string>;
        invalidateSession: () => void;
      };
    }
  ).options;
  const abort = new AbortController();
  await configured.session(abort.signal);
  expect(key).toHaveBeenCalledWith(abort.signal);
  configured.invalidateSession();
  expect(key.invalidate).toHaveBeenCalledOnce();
  expect(source).toHaveBeenCalledWith(
    expect.objectContaining({ recoveryReceiptFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE }),
  );
  tunnel.stop();
  read.mockResolvedValue({ token: "legacy" });
  const legacy = startGatewayCloudTunnel("https://localhost:1", {
    ...env,
    OMNESIS_TLS_KEY: undefined,
  })!;
  (legacy as unknown as { options: { invalidateSession: () => void } }).options.invalidateSession();
  expect(key.invalidate).toHaveBeenCalledOnce();
  legacy.stop();
  const missing = startGatewayCloudTunnel("https://localhost:1", {
    ...env,
    OMNESIS_TLS_KEY: undefined,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: "/synthetic/lost-owner",
  })!;
  (
    missing as unknown as { options: { invalidateSession: () => void } }
  ).options.invalidateSession();
  missing.stop();
});

test("legacy session-file transport reads valid local records and rejects incomplete gateway configuration", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readRelaySession } = await import("./gateway-integration.js");
  const directory = await mkdtemp(join(tmpdir(), "omnesis-legacy-routing-"));
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  try {
    const sessionFile = join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({ token: "legacy-routing-token" }));
    expect(await readRelaySession(sessionFile)).toBe("legacy-routing-token");
    expect(() =>
      startGatewayCloudTunnel("https://localhost:1", {
        OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      }),
    ).toThrow("requires a session file");
    const tunnel = startGatewayCloudTunnel("https://localhost:1", {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
    })!;
    expect(
      await (
        tunnel as unknown as { options: { session: () => Promise<string> } }
      ).options.session(),
    ).toBe("legacy-routing-token");
    tunnel.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
