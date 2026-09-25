// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";

import type { RelayMetrics } from "./metrics.js";
import type { RelayStore } from "./store.js";

export function createRelayMetricsApp(metrics: RelayMetrics, store: RelayStore): Hono {
  const app = new Hono();
  app.get("/metrics", (c) =>
    c.text(metrics.render(store.operationalSnapshot()), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  app.notFound((c) => c.body(null, 404));
  return app;
}
