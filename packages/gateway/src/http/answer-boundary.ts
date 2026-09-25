// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ConflictError } from "./errors.js";
import type { AnswerService } from "../privacy/answer-service.js";
import type { AnswerProfileReport } from "../privacy/answer-profile.js";
import type {
  AnswerEgressEndpoint,
  RecordAnswerEgressInput,
  RecordedAnswerEgress,
} from "../privacy/store-types.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";
import type { McpToolInvocationAuditInput } from "../access/types.js";

/** The device token an `/answer` egress is revalidated against; see `RecordAnswerEgressInput`. */
export type DeviceAnswerAuthority = NonNullable<RecordAnswerEgressInput["deviceAnswerAuthority"]>;

export interface SubmitAnswerBoundaryInput {
  question: string;
  clientRequestId: string;
  workflowId?: string;
  conversationId?: string;
  workflowName?: string;
  workflowPurpose?: string;
  approvalMode: "allow" | "never";
  completionRoute?: { integrationDeviceId: string; nativeConversationId: string };
  corpusAuthorization?: CorpusAuthorization;
  /**
   * Collect a timing profile of the run. Only the MCP `ask_omnesis`
   * `profiling` flag sets this; the REST answer route never does.
   */
  profiling?: boolean;
}

/**
 * Canonical privacy-release seam shared by REST Answer and MCP Answer.
 * Generation remains durable after disconnect, but egress is recorded only
 * when a live transport is about to receive the released response.
 */
export async function submitAnswerBoundary(
  service: AnswerService,
  ownerId: string,
  input: SubmitAnswerBoundaryInput,
  endpoint: AnswerEgressEndpoint,
  signal?: AbortSignal,
  mcpInvocationAudit?: McpToolInvocationAuditInput,
  deviceAnswerAuthority?: DeviceAnswerAuthority,
): Promise<RecordedAnswerEgress> {
  // The REST path never profiles: it keeps calling answer() exactly as
  // before, so existing behavior and test doubles are unaffected. Only the
  // MCP profiling variant below goes through answerWithProfile.
  const result = await service.answer({ ownerId, ...input });
  return releaseAnswerBoundary(
    service,
    result.taskId,
    ownerId,
    endpoint,
    signal,
    mcpInvocationAudit,
    deviceAnswerAuthority,
  );
}

/**
 * Profiled variant of {@link submitAnswerBoundary} for the MCP Answer
 * `profiling` flag. Returns the recorded egress alongside the timing
 * profile (null when the call did not ask for one).
 */
export async function submitAnswerBoundaryWithProfile(
  service: AnswerService,
  ownerId: string,
  input: SubmitAnswerBoundaryInput,
  endpoint: AnswerEgressEndpoint,
  signal?: AbortSignal,
  mcpInvocationAudit?: McpToolInvocationAuditInput,
): Promise<{ egress: RecordedAnswerEgress; profile: AnswerProfileReport | null }> {
  const { response, profile } = await service.answerWithProfile({ ownerId, ...input });
  const egress = await releaseAnswerBoundary(
    service,
    response.taskId,
    ownerId,
    endpoint,
    signal,
    mcpInvocationAudit,
  );
  return { egress, profile };
}

export async function getAnswerBoundary(
  service: AnswerService,
  taskId: string,
  ownerId: string,
  endpoint: AnswerEgressEndpoint,
  signal?: AbortSignal,
  mcpInvocationAudit?: McpToolInvocationAuditInput,
  deviceAnswerAuthority?: DeviceAnswerAuthority,
): Promise<RecordedAnswerEgress> {
  const response = await service.getResponse(taskId, ownerId);
  if (!response) throw new ConflictError("Answer task has not reached a release decision.");
  return releaseAnswerBoundary(
    service,
    taskId,
    ownerId,
    endpoint,
    signal,
    mcpInvocationAudit,
    deviceAnswerAuthority,
  );
}

async function releaseAnswerBoundary(
  service: AnswerService,
  taskId: string,
  ownerId: string,
  endpoint: AnswerEgressEndpoint,
  signal?: AbortSignal,
  mcpInvocationAudit?: McpToolInvocationAuditInput,
  deviceAnswerAuthority?: DeviceAnswerAuthority,
): Promise<RecordedAnswerEgress> {
  if (signal?.aborted) {
    throw new ConflictError("Answer task completed after the client disconnected.");
  }
  const egress = await service.recordEgress(
    taskId,
    ownerId,
    endpoint,
    mcpInvocationAudit,
    deviceAnswerAuthority,
  );
  if (!egress) throw new ConflictError("Answer task has not reached a release decision.");
  return egress;
}
