// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark and parity capture for `GET /admin/source-descriptors`, the
 * cross-collector list the Add Source flows read.
 *
 *   npx tsx scripts/bench-source-descriptors.mts measure healthy|slow [runs=7]
 *   npx tsx scripts/bench-source-descriptors.mts capture <out.json>
 *
 * Both modes boot an isolated gateway through `MultiCollectorHarness` and pair
 * in-process pseudo-collectors that advertise invented descriptors. Each
 * pseudo-collector answers `source.descriptors` immediately, after a fixed
 * delay, or never, from the moment it connects, which models a collector whose
 * event loop is busy syncing.
 *
 * `measure` waits for the gateway to settle after the collectors connect, then
 * times sequential requests and counts the `source.descriptors` commands the
 * collectors received while they ran. `healthy` pairs three collectors that
 * answer at once; `slow` pairs one that answers at once, one that answers in
 * 2.5 s and one that never answers.
 *
 * `capture` walks the list through connect, a second collector, a hung
 * collector, a reconnect with a changed provider set, a disconnect, a
 * revocation and an empty fleet, and writes each response body with device ids
 * replaced by names, so two checkouts' outputs can be diffed for parity.
 *
 * Copy the script into another checkout to measure that checkout's gateway: it
 * imports the harness relative to its own location. It never touches a live
 * gateway; the harness boots its own on a free port and temporary directory.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { GatewayWsClient } from "@omnesis/gateway-client";
import {
  MultiCollectorHarness,
  sleep,
  type PairedCollector,
} from "../packages/collector/src/e2e/multi-collector-harness.js";

type Behaviour = number | "never";

const [mode, arg1, arg2] = process.argv.slice(2);
if (mode !== "measure" && mode !== "capture") {
  console.error("usage: bench-source-descriptors.mts measure healthy|slow [runs] | capture <out>");
  process.exit(2);
}

// Every pseudo-collector's command handler is installed through
// `GatewayWsClient.onCommand` while the harness pairs it, before its hello.
// Wrapping that method applies the behaviour chosen for the collector being
// added from its first command on, and counts what it receives.
let nextBehaviour: Behaviour = 0;
const descriptorCommands = new Map<GatewayWsClient, number>();
const originalOnCommand = GatewayWsClient.prototype.onCommand;
GatewayWsClient.prototype.onCommand = function (this: GatewayWsClient, handler) {
  const behaviour = nextBehaviour;
  originalOnCommand.call(this, async (command) => {
    if (command.type === "source.descriptors") {
      descriptorCommands.set(this, (descriptorCommands.get(this) ?? 0) + 1);
      if (behaviour === "never") await new Promise<never>(() => {});
      if (behaviour > 0) await sleep(behaviour);
    }
    return handler(command);
  });
};

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function descriptor(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: `invented ${id}`,
    provider: { id: `${id}-provider`, name: `${name} provider` },
    params: [{ name: "folder", label: "Folder", type: "path", required: true }],
    hasAuthFlow: false,
    hasDiscover: false,
    authType: "local",
    pushBased: false,
    singleInstance: false,
    ...extra,
  };
}

async function addCollector(
  harness: MultiCollectorHarness,
  name: string,
  descriptors: Array<Record<string, unknown>>,
  behaviour: Behaviour,
): Promise<PairedCollector> {
  nextBehaviour = behaviour;
  try {
    return await harness.addCollector({
      name,
      hostableSourceTypes: descriptors.map((d) => String(d.id)),
      descriptors,
    });
  } finally {
    nextBehaviour = 0;
  }
}

async function reconnect(harness: MultiCollectorHarness, c: PairedCollector, b: Behaviour) {
  nextBehaviour = b;
  try {
    await harness.reconnectCollector(c);
  } finally {
    nextBehaviour = 0;
  }
}

function commandsReceived(harness: MultiCollectorHarness): number {
  let total = 0;
  for (const c of harness.collectors) total += descriptorCommands.get(c.ws) ?? 0;
  return total;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function measure(scenario: string, runs: number): Promise<void> {
  const harness = new MultiCollectorHarness();
  await harness.start();
  try {
    const shared = descriptor("shared-synth", "Shared");
    if (scenario === "healthy") {
      await addCollector(harness, "alpha", [shared, descriptor("alpha-synth", "Alpha")], 0);
      await addCollector(harness, "beta", [shared, descriptor("beta-synth", "Beta")], 0);
      await addCollector(harness, "gamma", [shared, descriptor("gamma-synth", "Gamma")], 0);
    } else if (scenario === "slow") {
      await addCollector(harness, "alpha", [shared, descriptor("alpha-synth", "Alpha")], 0);
      await addCollector(harness, "beta", [shared, descriptor("beta-synth", "Beta")], 2_500);
      await addCollector(harness, "gamma", [shared, descriptor("gamma-synth", "Gamma")], "never");
    } else {
      throw new Error(`unknown scenario ${scenario}`);
    }
    // Long enough for a collector that answers in 2.5 s to have answered
    // anything sent when it connected.
    await sleep(6_000);
    const before = commandsReceived(harness);
    const latencies: number[] = [];
    let hosts = "";
    for (let i = 0; i < runs; i++) {
      const started = performance.now();
      const body = await harness.json<{ items: Array<{ id: string; devices: unknown[] }> }>(
        "/admin/source-descriptors",
      );
      latencies.push(performance.now() - started);
      hosts = body.items.map((item) => `${item.id}:${item.devices.length}`).join(" ");
      await sleep(250);
    }
    const commands = commandsReceived(harness) - before;
    console.log(
      JSON.stringify({
        scenario,
        runs,
        medianMs: Math.round(median(latencies)),
        worstMs: Math.round(Math.max(...latencies)),
        latenciesMs: latencies.map((ms) => Math.round(ms)),
        descriptorCommandsDuringRuns: commands,
        lastHosts: hosts,
      }),
    );
  } finally {
    await harness.destroy();
  }
}

async function capture(out: string): Promise<void> {
  const harness = new MultiCollectorHarness();
  await harness.start();
  const steps: Record<string, unknown> = {};
  const names = new Map<string, string>();
  const snapshot = async (step: string) => {
    let text = JSON.stringify(await harness.json("/admin/source-descriptors"));
    for (const [id, name] of names) text = text.split(id).join(`<${name}>`);
    steps[step] = JSON.parse(text);
  };
  try {
    await snapshot("01-no-collector");

    const alpha = await addCollector(
      harness,
      "alpha",
      [
        descriptor("shared-synth", "Shared (alpha build)", { icon: { imageDataUri: PIXEL } }),
        descriptor("alpha-synth", "Alpha"),
      ],
      0,
    );
    names.set(alpha.deviceId, "alpha");
    await snapshot("02-one-collector");

    // Answers a little later than alpha, so a list merged in arrival order and
    // one merged in pairing order agree on which shared descriptor comes first.
    const beta = await addCollector(
      harness,
      "beta",
      [descriptor("shared-synth", "Shared (beta build)"), descriptor("beta-synth", "Beta")],
      200,
    );
    names.set(beta.deviceId, "beta");
    await snapshot("03-two-collectors-merged");

    const hung = await addCollector(harness, "hung", [descriptor("hung-synth", "Hung")], "never");
    names.set(hung.deviceId, "hung");
    await snapshot("04-hung-collector-online");
    await harness.disconnectCollector(hung);
    await snapshot("05-hung-collector-gone");

    // An updated build: one provider removed, one added.
    await harness.disconnectCollector(beta);
    await snapshot("06-beta-offline");
    beta.descriptors = [
      descriptor("shared-synth", "Shared (beta build)"),
      descriptor("beta-new-synth", "Beta New"),
    ];
    await reconnect(harness, beta, 200);
    await snapshot("07-beta-updated");

    await harness.json(`/admin/devices/${beta.deviceId}`, { method: "DELETE" });
    await snapshot("08-beta-revoked");

    await harness.disconnectCollector(alpha);
    await snapshot("09-no-collector-online");
  } finally {
    await harness.destroy();
  }
  writeFileSync(out, `${JSON.stringify(steps, null, 2)}\n`);
  console.log(`wrote ${Object.keys(steps).length} steps to ${out}`);
}

if (mode === "measure") {
  await measure(arg1 ?? "healthy", Number(arg2 ?? 7));
} else {
  if (!arg1) throw new Error("capture needs an output path");
  await capture(arg1);
}
process.exit(0);
