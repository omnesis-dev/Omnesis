// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pathToFileURL } from "node:url";
import { createFakeOpenClawHost } from "../../../scripts/test-fixtures/openclaw-host-fixture.mjs";

const entryPath = process.env.OMNESIS_OPENCLAW_ENTRY_PATH;
const stateDir = process.env.OMNESIS_OPENCLAW_STATE_DIR;
const question = process.env.OMNESIS_OPENCLAW_QUESTION;
if (!entryPath || !stateDir || !question) {
  throw new Error("OpenClaw MCP probe environment is incomplete");
}

const definition = (await import(pathToFileURL(entryPath).href)).default;
const { api, services, tools, logger } = createFakeOpenClawHost({
  runId: "run-fictional-cold-process",
});

definition.register(api);
const service = services.find((candidate) => candidate.id === "omnesis-integration");
const registered = tools.find((candidate) => candidate.options.name === "omnesis_answer");
if (!service || !registered) throw new Error("installed OpenClaw plugin did not register");

await service.start({ stateDir, logger });
try {
  const tool = registered.factory({ sessionKey: "agent:main:e2e:cold-process" });
  if (!tool) throw new Error("installed OpenClaw answer tool was unavailable");
  const result = await tool.execute(
    "fictional-cold-process-tool-call",
    { question, timeoutMs: 60_000 },
    new AbortController().signal,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await service.stop();
}
