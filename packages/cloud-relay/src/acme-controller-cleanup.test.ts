// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as bootstrap from "./acme-bootstrap.js";
import { createGatewayAcmeController } from "./acme-integration.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "acme-controller-cleanup-"));
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function environment() {
  return {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_TERMS_ACCEPTED: "1",
    OMNESIS_ACME_CERT_FILE: join(directory, "public.pem"),
    OMNESIS_TLS_CERT: join(directory, "direct.pem"),
    OMNESIS_TLS_KEY: join(directory, "direct.key"),
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
  };
}

test("initialization uncertainty is retained before the controller reaches its caller", async () => {
  const marker = Object.assign(new Error("fixture bootstrap cleanup uncertain"), {
    cleanupFailure: undefined,
  });
  const prepare = vi.spyOn(bootstrap, "ensureAcmeBootstrap").mockRejectedValue(marker);
  const activate = vi.fn(async () => {});
  const controller = (await createGatewayAcmeController(environment(), {
    configDir: directory,
    activate,
  }))!;
  expect(controller.cleanupFailure()).toBe(marker);
  await expect(controller.renew(new AbortController().signal)).rejects.toBe(marker);
  expect(prepare).toHaveBeenCalledOnce();
  expect(activate).not.toHaveBeenCalled();
  const close = controller.close();
  expect(controller.close()).toBe(close);
  await expect(close).rejects.toBe(marker);
});

test("close joins initialization accepted by a renewal and prevents post-close activation", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prepare = vi
    .spyOn(bootstrap, "ensureAcmeBootstrap")
    .mockRejectedValueOnce(new Error("ordinary initial outage"))
    .mockImplementationOnce(async () => {
      entered();
      await gate;
    });
  const activate = vi.fn(async () => {});
  const controller = (await createGatewayAcmeController(environment(), {
    configDir: directory,
    activate,
  }))!;
  const renewal = controller.renew(new AbortController().signal);
  const rejected = expect(renewal).rejects.toThrow();
  await started;
  const close = controller.close();
  expect(controller.close()).toBe(close);
  expect(controller.cleanupFailure()).toMatchObject({ cleanupPending: true });
  release();
  await rejected;
  await expect(close).resolves.toBeUndefined();
  expect(activate).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(controller.cleanupFailure()).toBeUndefined();
  await expect(controller.renew(new AbortController().signal)).rejects.toThrow("closed");
});

test("closed cloudflare initialization never starts the next private-token command", async () => {
  const credentials = await import("./google-credentials.js");
  const read = vi
    .spyOn(credentials, "readPrivateJson")
    .mockRejectedValue(new Error("No private token command is expected"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(bootstrap, "ensureAcmeBootstrap")
    .mockRejectedValueOnce(new Error("ordinary initial outage"))
    .mockImplementationOnce(async () => {
      entered();
      await gate;
    });
  const env = {
    ...environment(),
    OMNESIS_ACME_DNS_PROVIDER: "cloudflare",
    OMNESIS_ACME_DNS_ZONE_ID: "a".repeat(32),
    OMNESIS_ACME_DNS_ZONE_NAME: "example.test",
    OMNESIS_ACME_DNS_TOKEN_FILE: join(directory, "invented-token.json"),
  };
  const controller = (await createGatewayAcmeController(env, {
    configDir: directory,
    activate: async () => {},
  }))!;
  const renewal = controller.renew(new AbortController().signal);
  const refused = expect(renewal).rejects.toThrow();
  await started;
  const close = controller.close();
  release();
  await refused;
  await close;
  expect(read).not.toHaveBeenCalled();
});

test("a finished construction signal cannot poison a later renewal attempt", async () => {
  const construction = new AbortController();
  const prepare = vi
    .spyOn(bootstrap, "ensureAcmeBootstrap")
    .mockRejectedValue(new Error("ordinary fixture outage"));
  const controller = (await createGatewayAcmeController(environment(), {
    configDir: directory,
    activate: async () => {},
    signal: construction.signal,
  }))!;
  construction.abort();
  await expect(controller.renew(new AbortController().signal)).rejects.toThrow(
    "ordinary fixture outage",
  );
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(controller.cleanupFailure()).toBeUndefined();
  await controller.close();
});

test("construction cancellation prevents commands after a completed bootstrap", async () => {
  const credentials = await import("./google-credentials.js");
  const read = vi
    .spyOn(credentials, "readPrivateJson")
    .mockRejectedValue(new Error("No private token command is expected"));
  const construction = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(bootstrap, "ensureAcmeBootstrap").mockImplementationOnce(async () => {
    entered();
    await gate;
  });
  const env = {
    ...environment(),
    OMNESIS_ACME_DNS_PROVIDER: "cloudflare",
    OMNESIS_ACME_DNS_ZONE_ID: "a".repeat(32),
    OMNESIS_ACME_DNS_ZONE_NAME: "example.test",
    OMNESIS_ACME_DNS_TOKEN_FILE: join(directory, "invented-token.json"),
  };
  const pending = createGatewayAcmeController(env, {
    configDir: directory,
    activate: async () => {},
    signal: construction.signal,
  });
  await started;
  construction.abort();
  release();
  const controller = (await pending)!;
  expect(read).not.toHaveBeenCalled();
  expect(controller.cleanupFailure()).toBeUndefined();
  await controller.close();
});
