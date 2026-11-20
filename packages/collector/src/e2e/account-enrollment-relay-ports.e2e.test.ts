// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The enrollment world's relay ports. They are probed free and released for the
 * relay to bind, so any socket on the machine can take one in between. Each test
 * here takes one of them at that moment, as another process on a busy test host
 * can: the world's first relay start must survive it on new ports.
 */
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EnrollmentWorld,
  RELAY_HOST,
  freePorts,
  type WorldOptions,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

const occupied: Server[] = [];
const directories: string[] = [];
let world: EnrollmentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
  await Promise.all(
    occupied
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function occupy(port: number): Promise<void> {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  occupied.push(server);
}

/** Free ports, of which another listener takes the one at `taken` in the first `times` picks. */
function portsTakenFirst(taken: number, times = 1) {
  const picks: number[][] = [];
  const choose = async (count: number): Promise<number[]> => {
    const ports = await freePorts(count);
    picks.push(ports);
    if (picks.length <= times) await occupy(ports[taken]!);
    return ports;
  };
  return { picks, choose };
}

async function create(options: Partial<WorldOptions>): Promise<EnrollmentWorld> {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-relay-ports-"));
  directories.push(directory);
  world = await EnrollmentWorld.create(directory, { signupPolicy: "closed", ...options });
  return world;
}

/** What a failed world creation reports: its fixture cleanup wraps the startup error. */
async function creationFailure(options: Partial<WorldOptions>): Promise<string> {
  try {
    await create(options);
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    return errors.map((each) => (each instanceof Error ? each.message : String(each))).join("\n");
  }
  throw new Error("The world started");
}

describe("the enrollment world's relay ports", () => {
  test("one call never returns a port twice", async () => {
    const ports = await freePorts(16);
    expect(new Set(ports).size).toBe(16);
  });

  test.each([
    ["control", 0],
    ["passthrough", 1],
    ["metrics", 2],
  ] as const)(
    "starts the relay on new ports when its %s port is taken before it binds",
    async (_listener, taken) => {
      const { picks, choose } = portsTakenFirst(taken);
      const started = await create({ metrics: true, freePorts: choose });

      expect(picks).toHaveLength(2);
      const [relay, data, metrics] = picks[1]!;
      expect([started.relayPort, started.dataPort, started.metricsPort]).toEqual([
        relay,
        data,
        metrics,
      ]);
      expect(started.relayOrigin).toBe(`https://${RELAY_HOST}:${relay}`);
      expect(started.relayLog()).toContain(`TLS passthrough port ${data}`);
      expect((await fetch(`https://127.0.0.1:${relay}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${metrics}/metrics`)).status).toBe(200);
    },
    gatewayBootBudgetMs() + 60_000,
  );

  test(
    "gives up with the relay's own error after three starts on taken ports",
    async () => {
      const { picks, choose } = portsTakenFirst(0, Infinity);
      expect(await creationFailure({ freePorts: choose })).toMatch(
        /^Relay exited 1: [^]*\(EADDRINUSE\)/m,
      );
      expect(picks).toHaveLength(3);
    },
    3 * gatewayBootBudgetMs() + 60_000,
  );

  test(
    "does not retry a relay that fails for any other reason",
    async () => {
      const { picks, choose } = portsTakenFirst(0, 0);
      const failure = await creationFailure({
        freePorts: choose,
        extraEnv: { OMNESIS_CLOUD_RELAY_METRICS_PORT: "not-a-port" },
      });
      expect(failure).toMatch(/^Relay exited 1: /m);
      expect(failure).not.toContain("EADDRINUSE");
      expect(picks).toHaveLength(1);
    },
    gatewayBootBudgetMs() + 60_000,
  );
});
