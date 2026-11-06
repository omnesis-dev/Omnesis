// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /admin/source-descriptors` answers from what each collector reported
 * over its current connection, across real processes: a gateway subprocess
 * and in-test pseudo-collectors on `MultiCollectorHarness`.
 *
 * Each collector is asked for its descriptors once per connection, so the
 * list neither waits on a collector that is busy nor sends it a command per
 * request; and the list still follows the fleet exactly: a reconnect (an
 * update) replaces a collector's types, a disconnect or a revocation drops it
 * as a host, and a collector that never answers is never listed.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

interface Listed {
  id: string;
  name: string;
  devices: Array<{ id: string; name: string }>;
}

function descriptor(id: string, name: string) {
  return {
    id,
    name,
    description: `invented ${id}`,
    provider: { id: `${id}-provider`, name: `${name} provider` },
    params: [],
    hasAuthFlow: false,
    hasDiscover: false,
    authType: "local",
    pushBased: false,
    singleInstance: false,
  };
}

function descriptorCommands(c: PairedCollector): number {
  return c.receivedCommands.filter((cmd) => cmd.type === "source.descriptors").length;
}

describe("source descriptors across collectors", () => {
  let harness: MultiCollectorHarness;
  let alpha: PairedCollector;
  let beta: PairedCollector;

  const list = async () =>
    (await harness.json<{ items: Listed[] }>("/admin/source-descriptors")).items;
  const hosts = (items: Listed[]) =>
    Object.fromEntries(
      items.filter((i) => i.devices.length > 0).map((i) => [i.id, i.devices.map((d) => d.name)]),
    );

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    alpha = await harness.addCollector({
      name: "alpha",
      hostableSourceTypes: ["shared-synth", "alpha-synth"],
      descriptors: [descriptor("shared-synth", "Shared (alpha)"), descriptor("alpha-synth", "A")],
    });
    // Busy for a while before it answers anything it is asked.
    beta = await harness.addCollector({
      name: "beta",
      hostableSourceTypes: ["shared-synth", "beta-synth"],
      descriptors: [descriptor("shared-synth", "Shared (beta)"), descriptor("beta-synth", "B")],
      descriptorsAnswer: 1_500,
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("connect → known: each collector is asked once, and warm requests send no command", async () => {
    await waitForCondition(
      async () => hosts(await list())["beta-synth"] !== undefined,
      15_000,
      "the busy collector's answer reaches the list",
    );
    expect(descriptorCommands(alpha)).toBe(1);
    expect(descriptorCommands(beta)).toBe(1);

    for (let i = 0; i < 5; i++) {
      const items = await list();
      expect(hosts(items)).toEqual({
        "shared-synth": ["alpha", "beta"],
        "alpha-synth": ["alpha"],
        "beta-synth": ["beta"],
      });
      // The first collector in pairing order supplies the merged payload.
      expect(items.find((i) => i.id === "shared-synth")?.name).toBe("Shared (alpha)");
    }
    // The pin: a warm list never sends `source.descriptors` to a collector.
    expect(descriptorCommands(alpha)).toBe(1);
    expect(descriptorCommands(beta)).toBe(1);
  });

  test("a collector that never answers is never listed, and the others still are", async () => {
    const hung = await harness.addCollector({
      name: "hung",
      hostableSourceTypes: ["hung-synth"],
      descriptors: [descriptor("hung-synth", "Hung")],
      descriptorsAnswer: "never",
    });
    try {
      for (let i = 0; i < 3; i++) {
        expect(hosts(await list())).toEqual({
          "shared-synth": ["alpha", "beta"],
          "alpha-synth": ["alpha"],
          "beta-synth": ["beta"],
        });
      }
      expect(descriptorCommands(alpha)).toBe(1);
      expect(descriptorCommands(beta)).toBe(1);
    } finally {
      await harness.disconnectCollector(hung);
    }
  });

  test("reconnect (an update): the new build's types replace the old ones, asked once", async () => {
    await harness.disconnectCollector(alpha);
    alpha.receivedCommands.length = 0;
    alpha.descriptors = [
      descriptor("shared-synth", "Shared (alpha)"),
      descriptor("alpha-new-synth", "A2"),
    ];
    await harness.reconnectCollector(alpha);

    for (let i = 0; i < 3; i++) {
      expect(hosts(await list())).toEqual({
        "shared-synth": ["alpha", "beta"],
        "alpha-new-synth": ["alpha"],
        "beta-synth": ["beta"],
      });
    }
    expect(descriptorCommands(alpha)).toBe(1);
  });

  test("disconnect: an offline collector is no longer listed as a host", async () => {
    await harness.disconnectCollector(beta);
    expect(hosts(await list())).toEqual({
      "shared-synth": ["alpha"],
      "alpha-new-synth": ["alpha"],
    });
    await harness.reconnectCollector(beta);
    await waitForCondition(
      async () => hosts(await list())["beta-synth"] !== undefined,
      15_000,
      "the reconnected collector is listed again",
    );
  });

  test("revoke: a revoked collector is dropped, and gateway-hosted sources remain", async () => {
    await harness.json(`/admin/devices/${beta.deviceId}`, { method: "DELETE" });
    expect(hosts(await list())).toEqual({
      "shared-synth": ["alpha"],
      "alpha-new-synth": ["alpha"],
    });

    await harness.disconnectCollector(alpha);
    const items = await list();
    expect(hosts(items)).toEqual({});
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.devices.length === 0)).toBe(true);
  });
});
