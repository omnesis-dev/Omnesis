// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  accessOverview,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import type { ScopeFixture } from "./source-scope-fixtures.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";

export function filteredRule(
  source: ScopeFixture,
  capability: "direct" | "answer",
  sources: { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] } = {
    mode: "all",
    sourceIds: [],
  },
): TestGrantRule {
  const boundary = {
    capability,
    sources,
    scopePolicies: [
      {
        sourceId: source.sourceId,
        audience: { accessLevel: "new", capability },
        rules: [{ action: "share" as const, match: [source.ref] }],
        otherwise: "hide" as const,
      },
    ],
  };
  return capability === "answer"
    ? { ...boundary, capability, release: { mode: "unreviewed" } }
    : { ...boundary, capability };
}
export async function askScoped(
  client: AuthorizedMcpClient,
  question: string,
): Promise<{ answer: string; status: string; taskId: string }> {
  const response = await client.client.callTool({
    name: "ask_omnesis",
    arguments: {
      question,
      requestId: randomUUID(),
      workflowName: "Invented context check",
      workflowPurpose: "Read invented authorized evidence.",
    },
  });
  expect(response.isError).not.toBe(true);
  let value = response.structuredContent as { answer: string; status: string; taskId: string };
  for (let attempt = 0; attempt < 120 && ["running", "queued"].includes(value.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const polled = await client.client.callTool({
      name: "get_answer_status",
      arguments: { taskId: value.taskId },
    });
    expect(polled.isError).not.toBe(true);
    value = polled.structuredContent as typeof value;
  }
  expect(value.status).toMatch(/^released/);
  return value;
}
export async function fetched(client: AuthorizedMcpClient, id: string): Promise<string> {
  const response = await client.client.callTool({
    name: "fetch_many",
    arguments: { documents: [{ documentId: id }] },
  });
  expect(response.isError).not.toBe(true);
  return JSON.stringify(response.structuredContent);
}
export async function levelFor(harness: SyntheticE2EHarness, client: AuthorizedMcpClient) {
  const overview = await accessOverview(harness.gatewayUrl, client.portal);
  const grant = overview.principals
    .flatMap((principal) => principal.grants)
    .find((candidate) => candidate.id === client.grantId)!;
  const level = overview.levels?.find((candidate) => candidate.id === grant.levelId);
  if (!level) throw new Error("Filtered connection has no level.");
  return level;
}
export async function closeScoped(client: AuthorizedMcpClient | undefined): Promise<void> {
  if (client) await Promise.allSettled([client.client.close(), client.transport.close()]);
}
