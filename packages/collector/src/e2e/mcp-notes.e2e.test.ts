// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  authorizeMcpClient,
  stageConnectionApproval,
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
      expect(inventory.tools[0]?.annotations?.idempotentHint).toBe(true);
      const missingId = await authorized.client.callTool({
        name: "add_note",
        arguments: { text: "Fictional capture missing its retry ID." },
      });
      expect(missingId.isError).toBe(true);
      expect(noteCount("Fictional capture missing its retry ID.")).toBe(0);
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
        captureId: args.id,
        day: "2026-06-19",
        capturedAt: args.capturedAt,
        receivedAt: expect.any(String),
      });
      expect(JSON.stringify(result)).not.toContain(args.text);
      const receipt = result.structuredContent as { id: string; receivedAt: string };
      expect(receipt.id).not.toBe(args.id);
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
      const written = await authorized.client.callTool({
        name: "add_note",
        arguments: { id: randomUUID(), text },
      });
      expect(written.isError).not.toBe(true);
      expect(written.structuredContent).toMatchObject({ captureId: expect.any(String) });
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

  test("reconnect retries deduplicate while other connections and native captures stay isolated", async () => {
    const original = await authorizeMcpClient(harness, {
      principalName: "Fictional reconnecting notebook",
      grantName: "Retry notes",
      credentialLabel: "Fictional retry client",
      capabilities: ["notes"],
    });
    let replacement: AuthorizedMcpClient | undefined;
    let other: AuthorizedMcpClient | undefined;
    try {
      const args = { id: randomUUID(), text: "Prepare the fictional telescope checklist." };
      const first = await original.client.callTool({ name: "add_note", arguments: args });
      expect(first.isError).not.toBe(true);
      const pending = await stageConnectionApproval(harness, {
        clientName: "fictional replacement notebook",
        redirectUrl: "http://localhost:17629/callback",
      });
      try {
        replacement = await (
          await pending.approve({
            kind: "replace-connection",
            connectionId: original.principalId,
            expectedGrantRevision: original.grantRevision,
          })
        ).finish();
      } finally {
        await pending.close();
      }
      expect(replacement.principalId).toBe(original.principalId);
      expect(replacement.credentialId).not.toBe(original.credentialId);
      const retry = await replacement.client.callTool({ name: "add_note", arguments: args });
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent).toEqual(first.structuredContent);
      expect(noteCount(args.text)).toBe(1);

      other = await authorizeMcpClient(harness, {
        principalName: "Fictional separate notebook",
        grantName: "Independent notes",
        credentialLabel: "Fictional separate client",
        capabilities: ["notes"],
      });
      expect(other.principalId).not.toBe(original.principalId);
      const independent = await other.client.callTool({ name: "add_note", arguments: args });
      expect(independent.isError).not.toBe(true);
      expect(independent.structuredContent).toMatchObject({ captureId: args.id });
      expect(independent.structuredContent!.id).not.toBe(first.structuredContent!.id);
      for (const surface of ["portal", "ios-app"]) {
        const native = await fetch(`${harness.gatewayUrl}/notes`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${harness.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...args, surface }),
        });
        expect(native.status).toBe(201);
        expect(await native.json()).toMatchObject({ id: args.id });
      }
      expect(noteCount(args.text)).toBe(3);
      expect(noteRow(args.id)?.surface).toBe("portal");
    } finally {
      if (other) await closeAuthorized(other);
      if (replacement) await closeAuthorized(replacement);
      await closeAuthorized(original);
    }
  }, 90_000);

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
