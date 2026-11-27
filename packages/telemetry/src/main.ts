// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, chmodSync } from "node:fs";
import { createTelemetryServer } from "./server.js";
import { TelemetryStore } from "./store.js";
import { readLatestStable } from "./release.js";

const database = process.env.OMNESIS_TELEMETRY_DB;
const tokenFile = process.env.OMNESIS_TELEMETRY_METRICS_TOKEN_FILE;
if (!database || !tokenFile)
  throw new Error("Telemetry database and metrics credential paths are required");
const store = new TelemetryStore(database);
chmodSync(database, 0o600);
store.prune(new Date());
const server = createTelemetryServer({
  store,
  metricsToken: readFileSync(tokenFile, "utf8").trim(),
  latestStable: () =>
    readLatestStable(
      process.env.OMNESIS_TELEMETRY_LATEST_STABLE_FILE ?? "/run/config/latest-stable",
    ),
});
const timer = setInterval(() => {
  try {
    store.prune(new Date());
  } catch {
    /* The next hourly maintenance retries; no request data is logged. */
  }
}, 60 * 60_000);
timer.unref();
server.listen(
  Number(process.env.OMNESIS_TELEMETRY_PORT ?? 8080),
  process.env.OMNESIS_TELEMETRY_HOST ?? "127.0.0.1",
);
function shutdown(): void {
  clearInterval(timer);
  server.close(() => {
    store.close();
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
