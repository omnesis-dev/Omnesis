// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  enrollDesktopRole,
  type DesktopEnrollmentEvent,
  type DesktopEnrollmentUI,
  type DesktopPairing,
} from "./enrollment.js";
import type { authorizeAccountDesktop, pairAccountDevice } from "@omnesis/cloud-relay";

const origin = "https://library.example.test";
const choice = {
  gatewayId: "00000000-0000-4000-8000-000000000001",
  publicOrigin: origin,
  online: true,
};
const credential: DesktopPairing = {
  gatewayUrl: origin,
  gatewayFingerprint: "a".repeat(64),
  gatewayCertificate: "fictional-public-certificate",
  token: "fictional-private-token",
  deviceId: "00000000-0000-4000-8000-000000000002",
  kind: "cli",
  scopes: ["admin", "read"],
};

function fixture() {
  const controller = new AbortController();
  const events: DesktopEnrollmentEvent[] = [];
  const ui: DesktopEnrollmentUI = {
    openBrowser: vi.fn(async () => {}),
    connectCode: vi.fn(),
    chooseGateway: vi.fn(async () => choice.gatewayId),
    compareCode: vi.fn(async () => true),
  };
  const options = {
    role: "interactive" as const,
    relayUrl: "https://relay.example.test",
    name: "fictional-mac",
    deviceKeyFile: "/tmp/fictional-desktop.key",
    signal: controller.signal,
    ui,
    onEvent: (event: DesktopEnrollmentEvent) => events.push(event),
  };
  return { controller, events, ui, options };
}

test("keeps interactive and collector enrollment in their existing least-authority roles", async () => {
  const f = fixture();
  const pair = vi.fn<typeof pairAccountDevice>(async (options) => ({
    ...credential,
    kind: options.kind,
  }));
  await enrollDesktopRole(f.options, { pair });
  await enrollDesktopRole(
    { ...f.options, role: "collector", deviceKeyFile: "/tmp/fictional-collector.key" },
    { pair },
  );
  expect(pair.mock.calls.map(([options]) => [options.kind, options.deviceKeyFile])).toEqual([
    ["cli", "/tmp/fictional-desktop.key"],
    ["collector", "/tmp/fictional-collector.key"],
  ]);
  for (const [options] of pair.mock.calls) {
    expect(options).not.toHaveProperty("scopes");
    expect(options.requireEncryptedStorage).toBe(true);
  }
  expect(f.events).toEqual([
    { role: "interactive", phase: "signing-in" },
    { role: "interactive", phase: "connected" },
    { role: "collector", phase: "signing-in" },
    { role: "collector", phase: "connected" },
  ]);
  expect(JSON.stringify(f.events)).not.toContain(credential.token);
});

test("forwards browser launch, connect code, choice and comparison through native hooks", async () => {
  const f = fixture();
  const code = { connectUrl: "https://relay.example.test/_relay/connect", code: "ABCD-EFGH" };
  const comparison = { gatewayUrl: origin, verificationCode: "123 456" };
  const authorize = vi.fn<typeof authorizeAccountDesktop>(async (options, deps) => {
    await deps?.openBrowser?.(
      "https://relay.example.test/_relay/v3/desktop/begin",
      options.relayUrl,
    );
    options.onConnectCode?.(code);
    return {
      status: "approved",
      accountId: "a".repeat(64),
      discoveryToken: "fictional-discovery",
      expiresAt: 1,
    };
  });
  const pair = vi.fn<typeof pairAccountDevice>(async (options, deps) => {
    await deps?.authorize?.({
      relayUrl: options.relayUrl,
      kind: options.kind,
      name: options.name,
      nonce: "a".repeat(43),
      signal: options.signal!,
      onConnectCode: options.onConnectCode,
    });
    expect(await options.selectGateway([choice], options.signal!)).toBe(choice.gatewayId);
    expect(await options.confirm(comparison, options.signal!)).toBe(true);
    return credential;
  });
  expect(await enrollDesktopRole(f.options, { pair, authorize })).toBe(credential);
  expect(f.ui.openBrowser).toHaveBeenCalledWith(
    "https://relay.example.test/_relay/v3/desktop/begin",
    f.controller.signal,
  );
  expect(f.ui.connectCode).toHaveBeenCalledWith(code);
  expect(f.ui.chooseGateway).toHaveBeenCalledWith([choice], f.controller.signal);
  expect(f.ui.compareCode).toHaveBeenCalledWith(comparison, f.controller.signal);
  expect(f.events.map((event) => event.phase)).toEqual([
    "signing-in",
    "choosing",
    "comparing",
    "finishing",
    "connected",
  ]);
});

describe.each(["browser", "choice", "comparison"] as const)("cancel during %s", (stage) => {
  test("releases an unanswered native prompt and never reports connected", async () => {
    const f = fixture();
    const reason = new Error("Cancelled enrollment");
    const waitForCancel = () => {
      f.controller.abort(reason);
      return new Promise<never>(() => {});
    };
    const authorize = vi.fn<typeof authorizeAccountDesktop>(async (options, deps) => {
      await deps?.openBrowser?.(
        "https://relay.example.test/_relay/v3/desktop/begin",
        options.relayUrl,
      );
      throw new Error("Unexpected completed browser");
    });
    const pair = vi.fn<typeof pairAccountDevice>(async (options, deps) => {
      if (stage === "browser") {
        f.ui.openBrowser = vi.fn(waitForCancel);
        await deps?.authorize?.({
          relayUrl: options.relayUrl,
          kind: options.kind,
          name: options.name,
          nonce: "a".repeat(43),
          signal: options.signal!,
        });
      } else if (stage === "choice") {
        f.ui.chooseGateway = vi.fn(waitForCancel);
        await options.selectGateway([choice], options.signal!);
      } else {
        f.ui.compareCode = vi.fn(waitForCancel);
        await options.confirm({ gatewayUrl: origin, verificationCode: "123 456" }, options.signal!);
      }
      return credential;
    });
    await expect(enrollDesktopRole(f.options, { pair, authorize })).rejects.toBe(reason);
    expect(f.events.at(-1)?.phase).toBe("cancelled");
    expect(f.events.some((event) => event.phase === "connected")).toBe(false);
  });
});

test("does not begin an already cancelled enrollment", async () => {
  const f = fixture();
  f.controller.abort();
  const pair = vi.fn<typeof pairAccountDevice>();
  await expect(enrollDesktopRole(f.options, { pair })).rejects.toThrow();
  expect(pair).not.toHaveBeenCalled();
  expect(f.events).toEqual([{ role: "interactive", phase: "cancelled" }]);
});

test("a failed or declined enrollment exposes only its phase to events", async () => {
  const f = fixture();
  const secretError = new Error("fictional-private-detail");
  const pair = vi.fn<typeof pairAccountDevice>(async (options) => {
    f.ui.compareCode = vi.fn(async () => false);
    expect(
      await options.confirm({ gatewayUrl: origin, verificationCode: "123 456" }, options.signal!),
    ).toBe(false);
    throw secretError;
  });
  await expect(enrollDesktopRole(f.options, { pair })).rejects.toBe(secretError);
  expect(f.events.map((event) => event.phase)).toEqual(["signing-in", "comparing", "failed"]);
  expect(JSON.stringify(f.events)).not.toContain(secretError.message);
});

test("a late pairing result after cancellation cannot be saved as connected", async () => {
  const f = fixture();
  const pair = vi.fn<typeof pairAccountDevice>(async () => {
    f.controller.abort();
    return credential;
  });
  await expect(enrollDesktopRole(f.options, { pair })).rejects.toThrow();
  expect(f.events.map((event) => event.phase)).toEqual(["signing-in", "cancelled"]);
});

test("retirement can refuse signing-key publication before enrollment opens a browser", async () => {
  const f = fixture();
  const retired = new Error("The managed installation retired");
  const publication = vi.fn(async () => {
    throw retired;
  });
  const pair = vi.fn<typeof pairAccountDevice>(async (options, deps) => {
    await deps!.readDeviceKey!(options.deviceKeyFile, options.deviceKeySecretOptions);
    return credential;
  });
  await expect(
    enrollDesktopRole({ ...f.options, deviceKeyPublication: publication }, { pair }),
  ).rejects.toBe(retired);
  expect(publication).toHaveBeenCalledOnce();
  expect(f.ui.openBrowser).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.phase).toBe("failed");
});
