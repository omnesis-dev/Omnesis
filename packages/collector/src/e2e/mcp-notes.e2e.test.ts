// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  authorizeMcpClient,
  updateAccessGrant,
  type AuthorizedMcpClient,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const notesRule: TestGrantRule = {
  capability: "notes",
  sources: { mode: "all", sourceIds: [] },
};
const answerRule: TestGrantRule = {
  capability: "answer",
  sources: { mode: "all", sourceIds: [] },
  release: { mode: "unreviewed" },
};

describe("Notes MCP OAuth — synthetic-corpus gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", agentBackend: "replay" });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("authorizes notes alone and persists authenticated attribution with capture context", async () => {
    const authorized = await authorizeMcpClient(harness, {
      principalName: "Fictional capture assistant",
      grantName: "Capture only",
      credentialLabel: "Fictional notebook client",
      capabilities: ["notes"],
    });
    try {
      const inventory = await authorized.client.listTools();
      expect(inventory.tools.map((tool) => tool.name)).toEqual(["add_note"]);
      expect(inventory.tools[0]?.annotations?.readOnlyHint).toBe(false);
      const args = {
        id: randomUUID(),
        text: "Remember to bring the fictional observatory membership card.",
        capturedAt: "2026-06-18T23:30:00.000Z",
        capturedTimeZoneId: "Europe/Paris",
        capturedUtcOffsetSeconds: 7200,
        latitude: 0,
        longitude: 0,
        placeName: "example observatory",
      };
      const result = await authorized.client.callTool({ name: "add_note", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        id: expect.any(String),
        day: "2026-06-19",
        capturedAt: args.capturedAt,
        receivedAt: expect.any(String),
      });
      expect(JSON.stringify(result)).not.toContain(args.text);
      const receipt = result.structuredContent as { id: string; receivedAt: string };
      const stored = noteRow(receipt.id);
      expect(stored).toMatchObject({
        text: args.text,
        surface: "mcp",
        device_id: null,
        captured_at: args.capturedAt,
        captured_time_zone_id: args.capturedTimeZoneId,
        captured_utc_offset_seconds: 7200,
        received_at: receipt.receivedAt,
        latitude: 0,
        longitude: 0,
        place_name: args.placeName,
      });
      expect(JSON.parse(String(stored!.capture_context))).toMatchObject({
        principalId: authorized.principalId,
        principalName: "Fictional capture assistant",
        grantId: authorized.grantId,
        grantRevision: authorized.grantRevision,
        credentialId: authorized.credentialId,
        oauthClientId: authorized.provider.savedClientInformation?.client_id,
        requestId: expect.any(String),
      });

      const retry = await authorized.client.callTool({ name: "add_note", arguments: args });
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent).toEqual(result.structuredContent);
      expect(noteCount(args.text)).toBe(1);

      await expect
        .poll(() => projectedEntries(receipt.id), { timeout: 15_000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: receipt.id,
              surface: "mcp",
              captureContext: expect.objectContaining({
                principalId: authorized.principalId,
                principalName: "Fictional capture assistant",
              }),
            }),
          ]),
        );
    } finally {
      await closeAuthorized(authorized);
    }
  }, 60_000);

  test("enables an existing credential through a grant edit and denies writes after removal", async () => {
    const authorized = await authorizeMcpClient(harness, {
      principalName: "Fictional expandable assistant",
      grantName: "Editable capture access",
      credentialLabel: "Fictional expandable client",
      capabilities: ["answer"],
      rules: [answerRule],
    });
    try {
      const deniedText = "Fictional capture without permission must not be saved.";
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        "add_note",
      );
      await expectWriteDenied(authorized, deniedText);
      expect(noteCount(deniedText)).toBe(0);
      const firstToken = authorized.provider.savedTokens?.access_token;
      const expandedRevision = await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        authorized.grantRevision,
        [answerRule, notesRule],
      );
      expect(
        (await authorized.client.listTools(undefined, { cacheMode: "refresh" })).tools.map(
          (tool) => tool.name,
        ),
      ).toEqual(["ask_omnesis", "get_answer_status", "add_note"]);
      expect(authorized.provider.savedTokens?.access_token).not.toBe(firstToken);
      expect(authorized.provider.authorizationRedirects).toBe(1);
      const text = "The fictional workshop starts after lunch.";
      const written = await authorized.client.callTool({ name: "add_note", arguments: { text } });
      expect(written.isError).not.toBe(true);
      expect(noteCount(text)).toBe(1);
      const receipt = written.structuredContent as { id: string };
      expect(JSON.parse(String(noteRow(receipt.id)!.capture_context))).toMatchObject({
        principalId: authorized.principalId,
        grantRevision: expandedRevision,
      });

      await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        expandedRevision,
        [answerRule],
      );
      expect(
        (await authorized.client.listTools(undefined, { cacheMode: "refresh" })).tools.map(
          (tool) => tool.name,
        ),
      ).not.toContain("add_note");
      await expectWriteDenied(authorized, deniedText);
      expect(noteCount(deniedText)).toBe(0);
      expect(authorized.provider.authorizationRedirects).toBe(1);
    } finally {
      await closeAuthorized(authorized);
    }
  }, 60_000);

  function noteRow(id: string): Record<string, string | number | null> | undefined {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          Record<string, string | number | null>
        >("SELECT * FROM note_entries WHERE id = ?")
        .get(id);
    } finally {
      db.close();
    }
  }

  function noteCount(text: string): number {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          { count: number }
        >("SELECT count(*) AS count FROM note_entries WHERE text = ?")
        .get(text)!.count;
    } finally {
      db.close();
    }
  }

  function projectedEntries(id: string): unknown[] {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const rows = db
        .prepare<
          [],
          { metadata: string }
        >("SELECT metadata FROM documents WHERE source_id = 'omnesis-notes'")
        .all();
      return rows.flatMap((row) => {
        const metadata = JSON.parse(row.metadata) as { addressedEntries?: Array<{ id: string }> };
        return metadata.addressedEntries?.filter((entry) => entry.id === id) ?? [];
      });
    } finally {
      db.close();
    }
  }
});

async function expectWriteDenied(authorized: AuthorizedMcpClient, text: string): Promise<void> {
  const result = await authorized.client
    .callTool({
      name: "add_note",
      arguments: { text },
    })
    .catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/(?:unknown tool|tool.*not found|not.*available)/i);
      return undefined;
    });
  if (result !== undefined) expect(result.isError).toBe(true);
}

async function closeAuthorized(authorized: AuthorizedMcpClient): Promise<void> {
  const outcomes = await Promise.allSettled([
    authorized.client.close(),
    authorized.transport.close(),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
}
