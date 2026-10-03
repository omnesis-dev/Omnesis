// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import {
  claimNotification,
  enqueueNotification,
  leaseNotificationWakes,
  pendingNotificationCount,
} from "../push/queue.js";
import {
  createAuthorizationRequest,
  decideAuthorizationRequest,
  defaultAuthorizationScope,
  enqueueAccessAuthorizationNotification,
  registerOAuthClient,
} from "./store.js";
import type { Db } from "../data/types.js";
import type { DeviceId } from "@omnesis/types";

const NOW = 1_800_000_000_000;
const REDIRECT = "https://example.org/oauth/callback";
let db: Db;
let phoneId: DeviceId;
let clientId: string;

beforeEach(() => {
  db = new Database(":memory:") as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  phoneId = createDevice(db, { name: "Fictional phone", kind: "ios" }).id;
  clientId = registerOAuthClient(
    db,
    {
      clientName: "Fictional assistant",
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      clientUri: "https://example.org/assistant",
    },
    NOW,
  ).clientId;
});

afterEach(() => db.close());

function request(ttlMs = 60_000) {
  const created = createAuthorizationRequest(
    db,
    {
      clientId,
      redirectUri: REDIRECT,
      codeChallenge: "a".repeat(43),
      resource: "https://example.org/mcp",
      scope: defaultAuthorizationScope(),
      ttlMs,
    },
    NOW,
  );
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

function decide(id: string, decision: "approve" | "deny") {
  const result = decideAuthorizationRequest(
    db,
    {
      approvalId: id,
      decision,
      actorTokenId: "fictional-portal-token",
      ...(decision === "approve"
        ? {
            selection: {
              kind: "new-principal" as const,
              principalName: "Fictional assistant",
              grantName: "Capture",
              rules: [
                {
                  capability: "notes" as const,
                  sources: { mode: "all" as const, sourceIds: [] },
                },
              ],
              credentialLabel: "Fictional credential",
              expiresAt: null,
            },
          }
        : {}),
    },
    NOW + 2,
  );
  expect(result.ok).toBe(true);
}

function wakes(now: number) {
  return leaseNotificationWakes(db, { now, limit: 10, maxAttempts: 4 });
}

describe("access authorization notification lifecycle", () => {
  test.each(["approve", "deny"] as const)(
    "does not wake or show a queued request after %s",
    (decision) => {
      const pending = request();
      expect(
        enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 1),
      ).not.toBeNull();
      decide(pending.id, decision);

      expect(pendingNotificationCount(db, phoneId, NOW + 3)).toBe(0);
      expect(wakes(NOW + 3)).toEqual([]);
      expect(claimNotification(db, { deviceId: phoneId, now: NOW + 3 })).toBeNull();
    },
  );

  test("does not replay a leased notification after the request is decided", () => {
    const pending = request();
    enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 1);
    expect(claimNotification(db, { deviceId: phoneId, now: NOW + 1, leaseMs: 10 })).not.toBeNull();
    decide(pending.id, "deny");

    expect(pendingNotificationCount(db, phoneId, NOW + 12)).toBe(0);
    expect(wakes(NOW + 12)).toEqual([]);
    expect(claimNotification(db, { deviceId: phoneId, now: NOW + 12 })).toBeNull();
  });

  test("rejects a generic prompt when no authorization request is waiting", () => {
    expect(
      enqueueNotification(db, {
        message: {
          kind: "access-authorization",
          title: "Access request waiting",
          body: "Review access for the fictional assistant.",
          data: {},
          collapseId: "access:authorization",
        },
        deviceIds: [phoneId],
        createdAt: NOW,
        expiresAt: NOW + 60_000,
      }),
    ).toBeNull();
  });

  test.each(["expired", "deleted"] as const)(
    "suppresses a still-retained generic prompt when its last request is %s",
    (status) => {
      const pending = request(10);
      expect(
        enqueueNotification(db, {
          message: {
            kind: "access-authorization",
            title: "Access request waiting",
            body: "Review access for the fictional assistant.",
            data: {},
            collapseId: "access:authorization",
          },
          deviceIds: [phoneId],
          createdAt: NOW + 1,
          expiresAt: NOW + 60_000,
        }),
      ).not.toBeNull();
      if (status === "deleted")
        db.prepare("DELETE FROM oauth_authorization_requests WHERE id = ?").run(pending.id);
      expect(pendingNotificationCount(db, phoneId, NOW + 10)).toBe(0);
      expect(wakes(NOW + 10)).toEqual([]);
      expect(claimNotification(db, { deviceId: phoneId, now: NOW + 10 })).toBeNull();
    },
  );

  test("the newest prompt stands for an older waiting request it superseded", () => {
    const older = request();
    const newer = request();
    enqueueAccessAuthorizationNotification(db, older.id, [phoneId], NOW + 1);
    enqueueAccessAuthorizationNotification(db, newer.id, [phoneId], NOW + 1);
    expect(pendingNotificationCount(db, phoneId, NOW + 1)).toBe(1);
    decide(newer.id, "deny");

    // The older request's own prompt was superseded; the surviving one is the
    // only alert left for it, so it stays deliverable and counted.
    expect(pendingNotificationCount(db, phoneId, NOW + 3)).toBe(1);
    expect(claimNotification(db, { deviceId: phoneId, now: NOW + 3 })).toMatchObject({
      kind: "access-authorization",
    });
  });

  test("keeps the generic prompt actionable while another request is waiting", () => {
    const first = request();
    const second = request();
    enqueueAccessAuthorizationNotification(db, first.id, [phoneId], NOW + 1);
    decide(first.id, "deny");

    expect(pendingNotificationCount(db, phoneId, NOW + 3)).toBe(1);
    expect(wakes(NOW + 3)).toHaveLength(1);
    expect(claimNotification(db, { deviceId: phoneId, now: NOW + 3 })).toMatchObject({
      kind: "access-authorization",
    });
    decide(second.id, "deny");
    expect(claimNotification(db, { deviceId: phoneId, now: NOW + 30_004 })).toBeNull();
  });
});
