// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import { PRIVACY_EXISTENCE_DECISIONS, PRIVACY_POLICY_DECISIONS } from "@omnesis/types/privacy";
import { z } from "zod";

import { AnswerStoreError, PrivacyCursorError } from "../../privacy/store.js";
import { BadRequestError, HttpError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import type { PrivacyPolicyWriteResult } from "../../privacy/admin-service.js";
import type { AgentRoutesDeps } from "./agent.js";
import type { RouteApp } from "./types.js";
import type { PrivacyPolicyDocument } from "@omnesis/types/privacy";

const policyBody = z
  .object({
    policy: z.string().min(1).max(64_000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const policyDecision = z.enum(PRIVACY_POLICY_DECISIONS);

const policySchemaEditBody = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    row: z.string().min(1).max(200).optional(),
    existence: z.enum(PRIVACY_EXISTENCE_DECISIONS).optional(),
    summary: policyDecision.optional(),
    exact: policyDecision.optional(),
    credentialApprovalEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.row === undefined ||
      body.existence !== undefined ||
      body.summary !== undefined ||
      body.exact !== undefined,
    { message: "a row edit must change existence, summary, or exact" },
  )
  .refine((body) => body.row !== undefined || body.credentialApprovalEnabled !== undefined, {
    message: "an edit must name a row to change or set credentialApprovalEnabled",
  })
  .refine(
    (body) =>
      body.row !== undefined ||
      (body.existence === undefined && body.summary === undefined && body.exact === undefined),
    { message: "existence, summary, and exact require a row" },
  );

const approvalStatuses = new Set(["pending", "approved", "denied", "expired", "all"]);
const policyRevertBody = z
  .object({
    generation: z.number().int().positive(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const policyFamilyId = z.string().uuid();
const policyFamilyCreateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    templateId: z.enum(["guarded", "balanced", "open", "unfiltered"]).optional(),
    forkRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (body) => Number(body.templateId !== undefined) + Number(body.forkRevision !== undefined) === 1,
    {
      message: "exactly one of templateId or forkRevision is required",
    },
  );
const policyFamilyRestoreBody = z
  .object({
    version: z.number().int().positive(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const policyFamilyEditBody = z
  .object({
    policy: z.string().min(1).max(64_000),
    beforeVersion: z.number().int().positive().optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      Number(body.beforeVersion !== undefined) + Number(body.expectedRevision !== undefined) === 1,
    { message: "exactly one of beforeVersion or expectedRevision is required" },
  );
const policyFamilyRenameBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((name) => !name.includes("\0"), "name must not contain NUL characters"),
  })
  .strict();
const policyFamilyUpdateBody = z.union([policyFamilyRenameBody, policyFamilyEditBody]);
const policyFamilyForkBody = z.object({ name: z.string().trim().min(1).max(120) }).strict();

export function mountPrivacyRoutes(app: RouteApp, deps: AgentRoutesDeps): void {
  const requireDeps = () => {
    if (!deps.privacyAdminService) {
      throw new ServiceUnavailableError("Privacy boundary is not available on this gateway.");
    }
    return deps.privacyAdminService;
  };
  const noStore = async (
    c: { header: (name: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.header("Cache-Control", "no-store");
    await next();
  };

  app.get("/admin/privacy/policies", noStore, scope.admin(), (c) => {
    return c.json({ policies: requireDeps().listPolicyFamilies() });
  });

  app.post(
    "/admin/privacy/policies",
    noStore,
    scope.portalAdmin(),
    validateJson(policyFamilyCreateBody),
    async (c) => {
      return c.json(
        written(
          await requireDeps().createPolicyFamily(c.req.valid("json")),
          "This policy cannot be created.",
        ),
        201,
      );
    },
  );

  app.delete("/admin/privacy/policies/:familyId", noStore, scope.portalAdmin(), async (c) => {
    const result = await requireDeps().deletePolicyFamily(
      requiredPolicyFamilyId(c.req.param("familyId")),
    );
    if (result.outcome === "not-found") throw new NotFoundError("Privacy policy family not found.");
    if (result.outcome === "in-use") throw new HttpError(409, "policy_in_use", result.message);
    return c.body(null, 204);
  });

  app.get("/admin/privacy/policies/:familyId", noStore, scope.admin(), async (c) => {
    const familyId = requiredPolicyFamilyId(c.req.param("familyId"));
    const policy = await requireDeps().getPolicyFamily(familyId);
    if (!policy) throw new NotFoundError("Privacy policy family not found.");
    return c.json(policy);
  });

  app.patch(
    "/admin/privacy/policies/:familyId",
    noStore,
    scope.portalAdmin(),
    validateJson(policyFamilyUpdateBody),
    async (c) => {
      const familyId = requiredPolicyFamilyId(c.req.param("familyId"));
      const body = c.req.valid("json");
      if ("name" in body) {
        const result = await requireDeps().renamePolicyFamily(familyId, body.name);
        switch (result.outcome) {
          case "renamed":
            return c.json(result.document);
          case "not-found":
            throw new NotFoundError("Privacy policy family not found.");
          case "name-taken":
            throw new HttpError(
              409,
              "POLICY_NAME_TAKEN",
              "A privacy policy with this name already exists.",
            );
          case "invalid":
            throw new BadRequestError("Privacy policy name is invalid.");
          default:
            return assertNever(result);
        }
      }
      return c.json(
        written(
          await requireDeps().putPolicyFamily(familyId, body.policy, {
            ...(body.beforeVersion === undefined ? {} : { beforeVersion: body.beforeVersion }),
            ...(body.expectedRevision === undefined
              ? {}
              : { expectedRevision: body.expectedRevision }),
          }),
          "This policy cannot be stored as written.",
        ),
      );
    },
  );

  app.get("/admin/privacy/policies/:familyId/history", noStore, scope.admin(), (c) => {
    const familyId = requiredPolicyFamilyId(c.req.param("familyId"));
    const limit = parseLimit(c.req.query("limit"), 50, 100);
    const beforeVersion = optionalPositiveInt(c.req.query("beforeVersion"), "beforeVersion");
    const probe = requireDeps().listPolicyFamilyHistory(familyId, {
      limit: limit + 1,
      ...(beforeVersion ? { beforeVersion } : {}),
    });
    const hasMore = probe.length > limit;
    const versions = hasMore ? probe.slice(0, limit) : probe;
    return c.json({
      versions,
      pageInfo: {
        hasMore,
        limit,
        ...(hasMore && versions.at(-1)
          ? { nextBeforeVersion: versions.at(-1)!.familyVersion }
          : {}),
      },
    });
  });

  app.get("/admin/privacy/policies/:familyId/history/:version", noStore, scope.admin(), (c) => {
    const familyId = requiredPolicyFamilyId(c.req.param("familyId"));
    const familyVersion = requiredPositiveInt(c.req.param("version"), "version");
    const version = requireDeps().getPolicyFamilyVersion(familyId, familyVersion);
    if (!version) throw new NotFoundError("Privacy policy version not found.");
    return c.json({ version });
  });

  app.post(
    "/admin/privacy/policies/:familyId/restore",
    noStore,
    scope.portalAdmin(),
    validateJson(policyFamilyRestoreBody),
    async (c) => {
      const familyId = requiredPolicyFamilyId(c.req.param("familyId"));
      const body = c.req.valid("json");
      return c.json(
        written(
          await requireDeps().restorePolicyFamily(familyId, body.version, body.expectedRevision),
          "This policy version cannot be restored.",
        ),
      );
    },
  );

  app.post(
    "/admin/privacy/policies/:familyId/fork",
    noStore,
    scope.portalAdmin(),
    validateJson(policyFamilyForkBody),
    async (c) => {
      const familyId = requiredPolicyFamilyId(c.req.param("familyId"));
      const current = await requireDeps().getPolicyFamily(familyId);
      if (!current) throw new NotFoundError("Privacy policy family not found.");
      return c.json(
        written(
          await requireDeps().createPolicyFamily({
            name: c.req.valid("json").name,
            forkRevision: current.revision,
          }),
          "This policy cannot be forked.",
        ),
        201,
      );
    },
  );

  app.get("/admin/privacy/policy", noStore, scope.admin(), async (c) => {
    return c.json(await requireDeps().getPolicy());
  });

  /** Applies one decision change without the client having to author markdown. */
  app.patch(
    "/admin/privacy/policy",
    noStore,
    scope.portalAdmin(),
    validateJson(policySchemaEditBody),
    async (c) => {
      const body = c.req.valid("json");
      const result = await requireDeps().editPolicySchema(body, body.expectedRevision);
      return c.json(
        written(
          result,
          "This policy has been edited as text and no longer matches the standard layout. Edit it as text instead.",
        ),
      );
    },
  );

  app.get("/admin/privacy/policy/templates", noStore, scope.admin(), (c) => {
    return c.json({ templates: requireDeps().listPolicyTemplates() });
  });

  app.get("/admin/privacy/policy/history", noStore, scope.admin(), (c) => {
    const limit = parseLimit(c.req.query("limit"), 50, 100);
    const beforeGeneration = optionalPositiveInt(
      c.req.query("beforeGeneration"),
      "beforeGeneration",
    );
    const probe = requireDeps().listPolicyHistory({
      limit: limit + 1,
      ...(beforeGeneration ? { beforeGeneration } : {}),
    });
    const hasMore = probe.length > limit;
    const versions = hasMore ? probe.slice(0, limit) : probe;
    return c.json({
      versions,
      pageInfo: {
        hasMore,
        limit,
        ...(hasMore && versions.at(-1)
          ? { nextBeforeGeneration: versions.at(-1)!.generation }
          : {}),
      },
    });
  });

  app.get("/admin/privacy/policy/history/:generation", noStore, scope.admin(), (c) => {
    const generation = requiredPositiveInt(c.req.param("generation"), "generation");
    const version = requireDeps().getPolicyVersion(generation);
    if (!version) throw new NotFoundError("Privacy policy version not found.");
    return c.json({ version });
  });

  app.post(
    "/admin/privacy/policy/revert",
    noStore,
    scope.portalAdmin(),
    validateJson(policyRevertBody),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        written(
          await requireDeps().revertPolicy(body.generation, body.expectedRevision),
          "This policy version cannot be restored.",
        ),
      );
    },
  );

  app.put(
    "/admin/privacy/policy",
    noStore,
    scope.portalAdmin(),
    validateJson(policyBody),
    async (c) => {
      const body = c.req.valid("json");
      const result = await requireDeps().putPolicy(body.policy, body.expectedRevision);
      return c.json(written(result, "This policy cannot be stored as written."));
    },
  );

  app.get("/admin/privacy/approvals", noStore, scope.admin(), async (c) => {
    const status = c.req.query("status") ?? "pending";
    if (!approvalStatuses.has(status)) throw new BadRequestError("invalid approval status");
    try {
      return c.json(
        requireDeps().listApprovalPage(
          status as "pending" | "approved" | "denied" | "expired" | "all",
          parseLimit(c.req.query("limit")),
          optionalCursor(c.req.query("cursor")),
        ),
      );
    } catch (err) {
      if (err instanceof PrivacyCursorError) throw new BadRequestError(err.message);
      throw err;
    }
  });

  app.get("/admin/privacy/approvals/:id", noStore, scope.admin(), async (c) => {
    const approval = await requireDeps().getApproval(c.req.param("id"));
    if (!approval) throw new NotFoundError("Privacy approval not found.");
    return c.json({ approval });
  });

  for (const action of ["approve", "deny"] as const) {
    app.post(`/admin/privacy/approvals/:id/${action}`, noStore, scope.admin(), async (c) => {
      const auth = c.get("auth");
      const response = await requireDeps().resolveApproval(c.req.param("id"), action, {
        requestId: c.get("requestId"),
        tokenId: auth.tokenId,
        deviceId: auth.deviceId,
      });
      if (!response) throw new NotFoundError("Privacy approval not found.");
      return c.json(response);
    });
  }

  app.get("/admin/privacy/decisions", noStore, scope.admin(), (c) => {
    return c.json({
      decisions: requireDeps().listDecisions(parseLimit(c.req.query("limit"))),
    });
  });

  app.get("/admin/privacy/reviewer-health", noStore, scope.admin(), (c) => {
    return c.json(requireDeps().getReviewerHealth());
  });

  app.get("/admin/privacy/conversations", noStore, scope.admin(), async (c) => {
    try {
      return c.json(
        await requireDeps().listConversations(
          parseLimit(c.req.query("limit"), 50, 100),
          optionalCursor(c.req.query("cursor")),
        ),
      );
    } catch (err) {
      if (err instanceof PrivacyCursorError) throw new BadRequestError(err.message);
      throw err;
    }
  });

  // The Privacy landing feed. Flat and newest-first, so one row is one
  // exchange; the conversation-scoped route below still backs the detail view.
  app.get("/admin/privacy/exchanges", noStore, scope.admin(), async (c) => {
    try {
      return c.json(
        await requireDeps().listExchangeFeed(
          parseLimit(c.req.query("limit"), 50, 100),
          optionalCursor(c.req.query("cursor")),
        ),
      );
    } catch (err) {
      if (err instanceof PrivacyCursorError) throw new BadRequestError(err.message);
      throw err;
    }
  });

  app.get("/admin/privacy/conversations/:id", noStore, scope.admin(), async (c) => {
    const conversation = await requireDeps().getConversation(c.req.param("id"));
    if (!conversation) throw new NotFoundError("Privacy conversation not found.");
    return c.json({ conversation });
  });

  app.get("/admin/privacy/conversations/:id/exchanges", noStore, scope.admin(), async (c) => {
    try {
      const page = await requireDeps().listExchanges(
        c.req.param("id"),
        parseLimit(c.req.query("limit"), 50, 100),
        optionalCursor(c.req.query("cursor")),
        optionalTaskId(c.req.query("includeAgentTracesTaskId")),
      );
      if (!page) throw new NotFoundError("Privacy conversation not found.");
      return c.json(page);
    } catch (err) {
      if (err instanceof PrivacyCursorError) throw new BadRequestError(err.message);
      throw err;
    }
  });

  app.get("/admin/privacy/conversations/:id/events", noStore, scope.admin(), (c) => {
    try {
      const page = requireDeps().listAuditEvents(
        c.req.param("id"),
        parseLimit(c.req.query("limit"), 50, 100),
        optionalCursor(c.req.query("cursor")),
      );
      if (!page) throw new NotFoundError("Privacy conversation not found.");
      return c.json(page);
    } catch (err) {
      if (err instanceof PrivacyCursorError) throw new BadRequestError(err.message);
      throw err;
    }
  });

  app.get("/admin/privacy/conversations/:id/events/:eventId", noStore, scope.admin(), (c) => {
    const event = requireDeps().getAuditEvent(c.req.param("id"), c.req.param("eventId"));
    if (!event) throw new NotFoundError("Privacy audit event not found.");
    return c.json({ event });
  });

  app.delete("/admin/privacy/conversations/:id", noStore, scope.admin(), async (c) => {
    try {
      const deleted = await requireDeps().deleteConversation(c.req.param("id"));
      if (!deleted) throw new NotFoundError("Privacy conversation not found.");
      return c.json({ deleted: true });
    } catch (err) {
      if (err instanceof AnswerStoreError && err.code === "conversation_running") {
        throw new HttpError(409, "PRIVACY_CONVERSATION_RUNNING", err.message);
      }
      throw err;
    }
  });

  // Direct MCP transcript sessions, newest first. Same admin posture as the
  // Answer conversation reads above: the operator sees every principal.
  app.get("/admin/privacy/direct/sessions", noStore, scope.admin(), (c) => {
    return c.json({
      sessions: requireDeps().listDirectSessions(parseLimit(c.req.query("limit"), 50, 100)),
    });
  });

  app.get("/admin/privacy/direct/sessions/:id/events", noStore, scope.admin(), (c) => {
    const events = requireDeps().listDirectSessionEvents(
      c.req.param("id"),
      parseLimit(c.req.query("limit"), 50, 100),
    );
    if (!events) throw new NotFoundError("Direct audit session not found.");
    return c.json({ events });
  });

  app.get("/admin/privacy/direct/events/:eventId", noStore, scope.admin(), (c) => {
    const event = requireDeps().getDirectEvent(c.req.param("eventId"));
    if (!event) throw new NotFoundError("Direct audit event not found.");
    return c.json({ event });
  });

  app.delete("/admin/privacy/direct/sessions/:id", noStore, scope.admin(), async (c) => {
    const deleted = await requireDeps().deleteDirectSession(c.req.param("id"));
    if (!deleted) throw new NotFoundError("Direct audit session not found.");
    return c.json({ deleted: true });
  });
}

/**
 * The written document, or the HTTP contract for why there is none: a revision
 * that moved under the client is a 409 carrying the document as it now stands,
 * and a policy the controls cannot rewrite — or text the store will not hold —
 * is a 400.
 */
function written(
  result: PrivacyPolicyWriteResult,
  unparseableMessage: string,
): PrivacyPolicyDocument {
  switch (result.outcome) {
    case "written":
      return result.document;
    case "unparseable":
      throw new BadRequestError(unparseableMessage);
    case "conflict":
      throw new HttpError(409, "PRIVACY_POLICY_CONFLICT", result.message, result.current);
    case "invalid":
      throw new BadRequestError(result.message);
    default:
      return assertNever(result);
  }
}

function parseLimit(raw: string | undefined, fallback = 100, maximum = 500): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new BadRequestError(`limit must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function optionalCursor(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

function requiredPolicyFamilyId(raw: string): string {
  const parsed = policyFamilyId.safeParse(raw);
  if (!parsed.success) throw new BadRequestError("familyId must be a UUID");
  return parsed.data;
}

function optionalTaskId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > 256) throw new BadRequestError("task id is too long");
  return raw;
}

function optionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return requiredPositiveInt(raw, name);
}

function requiredPositiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestError(`${name} must be a positive integer`);
  }
  return value;
}
