// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis watches` — the operator-facing name for what an integration asks
 * Omnesis to keep an eye on. The HTTP surface it drives is `/subscriptions`:
 * subscription is the transport's term for the same object, and stays put in
 * the routes and the response types. The one exception is `purge`, an
 * operator-only hard delete that drives the admin surface
 * (`/admin/privacy/subscriptions`) because it reaches across every
 * integration device rather than acting as one.
 */

import { defineCommand } from "citty";
import { assertNever } from "@omnesis/core";
import { c, CliError, EXIT_USER_ERROR, gatewayJson } from "../utils.js";
import type {
  CreateSubscriptionRequest,
  SubscriptionDetail,
  SubscriptionPurgeSummary,
  SubscriptionSummary,
  UpdateSubscriptionRequest,
} from "@omnesis/types";

function requiredString(value: unknown, flag: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`${c.red}${flag} is required.${c.reset}`, EXIT_USER_ERROR);
  }
  return value.trim();
}

function parseExpiresAt(value: unknown, allowNone: boolean): number | null | undefined {
  if (value === undefined) return undefined;
  const raw = requiredString(value, "--expires-at");
  if (allowNone && raw.toLowerCase() === "none") return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(
      `${c.red}--expires-at must be an ISO timestamp${allowNone ? ' or "none"' : ""}.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return parsed;
}

/**
 * What a firing does, in one line. Exhaustive so a new delivery kind must say
 * how it reads rather than silently rendering as a push.
 */
function reactionLine(reaction: SubscriptionSummary["reaction"]): string {
  switch (reaction.kind) {
    case "agent-workflow":
      return reaction.instruction;
    case "ios-push": {
      const text = [reaction.title, reaction.body]
        .filter((value) => value !== undefined)
        .join(" — ");
      return text.length > 0
        ? `notify this device's owner — ${text}`
        : "notify this device's owner";
    }
    default:
      return assertNever(reaction);
  }
}

function printWatch(subscription: SubscriptionSummary | SubscriptionDetail): void {
  const reaction = reactionLine(subscription.reaction);
  console.log(`${subscription.id}  ${subscription.status}`);
  console.log(`  Revision:  ${subscription.revision}`);
  console.log(`  Condition: ${subscription.condition.description}`);
  console.log(`  Reaction:  ${reaction}`);
  console.log(`  Workflow:  ${subscription.workflowHandle}`);
  console.log(`  Expires:   ${new Date(subscription.expiresAt).toISOString()}`);
}

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a natural-language watch" },
  args: {
    condition: { type: "string", description: "Natural-language match condition" },
    reaction: { type: "string", description: "Exact agent-workflow instruction" },
    "idempotency-key": {
      type: "string",
      description: "Stable retry key (at least 8 characters)",
    },
    "workflow-id": {
      type: "string",
      description: "Existing opaque workflow identifier to reuse",
    },
    "expires-at": { type: "string", description: "Optional ISO expiry timestamp" },
  },
  async run(ctx) {
    const condition = requiredString(ctx.args.condition, "--condition");
    const reaction = requiredString(ctx.args.reaction, "--reaction");
    const idempotencyKey = requiredString(ctx.args["idempotency-key"], "--idempotency-key");
    if (idempotencyKey.length < 8) {
      throw new CliError(
        `${c.red}--idempotency-key must be at least 8 characters.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const workflowId =
      typeof ctx.args["workflow-id"] === "string"
        ? requiredString(ctx.args["workflow-id"], "--workflow-id")
        : undefined;
    const expiresAt = parseExpiresAt(ctx.args["expires-at"], false);
    const body: CreateSubscriptionRequest = {
      condition: { kind: "natural-language", description: condition },
      reaction: { kind: "agent-workflow", instruction: reaction },
      idempotencyKey,
      ...(workflowId ? { workflowId } : {}),
      ...(expiresAt !== undefined && expiresAt !== null ? { expiresAt } : {}),
    };
    const { subscription } = await gatewayJson<{ subscription: SubscriptionDetail }>(
      "/subscriptions",
      { method: "POST", body: JSON.stringify(body) },
    );
    printWatch(subscription);
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List this agent device's watches" },
  args: {
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const result = await gatewayJson<{ subscriptions: SubscriptionSummary[] }>("/subscriptions");
    if (ctx.args.json === true) {
      console.log(JSON.stringify(result));
      return;
    }
    if (result.subscriptions.length === 0) {
      // Not "No watches." An empty list here is scoped, not global: the route
      // answers as the calling agent device and returns only what that device
      // created, so an operator running it on their own token reads a correct
      // empty list as proof they have nothing installed — while the watches
      // they wrote themselves are running, and listed elsewhere.
      console.log("No watches for this agent device.");
      console.log(
        "  This lists only the watches the calling device created; watches you authored yourself are not among them.",
      );
      console.log("  `omnesis watch list` shows every watch the runtime is running.");
      return;
    }
    for (const subscription of result.subscriptions) printWatch(subscription);
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Inspect one watch" },
  args: {
    id: { type: "positional", description: "watch id", required: true },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const id = requiredString(ctx.args.id, "watch id");
    const result = await gatewayJson<{ subscription: SubscriptionDetail }>(
      `/subscriptions/${encodeURIComponent(id)}`,
    );
    if (ctx.args.json === true) console.log(JSON.stringify(result));
    else printWatch(result.subscription);
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update or pause a watch" },
  args: {
    id: { type: "positional", description: "watch id", required: true },
    condition: { type: "string", description: "Replacement match condition" },
    reaction: { type: "string", description: "Replacement workflow instruction" },
    "expires-at": {
      type: "string",
      description: 'Replacement ISO expiry, or "none" to reset the safe default',
    },
    status: { type: "string", description: "active or paused" },
    "expected-revision": {
      type: "string",
      description: "Current positive revision returned by list or get",
    },
  },
  async run(ctx) {
    const id = requiredString(ctx.args.id, "watch id");
    const rawExpectedRevision = requiredString(
      ctx.args["expected-revision"],
      "--expected-revision",
    );
    const expectedRevision = Number(rawExpectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new CliError(
        `${c.red}--expected-revision must be a positive integer.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const body: UpdateSubscriptionRequest = {
      expectedRevision,
    };
    if (ctx.args.condition !== undefined) {
      body.condition = {
        kind: "natural-language",
        description: requiredString(ctx.args.condition, "--condition"),
      };
    }
    if (ctx.args.reaction !== undefined) {
      body.reaction = {
        kind: "agent-workflow",
        instruction: requiredString(ctx.args.reaction, "--reaction"),
      };
    }
    const expiresAt = parseExpiresAt(ctx.args["expires-at"], true);
    if (expiresAt !== undefined) body.expiresAt = expiresAt;
    if (ctx.args.status !== undefined) {
      if (ctx.args.status !== "active" && ctx.args.status !== "paused") {
        throw new CliError(`${c.red}--status must be active or paused.${c.reset}`, EXIT_USER_ERROR);
      }
      body.status = ctx.args.status;
    }
    if (
      body.status !== undefined &&
      (body.condition !== undefined || body.reaction !== undefined || body.expiresAt !== undefined)
    ) {
      throw new CliError(
        `${c.red}Change the watch definition and status in separate requests.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (Object.keys(body).length === 1) {
      throw new CliError(`${c.red}Provide at least one update flag.${c.reset}`, EXIT_USER_ERROR);
    }
    const { subscription } = await gatewayJson<{ subscription: SubscriptionDetail }>(
      `/subscriptions/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    printWatch(subscription);
  },
});

const revokeCommand = defineCommand({
  meta: { name: "revoke", description: "Revoke a watch" },
  args: {
    id: { type: "positional", description: "watch id", required: true },
  },
  async run(ctx) {
    const id = requiredString(ctx.args.id, "watch id");
    const { subscription } = await gatewayJson<{ subscription: SubscriptionDetail }>(
      `/subscriptions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    printWatch(subscription);
  },
});

function printPurge(purge: SubscriptionPurgeSummary): void {
  console.log(`${purge.subscriptionId}  deleted (was ${purge.status})`);
  console.log(
    `  Removed: ${purge.revisionsDeleted} revisions, ${purge.firingsDeleted} firings, ` +
      `${purge.answerTokensDeleted} answer tokens, ${purge.workflowsDeleted} workflows`,
  );
}

async function purgeWatch(id: string): Promise<SubscriptionPurgeSummary> {
  const { purged } = await gatewayJson<{ purged: SubscriptionPurgeSummary }>(
    `/admin/privacy/subscriptions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return purged;
}

/** Pagination chunk for the --all-revoked sweep; the server caps limit at 200. */
const PURGE_PAGE_SIZE = 100;

async function listRevokedWatchIds(): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page: { subscriptions: SubscriptionSummary[]; nextCursor: string | null } =
      await gatewayJson<{ subscriptions: SubscriptionSummary[]; nextCursor: string | null }>(
        `/admin/privacy/subscriptions?status=revoked&limit=${PURGE_PAGE_SIZE}${query}`,
      );
    for (const subscription of page.subscriptions) ids.push(subscription.id);
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

const purgeCommand = defineCommand({
  meta: {
    name: "purge",
    description: "Permanently delete a revoked or expired watch and all its records",
  },
  args: {
    id: { type: "positional", description: "watch id", required: false },
    "all-revoked": {
      type: "boolean",
      description: "Permanently delete every revoked watch, continuing past failures",
    },
  },
  async run(ctx) {
    if (ctx.args["all-revoked"] === true) {
      if (typeof ctx.args.id === "string" && ctx.args.id.trim() !== "") {
        throw new CliError(
          `${c.red}Pass either a watch id or --all-revoked, not both.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const ids = await listRevokedWatchIds();
      if (ids.length === 0) {
        console.log("No revoked watches.");
        return;
      }
      const failures: string[] = [];
      for (const id of ids) {
        try {
          printPurge(await purgeWatch(id));
        } catch (err) {
          failures.push(id);
          console.log(`${id}  FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const deleted = ids.length - failures.length;
      console.log(
        `Deleted ${deleted} of ${ids.length} revoked watch${ids.length === 1 ? "" : "es"}.`,
      );
      if (failures.length > 0) {
        throw new CliError(
          `${c.red}${failures.length} watch${failures.length === 1 ? "" : "es"} could not be deleted: ${failures.join(", ")}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      return;
    }
    printPurge(await purgeWatch(requiredString(ctx.args.id, "watch id")));
  },
});

export const watchesCommand = defineCommand({
  meta: { name: "watches", description: "Manage the watches integrations own" },
  subCommands: {
    create: createCommand,
    list: listCommand,
    get: getCommand,
    update: updateCommand,
    revoke: revokeCommand,
    purge: purgeCommand,
  },
});
