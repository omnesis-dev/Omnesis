// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { AccountId, SourceType, type DeviceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  setSourceMemberConfigOverride,
} from "../../data/repositories/SourceRepository.js";
import { initializeOrAssertSourceMemberConfigContract } from "../../data/repositories/SourceMemberConfigContractRepository.js";
import { directWriteGate } from "../../write-gate.js";
import {
  ConfigChangeOrchestrator,
  type ConfigChangeOrchestratorDeps,
} from "./ConfigChangeOrchestrator.js";
import type { ConfigStore } from "../../config-store.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { DeviceWsServer } from "../../ws.js";

type ChangeListener = (
  before: OmnesisConfig,
  after: OmnesisConfig,
  changedPaths: string[],
) => void | Promise<void>;

/**
 * Build an orchestrator wired to spy swap functions and a fake configStore
 * that captures its onChange listeners so a test can fire the model-switch one
 * directly. The model-switch listener is the 4th registered (after reconcile,
 * broadcast, and cutoffs) — see register().
 */
function harness() {
  const listeners: ChangeListener[] = [];
  const configStore = {
    onChange: (cb: ChangeListener) => listeners.push(cb),
    getStatus: () => ({ version: 1 }),
  } as unknown as ConfigStore;

  const applyAgentSwap = vi.fn(async () => {});
  const applyEmbedSwap = vi.fn(async () => {});
  const loadConfig = vi.fn();

  const deps: ConfigChangeOrchestratorDeps = {
    db: {} as ConfigChangeOrchestratorDeps["db"],
    writeGate: {} as ConfigChangeOrchestratorDeps["writeGate"],
    getIndexerProxy: () => null,
    inferenceRegistry: {
      loadConfig,
    } as unknown as ConfigChangeOrchestratorDeps["inferenceRegistry"],
    applyEmbedSwap,
    applyAgentSwap,
  };

  const orchestrator = new ConfigChangeOrchestrator(deps);
  orchestrator.register(configStore);
  // reconcile (0), broadcast (1), cutoffs (2), model-switch (3).
  const modelSwitch = listeners[3];
  return { modelSwitch, applyAgentSwap, loadConfig };
}

function config(allowRemoteInference: boolean): OmnesisConfig {
  return {
    inference: {
      allowRemoteInference,
      assignments: { agent: "anthropic/claude-sonnet-4-6" },
    },
  } as OmnesisConfig;
}

describe("ConfigChangeOrchestrator — agent hot reload", () => {
  test("re-swaps the cached agent when the flag flips, without any assignment change", () => {
    const { modelSwitch, applyAgentSwap, loadConfig } = harness();

    // ON → OFF: the assignment strings are identical; only the flag changed.
    modelSwitch(config(true), config(false), []);

    expect(applyAgentSwap).toHaveBeenCalledTimes(1);
    // The registry is refreshed first so the rebuilt backend resolves against
    // the new egress flag.
    expect(loadConfig).toHaveBeenCalledWith(config(false));
  });

  test("does not re-swap when neither the flag nor any assignment changed", () => {
    const { modelSwitch, applyAgentSwap } = harness();

    modelSwitch(config(true), config(true), []);

    expect(applyAgentSwap).not.toHaveBeenCalled();
  });

  test("re-swaps the cached agent when its model behavior changes", () => {
    const { modelSwitch, applyAgentSwap, loadConfig } = harness();
    const before = config(true);
    const after = {
      ...config(true),
      inference: {
        ...config(true).inference,
        modelSettings: {
          agent: {
            assignment: "anthropic/claude-sonnet-4-6",
            values: { reasoningEffort: "high" },
          },
        },
      },
    } as OmnesisConfig;

    modelSwitch(before, after, ["/inference/modelSettings/agent"]);

    expect(loadConfig).toHaveBeenCalledWith(after);
    expect(applyAgentSwap).toHaveBeenCalledTimes(1);
  });
});

describe("ConfigChangeOrchestrator — source reconciliation", () => {
  test.each([{ additional: [] }, { additional: ["cachePath"] }])(
    "a live config edit preserves member privacy with additive fields $additional",
    async ({ additional }) => {
      const db = createDatabase(":memory:");
      try {
        const type = SourceType("notes-synth");
        const capabilities = {
          hostableSourceTypes: [type],
          multiDeviceModes: { [type]: "partitioned" as const },
          memberScopedParams: { [type]: ["sessionsPath"] },
        };
        const owner = createDevice(db, {
          name: "collector-owner",
          kind: "collector",
          capabilities,
        });
        const sibling = createDevice(db, {
          name: "collector-sibling",
          kind: "collector",
          capabilities,
        });
        const source = createSource(db, {
          type,
          accountId: AccountId("fictional-team"),
          deviceId: owner.id,
          multiDeviceMode: "partitioned",
          config: { params: { sharedLabel: "fictional-team" } },
        });
        initializeOrAssertSourceMemberConfigContract(db, source.id, ["sessionsPath"]);
        setSourceMemberConfigOverride(db, source.id, owner.id, {
          params: { sessionsPath: "/srv/fictional-owner/sessions" },
        });
        addSourceMember(db, source.id, sibling.id);
        updateDeviceCapabilities(db, sibling.id, {
          ...capabilities,
          memberScopedParams: { [type]: ["sessionsPath", ...additional] },
        });

        const listeners: ChangeListener[] = [];
        const configStore = {
          onChange: (cb: ChangeListener) => listeners.push(cb),
          getStatus: () => ({ version: 2 }),
        } as unknown as ConfigStore;
        const sendCommand = vi.fn((_deviceId: DeviceId) => Promise.resolve({ ok: true }));
        const orchestrator = new ConfigChangeOrchestrator({
          db,
          writeGate: directWriteGate(db),
          getIndexerProxy: () => null,
          inferenceRegistry: {
            loadConfig: vi.fn(),
          } as unknown as ConfigChangeOrchestratorDeps["inferenceRegistry"],
          applyEmbedSwap: async () => {},
          applyAgentSwap: async () => {},
        });
        orchestrator.attachServer({
          sendCommand,
          broadcast: vi.fn(),
        } as unknown as DeviceWsServer);
        orchestrator.register(configStore);

        await listeners[0]?.(
          {},
          {
            sources: {
              [source.id]: {
                params: {
                  sharedLabel: "fictional-updated-team",
                  sessionsPath: "/srv/stale-file/sessions",
                },
              },
            },
          },
          [`/sources/${source.id}/params/sharedLabel`],
        );

        expect(sendCommand).toHaveBeenCalledWith(owner.id, "source.updated", {
          source: expect.objectContaining({
            config: {
              params: {
                sharedLabel: "fictional-updated-team",
                sessionsPath: "/srv/fictional-owner/sessions",
              },
            },
          }),
        });
        expect(sendCommand).toHaveBeenCalledWith(sibling.id, "source.updated", {
          source: expect.objectContaining({
            config: { params: { sharedLabel: "fictional-updated-team" } },
          }),
        });
      } finally {
        db.close();
      }
    },
  );

  test("a live config edit does not reactivate a member with a mismatched pinned contract", async () => {
    const db = createDatabase(":memory:");
    try {
      const type = SourceType("notes-synth");
      const capabilities = {
        hostableSourceTypes: [type],
        multiDeviceModes: { [type]: "partitioned" as const },
        memberScopedParams: { [type]: ["sessionsPath"] },
      };
      const owner = createDevice(db, {
        name: "collector-compatible",
        kind: "collector",
        capabilities,
      });
      const sibling = createDevice(db, {
        name: "collector-downgraded",
        kind: "collector",
        capabilities,
      });
      const source = createSource(db, {
        type,
        accountId: AccountId("fictional-contract-edit"),
        deviceId: owner.id,
        multiDeviceMode: "partitioned",
        config: { syncInterval: "5m" },
      });
      initializeOrAssertSourceMemberConfigContract(db, source.id, ["sessionsPath"]);
      addSourceMember(db, source.id, sibling.id);
      updateDeviceCapabilities(db, sibling.id, {
        ...capabilities,
        memberScopedParams: { [type]: [] },
      });

      const listeners: ChangeListener[] = [];
      const configStore = {
        onChange: (cb: ChangeListener) => listeners.push(cb),
        getStatus: () => ({ version: 2 }),
      } as unknown as ConfigStore;
      const sendCommand = vi.fn((_deviceId: DeviceId) => Promise.resolve({ ok: true }));
      const orchestrator = new ConfigChangeOrchestrator({
        db,
        writeGate: directWriteGate(db),
        getIndexerProxy: () => null,
        inferenceRegistry: {
          loadConfig: vi.fn(),
        } as unknown as ConfigChangeOrchestratorDeps["inferenceRegistry"],
        applyEmbedSwap: async () => {},
        applyAgentSwap: async () => {},
      });
      orchestrator.attachServer({ sendCommand, broadcast: vi.fn() } as unknown as DeviceWsServer);
      orchestrator.register(configStore);

      await listeners[0]?.({}, { sources: { [source.id]: { syncInterval: "10m" } } }, [
        `/sources/${source.id}/syncInterval`,
      ]);

      expect(sendCommand).toHaveBeenCalledWith(owner.id, "source.updated", expect.anything());
      expect(sendCommand.mock.calls.some(([deviceId]) => deviceId === sibling.id)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a live config edit does not reactivate a replica missing its pinned row-version policy", async () => {
    const db = createDatabase(":memory:");
    try {
      const type = SourceType("tasks-synth");
      const capabilities = {
        hostableSourceTypes: [type],
        multiDeviceModes: { [type]: "replicated" as const },
        replicaVersionPolicies: { [type]: "source-updated-at" as const },
        memberScopedParams: { [type]: [] },
        syncLease: true,
      };
      const owner = createDevice(db, {
        name: "collector-compatible",
        kind: "collector",
        capabilities,
      });
      const sibling = createDevice(db, {
        name: "collector-downgraded",
        kind: "collector",
        capabilities,
      });
      const source = createSource(db, {
        type,
        accountId: AccountId("fictional-version-edit"),
        deviceId: owner.id,
        multiDeviceMode: "replicated",
        replicaVersionPolicy: "source-updated-at",
        config: { syncInterval: "5m" },
      });
      initializeOrAssertSourceMemberConfigContract(db, source.id, []);
      addSourceMember(db, source.id, sibling.id);
      updateDeviceCapabilities(db, sibling.id, {
        ...capabilities,
        replicaVersionPolicies: {},
      });

      const listeners: ChangeListener[] = [];
      const configStore = {
        onChange: (cb: ChangeListener) => listeners.push(cb),
        getStatus: () => ({ version: 2 }),
      } as unknown as ConfigStore;
      const sendCommand = vi.fn((_deviceId: DeviceId) => Promise.resolve({ ok: true }));
      const orchestrator = new ConfigChangeOrchestrator({
        db,
        writeGate: directWriteGate(db),
        getIndexerProxy: () => null,
        inferenceRegistry: {
          loadConfig: vi.fn(),
        } as unknown as ConfigChangeOrchestratorDeps["inferenceRegistry"],
        applyEmbedSwap: async () => {},
        applyAgentSwap: async () => {},
      });
      orchestrator.attachServer({ sendCommand, broadcast: vi.fn() } as unknown as DeviceWsServer);
      orchestrator.register(configStore);

      await listeners[0]?.({}, { sources: { [source.id]: { syncInterval: "10m" } } }, [
        `/sources/${source.id}/syncInterval`,
      ]);

      expect(sendCommand).toHaveBeenCalledWith(owner.id, "source.updated", expect.anything());
      expect(sendCommand.mock.calls.some(([deviceId]) => deviceId === sibling.id)).toBe(false);
    } finally {
      db.close();
    }
  });
});
