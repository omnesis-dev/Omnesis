// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { readAnalyticsBuildPins } from "./analytics-sources.mjs";
import { qualifyDesktopAnalyticsLifecycle } from "./qualify-analytics.mjs";

const gatewayManifest = new URL("../../packages/gateway/package.json", import.meta.url);
const requireGateway = createRequire(gatewayManifest);

test("the pinned native analytics API releases handles and reports a late streaming failure", async () => {
  const pins = await readAnalyticsBuildPins();
  const manifest = JSON.parse(await readFile(gatewayManifest, "utf8"));
  expect(manifest.dependencies["@duckdb/node-api"]).toBe(pins.nodeBindingsVersion);
  const { DuckDBInstance } = requireGateway("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:", {
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
    threads: "1",
    memory_limit: "128MB",
  });
  let connection;
  try {
    connection = await instance.connect();
    await qualifyDesktopAnalyticsLifecycle(connection, pins.duckdbVersion);
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}, 10_000);
