// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { markedFileError } from "../test/private-operation-fixture.js";
import { startGatewayCloudTunnel } from "./gateway-integration.js";
import { GatewayTunnel } from "./tunnel-client.js";
import * as credentials from "./google-credentials.js";
import * as privateInputs from "./private-inputs.js";

vi.mock("node:fs", async (original) => {
  const module = await original<typeof import("node:fs")>();
  return { ...module, lstatSync: vi.fn(module.lstatSync) };
});

beforeEach(() => {
  vi.spyOn(privateInputs, "identityArtifactPresent").mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test.each(["ENOTDIR", "EACCES", "EIO"])(
  "owner-key metadata failure %s cannot select Google routing",
  async (code) => {
    vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
    const google = vi.fn(() => Promise.resolve("invented-google-session"));
    vi.spyOn(credentials, "googleRelaySessionSource").mockReturnValue(google);
    vi.spyOn(credentials, "readPrivateJson").mockResolvedValue({ token: "legacy-session" });
    const refused = Object.assign(new Error("Invented owner metadata failure"), { code });
    vi.mocked(privateInputs.identityArtifactPresent).mockRejectedValueOnce(refused);
    const tunnel = startGatewayCloudTunnel("https://localhost:1", {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/metadata-session",
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
      OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/synthetic/google.json",
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-desktop-client",
    })!;
    try {
      const session = (tunnel as unknown as { options: { session: () => Promise<string> } }).options
        .session;
      await expect(session()).rejects.toBe(refused);
      expect(google).not.toHaveBeenCalled();
    } finally {
      tunnel.stop();
    }
  },
);

test("observing an owner entry selects owner routing and never downgrades when the entry later disappears", async () => {
  vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  const owner = Object.assign(
    vi.fn(() => Promise.resolve("invented-owner-session")),
    { invalidate: vi.fn() },
  );
  const keyModule = await import("./gateway-key-client.js");
  vi.spyOn(keyModule, "gatewayKeySessionSource").mockReturnValue(owner);
  const google = vi.fn(() => Promise.resolve("invented-google-session"));
  vi.spyOn(credentials, "googleRelaySessionSource").mockReturnValue(google);
  vi.spyOn(credentials, "readPrivateJson").mockResolvedValue({ token: "legacy-session" });
  vi.mocked(privateInputs.identityArtifactPresent)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const tunnel = startGatewayCloudTunnel("https://localhost:1", {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/observed-owner-session",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
    OMNESIS_TLS_CERT: "/synthetic/cert",
    OMNESIS_TLS_KEY: "/synthetic/key",
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/synthetic/google.json",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-desktop-client",
  })!;
  try {
    const session = (tunnel as unknown as { options: { session: () => Promise<string> } }).options
      .session;
    expect(await session()).toBe("invented-owner-session");
    expect(await session()).toBe("invented-owner-session");
    expect(google).not.toHaveBeenCalled();
  } finally {
    tunnel.stop();
  }
});

test("gateway routing refresh is optional and requires its dedicated Google audience", () => {
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
    OMNESIS_CONFIG_DIR: "/synthetic/explicit-config",
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
      configDir: env.OMNESIS_CONFIG_DIR,
    }),
  );
  key.mockRejectedValueOnce(new Error("lost owner identity"));
  await expect(session(tunnel)).rejects.toThrow("lost owner identity");
  expect(google).not.toHaveBeenCalled();
  // Nobody asked to be told that the relay no longer has this gateway.
  key.mockRejectedValueOnce(new keyModule.GatewayUnregistered());
  await expect(session(tunnel)).rejects.toBeInstanceOf(keyModule.GatewayUnregistered);
  tunnel.stop();
  // Only that answer reaches the listener: a relay that is failing says nothing of the kind.
  stored.mockResolvedValue({ authentication: "gateway-key-v2" });
  const unregistered = vi.fn();
  const watched = startGatewayCloudTunnel("https://localhost:1", env, unregistered)!;
  key.mockRejectedValueOnce(new Error("relay unavailable"));
  await expect(session(watched)).rejects.toThrow("relay unavailable");
  expect(unregistered).not.toHaveBeenCalled();
  key.mockRejectedValueOnce(new keyModule.GatewayUnregistered());
  await expect(session(watched)).rejects.toThrow("no longer has a registration");
  expect(unregistered).toHaveBeenCalledOnce();
  watched.stop();
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

test("a gateway with no relay ID of its own starts no tunnel: no session sources, file reads or sockets", () => {
  const start = vi.spyOn(GatewayTunnel.prototype, "start");
  const source = vi.spyOn(credentials, "googleRelaySessionSource");
  const read = vi.spyOn(credentials, "readPrivateJson");
  for (const env of [
    {},
    { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test" },
    {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: "/must-not-read",
      OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/must-not-read",
    },
    { OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001" },
  ])
    expect(startGatewayCloudTunnel("https://localhost:1", env)).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(source).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test("public ACME routing selects its independent key/origin while incomplete configuration cannot fall back to direct TLS", async () => {
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
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readRelaySession } = await import("./gateway-integration.js");
  const directory = await mkdtemp(join(tmpdir(), "omnesis-legacy-routing-"));
  vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
  try {
    const sessionFile = join(directory, "session.json");
    await core.atomicWriteFile(sessionFile, JSON.stringify({ token: "legacy-routing-token" }), {
      mode: 0o600,
    });
    expect(await readRelaySession(sessionFile)).toBe("legacy-routing-token");
    expect(
      startGatewayCloudTunnel("https://localhost:1", {
        OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      }),
    ).toBeUndefined();
    expect(() =>
      startGatewayCloudTunnel("https://localhost:1", {
        OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000002",
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

test.each(["ENOTDIR", "EACCES", "EIO"])(
  "a synchronous owner metadata failure %s refuses the routing hint before any transport",
  (code) => {
    const failure = Object.assign(new Error("Invented owner metadata refusal"), { code });
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
      throw failure;
    });
    const start = vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
    const google = vi.spyOn(credentials, "googleRelaySessionSource");
    expect(() =>
      startGatewayCloudTunnel("https://localhost:1", {
        OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
        OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/refused-owner/session",
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(failure);
    expect(start).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  },
);

test.each(["own", "cause"] as const)(
  "marked saved-session absence cannot fall through to another routing identity (%s)",
  async (placement) => {
    const failure = markedFileError("ENOENT", placement);
    vi.spyOn(GatewayTunnel.prototype, "start").mockImplementation(() => {});
    const google = vi.fn(() => Promise.resolve("invented-google-routing-session"));
    vi.spyOn(credentials, "googleRelaySessionSource").mockReturnValue(google);
    vi.spyOn(credentials, "readPrivateJson").mockRejectedValueOnce(failure);
    const tunnel = startGatewayCloudTunnel("https://localhost:1", {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/uncertain-routing-session",
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
      OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "/synthetic/google.json",
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "invented-client",
    })!;
    try {
      const session = (tunnel as unknown as { options: { session: () => Promise<string> } }).options
        .session;
      await expect(session()).rejects.toBe(failure);
      expect(google).not.toHaveBeenCalled();
    } finally {
      tunnel.stop();
    }
  },
);
