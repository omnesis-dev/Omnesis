// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boot the installed OpenClaw plugin in a cold process and report what it
 * decided, without asking it anything.
 *
 * Two things are only observable from inside a real plugin process: which
 * tools it offers a session — which depends on what the gateway said it could
 * do — and what its start-time OAuth keepalive did to the stored credential.
 * `service.stop()` waits for a renewal in flight, so by the time this exits
 * the credential file has settled and the caller can read it.
 */

import { pathToFileURL } from "node:url";
import { createFakeOpenClawHost } from "../../../scripts/test-fixtures/openclaw-host-fixture.mjs";

const entryPath = process.env.OMNESIS_OPENCLAW_ENTRY_PATH;
const stateDir = process.env.OMNESIS_OPENCLAW_STATE_DIR;
if (!entryPath || !stateDir) throw new Error("OpenClaw plugin probe environment is incomplete");

const definition = (await import(pathToFileURL(entryPath).href)).default;
const warnings = [];
const { api, services, tools, logger } = createFakeOpenClawHost({
  runId: "run-fictional-plugin-probe",
});
const probeLogger = { ...logger, warn: (message) => warnings.push(String(message)) };

definition.register(api);
const service = services.find((candidate) => candidate.id === "omnesis-integration");
if (!service) throw new Error("installed OpenClaw plugin registered no service");

await service.start({ stateDir, logger: probeLogger });
let offered;
try {
  // A conversation session, which is the context every ordinary tool resolves
  // for; a tool the plugin declines to offer returns null here.
  const context = { sessionKey: "agent:main:e2e:plugin-probe" };
  offered = tools
    .filter((candidate) => candidate.factory(context) !== null)
    .map((candidate) => candidate.options.name)
    .sort();
} finally {
  await service.stop();
}
process.stdout.write(`${JSON.stringify({ tools: offered, warnings })}\n`);
