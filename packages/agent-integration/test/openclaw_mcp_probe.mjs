// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pathToFileURL } from "node:url";
import { createFakeOpenClawHost } from "../../../scripts/test-fixtures/openclaw-host-fixture.mjs";

const entryPath = process.env.OMNESIS_OPENCLAW_ENTRY_PATH;
const stateDir = process.env.OMNESIS_OPENCLAW_STATE_DIR;
const question = process.env.OMNESIS_OPENCLAW_QUESTION;
// A JSON list of `{ "tool": "omnesis_…", "args": {…} }` calls to make instead
// of asking a question.
const calls = process.env.OMNESIS_OPENCLAW_TOOL_CALLS;
if (!entryPath || !stateDir || (!question && !calls)) {
  throw new Error("OpenClaw MCP probe environment is incomplete");
}

const definition = (await import(pathToFileURL(entryPath).href)).default;
const { api, services, tools, logger } = createFakeOpenClawHost({
  runId: "run-fictional-cold-process",
});

definition.register(api);
const service = services.find((candidate) => candidate.id === "omnesis-integration");
if (!service) throw new Error("installed OpenClaw plugin did not register");
const context = { sessionKey: "agent:main:e2e:cold-process" };

/** The tool of this name as OpenClaw would resolve it for the session. */
function resolveTool(name) {
  for (const candidate of tools) {
    const resolved = candidate.factory(context);
    const offered = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
    const tool = offered.find((item) => item.name === name);
    if (tool) return tool;
  }
  throw new Error(`installed OpenClaw plugin did not offer ${name}`);
}

await service.start({ stateDir, logger });
try {
  if (calls) {
    const results = [];
    for (const { tool, args } of JSON.parse(calls)) {
      results.push(
        await resolveTool(tool).execute(
          "fictional-cold-process-tool-call",
          args,
          new AbortController().signal,
        ),
      );
    }
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } else {
    const result = await resolveTool("omnesis_answer").execute(
      "fictional-cold-process-tool-call",
      { question, timeoutMs: 60_000 },
      new AbortController().signal,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await service.stop();
}
