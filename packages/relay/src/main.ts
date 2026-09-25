// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { serve } from "@hono/node-server";
import { createLogger } from "@omnesis/core";

import { RelayAbuseGuard } from "./abuse.js";
import { ApnsRelayCarrier } from "./carriers/apns.js";
import { FcmRelayCarrier } from "./carriers/fcm.js";
import { runRelayAdminCommand } from "./admin.js";
import { loadRelayConfig } from "./config.js";
import { validateRelayCredentialFiles } from "./credentials.js";
import { runRelayHealthCommand } from "./health-command.js";
import { RelayMetrics } from "./metrics.js";
import { createRelayMetricsApp } from "./metrics-server.js";
import { createRelayApp } from "./server.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";

const log = createLogger("relay");

function main(): void {
  const config = loadRelayConfig();
  validateRelayCredentialFiles(config);
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const store = new RelayStore(config.dbPath);
  const metrics = new RelayMetrics();
  const service = new RelayService({
    store,
    carriers: [new ApnsRelayCarrier(config.apns), new FcmRelayCarrier(config.fcm)],
    metrics,
    abuseGuard: new RelayAbuseGuard({
      enrol: { limit: config.abuse.enrolSourceLimit, windowMs: config.abuse.sourceWindowMs },
      verify: { limit: config.abuse.verifySourceLimit, windowMs: config.abuse.sourceWindowMs },
      invalidWake: {
        limit: config.abuse.invalidWakeSourceLimit,
        windowMs: config.abuse.sourceWindowMs,
      },
      globalEnrol: {
        limit: config.abuse.globalEnrolLimit,
        windowMs: config.abuse.globalEnrolWindowMs,
      },
      renewalEnrol: {
        limit: config.abuse.renewalEnrolLimit,
        windowMs: config.abuse.globalEnrolWindowMs,
      },
      carrierFailures: {
        limit: config.abuse.carrierFailureLimit,
        windowMs: config.abuse.carrierFailureWindowMs,
      },
      maxTrackedSources: config.abuse.maxTrackedSources,
    }),
    challengeTtlMs: config.abuse.challengeTtlMs,
    maxPendingChallenges: config.abuse.maxPendingChallenges,
  });
  const app = createRelayApp(service);
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  const metricsServer = serve({
    fetch: createRelayMetricsApp(metrics, store).fetch,
    hostname: config.metricsHost,
    port: config.metricsPort,
  });
  log.info(`listening on plain HTTP at ${config.host}:${config.port}`);
  log.info(`metrics listening at ${config.metricsHost}:${config.metricsPort}`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => metricsServer.close(() => resolve())),
    ]).then(() => {
      void service
        .dispose()
        .catch((err) => {
          log.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        })
        .finally(() => process.removeAllListeners("SIGTERM"));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const argv = process.argv.slice(2);
if (argv[0] === "check-health") {
  void runRelayHealthCommand(argv.slice(1)).then((exitCode) => {
    process.exitCode = exitCode;
  });
} else if (argv.length > 0) {
  process.exitCode = runRelayAdminCommand(argv);
} else {
  try {
    main();
  } catch (err) {
    log.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
