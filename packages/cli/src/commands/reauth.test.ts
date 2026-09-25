// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { collectReauthCredentials, resolveProviderTarget } from "./reauth.js";
import type { SerializedDescriptor } from "@omnesis/source-sdk";
import type { ConfiguredSourcesSnapshot } from "../utils.js";

const descriptors: SerializedDescriptor[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "",
    provider: { id: "google", name: "Google" },
    authType: "oauth",
    hasAuthFlow: true,
    hasDiscover: true,
    unitName: "emails",
  },
  {
    id: "google-calendar",
    name: "Calendar",
    description: "",
    provider: { id: "google", name: "Google" },
    authType: "oauth",
    hasAuthFlow: true,
    hasDiscover: true,
    unitName: "events",
  },
  {
    id: "google-drive",
    name: "Drive",
    description: "",
    provider: { id: "google", name: "Google" },
    authType: "oauth",
    hasAuthFlow: true,
    hasDiscover: true,
    unitName: "files",
  },
  {
    id: "outlook-email",
    name: "Outlook Email",
    description: "",
    provider: { id: "outlook", name: "Outlook" },
    authType: "oauth",
    hasAuthFlow: true,
    hasDiscover: true,
    unitName: "emails",
  },
] as unknown as SerializedDescriptor[];

function snapshot(configured: Record<string, { enabled: boolean }>): ConfiguredSourcesSnapshot {
  return {
    deviceId: "device-1",
    configured,
  };
}

describe("collectReauthCredentials", () => {
  test("collects replacement fields for a per-account provider", async () => {
    const collect = vi.fn(() =>
      Promise.resolve({
        host: "imap.example.com",
        username: "account@example.com",
        app_password: "replacement-app-password",
      }),
    );
    const descriptor = {
      id: "imap",
      credentials: { fileKey: "imap", perAccount: true },
    } as unknown as SerializedDescriptor;

    const fields = await collectReauthCredentials(descriptor, "device-1", {
      fetchStatus: vi.fn(() =>
        Promise.resolve({
          hostname: "collector.example.com",
          items: [{ fileKey: "imap" }],
        }),
      ) as never,
      sameHost: vi.fn(() => true),
      collect: collect as never,
      interactive: () => true,
      confirmReplace: () => Promise.resolve(true),
    });

    expect(fields).toEqual({
      host: "imap.example.com",
      username: "account@example.com",
      app_password: "replacement-app-password",
    });
    expect(collect).toHaveBeenCalledWith({ fileKey: "imap" }, { sameHost: true, perAccount: true });
  });

  test("defaults to the stored credential, prompting nothing non-interactively", async () => {
    // Zero-prompt reauth is the contract every stored-credential provider
    // relies on (lunchflow, github, coinbase, granola, imap): the auth flow
    // revalidates the stored secret when no fields are supplied.
    const fetchStatus = vi.fn();
    const collect = vi.fn();
    const descriptor = {
      id: "imap",
      credentials: { fileKey: "imap", perAccount: true },
    } as unknown as SerializedDescriptor;

    await expect(
      collectReauthCredentials(descriptor, "device-1", {
        fetchStatus: fetchStatus as never,
        sameHost: vi.fn(),
        collect: collect as never,
        interactive: () => false,
        confirmReplace: () => Promise.reject(new Error("must not prompt non-interactively")),
      }),
    ).resolves.toBeUndefined();
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  test("declining the replacement offer keeps the stored credential", async () => {
    const collect = vi.fn();
    const descriptor = {
      id: "imap",
      credentials: { fileKey: "imap", perAccount: true },
    } as unknown as SerializedDescriptor;

    await expect(
      collectReauthCredentials(descriptor, "device-1", {
        fetchStatus: vi.fn() as never,
        sameHost: vi.fn(),
        collect: collect as never,
        interactive: () => true,
        confirmReplace: () => Promise.resolve(false),
      }),
    ).resolves.toBeUndefined();
    expect(collect).not.toHaveBeenCalled();
  });

  test("does nothing for provider-wide credentials", async () => {
    const fetchStatus = vi.fn();
    const interactive = vi.fn();
    const confirmReplace = vi.fn();
    const descriptor = {
      id: "gmail",
      credentials: { fileKey: "google", perAccount: false },
    } as unknown as SerializedDescriptor;

    await expect(
      collectReauthCredentials(descriptor, "device-1", {
        fetchStatus: fetchStatus as never,
        sameHost: vi.fn(),
        collect: vi.fn() as never,
        interactive,
        confirmReplace,
      }),
    ).resolves.toBeUndefined();
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(interactive).not.toHaveBeenCalled();
    expect(confirmReplace).not.toHaveBeenCalled();
  });
});

describe("resolveProviderTarget", () => {
  test("provider:account form with multiple sources resolves to all siblings", () => {
    const out = resolveProviderTarget(
      "google:user@gmail.com",
      descriptors,
      snapshot({
        "gmail:user@gmail.com": { enabled: true },
        "google-calendar:user@gmail.com": { enabled: true },
        "google-drive:user@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.providerType).toBe("google");
    expect(out!.accountId).toBe("user@gmail.com");
    expect(out!.sources.sort()).toEqual([
      "gmail:user@gmail.com",
      "google-calendar:user@gmail.com",
      "google-drive:user@gmail.com",
    ]);
    // Driver source-type is one of the configured types — alphabetical wins.
    expect(out!.driverSourceType).toBe("gmail");
  });

  test("provider alone resolves when there is exactly one configured account", () => {
    const out = resolveProviderTarget(
      "google",
      descriptors,
      snapshot({
        "gmail:user@gmail.com": { enabled: true },
        "google-calendar:user@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.providerType).toBe("google");
    expect(out!.accountId).toBe("user@gmail.com");
  });

  test("provider alone fails when multiple accounts exist (refuses to guess)", () => {
    const out = resolveProviderTarget(
      "google",
      descriptors,
      snapshot({
        "gmail:user1@gmail.com": { enabled: true },
        "gmail:user2@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeUndefined();
  });

  test("source-type is back-compat: maps to its provider", () => {
    const out = resolveProviderTarget(
      "gmail",
      descriptors,
      snapshot({
        "gmail:user@gmail.com": { enabled: true },
        "google-calendar:user@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.providerType).toBe("google");
    expect(out!.accountId).toBe("user@gmail.com");
    // Heals every Google sibling, not just gmail.
    expect(out!.sources.sort()).toEqual(["gmail:user@gmail.com", "google-calendar:user@gmail.com"]);
  });

  test("source-id is back-compat: collapses to provider+account", () => {
    const out = resolveProviderTarget(
      "gmail:user@gmail.com",
      descriptors,
      snapshot({
        "gmail:user@gmail.com": { enabled: true },
        "google-drive:user@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.providerType).toBe("google");
    expect(out!.accountId).toBe("user@gmail.com");
    expect(out!.sources.sort()).toEqual(["gmail:user@gmail.com", "google-drive:user@gmail.com"]);
  });

  test("provider:account with no configured sources errors out", () => {
    const out = resolveProviderTarget(
      "google:nobody@gmail.com",
      descriptors,
      snapshot({
        "gmail:user@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeUndefined();
  });

  test("unknown provider/source string errors out", () => {
    const out = resolveProviderTarget("weirdthing:foo", descriptors, snapshot({}));
    expect(out).toBeUndefined();
  });

  test("paused siblings are skipped (enabled=false)", () => {
    const out = resolveProviderTarget(
      "google:user@gmail.com",
      descriptors,
      snapshot({
        "gmail:user@gmail.com": { enabled: true },
        "google-calendar:user@gmail.com": { enabled: false },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.sources).toEqual(["gmail:user@gmail.com"]);
  });

  test("cross-account isolation", () => {
    const out = resolveProviderTarget(
      "google:user1@gmail.com",
      descriptors,
      snapshot({
        "gmail:user1@gmail.com": { enabled: true },
        "google-calendar:user2@gmail.com": { enabled: true },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.sources).toEqual(["gmail:user1@gmail.com"]);
  });

  test("cross-provider isolation", () => {
    const out = resolveProviderTarget(
      "google:foo@bar.com",
      descriptors,
      snapshot({
        "gmail:foo@bar.com": { enabled: true },
        "outlook-email:foo@bar.com": { enabled: true },
      }),
    );
    expect(out).toBeDefined();
    expect(out!.sources).toEqual(["gmail:foo@bar.com"]);
  });
});
