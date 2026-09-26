// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCOPE_ADMIN, SCOPE_ANSWER, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import {
  appendDirectAuditEvent,
  auditDisplay,
  createAnswerPrivacyTables,
  createDirectAuditTables,
  digestCandidate,
  getPrivacyAuditEvent,
  listPrivacyAuditEvents,
} from "../../privacy/store.js";
import { PrivacyPolicyStore } from "../../privacy/policy-store.js";
import { PrivacyAdminService } from "../../privacy/admin-service.js";
import { directWriteGate } from "../../write-gate.js";
import { errorResponse, HttpError } from "../errors.js";
import { scope, strictRoute } from "../scope.js";
import { mountPrivacyRoutes } from "./privacy.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";
import type { AppEnv } from "./types.js";

const review: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v1",
  provider: "test",
  model: "reviewer",
  confidence: 0.9,
  policyRevision: "policy-a",
  findings: [],
  rationale: "Approval required by synthetic policy.",
};

const PORTAL_TOKEN_ID = "11111111-1111-4111-8111-111111111111";
const PORTAL_DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PORTAL_CSRF_TOKEN = "a".repeat(64);
const POLICY_MUTATION_HEADERS = {
  "content-type": "application/json",
  "x-omnesis-csrf": PORTAL_CSRF_TOKEN,
};

describe("privacy admin routes", () => {
  let app: Hono<AppEnv>;
  let db: Database.Database;
  let dir: string;
  let previousExperimental: string | undefined;

  beforeEach(() => {
    previousExperimental = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "0";
    dir = mkdtempSync(join(tmpdir(), "omnesis-privacy-route-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
    createAnswerPrivacyTables(db);
    createDirectAuditTables(db);
    db.exec("CREATE TABLE tokens (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT)");
    db.prepare("INSERT INTO tokens (id, device_id, name) VALUES (?, ?, ?)").run(
      PORTAL_TOKEN_ID,
      PORTAL_DEVICE_ID,
      "Portal",
    );
    db.prepare("INSERT INTO tokens (id, device_id, name) VALUES (?, ?, ?)").run(
      "external",
      "external-device",
      "OpenClaw",
    );
    const writeGate = directWriteGate(db);

    app = new Hono<AppEnv>();
    app.onError((err, c) => {
      if (err instanceof HttpError) return errorResponse(c, err);
      throw err;
    });
    app.use("*", async (c, next) => {
      c.set("requestId", "privacy-route-request");
      c.set("auth", {
        authMethod: "portal-session",
        deviceId: null,
        credentialDeviceId: null,
        tokenId: PORTAL_TOKEN_ID as TokenId,
        scopes: [SCOPE_ADMIN] as Scope[],
        csrfToken: PORTAL_CSRF_TOKEN,
      });
      await next();
    });
    mountPrivacyRoutes(strictRoute(app), {
      privacyAdminService: new PrivacyAdminService({
        db,
        policyStore: new PrivacyPolicyStore(dir, { db, writeGate }),
        writeGate,
      }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = previousExperimental;
  });

  it("lists the built-in policy templates with experimental mode disabled", async () => {
    const res = await app.request("/admin/privacy/policy/templates");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      templates: Array<{ id: string; isDefault: boolean; policy: string }>;
    };
    expect(body.templates.map((t) => t.id)).toEqual(["guarded", "balanced", "open", "unfiltered"]);
    expect(body.templates.filter((t) => t.isDefault)).toHaveLength(1);
    for (const template of body.templates.filter((t) => t.id !== "unfiltered")) {
      expect(template.policy).toContain("Never released automatically");
    }
    const unfiltered = body.templates.find((template) => template.id === "unfiltered");
    expect(unfiltered?.policy).toContain("| All information not listed below | Allow | Allow |");
    expect(unfiltered?.policy).toContain(
      "| Identity documents | Approval required | Approval required |",
    );
    expect(unfiltered?.policy).toContain(
      "| Passwords, authentication codes, tokens, private keys, and recovery codes | Approval required | Approval required |",
    );
    expect(unfiltered?.policy).toContain("This rule is exhaustive.");
    expect(unfiltered?.policy).not.toContain("Release with reductions");
    expect(unfiltered?.policy).not.toContain("Deny");

    expect((await app.request("/admin/privacy/policy/templates")).status).toBe(200);
  });

  it("creates, updates, restores, and forks named policy families by family version", async () => {
    const createdResponse = await app.request("/admin/privacy/policies", {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({ name: "Fictional research policy", templateId: "guarded" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      familyId: string;
      familyVersion: number;
      revision: string;
      policy: string;
    };
    expect(created).toMatchObject({ familyVersion: 1, familyName: "Fictional research policy" });

    const updatedResponse = await app.request(`/admin/privacy/policies/${created.familyId}`, {
      method: "PATCH",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({
        policy: `${created.policy}\n<!-- fictional family edit -->\n`,
        beforeVersion: 1,
      }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = (await updatedResponse.json()) as { familyVersion: number; revision: string };
    expect(updated.familyVersion).toBe(2);

    const history = await app.request(
      `/admin/privacy/policies/${created.familyId}/history?beforeVersion=3`,
    );
    expect(await history.json()).toMatchObject({
      versions: [{ familyVersion: 2 }, { familyVersion: 1 }],
    });
    const restored = await app.request(`/admin/privacy/policies/${created.familyId}/restore`, {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({ version: 1, expectedRevision: updated.revision }),
    });
    expect(await restored.json()).toMatchObject({ familyVersion: 3, policy: created.policy });

    const forked = await app.request(`/admin/privacy/policies/${created.familyId}/fork`, {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({ name: "Fictional research copy" }),
    });
    expect(forked.status).toBe(201);
    expect(await forked.json()).toMatchObject({
      familyName: "Fictional research copy",
      familyVersion: 1,
    });
  });

  it("deletes an unused named policy and protects the default policy", async () => {
    await app.request("/admin/privacy/policy");
    const createdResponse = await app.request("/admin/privacy/policies", {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({ name: "Unused policy", templateId: "balanced" }),
    });
    const created = await createdResponse.json();
    db.exec("CREATE TABLE access_level_capabilities (policy_family_id TEXT)");
    db.prepare("INSERT INTO access_level_capabilities VALUES (?)").run(created.familyId);
    const inUse = await app.request(`/admin/privacy/policies/${created.familyId}`, {
      method: "DELETE",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({
      code: "policy_in_use",
      error: expect.stringContaining("access level"),
    });
    db.exec("DELETE FROM access_level_capabilities");
    const deleted = await app.request(`/admin/privacy/policies/${created.familyId}`, {
      method: "DELETE",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/admin/privacy/policies/${created.familyId}`)).status).toBe(404);
    const policies = await (await app.request("/admin/privacy/policies")).json();
    expect(policies.policies.map((policy: { id: string }) => policy.id)).not.toContain(
      created.familyId,
    );
    const blocked = await app.request(`/admin/privacy/policies/${policies.policies[0].id}`, {
      method: "DELETE",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "policy_in_use" });
    expect(
      (
        await app.request("/admin/privacy/policies/not-a-uuid", {
          method: "DELETE",
          headers: POLICY_MUTATION_HEADERS,
        })
      ).status,
    ).toBe(400);
    expect(
      (await app.request(`/admin/privacy/policies/${created.familyId}`, { method: "DELETE" }))
        .status,
    ).toBe(403);
  });

  it("returns 400 for a malformed policy-family id on reads and mutations", async () => {
    const read = await app.request("/admin/privacy/policies/not-a-uuid");
    expect(read.status).toBe(400);
    await expect(read.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });

    const mutation = await app.request("/admin/privacy/policies/not-a-uuid", {
      method: "PATCH",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({
        policy: "# Synthetic policy\n\nAllow fictional summaries.\n",
        expectedRevision: "a".repeat(64),
      }),
    });
    expect(mutation.status).toBe(400);
    await expect(mutation.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reads and optimistically updates the one global policy", async () => {
    const initial = await app.request("/admin/privacy/policy");
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    const document = (await initial.json()) as { policy: string; revision: string };
    expect(document.policy).toContain("| Information | Existence | Summary | Exact or original |");

    const updated = await app.request("/admin/privacy/policy", {
      method: "PUT",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({
        policy: "# Synthetic privacy policy\n\nAsk before releasing private messages.",
        expectedRevision: document.revision,
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      policy: expect.stringContaining("Synthetic privacy policy"),
    });

    const stale = await app.request("/admin/privacy/policy", {
      method: "PUT",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({ policy: "# Stale", expectedRevision: document.revision }),
    });
    expect(stale.status).toBe(409);

    const health = await app.request("/admin/privacy/reviewer-health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      recentOperationalFailureCount: 0,
      lastFailureAt: null,
    });
  });

  it("lists immutable policy history and appends a revert", async () => {
    const initial = (await (await app.request("/admin/privacy/policy")).json()) as {
      generation: number;
      revision: string;
      policy: string;
    };
    const changedResponse = await app.request("/admin/privacy/policy", {
      method: "PUT",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({
        policy: "# Replacement policy\n\nRequire approval for exact details.\n",
        expectedRevision: initial.revision,
      }),
    });
    expect(changedResponse.status).toBe(200);
    const changed = (await changedResponse.json()) as { generation: number; revision: string };

    const history = await app.request("/admin/privacy/policy/history?limit=10");
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      versions: [
        { generation: changed.generation, action: "edit" },
        { generation: initial.generation, action: "bootstrap" },
      ],
      pageInfo: { hasMore: false, limit: 10 },
    });

    const detail = await app.request(`/admin/privacy/policy/history/${initial.generation}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ version: { policy: initial.policy } });

    const revertedResponse = await app.request("/admin/privacy/policy/revert", {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({
        generation: initial.generation,
        expectedRevision: changed.revision,
      }),
    });
    expect(revertedResponse.status).toBe(200);
    const reverted = (await revertedResponse.json()) as {
      generation: number;
      revision: string;
      policy: string;
    };
    expect(reverted.policy).toBe(initial.policy);
    expect(reverted.generation).toBeGreaterThan(changed.generation);
    expect(reverted.revision).not.toBe(initial.revision);

    const latestHistory = (await (
      await app.request("/admin/privacy/policy/history?limit=1")
    ).json()) as { versions: Array<Record<string, unknown>> };
    expect(latestHistory.versions[0]).toMatchObject({
      action: "revert",
      revertedFromGeneration: initial.generation,
    });
  });

  it("rejects bearer-admin policy mutation even with a CSRF header", async () => {
    const bearerApp = new Hono<AppEnv>();
    bearerApp.onError((err, c) => {
      if (err instanceof HttpError) return errorResponse(c, err);
      throw err;
    });
    bearerApp.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: PORTAL_DEVICE_ID as DeviceId,
        tokenId: PORTAL_TOKEN_ID as TokenId,
        scopes: [SCOPE_ADMIN] as Scope[],
      });
      await next();
    });
    bearerApp.put("/policy", scope.portalAdmin(), (c) => c.json({ ok: true }));
    mountPrivacyRoutes(strictRoute(bearerApp), {});

    const response = await bearerApp.request("/policy", {
      method: "PUT",
      headers: { "X-Omnesis-CSRF": PORTAL_CSRF_TOKEN },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("portal session required");
    const deleted = await bearerApp.request(`/admin/privacy/policies/${PORTAL_DEVICE_ID}`, {
      method: "DELETE",
      headers: { "X-Omnesis-CSRF": PORTAL_CSRF_TOKEN },
    });
    expect(deleted.status).toBe(403);
  });

  it("removes the legacy standing-watch endpoint", async () => {
    const response = await app.request("/admin/privacy/policy/watch-auto-approval", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ integrations: [], categories: [], expectedRevision: "a".repeat(64) }),
    });
    expect(response.status).toBe(404);
  });

  it("does not expose retired workflow-grant routes", async () => {
    expect((await app.request("/admin/privacy/grants")).status).toBe(404);
    expect(
      (
        await app.request("/admin/privacy/grants/grant-example/revoke", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("edits one decision from the controls, and reports the table back with the document", async () => {
    const readPolicy = async () => {
      const res = await app.request("/admin/privacy/policy");
      return (await res.json()) as {
        policy: string;
        revision: string;
        schema: {
          rows: Array<{ label: string; existence: string; summary: string; exact: string }>;
          credentialApprovalEnabled: boolean;
        } | null;
      };
    };
    const patch = (body: unknown) =>
      app.request("/admin/privacy/policy", {
        method: "PATCH",
        headers: POLICY_MUTATION_HEADERS,
        body: JSON.stringify(body),
      });

    const initial = await readPolicy();
    expect(initial.schema?.rows.find((row) => row.label === "Health")).toEqual({
      label: "Health",
      existence: "approve",
      summary: "approve",
      exact: "deny",
    });

    const edited = await patch({
      row: "Health",
      existence: "deny",
      summary: "deny",
      expectedRevision: initial.revision,
    });
    expect(edited.status).toBe(200);
    const editedBody = (await edited.json()) as Awaited<ReturnType<typeof readPolicy>>;
    // The write reports the same projection a read would, so a client never has
    // to re-fetch to learn what it just changed.
    expect(editedBody.schema?.rows.find((row) => row.label === "Health")?.summary).toBe("deny");
    expect(editedBody.schema?.rows.find((row) => row.label === "Health")?.existence).toBe("deny");
    expect((await readPolicy()).schema).toEqual(editedBody.schema);
    expect(editedBody.revision).not.toBe(initial.revision);

    // The revision moved under this body, so the write is refused and the
    // caller is handed the document as it now stands.
    const stale = await patch({
      row: "Health",
      summary: "allow",
      expectedRevision: initial.revision,
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "PRIVACY_POLICY_CONFLICT",
      detail: { revision: editedBody.revision, schema: editedBody.schema },
    });
  });

  it("refuses a schema edit the stored policy cannot express", async () => {
    const initial = (await (await app.request("/admin/privacy/policy")).json()) as {
      revision: string;
    };
    const patch = (body: unknown) =>
      app.request("/admin/privacy/policy", {
        method: "PATCH",
        headers: POLICY_MUTATION_HEADERS,
        body: JSON.stringify(body),
      });

    // A row the table does not have: a stale client must not rewrite a policy
    // it cannot see.
    expect(
      (await patch({ row: "Nonexistent", summary: "allow", expectedRevision: initial.revision }))
        .status,
    ).toBe(400);

    // A body naming neither a row nor the credential opt-in changes nothing.
    const empty = await patch({ expectedRevision: initial.revision });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("credentialApprovalEnabled");

    // Decisions without a row do not say which row they apply to.
    const rowless = await patch({ summary: "allow", expectedRevision: initial.revision });
    expect(rowless.status).toBe(400);
    expect(await rowless.text()).toContain("require a row");

    // An existence bit cannot be generalized into a lower-detail signal.
    const reducedExistence = await patch({
      row: "Health",
      existence: "reduce",
      expectedRevision: initial.revision,
    });
    expect(reducedExistence.status).toBe(400);

    // A policy hand-edited past the grammar: the client falls back to text.
    const replaced = await app.request("/admin/privacy/policy", {
      method: "PUT",
      headers: POLICY_MUTATION_HEADERS,
      body: JSON.stringify({
        policy: "# Synthetic policy\n\nNo decision table here.\n",
        expectedRevision: initial.revision,
      }),
    });
    const replacedBody = (await replaced.json()) as { revision: string; schema: unknown };
    expect(replacedBody.schema).toBeNull();
    const unparseable = await patch({
      row: "Health",
      summary: "allow",
      expectedRevision: replacedBody.revision,
    });
    expect(unparseable.status).toBe(400);
    expect(await unparseable.text()).toContain("Edit it as text instead");
  });

  it("keeps approval lists metadata-only and exposes the candidate only on admin detail", async () => {
    const writeGate = directWriteGate(db);
    await writeGate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-1",
      question: "Synthetic question",
      ids: { workflowId: "wf-1", conversationId: "conv-1", taskId: "task-1" },
      now: 100,
      workflowExpiresAt: 10_000,
    });
    await writeGate.completeAnswerTask({
      taskId: "task-1",
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-1",
        candidateAnswer: "Held synthetic answer",
        candidateDigest: digestCandidate("Held synthetic answer"),
        releaseStatus: "released",
        reductions: [],
        expiresAt: Date.now() + 10_000,
      },
    });
    await writeGate.recordAnswerEgress({
      id: "egress-approval-required",
      taskId: "task-1",
      ownerId: "token:external",
      endpoint: "/answer",
      now: 201,
    });
    const list = await app.request("/admin/privacy/approvals");
    const listText = await list.text();
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(listText).toContain("approval-1");
    expect(listText).toContain("OpenClaw");
    expect(listText).not.toContain("Held synthetic answer");

    const detail = await app.request("/admin/privacy/approvals/approval-1");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      approval: {
        candidateAnswer: "Held synthetic answer",
        question: "Synthetic question",
        externalAgent: { displayName: "OpenClaw", source: "token" },
        review: { fallbackCause: null },
      },
    });

    const approved = await app.request("/admin/privacy/approvals/approval-1/approve", {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      status: "released",
      answer: "Held synthetic answer",
    });
    const readyDetail = await app.request("/admin/privacy/approvals/approval-1");
    await expect(readyDetail.json()).resolves.toMatchObject({
      approval: { status: "approved", sharedAt: null },
    });
    await writeGate.recordAnswerEgress({
      id: "egress-released-answer",
      taskId: "task-1",
      ownerId: "token:external",
      endpoint: "/answer/tasks/:id",
      now: 300,
    });
    const sharedDetail = await app.request("/admin/privacy/approvals/approval-1");
    await expect(sharedDetail.json()).resolves.toMatchObject({
      approval: { status: "approved", sharedAt: 300 },
    });
    const resolution = listPrivacyAuditEvents(db, "conv-1", 50)?.events.find(
      (event) => event.kind === "approval_resolved",
    );
    expect(resolution).toBeDefined();
    expect(getPrivacyAuditEvent(db, "conv-1", resolution!.id)?.payload).toEqual({
      approvalId: "approval-1",
      status: "approved",
      resolvedAt: expect.any(Number),
      action: "approve",
      outcome: "approved",
      request: {
        requestId: "privacy-route-request",
        tokenId: PORTAL_TOKEN_ID,
        deviceId: PORTAL_DEVICE_ID,
      },
    });

    const audit = await app.request("/admin/privacy/decisions");
    await expect(audit.json()).resolves.toMatchObject({
      decisions: [expect.objectContaining({ status: "released", answer: "Held synthetic answer" })],
    });
  });

  it("names the policy family a review ran under on the feed, the exchange, and the approval", async () => {
    const writeGate = directWriteGate(db);
    const familyReview: PrivacyReviewRecord = {
      ...review,
      policyFamilyId: "33333333-3333-4333-8333-333333333333",
      policyFamilyName: "Fictional research policy",
    };
    await writeGate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "family-request",
      question: "Synthetic question",
      ids: { workflowId: "wf-family", conversationId: "conv-family", taskId: "task-family" },
      now: 100,
      workflowExpiresAt: 10_000,
    });
    await writeGate.completeAnswerTask({
      taskId: "task-family",
      ownerId: "token:external",
      review: familyReview,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-family",
        candidateAnswer: "Held synthetic answer",
        candidateDigest: digestCandidate("Held synthetic answer"),
        releaseStatus: "released",
        reductions: [],
        expiresAt: Date.now() + 10_000,
      },
    });
    // A record written before families were recorded carries only the revision.
    await writeGate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "older-request",
      question: "Older synthetic question",
      ids: { workflowId: "wf-older", conversationId: "conv-older", taskId: "task-older" },
      now: 300,
      workflowExpiresAt: 10_000,
    });
    await writeGate.completeAnswerTask({
      taskId: "task-older",
      ownerId: "token:external",
      review,
      now: 400,
      outcome: { kind: "deny", reason: "privacy_policy" },
    });
    const named = {
      policyFamilyId: familyReview.policyFamilyId,
      policyFamilyName: familyReview.policyFamilyName,
    };

    type Feed = { exchanges: Array<{ taskId: string; review: Record<string, unknown> | null }> };
    const feed = (await (await app.request("/admin/privacy/exchanges")).json()) as Feed;
    expect(
      feed.exchanges.find((exchange) => exchange.taskId === "task-family")?.review,
    ).toMatchObject(named);
    const older = feed.exchanges.find((exchange) => exchange.taskId === "task-older")?.review;
    expect(older).toMatchObject({ rationale: review.rationale });
    expect(older).not.toHaveProperty("policyFamilyId");
    expect(older).not.toHaveProperty("policyFamilyName");

    const detail = (await (
      await app.request("/admin/privacy/conversations/conv-family/exchanges")
    ).json()) as Feed;
    expect(detail.exchanges[0]?.review).toMatchObject(named);

    await expect(
      (await app.request("/admin/privacy/approvals/approval-family")).json(),
    ).resolves.toMatchObject({ approval: { review: named } });
  });

  it("keyset-paginates approval history and scopes cursors to the status filter", async () => {
    const writeGate = directWriteGate(db);
    const expiresAt = Date.now() + 60_000;
    for (const index of [1, 2, 3]) {
      await writeGate.beginAnswerTask({
        ownerId: "token:external",
        clientRequestId: `page-request-${index}`,
        question: `Synthetic page question ${index}`,
        ids: {
          workflowId: `page-workflow-${index}`,
          conversationId: `page-conversation-${index}`,
          taskId: `page-task-${index}`,
        },
        now: 100 + index,
        workflowExpiresAt: expiresAt,
      });
      await writeGate.completeAnswerTask({
        taskId: `page-task-${index}`,
        ownerId: "token:external",
        review,
        now: 200 + index,
        outcome: {
          kind: "approval",
          approvalId: `page-approval-${index}`,
          candidateAnswer: `Synthetic held answer ${index}`,
          candidateDigest: digestCandidate(`Synthetic held answer ${index}`),
          releaseStatus: "released",
          reductions: [],
          expiresAt,
        },
      });
    }

    const first = (await (
      await app.request("/admin/privacy/approvals?status=pending&limit=2")
    ).json()) as {
      approvals: Array<{ id: string }>;
      nextCursor: string | null;
      totalCount: number;
    };
    expect(first.approvals.map((approval) => approval.id)).toEqual([
      "page-approval-3",
      "page-approval-2",
    ]);
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (await (
      await app.request(
        `/admin/privacy/approvals?status=pending&limit=2&cursor=${encodeURIComponent(
          first.nextCursor!,
        )}`,
      )
    ).json()) as typeof first;
    expect(second.approvals.map((approval) => approval.id)).toEqual(["page-approval-1"]);
    expect(second).toMatchObject({ nextCursor: null, totalCount: 3 });
    expect(
      (
        await app.request(
          `/admin/privacy/approvals?status=all&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).status,
    ).toBe(400);
  });

  it("serves lazy conversation audit payloads only to admin scope and deletes them", async () => {
    const writeGate = directWriteGate(db);
    await writeGate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-audit",
      question: "Summarize the fictional planning note.",
      workflowName: "Planning assistant",
      ids: { workflowId: "wf-audit", conversationId: "conv-audit", taskId: "task-audit" },
      now: 100,
      workflowExpiresAt: 10_000,
    });
    await writeGate.appendAnswerAuditEvents([
      {
        id: "event-candidate",
        taskId: "task-audit",
        ownerId: "token:external",
        kind: "candidate_generated",
        display: auditDisplay({ title: "Candidate inside Omnesis", text: "Bounded preview" }),
        payload: { candidateAnswer: "Full trusted candidate" },
        now: 110,
      },
      {
        id: "event-agent-trace",
        taskId: "task-audit",
        ownerId: "token:external",
        kind: "agent_trace",
        display: auditDisplay({ title: "Agent activity" }),
        payload: {
          provider: "synthetic-provider",
          model: "synthetic-model",
          sessionId: "synthetic-session",
          messages: [{ role: "assistant", parts: [{ kind: "text", text: "Observable output" }] }],
        },
        now: 109,
      },
    ]);
    await writeGate.completeAnswerTask({
      taskId: "task-audit",
      ownerId: "token:external",
      review,
      now: 120,
      outcome: {
        kind: "release",
        releaseId: "release-audit",
        answer: "Bounded preview",
        expectedDisclosureRevision: 0,
      },
    });
    await writeGate.recordAnswerEgress({
      id: "egress-audit",
      taskId: "task-audit",
      ownerId: "token:external",
      endpoint: "/answer",
      now: 121,
    });
    await writeGate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-other",
      question: "Summarize another fictional planning note.",
      workflowName: "Another planning assistant",
      ids: { workflowId: "wf-other", conversationId: "conv-other", taskId: "task-other" },
      now: 200,
      workflowExpiresAt: 10_000,
    });

    const list = await app.request("/admin/privacy/conversations?limit=10");
    const listText = await list.text();
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(listText).toContain("conv-audit");
    expect(listText).toContain("OpenClaw");
    expect(listText).not.toContain("Full trusted candidate");

    const exchanges = await app.request(
      "/admin/privacy/conversations/conv-audit/exchanges?limit=10",
    );
    expect(exchanges.status).toBe(200);
    expect(exchanges.headers.get("cache-control")).toBe("no-store");
    const exchangesText = await exchanges.text();
    expect(JSON.parse(exchangesText)).toMatchObject({
      exchanges: [
        {
          outcome: "shared",
          sharedAnswer: "Bounded preview",
          pendingCandidate: null,
          externalAgent: { displayName: "OpenClaw", source: "token" },
        },
      ],
    });
    expect(exchangesText).not.toContain("Observable output");

    const exchangeWithTrace = await app.request(
      "/admin/privacy/conversations/conv-audit/exchanges?includeAgentTracesTaskId=task-audit",
    );
    expect(exchangeWithTrace.status).toBe(200);
    expect(await exchangeWithTrace.text()).toContain("Observable output");

    const exchangeFromAnotherConversation = await app.request(
      "/admin/privacy/conversations/conv-audit/exchanges?includeAgentTracesTaskId=task-other",
    );
    expect(exchangeFromAnotherConversation.status).toBe(200);
    await expect(exchangeFromAnotherConversation.json()).resolves.toMatchObject({ exchanges: [] });

    const events = await app.request("/admin/privacy/conversations/conv-audit/events");
    const eventsText = await events.text();
    expect(events.status).toBe(200);
    expect(eventsText).toContain("event-candidate");
    expect(eventsText).not.toContain("Full trusted candidate");

    const payload = await app.request(
      "/admin/privacy/conversations/conv-audit/events/event-candidate",
    );
    expect(payload.status).toBe(200);
    await expect(payload.json()).resolves.toMatchObject({
      event: { payload: { candidateAnswer: "Full trusted candidate" } },
    });

    const answerOnlyApp = new Hono<AppEnv>();
    answerOnlyApp.onError((err, c) => {
      if (err instanceof HttpError) return errorResponse(c, err);
      throw err;
    });
    answerOnlyApp.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: "answer-device" as DeviceId,
        tokenId: "answer-token" as TokenId,
        scopes: [SCOPE_ANSWER] as Scope[],
      });
      await next();
    });
    mountPrivacyRoutes(strictRoute(answerOnlyApp), {
      privacyAdminService: new PrivacyAdminService({
        db,
        policyStore: new PrivacyPolicyStore(dir),
        writeGate,
      }),
    });
    expect((await answerOnlyApp.request("/admin/privacy/conversations")).status).toBe(403);

    const deleted = await app.request("/admin/privacy/conversations/conv-audit", {
      method: "DELETE",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(deleted.status).toBe(200);
    expect((await app.request("/admin/privacy/conversations/conv-audit")).status).toBe(404);
  });

  it("presents lapsed held answers as expired on conversation, exchange, and decision routes", async () => {
    const now = Date.now();
    const writeGate = directWriteGate(db);
    for (const suffix of ["detail", "exchanges"]) {
      const candidate = `Held synthetic answer for ${suffix}`;
      await writeGate.beginAnswerTask({
        ownerId: "token:external",
        clientRequestId: `request-expired-${suffix}`,
        question: `Synthetic expired question for ${suffix}`,
        ids: {
          workflowId: `wf-expired-${suffix}`,
          conversationId: `conv-expired-${suffix}`,
          taskId: `task-expired-${suffix}`,
        },
        now: now - 1_000,
        workflowExpiresAt: now + 60_000,
      });
      await writeGate.completeAnswerTask({
        taskId: `task-expired-${suffix}`,
        ownerId: "token:external",
        review,
        now: now - 500,
        outcome: {
          kind: "approval",
          approvalId: `approval-expired-${suffix}`,
          candidateAnswer: candidate,
          candidateDigest: digestCandidate(candidate),
          releaseStatus: "released",
          reductions: [],
          expiresAt: now - 1,
        },
      });
    }

    const conversation = await app.request("/admin/privacy/conversations/conv-expired-detail");
    expect(conversation.status).toBe(200);
    await expect(conversation.json()).resolves.toMatchObject({
      conversation: {
        latestStatus: "denied",
        latestOutcome: "not_shared",
        pendingApprovalCount: 0,
      },
    });

    // The paged conversations list shares the projection and outcome
    // mapping — the lapsed conversations must not read as pending there
    // either.
    const list = await app.request("/admin/privacy/conversations");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      conversations: Array<{ id: string; latestStatus: string; pendingApprovalCount: number }>;
    };
    for (const suffix of ["detail", "exchanges"]) {
      expect(listBody.conversations.find((c) => c.id === `conv-expired-${suffix}`)).toMatchObject({
        latestStatus: "denied",
        pendingApprovalCount: 0,
      });
    }

    const decisions = await app.request("/admin/privacy/decisions");
    expect(decisions.status).toBe(200);
    const decisionsBody = (await decisions.json()) as {
      decisions: Array<{ taskId: string; status: string }>;
    };
    for (const suffix of ["detail", "exchanges"]) {
      expect(
        decisionsBody.decisions.find((d) => d.taskId === `task-expired-${suffix}`),
      ).toMatchObject({ status: "denied" });
    }

    const exchanges = await app.request(
      "/admin/privacy/conversations/conv-expired-exchanges/exchanges",
    );
    expect(exchanges.status).toBe(200);
    await expect(exchanges.json()).resolves.toMatchObject({
      exchanges: [
        {
          status: "denied",
          outcome: "not_shared",
          pendingCandidate: null,
          approval: {
            id: "approval-expired-exchanges",
            status: "expired",
          },
          userDecision: "expired",
        },
      ],
    });
  });

  it("reports a hard stop discovered when the user tries to approve", async () => {
    const writeGate = directWriteGate(db);
    const candidate = ["Bearer", "synthetic_token_value_1234567890"].join(" ");
    const now = Date.now();
    await writeGate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-hard-stop",
      question: "Return the fictional service credential.",
      ids: {
        workflowId: "wf-hard-stop",
        conversationId: "conv-hard-stop",
        taskId: "task-hard-stop",
      },
      now,
      workflowExpiresAt: now + 60_000,
    });
    await writeGate.completeAnswerTask({
      taskId: "task-hard-stop",
      ownerId: "token:external",
      review,
      now: now + 1,
      outcome: {
        kind: "approval",
        approvalId: "approval-hard-stop",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: now + 60_000,
      },
    });

    const resolution = await app.request("/admin/privacy/approvals/approval-hard-stop/approve", {
      method: "POST",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(resolution.status).toBe(200);
    await expect(resolution.json()).resolves.toMatchObject({
      status: "denied",
      reason: "hard_stop",
    });

    const detail = await app.request("/admin/privacy/approvals/approval-hard-stop");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      approval: {
        status: "denied",
        review: { fallbackCause: "hard_stop" },
      },
    });

    const exchanges = await app.request("/admin/privacy/conversations/conv-hard-stop/exchanges");
    await expect(exchanges.json()).resolves.toMatchObject({
      exchanges: [
        {
          outcome: "not_shared",
          sharedAnswer: null,
          pendingCandidate: null,
          userDecision: "approved_but_blocked",
          review: { fallbackCause: "hard_stop" },
        },
      ],
    });
  });

  it("serves the landing feed newest-first across conversations, and pages it", async () => {
    const writeGate = directWriteGate(db);
    for (const index of [1, 2, 3]) {
      await writeGate.beginAnswerTask({
        ownerId: "token:external",
        clientRequestId: `feed-request-${index}`,
        question: `Synthetic feed question ${index}`,
        ids: {
          workflowId: `feed-workflow-${index}`,
          conversationId: `feed-conversation-${index}`,
          taskId: `feed-task-${index}`,
        },
        now: index * 100,
        workflowExpiresAt: 1_000_000,
      });
    }

    const first = await app.request("/admin/privacy/exchanges?limit=2");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstBody = (await first.json()) as {
      exchanges: Array<{ taskId: string; conversationId: string; externalAgent: unknown }>;
      nextCursor: string | null;
    };
    // One row is one exchange, newest first — the feed is flat, not grouped by
    // conversation.
    expect(firstBody.exchanges.map((exchange) => exchange.taskId)).toEqual([
      "feed-task-3",
      "feed-task-2",
    ]);
    expect(firstBody.exchanges[0]!.externalAgent).toEqual({
      displayName: "OpenClaw",
      narrativeName: "OpenClaw",
      integrationSlug: null,
      source: "token",
    });
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = (await (
      await app.request(
        `/admin/privacy/exchanges?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      )
    ).json()) as typeof firstBody;
    expect(second.exchanges.map((exchange) => exchange.taskId)).toEqual(["feed-task-1"]);
    expect(second.nextCursor).toBeNull();

    expect((await app.request("/admin/privacy/exchanges?cursor=not-a-cursor")).status).toBe(400);
    expect((await app.request("/admin/privacy/exchanges?limit=0")).status).toBe(400);

    expect((await app.request("/admin/privacy/exchanges")).status).toBe(200);
  });

  describe("direct audit transcript routes", () => {
    function seedDirectEvent(
      overrides: Partial<Parameters<typeof appendDirectAuditEvent>[1]> = {},
      now = 1_700_000_000_000,
    ): { sessionId: string; eventId: string } {
      const { session, eventId } = appendDirectAuditEvent(db, {
        ownerId: "principal:fictional",
        principalId: "principal_fictional",
        credentialId: "credential_fictional",
        grantId: "grant_fictional",
        tool: "search_many",
        outcome: "ok",
        requestId: "request_fictional",
        args: { query: "fictional schedule" },
        result: { documents: [] },
        now,
        ...overrides,
      });
      return { sessionId: session.id, eventId };
    }

    it("lists sessions newest first behind the admin scope", async () => {
      const first = seedDirectEvent({}, 1_700_000_000_000);
      const second = seedDirectEvent(
        { conversationId: "conv_fictional" },
        1_700_000_000_000 + 5_000,
      );
      const res = await app.request("/admin/privacy/direct/sessions?limit=50");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((session) => session.id)).toEqual([
        second.sessionId,
        first.sessionId,
      ]);
    });

    it("rejects an out-of-range limit", async () => {
      const res = await app.request("/admin/privacy/direct/sessions?limit=500");
      expect(res.status).toBe(400);
    });

    it("reads one session transcript and one event", async () => {
      const { sessionId, eventId } = seedDirectEvent();
      const eventsRes = await app.request(
        `/admin/privacy/direct/sessions/${sessionId}/events?limit=50`,
      );
      expect(eventsRes.status).toBe(200);
      const eventsBody = (await eventsRes.json()) as { events: Array<{ id: string }> };
      expect(eventsBody.events.map((event) => event.id)).toEqual([eventId]);

      const eventRes = await app.request(`/admin/privacy/direct/events/${eventId}`);
      expect(eventRes.status).toBe(200);
      const eventBody = (await eventRes.json()) as { event: { id: string; tool: string } };
      expect(eventBody.event).toMatchObject({ id: eventId, tool: "search_many" });
    });

    it("returns 404 for unknown sessions and events", async () => {
      expect((await app.request("/admin/privacy/direct/sessions/missing/events")).status).toBe(404);
      expect((await app.request("/admin/privacy/direct/events/missing")).status).toBe(404);
      expect(
        (
          await app.request("/admin/privacy/direct/sessions/missing", {
            method: "DELETE",
            headers: POLICY_MUTATION_HEADERS,
          })
        ).status,
      ).toBe(404);
    });

    it("deletes a session with its transcript", async () => {
      const { sessionId, eventId } = seedDirectEvent();
      const deleted = await app.request(`/admin/privacy/direct/sessions/${sessionId}`, {
        method: "DELETE",
        headers: POLICY_MUTATION_HEADERS,
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
      expect((await app.request(`/admin/privacy/direct/events/${eventId}`)).status).toBe(404);
    });
  });

  it("rejects deletion while an external answer is still running", async () => {
    await directWriteGate(db).beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-running",
      question: "A synthetic in-flight question.",
      ids: {
        workflowId: "wf-running",
        conversationId: "conv-running",
        taskId: "task-running",
      },
      now: 100,
      workflowExpiresAt: 10_000,
    });

    const response = await app.request("/admin/privacy/conversations/conv-running", {
      method: "DELETE",
      headers: POLICY_MUTATION_HEADERS,
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
