// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import {
  anotherEnabledKeyAddresses,
  configKeyAddressesSource,
  isSourceEnabled,
  SourceConfigReconciler,
} from "./source-config-reconciler.js";
import type { CollectorInternalConfig } from "./internal-config.js";
import type { RegisteredSource, SyncEngine } from "./sync-engine.js";

/**
 * `configKeyAddressesSource` is the predicate every teardown path routes
 * through — unregister, disable, credential cleanup. Its whole job is to keep
 * two accounts of one source type independent, so the account-qualified cases
 * below are the contract, not incidental coverage.
 */
describe("configKeyAddressesSource", () => {
  test("an account-qualified key addresses only its own account", () => {
    expect(configKeyAddressesSource("gmail:alice@example.com", "gmail:alice@example.com")).toBe(
      true,
    );
    expect(configKeyAddressesSource("gmail:alice@example.com", "gmail:bob@example.com")).toBe(
      false,
    );
  });

  test("a bare key addresses every account under its type", () => {
    expect(configKeyAddressesSource("gmail", "gmail:alice@example.com")).toBe(true);
    expect(configKeyAddressesSource("gmail", "gmail:bob@example.com")).toBe(true);
  });

  test("a key never addresses a different source type", () => {
    expect(configKeyAddressesSource("gmail", "google-calendar:alice@example.com")).toBe(false);
    expect(
      configKeyAddressesSource("gmail:alice@example.com", "google-calendar:alice@example.com"),
    ).toBe(false);
  });

  test("a source type that prefixes another is not addressed by it", () => {
    // `notion` must not match `notion-databases:...` — the guard is the colon.
    expect(configKeyAddressesSource("notion", "notion-databases:workspace-1")).toBe(false);
  });

  test("an account-less source id is addressed by its bare key", () => {
    expect(configKeyAddressesSource("things", "things")).toBe(true);
    expect(configKeyAddressesSource("things", "things:local")).toBe(true);
  });

  test("a malformed source id yields false rather than throwing", () => {
    // Teardown loops call this per live source. A throw would abort the loop
    // partway, leaving the collector to re-run it on every snapshot.
    for (const malformed of ["", ":", "gmail:", "gmail:a:b", ":alice@example.com"]) {
      expect(() => configKeyAddressesSource("gmail", malformed)).not.toThrow();
    }
    expect(configKeyAddressesSource("gmail", "gmail:a:b")).toBe(true);
    expect(configKeyAddressesSource("gmail", "")).toBe(false);
  });
});

describe("isSourceEnabled", () => {
  test("only enabled entries match", () => {
    expect(
      isSourceEnabled("gmail:alice@example.com", {
        "gmail:alice@example.com": { enabled: false },
      }),
    ).toBe(false);
    expect(
      isSourceEnabled("gmail:alice@example.com", {
        "gmail:alice@example.com": { enabled: true },
      }),
    ).toBe(true);
  });

  test("a disabled account does not borrow its sibling's enabled flag", () => {
    expect(
      isSourceEnabled("gmail:bob@example.com", {
        "gmail:alice@example.com": { enabled: true },
        "gmail:bob@example.com": { enabled: false },
      }),
    ).toBe(false);
  });
});

describe("anotherEnabledKeyAddresses", () => {
  test("a sibling account does not keep another account's instance alive", () => {
    const sources = {
      "gmail:alice@example.com": { enabled: true },
      "gmail:bob@example.com": { enabled: true },
    };
    expect(
      anotherEnabledKeyAddresses(sources, "gmail:alice@example.com", "gmail:alice@example.com"),
    ).toBe(false);
  });

  test("a bare key keeps an account-qualified instance alive", () => {
    const sources = {
      gmail: { enabled: true },
      "gmail:alice@example.com": { enabled: true },
    };
    expect(
      anotherEnabledKeyAddresses(sources, "gmail:alice@example.com", "gmail:alice@example.com"),
    ).toBe(true);
  });

  test("a disabled other key does not keep an instance alive", () => {
    const sources = {
      gmail: { enabled: false },
      "gmail:alice@example.com": { enabled: true },
    };
    expect(
      anotherEnabledKeyAddresses(sources, "gmail:alice@example.com", "gmail:alice@example.com"),
    ).toBe(false);
  });

  test("the excluded key never counts as another key", () => {
    const sources = { "gmail:alice@example.com": { enabled: true } };
    expect(
      anotherEnabledKeyAddresses(sources, "gmail:alice@example.com", "gmail:alice@example.com"),
    ).toBe(false);
  });

  test("an absent sources map is handled", () => {
    expect(anotherEnabledKeyAddresses(undefined, "gmail:alice@example.com", "gmail")).toBe(false);
  });
});

describe("SourceConfigReconciler multi-device mode", () => {
  test("the gateway snapshot overrides the descriptor before first sync and updates a live source", async () => {
    let source: RegisteredSource | undefined;
    const retainedModes = new Map<string, "exclusive" | "handoff" | "replicated" | "partitioned">();
    const descriptorSource = {
      id: "notes:local",
      name: "Notes",
      providerId: "notes-provider",
      multiDeviceMode: "exclusive",
      instance: {},
    } as unknown as RegisteredSource;
    const config: CollectorInternalConfig = {};
    const registeredKeys = new Set<string>();
    const startedModes: Array<string | undefined> = [];
    const engine = {
      getStatuses: () => [],
      unhostedEntries: () => [],
      getSourcesById: (id: string) => (id === source?.id ? [source] : []),
      updateSyncIntervals: vi.fn(),
      startSourceSyncLoops: vi.fn(async (sources: RegisteredSource[]) => {
        startedModes.push(sources[0]?.multiDeviceMode);
      }),
    } as unknown as SyncEngine;
    const reconciler = new SourceConfigReconciler({
      getConfig: () => config,
      getRegisteredKeys: () => registeredKeys,
      engine,
      setMultiDeviceMode: (id, mode) => retainedModes.set(id, mode),
      clearMultiDeviceMode: (id) => retainedModes.delete(id),
      setupSources: vi.fn(async () => {
        source = {
          ...descriptorSource,
          multiDeviceMode: retainedModes.get(descriptorSource.id) ?? "exclusive",
        } as unknown as RegisteredSource;
        return [];
      }),
      findSourcesForKeys: () => (source ? [source] : []),
      saveConfig: vi.fn(),
    });

    await reconciler.applySnapshot([
      { id: descriptorSource.id, enabled: true, multiDeviceMode: "partitioned" },
    ]);
    expect(startedModes).toEqual(["partitioned"]);
    expect(source?.multiDeviceMode).toBe("partitioned");

    await reconciler.applySnapshot([
      { id: descriptorSource.id, enabled: true, multiDeviceMode: "handoff" },
    ]);
    expect(source?.multiDeviceMode).toBe("handoff");
  });
});

describe("SourceConfigReconciler effective config replacement", () => {
  test("concurrent duplicate snapshots serialize one replacement and each config change restarts once", async () => {
    const source = {
      id: "sessions:local",
      name: "Sessions",
      providerId: "sessions-provider",
      instance: {},
    } as unknown as RegisteredSource;
    const config: CollectorInternalConfig & {
      sources: NonNullable<CollectorInternalConfig["sources"]>;
    } = {
      sources: {
        "sessions:local": {
          enabled: true,
          params: { sessionsPath: "/srv/fictional-alpha/sessions" },
        },
      },
    };
    const registeredKeys = new Set(["sessions:local"]);
    const setupSources = vi.fn(async () => []);
    const startSourceSyncLoops = vi.fn(async () => undefined);
    const engine = {
      getStatuses: () => [{ sourceId: source.id, state: "idle" }],
      unhostedEntries: () => [],
      getSourcesById: (id: string) => (id === source.id ? [source] : []),
      updateSyncIntervals: vi.fn(),
      startSourceSyncLoops,
    } as unknown as SyncEngine;
    const reconciler = new SourceConfigReconciler({
      getConfig: () => config,
      getRegisteredKeys: () => registeredKeys,
      engine,
      setupSources,
      findSourcesForKeys: () => [source],
      saveConfig: vi.fn(),
    });
    const changed = [
      {
        id: source.id,
        enabled: true,
        config: {
          enabled: true,
          params: { sessionsPath: "/srv/fictional-beta/sessions" },
        },
      },
    ];

    await Promise.all([reconciler.applySnapshot(changed), reconciler.applySnapshot(changed)]);

    expect(setupSources).toHaveBeenCalledOnce();
    expect(setupSources).toHaveBeenCalledWith(
      {
        "sessions:local": {
          enabled: true,
          params: { sessionsPath: "/srv/fictional-beta/sessions" },
        },
      },
      ["sessions:local"],
    );
    expect(startSourceSyncLoops).toHaveBeenCalledOnce();
    expect(config.sources["sessions:local"]?.params?.sessionsPath).toBe(
      "/srv/fictional-beta/sessions",
    );

    await reconciler.applySnapshot([
      {
        id: source.id,
        enabled: true,
        config: {
          enabled: true,
          maxAge: "30d",
          params: { sessionsPath: "/srv/fictional-beta/sessions" },
        },
      },
    ]);

    expect(setupSources).toHaveBeenCalledTimes(2);
    expect(startSourceSyncLoops).toHaveBeenCalledTimes(2);
    expect(config.sources["sessions:local"]?.maxAge).toBe("30d");
  });
});
